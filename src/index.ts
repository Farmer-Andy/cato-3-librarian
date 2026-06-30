import { CatoAgent } from './agent';
import type { Env, Actor } from './types';

export { CatoAgent };

function getAgent(env: Env): DurableObjectStub {
  const id = env.CATO_AGENT.idFromName('cato3-primary');
  return env.CATO_AGENT.get(id);
}

async function forwardToAgent(
  agent: DurableObjectStub,
  path: string,
  request: Request,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const [k, v] of Object.entries(extraHeaders ?? {})) {
    headers.set(k, v);
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const forwarded = new Request(`https://agent.internal${path}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
  });
  return agent.fetch(forwarded);
}

function resolveActorFromTelegram(body: TelegramUpdate, env: Env): Actor {
  const userId = body.message?.from?.id ?? body.edited_message?.from?.id;
  if (!userId) return { id: 'telegram:unknown', role: 'user' };
  const id = `telegram:${userId}`;
  const role = String(userId) === env.ADMIN_TELEGRAM_ID ? 'admin' : 'user';
  return { id, role };
}

// Length-independent equality on the matched bytes, to avoid leaking the token
// through response timing on a per-character compare.
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

// Admin HTTP auth: a shared-secret bearer token checked against env.ADMIN_TOKEN.
// Fail-closed: if ADMIN_TOKEN is unset, no request can authenticate, so the
// admin surface stays closed rather than opening up.
function isAuthorizedAdmin(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = request.headers.get('Authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return timingSafeEqual(match[1], expected);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const agent = getAgent(env);

    // Health — available to anyone
    if (request.method === 'GET' && url.pathname === '/health') {
      return forwardToAgent(agent, '/health', request);
    }

    // Telegram webhook — actor resolved from payload
    if (request.method === 'POST' && url.pathname === '/webhook/telegram') {
      let body: TelegramUpdate;
      try {
        const raw = await request.arrayBuffer();
        body = JSON.parse(new TextDecoder().decode(raw)) as TelegramUpdate;
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      const actor = resolveActorFromTelegram(body, env);

      // Non-admin users: silently drop — no response, no DO call
      if (actor.role !== 'admin') {
        return new Response('', { status: 200 });
      }

      // Reconstruct request with original body for forwarding
      const headers = new Headers(request.headers);
      headers.set('X-Cato-Actor', actor.id);
      headers.set('X-Cato-Role', actor.role);
      const forwarded = new Request('https://agent.internal/telegram', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
      });
      return agent.fetch(forwarded);
    }

    // Admin-only HTTP surface: privileged read / exec / mutate endpoints.
    // Auth is a shared-secret bearer token: `Authorization: Bearer <ADMIN_TOKEN>`.
    // Fail-closed: if env.ADMIN_TOKEN is unset, every admin route denies with 401.
    // An unconfigured deployment exposes nothing here beyond /health.
    const approvePath = url.pathname.match(/^\/(approve|deny)\/(.+)$/);
    const isAdminRoute =
      (request.method === 'GET' && url.pathname === '/manifest') ||
      (request.method === 'POST' && url.pathname === '/invoke') ||
      (request.method === 'POST' && url.pathname === '/eval/run') ||
      (request.method === 'GET' && url.pathname === '/eval/runs') ||
      (request.method === 'POST' && url.pathname === '/setup/webhook') ||
      (request.method === 'POST' && approvePath !== null);

    if (isAdminRoute && !isAuthorizedAdmin(request, env)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const adminActor: Actor = { id: 'http:admin', role: 'admin' };

    if (request.method === 'GET' && url.pathname === '/manifest') {
      return forwardToAgent(agent, '/manifest', request, {
        'X-Cato-Actor': adminActor.id,
        'X-Cato-Role': adminActor.role,
      });
    }

    if (request.method === 'POST' && url.pathname === '/invoke') {
      return forwardToAgent(agent, '/invoke', request, {
        'X-Cato-Actor': adminActor.id,
        'X-Cato-Role': adminActor.role,
      });
    }

    if (request.method === 'POST' && url.pathname === '/eval/run') {
      return forwardToAgent(agent, '/eval/run', request, {
        'X-Cato-Actor': adminActor.id,
        'X-Cato-Role': adminActor.role,
      });
    }

    if (request.method === 'GET' && url.pathname === '/eval/runs') {
      return forwardToAgent(agent, '/eval/runs', request, {
        'X-Cato-Actor': adminActor.id,
        'X-Cato-Role': adminActor.role,
      });
    }

    // /approve/:id and /deny/:id
    if (request.method === 'POST' && approvePath) {
      return forwardToAgent(agent, url.pathname, request, {
        'X-Cato-Actor': adminActor.id,
        'X-Cato-Role': adminActor.role,
      });
    }

    // One-time webhook registration — safe to call multiple times (idempotent)
    if (request.method === 'POST' && url.pathname === '/setup/webhook') {
      const webhookUrl = `${url.origin}/webhook/telegram`;
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'edited_message'] }),
        }
      );
      const data = await res.json();
      return Response.json(data);
    }

    return new Response(null, { status: 404 });
  },
};

interface TelegramUpdate {
  message?: { from?: { id: number }; chat?: { id: number }; text?: string };
  edited_message?: { from?: { id: number }; chat?: { id: number }; text?: string };
}
