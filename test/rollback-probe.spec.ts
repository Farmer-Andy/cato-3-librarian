import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CatoAgent } from '../src/agent';

// ---------------------------------------------------------------------------
// PROBE (measurement, not a behavioural test of app code).
//
// Question: when a Durable Object event throws AFTER performing an outbound
// fetch, are SQL writes made BEFORE that fetch rolled back — or did the output
// gate durably commit them the moment the fetch left the isolate?
//
// Why it matters: the family's Telegram webhook handlers write state (dedup
// rows, approval flips) and then call the LLM (an outbound fetch) before
// sending the reply. If the reply send throws:
//   - writes ROLLED BACK  → Telegram redelivers, the dedup row is gone, the
//     turn re-runs cleanly (at-least-once).
//   - writes COMMITTED    → the dedup row survives, redelivery is skipped,
//     and the command is eaten with no reply (the exact failure mode the
//     Librarian's alarm-driven inbox exists to prevent).
// Two independent reviews asserted OPPOSITE answers. This probe measures what
// it can on real workerd.
//
// Method: three event deliveries against real DO SQLite, each throwing at a
// different point; a fresh event then checks which rows survived.
//   1. control:    INSERT, throw            (no outbound I/O)
//   2. post-fetch: INSERT, outbound fetch, throw
//   3. clean:      INSERT, return normally  (sanity: writes persist)
//
// MEASURED FINDING (snapshot below): ALL THREE rows survive — including the
// control. A throw from a runInDurableObject closure does NOT engage workerd's
// event-level reset/rollback machinery, so THIS HARNESS CANNOT measure the
// production rollback boundary. The probe is kept because that harness
// limitation is itself load-bearing: any future spec that "proves" rollback
// behavior via runInDurableObject is proving nothing.
//
// The production question is settled by the output-gate design instead: the
// gate flushes ALL pending writes before ANY outbound message leaves the
// isolate — and the reply send is itself an outbound message. By the time a
// Telegram sendMessage fetch departs, every prior write of the event (dedup
// rows included) is already durable; a throw on a failed send unwinds nothing,
// and a redelivered update hits the committed dedup row and is skipped. So on
// a synchronous webhook, throw-on-send-failure CANNOT provide at-least-once
// delivery; only a persisted queue drained outside the webhook event (the
// Librarian's telegram_updates inbox + alarm) can. Webhook callers must treat
// reply sends as best-effort; the throw exists for queue-drain callers whose
// retry machinery depends on it.
// ---------------------------------------------------------------------------

describe('probe: DO SQLite rollback vs outbound-fetch commit points', () => {
  it('measures which writes survive a thrown event', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('rollback-probe'));

    // Setup in its own (clean) event: table exists before any probing.
    await runInDurableObject(stub, async (_i: CatoAgent, state: DurableObjectState) => {
      state.storage.sql.exec('DROP TABLE IF EXISTS probe_rollback').toArray();
      state.storage.sql.exec('CREATE TABLE probe_rollback (tag TEXT PRIMARY KEY)').toArray();
    });

    // 1. control: write then throw, no outbound I/O.
    await runInDurableObject(stub, async (_i: CatoAgent, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO probe_rollback (tag) VALUES ('control')").toArray();
      throw new Error('probe: control throw');
    }).catch(() => {});

    // 2. post-fetch: write, real outbound fetch (crosses the output gate), throw.
    let fetchOk = false;
    await runInDurableObject(stub, async (_i: CatoAgent, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO probe_rollback (tag) VALUES ('post_fetch')").toArray();
      const res = await fetch('https://www.cloudflare.com/', { method: 'HEAD' });
      fetchOk = res.status > 0;
      throw new Error('probe: post-fetch throw');
    }).catch(() => {});

    // 3. clean: write and return normally.
    await runInDurableObject(stub, async (_i: CatoAgent, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO probe_rollback (tag) VALUES ('clean')").toArray();
    });

    // Fresh event: what survived?
    const survivors = await runInDurableObject(stub, async (_i: CatoAgent, state: DurableObjectState) => {
      return state.storage.sql
        .exec('SELECT tag FROM probe_rollback ORDER BY tag')
        .toArray()
        .map((r) => (r as { tag: string }).tag);
    });

    // eslint-disable-next-line no-console
    console.log('ROLLBACK_PROBE ' + JSON.stringify({ fetchOk, survivors }));

    // Sanity: the clean write persists. (fetchOk is not asserted so the suite
    // stays green offline; the survivors snapshot is identical either way
    // because the INSERT precedes the fetch attempt.)
    if (!fetchOk) {
      // eslint-disable-next-line no-console
      console.warn('ROLLBACK_PROBE: outbound fetch unavailable in this run');
    }
    expect(survivors).toContain('clean');

    // All three survive: runInDurableObject throws do not trigger event-level
    // rollback — see the header comment for what this does and does not prove.
    expect(survivors).toMatchSnapshot();
  });
});
