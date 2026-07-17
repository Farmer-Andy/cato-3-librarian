import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatoAgent } from '../src/agent';
import type { TelegramCall } from './helpers';

type AgentInternals = { initialize(): Promise<void> };
type AgentAlarm = { alarm(): Promise<void> };

interface ScriptedTurn {
  content: string | null;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
}

// Stub both outbound APIs. Telegram calls are captured (url + body). OpenRouter
// either plays back a scripted conversation (one turn per LLM round) or throws to
// simulate a model outage, so we can exercise the alarm's retry/quarantine path.
function stubOutbound(opts: { llm?: ScriptedTurn[]; llmThrows?: boolean }): TelegramCall[] {
  const telegramCalls: TelegramCall[] = [];
  let turn = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.telegram.org/')) {
      const raw = init?.body ? String(init.body) : await (input as Request).clone().text();
      telegramCalls.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
      return Response.json({ ok: true, result: true });
    }
    if (url.startsWith('https://openrouter.ai/')) {
      if (opts.llmThrows) throw new Error('simulated model outage');
      const script = opts.llm ?? [{ content: '(no script)' }];
      const t = script[Math.min(turn, script.length - 1)];
      turn++;
      return Response.json({
        choices: [
          {
            message: {
              content: t.content,
              tool_calls: t.tool_calls?.map((tc, i) => ({
                id: `tc${turn}-${i}`,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
  return telegramCalls;
}

function regularBody(updateId: number, text: string): string {
  const adminId = Number(env.ADMIN_TELEGRAM_ID);
  return JSON.stringify({
    update_id: updateId,
    message: { from: { id: adminId }, chat: { id: adminId }, text },
  });
}

function bareBody(updateId: number): string {
  return JSON.stringify({ update_id: updateId });
}

// Build the forwarded Request INSIDE the DO context. A Request body is a stream
// bound to the isolate context that created it; passing one built in the test's
// top-level context into instance.fetch() trips workerd's cross-DO I/O guard.
function telegramRequest(body: string): Request {
  return new Request('https://agent.internal/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

// Enqueue an update through the real DO handler, then delete the alarm it armed.
// The webhook arms an immediate (now) alarm; the test harness would auto-deliver
// that on a real timer and race our assertions. We drop it and instead drive the
// alarm deterministically with drainOnce(), one pass per call. clearInbox keeps a
// re-run's persisted rows from reading as duplicates.
async function enqueue(name: string, body: string, opts: { clearEventLog?: boolean } = {}): Promise<void> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
  await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
    await (instance as unknown as AgentInternals).initialize();
    state.storage.sql.exec('DELETE FROM telegram_updates').toArray();
    if (opts.clearEventLog) state.storage.sql.exec('DELETE FROM event_log').toArray();
    const res = await instance.fetch(telegramRequest(body));
    expect(res.status).toBe(200);
    await state.storage.deleteAlarm();
  });
}

// Re-deliver without clearing the inbox first (proves a done row is not reprocessed).
async function deliver(name: string, body: string): Promise<void> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
  await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
    await instance.fetch(telegramRequest(body));
    await state.storage.deleteAlarm();
  });
}

// Run the DO's alarm() exactly once, awaited to completion — the deterministic
// stand-in for a scheduled alarm firing.
async function drainOnce(name: string): Promise<void> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
  await runInDurableObject(stub, async (instance: CatoAgent) => {
    await (instance as unknown as AgentAlarm).alarm();
  });
}

async function readRow(name: string, updateId: number): Promise<Record<string, unknown>> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
  return runInDurableObject(stub, async (_i: CatoAgent, state: DurableObjectState) => {
    const rows = state.storage.sql
      .exec('SELECT status, attempts FROM telegram_updates WHERE update_id = ?', updateId)
      .toArray();
    return (rows[0] ?? {}) as Record<string, unknown>;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telegram inbox alarm drain', () => {
  it('drains a queued regular message: row becomes done and the reply is delivered', async () => {
    const name = 'inbox-drain';
    const telegramCalls = stubOutbound({ llm: [{ content: 'Two tables: event_log and model_registry.' }] });
    const updateId = 810001;

    await enqueue(name, regularBody(updateId, 'What tables exist?'));

    // Enqueue-only: no LLM/Telegram traffic yet, row is pending.
    expect(telegramCalls).toHaveLength(0);
    expect((await readRow(name, updateId))['status']).toBe('pending');

    await drainOnce(name);

    const reply = telegramCalls.find((c) => c.url.includes('sendMessage'));
    expect(reply).toBeDefined();
    expect(String(reply?.body['text'])).toContain('event_log');
    expect((await readRow(name, updateId))['status']).toBe('done');
  });

  it('marks a text-less update done without any LLM or Telegram call', async () => {
    const name = 'inbox-noop';
    const telegramCalls = stubOutbound({ llm: [{ content: 'should never be produced' }] });
    const updateId = 830001;

    await enqueue(name, bareBody(updateId));
    await drainOnce(name);

    // No message text → no-op. No outbound traffic at all, and the row is retired.
    expect(telegramCalls).toHaveLength(0);
    expect((await readRow(name, updateId))['status']).toBe('done');
  });

  it('does not reprocess an update redelivered after it is already done', async () => {
    const name = 'inbox-redeliver';
    const telegramCalls = stubOutbound({ llm: [{ content: 'first and only answer' }] });
    const updateId = 820001;

    await enqueue(name, regularBody(updateId, 'hello'));
    await drainOnce(name);
    expect(telegramCalls.filter((c) => c.url.includes('sendMessage'))).toHaveLength(1);
    expect((await readRow(name, updateId))['status']).toBe('done');

    // Redeliver the same update_id. INSERT OR IGNORE conflicts on the done row, so
    // nothing is enqueued; a subsequent drain finds no pending work.
    await deliver(name, regularBody(updateId, 'hello'));
    await drainOnce(name);

    // Still exactly one reply — the redelivery was not reprocessed.
    expect(telegramCalls.filter((c) => c.url.includes('sendMessage'))).toHaveLength(1);
  });

  it('retries a failing update 3 times then quarantines it, and keeps draining the queue', async () => {
    const name = 'inbox-poison';
    const poisonId = 840001;

    // Model outage: every LLM round throws, so processing the update throws too.
    const poisonCalls = stubOutbound({ llmThrows: true });
    await enqueue(name, regularBody(poisonId, 'trigger the model'), { clearEventLog: true });

    // Run 1: attempts = 1, still pending.
    await drainOnce(name);
    let row = await readRow(name, poisonId);
    expect(row['status']).toBe('pending');
    expect(Number(row['attempts'])).toBe(1);

    // Run 2: attempts = 2, still pending.
    await drainOnce(name);
    row = await readRow(name, poisonId);
    expect(row['status']).toBe('pending');
    expect(Number(row['attempts'])).toBe(2);

    // Run 3: attempts = 3 → failed, and a telegram_update_failed event is logged.
    await drainOnce(name);
    row = await readRow(name, poisonId);
    expect(row['status']).toBe('failed');
    expect(Number(row['attempts'])).toBe(3);

    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
    const failed = await runInDurableObject(stub, async (_i: CatoAgent, state: DurableObjectState) =>
      state.storage.sql.exec("SELECT * FROM event_log WHERE event_type = 'telegram_update_failed'").toArray(),
    );
    expect(failed).toHaveLength(1);

    // Quarantine notice: the user is told their command was dropped, exactly once,
    // on the attempt that marked the row failed (not on the earlier retries).
    const quarantineNotices = poisonCalls.filter(
      (c) => c.url.includes('sendMessage') && String(c.body['text']).includes('failed after 3 attempts'),
    );
    expect(quarantineNotices).toHaveLength(1);
    expect(Number(quarantineNotices[0].body['chat_id'])).toBe(Number(env.ADMIN_TELEGRAM_ID));

    // A later, healthy update still gets processed — the poison did not block the queue.
    vi.unstubAllGlobals();
    const healthyCalls = stubOutbound({ llm: [{ content: 'healthy reply' }] });
    const healthyId = 840002;
    await deliver(name, regularBody(healthyId, 'hello again'));
    await drainOnce(name);
    expect((await readRow(name, healthyId))['status']).toBe('done');
    expect(healthyCalls.some((c) => c.url.includes('sendMessage'))).toBe(true);
  });

  it('reschedules immediately (not +30s) when a fresh update arrives mid-drain', async () => {
    const name = 'inbox-fresh-reschedule';
    const firstId = 850001;
    const secondId = 850002;
    const telegramCalls: TelegramCall[] = [];
    let injected = false;

    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      await (instance as unknown as AgentInternals).initialize();
      state.storage.sql.exec('DELETE FROM telegram_updates').toArray();

      // Stub outbound. While the FIRST update's LLM round is in flight, inject a
      // second, fresh (attempts = 0) update straight into the inbox — the input
      // gate is open during this await, exactly as a real webhook enqueue would
      // be. That row is not in processInbox's snapshot, so it survives the drain
      // and must trigger an IMMEDIATE reschedule, not the 30s retry backoff.
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith('https://api.telegram.org/')) {
          const raw = init?.body ? String(init.body) : await (input as Request).clone().text();
          telegramCalls.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
          return Response.json({ ok: true, result: true });
        }
        if (url.startsWith('https://openrouter.ai/')) {
          if (!injected) {
            injected = true;
            state.storage.sql.exec(
              `INSERT OR IGNORE INTO telegram_updates (update_id, chat_id, text, payload) VALUES (?, ?, ?, ?)`,
              secondId,
              Number(env.ADMIN_TELEGRAM_ID),
              'second',
              regularBody(secondId, 'second')
            ).toArray();
          }
          return Response.json({ choices: [{ message: { content: 'first answer' } }] });
        }
        throw new Error(`Unexpected outbound fetch in test: ${url}`);
      });

      // Enqueue the first update, drop the alarm it armed, then drive one alarm pass.
      const res = await instance.fetch(telegramRequest(regularBody(firstId, 'first')));
      expect(res.status).toBe(200);
      await state.storage.deleteAlarm();

      await (instance as unknown as AgentAlarm).alarm();

      // The fresh second row is pending after the drain, so the reschedule is
      // immediate: getAlarm() is at or before now, not ~30s out. Read and clear
      // the alarm before the block yields, so the harness cannot auto-fire the
      // now-alarm and race the assertions.
      const alarmAt = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
      expect(alarmAt).not.toBeNull();
      expect(alarmAt as number).toBeLessThanOrEqual(Date.now());

      const secondRow = state.storage.sql
        .exec('SELECT status, attempts FROM telegram_updates WHERE update_id = ?', secondId)
        .toArray()[0] as Record<string, unknown>;
      expect(secondRow['status']).toBe('pending');
      expect(Number(secondRow['attempts'])).toBe(0);
    });
    vi.unstubAllGlobals();
  });
});
