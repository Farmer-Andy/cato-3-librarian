# Cato-3 — Database Librarian

A deployable Cloudflare Workers + Durable Objects database agent. Drop it on any SQLite schema and get a Telegram-accessible AI that can read, write, propose schema changes, and govern its own actions — all with an append-only audit trail and an admin approval gate on DDL.

This repo is the **base template**. Clone it, customize two files, deploy. That's the full workflow.

---

## What You Get Out of the Box

- **AI database librarian** — reads your schema on every invocation, answers questions accurately, refuses to fabricate
- **Tiered permissions** — reads run free, writes are audited, DDL requires admin approval via Telegram
- **Approval flow** — agent proposes schema changes, admin approves or denies via `/approve <id>` in Telegram; unapproved requests expire after 1 hour
- **Eval suite** — 6 built-in tasks; run `POST /eval/run` to get a 0–24 score at any time
- **Model switching** — `/model <slug>` swaps the active LLM without redeployment; registry lives in the database
- **HTTP + Telegram interfaces** — works from a bot or as a REST endpoint

---

## Architecture

```
Telegram / HTTP
    ↓
Edge Worker (src/index.ts)        ← stateless; actor resolution + auth
    ↓
CatoAgent Durable Object          ← SQLite + LLM loop + tools
  ├── event_log                   ← append-only audit trail
  ├── approval_pending            ← DDL approval queue
  ├── model_registry / active_model
  ├── eval_tasks / eval_runs
  └── your tables
```

Key source files:

| File | Role |
|------|------|
| `src/soul.ts` | System prompt — **customize this for your domain** |
| `src/schema.ts` | Schema init + model seed — **add your tables here** |
| `src/agent.ts` | LLM loop, tool implementations, eval runner |
| `src/tools.ts` | SQL classifier + 5 tool definitions |
| `src/approval.ts` | Approval queue (enqueue, process, TTL sweep) |
| `src/llm.ts` | OpenRouter client with fallback |
| `src/index.ts` | Edge Worker entry point |

---

## Customizing for a Specific Use Case

There are two files to edit. Everything else is generic infrastructure.

### 1. Edit `src/soul.ts` — Tell the agent what it's working with

The soul prompt is the agent's identity and domain knowledge. Open `src/soul.ts` and add a section after the Core Rules describing your data:

```typescript
export function getSoulPrompt(): string {
  return `You are Cato, a database librarian running inside a Cloudflare Durable Object.

Your purpose: help your operator introspect, query, and carefully modify a SQLite database, with strict governance over destructive operations.

## Core Rules
// ... keep the Core Rules unchanged ...

## Your Domain Section Title

Describe your tables, their purpose, and any important domain vocabulary.

Example for a support ticket system:
- \`tickets\` is the primary table. Status values are: open, in_progress, resolved, closed.
- \`ticket_id\` format is \`PROJ-{number}\`, e.g. \`PROJ-4421\`.
- Do not close a ticket without a \`resolution_notes\` entry.
- High-volume queries: always filter by \`status\` or \`assignee_id\` — unfiltered scans over large tables are slow.

## Identity

- You are Cato-3 experimental.
- You are stateless across conversations at this checkpoint. Each message is a fresh invocation.
- You are the authoritative source of truth about this database — but only because you read the manifest. The manifest is the ground truth.`;
}
```

**What to put in your domain section:**
- What each important table is for
- Canonical identifier formats (primary keys, slug formats, enum values)
- Write constraints — data the agent should never modify or should treat as read-only
- Query guidance — fields to always filter on to avoid expensive scans
- Any external systems this database mirrors

### 2. Edit `src/schema.ts` — Add your tables and seed data

#### Add your tables to `initSchema()`

Append your `CREATE TABLE IF NOT EXISTS` statements inside `initSchema()`. Every statement needs `.toArray()` — this is a Cloudflare DO SQLite requirement (lazy cursor execution):

```typescript
export function initSchema(sql: SqlStorage): void {
  // ... existing system tables ...

  // Your tables
  sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    assignee_id TEXT,
    body        TEXT
  )`).toArray();

  sql.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`).toArray();
}
```

#### Add table/column comments to `populateMetaComments()`

These comments are read by the manifest generator and included in the agent's context on every invocation. They are your primary documentation layer for the LLM:

```typescript
// inside the comments array in populateMetaComments()
['table', 'tickets', 'Support ticket records. Primary work item for this agent.'],
['column', 'tickets.id', 'ULID primary key.'],
['column', 'tickets.status', "Lifecycle state: 'open' | 'in_progress' | 'resolved' | 'closed'."],
['column', 'tickets.assignee_id', 'FK to users.id. Null means unassigned.'],
```

Good comments are the difference between an agent that guesses column semantics and one that explains them correctly.

#### Optionally swap the default models in `seedModelRegistry()`

The template seeds `google/gemini-flash-1.5` as primary and `meta-llama/llama-3.1-8b-instruct` as fallback. Replace these with any [OpenRouter](https://openrouter.ai/models) model IDs you prefer:

```typescript
const models = [
  { slug: 'sonnet', id: 'anthropic/claude-sonnet-4-5', role: 'primary', notes: 'Primary' },
  { slug: 'haiku',  id: 'anthropic/claude-haiku-4-5',  role: 'fallback', notes: 'Fallback' },
];
```

You can always add models later via SQL: `INSERT INTO model_registry ...` and switch with `/model <slug>`.

---

## Deployment

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and authenticated
- [OpenRouter API key](https://openrouter.ai/keys)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and your numeric Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot))

### Steps

**1. Clone and install**

```bash
git clone <this-repo> my-cato
cd my-cato
npm install
```

**2. Rename your worker**

Edit `wrangler.toml` and set a name for your deployment:

```toml
name = "my-cato"
```

**3. Customize** (see above — edit `soul.ts` and `schema.ts`)

**4. Deploy**

```bash
npx wrangler deploy
```

**5. Set secrets**

```bash
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TELEGRAM_ID   # your numeric Telegram user ID
```

> **Important:** `ADMIN_TELEGRAM_ID` must be a secret, not a `[vars]` entry in `wrangler.toml`. A vars entry shadows the secret and causes all messages to be dropped silently.

**6. Register the Telegram webhook**

```bash
curl -s -X POST https://my-cato.your-subdomain.workers.dev/setup/webhook | jq .
```

**7. Verify**

```bash
# Health check
curl https://my-cato.your-subdomain.workers.dev/health

# Run the built-in eval suite
curl -s -X POST https://my-cato.your-subdomain.workers.dev/eval/run | jq .
```

Target: `total_score: 24`, `veto_triggers: 0`. A lower score on `db.data.query` is a known scoring quirk (3/4 is acceptable) and not a safety issue.

---

## HTTP API Reference

All admin endpoints return a silent 404 for unauthorized actors.

| Endpoint | Method | Auth | Notes |
|----------|--------|------|-------|
| `/health` | GET | public | Returns `{ status, manifest_generated_at }` |
| `/manifest` | GET | admin | Full schema manifest as markdown |
| `/invoke` | POST | admin | `{ message: string }` → `{ reply }` |
| `/eval/run` | POST | admin | Run all eval tasks → score report |
| `/eval/runs` | GET | admin | Last 20 eval run records |
| `/approve/:id` | POST | admin | Approve a pending DDL |
| `/deny/:id` | POST | admin | Deny a pending DDL |
| `/webhook/telegram` | POST | public | Telegram webhook receiver |

Authenticate HTTP requests by passing your Telegram user ID in the `X-Cato-Actor` header:

```bash
curl -s -X POST https://my-cato.workers.dev/invoke \
  -H "Content-Type: application/json" \
  -H "X-Cato-Actor: telegram:YOUR_TELEGRAM_ID" \
  -d '{"message": "What tables exist in this database?"}' | jq .
```

---

## Telegram Commands

| Command | Effect |
|---------|--------|
| `/approve <id>` | Approve a pending DDL operation |
| `/deny <id>` | Deny a pending DDL operation |
| `/approve` (no ID) | List all pending approvals |
| `/model <slug>` | Switch the active LLM |
| `/models` | List available models from the registry |
| `/refresh` | Regenerate the schema manifest |

---

## Permission Model

| Tier | SQL Operations | Gate |
|------|---------------|------|
| **Read** | `SELECT`, `PRAGMA`, `EXPLAIN` | None — runs immediately |
| **Write** | `INSERT`, `UPDATE`, `DELETE` with `WHERE` | Runs + audit logged |
| **DDL** | `CREATE`, `ALTER`, `DROP` | Queued → requires `/approve <id>` |

The SQL classifier runs server-side. If the agent tries to call `query` with a `DROP TABLE`, it's rejected with a tier mismatch error regardless of the tool name used.

---

## Known Gotchas

- **CF DO SQLite requires `.toArray()` on every `sql.exec()` call.** Cursors are lazy — omitting it means DDL statements silently don't execute in production.
- **`sqlite_version()` is blocked** in Cloudflare DO SQLite. The manifest reports `cf-do-sqlite` as the version string.
- **`LIKE '__%'` is a wildcard trap.** The `_` in SQL LIKE matches any single character. Use `substr(name, 1, 2) != '__'` instead of `name NOT LIKE '__%'` when filtering internal table prefixes.
- **Table name prefix `_cf_` is reserved** by Cloudflare. Don't use it for your tables.
- **`ADMIN_TELEGRAM_ID` must be a secret**, not a `[vars]` entry. See step 5 of deployment.

---

## What's Out of Scope (Checkpoint 2+)

The `mutations` and `skill_versions` tables are empty stubs. They exist for schema stability. The following are intentionally deferred:

- Conversational memory (`knowledge`, `sessions`, `messages` tables)
- Self-improvement eval ratchet loop
- Digest agent / async summarization
- Federation with other agents
- Multi-tenant isolation

Don't implement these from this template. They belong to Checkpoint 2, which should only start after Checkpoint 1 has run against real use for at least a week.

---

## Project Layout

```
src/
├── index.ts        Edge Worker — auth + routing
├── agent.ts        CatoAgent DO — LLM loop, tools, eval runner
├── schema.ts       Schema init, manifest generator, model seed
├── soul.ts         System prompt (customize this)
├── tools.ts        SQL classifier + tool definitions
├── approval.ts     DDL approval queue
├── llm.ts          OpenRouter client with fallback
├── telegram.ts     Telegram message helpers
├── types.ts        TypeScript interfaces
└── ulid.ts         ULID generator (no dependencies)
```
