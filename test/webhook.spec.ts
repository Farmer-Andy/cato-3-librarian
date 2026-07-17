import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

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

  it('forwards an authenticated admin command to the agent', async () => {
    const res = await SELF.fetch('https://example.com/webhook/telegram', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': await deriveSecret(env.ADMIN_TOKEN) },
      body: adminUpdate('/models'),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // /models replies via the Telegram API — proof the command surface was reached.
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].url).toContain('sendMessage');
  });

  it('fails closed when ADMIN_TOKEN is unset', async () => {
    const bare = { ...env, ADMIN_TOKEN: '' } as Env;
    const res = await worker.fetch(
      new Request('https://example.com/webhook/telegram', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': await deriveSecret('') },
        body: adminUpdate('/models'),
      }),
      bare
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
