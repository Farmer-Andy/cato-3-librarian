import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROTECTED_TABLES } from '../src/tools';
import type { CatoAgent } from '../src/agent';
import type { Actor } from '../src/types';

const admin: Actor = { id: 'test:admin', role: 'admin' };

type AgentInternals = {
  initialize(): Promise<void>;
  executeTool(toolName: string, args: Record<string, unknown>, actor: Actor): Promise<string>;
};

// A Telegram update carrying only an update_id (no message). It exercises the
// dedup + enqueue path deterministically: the webhook writes a pending inbox row
// and never touches the LLM or the Telegram API.
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

describe('telegram webhook enqueue + update_id dedup (real DO)', () => {
  it('enqueues a pending row on first delivery and ignores an identical redelivery', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('dedup-same-id'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      await (instance as unknown as AgentInternals).initialize();
      // pool-workers persists DO storage across runs; start from a clean inbox so
      // a leftover row from a prior run does not read as a duplicate first delivery.
      state.storage.sql.exec('DELETE FROM telegram_updates').toArray();

      const updateId = 100001;

      const first = await instance.fetch(telegramRequest(updateId));
      expect(first.status).toBe(200);
      // Enqueue path ACKs an empty body — no reply is carried here.
      expect(await first.text()).toBe('');

      // First delivery wrote exactly one pending row.
      const afterFirst = state.storage.sql
        .exec('SELECT status FROM telegram_updates WHERE update_id = ?', updateId)
        .toArray();
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]['status']).toBe('pending');

      // Redelivery of the SAME update_id conflicts on the primary key and is
      // ignored (INSERT OR IGNORE), so no second row and no second processing.
      const second = await instance.fetch(telegramRequest(updateId));
      expect(second.status).toBe(200);

      const count = state.storage.sql
        .exec('SELECT COUNT(*) AS n FROM telegram_updates WHERE update_id = ?', updateId)
        .toArray()[0]['n'] as number;
      expect(count).toBe(1);
    });
  });

  it('enqueues two distinct update_ids as two rows', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('dedup-distinct-ids'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      await (instance as unknown as AgentInternals).initialize();
      state.storage.sql.exec('DELETE FROM telegram_updates').toArray();

      const idA = 200001;
      const idB = 200002;

      await instance.fetch(telegramRequest(idA));
      await instance.fetch(telegramRequest(idB));

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
