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
});
