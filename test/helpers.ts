import { env } from 'cloudflare:test';
import { vi } from 'vitest';

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
