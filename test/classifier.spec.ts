import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { classifySQL, isUnsafeWrite } from '../src/tools';
import type { CatoAgent } from '../src/agent';
import type { Actor } from '../src/types';

// Reach the private tool dispatcher on the real DO instance.
type AgentInternals = {
  initialize(): Promise<void>;
  executeTool(toolName: string, args: Record<string, unknown>, actor: Actor): Promise<string>;
};

const admin: Actor = { id: 'test:admin', role: 'admin' };

describe('classifySQL', () => {
  it('classifies plain statements by first keyword', () => {
    expect(classifySQL('SELECT 1')).toBe('read');
    expect(classifySQL('EXPLAIN SELECT 1')).toBe('read');
    expect(classifySQL('VALUES (1)')).toBe('read');
    expect(classifySQL("INSERT INTO t VALUES (1)")).toBe('write');
    expect(classifySQL('CREATE TABLE t (id INTEGER)')).toBe('ddl');
  });

  it('classifies CTE-wrapped mutations as write', () => {
    expect(classifySQL('WITH c(v) AS (SELECT 1) INSERT INTO t SELECT v FROM c')).toBe('write');
    expect(classifySQL('WITH c AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM c)')).toBe('write');
    expect(classifySQL('WITH c AS (SELECT 1) UPDATE t SET x = 1 WHERE id IN (SELECT * FROM c)')).toBe('write');
  });

  it('classifies CTE-wrapped selects as read', () => {
    expect(classifySQL('WITH c AS (SELECT 1) SELECT * FROM c')).toBe('read');
    // Nested subqueries inside the CTE body must not confuse the depth walk
    expect(classifySQL('WITH c AS (SELECT * FROM (SELECT 1)) SELECT * FROM c')).toBe('read');
  });

  it('classifies CTE mutations behind comments as write', () => {
    expect(classifySQL('-- innocent\nWITH c(v) AS (SELECT 1) INSERT INTO t SELECT v FROM c')).toBe('write');
  });

  it('treats assignment pragmas as unknown, bare pragmas as read', () => {
    expect(classifySQL('PRAGMA writable_schema = ON')).toBe('unknown');
    expect(classifySQL('PRAGMA user_version = 7')).toBe('unknown');
    expect(classifySQL('PRAGMA table_info(event_log)')).toBe('read');
    expect(classifySQL('PRAGMA table_list')).toBe('read');
  });

  it('allows only bare, unquoted introspection pragmas as reads', () => {
    // Bare name or name(args), name on the read-only allowlist → read.
    expect(classifySQL('PRAGMA table_info(users)')).toBe('read');
    expect(classifySQL('PRAGMA table_list')).toBe('read');
    expect(classifySQL('PRAGMA foreign_key_list(x)')).toBe('read');
    // Quoted ARG is fine — the NAME index_list is bare and on the allowlist.
    expect(classifySQL('PRAGMA index_list("t")')).toBe('read');
  });

  it('rejects quoted, bracketed, and call-form assignment pragmas as unknown', () => {
    // Assignment forms — these mutate connection/transaction state.
    expect(classifySQL('PRAGMA foreign_keys = 0')).toBe('unknown');
    expect(classifySQL('PRAGMA "foreign_keys" = 0')).toBe('unknown');
    expect(classifySQL('PRAGMA [foreign_keys] = 0')).toBe('unknown');
    // Call form of an assignment — DOES execute and weaken FK enforcement.
    expect(classifySQL('PRAGMA foreign_keys(0)')).toBe('unknown');
    // Quoted NAME — even of an allowlisted pragma — is not bare, so unknown.
    expect(classifySQL('PRAGMA "table_info"(users)')).toBe('unknown');
    // Other assignment pragmas.
    expect(classifySQL('PRAGMA writable_schema = 1')).toBe('unknown');
    expect(classifySQL('PRAGMA case_sensitive_like = 1')).toBe('unknown');
    expect(classifySQL('PRAGMA journal_mode = WAL')).toBe('unknown');
  });
});

describe('isUnsafeWrite', () => {
  it('rejects DELETE/UPDATE with no WHERE', () => {
    expect(isUnsafeWrite('DELETE FROM t')).toBe(true);
    expect(isUnsafeWrite('UPDATE t SET x = 1')).toBe(true);
  });

  it('accepts DELETE/UPDATE with a WHERE clause', () => {
    expect(isUnsafeWrite('DELETE FROM t WHERE id = 1')).toBe(false);
    expect(isUnsafeWrite('UPDATE t SET x = 1 WHERE id = 1')).toBe(false);
  });

  it('is not fooled by WHERE as an identifier substring', () => {
    // Old substring check would have accepted these as constrained.
    expect(isUnsafeWrite('DELETE FROM somewhere')).toBe(true);
    expect(isUnsafeWrite('UPDATE t SET x = anywhere_flag')).toBe(true);
  });

  it('documents the tautological-WHERE residual gap', () => {
    // Known accepted gap, shared with phase-2: any WHERE token counts as
    // constrained, even a tautology. If this ever tightens, update the README.
    expect(isUnsafeWrite('DELETE FROM t WHERE id = id')).toBe(false);
  });

  it('ignores non-DELETE/UPDATE statements', () => {
    expect(isUnsafeWrite('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isUnsafeWrite('SELECT 1')).toBe(false);
  });
});

describe('query tool boundary (real DO SQLite)', () => {
  it('rejects a CTE-wrapped INSERT and leaves the table unchanged', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('classifier-test'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe (v INTEGER)').toArray();

      const result = await internals.executeTool(
        'query',
        { sql: 'WITH c(v) AS (SELECT 1) INSERT INTO probe SELECT v FROM c' },
        admin
      );
      expect(result).toContain('query tool only accepts read SQL');

      const rows = state.storage.sql.exec('SELECT COUNT(*) AS n FROM probe').toArray();
      expect(rows[0]['n']).toBe(0);
    });
  });

  it('still serves genuine reads', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('classifier-test-read'));
    await runInDurableObject(stub, async (instance: CatoAgent) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      const result = await internals.executeTool('query', { sql: 'SELECT 1 AS one' }, admin);
      expect(JSON.parse(result)).toEqual([{ one: 1 }]);
    });
  });

  it('rejects a call-form assignment pragma through the query tool (unknown, not executed)', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('classifier-test-pragma'));
    await runInDurableObject(stub, async (instance: CatoAgent) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      // PRAGMA foreign_keys(0) DOES execute and weaken FK enforcement in workerd
      // if it reaches SQLite. Classified 'unknown', the tier check rejects it.
      const result = await internals.executeTool('query', { sql: 'PRAGMA foreign_keys(0)' }, admin);
      expect(result).toContain('query tool only accepts read SQL');
      expect(result).toContain('unknown');
    });
  });
});
