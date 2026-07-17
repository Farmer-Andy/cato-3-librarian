import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { PROTECTED_TABLES } from '../src/tools';
import type { CatoAgent } from '../src/agent';
import type { Actor } from '../src/types';
import { deriveSecret, stubTelegramFetch, type TelegramCall } from './helpers';

const admin: Actor = { id: 'test:admin', role: 'admin' };

type AgentInternals = {
  initialize(): Promise<void>;
  executeTool(toolName: string, args: Record<string, unknown>, actor: Actor): Promise<string>;
};

// A Telegram update carrying an update_id but no message text. The DO-level
// dedup runs on update_id before the message is inspected, and a text-less
// update returns early — so this exercises the insert-before-process path
// deterministically without ever entering the LLM loop.
function updateBody(updateId: number): string {
  return JSON.stringify({ update_id: updateId });
}

function telegramRequest(updateId: number): Request {
  return new Request('https://agent.internal/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: updateBody(updateId),
  });
}

async function callWrite(sql: string, name = 'dedup-protected'): Promise<string> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: CatoAgent) => {
    const internals = instance as unknown as AgentInternals;
    await internals.initialize();
    return internals.executeTool('write', { sql, rationale: 'test' }, admin);
  });
}

describe('telegram webhook update_id dedup (real DO)', () => {
  it('inserts on first delivery and dedups an identical redelivery', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('dedup-same-id'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const updateId = 100001;

      const first = await instance.fetch(telegramRequest(updateId));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true });

      // First delivery recorded exactly one row.
      const afterFirst = state.storage.sql
        .exec('SELECT update_id FROM telegram_updates WHERE update_id = ?', updateId)
        .toArray();
      expect(afterFirst).toHaveLength(1);

      // Redelivery of the SAME update_id is skipped without reprocessing.
      const second = await instance.fetch(telegramRequest(updateId));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ ok: true, deduplicated: true });

      // Still exactly one row for that update_id — the redelivery inserted nothing.
      const count = state.storage.sql
        .exec('SELECT COUNT(*) AS n FROM telegram_updates WHERE update_id = ?', updateId)
        .toArray()[0]['n'] as number;
      expect(count).toBe(1);
    });
  });

  it('processes two distinct update_ids and dedups neither', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('dedup-distinct-ids'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const idA = 200001;
      const idB = 200002;

      const resA = await instance.fetch(telegramRequest(idA));
      const resB = await instance.fetch(telegramRequest(idB));
      expect(await resA.json()).toEqual({ ok: true });
      expect(await resB.json()).toEqual({ ok: true });

      const rows = state.storage.sql
        .exec(
          'SELECT update_id FROM telegram_updates WHERE update_id IN (?, ?) ORDER BY update_id',
          idA,
          idB,
        )
        .toArray()
        .map((r) => Number((r as Record<string, unknown>)['update_id']));
      expect(rows).toEqual([idA, idB]);
    });
  });
});

describe('telegram_updates protected table', () => {
  it('is in PROTECTED_TABLES', () => {
    expect(PROTECTED_TABLES.has('telegram_updates')).toBe(true);
  });

  it('rejects an LLM-issued write to telegram_updates', async () => {
    const result = await callWrite('DELETE FROM telegram_updates WHERE 1=1');
    expect(result).toContain('agent infrastructure');
  });
});

describe('webhook async ACK', () => {
  let telegramCalls: TelegramCall[];

  beforeEach(() => {
    telegramCalls = stubTelegramFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ACKs instantly with an empty 200; the reply is delivered in the background', async () => {
    const adminId = Number(env.ADMIN_TELEGRAM_ID);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://example.com/webhook/telegram', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': await deriveSecret(env.ADMIN_TOKEN) },
        body: JSON.stringify({
          update_id: 900001,
          message: { from: { id: adminId }, chat: { id: adminId }, text: '/models' },
        }),
      }),
      env,
      ctx,
    );

    // Fast ACK: empty body, 200, no waiting on the DO's LLM/command work.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');

    // The DO delivers the /models reply out-of-band via the Telegram API.
    await waitOnExecutionContext(ctx);
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].url).toContain('sendMessage');
  });
});
