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
  // <br> family → newline.
  out = out.replace(/<br\s*\/?>/gi, "\n");
  // <li>...</li> → "- text\n" (the trailing \n separates consecutive bullets;
  // the closing </li> is consumed by this regex so the block-close pass below
  // won't insert one).
  out = out.replace(/<li[^>]*>(.*?)<\/li>/gis, "- $1\n");
  // Block-level closes → newline.
  out = out.replace(/<\/(p|div|h[1-6]|ul|ol|li)>/gi, "\n");
  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, "");
  // Decode entities AFTER tag-stripping so a decoded "<x>" isn't re-stripped.
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    out = out.replaceAll(entity, char);
  }
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  // Collapse runs of >2 newlines to 2.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export function plainTextToHtml(text: string): string {
  // Escape HTML-significant chars first.
  const safe = text
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
        if (buf.length > 0) {
          bulletGroups.push(buf.join("<br>") + "<br>");
        }
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
  // NOTE: top-level `return` is invalid in JXA scripts. Use an accumulator
  // pattern: assign to `result`, `break` out of the loop, then end with a bare
  // `JSON.stringify(result)` expression.
  return `
    const Notes = Application('Notes');
    const id = ${jsonLiteral(args.id)};
    let result = null;
    for (const f of Notes.folders()) {
      const m = f.notes.whose({ id })();
      if (m.length) {
        const n = m[0];
        result = {
          id: n.id(),
          name: n.name(),
          folderName: f.name(),
          modified: n.modificationDate().toISOString(),
          body: n.body(),
        };
        break;
      }
    }
    if (!result) throw new Error("Note not found: " + id);
    JSON.stringify(result);
  `;
}

// ─────────────────────────────── Write builders ─────────────────────────────

export interface CreateNoteArgs {
  title: string;
  body: string;
  folder?: string;
}

export function buildCreateNoteScript(args: CreateNoteArgs): string {
  const html = plainTextToHtml(args.body);
  // The body is built inline from `args.title` (HTML-escaped) + `args.html`.
  // No top-level `return` — the script ends with a bare `JSON.stringify(...)`.
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
  // NOTE: top-level `return` is invalid in JXA scripts. Use an accumulator
  // pattern: assign to `result`, `break` out of the loop, then end with a bare
  // `JSON.stringify(result)` expression.
  return `
    const Notes = Application('Notes');
    const id = ${jsonLiteral(args.id)};
    const html = ${jsonLiteral(html)};
    let result = null;
    for (const f of Notes.folders()) {
      const m = f.notes.whose({ id })();
      if (m.length) {
        const n = m[0];
        n.body = String(n.body() || "") + "<br>" + html;
        result = { id: n.id(), name: n.name() };
        break;
      }
    }
    if (!result) throw new Error("Note not found: " + id);
    JSON.stringify(result);
  `;
}

export interface UpdateNoteArgs {
  id: string;
  title?: string;
  body?: string;
}

export function buildUpdateNoteScript(args: UpdateNoteArgs): string {
  const html = args.body !== undefined ? plainTextToHtml(args.body) : null;
  // NOTE: top-level `return` is invalid in JXA scripts. Use an accumulator
  // pattern: assign to `result`, `break` out of the loop, then end with a bare
  // `JSON.stringify(result)` expression.
  return `
    const Notes = Application('Notes');
    const id = ${jsonLiteral(args.id)};
    const newTitle = ${jsonLiteral(args.title ?? null)};
    const newHtml = ${jsonLiteral(html)};
    let result = null;
    for (const f of Notes.folders()) {
      const m = f.notes.whose({ id })();
      if (m.length) {
        const n = m[0];
        if (newTitle !== null) n.name = newTitle;
        if (newHtml !== null) {
          const titleH1 = "<h1>" + (newTitle || n.name()).replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[c])) + "</h1>";
          n.body = titleH1 + newHtml;
        }
        result = { id: n.id(), name: n.name() };
        break;
      }
    }
    if (!result) throw new Error("Note not found: " + id);
    JSON.stringify(result);
  `;
}

export interface DeleteNoteArgs {
  id: string;
}

export function buildDeleteNoteScript(args: DeleteNoteArgs): string {
  // NOTE: top-level `return` is invalid in JXA scripts. Use an accumulator
  // pattern: assign to `result`, `break` out of the loop, then end with a bare
  // `JSON.stringify(result)` expression.
  return `
    const Notes = Application('Notes');
    const id = ${jsonLiteral(args.id)};
    let result = null;
    for (const f of Notes.folders()) {
      const m = f.notes.whose({ id })();
      if (m.length) {
        m[0].delete();
        result = { id, deleted: true };
        break;
      }
    }
    if (!result) throw new Error("Note not found: " + id);
    JSON.stringify(result);
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
                return {
                  content: [{ type: "text" as const, text: osaErrorToText(err) }],
                  isError: true,
                };
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
                  content: [
                    { type: "text" as const, text: rows.map(formatNoteLine).join("\n") },
                  ],
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
            "search_notes",
            "Substring search across note titles and bodies (slower than list_notes — use a folder filter via list_notes when you can). Up to `limit` hits across all folders.",
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
                  content: [
                    { type: "text" as const, text: rows.map(formatNoteLine).join("\n") },
                  ],
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
            "read_note",
            "Read the full body of a note by id. HTML stripped to plain text — bullets and line breaks preserved, but attachments, images, drawings, tables, and checkboxes are not surfaced.",
            { id: z.string() },
            async (args) => {
              try {
                const n = await runOsa<NoteRow>(buildReadNoteScript(args));
                const plain = htmlToPlainText(n.body ?? "");
                const header = `# ${n.name}\n(folder: ${n.folderName} · modified ${n.modified.slice(0, 10)})\n\n`;
                return { content: [{ type: "text" as const, text: header + plain }] };
              } catch (err) {
                return {
                  content: [{ type: "text" as const, text: osaErrorToText(err) }],
                  isError: true,
                };
              }
            },
          ),

          // ─── Write tools ───

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
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Created [${n.id}] ${n.name} in ${n.folderName}`,
                    },
                  ],
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
            "append_to_note",
            "Append plain-text content to the end of an existing note. ALWAYS go through save_draft first.",
            { id: z.string(), content: z.string() },
            async (args) => {
              try {
                const n = await runOsa<{ id: string; name: string }>(
                  buildAppendToNoteScript(args),
                );
                return {
                  content: [
                    { type: "text" as const, text: `Appended to [${n.id}] ${n.name}` },
                  ],
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
            "update_note",
            "Replace a note's title and/or body. Body is plain text, converted to minimal HTML. ALWAYS go through save_draft first.",
            {
              id: z.string(),
              title: z.string().optional(),
              body: z.string().optional(),
            },
            async (args) => {
              try {
                const n = await runOsa<{ id: string; name: string }>(
                  buildUpdateNoteScript(args),
                );
                return {
                  content: [
                    { type: "text" as const, text: `Updated [${n.id}] ${n.name}` },
                  ],
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
            "delete_note",
            "Delete a note permanently. Cannot be undone. ALWAYS go through save_draft first.",
            { id: z.string() },
            async (args) => {
              try {
                await runOsa(buildDeleteNoteScript(args));
                return {
                  content: [{ type: "text" as const, text: `Deleted ${args.id}` }],
                };
              } catch (err) {
                return {
                  content: [{ type: "text" as const, text: osaErrorToText(err) }],
                  isError: true,
                };
              }
            },
          ),
        ],
      }),
  };
}
