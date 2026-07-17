import { env, runInDurableObject } from 'cloudflare:test';
import { vi } from 'vitest';
import type { CatoAgent } from '../src/agent';

// Same derivation as src/index.ts webhookSecret().
export async function deriveSecret(adminToken: string): Promise<string> {
  const data = new TextEncoder().encode(`telegram-webhook:${adminToken}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function adminUpdate(text: string): string {
  const adminId = Number(env.ADMIN_TELEGRAM_ID);
  return JSON.stringify({ message: { from: { id: adminId }, chat: { id: adminId }, text } });
}

export interface TelegramCall {
  url: string;
  body: Record<string, unknown>;
}

// pool-workers persists DO storage across test runs, and update_ids are reused
// across runs, so a re-run's "first delivery" would collide with a leftover row
// and be treated as a duplicate. Clear the inbox (and, optionally, event_log) for
// a DO before a test that inserts a known update_id and inspects the result.
export async function clearInbox(name = 'cato3-primary', alsoEventLog = false): Promise<void> {
  const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName(name));
  await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
    await (instance as unknown as { initialize(): Promise<void> }).initialize();
    state.storage.sql.exec('DELETE FROM telegram_updates').toArray();
    if (alsoEventLog) state.storage.sql.exec('DELETE FROM event_log').toArray();
  });
}

// The main worker (and its DO) run in the same isolate as tests, so stubbing
// global fetch intercepts their outbound Telegram API calls. Any other outbound
// fetch fails the test. Call vi.unstubAllGlobals() in afterEach.
export function stubTelegramFetch(): TelegramCall[] {
  const calls: TelegramCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.telegram.org/')) {
      const raw = init?.body ? String(init.body) : await (input as Request).clone().text();
      calls.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
      return Response.json({ ok: true, result: true });
    }
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
  return calls;
}
