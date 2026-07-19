import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { classifySQL, isUnsafeWrite, hasMultipleStatements } from '../src/tools';
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

  it('splits value pragmas from lookup pragmas on the call form', () => {
    // Call form of a VALUE pragma IS assignment: PRAGMA user_version(9) sets the
    // user version. These must classify unknown so they never reach the read tier.
    expect(classifySQL('PRAGMA user_version(9)')).toBe('unknown');
    expect(classifySQL('PRAGMA page_size(4096)')).toBe('unknown');
    expect(classifySQL("PRAGMA encoding('UTF-8')")).toBe('unknown');
    expect(classifySQL('PRAGMA auto_vacuum(2)')).toBe('unknown');
    expect(classifySQL('PRAGMA schema_version(1)')).toBe('unknown');
    // Call form of a LOOKUP pragma is a read: the argument names the object.
    expect(classifySQL('PRAGMA table_info(users)')).toBe('read');
    expect(classifySQL('PRAGMA integrity_check(10)')).toBe('read');
    expect(classifySQL('PRAGMA foreign_key_list(users)')).toBe('read');
    // Bare value pragmas remain reads.
    expect(classifySQL('PRAGMA user_version')).toBe('read');
    expect(classifySQL('PRAGMA page_size')).toBe('read');
    // Quoted names — even of a lookup pragma — are never bare, so unknown.
    expect(classifySQL('PRAGMA "user_version"')).toBe('unknown');
    expect(classifySQL('PRAGMA "user_version"(9)')).toBe('unknown');
  });
});

describe('multi-statement rejection', () => {
  it('classifies a multi-statement string as unknown', () => {
    // DO SQLite would run only `SELECT 1` and silently drop the UPDATE.
    expect(classifySQL('SELECT 1; UPDATE t SET c = 2')).toBe('unknown');
  });

  it('allows a single trailing semicolon', () => {
    expect(classifySQL('SELECT 1;')).toBe('read');
  });

  it('does not count a semicolon inside a string literal', () => {
    expect(classifySQL("SELECT ';'")).toBe('read');
  });

  it('classifies a multi-statement DDL string as unknown (propose_ddl would refuse it)', () => {
    // Admin sees two CREATEs; DO SQLite would run only the first. Classified
    // 'unknown', propose_ddl (which requires 'ddl') rejects the whole string.
    expect(classifySQL('CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER)')).toBe('unknown');
  });

  it('hasMultipleStatements detects trailing content vs a bare trailing semicolon', () => {
    expect(hasMultipleStatements('SELECT 1; UPDATE t SET c = 2')).toBe(true);
    expect(hasMultipleStatements('SELECT 1;')).toBe(false);
    expect(hasMultipleStatements('SELECT 1')).toBe(false);
    expect(hasMultipleStatements("SELECT ';'")).toBe(false);
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

  it('flags CTE-wrapped UPDATE/DELETE with no WHERE as unsafe', () => {
    // First keyword is WITH, but the top-level verb is a full-table write — the
    // plain first-keyword check used to skip these entirely.
    expect(isUnsafeWrite('WITH x AS (SELECT 1) UPDATE t SET c = 2')).toBe(true);
    expect(isUnsafeWrite('WITH x AS (SELECT 1) DELETE FROM t')).toBe(true);
  });

  it('accepts a CTE-wrapped UPDATE/DELETE that carries a WHERE on the verb', () => {
    expect(isUnsafeWrite('WITH x AS (SELECT 1) UPDATE t SET c = 2 WHERE id = 3')).toBe(false);
  });

  it('does not count a WHERE inside the CTE body as constraining the write', () => {
    // The WHERE binds the CTE's SELECT, not the UPDATE — still a full-table write.
    expect(isUnsafeWrite('WITH x AS (SELECT 1 FROM y WHERE a = 1) UPDATE t SET c = 2')).toBe(true);
  });

  it('ignores CTE-wrapped INSERT and SELECT (no WHERE requirement)', () => {
    expect(isUnsafeWrite('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(false);
    expect(isUnsafeWrite('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
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

  it('rejects a multi-statement string end to end (DO SQLite would run only the first)', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('classifier-test-multi'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe (v INTEGER)').toArray();
      state.storage.sql.exec('INSERT INTO probe (v) VALUES (1)').toArray();

      // DO SQLite would execute only `SELECT 1` and silently drop the UPDATE. The
      // classifier calls the whole string 'unknown', so the query tier refuses it
      // before any statement runs.
      const result = await internals.executeTool(
        'query',
        { sql: 'SELECT 1; UPDATE probe SET v = 2' },
        admin
      );
      expect(result).toContain('query tool only accepts read SQL');
      expect(result).toContain('unknown');

      // The trailing UPDATE never ran.
      const rows = state.storage.sql.exec('SELECT v FROM probe').toArray();
      expect(rows).toEqual([{ v: 1 }]);
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

  it('rejects a call-form value pragma (user_version(9)) through the query tool', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('classifier-test-uv'));
    await runInDurableObject(stub, async (instance: CatoAgent) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      // Call form of a value pragma is assignment: PRAGMA user_version(9) sets
      // state. Classified 'unknown', the query tier refuses it before SQLite.
      const result = await internals.executeTool('query', { sql: 'PRAGMA user_version(9)' }, admin);
      expect(result).toContain('query tool only accepts read SQL');
      expect(result).toContain('unknown');
    });
  });

  it('probes raw PRAGMA user_version(9) against DO SQLite to pin workerd behavior', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('classifier-test-uv-probe'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      await (instance as unknown as AgentInternals).initialize();

      let threw = false;
      let errText = '';
      try {
        // Raw call-form value pragma straight to DO SQLite, no classifier in the
        // path. This pins what workerd actually does with the assignment form.
        state.storage.sql.exec('PRAGMA user_version(9)').toArray();
      } catch (err) {
        threw = true;
        errText = String(err);
      }

      // PINNED WORKERD BEHAVIOR (workerd 1.20260415.1, DO SQLite): the call-form
      // value pragma PRAGMA user_version(9) THROWS "not authorized: SQLITE_AUTH".
      // workerd's SQLite authorizer blocks the user_version pragma outright (the
      // bare read form throws SQLITE_AUTH too), so the assignment never lands and
      // no state changes. The classifier refuses the call form independently
      // (classified 'unknown', see the query-tool rejection test above), so the
      // safety guarantee does NOT depend on this runtime throw. If a future
      // workerd stops throwing here, this assertion flips and the classifier
      // becomes the only thing standing between the agent and a silent write.
      expect(threw).toBe(true);
      expect(errText).toContain('SQLITE_AUTH');
    });
  });
});

describe('write tool boundary (real DO SQLite)', () => {
  it('rejects a CTE-wrapped no-WHERE UPDATE like a plain no-WHERE UPDATE', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('classifier-test-cte-write'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe (v INTEGER)').toArray();
      state.storage.sql.exec('INSERT INTO probe (v) VALUES (1)').toArray();

      // WITH-prefixed full-table UPDATE: classifySQL sees 'write' (top-level verb
      // is UPDATE), and isUnsafeWrite must catch the missing WHERE even though the
      // first keyword is WITH. Same rejection path as a plain no-WHERE UPDATE.
      const result = await internals.executeTool(
        'write',
        { sql: 'WITH x AS (SELECT 1) UPDATE probe SET v = 2', rationale: 'test' },
        admin
      );
      expect(result).toContain('Unsafe operation rejected');
      expect(result).toContain('WHERE');

      // The row is untouched — the write never executed.
      const rows = state.storage.sql.exec('SELECT v FROM probe').toArray();
      expect(rows).toEqual([{ v: 1 }]);
    });
  });
});
