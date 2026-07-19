import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CatoAgent } from '../src/agent';
import type { Actor } from '../src/types';

// The write tool must report the LOGICAL affected-row count (from changes(),
// not the inflating cursor.rowsWritten — see rows-written-probe.spec.ts) and
// must refuse to let a no-op UPDATE/DELETE read as success. WHY: a live
// incident where the model "closed tasks" via UPDATEs with fabricated ids —
// zero rows matched, the tool said success, and it told the operator it was done.

type AgentInternals = {
  initialize(): Promise<void>;
  executeTool(toolName: string, args: Record<string, unknown>, actor: Actor): Promise<string>;
};

const admin: Actor = { id: 'test:admin', role: 'admin' };

// Most-recent tool_call success payload for the DO. Order by the implicit
// rowid (strict insertion order): the ULID `id` is only millisecond-resolution
// so two events in the same ms are not reliably orderable by id.
function lastToolCallPayload(sql: SqlStorage): Record<string, unknown> {
  const row = sql
    .exec("SELECT payload_json FROM event_log WHERE event_type = 'tool_call' AND outcome = 'success' ORDER BY rowid DESC LIMIT 1")
    .toArray()[0] as { payload_json: string };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

describe('write tool reports rows modified (real DO)', () => {
  it('success message carries the affected-row count and logs rows_written', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('rows-modified-count'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      const sql = state.storage.sql;

      // delete-first: the pool persists DO storage across runs.
      sql.exec('DROP TABLE IF EXISTS widgets').toArray();
      sql.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, status TEXT)').toArray();
      sql.exec("INSERT INTO widgets (id, status) VALUES (1,'open'),(2,'open'),(3,'closed')").toArray();

      // Single-row INSERT → singular "1 row modified".
      const ins = await internals.executeTool('write', { sql: "INSERT INTO widgets (id, status) VALUES (4,'open')", rationale: 't' }, admin);
      expect(ins).toBe('Write executed successfully (1 row modified).');
      expect(lastToolCallPayload(sql).rows_written).toBe(1);

      // UPDATE matching 3 rows → plural "3 rows modified".
      const upd = await internals.executeTool('write', { sql: "UPDATE widgets SET status = 'done' WHERE status = 'open'", rationale: 't' }, admin);
      expect(upd).toBe('Write executed successfully (3 rows modified).');
      expect(lastToolCallPayload(sql).rows_written).toBe(3);

      // DELETE matching 1 row → singular again.
      const del = await internals.executeTool('write', { sql: 'DELETE FROM widgets WHERE id = 3', rationale: 't' }, admin);
      expect(del).toBe('Write executed successfully (1 row modified).');
      expect(lastToolCallPayload(sql).rows_written).toBe(1);
    });
  });

  it('a 0-row UPDATE returns the warning and logs rows_written: 0', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('rows-modified-zero-update'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      const sql = state.storage.sql;

      sql.exec('DROP TABLE IF EXISTS widgets').toArray();
      sql.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, status TEXT)').toArray();
      sql.exec("INSERT INTO widgets (id, status) VALUES (1,'open')").toArray();

      // Fabricated id — matches nothing (the live-incident shape).
      const res = await internals.executeTool('write', { sql: "UPDATE widgets SET status = 'done' WHERE id = 9999", rationale: 't' }, admin);
      expect(res).toContain('WARNING');
      expect(res).toContain('modified 0 rows');
      expect(res).not.toContain('successfully');

      // The write is SQLite-"successful", so the event is logged success — but it
      // must record rows_written: 0 so the audit trail shows the no-op.
      expect(lastToolCallPayload(sql).rows_written).toBe(0);

      // Nothing actually changed.
      const still = sql.exec("SELECT status FROM widgets WHERE id = 1").toArray()[0] as { status: string };
      expect(still.status).toBe('open');
    });
  });

  it('a 0-row DELETE also returns the warning', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('rows-modified-zero-delete'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();
      const sql = state.storage.sql;

      sql.exec('DROP TABLE IF EXISTS widgets').toArray();
      sql.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, status TEXT)').toArray();
      sql.exec("INSERT INTO widgets (id, status) VALUES (1,'open')").toArray();

      const res = await internals.executeTool('write', { sql: 'DELETE FROM widgets WHERE id = 9999', rationale: 't' }, admin);
      expect(res).toContain('WARNING');
      expect(res).toContain('modified 0 rows');
      expect(lastToolCallPayload(sql).rows_written).toBe(0);
    });
  });
});
