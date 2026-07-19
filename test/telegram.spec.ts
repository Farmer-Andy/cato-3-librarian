import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTelegramMessage } from '../src/telegram';

// A recognizable secret so tests can assert it never leaks into an error.
const TOKEN = 'secret-bot-token-abc123';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

// Repo convention is vi.stubGlobal('fetch', ...) (see test/helpers.ts). This
// version of @cloudflare/vitest-pool-workers (0.18.6) does not export `fetchMock`
// from cloudflare:test — only the MockAgent type is declared — so we stub the
// global fetch that sendTelegramMessage calls. `responder` returns the Response
// for the Nth outbound call (1-indexed), letting us script per-call failures.
function stubFetch(responder: (callNumber: number) => Response): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body ? String(init.body) : '';
    calls.push({ url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
    return responder(calls.length);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('sendTelegramMessage', () => {
  it('first attempt ok → one call, no throw', async () => {
    const calls = stubFetch(() => Response.json({ ok: true, result: true }));
    await expect(sendTelegramMessage(TOKEN, 111, 'hello')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].body['parse_mode']).toBe('HTML');
  });

  it('first fails, fallback ok → two calls, no throw', async () => {
    const calls = stubFetch((n) =>
      n === 1 ? new Response('bad html', { status: 400 }) : Response.json({ ok: true, result: true })
    );
    await expect(sendTelegramMessage(TOKEN, 111, 'hi')).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    // First carries parse_mode: HTML; the fallback drops it.
    expect(calls[0].body['parse_mode']).toBe('HTML');
    expect(calls[1].body['parse_mode']).toBeUndefined();
  });

  it('both fail → throws with status but never the token or URL', async () => {
    const calls = stubFetch(() =>
      new Response('{"ok":false,"error_code":403,"description":"Bad Request: chat not found"}', { status: 403 })
    );
    let err: Error | undefined;
    try {
      await sendTelegramMessage(TOKEN, 111, 'hi');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(calls).toHaveLength(2); // HTML attempt + fallback, both failed
    expect(err!.message).toContain('403');
    // The bot token, the API URL, and the /bot path must never surface.
    expect(err!.message).not.toContain(TOKEN);
    expect(err!.message).not.toContain('api.telegram.org');
    expect(err!.message).not.toContain('/bot');
  });

  it('multi-chunk message (>4000 chars) sends one request per chunk', async () => {
    const calls = stubFetch(() => Response.json({ ok: true, result: true }));
    // Two newline-separated blocks; splitMessage cuts at the newline into 2 chunks.
    const blockA = 'a'.repeat(3000);
    const blockB = 'b'.repeat(3000);
    await sendTelegramMessage(TOKEN, 111, `${blockA}\n${blockB}`);
    expect(calls).toHaveLength(2);
    expect(String(calls[0].body['text']).startsWith('a')).toBe(true);
    expect(String(calls[1].body['text']).startsWith('b')).toBe(true);
  });
});
