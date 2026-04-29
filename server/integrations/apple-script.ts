import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type OsaLang = "JavaScript" | "AppleScript";

export interface RunOsaOptions {
  lang?: OsaLang;
  timeoutMs?: number;
  parse?: "json" | "text";
}

export class OsaError extends Error {
  constructor(
    public readonly kind:
      | "permission"
      | "not_found"
      | "app_not_running"
      | "timeout"
      | "unknown",
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "OsaError";
  }
}

/**
 * Safely interpolate a JS value into a JXA script.
 * NEVER concat user input directly — always go through this.
 */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function classifyStderr(stderr: string): OsaError["kind"] {
  const s = stderr.toLowerCase();
  if (s.includes("not authorized") || s.includes("not allowed")) return "permission";
  if (s.includes("application isn't running") || s.includes("can't get application")) {
    return "app_not_running";
  }
  if (s.includes("doesn't understand") || s.includes("can't get")) return "not_found";
  return "unknown";
}

export async function runOsa<T = unknown>(
  script: string,
  opts: RunOsaOptions = {},
): Promise<T> {
  const lang: OsaLang = opts.lang ?? "JavaScript";
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const parse = opts.parse ?? (lang === "JavaScript" ? "json" : "text");

  try {
    const { stdout } = await execFileP("osascript", ["-l", lang, "-e", script], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (parse === "json") {
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new OsaError(
          "unknown",
          `Failed to parse osascript JSON output: ${(err as Error).message}\nstdout: ${text.slice(0, 500)}`,
        );
      }
    }
    return text as T;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals;
      code?: number | string;
    };
    if ((e.killed && e.signal === "SIGTERM") || e.code === "ETIMEDOUT") {
      throw new OsaError("timeout", `osascript timed out after ${timeoutMs}ms`);
    }
    const stderr = e.stderr ?? e.message ?? "";
    const kind = classifyStderr(stderr);
    throw new OsaError(kind, stderr.trim() || "osascript failed", stderr);
  }
}
