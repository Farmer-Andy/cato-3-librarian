import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CatoAgent } from '../src/agent';

type AgentInternals = {
  initialize(): Promise<void>;
  refreshManifest(): Promise<void>;
  getManifest(): Promise<string>;
};

describe('schema manifest — hostile identifier quoting (real DO)', () => {
  it('regenerates without throwing when a table name contains a space and a quote', async () => {
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('manifest-hostile'));
    await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const internals = instance as unknown as AgentInternals;
      await internals.initialize();

      // The literal "weird ""name" denotes the identifier: weird "name — it has a
      // space AND an embedded double quote. An unquoted PRAGMA interpolation would
      // throw here and (in production) brick boot, since manifest generation runs
      // during initialize(). Drop-first: pool persists DO storage across runs.
      state.storage.sql.exec('DROP TABLE IF EXISTS "weird ""name"').toArray();
      state.storage.sql.exec('CREATE TABLE "weird ""name" (id INTEGER)').toArray();

      try {
        // Trigger regeneration; must not throw on the hostile name.
        await internals.refreshManifest();
        const manifest = await internals.getManifest();
        expect(manifest).toContain('weird "name');
      } finally {
        // Clean up so the persisted DO storage stays tidy for later runs.
        state.storage.sql.exec('DROP TABLE IF EXISTS "weird ""name"').toArray();
        await internals.refreshManifest();
      }
    });
  });
});
