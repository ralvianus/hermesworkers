import { Hono } from 'hono';
import type { Env } from './lib/container';
import { bearerFromHeader, timingSafeEqualStr } from './lib/auth';
import { chat } from './routes/chat';
import { instance } from './routes/instance';
import { maybeHandleDashboard } from './services/dashboard-proxy';

export { HermesInstance } from './hermesContainer';

const app = new Hono<{ Bindings: Env }>();

// Bearer-token gate on every /api/* and /v1/* request. Fails closed: with
// API_TOKEN unset, requests are rejected with 503 unless the deployment
// explicitly opts in with ALLOW_UNAUTHENTICATED=true (local dev only).
app.use('/v1/*', requireToken);
app.use('/api/*', requireToken);

app.route('/', chat);
app.route('/', instance);

app.get('/', (c) =>
  c.json({
    name: 'hermesworkers',
    description: 'Hermes Agent on Cloudflare Sandbox',
    endpoints: {
      health: 'GET /api/health',
      chat: 'POST /v1/chat/completions',
      wake: 'POST /api/instance/wake',
      restart: 'POST /api/instance/restart',
      restartGateway: 'POST /api/instance/restart-gateway',
      stop: 'POST /api/instance/stop',
      backup: 'POST /api/instance/backup',
      logs: 'GET /api/instance/logs',
    },
    docs: 'https://github.com/ralvianus/hermesworkers',
  }),
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Hostname-based dashboard proxy takes precedence over the Hono router so
    // every path under DASHBOARD_HOSTNAME hits the native Hermes web UI.
    const dashboardResponse = await maybeHandleDashboard(request, env);
    if (dashboardResponse) return dashboardResponse;

    return app.fetch(request, env, ctx);
  },
};

async function requireToken(c: any, next: any) {
  const expected = c.env.API_TOKEN;
  if (!expected) {
    // Fail closed: with no credential configured the Worker must not serve
    // traffic. Opt back in explicitly (local dev only) via the var.
    if (c.env.ALLOW_UNAUTHENTICATED !== 'true') {
      console.error(
        '[auth] rejected request: API_TOKEN is not set. Set it with `npm run secret -- put API_TOKEN`.',
      );
      return c.json(
        {
          error: 'api_token_not_set',
          message:
            'API_TOKEN is not configured — all /api/* and /v1/* endpoints are disabled. Set it with `npm run secret -- put API_TOKEN`.',
        },
        503,
      );
    }
    console.warn(
      '[auth] API_TOKEN is not set and ALLOW_UNAUTHENTICATED=true — all /api/* and /v1/* endpoints are PUBLIC.',
    );
    return next();
  }
  const bearer = bearerFromHeader(c.req.header('authorization'));
  if (!bearer || !(await timingSafeEqualStr(bearer, expected))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
}
