import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CatoAgent } from '../src/agent';

// ---------------------------------------------------------------------------
// PROBE (measurement, not a behavioural test of app code).
//
// Question: on real Durable Object SQLite, does `cursor.rowsWritten` (read off
// the exec cursor after `.toArray()`) equal the LOGICAL affected-row count, or
// does it inflate because of secondary-index maintenance / differ from the
// canonical `SELECT changes()` counter?
//
// This matters because two LIVE sibling deployments (Cato-3-phase-2 and
// Learning Everywhere) report `cursor.rowsWritten` to the model as "rows
// modified". If it inflates on indexed tables, the model is told a single-row
// INSERT touched 2 rows, a 3-row UPDATE touched 6, etc.
//
// The table under test carries a SECONDARY INDEX on `grp`, so every write also
// forces index maintenance — the worst case for inflation.
//
// FINDING (asserted below, captured on this workerd runtime, deterministic):
//   statement                          rowsWritten   changes()
//   a. UPDATE matching 3 (indexed col)      6            3     <- INFLATED
//   b. UPDATE matching 0                     0            0
//   c. DELETE matching 2                     2            2
//   d. single-row INSERT (indexed)           2            1     <- INFLATED
//   e. multi-row INSERT (3 tuples)           6            3     <- INFLATED
//
// VERDICT: `cursor.rowsWritten` DOES inflate. On a table with a secondary
// index it counts the index-entry write in addition to the table-row write for
// INSERT and UPDATE (roughly table_rows + index_entries), so it over-reports
// the logical affected-row count by the number of maintained index entries.
// DELETE was NOT inflated here (index-entry removals were not counted), and a
// no-match UPDATE stays 0 — so the ZERO check (rowsWritten === 0) still lines
// up with changes() === 0. But the *magnitude* is wrong on indexed tables.
//
// `SELECT changes()` returns the logical affected-row count in EVERY case.
//
// CONSEQUENCE: `changes()` is the correct counter for a user-facing "N rows
// modified" message. The Librarian backport uses `changes()`. The live phase-2
// and Learning Everywhere code reports `cursor.rowsWritten` and therefore
// OVER-REPORTS the row count on any indexed table (their 0-row WARNING still
// fires correctly, but the count shown to the model is inflated). Flagged for
// a family follow-up.
// ---------------------------------------------------------------------------

interface Measured {
  rowsWritten: number;
  changes: number;
}

// Run one write statement, then read BOTH counters:
//  - cursor.rowsWritten: the property on the exec cursor, after consuming it
//    with .toArray() (DO cursors are lazy — the write does not run until then).
//  - SELECT changes(): a separate exec immediately after, the canonical SQLite
//    "rows modified by the most recent INSERT/UPDATE/DELETE" counter.
function measure(sql: SqlStorage, stmt: string): Measured {
  const cursor = sql.exec(stmt);
  cursor.toArray();
  const rowsWritten = cursor.rowsWritten;
  const changesRow = sql.exec('SELECT changes() AS n').toArray()[0] as { n: number };
  return { rowsWritten, changes: Number(changesRow.n) };
}

describe('probe: cursor.rowsWritten vs changes() on real DO SQLite', () => {
  it('rowsWritten inflates on an indexed table while changes() equals the logical count', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('rows-written-probe'));
    await runInDurableObject(stub, async (_instance: CatoAgent, state: DurableObjectState) => {
      const sql = state.storage.sql;

      // delete-first: the pool persists DO storage across runs.
      sql.exec('DROP TABLE IF EXISTS probe_rows').toArray();
      sql.exec('CREATE TABLE probe_rows (id INTEGER PRIMARY KEY, grp TEXT, val INTEGER)').toArray();
      // Secondary index — forces index maintenance on every write below.
      sql.exec('CREATE INDEX probe_rows_grp ON probe_rows (grp)').toArray();

      // Seed 5 rows (single statement, multi-VALUES — house rule allows one
      // statement per exec; a multi-row INSERT is still one statement).
      sql
        .exec("INSERT INTO probe_rows (id, grp, val) VALUES (1,'a',10),(2,'a',20),(3,'b',30),(4,'b',40),(5,'c',50)")
        .toArray();

      const results: Record<string, Measured> = {};

      // a. UPDATE matching 3 rows, rewriting the INDEXED column (grp) so index
      //    maintenance is maximally exercised.
      results.a_update3 = measure(sql, "UPDATE probe_rows SET grp = 'x' WHERE id IN (1,2,3)");

      // b. UPDATE matching 0 rows (fabricated-id shape — the live-incident case).
      results.b_update0 = measure(sql, 'UPDATE probe_rows SET val = 999 WHERE id = 9999');

      // c. DELETE matching 2 rows (removes table rows AND their index entries).
      results.c_delete2 = measure(sql, 'DELETE FROM probe_rows WHERE id IN (4,5)');

      // d. single-row INSERT (writes 1 table row + 1 index entry).
      results.d_insert1 = measure(sql, "INSERT INTO probe_rows (id, grp, val) VALUES (6,'d',60)");

      // e. multi-row INSERT, one statement, 3 VALUES tuples.
      results.e_insert3 = measure(sql, "INSERT INTO probe_rows (id, grp, val) VALUES (7,'e',70),(8,'e',80),(9,'f',90)");

      // Emit the raw probe table so the numbers are visible in test output.
      // eslint-disable-next-line no-console
      console.log('ROWS_WRITTEN_PROBE ' + JSON.stringify(results));

      // --- Ground truth: changes() is the logical affected-row count. ---
      expect(results.a_update3.changes).toBe(3);
      expect(results.b_update0.changes).toBe(0);
      expect(results.c_delete2.changes).toBe(2);
      expect(results.d_insert1.changes).toBe(1);
      expect(results.e_insert3.changes).toBe(3);

      // --- Observed rowsWritten (documents the inflation as ground truth). ---
      expect(results.a_update3.rowsWritten).toBe(6); // 3 table rows + 3 index entries
      expect(results.b_update0.rowsWritten).toBe(0); // no match → nothing written
      expect(results.c_delete2.rowsWritten).toBe(2); // index-entry removals not counted
      expect(results.d_insert1.rowsWritten).toBe(2); // 1 table row + 1 index entry
      expect(results.e_insert3.rowsWritten).toBe(6); // 3 table rows + 3 index entries

      // --- The load-bearing conclusions for the backport. ---
      // 1. rowsWritten DIVERGES from the logical count on indexed INSERT/UPDATE.
      expect(results.a_update3.rowsWritten).toBeGreaterThan(results.a_update3.changes);
      expect(results.d_insert1.rowsWritten).toBeGreaterThan(results.d_insert1.changes);
      expect(results.e_insert3.rowsWritten).toBeGreaterThan(results.e_insert3.changes);
      // 2. The zero case still coincides (so a 0-row WARNING keyed on either
      //    counter fires correctly), but changes() is the only accurate count.
      expect(results.b_update0.rowsWritten).toBe(0);
      expect(results.b_update0.changes).toBe(0);
    });
  });
});
