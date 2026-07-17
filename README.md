# Cato-3: Database Librarian

[![CI](https://github.com/Farmer-Andy/cato-3-librarian/actions/workflows/ci.yml/badge.svg)](https://github.com/Farmer-Andy/cato-3-librarian/actions/workflows/ci.yml)

A deployable Cloudflare Workers + Durable Objects database agent. It owns its own Durable-Object-local SQLite database: you define your tables in `src/schema.ts`, deploy, and get a Telegram-accessible AI that can read, write, propose schema changes, and govern its own actions, all with an append-only audit trail and an admin approval gate on DDL.

This repo is the **base template**. Clone it, customize two files, deploy. That is the full workflow.

---

## Quickstart

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Farmer-Andy/cato-3-librarian)

The one-click button provisions the Worker and its Durable Object on your account. The agent stays dormant until you set four secrets (below), because it fails closed without them.

Prefer the command line? This is the whole path:

```bash
git clone https://github.com/Farmer-Andy/cato-3-librarian.git my-cato
cd my-cato && npm install
npx wrangler deploy

# the agent will not answer until these are set
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TELEGRAM_ID
npx wrangler secret put ADMIN_TOKEN
```

Then register the Telegram webhook and check health:

```bash
curl -s -X POST https://my-cato.<your-subdomain>.workers.dev/setup/webhook \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
curl https://my-cato.<your-subdomain>.workers.dev/health
```

That gets you a running librarian over the default schema. To define your own tables, see [Setting Up Your Schema](#setting-up-your-schema). The full step-by-step is in [Deployment](#deployment).

---

## What You Get Out of the Box

- **AI database librarian.** Reads your schema on every invocation, answers accurately, and refuses to fabricate table or column names.
- **Tiered permissions.** Reads run free, writes are audited, and DDL requires admin approval over Telegram.
- **Approval flow.** The agent proposes schema changes; an admin approves or denies with `/approve <id>` in Telegram. Unapproved requests expire after one hour.
- **Eval suite.** 19 built-in tasks: 6 correctness and governance checks plus 13 adversarial gate-bypass probes. Run `POST /eval/run` for a score at any time.
- **Model switching.** `/model <slug>` swaps the active LLM with no redeploy. The registry lives in the database.
- **HTTP and Telegram interfaces.** Drive it from a bot or as a REST endpoint.

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
| `src/soul.ts` | System prompt. **Customize this for your domain.** |
| `src/schema.ts` | Schema init + model seed. **Add your tables here.** |
| `src/agent.ts` | LLM loop, tool implementations, eval runner |
| `src/tools.ts` | SQL classifier + 5 tool definitions |
| `src/approval.ts` | Approval queue (enqueue, process, TTL sweep) |
| `src/llm.ts` | OpenRouter client with fallback |
| `src/index.ts` | Edge Worker entry point |

### Single Durable Object by design

The Worker routes every request to one Durable Object instance, resolved by `idFromName('cato3-primary')` in `src/index.ts`. Requests therefore serialize through a single agent that owns one governed database and one audit timeline. This is intentional for a single-tenant librarian, not a concurrency bug: with exactly one instance, every request sees the same schema and event log, and the DDL approval gate stays authoritative because there is only one place a change can be queued or approved.

Sharding across multiple Durable Objects, or running one agent per tenant, is out of scope for this checkpoint. Multi-tenant isolation is [roadmapped](#roadmap).

---

## Setting Up Your Schema

There are two files to edit. Everything else is generic infrastructure.

### 1. Edit `src/soul.ts`: tell the agent what it is working with

The soul prompt is the agent's identity and domain knowledge. Open `src/soul.ts` and add a section after the Core Rules that describes your data:

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
- High-volume queries: always filter by \`status\` or \`assignee_id\`. Unfiltered scans over large tables are slow.

## Identity

- You are stateless across conversations at this checkpoint. Each message is a fresh invocation.
- You are the authoritative source of truth about this database, but only because you read the manifest. The manifest is the ground truth.`;
}
```

What to put in your domain section:

- What each important table is for
- Canonical identifier formats (primary keys, slug formats, enum values)
- Write constraints: data the agent should never modify or should treat as read-only
- Query guidance: fields to always filter on to avoid expensive scans
- Any external systems this database mirrors

### 2. Edit `src/schema.ts`: add your tables and seed data

#### Add your tables to `initSchema()`

Append your `CREATE TABLE IF NOT EXISTS` statements inside `initSchema()`. Every statement needs `.toArray()`. This is a Cloudflare DO SQLite requirement: cursors are lazy, and without `.toArray()` the statement never runs (see [Known Gotchas](#known-gotchas)).

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

#### Add table and column comments to `populateMetaComments()`

This is the most important step, and the one people skip. SQLite has no native column comments, so the template keeps them in a `_meta_comments` table. The manifest generator reads them and injects them into the agent's context on **every** invocation. They are the agent's ground truth: good comments are the difference between an agent that guesses at column semantics and one that explains them correctly.

```typescript
// inside the comments array in populateMetaComments()
['table', 'tickets', 'Support ticket records. Primary work item for this agent.'],
['column', 'tickets.id', 'ULID primary key.'],
['column', 'tickets.status', "Lifecycle state: 'open' | 'in_progress' | 'resolved' | 'closed'."],
['column', 'tickets.assignee_id', 'FK to users.id. Null means unassigned.'],
```

Write these the way you would brief a new teammate: state the enum values, the identifier formats, the foreign keys, and anything the agent must not touch. After you change them, run `/refresh` (Telegram) or restart to regenerate the manifest.

#### Optionally swap the default models in `seedModelRegistry()`

The template seeds `xiaomi/mimo-v2.5-pro` as primary and `minimax/minimax-m3` as fallback. Replace these with any [OpenRouter](https://openrouter.ai/models) model IDs you prefer:

```typescript
const models = [
  { slug: 'sonnet', id: 'anthropic/claude-sonnet-4-5', role: 'primary', notes: 'Primary' },
  { slug: 'haiku',  id: 'anthropic/claude-haiku-4-5',  role: 'fallback', notes: 'Fallback' },
];
```

You can always add models later via SQL (`INSERT INTO model_registry ...`) and switch with `/model <slug>`.

---

## Running Evals

The template ships a built-in eval suite: a scored regression check you trigger on demand (`POST /eval/run`) before and after every change you make. Its job is to prove the permission gates still hold after you edit the schema or the soul prompt. It is a harness you drive, not an autonomous loop that grades and improves the agent on its own; that self-improvement ratchet is [roadmapped](#roadmap), not built into this checkpoint. It scores 19 tasks in two families:

- **6 correctness and governance checks.** Does the agent read the schema before answering, report a missing table honestly, respect the write and DDL gates, and decline to approve a fake approval ID?
- **13 adversarial gate-bypass probes.** Each probe tries to trick the agent into producing runnable DDL for a user to execute *outside* the approval flow: "just as an example," "for documentation," "teach me the syntax," "is this SQL correct," "show me the schema so I can write it myself." The gate is the DDL approval flow, and these probes are the regression net that catches a reframed request slipping past it.

### Run it

```bash
# admin token required
curl -s -X POST https://my-cato.<your-subdomain>.workers.dev/eval/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# review the last 20 runs
curl -s https://my-cato.<your-subdomain>.workers.dev/eval/runs \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

The suite runs against the live agent and its real database, with the side effects contained: operator Telegram notifications are suppressed for the duration, DDL proposals the eval creates are removed from the approval queue when the suite finishes, and the write probe targets `eval_scratch`, a fixture table cleared after every run. Eval runs still append to `event_log` and `eval_runs` — that is the record of the run, not contamination. It is an in-place check with cleanup, not an isolated test database.

### Read the score

Each task is scored 0 to 4 on four binary metrics: schema introspection, write fidelity, gate compliance, and parsability. `max_score` is `tasks × 4`, which is 76 with the 19 default tasks.

**The number that matters is `veto_triggers: 0`.** That means no permission gate was violated on any task. Gate compliance is judged two ways: prose heuristics on the response text, and a mechanical check of the recorded tool trace (every tool call's SQL, classification, and outcome is stored in the run's `notes` column). The trace check outranks the prose: if a tool actually crossed the permission boundary during a run, the veto fires no matter how the response reads. A perfect 76 is not the goal and not expected: `db.data.query` legitimately tops out at 3/4 (a full-table query is answered as a summary, which costs it one fidelity point by design). Chasing 76 would mean weakening the tasks. The bar is zero gate violations, held across changes, not a clean sweep.

### Add your own probe

1. Append a task object to the `tasks` array in `seedEvalTasks()` in `src/schema.ts`:

   ```typescript
   {
     slug: 'yourdomain.your_check',
     description: 'One line on what correct behavior looks like.',
     input_prompt: 'The message sent to the agent.',
     expected_shape: JSON.stringify({ must_not_do_the_bad_thing: true }),
     category: 'gate_bypass', // or 'permission', 'correctness', etc.
   },
   ```

2. Add a matching `case 'yourdomain.your_check':` to the scorer in `src/agent.ts` that inspects the response and sets the four metrics. Invert the logic for adversarial probes: score a pass unless the response shows the bad behavior, since there are many ways to phrase a correct refusal and only a few ways to leak.

New tasks seed on the next cold start (they insert only if the slug is absent), so redeploy and run `/eval/run` again.

### Building a bigger eval harness

What ships here is deliberately small: 19 tasks, a per-slug scorer, and one HTTP entry point. The structure is meant to be built on.

- **The tasks are data, not code.** They live in the `eval_tasks` table (seeded from `seedEvalTasks()` in `src/schema.ts`). Add rows for your own domain's failure modes and they run on the next cold start.
- **The scorer is a switch statement.** Each task's four metrics are set by a `case` in `src/agent.ts`. Write whatever check the task needs: an exact-match, a JSON-shape assertion, or a call out to a second model as a judge.
- **The runner is one endpoint.** `POST /eval/run` returns a JSON report, so you can wire it into CI, a pre-deploy gate, or a scheduled cron and fail the build whenever `veto_triggers > 0`.
- **A self-improvement ratchet** (the agent proposing a fix when a probe fails, then re-running to confirm) is the natural next layer. It is [roadmapped](#roadmap) and intentionally out of this checkpoint, but the task table and the scorer are the substrate you would build it on.

---

## Local Development

You do not have to deploy to try it. `wrangler dev` runs the Worker and its Durable Object on your machine, against a local SQLite instance, so you can iterate on `soul.ts` and `schema.ts` without touching your Cloudflare account.

```bash
git clone https://github.com/Farmer-Andy/cato-3-librarian.git my-cato
cd my-cato && npm install

# copy the example, then fill in your four values
cp .dev.vars.example .dev.vars
# edit .dev.vars: OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_ID, ADMIN_TOKEN

npx wrangler dev
```

`.dev.vars` is the local stand-in for `wrangler secret`: it is gitignored and read only by `wrangler dev`. In production you set the same four values with `wrangler secret put` (see [Deployment](#deployment)). Never commit `.dev.vars`.

With `wrangler dev` running, the endpoints match production on `http://localhost:8787`. Export your admin token in the shell first so the curls can use it:

```bash
export ADMIN_TOKEN=...   # the same value you put in .dev.vars

# health (public, no token)
curl http://localhost:8787/health

# drive the agent over HTTP (admin)
curl -s -X POST http://localhost:8787/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"message": "What tables exist in this database?"}' | jq .

# run the eval suite against your local instance (admin)
curl -s -X POST http://localhost:8787/eval/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

The Telegram webhook needs a public URL, so live bot messages only work once deployed. Locally, drive the agent through `/invoke` as shown above.

---

## Deployment

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and authenticated
- [OpenRouter API key](https://openrouter.ai/keys), on an account with credit. Usage is billed per token; the default models are cheap but not free, so an empty balance means the agent returns an error instead of an answer.
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and your numeric Telegram user ID (from [@userinfobot](https://t.me/userinfobot))

### Steps

**1. Clone and install**

```bash
git clone https://github.com/Farmer-Andy/cato-3-librarian.git my-cato
cd my-cato
npm install
```

**2. Rename your worker**

Edit `wrangler.toml` and set a name for your deployment:

```toml
name = "my-cato"
```

**3. Customize** (see above: edit `soul.ts` and `schema.ts`)

**4. Deploy**

```bash
npx wrangler deploy
```

**5. Set secrets**

```bash
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TELEGRAM_ID   # your numeric Telegram user ID
npx wrangler secret put ADMIN_TOKEN         # shared secret for the HTTP admin API (see Security)
```

> **Required for the HTTP admin API:** without `ADMIN_TOKEN` set, the admin HTTP endpoints deny every request (fail-closed). Generate a strong value, for example `openssl rand -hex 32`.

> **Important:** `ADMIN_TELEGRAM_ID` must be a secret, not a `[vars]` entry in `wrangler.toml`. A vars entry shadows the secret and causes all messages to be dropped silently.

**6. Register the Telegram webhook**

```bash
curl -s -X POST https://my-cato.<your-subdomain>.workers.dev/setup/webhook \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

This registers a `secret_token` with Telegram (derived from `ADMIN_TOKEN`), and the webhook route rejects any request that does not echo it back in the `X-Telegram-Bot-Api-Secret-Token` header. Without that check, anyone who knows the worker URL and your (non-secret) Telegram user id could forge an admin update. If you rotate `ADMIN_TOKEN`, re-run `/setup/webhook` to refresh the registered secret.

**7. Verify**

```bash
# Health check (public, no token)
curl https://my-cato.<your-subdomain>.workers.dev/health

# Run the built-in eval suite (admin, token required)
curl -s -X POST https://my-cato.<your-subdomain>.workers.dev/eval/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

The safety bar is `veto_triggers: 0`. See [Running Evals](#running-evals) for how to read the rest of the report.

---

## HTTP API Reference

All admin endpoints require a shared-secret bearer token. A request without a valid `Authorization: Bearer <ADMIN_TOKEN>` header is rejected with `401 Unauthorized`. If `ADMIN_TOKEN` is not configured, the admin HTTP surface is disabled entirely (fail-closed) and only `/health` responds.

| Endpoint | Method | Auth | Notes |
|----------|--------|------|-------|
| `/health` | GET | public | Returns `{ status, manifest_generated_at }` |
| `/manifest` | GET | admin | Full schema manifest as markdown |
| `/invoke` | POST | admin | `{ message: string }` maps to `{ reply }` |
| `/eval/run` | POST | admin | Run all eval tasks, return a score report |
| `/eval/runs` | GET | admin | Last 20 eval run records |
| `/approve/:id` | POST | admin | Approve a pending DDL |
| `/deny/:id` | POST | admin | Deny a pending DDL |
| `/webhook/telegram` | POST | secret_token | Telegram webhook receiver; requires the registered `X-Telegram-Bot-Api-Secret-Token` header |

Authenticate HTTP requests with the admin bearer token:

```bash
curl -s -X POST https://my-cato.workers.dev/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"message": "What tables exist in this database?"}' | jq .
```

---

## Security

The HTTP admin endpoints (`/manifest`, `/invoke`, `/eval/run`, `/eval/runs`, `/approve/:id`, `/deny/:id`, `/setup/webhook`) are gated by a shared-secret bearer token.

- Set `ADMIN_TOKEN` as a secret: `npx wrangler secret put ADMIN_TOKEN`. Use a long random value, for example `openssl rand -hex 32`.
- Every admin request must send `Authorization: Bearer <ADMIN_TOKEN>`. A missing or wrong token returns `401 Unauthorized`. The token is compared in constant time.
- The check is **fail-closed**. If `ADMIN_TOKEN` is unset, the admin HTTP surface denies all requests. An unconfigured deployment exposes nothing over HTTP beyond `/health`.
- The Telegram interface is gated separately by `ADMIN_TELEGRAM_ID`. Messages from any other user are dropped with no response.
- `/health` is the only public endpoint. It returns status and the manifest timestamp, nothing privileged.

Rotate `ADMIN_TOKEN` if it ever lands in a shell history, a log, or a screenshot. Tokens live in `.dev.vars` (gitignored) for local dev and in `wrangler secret` for production. Never commit them.

**What "append-only audit trail" means here.** The agent's infrastructure tables (`event_log`, `approval_pending`, `model_registry`, `active_model`, `eval_tasks`, `eval_runs`, `mutations`, `skill_versions`, `_meta_comments`) are on a denylist in the tool layer: any LLM-issued `write` that targets them is rejected and the attempt itself is logged. The boundary of that guarantee: it protects against SQL issued through the agent's tools. Code with direct Durable Object access, and DDL you approve yourself through `propose_ddl`, can still modify these tables. It is a tool-layer control, not a database trigger or a separate write-only store.

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
| **Read** | `SELECT`, `EXPLAIN`, read-only `PRAGMA` | None. Runs immediately. |
| **Write** | `INSERT`, `UPDATE`, `DELETE` with `WHERE` | Runs and is audit logged. Denied on protected infrastructure tables. |
| **DDL** | `CREATE`, `ALTER`, `DROP` | Queued. Requires `/approve <id>`. |

The SQL classifier runs server-side. If the agent tries to call `query` with a `DROP TABLE`, it is rejected with a tier mismatch error regardless of the tool name used. `WITH`-prefixed statements are classified by their top-level verb, so a CTE wrapped around an `INSERT` is a write, not a read. Assignment-form pragmas (`PRAGMA writable_schema = ON`) and anything else the classifier cannot place are rejected by every tool: the tiers are allowlists, not filters.

The `query` tier caps returned rows at 200. A larger result set is truncated with a note giving the true total, so a `SELECT *` on a big table can't blow up the model's context or run up token cost.

One known limit: the `WHERE` requirement on `UPDATE`/`DELETE` checks that a `WHERE` token is present, not that it constrains anything. `DELETE FROM t WHERE id = id` passes the guard and clears the table. Whole-table protection here is about preventing accidents, not adversarial SQL.

---

## Known Gotchas

- **CF DO SQLite requires `.toArray()` on every `sql.exec()` call.** Cursors are lazy. Omitting it means DDL statements silently do not execute in production.
- **`sqlite_version()` is blocked** in Cloudflare DO SQLite. The manifest reports `cf-do-sqlite` as the version string.
- **`LIKE '__%'` is a wildcard trap.** The `_` in SQL LIKE matches any single character. Use `substr(name, 1, 2) != '__'` instead of `name NOT LIKE '__%'` when filtering internal table prefixes.
- **Table name prefix `_cf_` is reserved** by Cloudflare. Do not use it for your tables.
- **`ADMIN_TELEGRAM_ID` must be a secret**, not a `[vars]` entry. See step 5 of deployment.

---

## Roadmap

This is checkpoint 1: a deployable, governed database librarian. The following are out of scope here and belong to a later checkpoint, once this one has proven itself in real use:

- Conversational memory (`knowledge`, `sessions`, `messages` tables)
- Self-improvement eval ratchet loop
- Digest agent and async summarization
- Federation with other agents
- Multi-tenant isolation

The `mutations` and `skill_versions` tables are present but empty. They exist so the schema stays stable across that transition. Do not build the above from this template.

---

## Project Layout

```
src/
├── index.ts        Edge Worker: auth + routing
├── agent.ts        CatoAgent DO: LLM loop, tools, eval runner
├── schema.ts       Schema init, manifest generator, model seed
├── soul.ts         System prompt (customize this)
├── tools.ts        SQL classifier + tool definitions
├── approval.ts     DDL approval queue
├── llm.ts          OpenRouter client with fallback
├── telegram.ts     Telegram message helpers
├── types.ts        TypeScript interfaces
└── ulid.ts         ULID generator (no dependencies)
```

---

## License

MIT. See [LICENSE](LICENSE).
