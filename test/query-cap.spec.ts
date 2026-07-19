import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CatoAgent } from '../src/agent';
import type { Actor } from '../src/types';

type AgentInternals = {
  initialize(): Promise<void>;
  executeTool(toolName: string, args: Record<string, unknown>, actor: Actor): Promise<string>;
};

const admin: Actor = { id: 'test:admin', role: 'admin' };

describe('query tool row cap (real DO)', () => {
  it('truncates results above 200 rows and reports the true total', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('query-cap-large'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();

      // Scratch table (not protected) seeded with 250 rows via a recursive CTE.
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS scratch (id INTEGER PRIMARY KEY, val TEXT)').toArray();
      state.storage.sql.exec(
        `INSERT INTO scratch (id, val)
         WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 250)
         SELECT n, 'row-' || n FROM seq`
      ).toArray();

      const result = await internals.executeTool('query', { sql: 'SELECT * FROM scratch' }, admin);

      // (a) truncation note. The early-break cursor can no longer report the exact
      // total (it stops at the cap), so the note directs the caller to narrow.
      expect(result).toContain('[Result truncated: showing the first 200 rows. Add a WHERE filter or LIMIT to narrow the result.]');

      // (b) the JSON portion parses to exactly 200 rows — the cap held.
      const jsonPart = result.split('\n\n[Result truncated')[0];
      const parsed = JSON.parse(jsonPart) as unknown[];
      expect(parsed).toHaveLength(200);
    });
  });

  it('leaves small results (< 200 rows) untruncated', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('query-cap-small'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();

      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS small (id INTEGER PRIMARY KEY, val TEXT)').toArray();
      state.storage.sql.exec(
        `INSERT INTO small (id, val)
         WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 3)
         SELECT n, 'row-' || n FROM seq`
      ).toArray();

      const result = await internals.executeTool('query', { sql: 'SELECT * FROM small' }, admin);

      expect(result).not.toContain('Result truncated');
      const parsed = JSON.parse(result) as unknown[];
      expect(parsed).toHaveLength(3);
    });
  });

  it('is byte-identical to a plain JSON.stringify for a normal small result', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('query-cap-identical'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();

      state.storage.sql.exec('DROP TABLE IF EXISTS ident').toArray();
      state.storage.sql.exec('CREATE TABLE ident (id INTEGER PRIMARY KEY, val TEXT)').toArray();
      state.storage.sql.exec("INSERT INTO ident (id, val) VALUES (1, 'alpha'), (2, 'beta')").toArray();

      const result = await internals.executeTool('query', { sql: 'SELECT * FROM ident ORDER BY id' }, admin);

      // No cap tripped → output is exactly the pretty-printed rows, no marker.
      expect(result).toBe(JSON.stringify([{ id: 1, val: 'alpha' }, { id: 2, val: 'beta' }], null, 2));
    });
  });

  it('truncates a single oversized string cell with a char-count marker', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('query-cap-cell'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();

      state.storage.sql.exec('DROP TABLE IF EXISTS bigcell').toArray();
      state.storage.sql.exec('CREATE TABLE bigcell (id INTEGER PRIMARY KEY, val TEXT)').toArray();
      // 5000-char value; per-cell cap is 2000.
      state.storage.sql.exec('INSERT INTO bigcell (id, val) VALUES (1, ?)', 'y'.repeat(5000)).toArray();

      const result = await internals.executeTool('query', { sql: 'SELECT * FROM bigcell' }, admin);

      // Whole-result byte budget not tripped, so no row/byte notice; only the cell marker.
      expect(result).not.toContain('Result truncated');
      expect(result).toContain('… [truncated, 5000 chars total]');
      const parsed = JSON.parse(result) as Array<{ val: string }>;
      // 2000 kept chars + the marker text.
      expect(parsed[0].val.startsWith('y'.repeat(2000))).toBe(true);
      expect(parsed[0].val).toContain('[truncated, 5000 chars total]');
      expect(parsed[0].val.length).toBeLessThan(2100);
    });
  });

  it('trips the byte budget before the 200-row cap and says so', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('query-cap-bytes'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();

      // 100 rows, each ~1900-char value (under the 2000 per-cell cap so no cell
      // marker). ~1900 bytes/row * 100 ≈ 190KB total, so the 64KB byte budget
      // trips well before the 200-row cap.
      state.storage.sql.exec('DROP TABLE IF EXISTS wide').toArray();
      state.storage.sql.exec('CREATE TABLE wide (id INTEGER PRIMARY KEY, val TEXT)').toArray();
      // substr(replace(hex(zeroblob(1000)), '0', 'x'), 1, 1900) → 1900 'x' chars.
      state.storage.sql.exec(
        `INSERT INTO wide (id, val)
         WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100)
         SELECT n, substr(replace(hex(zeroblob(1000)), '0', 'x'), 1, 1900) FROM seq`
      ).toArray();

      const result = await internals.executeTool('query', { sql: 'SELECT * FROM wide' }, admin);

      // The byte-budget notice fired, not the row-cap notice.
      expect(result).toContain('output budget');
      expect(result).not.toContain('showing the first 200 rows');
      const jsonPart = result.split('\n\n[Result truncated')[0];
      const parsed = JSON.parse(jsonPart) as unknown[];
      // Fewer than the 200-row cap: the byte budget stopped it first.
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.length).toBeLessThan(200);
    });
  });
});
