import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('serves /health through the Worker and Durable Object', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('404s unknown routes', async () => {
    const res = await SELF.fetch('https://example.com/nope');
    expect(res.status).toBe(404);
  });
});
