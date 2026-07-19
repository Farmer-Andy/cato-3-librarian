import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { findMutationTargets, PROTECTED_TABLES } from '../src/tools';
import type { CatoAgent } from '../src/agent';
import type { Actor } from '../src/types';

type AgentInternals = {
  initialize(): Promise<void>;
  executeTool(toolName: string, args: Record<string, unknown>, actor: Actor): Promise<string>;
};

const admin: Actor = { id: 'test:admin', role: 'admin' };

async function callWrite(sql: string, name = 'protected-test'): Promise<string> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: CatoAgent) => {
    const internals = instance as unknown as AgentInternals;
    await internals.initialize();
    return internals.executeTool('write', { sql, rationale: 'test' }, admin);
  });
}

describe('findMutationTargets', () => {
  it('finds plain INSERT/UPDATE/DELETE targets', () => {
    expect(findMutationTargets("INSERT INTO event_log VALUES ('x')")).toEqual(['event_log']);
    expect(findMutationTargets('UPDATE approval_pending SET status = 1')).toEqual(['approval_pending']);
    expect(findMutationTargets('DELETE FROM eval_runs WHERE 1=1')).toEqual(['eval_runs']);
    expect(findMutationTargets('REPLACE INTO active_model VALUES (1)')).toEqual(['active_model']);
  });

  it('sees through CTE prefixes, quoting, and schema qualification', () => {
    expect(findMutationTargets('WITH c AS (SELECT 1) DELETE FROM event_log WHERE id IN (SELECT * FROM c)')).toEqual(['event_log']);
    expect(findMutationTargets('DELETE FROM "event_log" WHERE 1=1')).toEqual(['event_log']);
    expect(findMutationTargets('DELETE FROM main.event_log WHERE 1=1')).toEqual(['event_log']);
    expect(findMutationTargets('INSERT OR REPLACE INTO model_registry VALUES (1)')).toEqual(['model_registry']);
    expect(findMutationTargets('UPDATE OR ROLLBACK eval_tasks SET active = 0 WHERE 1=1')).toEqual(['eval_tasks']);
  });

  it('does not flag reads or unrelated identifiers', () => {
    expect(findMutationTargets('SELECT * FROM event_log')).toEqual([]);
    // "ordering" must not be mangled by the UPDATE OR <conflict> form
    expect(findMutationTargets('UPDATE ordering SET x = 1 WHERE id = 1')).toEqual(['ordering']);
  });

  it('covers every table initSchema creates', () => {
    // If a new infrastructure table is added to schema.ts, it must be added to
    // PROTECTED_TABLES too — this test just pins the current set.
    expect([...PROTECTED_TABLES].sort()).toEqual([
      '_meta_comments',
      'active_model',
      'approval_pending',
      'eval_runs',
      'eval_tasks',
      'event_log',
      'model_registry',
      'mutations',
      'skill_versions',
      'telegram_updates',
    ]);
  });
});

describe('write tool protected-table guard (real DO)', () => {
  it('rejects deleting from the audit trail and leaves it intact', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('guard-audit'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();

      // Seed one legitimate audit row via a permitted domain write
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)').toArray();
      await internals.executeTool('write', { sql: "INSERT INTO notes (body) VALUES ('hello')", rationale: 'seed' }, admin);
      const before = state.storage.sql.exec('SELECT COUNT(*) AS n FROM event_log').toArray()[0]['n'] as number;
      expect(before).toBeGreaterThan(0);

      const result = await internals.executeTool('write', { sql: 'DELETE FROM event_log WHERE 1=1', rationale: 'cover tracks' }, admin);
      expect(result).toContain('agent infrastructure');

      const after = state.storage.sql.exec('SELECT COUNT(*) AS n FROM event_log').toArray()[0]['n'] as number;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  it('rejects granting approvals by direct UPDATE', async () => {
    const result = await callWrite("UPDATE approval_pending SET status = 'granted' WHERE 1=1");
    expect(result).toContain('agent infrastructure');
  });

  it('rejects CTE-wrapped mutations of protected tables', async () => {
    const result = await callWrite('WITH c AS (SELECT 1) DELETE FROM event_log WHERE id IN (SELECT * FROM c)');
    expect(result).toContain('agent infrastructure');
  });

  it('rejects quoted and schema-qualified evasions', async () => {
    expect(await callWrite('DELETE FROM "event_log" WHERE 1=1')).toContain('agent infrastructure');
    expect(await callWrite('DELETE FROM main.event_log WHERE 1=1')).toContain('agent infrastructure');
  });

  it('rejects unknown-class statements instead of executing them', async () => {
    const result = await callWrite('PRAGMA writable_schema = ON');
    expect(result).toContain('write tool only accepts INSERT, UPDATE, DELETE, or REPLACE');
  });

  it('still allows normal domain-table writes', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('guard-domain'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)').toArray();

      const result = await internals.executeTool('write', { sql: "INSERT INTO notes (body) VALUES ('kept')", rationale: 'test' }, admin);
      expect(result).toBe('Write executed successfully (1 row modified).');

      const rows = state.storage.sql.exec('SELECT body FROM notes').toArray();
      expect(rows).toEqual([{ body: 'kept' }]);
    });
  });
});
