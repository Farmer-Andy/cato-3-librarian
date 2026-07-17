import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Defense-in-depth guard for the X-Cato-Actor / X-Cato-Role trust headers.
//
// forwardToAgent() strips any inbound X-Cato-* headers before applying the
// Worker's authenticated overrides, so a client cannot inject an actor/role on a
// forwarded route that does not re-set them (today only /health).
//
// HONEST NOTE ON WHAT THIS PROVES: /health ignores role entirely, so it returns
// the same payload with or without the strip. This test therefore does NOT fail
// if the strip is removed — no route exposes role-dependent behavior without also
// overriding the headers, which is exactly why this hardening is defense-in-depth
// with no exploitable route today. The assertion below is a behavioral guard that
// a spoofed X-Cato-Role opens no privilege path on the one header-passthrough
// route, not direct proof that the strip executes.
describe('trust-header injection (defense in depth)', () => {
  it('a client-supplied X-Cato-Role: admin does not alter the /health response', async () => {
    const res = await SELF.fetch('https://example.com/health', {
      headers: { 'X-Cato-Role': 'admin', 'X-Cato-Actor': 'attacker:9999' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});
