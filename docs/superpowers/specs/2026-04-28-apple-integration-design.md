# Apple Reminders + Notes Integration

**Date:** 2026-04-28
**Status:** Approved (ready for implementation plan)
**Scope:** v1 — read/write access to local macOS Reminders and Notes from the Boop agent.

## Problem

Boop's executor agent has rich access to cloud SaaS through Composio (Gmail, Slack, GitHub, Notion, etc.) but no access to the user's local Apple apps. The most-used personal-task surfaces — Reminders and Notes — live entirely on macOS with no cloud API. Without access, the agent can't answer "what's on my list today?", add a reminder from an iMessage, or surface a note the user wrote last month.

## Goals

- Full read/write access to **Apple Reminders** from the executor agent.
- Full read/write access to **Apple Notes** from the executor agent.
- Plug into Boop's existing integration registry, draft flow, memory extraction, and automations without architectural changes.
- Provide a debug-UI surface so the user can verify the integration is loaded and permissions are granted.

## Non-goals (v1)

- Apple Messages (iMessage / SMS). Sendblue already handles Boop's own iMessage in/out; reading the user's personal `chat.db` is deferred.
- Calendar, Mail, Contacts, Maps. Composio + Google Calendar already covers the equivalent surface for most users.
- Vector indexing of Notes content into Convex `memoryRecords` for semantic recall. Useful but a bigger feature; defer to v2.
- Cloud-deployed Boop access to local Apple apps. Boop currently runs on the user's Mac (`npm run dev`) or a home Mac mini; cloud deployment is out of scope and would require a separate local bridge process.

## Architecture

### File layout

Two new TypeScript modules + one shared helper, slotted into the existing `server/integrations/` directory:

```
server/integrations/
├── registry.ts              (existing) +1 platform-gated registration block
├── composio-loader.ts       (existing, untouched)
├── apple-script.ts          NEW: shared osascript runner + JSON helpers
├── apple-reminders.ts       NEW: IntegrationModule for Reminders
└── apple-notes.ts           NEW: IntegrationModule for Notes
```

Plus:

```
server/apple-routes.ts       NEW: /apple/* HTTP routes for the debug UI
debug/src/pages/Local.tsx    NEW: "Local" tab in the debug dashboard
scripts/apple-permissions.mjs NEW: CLI permission warmup
```

### Integration registry hook

`server/integrations/registry.ts` gains one block before the Composio loader call:

```ts
if (process.platform === "darwin") {
  registerIntegration(buildAppleRemindersIntegrationModule());
  registerIntegration(buildAppleNotesIntegrationModule());
}
```

The `darwin` guard means the modules silently skip on Linux/Windows (e.g., a hypothetical cloud deployment); on macOS they always load. No env var, no Connections-tab card, no OAuth.

### Slugs

- `apple-reminders`
- `apple-notes`

The dispatcher names them like any other integration:

```ts
spawn_agent({ task: "what's on my list today?", integrations: ["apple-reminders"] })
```

### Two-toolkit split rationale

Each module is a separate IntegrationModule, not one combined "apple" toolkit. Boop's executor design loads only the integrations named in a spawn — minimum tool surface per task. A reminders task shouldn't pay the context cost of Notes tool descriptions, and vice versa. Combined integrations are rare enough (e.g., "save my reminders for today as a note") that the dispatcher just passes both slugs when needed.

### Module shape

Each module exports a builder matching the existing `IntegrationModule` interface (`server/integrations/registry.ts`):

```ts
export function buildAppleRemindersIntegrationModule(): IntegrationModule {
  return {
    name: "apple-reminders",
    description: "Apple Reminders (local macOS)",
    requiredEnv: [],
    createServer: async () => createSdkMcpServer({
      name: "apple-reminders",
      version: "0.1.0",
      tools: [/* tool() calls — see Tool Surface */],
    }),
  };
}
```

This matches `buildComposioIntegrationModule` in `server/composio.ts` exactly.

## Tool surface

### `apple-reminders` — 8 tools

**Reads (idempotent, bypass draft flow):**

| Tool | Input | Returns |
|---|---|---|
| `list_lists` | `()` | `Personal: 18 (4 today, 1 overdue)\nWork: 9 (...)\n...` |
| `list_reminders` | `{ list?: string, status?: "incomplete"\|"completed"\|"all", dueBefore?: ISO8601, dueAfter?: ISO8601 }` | bullets: `[id] Title · list · due 2026-04-29 17:00 · priority high` |
| `search_reminders` | `{ query: string, limit?: number }` | bullets like `list_reminders` |
| `get_reminder` | `{ id: string }` | full plain-text dump (notes, due, priority, list, completion) |

**Writes (system prompt routes through `save_draft` first):**

| Tool | Input | Returns |
|---|---|---|
| `create_reminder` | `{ title, list?, due?, notes?, priority?: "none"\|"low"\|"medium"\|"high" }` | new reminder id |
| `update_reminder` | `{ id, title?, list?, due?, notes?, priority? }` | confirmation + new state |
| `complete_reminder` | `{ id }` | confirmation |
| `delete_reminder` | `{ id }` | confirmation |

### `apple-notes` — 8 tools

**Reads:**

| Tool | Input | Returns |
|---|---|---|
| `list_folders` | `()` | `Notes: 42\nWork: 18\nIdeas: 9\n...` |
| `list_notes` | `{ folder?: string, limit?: number }` | bullets: `[id] Title · Folder · 2026-04-22 · preview…` |
| `search_notes` | `{ query, limit? }` | bullets like `list_notes` |
| `read_note` | `{ id }` | `# Title\n(folder · modified)\n\nbody…` (HTML stripped) |

**Writes:**

| Tool | Input | Returns |
|---|---|---|
| `create_note` | `{ title, body, folder? }` | new note id |
| `append_to_note` | `{ id, content }` | confirmation |
| `update_note` | `{ id, title?, body? }` | confirmation |
| `delete_note` | `{ id }` | confirmation |

### Cross-cutting decisions

- **Scope:** wide-open. Agent sees all lists/folders. No allowlist/denylist in v1 (deferred until needed).
- **IDs are opaque strings.** Apple's `x-apple-reminderkit://...` and `x-coredata://...` URIs pass through as-is. Long, unique, stable.
- **Returns are plain text, bulleted.** Matches every other Boop tool. JSON only travels internally inside `save_draft.payload`.
- **Dates are ISO 8601 in, `YYYY-MM-DD HH:MM` out.** AppleScript wants local time; converted before passing.
- **`folder`/`list` matched case-insensitive by name.** If ambiguous across iCloud + "On My Mac" accounts, error response lists the matches and the agent picks.
- **Default account = iCloud** when multiple exist. Override via `APPLE_NOTES_ACCOUNT` / `APPLE_REMINDERS_ACCOUNT` env vars.
- **Notes HTML.** AppleScript returns HTML for `body`; we strip to plain text on read (preserve `<br>` as `\n`, `<li>` as `- `), convert plain text to minimal HTML on write. Lossy for images/drawings/attachments — agent does not round-trip those.
- **Verb separation kept.** `complete_reminder` not folded into `update_reminder({status:"completed"})`; `append_to_note` not folded into `update_note({mode:"append"})`. Extra tool description tokens (~50 each) are cheaper than the LLM picking the wrong verb.

## System integration

### Memory extraction (no new wiring)

The executor's reply text feeds back through the dispatcher into `extract.ts`, which is fire-and-forget. So a turn like:

> User: "what's on my list today?"
> Agent: "Pick up dry cleaning at 5pm, call dentist about Friday's appointment, finish Q2 deck."

Yields automatic memory writes via the existing extraction prompt — e.g., "User has dentist appointment Friday" (segment: `context`), "User is preparing a Q2 deck" (segment: `project`). Same mechanism that captures facts from Gmail/Slack replies captures facts from Reminders/Notes replies.

### Memory-informed actions (no new wiring)

The dispatcher already calls `recall(query)` before deciding what to do. So "add a reminder about the meeting" gets context-enrichment from existing memory — `recall` finds "User has weekly standup with Sarah, Wednesdays 9am", dispatcher passes that into the spawn, executor creates a precise reminder.

### Drafts flow for writes (mirrors Gmail/Slack)

Apple write tools exist on the toolkit but the executor's system prompt routes external writes through `save_draft(kind, summary, payload)` first.

```
1. Dispatcher → spawn(task, integrations: ["apple-reminders"])
2. Executor → save_draft({
     kind: "apple-reminders.create",
     summary: "Add 'Pick up dry cleaning' to Personal, due 5pm tomorrow",
     payload: <JSON of args>
   })
3. Dispatcher → "Draft ready: …" → user replies "send"
4. Dispatcher → send_draft(draftId, integrations: ["apple-reminders"])
5. send_draft → spawns fresh executor whose task is "execute payload" → calls actual create_reminder
```

Draft `kind` tags introduced:

- `apple-reminders.create` / `.update` / `.complete` / `.delete`
- `apple-notes.create` / `.append` / `.update` / `.delete`

The Drafts tab in the dashboard already renders kind + summary + raw JSON. No schema change.

### Automations (free)

`create_automation(name, schedule, task, integrations)` accepts arbitrary integration slugs. So:

> "Every morning at 8, summarize my reminders due today and text it to me."

works out of the box: cron fires → executor spawned with `integrations: ["apple-reminders"]` → result pushed back via Sendblue.

### Agents-tab visibility (free + tiny addition)

`agentLogs` already records every tool call (name, args, result, duration). The Agents tab renders timeline + per-integration logos. Logos lookup is currently Composio-keyed; we add two SVGs to the dashboard's logo map for `apple-reminders` and `apple-notes` (Apple-style monochrome, distinct from Composio cloud logos). ~10 lines in the debug UI.

## Debug UI: new "Local" tab

A new top-level tab in the debug dashboard, alongside Connections / Agents / Automations / Memory / Events. Houses Apple modules now and any future local-machine integrations later.

### Layout

Two cards (one per Apple module) plus a setup card:

```
┌─────────────────────────────────────────────────────────────┐
│  Local integrations                                          │
│  Run on the Mac hosting Boop. macOS-only.                    │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────┐  ┌──────────────────────────┐ │
│  │ Apple Reminders          │  │ Apple Notes              │ │
│  │ Loaded · Permission ✓    │  │ Loaded · Permission ⚠    │ │
│  │ 6 lists · 47 reminders   │  │ 9 folders · 213 notes    │ │
│  │ 4 due today              │  │                          │ │
│  │ Last call: 12s ago ✓     │  │ Last call: never         │ │
│  │ [ Test access ]          │  │ [ Grant permission ]     │ │
│  └──────────────────────────┘  └──────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Setup                                                   ││
│  │ [ Permission warmup ] triggers macOS Automation prompts ││
│  │ for both apps in one go.                                ││
│  │ Currently granted: Reminders ✓  Notes ⚠                ││
│  │ Fix denied permissions in System Settings → Privacy &   ││
│  │ Security → Automation → Node                            ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### State per card

| Field | Source | Notes |
|---|---|---|
| Loaded | runtime registry | true if `darwin` and registered without throwing |
| Permission | last test call result | `granted` / `denied` / `unknown` |
| Stat counts | lazy fetch on tab open | cached for 60s; no auto-refresh |
| Last call | `agentLogs`, filtered by `mcp__apple-reminders__*` | already exists |

### HTTP routes (`server/apple-routes.ts`, mounted at `/apple`)

- `GET /apple/status` → `{ reminders: { loaded, permission, lastCallAt }, notes: { ... } }`. Cheap, no AppleScript call (reads cache).
- `POST /apple/test/:slug` → runs `list_lists` / `list_folders`. Updates cached permission state. Returns `{ ok, durationMs, sample }`.
- `POST /apple/warmup` → runs both tests in sequence.
- `GET /apple/stats/:slug` → counts. Lazy, only when tab is open. 60s cache.

No write routes from the dashboard — the dashboard stays read-only by Boop's existing pattern. Anything that creates a reminder/note still goes through the agent and the drafts flow.

### Permission detection

macOS does not expose a clean programmatic "is X allowed" API for AppleScript automation. We **observe the result**: a denied permission returns `osascript` exit code 1 with stderr containing `Not authorized to send Apple events` (or similar). Match those, set status to `denied`. Success → `granted`. Anything else → `unknown`.

State lives in:
- An in-memory map for fast reads.
- Convex `settings` table (`apple.reminders.permission`, `apple.notes.permission`) so it survives server restart.

## AppleScript bridge

### `server/integrations/apple-script.ts`

One small helper:

```ts
async function runOsa<T = string>(
  script: string,
  opts?: { lang?: "JavaScript" | "AppleScript", timeout?: number, parse?: "json" | "text" }
): Promise<T>
```

- Uses `child_process.execFile("osascript", ["-l", lang, "-e", script])` — no shell, no injection.
- **Default lang: JXA (JavaScript for Automation).** Has `JSON.stringify`, native object access, and is much easier to template. AppleScript only used for the rare cases JXA bugs (Notes' `body` writeback historically had issues; AppleScript is more reliable there).
- **Inputs interpolated via `JSON.stringify` into the script string.** Never shell concat.

  ```ts
  const script = `JSON.stringify(
    Application('Reminders').lists.byName(${JSON.stringify(name)})
      .reminders().map(r => ({ id: r.id(), name: r.name(), ... }))
  )`;
  ```

- 10s default timeout. `search_notes` bumps to 30s (slow on big libraries).
- `parse: "json"` (default for JXA) parses stdout as JSON before returning.

### Per-tool script builders

Each tool has a small builder function in its module file (e.g. `buildListRemindersScript(args)`) that returns the JXA string. Builders are pure — easy to unit test.

## Permissions warmup

### Mechanism

First `osascript` call to each app triggers macOS Automation prompt against the parent process (`node`/`tsx`). User clicks "OK" once per app.

The warmup function runs `list_lists` (Reminders) and `list_folders` (Notes) in sequence — surfaces both prompts immediately so the user is not surprised mid-conversation.

### Two entry points

- `npm run apple:permissions` → `scripts/apple-permissions.mjs` → calls warmup function. CLI use, ideal for first-time setup.
- `POST /apple/warmup` → same warmup function, exposed for the dashboard's button.

### Caching

Permission status cached in memory + Convex `settings`. Tools do not re-test on every call — they read the cache and only re-run a probe if the cache is `unknown` or stale (>1h).

### Denied-permission UX

If a tool call fails with a permission error, the response message includes the exact recovery instruction:

> Not authorized. Open System Settings → Privacy & Security → Automation → Node → enable Reminders/Notes, then retry.

## Error handling

`runOsa` normalizes osascript exit codes into typed errors:

| stderr signal | Mapped error | Tool returns |
|---|---|---|
| `Not authorized to send Apple events` | `PermissionError` | recovery instruction (see above) |
| `doesn't understand` / `Can't get` | `NotFoundError` | `"List/folder 'X' not found. Available: …"` (script lists alternatives) |
| `Application isn't running` | `AppNotRunningError` | tool calls `app.activate()` and retries once |
| timeout | `TimeoutError` | `"Timed out after Ns. Try narrowing the filter."` |
| anything else | `UnknownError` | full stderr surfaced |

All tool errors return `{ content: [...], isError: true }` so the SDK flags them properly to the model. Full stderr also lands in `agentLogs` for debugging in the Agents tab.

## Testing

- **Unit tests on script builders.** `buildListRemindersScript({list:"Personal"})` produces a known string. Pure, runs anywhere, no macOS dependency.
- **Integration tests gated by `APPLE_INTEGRATION_TESTS=true`.** Actually shell out to osascript. Run locally on macOS, skipped in CI.
- **Mock mode via `APPLE_MOCK=true`.** `runOsa` returns canned fixtures from `tests/fixtures/apple/*.json` instead of executing. Lets higher-level tool tests run cross-platform.
- **Smoke output in `npm run apple:permissions`.** After the warmup, prints a 1-line summary (`Reminders: ✓ 6 lists, 47 reminders / Notes: ✓ 9 folders, 213 notes`) so the user knows it actually worked.

## Documentation

- New section in `INTEGRATIONS.md` covering Apple modules: how they load, how to grant permissions, how the dashboard's Local tab works, how the draft flow gates writes.
- Add `INTEGRATIONS.md` permissions screenshot of System Settings → Privacy & Security → Automation (placeholder for v1; user can add the real screenshot).
- `CHANGELOG.md` entry for the release.

## Out of scope (revisit in v2)

- **Apple Messages.** Reading `~/Library/Messages/chat.db` for personal iMessage/SMS history. Requires Full Disk Access; bigger privacy ask.
- **Vector indexing of Notes content** into Convex `memoryRecords` for cross-source semantic recall. Bigger feature: sync loop, deletion handling, embeddings.
- **Reverse direction:** writing Boop memories back into a Notes folder as a backup mechanism.
- **Scope restrictions:** allowlist/denylist for which lists/folders the agent can see. Defer until needed.
- **Cloud-deployed Boop** with a local bridge process. Boop is local-only for now.
- **Calendar / Mail / Contacts / Maps** local integrations. Composio + Google Calendar already covers the equivalent for most users.

## Implementation order (high level)

1. `apple-script.ts` helper + tests.
2. `apple-reminders.ts` module: read tools first, then write tools.
3. `apple-notes.ts` module: read tools first, then write tools.
4. Registry hookup (`server/integrations/registry.ts`).
5. `server/apple-routes.ts` HTTP routes + permission caching.
6. CLI: `scripts/apple-permissions.mjs` + `package.json` script.
7. Debug UI: new "Local" tab + logo additions.
8. System prompt updates: drill draft flow for `apple-*.create/.update/.delete` kinds.
9. Documentation: `INTEGRATIONS.md` section, `CHANGELOG.md` entry.

A separate implementation plan will break each of these into the concrete steps with files, line targets, and verification commands.
