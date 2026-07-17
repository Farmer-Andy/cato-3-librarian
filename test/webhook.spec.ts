import { createExecutionContext, env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { CatoAgent } from '../src/agent';
import type { Env } from '../src/types';
import { clearInbox } from './helpers';

type AgentAlarm = { alarm(): Promise<void> };

// Same derivation as src/index.ts webhookSecret().
async function deriveSecret(adminToken: string): Promise<string> {
  const data = new TextEncoder().encode(`telegram-webhook:${adminToken}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function adminUpdate(text: string): string {
  const adminId = Number(env.ADMIN_TELEGRAM_ID);
  return JSON.stringify({ message: { from: { id: adminId }, chat: { id: adminId }, text } });
}

// The main worker (and its DO) run in the same isolate as tests, so stubbing
// global fetch intercepts their outbound Telegram API calls.
let telegramCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  telegramCalls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.telegram.org/')) {
      const raw = init?.body ? String(init.body) : await (input as Request).clone().text();
      telegramCalls.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
      return Response.json({ ok: true, result: true });
    }
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /webhook/telegram authentication', () => {
  it('rejects a forged admin payload with no secret header (the audit attack)', async () => {
    const res = await SELF.fetch('https://example.com/webhook/telegram', {
      method: 'POST',
      body: adminUpdate('/models'),
    });
    expect(res.status).toBe(401);
    expect(telegramCalls).toHaveLength(0);
  });

  it('rejects a wrong secret header', async () => {
    const res = await SELF.fetch('https://example.com/webhook/telegram', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'not-the-secret' },
      body: adminUpdate('/models'),
    });
    expect(res.status).toBe(401);
  });

  it('authenticates before parsing: valid secret + malformed JSON is 400, not 401', async () => {
    const res = await SELF.fetch('https://example.com/webhook/telegram', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': await deriveSecret(env.ADMIN_TOKEN) },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('silently drops non-admin senders after valid auth', async () => {
    const res = await SELF.fetch('https://example.com/webhook/telegram', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': await deriveSecret(env.ADMIN_TOKEN) },
      body: JSON.stringify({ message: { from: { id: 999999 }, chat: { id: 999999 }, text: 'hi' } }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(telegramCalls).toHaveLength(0);
  });

  it('enqueues the admin command and ACKs an empty 200 with no synchronous LLM/Telegram work; the alarm drains it', async () => {
    // The webhook now only enqueues: it dedups + writes an inbox row and returns
    // fast, doing no LLM work and sending no Telegram message on the request path.
    // The DO's alarm() drains the inbox and delivers the reply out-of-band. This is
    // the fix for the ~30s waitUntil cancellation that could kill long turns.
    await clearInbox('cato3-primary');
    const adminId = Number(env.ADMIN_TELEGRAM_ID);
    const updateId = 910001;
    const res = await SELF.fetch('https://example.com/webhook/telegram', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': await deriveSecret(env.ADMIN_TOKEN) },
      body: JSON.stringify({
        update_id: updateId,
        message: { from: { id: adminId }, chat: { id: adminId }, text: '/models' },
      }),
    });
    // Snapshot the Telegram-call count synchronously at ACK, before any await lets
    // the harness auto-deliver the now-alarm. The webhook did no Telegram work on
    // the request path — it only enqueued.
    const telegramAtAck = telegramCalls.length;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(telegramAtAck).toBe(0);

    // The update was written to the inbox for the alarm to drain. Then drop the
    // auto-armed alarm and drain deterministically (idempotent if the harness
    // already auto-fired it): the /models reply is delivered and the row is done.
    const stub = env.CATO_AGENT.get(env.CATO_AGENT.idFromName('cato3-primary'));
    const enqueuedRow = await runInDurableObject(stub, async (instance: CatoAgent, state: DurableObjectState) => {
      const row = state.storage.sql
        .exec('SELECT update_id FROM telegram_updates WHERE update_id = ?', updateId)
        .toArray();
      await state.storage.deleteAlarm();
      await (instance as unknown as AgentAlarm).alarm();
      return row;
    });
    expect(enqueuedRow).toHaveLength(1);
    expect(telegramCalls.some((c) => c.url.includes('sendMessage'))).toBe(true);

    const done = await runInDurableObject(stub, async (_i: CatoAgent, state: DurableObjectState) =>
      state.storage.sql.exec('SELECT status FROM telegram_updates WHERE update_id = ?', updateId).toArray(),
    );
    expect(done[0]['status']).toBe('done');
  });

  it('fails closed when ADMIN_TOKEN is unset', async () => {
    const bare = { ...env, ADMIN_TOKEN: '' } as Env;
    const res = await worker.fetch(
      new Request('https://example.com/webhook/telegram', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': await deriveSecret('') },
        body: adminUpdate('/models'),
      }),
      bare,
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /setup/webhook', () => {
  it('registers the derived secret_token with Telegram', async () => {
    const res = await SELF.fetch('https://example.com/setup/webhook', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);

    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].url).toContain('setWebhook');
    expect(telegramCalls[0].body['url']).toBe('https://example.com/webhook/telegram');
    expect(telegramCalls[0].body['secret_token']).toBe(await deriveSecret(env.ADMIN_TOKEN));
  });

  it('requires admin auth', async () => {
    const res = await SELF.fetch('https://example.com/setup/webhook', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(telegramCalls).toHaveLength(0);
  });
});
