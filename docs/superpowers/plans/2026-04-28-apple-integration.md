# Apple Reminders + Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `apple-reminders` and `apple-notes` integrations to Boop's executor agent — read/write access to local macOS Reminders and Notes via AppleScript/JXA, surfaced in the dispatcher just like a Composio toolkit, with a new "Local" tab in the debug UI.

**Architecture:** Two new `IntegrationModule` builders in `server/integrations/`, each wrapping `osascript` calls via a small shared helper (`apple-script.ts`). Modules auto-register on `darwin` (no env var, no UI card). Writes flow through Boop's existing draft pattern — the executor's system prompt already routes external actions to `save_draft`, so no prompt changes needed. A new `/apple/*` HTTP router and a `LocalPanel` React component surface load + permission status in the debug dashboard.

**Tech Stack:** TypeScript, Node `child_process.execFile`, JXA (JavaScript for Automation), the existing `@anthropic-ai/claude-agent-sdk` `tool()` + `createSdkMcpServer()` helpers, `zod`, Convex `settings` table, Express, React.

**Spec:** `docs/superpowers/specs/2026-04-28-apple-integration-design.md` — read it before starting any task. Tool surfaces, draft `kind` tags, and design decisions live in the spec; this plan only covers the implementation steps.

---

## File map

**New files:**
- `vitest.config.ts` — vitest config
- `server/integrations/apple-script.ts` — `runOsa<T>()` helper
- `server/integrations/apple-script.test.ts` — input-safety unit tests
- `server/integrations/apple-reminders.ts` — module + 8 tools
- `server/integrations/apple-reminders.test.ts` — script-builder tests
- `server/integrations/apple-notes.ts` — module + 8 tools (incl. HTML helpers)
- `server/integrations/apple-notes.test.ts` — html + script-builder tests
- `server/integrations/apple-permissions.ts` — permission caching + warmup
- `server/apple-routes.ts` — Express router, mounted at `/apple`
- `scripts/apple-permissions.mjs` — CLI permission warmup
- `debug/src/components/LocalPanel.tsx` — new dashboard tab content

**Modified files:**
- `package.json` — vitest dev dep + `test` / `apple:permissions` scripts
- `server/integrations/registry.ts` — register apple modules on `darwin`
- `server/index.ts` — mount `/apple` router
- `debug/src/App.tsx` — add `local` view + nav entry
- `debug/src/lib/branding.tsx` — Apple logo entries
- `INTEGRATIONS.md` — new "Apple integrations" section
- `CHANGELOG.md` — feature entry

---

## Task 1: Vitest setup

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install vitest as a dev dependency**

```bash
npm install -D vitest
```

- [ ] **Step 2: Add test scripts to `package.json`**

In the `"scripts"` block, add (preserve existing entries):

```json
"test": "vitest run",
"test:watch": "vitest",
"apple:permissions": "tsx scripts/apple-permissions.ts"
```

The `apple-permissions.ts` script is created in Task 10. Adding the npm script entry now keeps the package.json change in one place.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Verify**

```bash
npm test
```

Expected: `No test files found, exiting with code 0` (or similar — vitest prints a no-tests message). Exit code 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest for unit tests on integration helpers"
```

---

## Task 2: AppleScript bridge helper (`apple-script.ts`)

**Files:**
- Create: `server/integrations/apple-script.ts`
- Create: `server/integrations/apple-script.test.ts`

This is the foundation everything else uses. Inputs are interpolated via `JSON.stringify`; outputs default to JSON-parsed.

- [ ] **Step 1: Write failing test for input safety**

Create `server/integrations/apple-script.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { jsonLiteral } from "./apple-script.js";

describe("jsonLiteral", () => {
  it("escapes double quotes safely", () => {
    expect(jsonLiteral(`hello "world"`)).toBe(`"hello \\"world\\""`);
  });

  it("escapes backslashes", () => {
    expect(jsonLiteral(`a\\b`)).toBe(`"a\\\\b"`);
  });

  it("handles newlines", () => {
    expect(jsonLiteral("line1\nline2")).toBe(`"line1\\nline2"`);
  });

  it("handles unicode", () => {
    expect(jsonLiteral("café")).toBe(`"café"`);
  });

  it("encodes objects", () => {
    expect(jsonLiteral({ a: 1, b: "x" })).toBe(`{"a":1,"b":"x"}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- apple-script
```

Expected: FAIL with import error (module does not exist yet).

- [ ] **Step 3: Implement `apple-script.ts`**

Create `server/integrations/apple-script.ts`:

```ts
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
  return JSON.stringify(value);
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
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.killed && e.signal === "SIGTERM") {
      throw new OsaError("timeout", `osascript timed out after ${timeoutMs}ms`);
    }
    const stderr = e.stderr ?? e.message ?? "";
    const kind = classifyStderr(stderr);
    throw new OsaError(kind, stderr.trim() || "osascript failed", stderr);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- apple-script
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add server/integrations/apple-script.ts server/integrations/apple-script.test.ts
git commit -m "feat(integrations): apple-script helper for safe osascript execution"
```

---

## Task 3: Apple Reminders module — read tools

**Files:**
- Create: `server/integrations/apple-reminders.ts`
- Create: `server/integrations/apple-reminders.test.ts`

Implements the IntegrationModule + 4 read tools (`list_lists`, `list_reminders`, `search_reminders`, `get_reminder`). Each tool has a builder function (pure, testable) that returns the JXA script string.

- [ ] **Step 1: Write failing tests for script builders**

Create `server/integrations/apple-reminders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildListListsScript,
  buildListRemindersScript,
  buildSearchRemindersScript,
  buildGetReminderScript,
} from "./apple-reminders.js";

describe("apple-reminders script builders", () => {
  it("list_lists: returns JXA that JSON-stringifies the lists array", () => {
    const s = buildListListsScript();
    expect(s).toContain("Application('Reminders')");
    expect(s).toContain("JSON.stringify");
  });

  it("list_reminders: interpolates list name as JSON literal", () => {
    const s = buildListRemindersScript({ list: "Personal", status: "incomplete" });
    expect(s).toContain(`"Personal"`);
    expect(s).toContain("JSON.stringify");
  });

  it("list_reminders: handles quotes in list name safely", () => {
    const s = buildListRemindersScript({ list: `bad "name"` });
    expect(s).toContain(`"bad \\"name\\""`);
  });

  it("search_reminders: lowercases and substring-matches", () => {
    const s = buildSearchRemindersScript({ query: "DENTIST", limit: 25 });
    expect(s).toContain("dentist");
    expect(s).toContain("25");
  });

  it("get_reminder: includes id literal", () => {
    const s = buildGetReminderScript({
      id: "x-apple-reminderkit://REMCDReminder/abc-123",
    });
    expect(s).toContain(`"x-apple-reminderkit://REMCDReminder/abc-123"`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- apple-reminders
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement read tools**

Create `server/integrations/apple-reminders.ts`:

```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IntegrationModule } from "./registry.js";
import { runOsa, jsonLiteral, OsaError } from "./apple-script.js";

// ─────────────────────────────── Script builders ─────────────────────────────

export function buildListListsScript(): string {
  return `
    const Reminders = Application('Reminders');
    Reminders.includeStandardAdditions = true;
    const lists = Reminders.lists();
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const result = lists.map(l => {
      const items = l.reminders();
      let dueToday = 0, overdue = 0;
      for (const r of items) {
        if (r.completed()) continue;
        const d = r.dueDate();
        if (!d) continue;
        if (d >= today && d < tomorrow) dueToday++;
        else if (d < today) overdue++;
      }
      return {
        name: l.name(),
        total: items.length,
        dueToday,
        overdue,
      };
    });
    JSON.stringify(result);
  `;
}

export interface ListRemindersArgs {
  list?: string;
  status?: "incomplete" | "completed" | "all";
  dueBefore?: string;
  dueAfter?: string;
}

export function buildListRemindersScript(args: ListRemindersArgs): string {
  const status = args.status ?? "incomplete";
  return `
    const Reminders = Application('Reminders');
    const args = ${jsonLiteral(args)};
    const status = ${jsonLiteral(status)};
    const lists = args.list
      ? Reminders.lists.whose({ name: args.list })()
      : Reminders.lists();
    if (args.list && lists.length === 0) {
      const all = Reminders.lists().map(l => l.name());
      throw new Error("List not found: " + args.list + ". Available: " + all.join(", "));
    }
    const out = [];
    for (const l of lists) {
      for (const r of l.reminders()) {
        const completed = r.completed();
        if (status === "incomplete" && completed) continue;
        if (status === "completed" && !completed) continue;
        const d = r.dueDate();
        if (args.dueBefore && d && new Date(d) >= new Date(args.dueBefore)) continue;
        if (args.dueAfter && d && new Date(d) <= new Date(args.dueAfter)) continue;
        out.push({
          id: r.id(),
          name: r.name(),
          listName: l.name(),
          due: d ? d.toISOString() : null,
          priority: r.priority(),
          notes: r.body() || null,
          completed,
        });
      }
    }
    JSON.stringify(out);
  `;
}

export interface SearchRemindersArgs {
  query: string;
  limit?: number;
}

export function buildSearchRemindersScript(args: SearchRemindersArgs): string {
  const limit = args.limit ?? 50;
  return `
    const Reminders = Application('Reminders');
    const q = ${jsonLiteral(args.query.toLowerCase())};
    const limit = ${limit};
    const out = [];
    outer: for (const l of Reminders.lists()) {
      for (const r of l.reminders()) {
        const name = String(r.name() || "").toLowerCase();
        const body = String(r.body() || "").toLowerCase();
        if (!name.includes(q) && !body.includes(q)) continue;
        const d = r.dueDate();
        out.push({
          id: r.id(),
          name: r.name(),
          listName: l.name(),
          due: d ? d.toISOString() : null,
          priority: r.priority(),
          notes: r.body() || null,
          completed: r.completed(),
        });
        if (out.length >= limit) break outer;
      }
    }
    JSON.stringify(out);
  `;
}

export interface GetReminderArgs {
  id: string;
}

export function buildGetReminderScript(args: GetReminderArgs): string {
  return `
    const Reminders = Application('Reminders');
    const id = ${jsonLiteral(args.id)};
    for (const l of Reminders.lists()) {
      const matches = l.reminders.whose({ id })();
      if (matches.length) {
        const r = matches[0];
        const d = r.dueDate();
        return JSON.stringify({
          id: r.id(),
          name: r.name(),
          listName: l.name(),
          due: d ? d.toISOString() : null,
          priority: r.priority(),
          notes: r.body() || null,
          completed: r.completed(),
        });
      }
    }
    throw new Error("Reminder not found: " + id);
  `;
}

// ─────────────────────────────── Formatting ─────────────────────────────────

interface ReminderRow {
  id: string;
  name: string;
  listName: string;
  due: string | null;
  priority: number;
  notes: string | null;
  completed: boolean;
}

const PRIORITY_LABEL: Record<number, string> = {
  0: "none",
  1: "high",
  5: "medium",
  9: "low",
};

function formatDue(iso: string | null): string {
  if (!iso) return "no due date";
  const d = new Date(iso);
  const date = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  return time === "00:00" ? `due ${date}` : `due ${date} ${time}`;
}

function formatReminderLine(r: ReminderRow): string {
  const prio = PRIORITY_LABEL[r.priority] ?? "none";
  const status = r.completed ? " [done]" : "";
  return `[${r.id}] ${r.name} · ${r.listName} · ${formatDue(r.due)} · priority ${prio}${status}`;
}

function osaErrorToText(err: unknown): string {
  if (err instanceof OsaError) {
    if (err.kind === "permission") {
      return "Not authorized. Open System Settings → Privacy & Security → Automation → Node → enable Reminders, then retry.";
    }
    return `Apple Reminders error: ${err.message}`;
  }
  return `Apple Reminders error: ${String(err)}`;
}

// ─────────────────────────────── IntegrationModule ─────────────────────────

export function buildAppleRemindersIntegrationModule(): IntegrationModule {
  return {
    name: "apple-reminders",
    description: "Apple Reminders (local macOS)",
    requiredEnv: [],
    createServer: async () =>
      createSdkMcpServer({
        name: "apple-reminders",
        version: "0.1.0",
        tools: [
          tool(
            "list_lists",
            "List all Reminders lists on this Mac with reminder counts. Call this first when the user asks about reminders without naming a list.",
            {},
            async () => {
              try {
                const lists = await runOsa<
                  { name: string; total: number; dueToday: number; overdue: number }[]
                >(buildListListsScript());
                if (!lists.length) {
                  return { content: [{ type: "text" as const, text: "No reminder lists." }] };
                }
                const body = lists
                  .map(
                    (l) =>
                      `${l.name}: ${l.total}${l.total ? ` (${l.dueToday} today, ${l.overdue} overdue)` : ""}`,
                  )
                  .join("\n");
                return { content: [{ type: "text" as const, text: body }] };
              } catch (err) {
                return {
                  content: [{ type: "text" as const, text: osaErrorToText(err) }],
                  isError: true,
                };
              }
            },
          ),

          tool(
            "list_reminders",
            "List reminders, optionally filtered by list name, completion status, and/or due-date range. Default: incomplete reminders across all lists. IDs returned can be passed to get_reminder, update_reminder, complete_reminder, delete_reminder.",
            {
              list: z.string().optional().describe("Reminders list name (case-sensitive). If omitted, searches all lists."),
              status: z.enum(["incomplete", "completed", "all"]).optional(),
              dueBefore: z.string().optional().describe("ISO 8601 datetime. Only reminders due before this."),
              dueAfter: z.string().optional().describe("ISO 8601 datetime. Only reminders due after this."),
            },
            async (args) => {
              try {
                const rows = await runOsa<ReminderRow[]>(
                  buildListRemindersScript(args),
                );
                if (!rows.length) {
                  return { content: [{ type: "text" as const, text: "No reminders match." }] };
                }
                return {
                  content: [{ type: "text" as const, text: rows.map(formatReminderLine).join("\n") }],
                };
              } catch (err) {
                return {
                  content: [{ type: "text" as const, text: osaErrorToText(err) }],
                  isError: true,
                };
              }
            },
          ),

          tool(
            "search_reminders",
            "Substring search across reminder titles and notes. Up to `limit` hits across all lists, both completed and not.",
            {
              query: z.string(),
              limit: z.number().int().positive().max(200).optional(),
            },
            async (args) => {
              try {
                const rows = await runOsa<ReminderRow[]>(
                  buildSearchRemindersScript(args),
                );
                if (!rows.length) {
                  return { content: [{ type: "text" as const, text: "No matches." }] };
                }
                return {
                  content: [{ type: "text" as const, text: rows.map(formatReminderLine).join("\n") }],
                };
              } catch (err) {
                return {
                  content: [{ type: "text" as const, text: osaErrorToText(err) }],
                  isError: true,
                };
              }
            },
          ),

          tool(
            "get_reminder",
            "Get full details for a single reminder by id.",
            { id: z.string() },
            async (args) => {
              try {
                const r = await runOsa<ReminderRow>(buildGetReminderScript(args));
                const lines = [
                  `# ${r.name}`,
                  `list: ${r.listName}`,
                  `${formatDue(r.due)}`,
                  `priority: ${PRIORITY_LABEL[r.priority] ?? "none"}`,
                  `completed: ${r.completed}`,
                  "",
                  r.notes ? r.notes : "(no notes)",
                ];
                return { content: [{ type: "text" as const, text: lines.join("\n") }] };
              } catch (err) {
                return {
                  content: [{ type: "text" as const, text: osaErrorToText(err) }],
                  isError: true,
                };
              }
            },
          ),

          // Write tools added in Task 4.
        ],
      }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- apple-reminders
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add server/integrations/apple-reminders.ts server/integrations/apple-reminders.test.ts
git commit -m "feat(integrations): apple-reminders read tools (list/search/get)"
```

---

## Task 4: Apple Reminders module — write tools

**Files:**
- Modify: `server/integrations/apple-reminders.ts` (add 4 write tools to the same module)
- Modify: `server/integrations/apple-reminders.test.ts` (add 4 builder tests)

Add `create_reminder`, `update_reminder`, `complete_reminder`, `delete_reminder`. The executor's existing system prompt routes external writes through `save_draft` first (see `server/execution-agent.ts:76`) — we don't need a prompt change.

- [ ] **Step 1: Add failing tests for write-tool builders**

Append to `server/integrations/apple-reminders.test.ts`:

```ts
import {
  buildCreateReminderScript,
  buildUpdateReminderScript,
  buildCompleteReminderScript,
  buildDeleteReminderScript,
} from "./apple-reminders.js";

describe("apple-reminders write builders", () => {
  it("create_reminder: emits a new reminder with given fields", () => {
    const s = buildCreateReminderScript({
      title: "Pick up dry cleaning",
      list: "Personal",
      due: "2026-04-29T17:00:00",
      priority: "high",
    });
    expect(s).toContain(`"Pick up dry cleaning"`);
    expect(s).toContain(`"Personal"`);
    expect(s).toContain(`"2026-04-29T17:00:00"`);
    expect(s).toContain("Reminders.Reminder");
  });

  it("update_reminder: only updates provided fields", () => {
    const s = buildUpdateReminderScript({ id: "x-apple-...abc", title: "new title" });
    expect(s).toContain(`"new title"`);
  });

  it("complete_reminder: sets completed = true", () => {
    const s = buildCompleteReminderScript({ id: "x-apple-...abc" });
    expect(s).toContain("completed = true");
  });

  it("delete_reminder: deletes by id", () => {
    const s = buildDeleteReminderScript({ id: "x-apple-...abc" });
    expect(s).toContain(".delete()");
  });
});
```

- [ ] **Step 2: Run test to verify they fail**

```bash
npm test -- apple-reminders
```

Expected: 4 new failures (functions not exported yet).

- [ ] **Step 3: Add write builders + tools to `apple-reminders.ts`**

Append to `server/integrations/apple-reminders.ts` (above `buildAppleRemindersIntegrationModule`):

```ts
const PRIORITY_NUM: Record<string, number> = { none: 0, high: 1, medium: 5, low: 9 };

export interface CreateReminderArgs {
  title: string;
  list?: string;
  due?: string;
  notes?: string;
  priority?: "none" | "low" | "medium" | "high";
}

export function buildCreateReminderScript(args: CreateReminderArgs): string {
  const prio = PRIORITY_NUM[args.priority ?? "none"];
  return `
    const Reminders = Application('Reminders');
    const args = ${jsonLiteral(args)};
    const list = args.list
      ? Reminders.lists.whose({ name: args.list })()[0]
      : Reminders.defaultList();
    if (!list) throw new Error("List not found: " + args.list);
    const props = { name: args.title };
    if (args.due) props.dueDate = new Date(args.due);
    if (args.notes) props.body = args.notes;
    props.priority = ${prio};
    const r = Reminders.Reminder(props);
    list.reminders.push(r);
    JSON.stringify({ id: r.id(), name: r.name(), listName: list.name() });
  `;
}

export interface UpdateReminderArgs {
  id: string;
  title?: string;
  list?: string;
  due?: string | null;
  notes?: string;
  priority?: "none" | "low" | "medium" | "high";
}

export function buildUpdateReminderScript(args: UpdateReminderArgs): string {
  return `
    const Reminders = Application('Reminders');
    const args = ${jsonLiteral(args)};
    const PRIO = ${jsonLiteral(PRIORITY_NUM)};
    let target = null, sourceList = null;
    for (const l of Reminders.lists()) {
      const m = l.reminders.whose({ id: args.id })();
      if (m.length) { target = m[0]; sourceList = l; break; }
    }
    if (!target) throw new Error("Reminder not found: " + args.id);
    if (args.title !== undefined) target.name = args.title;
    if (args.notes !== undefined) target.body = args.notes;
    if (args.due === null) target.dueDate = null;
    else if (args.due !== undefined) target.dueDate = new Date(args.due);
    if (args.priority !== undefined) target.priority = PRIO[args.priority];
    if (args.list !== undefined && args.list !== sourceList.name()) {
      const dest = Reminders.lists.whose({ name: args.list })()[0];
      if (!dest) throw new Error("Destination list not found: " + args.list);
      // JXA can't move reminders directly; recreate in destination.
      const newProps = {
        name: target.name(),
        body: target.body(),
        priority: target.priority(),
      };
      const d = target.dueDate();
      if (d) newProps.dueDate = d;
      const newR = Reminders.Reminder(newProps);
      dest.reminders.push(newR);
      target.delete();
      target = newR;
      sourceList = dest;
    }
    JSON.stringify({ id: target.id(), name: target.name(), listName: sourceList.name() });
  `;
}

export interface CompleteReminderArgs {
  id: string;
}

export function buildCompleteReminderScript(args: CompleteReminderArgs): string {
  return `
    const Reminders = Application('Reminders');
    const id = ${jsonLiteral(args.id)};
    for (const l of Reminders.lists()) {
      const m = l.reminders.whose({ id })();
      if (m.length) {
        m[0].completed = true;
        return JSON.stringify({ id, completed: true });
      }
    }
    throw new Error("Reminder not found: " + id);
  `;
}

export interface DeleteReminderArgs {
  id: string;
}

export function buildDeleteReminderScript(args: DeleteReminderArgs): string {
  return `
    const Reminders = Application('Reminders');
    const id = ${jsonLiteral(args.id)};
    for (const l of Reminders.lists()) {
      const m = l.reminders.whose({ id })();
      if (m.length) {
        m[0].delete();
        return JSON.stringify({ id, deleted: true });
      }
    }
    throw new Error("Reminder not found: " + id);
  `;
}
```

Then, inside the `tools: [...]` array of `buildAppleRemindersIntegrationModule()`, append (replacing the `// Write tools added in Task 4.` placeholder):

```ts
tool(
  "create_reminder",
  "Create a reminder. ALWAYS go through save_draft first; this tool only commits when invoked by send_draft.",
  {
    title: z.string(),
    list: z.string().optional(),
    due: z.string().optional().describe("ISO 8601 datetime in local time (e.g. 2026-04-29T17:00:00)."),
    notes: z.string().optional(),
    priority: z.enum(["none", "low", "medium", "high"]).optional(),
  },
  async (args) => {
    try {
      const r = await runOsa<{ id: string; name: string; listName: string }>(
        buildCreateReminderScript(args),
      );
      return {
        content: [{ type: "text" as const, text: `Created [${r.id}] ${r.name} in ${r.listName}` }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
    }
  },
),

tool(
  "update_reminder",
  "Update a reminder by id. Pass only fields to change. ALWAYS go through save_draft first.",
  {
    id: z.string(),
    title: z.string().optional(),
    list: z.string().optional(),
    due: z.string().nullable().optional().describe("ISO 8601, or null to clear."),
    notes: z.string().optional(),
    priority: z.enum(["none", "low", "medium", "high"]).optional(),
  },
  async (args) => {
    try {
      const r = await runOsa<{ id: string; name: string; listName: string }>(
        buildUpdateReminderScript(args),
      );
      return {
        content: [{ type: "text" as const, text: `Updated [${r.id}] ${r.name} (${r.listName})` }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
    }
  },
),

tool(
  "complete_reminder",
  "Mark a reminder as completed. ALWAYS go through save_draft first.",
  { id: z.string() },
  async (args) => {
    try {
      await runOsa(buildCompleteReminderScript(args));
      return { content: [{ type: "text" as const, text: `Completed ${args.id}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
    }
  },
),

tool(
  "delete_reminder",
  "Delete a reminder permanently. Cannot be undone. ALWAYS go through save_draft first.",
  { id: z.string() },
  async (args) => {
    try {
      await runOsa(buildDeleteReminderScript(args));
      return { content: [{ type: "text" as const, text: `Deleted ${args.id}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
    }
  },
),
```

- [ ] **Step 4: Run test to verify all pass**

```bash
npm test -- apple-reminders
```

Expected: PASS, 9/9 (5 from Task 3 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add server/integrations/apple-reminders.ts server/integrations/apple-reminders.test.ts
git commit -m "feat(integrations): apple-reminders write tools (create/update/complete/delete)"
```

---

## Task 5: Apple Notes module — HTML helpers + read tools

**Files:**
- Create: `server/integrations/apple-notes.ts`
- Create: `server/integrations/apple-notes.test.ts`

Notes' AppleScript returns HTML for `body`. We need conversion both ways. Read tools: `list_folders`, `list_notes`, `search_notes`, `read_note`.

- [ ] **Step 1: Write failing tests for html helpers + script builders**

Create `server/integrations/apple-notes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  htmlToPlainText,
  plainTextToHtml,
  buildListFoldersScript,
  buildListNotesScript,
  buildSearchNotesScript,
  buildReadNoteScript,
} from "./apple-notes.js";

describe("html helpers", () => {
  it("strips tags and converts <br> to newlines", () => {
    expect(htmlToPlainText("<div>hello<br/>world</div>")).toBe("hello\nworld");
  });

  it("converts <li> to '- ' bullets", () => {
    expect(htmlToPlainText("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });

  it("decodes html entities", () => {
    expect(htmlToPlainText("&amp; &lt;x&gt; &quot;y&quot;")).toBe('& <x> "y"');
  });

  it("plain → html: wraps newlines as <br>", () => {
    expect(plainTextToHtml("a\nb")).toBe("a<br>b");
  });

  it("plain → html: '- ' lines become <li>", () => {
    const out = plainTextToHtml("- a\n- b");
    expect(out).toContain("<li>a</li>");
    expect(out).toContain("<li>b</li>");
  });
});

describe("apple-notes script builders", () => {
  it("list_folders: returns JXA", () => {
    const s = buildListFoldersScript();
    expect(s).toContain("Application('Notes')");
    expect(s).toContain("JSON.stringify");
  });

  it("list_notes: filters by folder", () => {
    const s = buildListNotesScript({ folder: "Work", limit: 25 });
    expect(s).toContain(`"Work"`);
    expect(s).toContain("25");
  });

  it("search_notes: lowercases query", () => {
    const s = buildSearchNotesScript({ query: "APARTMENT", limit: 50 });
    expect(s).toContain("apartment");
  });

  it("read_note: includes id literal", () => {
    const s = buildReadNoteScript({ id: "x-coredata://abc" });
    expect(s).toContain(`"x-coredata://abc"`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- apple-notes
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `server/integrations/apple-notes.ts`:

```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IntegrationModule } from "./registry.js";
import { runOsa, jsonLiteral, OsaError } from "./apple-script.js";

// ─────────────────────────────── HTML helpers ───────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function htmlToPlainText(html: string): string {
  let out = html;
  // Decode entities first so any < > inside them doesn't get stripped.
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    out = out.replaceAll(entity, char);
  }
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  // <br> family → newline.
  out = out.replace(/<br\s*\/?>/gi, "\n");
  // <li>...</li> → "- text".
  out = out.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1");
  // Block-level closes → newline.
  out = out.replace(/<\/(p|div|h[1-6]|ul|ol|li)>/gi, "\n");
  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, "");
  // Collapse runs of >2 newlines to 2.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export function plainTextToHtml(text: string): string {
  // Escape HTML-significant chars first.
  let safe = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  // Bullets.
  const lines = safe.split("\n");
  const bulletGroups: string[] = [];
  let buf: string[] = [];
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^- (.*)$/);
    if (m) {
      if (!inList) {
        bulletGroups.push(buf.join("<br>"));
        buf = [];
        inList = true;
      }
      buf.push(`<li>${m[1]}</li>`);
    } else {
      if (inList) {
        bulletGroups.push("<ul>" + buf.join("") + "</ul>");
        buf = [];
        inList = false;
      }
      buf.push(line);
    }
  }
  if (inList) bulletGroups.push("<ul>" + buf.join("") + "</ul>");
  else bulletGroups.push(buf.join("<br>"));
  return bulletGroups.filter(Boolean).join("");
}

// ─────────────────────────────── Script builders ─────────────────────────────

export function buildListFoldersScript(): string {
  return `
    const Notes = Application('Notes');
    const folders = Notes.folders();
    const out = folders.map(f => ({ name: f.name(), count: f.notes().length }));
    JSON.stringify(out);
  `;
}

export interface ListNotesArgs {
  folder?: string;
  limit?: number;
}

export function buildListNotesScript(args: ListNotesArgs): string {
  const limit = args.limit ?? 50;
  return `
    const Notes = Application('Notes');
    const args = ${jsonLiteral(args)};
    const limit = ${limit};
    const folders = args.folder
      ? Notes.folders.whose({ name: args.folder })()
      : Notes.folders();
    if (args.folder && folders.length === 0) {
      const all = Notes.folders().map(f => f.name());
      throw new Error("Folder not found: " + args.folder + ". Available: " + all.join(", "));
    }
    const out = [];
    for (const f of folders) {
      for (const n of f.notes()) {
        out.push({
          id: n.id(),
          name: n.name(),
          folderName: f.name(),
          modified: n.modificationDate().toISOString(),
          preview: String(n.plaintext() || "").slice(0, 200).replace(/\\s+/g, " "),
        });
      }
    }
    out.sort((a, b) => b.modified.localeCompare(a.modified));
    JSON.stringify(out.slice(0, limit));
  `;
}

export interface SearchNotesArgs {
  query: string;
  limit?: number;
}

export function buildSearchNotesScript(args: SearchNotesArgs): string {
  const limit = args.limit ?? 50;
  return `
    const Notes = Application('Notes');
    const q = ${jsonLiteral(args.query.toLowerCase())};
    const limit = ${limit};
    const out = [];
    outer: for (const f of Notes.folders()) {
      for (const n of f.notes()) {
        const title = String(n.name() || "").toLowerCase();
        const body = String(n.plaintext() || "").toLowerCase();
        if (!title.includes(q) && !body.includes(q)) continue;
        out.push({
          id: n.id(),
          name: n.name(),
          folderName: f.name(),
          modified: n.modificationDate().toISOString(),
          preview: String(n.plaintext() || "").slice(0, 200).replace(/\\s+/g, " "),
        });
        if (out.length >= limit) break outer;
      }
    }
    JSON.stringify(out);
  `;
}

export interface ReadNoteArgs {
  id: string;
}

export function buildReadNoteScript(args: ReadNoteArgs): string {
  return `
    const Notes = Application('Notes');
    const id = ${jsonLiteral(args.id)};
    for (const f of Notes.folders()) {
      const m = f.notes.whose({ id })();
      if (m.length) {
        const n = m[0];
        return JSON.stringify({
          id: n.id(),
          name: n.name(),
          folderName: f.name(),
          modified: n.modificationDate().toISOString(),
          body: n.body(),
        });
      }
    }
    throw new Error("Note not found: " + id);
  `;
}

// ─────────────────────────────── Formatting ─────────────────────────────────

interface NoteRow {
  id: string;
  name: string;
  folderName: string;
  modified: string;
  preview?: string;
  body?: string;
}

function formatNoteLine(n: NoteRow): string {
  const date = n.modified.slice(0, 10);
  const preview = (n.preview ?? "").trim();
  return preview
    ? `[${n.id}] ${n.name} · ${n.folderName} · ${date} · ${preview}`
    : `[${n.id}] ${n.name} · ${n.folderName} · ${date}`;
}

function osaErrorToText(err: unknown): string {
  if (err instanceof OsaError) {
    if (err.kind === "permission") {
      return "Not authorized. Open System Settings → Privacy & Security → Automation → Node → enable Notes, then retry.";
    }
    return `Apple Notes error: ${err.message}`;
  }
  return `Apple Notes error: ${String(err)}`;
}

// ─────────────────────────────── IntegrationModule ─────────────────────────

export function buildAppleNotesIntegrationModule(): IntegrationModule {
  return {
    name: "apple-notes",
    description: "Apple Notes (local macOS)",
    requiredEnv: [],
    createServer: async () =>
      createSdkMcpServer({
        name: "apple-notes",
        version: "0.1.0",
        tools: [
          tool(
            "list_folders",
            "List all Notes folders on this Mac with note counts.",
            {},
            async () => {
              try {
                const folders = await runOsa<{ name: string; count: number }[]>(
                  buildListFoldersScript(),
                );
                const body = folders.map((f) => `${f.name}: ${f.count}`).join("\n");
                return { content: [{ type: "text" as const, text: body || "No folders." }] };
              } catch (err) {
                return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
              }
            },
          ),

          tool(
            "list_notes",
            "List notes (title + 200-char preview + modified date), optionally filtered to a folder. Sorted by modified desc, up to `limit` (default 50).",
            {
              folder: z.string().optional(),
              limit: z.number().int().positive().max(200).optional(),
            },
            async (args) => {
              try {
                const rows = await runOsa<NoteRow[]>(buildListNotesScript(args));
                if (!rows.length) {
                  return { content: [{ type: "text" as const, text: "No notes match." }] };
                }
                return {
                  content: [{ type: "text" as const, text: rows.map(formatNoteLine).join("\n") }],
                };
              } catch (err) {
                return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
              }
            },
          ),

          tool(
            "search_notes",
            "Substring search across note titles and bodies. Up to `limit` hits across all folders.",
            {
              query: z.string(),
              limit: z.number().int().positive().max(200).optional(),
            },
            async (args) => {
              try {
                const rows = await runOsa<NoteRow[]>(
                  buildSearchNotesScript(args),
                  { timeoutMs: 30_000 },
                );
                if (!rows.length) {
                  return { content: [{ type: "text" as const, text: "No matches." }] };
                }
                return {
                  content: [{ type: "text" as const, text: rows.map(formatNoteLine).join("\n") }],
                };
              } catch (err) {
                return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
              }
            },
          ),

          tool(
            "read_note",
            "Read the full body of a note by id. HTML stripped to plain text (preserves '- ' bullets and newlines).",
            { id: z.string() },
            async (args) => {
              try {
                const n = await runOsa<NoteRow>(buildReadNoteScript(args));
                const plain = htmlToPlainText(n.body ?? "");
                const header = `# ${n.name}\n(folder: ${n.folderName} · modified ${n.modified.slice(0, 10)})\n\n`;
                return { content: [{ type: "text" as const, text: header + plain }] };
              } catch (err) {
                return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
              }
            },
          ),

          // Write tools added in Task 6.
        ],
      }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- apple-notes
```

Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add server/integrations/apple-notes.ts server/integrations/apple-notes.test.ts
git commit -m "feat(integrations): apple-notes html helpers + read tools"
```

---

## Task 6: Apple Notes module — write tools

**Files:**
- Modify: `server/integrations/apple-notes.ts`
- Modify: `server/integrations/apple-notes.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `server/integrations/apple-notes.test.ts`:

```ts
import {
  buildCreateNoteScript,
  buildAppendToNoteScript,
  buildUpdateNoteScript,
  buildDeleteNoteScript,
} from "./apple-notes.js";

describe("apple-notes write builders", () => {
  it("create_note: makes a Note in the named folder", () => {
    const s = buildCreateNoteScript({
      title: "Trip plans",
      body: "- Flight\n- Hotel",
      folder: "Travel",
    });
    expect(s).toContain(`"Travel"`);
    expect(s).toContain("Notes.Note");
    expect(s).toContain(`"Trip plans"`);
  });

  it("append_to_note: appends body content", () => {
    const s = buildAppendToNoteScript({ id: "x-coredata://abc", content: "extra" });
    expect(s).toContain(`"x-coredata://abc"`);
    expect(s).toContain("extra");
  });

  it("update_note: replaces title or body", () => {
    const s = buildUpdateNoteScript({ id: "x-coredata://abc", title: "new" });
    expect(s).toContain(`"new"`);
  });

  it("delete_note: deletes by id", () => {
    const s = buildDeleteNoteScript({ id: "x-coredata://abc" });
    expect(s).toContain(".delete()");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- apple-notes
```

Expected: 4 new failures.

- [ ] **Step 3: Add write builders + tools**

Append to `server/integrations/apple-notes.ts` (above `buildAppleNotesIntegrationModule`):

```ts
export interface CreateNoteArgs {
  title: string;
  body: string;
  folder?: string;
}

export function buildCreateNoteScript(args: CreateNoteArgs): string {
  const html = plainTextToHtml(args.body);
  return `
    const Notes = Application('Notes');
    const args = ${jsonLiteral({ title: args.title, html, folder: args.folder })};
    const folder = args.folder
      ? Notes.folders.whose({ name: args.folder })()[0]
      : Notes.defaultFolder();
    if (!folder) throw new Error("Folder not found: " + args.folder);
    const fullBody = "<h1>" + args.title.replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[c])) + "</h1>" + args.html;
    const n = Notes.Note({ name: args.title, body: fullBody });
    folder.notes.push(n);
    JSON.stringify({ id: n.id(), name: n.name(), folderName: folder.name() });
  `;
}

export interface AppendToNoteArgs {
  id: string;
  content: string;
}

export function buildAppendToNoteScript(args: AppendToNoteArgs): string {
  const html = plainTextToHtml(args.content);
  return `
    const Notes = Application('Notes');
    const id = ${jsonLiteral(args.id)};
    const html = ${jsonLiteral(html)};
    for (const f of Notes.folders()) {
      const m = f.notes.whose({ id })();
      if (m.length) {
        const n = m[0];
        n.body = String(n.body() || "") + "<br>" + html;
        return JSON.stringify({ id: n.id(), name: n.name() });
      }
    }
    throw new Error("Note not found: " + id);
  `;
}

export interface UpdateNoteArgs {
  id: string;
  title?: string;
  body?: string;
}

export function buildUpdateNoteScript(args: UpdateNoteArgs): string {
  const html = args.body !== undefined ? plainTextToHtml(args.body) : null;
  return `
    const Notes = Application('Notes');
    const id = ${jsonLiteral(args.id)};
    const newTitle = ${jsonLiteral(args.title ?? null)};
    const newHtml = ${jsonLiteral(html)};
    for (const f of Notes.folders()) {
      const m = f.notes.whose({ id })();
      if (m.length) {
        const n = m[0];
        if (newTitle !== null) n.name = newTitle;
        if (newHtml !== null) {
          const titleH1 = "<h1>" + (newTitle || n.name()).replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[c])) + "</h1>";
          n.body = titleH1 + newHtml;
        }
        return JSON.stringify({ id: n.id(), name: n.name() });
      }
    }
    throw new Error("Note not found: " + id);
  `;
}

export interface DeleteNoteArgs {
  id: string;
}

export function buildDeleteNoteScript(args: DeleteNoteArgs): string {
  return `
    const Notes = Application('Notes');
    const id = ${jsonLiteral(args.id)};
    for (const f of Notes.folders()) {
      const m = f.notes.whose({ id })();
      if (m.length) {
        m[0].delete();
        return JSON.stringify({ id, deleted: true });
      }
    }
    throw new Error("Note not found: " + id);
  `;
}
```

Inside `tools: [...]` of `buildAppleNotesIntegrationModule()`, append (replacing `// Write tools added in Task 6.`):

```ts
tool(
  "create_note",
  "Create a note. Body accepts plain text with '- ' bullets and newlines; converted to minimal HTML internally. ALWAYS go through save_draft first.",
  {
    title: z.string(),
    body: z.string(),
    folder: z.string().optional(),
  },
  async (args) => {
    try {
      const n = await runOsa<{ id: string; name: string; folderName: string }>(
        buildCreateNoteScript(args),
      );
      return { content: [{ type: "text" as const, text: `Created [${n.id}] ${n.name} in ${n.folderName}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
    }
  },
),

tool(
  "append_to_note",
  "Append plain-text content to the end of an existing note. ALWAYS go through save_draft first.",
  { id: z.string(), content: z.string() },
  async (args) => {
    try {
      const n = await runOsa<{ id: string; name: string }>(buildAppendToNoteScript(args));
      return { content: [{ type: "text" as const, text: `Appended to [${n.id}] ${n.name}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
    }
  },
),

tool(
  "update_note",
  "Replace a note's title and/or body. Body is plain text, converted to minimal HTML. ALWAYS go through save_draft first.",
  {
    id: z.string(),
    title: z.string().optional(),
    body: z.string().optional(),
  },
  async (args) => {
    try {
      const n = await runOsa<{ id: string; name: string }>(buildUpdateNoteScript(args));
      return { content: [{ type: "text" as const, text: `Updated [${n.id}] ${n.name}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
    }
  },
),

tool(
  "delete_note",
  "Delete a note permanently. Cannot be undone. ALWAYS go through save_draft first.",
  { id: z.string() },
  async (args) => {
    try {
      await runOsa(buildDeleteNoteScript(args));
      return { content: [{ type: "text" as const, text: `Deleted ${args.id}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: osaErrorToText(err) }], isError: true };
    }
  },
),
```

- [ ] **Step 4: Run test to verify all pass**

```bash
npm test -- apple-notes
```

Expected: PASS, 13/13 (9 from Task 5 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add server/integrations/apple-notes.ts server/integrations/apple-notes.test.ts
git commit -m "feat(integrations): apple-notes write tools (create/append/update/delete)"
```

---

## Task 7: Permission status caching + warmup

**Files:**
- Create: `server/integrations/apple-permissions.ts`

A small module that runs the smallest possible probe per app, classifies the result, caches it in memory + Convex `settings` (key: `apple.<slug>.permission`), and exposes a warmup function used by both the CLI script and the HTTP route.

- [ ] **Step 1: Create the module**

Create `server/integrations/apple-permissions.ts`:

```ts
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { runOsa, OsaError } from "./apple-script.js";
import { buildListListsScript } from "./apple-reminders.js";
import { buildListFoldersScript } from "./apple-notes.js";

export type PermissionStatus = "granted" | "denied" | "unknown";
export type AppleSlug = "apple-reminders" | "apple-notes";

interface CacheEntry {
  status: PermissionStatus;
  checkedAt: number;
  durationMs: number;
}

const memoryCache = new Map<AppleSlug, CacheEntry>();
const STALE_MS = 60 * 60 * 1000; // 1h

const PROBES: Record<AppleSlug, () => string> = {
  "apple-reminders": buildListListsScript,
  "apple-notes": buildListFoldersScript,
};

function settingKey(slug: AppleSlug): string {
  return `${slug}.permission`;
}

async function loadFromConvex(slug: AppleSlug): Promise<PermissionStatus> {
  const v = await convex.query(api.settings.get, { key: settingKey(slug) });
  if (v === "granted" || v === "denied") return v;
  return "unknown";
}

async function persist(slug: AppleSlug, status: PermissionStatus): Promise<void> {
  await convex.mutation(api.settings.set, { key: settingKey(slug), value: status });
}

export async function getCachedPermission(slug: AppleSlug): Promise<PermissionStatus> {
  const mem = memoryCache.get(slug);
  if (mem && Date.now() - mem.checkedAt < STALE_MS) return mem.status;
  const persisted = await loadFromConvex(slug);
  if (persisted !== "unknown") {
    memoryCache.set(slug, { status: persisted, checkedAt: Date.now(), durationMs: 0 });
  }
  return persisted;
}

export async function probePermission(slug: AppleSlug): Promise<{
  status: PermissionStatus;
  durationMs: number;
  sample?: unknown;
  errorMessage?: string;
}> {
  const start = Date.now();
  const buildScript = PROBES[slug];
  try {
    const sample = await runOsa(buildScript(), { timeoutMs: 5_000 });
    const durationMs = Date.now() - start;
    memoryCache.set(slug, { status: "granted", checkedAt: Date.now(), durationMs });
    await persist(slug, "granted");
    return { status: "granted", durationMs, sample };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (err instanceof OsaError && err.kind === "permission") {
      memoryCache.set(slug, { status: "denied", checkedAt: Date.now(), durationMs });
      await persist(slug, "denied");
      return { status: "denied", durationMs, errorMessage: err.message };
    }
    memoryCache.set(slug, { status: "unknown", checkedAt: Date.now(), durationMs });
    return {
      status: "unknown",
      durationMs,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function warmupAllPermissions(): Promise<
  Record<AppleSlug, Awaited<ReturnType<typeof probePermission>>>
> {
  const slugs: AppleSlug[] = ["apple-reminders", "apple-notes"];
  const results = {} as Record<AppleSlug, Awaited<ReturnType<typeof probePermission>>>;
  for (const slug of slugs) {
    results[slug] = await probePermission(slug);
  }
  return results;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/integrations/apple-permissions.ts
git commit -m "feat(integrations): apple-permissions caching + warmup"
```

---

## Task 8: Wire into integration registry

**Files:**
- Modify: `server/integrations/registry.ts`

Add `darwin`-gated registration of both apple modules.

- [ ] **Step 1: Modify `registry.ts`**

In `server/integrations/registry.ts`, modify `loadIntegrations()` to register the apple modules first:

```ts
export async function loadIntegrations(): Promise<void> {
  if (process.platform === "darwin") {
    const { buildAppleRemindersIntegrationModule } = await import(
      "./apple-reminders.js"
    );
    const { buildAppleNotesIntegrationModule } = await import("./apple-notes.js");
    registerIntegration(buildAppleRemindersIntegrationModule());
    registerIntegration(buildAppleNotesIntegrationModule());
    console.log("[apple] registered: apple-reminders, apple-notes");
  }
  const { registerComposioToolkits } = await import("./composio-loader.js");
  await registerComposioToolkits();
  const loaded = [...registry.keys()];
  console.log(
    `[integrations] loaded: ${loaded.join(", ") || "(none — connect a toolkit from the Debug UI's Connections tab)"}`,
  );
}
```

- [ ] **Step 2: Smoke test the server**

```bash
npm run dev:server
```

Expected: server boots; logs show `[apple] registered: apple-reminders, apple-notes` and the integrations line includes both. Ctrl-C to stop.

- [ ] **Step 3: Commit**

```bash
git add server/integrations/registry.ts
git commit -m "feat(integrations): register apple-reminders + apple-notes on darwin"
```

---

## Task 9: HTTP routes for the dashboard

**Files:**
- Create: `server/apple-routes.ts`
- Modify: `server/index.ts`

Endpoints: `GET /apple/status`, `POST /apple/test/:slug`, `POST /apple/warmup`, `GET /apple/stats/:slug`.

- [ ] **Step 1: Create `server/apple-routes.ts`**

```ts
import { Router } from "express";
import {
  type AppleSlug,
  getCachedPermission,
  probePermission,
  warmupAllPermissions,
} from "./integrations/apple-permissions.js";
import { runOsa } from "./integrations/apple-script.js";
import { buildListListsScript } from "./integrations/apple-reminders.js";
import { buildListFoldersScript } from "./integrations/apple-notes.js";

const SLUGS: AppleSlug[] = ["apple-reminders", "apple-notes"];

interface StatsCacheEntry {
  fetchedAt: number;
  data: unknown;
}
const STATS_CACHE_MS = 60_000;
const statsCache = new Map<AppleSlug, StatsCacheEntry>();

function isAppleSlug(s: string): s is AppleSlug {
  return SLUGS.includes(s as AppleSlug);
}

export function createAppleRouter(): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    const out: Record<string, { loaded: boolean; permission: string }> = {};
    for (const slug of SLUGS) {
      out[slug] = {
        loaded: process.platform === "darwin",
        permission: await getCachedPermission(slug),
      };
    }
    res.json(out);
  });

  router.post("/test/:slug", async (req, res) => {
    const slug = req.params.slug;
    if (!isAppleSlug(slug)) {
      res.status(400).json({ error: "unknown slug" });
      return;
    }
    const result = await probePermission(slug);
    res.json(result);
  });

  router.post("/warmup", async (_req, res) => {
    const results = await warmupAllPermissions();
    res.json(results);
  });

  router.get("/stats/:slug", async (req, res) => {
    const slug = req.params.slug;
    if (!isAppleSlug(slug)) {
      res.status(400).json({ error: "unknown slug" });
      return;
    }
    const cached = statsCache.get(slug);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_MS) {
      res.json(cached.data);
      return;
    }
    try {
      const data =
        slug === "apple-reminders"
          ? await runOsa<unknown[]>(buildListListsScript())
          : await runOsa<unknown[]>(buildListFoldersScript());
      const payload = { slug, count: Array.isArray(data) ? data.length : 0, items: data };
      statsCache.set(slug, { fetchedAt: Date.now(), data: payload });
      res.json(payload);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
```

- [ ] **Step 2: Mount in `server/index.ts`**

In `server/index.ts`, add the import and mount:

```ts
import { createAppleRouter } from "./apple-routes.js";
```

And after `app.use("/composio", createComposioRouter());`:

```ts
if (process.platform === "darwin") {
  app.use("/apple", createAppleRouter());
}
```

- [ ] **Step 3: Smoke test**

```bash
npm run dev:server
# in another shell:
curl http://localhost:3456/apple/status
```

Expected: JSON like `{"apple-reminders":{"loaded":true,"permission":"unknown"},"apple-notes":{"loaded":true,"permission":"unknown"}}`. Ctrl-C the server.

- [ ] **Step 4: Commit**

```bash
git add server/apple-routes.ts server/index.ts
git commit -m "feat(server): /apple/* routes for status, probe, warmup, stats"
```

---

## Task 10: CLI permission warmup script

**Files:**
- Create: `scripts/apple-permissions.mjs`

Calls the same `warmupAllPermissions` function and prints a 1-line summary. The `npm run apple:permissions` script was already added to `package.json` in Task 1.

- [ ] **Step 1: Create `scripts/apple-permissions.ts`**

```ts
import "dotenv/config";
import { warmupAllPermissions } from "../server/integrations/apple-permissions.js";

console.log("Triggering Apple Automation prompts (Reminders, Notes)...");
console.log("Click 'OK' on each macOS prompt that appears.\n");

const results = await warmupAllPermissions();

for (const [slug, r] of Object.entries(results)) {
  const icon = r.status === "granted" ? "✓" : r.status === "denied" ? "✗" : "?";
  const detail =
    r.status === "granted"
      ? `(${r.durationMs}ms)`
      : r.errorMessage
        ? `— ${r.errorMessage}`
        : "";
  console.log(`${icon} ${slug}: ${r.status} ${detail}`);
}

const denied = Object.values(results).filter((r) => r.status === "denied");
if (denied.length) {
  console.log(
    "\nFix denied permissions in System Settings → Privacy & Security → Automation → Node",
  );
  process.exit(1);
}
```

The `apple:permissions` npm script (added in Task 1) already points at this file via `tsx`.

- [ ] **Step 2: Run it**

```bash
npm run apple:permissions
```

Expected: macOS prompts (first run only). After clicking OK, output like:

```
✓ apple-reminders: granted (123ms)
✓ apple-notes: granted (98ms)
```

- [ ] **Step 3: Commit**

```bash
git add scripts/apple-permissions.ts
git commit -m "feat(scripts): apple:permissions warmup CLI"
```

---

## Task 11: Debug UI — add Apple logos

**Files:**
- Modify: `debug/src/lib/branding.tsx`

Two new entries in `TOOL_BRANDS` so the Agents tab renders the right logos.

- [ ] **Step 1: Add entries**

In `debug/src/lib/branding.tsx`, add to the `TOOL_BRANDS` array (after the existing `imessage` entry):

```ts
{
  key: "apple-reminders",
  displayName: "Apple Reminders",
  domain: "icloud.com",
  aliases: ["apple-reminders", "applereminders"],
},
{
  key: "apple-notes",
  displayName: "Apple Notes",
  domain: "icloud.com",
  aliases: ["apple-notes", "applenotes"],
},
```

(The `icloud.com` favicon shows the Apple logo, distinguishing them from cloud SaaS toolkits.)

- [ ] **Step 2: Verify in dev**

```bash
npm run dev:debug
```

Open http://localhost:5173 → Agents tab. (Logos won't show until an apple-* tool has actually run, which happens after the smoke test in Task 14.)

- [ ] **Step 3: Commit**

```bash
git add debug/src/lib/branding.tsx
git commit -m "feat(debug-ui): apple-reminders + apple-notes logo entries"
```

---

## Task 12: Debug UI — add Local view + nav entry

**Files:**
- Modify: `debug/src/App.tsx`

Add `local` to the `View` union, an icon to `NAV_ICONS`, an entry to `NAV`, and a conditional render.

- [ ] **Step 1: Modify `App.tsx`**

In `debug/src/App.tsx`:

1. Add `Apple01Icon` to the existing icon import block at the top of the file (alongside `Link04Icon`, etc.):

```ts
import {
  MachineRobotIcon,
  AiBrain02Icon,
  WorkflowCircle03Icon,
  Activity01Icon,
  Link04Icon,
  DashboardSquare01Icon,
  ArrowShrink02Icon,
  Apple01Icon,
} from "@hugeicons/core-free-icons";
```

(Verified to exist in `@hugeicons/core-free-icons` at the version pinned in this repo.)

2. Update the `View` type union:

```ts
type View =
  | "dashboard"
  | "agents"
  | "automations"
  | "memory"
  | "events"
  | "consolidation"
  | "connections"
  | "local";
```

3. Add to `NAV_ICONS`:

```ts
const NAV_ICONS: Record<View, any> = {
  dashboard: DashboardSquare01Icon,
  agents: MachineRobotIcon,
  automations: WorkflowCircle03Icon,
  memory: AiBrain02Icon,
  events: Activity01Icon,
  consolidation: ArrowShrink02Icon,
  connections: Link04Icon,
  local: Apple01Icon,
};
```

4. Add to `NAV` (after `connections`):

```ts
const NAV: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "agents", label: "Agents" },
  { id: "automations", label: "Automations" },
  { id: "memory", label: "Memory" },
  { id: "events", label: "Events" },
  { id: "consolidation", label: "Consolidation" },
  { id: "connections", label: "Connections" },
  { id: "local", label: "Local" },
];
```

5. Add the import (top of file, with the other panel imports):

```ts
import { LocalPanel } from "./components/LocalPanel.js";
```

6. Add the conditional render (in the `<main>` block):

```tsx
{view === "local" && <LocalPanel isDark={isDark} />}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: clean (will fail because `LocalPanel` doesn't exist yet — that's Task 13).

If typecheck blocks the commit, comment out the import + render until Task 13. Otherwise, leave them; Task 13 fixes the missing module.

- [ ] **Step 3: Commit**

```bash
git add debug/src/App.tsx
git commit -m "feat(debug-ui): add Local view to navigation"
```

---

## Task 13: Debug UI — `LocalPanel` component

**Files:**
- Create: `debug/src/components/LocalPanel.tsx`

Cards for `apple-reminders` and `apple-notes`, plus a setup card with Permission warmup button. Polls `GET /apple/status` on mount + after every action.

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useState, useCallback } from "react";
import { IntegrationLogo } from "../lib/branding.js";

interface Props {
  isDark: boolean;
}

interface Status {
  loaded: boolean;
  permission: "granted" | "denied" | "unknown";
}

interface AppleStatus {
  "apple-reminders": Status;
  "apple-notes": Status;
}

interface Stats {
  count: number;
  items: { name: string; total?: number; count?: number; dueToday?: number; overdue?: number }[];
}

const SLUGS = ["apple-reminders", "apple-notes"] as const;
type Slug = (typeof SLUGS)[number];

const LABELS: Record<Slug, string> = {
  "apple-reminders": "Apple Reminders",
  "apple-notes": "Apple Notes",
};

function permissionBadge(p: Status["permission"], isDark: boolean): JSX.Element {
  const map: Record<Status["permission"], { label: string; cls: string }> = {
    granted: { label: "Permission ✓", cls: isDark ? "text-emerald-400" : "text-emerald-600" },
    denied: { label: "Permission ✗", cls: isDark ? "text-rose-400" : "text-rose-600" },
    unknown: { label: "Permission ?", cls: isDark ? "text-amber-400" : "text-amber-600" },
  };
  const { label, cls } = map[p];
  return <span className={`text-xs ${cls}`}>{label}</span>;
}

export function LocalPanel({ isDark }: Props) {
  const [status, setStatus] = useState<AppleStatus | null>(null);
  const [stats, setStats] = useState<Record<Slug, Stats | null>>({
    "apple-reminders": null,
    "apple-notes": null,
  });
  const [busy, setBusy] = useState<Slug | "warmup" | null>(null);

  const refreshStatus = useCallback(async () => {
    const r = await fetch("/apple/status");
    if (r.ok) setStatus(await r.json());
  }, []);

  const fetchStats = useCallback(async (slug: Slug) => {
    try {
      const r = await fetch(`/apple/stats/${slug}`);
      if (r.ok) {
        const data = await r.json();
        setStats((prev) => ({ ...prev, [slug]: data }));
      }
    } catch {
      // silent — stats are optional eye candy
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    fetchStats("apple-reminders");
    fetchStats("apple-notes");
  }, [refreshStatus, fetchStats]);

  const onTest = async (slug: Slug) => {
    setBusy(slug);
    try {
      await fetch(`/apple/test/${slug}`, { method: "POST" });
      await refreshStatus();
      await fetchStats(slug);
    } finally {
      setBusy(null);
    }
  };

  const onWarmup = async () => {
    setBusy("warmup");
    try {
      await fetch("/apple/warmup", { method: "POST" });
      await refreshStatus();
      await Promise.all(SLUGS.map((s) => fetchStats(s)));
    } finally {
      setBusy(null);
    }
  };

  const cardCls = isDark
    ? "bg-slate-900/50 border-slate-800"
    : "bg-white border-slate-200";

  return (
    <div className="space-y-4">
      <div>
        <h2 className={`text-lg font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>
          Local integrations
        </h2>
        <p className={`text-sm ${isDark ? "text-slate-400" : "text-slate-500"}`}>
          Run on the Mac hosting Boop. macOS-only. No OAuth — uses native AppleScript automation.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SLUGS.map((slug) => {
          const s = status?.[slug];
          const st = stats[slug];
          const isBusy = busy === slug;
          return (
            <div key={slug} className={`rounded-lg border ${cardCls} p-4`}>
              <div className="flex items-center gap-3 mb-3">
                <IntegrationLogo raw={slug} size={28} />
                <div className="flex-1">
                  <div className={`font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>
                    {LABELS[slug]}
                  </div>
                  <div className="flex gap-2 items-center mt-0.5">
                    <span className={`text-xs ${s?.loaded ? (isDark ? "text-emerald-400" : "text-emerald-600") : (isDark ? "text-slate-500" : "text-slate-400")}`}>
                      {s?.loaded ? "Loaded" : "Not loaded"}
                    </span>
                    <span className={isDark ? "text-slate-600" : "text-slate-300"}>·</span>
                    {s ? permissionBadge(s.permission, isDark) : null}
                  </div>
                </div>
              </div>

              {st && (
                <div className={`text-sm mb-3 ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                  {slug === "apple-reminders" ? (
                    <>
                      {st.count} lists ·{" "}
                      {st.items.reduce((acc, l) => acc + (l.total ?? 0), 0)} reminders ·{" "}
                      {st.items.reduce((acc, l) => acc + (l.dueToday ?? 0), 0)} due today
                    </>
                  ) : (
                    <>
                      {st.count} folders ·{" "}
                      {st.items.reduce((acc, f) => acc + (f.count ?? 0), 0)} notes
                    </>
                  )}
                </div>
              )}

              <button
                onClick={() => onTest(slug)}
                disabled={isBusy}
                className={`text-xs px-3 py-1.5 rounded ${
                  isDark
                    ? "bg-slate-800 hover:bg-slate-700 text-slate-200"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                } disabled:opacity-50`}
              >
                {isBusy ? "Testing…" : s?.permission === "granted" ? "Test access" : "Grant permission"}
              </button>
            </div>
          );
        })}
      </div>

      <div className={`rounded-lg border ${cardCls} p-4`}>
        <div className={`font-medium mb-2 ${isDark ? "text-slate-100" : "text-slate-800"}`}>
          Setup
        </div>
        <p className={`text-sm mb-3 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
          Click <strong>Permission warmup</strong> to trigger macOS Automation prompts for both
          apps in one go. If a permission ends up denied, fix it in System Settings → Privacy
          &amp; Security → Automation → Node.
        </p>
        <button
          onClick={onWarmup}
          disabled={busy === "warmup"}
          className={`text-sm px-4 py-2 rounded ${
            isDark
              ? "bg-violet-600 hover:bg-violet-500 text-white"
              : "bg-violet-500 hover:bg-violet-600 text-white"
          } disabled:opacity-50`}
        >
          {busy === "warmup" ? "Warming up…" : "Permission warmup"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles + the dev UI renders**

```bash
npm run typecheck
```

Then with the server + debug UI running (`npm run dev`), open http://localhost:5173 → Local tab. Both cards should appear.

- [ ] **Step 3: Commit**

```bash
git add debug/src/components/LocalPanel.tsx
git commit -m "feat(debug-ui): LocalPanel component with status + warmup"
```

---

## Task 14: End-to-end smoke test

**Files:** none — manual verification.

Verify the integration works with the running agent. This is a sanity gate before docs.

- [ ] **Step 1: Start the dev stack**

```bash
npm run dev
```

Wait for the banner.

- [ ] **Step 2: Run permissions warmup if not already done**

In another shell:

```bash
npm run apple:permissions
```

Confirm both `granted`.

- [ ] **Step 3: Test from the chat endpoint**

```bash
curl -s -X POST http://localhost:3456/chat \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"smoke-apple-1","content":"What reminder lists do I have?"}'
```

Expected: a response that names your reminder lists. In the server logs, look for `[agent ...] tool: list_lists` and `[agent ...] done`.

- [ ] **Step 4: Test a write through the draft flow**

```bash
curl -s -X POST http://localhost:3456/chat \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"smoke-apple-1","content":"Add a reminder to test boop, due tomorrow at 5pm"}'
```

Expected: response says it staged a draft. Then:

```bash
curl -s -X POST http://localhost:3456/chat \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"smoke-apple-1","content":"send"}'
```

Expected: response confirms the reminder was created. Open Reminders.app and confirm it's there. Delete it manually to clean up.

- [ ] **Step 5: Verify the Local tab in the dashboard**

Open http://localhost:5173 → Local tab.

- Both cards show "Loaded · Permission ✓"
- Stats show non-zero counts
- Click "Test access" — completes without error.

- [ ] **Step 6: No commit needed** (smoke-only step). Stop the dev stack.

If anything fails, do NOT proceed to docs. Diagnose: server logs first, then `npm test` to confirm unit tests still pass, then `npm run typecheck`.

---

## Task 15: Update INTEGRATIONS.md

**Files:**
- Modify: `INTEGRATIONS.md`

Add a new section explaining the Apple modules, permissions setup, and the Local tab.

- [ ] **Step 1: Append to `INTEGRATIONS.md`**

After the existing "Notes" section at the bottom of `INTEGRATIONS.md`, append:

```markdown
---

## Local Apple integrations (macOS only)

Boop ships with two integrations that run against the Mac it's hosted on, alongside the Composio cloud catalog:

- `apple-reminders` — Reminders R/W (8 tools: list_lists, list_reminders, search_reminders, get_reminder, create_reminder, update_reminder, complete_reminder, delete_reminder).
- `apple-notes` — Notes R/W (8 tools: list_folders, list_notes, search_notes, read_note, create_note, append_to_note, update_note, delete_note).

These use AppleScript / JXA via `osascript`. They auto-register at server boot when `process.platform === "darwin"`. No env var, no Connections-tab card.

### One-time permission grant

The first AppleScript call to each app triggers a macOS Automation prompt against the parent Node process. Run the warmup once before texting Boop:

```bash
npm run apple:permissions
```

You'll see two macOS dialogs. Click **OK** on each. Output:

```
✓ apple-reminders: granted (123ms)
✓ apple-notes: granted (98ms)
```

If a prompt was missed (or denied by mistake), fix it in **System Settings → Privacy & Security → Automation → Node** — toggle Reminders and Notes on.

### Local tab in the dashboard

The debug dashboard's **Local** tab shows whether each module is loaded, current permission status, and live counts (lists / reminders / folders / notes). The **Permission warmup** button is the same as `npm run apple:permissions` — handy if you switched Macs or revoked the permission.

### Drafts flow

Apple writes (`create_reminder`, `delete_note`, etc.) go through the existing `save_draft` flow exactly like Gmail / Slack writes. The execution agent stages the action; the dispatcher confirms with the user; only `send_draft` commits. New `kind` tags:

- `apple-reminders.create / .update / .complete / .delete`
- `apple-notes.create / .append / .update / .delete`

These render in the Drafts tab with the kind + summary + raw JSON, same as cloud-toolkit drafts.

### Spawning

```ts
spawn_agent({
  task: "what's on my list today?",
  integrations: ["apple-reminders"],
});
```

Multi-toolkit spawns are supported (e.g. "save my reminders for today as a note" → `["apple-reminders", "apple-notes"]`).

### What's intentionally not included (v1)

- Apple Messages (iMessage / SMS history). Sendblue handles Boop's own iMessage in/out; reading the user's personal `chat.db` is deferred.
- Mail / Calendar / Contacts / Maps. Composio + Google Calendar already covers most use cases.
- Vector indexing of Notes content into Convex `memoryRecords` for cross-source semantic recall.
- Cloud-deployed Boop. The modules require osascript on the same machine.
```

- [ ] **Step 2: Commit**

```bash
git add INTEGRATIONS.md
git commit -m "docs: INTEGRATIONS.md section for apple-reminders + apple-notes"
```

---

## Task 16: Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry**

In `CHANGELOG.md`, add a new entry at the top of the list (matching the file's existing format):

```markdown
## [Unreleased]

### Added

- **Apple Reminders + Notes integrations** (macOS-only). Auto-registers two integration slugs (`apple-reminders`, `apple-notes`) when running on darwin. 16 tools total — full read/write surface via AppleScript / JXA. New "Local" tab in the debug dashboard surfaces module status, permissions, and live counts. New `npm run apple:permissions` script triggers macOS Automation prompts. Writes go through the existing draft flow with new `apple-*.create / .update / .delete` kinds. See `INTEGRATIONS.md` for full details.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for Apple integrations"
```

---

## Self-review notes (for the reviewer)

After all tasks complete:

- **Spec coverage:** Every section of the spec maps to a task — script bridge (Task 2), Reminders (3-4), Notes (5-6), permissions (7), registry (8), routes (9), CLI (10), UI (11-13), smoke (14), docs (15-16).
- **No prompt change:** `server/execution-agent.ts:76` already routes external writes through `save_draft`. The `tool()` descriptions reinforce this with "ALWAYS go through save_draft first", but no change to `EXECUTION_SYSTEM` is needed.
- **Permission detection:** purely observational (probe → classify stderr). The `OsaError.kind` enum in `apple-script.ts` is the source of truth.
- **The plan is darwin-only** — every task that touches runtime behavior is gated on `process.platform === "darwin"`; tests run cross-platform because they're pure-string builders + html helpers.

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-28-apple-integration.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — Run tasks in this session with checkpoints for review.

Which approach?
