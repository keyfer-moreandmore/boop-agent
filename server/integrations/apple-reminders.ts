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
    let result = null;
    for (const l of Reminders.lists()) {
      const matches = l.reminders.whose({ id })();
      if (matches.length) {
        const r = matches[0];
        const d = r.dueDate();
        result = {
          id: r.id(),
          name: r.name(),
          listName: l.name(),
          due: d ? d.toISOString() : null,
          priority: r.priority(),
          notes: r.body() || null,
          completed: r.completed(),
        };
        break;
      }
    }
    if (!result) throw new Error("Reminder not found: " + id);
    JSON.stringify(result);
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

export function formatDue(iso: string | null): string {
  if (!iso) return "no due date";
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const date = `${yyyy}-${mm}-${dd}`;
  const time = `${hh}:${min}`;
  return time === "00:00" ? `due ${date}` : `due ${date} ${time}`;
}

export function formatReminderLine(r: ReminderRow): string {
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
