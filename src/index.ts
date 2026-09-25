import { Hono } from 'hono';
import type { Env } from './lib/container';
import { bearerFromHeader, timingSafeEqualStr } from './lib/auth';
import { chat } from './routes/chat';
import { instance } from './routes/instance';
import { maybeHandleDashboard } from './services/dashboard-proxy';

export { HermesInstance } from './hermesContainer';

const app = new Hono<{ Bindings: Env }>();

// Optional bearer-token gate on every /api/* and /v1/* request.
// If API_TOKEN is left unset (single-machine dev), the Worker is open.
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
    // No token configured — open Worker (single-machine / private deployment).
    // Warn loudly: every endpoint below is reachable by anyone with the URL.
    console.warn(
      '[auth] API_TOKEN is not set — all /api/* and /v1/* endpoints are PUBLIC.',
    );
    return next();
  }
  const bearer = bearerFromHeader(c.req.header('authorization'));
  if (!bearer || !(await timingSafeEqualStr(bearer, expected))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
}
