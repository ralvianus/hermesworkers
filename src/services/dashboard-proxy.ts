/**
 * Hostname-based reverse proxy for the native Hermes dashboard.
 *
 * The native dashboard ships its own React app + WebSocket on port 9119 inside
 * the container. Serving it under a dedicated hostname (rather than a path on
 * the main Worker route) lets all the dashboard's absolute URLs (`/static/*`,
 * `/v1/*`, `ws://.../ws`) resolve naturally — no HTML rewriting required.
 *
 * Wire-up:
 *   1. Set `DASHBOARD_HOSTNAME` in wrangler.toml (e.g. `hermes.example.com`).
 *   2. Add a matching Worker Route pointing to this Worker.
 *   3. Add a DNS record (proxied) for that hostname.
 *
 * See `docs/custom-domain.md` for a step-by-step.
 *
 * When no custom hostname is configured this module is a no-op — the Worker
 * keeps serving its API routes on the workers.dev URL.
 */

import { getContainer, collectProviderKeys, collectR2Durability, type Env } from '../lib/container';
import { bearerFromHeader, timingSafeEqualStr } from '../lib/auth';
import { isValidAccessJwt } from '../lib/access';
import {
  ensureGateway,
  HERMES_DASHBOARD_PORT,
} from './container-lifecycle';

const DASHBOARD_LOGIN_PATH = '/dashboard-login';

/**
 * Returns a Response when `request` targets the configured dashboard hostname,
 * or `null` if the request should fall through to the normal Hono router.
 */
export async function maybeHandleDashboard(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!env.DASHBOARD_HOSTNAME) return null;
  const url = new URL(request.url);
  if (url.hostname.toLowerCase() !== env.DASHBOARD_HOSTNAME.toLowerCase()) {
    return null;
  }

  // Fail closed: the dashboard fronts a GATEWAY_ALLOW_ALL_USERS Hermes, so
  // with no credential configured it must stay unreachable. Same opt-in as
  // the API routes.
  if (!env.API_TOKEN && env.ALLOW_UNAUTHENTICATED !== 'true') {
    return new Response(
      'API_TOKEN is not configured — the dashboard is disabled. Set it with `npm run secret -- put API_TOKEN`.',
      { status: 503 },
    );
  }

  // Browser login for the token gate: shows a minimal form and, on a valid
  // token, sets the hw_token cookie (HttpOnly) that the gate below accepts.
  // Browsers cannot send Authorization headers on normal navigation, so this
  // replaces the old "set the cookie via DevTools" flow.
  if (env.API_TOKEN && url.pathname === DASHBOARD_LOGIN_PATH) {
    return handleDashboardLogin(request, env);
  }

  // Token gate. Three accepted credentials, in order:
  //   1. A valid Cloudflare Access JWT — the edge injects this once the user
  //      has authenticated through the Zero Trust application in front of
  //      this hostname. This is the primary (SSO) path.
  //   2. The hw_token cookie (set by /dashboard-login).
  //   3. An Authorization: Bearer <API_TOKEN> header (curl / API clients).
  if (env.API_TOKEN) {
    const accessJwt = request.headers.get('cf-access-jwt-assertion');
    const accessOk = await isValidAccessJwt(
      accessJwt,
      env.ACCESS_TEAM_DOMAIN ?? '',
      env.ACCESS_AUD ?? '',
    );
    if (!accessOk) {
      const cookieToken = parseTokenCookie(request.headers.get('cookie') || '');
      const bearer = bearerFromHeader(request.headers.get('authorization'));
      const provided = cookieToken || bearer;
      if (!provided || !(await timingSafeEqualStr(provided, env.API_TOKEN))) {
        // Browsers get bounced to the login form; anything else gets a 401.
        const isBrowserNavigation =
          request.method === 'GET' &&
          (request.headers.get('accept') || '').includes('text/html') &&
          (request.headers.get('upgrade') || '') === '';
        if (isBrowserNavigation) {
          return Response.redirect(`${url.origin}${DASHBOARD_LOGIN_PATH}`, 302);
        }
        return new Response('Unauthorized', { status: 401 });
      }
    }
  } else {
    // API_TOKEN unset with ALLOW_UNAUTHENTICATED=true — explicitly opted-in
    // open mode. Loud warning: the dashboard fronts the full Hermes session.
    console.warn(
      '[dashboard] API_TOKEN is not set — the dashboard is PUBLIC (ALLOW_UNAUTHENTICATED).',
    );
  }

  const container = getContainer(env);
  try {
    await ensureGateway(container, {
      providerKeys: collectProviderKeys(env),
      gatewayToken: env.HERMES_GATEWAY_TOKEN,
      defaultModel: env.HERMES_DEFAULT_MODEL,
      r2: collectR2Durability(env),
    });
  } catch (err) {
    return new Response(
      `Container not ready: ${err instanceof Error ? err.message : String(err)}`,
      { status: 503 },
    );
  }

  // Forward request 1:1 to the dashboard port inside the container.
  // The Sandbox SDK's containerFetch preserves WebSocket upgrades, which the
  // dashboard's live chat tab relies on.
  const isWebSocket =
    (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';

  const targetUrl = `http://localhost:${HERMES_DASHBOARD_PORT}${url.pathname}${url.search}`;
  const targetReq = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });

  let response: Response;
  try {
    response = await (container as any).containerFetch(
      targetReq,
      HERMES_DASHBOARD_PORT,
    );
  } catch (err) {
    return new Response(
      `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502 },
    );
  }

  // WebSocket responses already have the upgrade socket attached.
  if (isWebSocket) return response;

  return response;
}

function parseTokenCookie(cookieHeader: string): string {
  const match = cookieHeader.match(/hw_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * GET  /dashboard-login — render the token form.
 * POST /dashboard-login — verify the token (constant-time), set the
 * `hw_token` cookie (HttpOnly + Secure, 30 days) and redirect to /.
 */
async function handleDashboardLogin(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    return loginPage();
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const form = await request.formData();
  const provided = String(form.get('token') || '');
  const expected = env.API_TOKEN ?? '';
  if (!provided || !(await timingSafeEqualStr(provided, expected))) {
    return loginPage('Invalid token.');
  }

  return new Response(null, {
    status: 302,
    headers: {
      'set-cookie': `hw_token=${expected}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      location: '/',
    },
  });
}

function loginPage(error?: string): Response {
  const errorHtml = error ? `<p class="error">${error}</p>` : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hermesworkers — dashboard login</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  form { background: #23233b; padding: 2rem; border-radius: 8px; width: 22rem; }
  h1 { font-size: 1.1rem; margin: 0 0 1.5rem; }
  input { width: 100%; box-sizing: border-box; padding: .6rem; border-radius: 4px;
          border: 1px solid #444; background: #1a1a2e; color: #eee; }
  button { margin-top: 1rem; width: 100%; padding: .6rem; border: 0;
           border-radius: 4px; background: #f6821f; color: #1a1a2e;
           font-weight: 700; cursor: pointer; }
  .error { color: #ff8f8f; }
</style>
</head>
<body>
<form method="post" action="${DASHBOARD_LOGIN_PATH}">
  <h1>Hermes dashboard login</h1>
  ${errorHtml}
  <input type="password" name="token" placeholder="API token" autofocus autocomplete="off">
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
