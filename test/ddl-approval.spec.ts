import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatoAgent } from '../src/agent';
import type { Actor } from '../src/types';
import { adminUpdate, deriveSecret, stubTelegramFetch, type TelegramCall } from './helpers';

type AgentInternals = {
  initialize(): Promise<void>;
  executeTool(toolName: string, args: Record<string, unknown>, actor: Actor): Promise<string>;
};

const admin: Actor = { id: 'test:admin', role: 'admin' };

let telegramCalls: TelegramCall[];

beforeEach(() => {
  telegramCalls = stubTelegramFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function proposeDDL(ddl: string): Promise<string> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('cato3-primary'));
  return runInDurableObject(stub, async (instance: CatoAgent) => {
    const internals = instance as unknown as AgentInternals;
    await internals.initialize();
    const result = await internals.executeTool('propose_ddl', { sql: ddl, rationale: 'test' }, admin);
    const match = result.match(/ID: (\S+?)\./);
    if (!match) throw new Error(`propose_ddl gave no id: ${result}`);
    return match[1];
  });
}

async function readAgentState(query: string): Promise<Array<Record<string, unknown>>> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('cato3-primary'));
  return runInDurableObject(stub, async (_instance: CatoAgent, state: DurableObjectState) =>
    state.storage.sql.exec(query).toArray()
  );
}

describe('approved DDL execution', () => {
  it('materializes the schema change before reporting granted (Telegram /approve path)', async () => {
    const id = await proposeDDL('CREATE TABLE approved_widget (id INTEGER PRIMARY KEY)');

    const res = await SELF.fetch('https://example.com/webhook/telegram', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': await deriveSecret(env.ADMIN_TOKEN) },
      body: adminUpdate(`/approve ${id}`),
    });
    expect(res.status).toBe(200);

    // The reply message reports the grant (earlier sendMessage calls are the
    // proposal notification from propose_ddl — take the latest)
    const reply = telegramCalls.filter((c) => c.url.includes('sendMessage')).at(-1);
    expect(String(reply?.body['text'])).toContain('granted and executed');

    // The table actually exists in the schema
    const tables = await readAgentState(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'approved_widget'`
    );
    expect(tables).toHaveLength(1);

    // And the approval row is granted
    const rows = await readAgentState(`SELECT status FROM approval_pending WHERE id = '${id}'`);
    expect(rows[0]['status']).toBe('granted');
  });

  it('does not grant when the DDL fails (HTTP /approve path)', async () => {
    const id = await proposeDDL('CREATE INDEX idx_broken ON no_such_table (nope)');

    const res = await SELF.fetch(`https://example.com/approve/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Execution failed');

    // Approval fell back to pending, not granted
    const rows = await readAgentState(`SELECT status FROM approval_pending WHERE id = '${id}'`);
    expect(rows[0]['status']).toBe('pending');

    // And the failure is in the audit log
    const failures = await readAgentState(
      `SELECT outcome FROM event_log WHERE event_type = 'ddl_execute' AND outcome = 'failure'`
    );
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  it('grants and executes via the HTTP /approve path too', async () => {
    const id = await proposeDDL('CREATE TABLE approved_gadget (id INTEGER PRIMARY KEY)');

    const res = await SELF.fetch(`https://example.com/approve/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    const result = (await res.json()) as { ok: boolean };
    expect(result.ok).toBe(true);

    const tables = await readAgentState(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'approved_gadget'`
    );
    expect(tables).toHaveLength(1);
  });
});
