/**
 * Container lifecycle helpers for the Hermes Sandbox container.
 *
 * Every container interaction goes through the Sandbox SDK methods
 * (`startProcess`, `listProcesses`, `exec`, `containerFetch`) — there
 * is no business logic inside the DO class itself.
 *
 * This mirrors the pattern documented by Cloudflare's moltworker reference
 * implementation: keep the DO class minimal, treat it like a remote shell.
 */

import type { R2Durability } from '../lib/container';
import type { BackupHandle, BackupState } from '../hermesContainer';
import { redactSecrets } from '../lib/redact';

const STARTUP_SCRIPT = '/usr/local/bin/start-hermes.sh';
const API_PORT = 18789;
const DASHBOARD_PORT = 9119;

// ─── R2 state durability ────────────────────────────────────────────
// Bucket layout (see docs/plans/r2-durability-plan.md):
//   memories/<file>   — s3fs-mounted at ~/.hermes/memories (live)
//   backups/<id>/...  — squashfs snapshots of ~/.hermes
const HERMES_HOME = '/home/hermes/.hermes';
const MEMORIES_DIR = `${HERMES_HOME}/memories`;
const MEMORIES_PREFIX = '/memories/';
const MEMORIES_SEED_DIR = '/tmp/hermes-mem-seed';
const BACKUP_PREFIX = '/backups/';
const RESTORE_MOUNT = '/mnt/hermes-restore';
const BACKUP_TTL_SEC = 30 * 24 * 60 * 60; // 30 days — covers long quiet periods

// The container can take a few minutes to wake up from sleep on `standard-1`.
// Allow generous headroom so first-request after sleep doesn't time out.
const STARTUP_TIMEOUT_MS = 300_000;

export const HERMES_API_PORT = API_PORT;
export const HERMES_DASHBOARD_PORT = DASHBOARD_PORT;

// ─── Port probes ────────────────────────────────────────────────────

/**
 * Returns true if `localhost:<port>` is accepting TCP connections inside
 * the container. Uses bash's built-in `/dev/tcp` (no external binary needed)
 * with a netcat fallback for older base images.
 */
export async function isPortOpen(
  container: DurableObjectStub,
  port: number = API_PORT,
): Promise<boolean> {
  try {
    const result = await (container as any).exec(
      `bash -c 'timeout 1 bash -c "</dev/tcp/localhost/${port}" 2>/dev/null' || nc -z localhost ${port} 2>/dev/null`,
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ─── Process management ────────────────────────────────────────────

/**
 * Locate the running `hermes gateway` process tracked by the Sandbox SDK.
 * Returns null when no matching process exists.
 */
async function findGatewayProcess(container: DurableObjectStub): Promise<any | null> {
  try {
    const processes = await (container as any).listProcesses();
    for (const proc of processes) {
      const cmd: string = proc.command || '';
      const isGateway =
        cmd.includes('start-hermes.sh') || cmd.includes('hermes gateway');
      if (isGateway && (proc.status === 'running' || proc.status === 'starting')) {
        return proc;
      }
    }
  } catch (e) {
    console.warn('[container-lifecycle] listProcesses failed:', e);
  }
  return null;
}

/**
 * Kill any running Hermes gateway process and clean up its lock files.
 *
 * Hermes forks worker processes that don't always die with the tracked PID,
 * so we hit them with both SIGTERM (graceful, lets state persist to disk)
 * and SIGKILL via `pgrep`/`pkill` for anything still listening on the port.
 */
export async function killGateway(container: DurableObjectStub): Promise<void> {
  // Graceful shutdown
  try {
    await (container as any).exec(
      [
        'kill -TERM $(pgrep -f "hermes gateway" 2>/dev/null) 2>/dev/null',
        'kill -TERM $(pgrep -f "hermes dashboard" 2>/dev/null) 2>/dev/null',
        'true',
      ].join('; '),
    );
  } catch {
    /* process may already be gone */
  }
  await new Promise((r) => setTimeout(r, 3000));

  // Force kill anything still listening on our ports
  try {
    await (container as any).exec(
      [
        'kill -9 $(pgrep -f "hermes gateway" 2>/dev/null) 2>/dev/null',
        'kill -9 $(pgrep -f "hermes dashboard" 2>/dev/null) 2>/dev/null',
        `kill -9 $(ss -tlnp sport = :${API_PORT} 2>/dev/null | grep -oP "pid=\\K[0-9]+") 2>/dev/null`,
        `kill -9 $(ss -tlnp sport = :${DASHBOARD_PORT} 2>/dev/null | grep -oP "pid=\\K[0-9]+") 2>/dev/null`,
        'true',
      ].join('; '),
    );
  } catch {
    /* process may already be gone */
  }

  // Also kill via the tracked-process API in case it's still registered.
  const proc = await findGatewayProcess(container);
  if (proc) {
    try {
      await proc.kill();
    } catch {
      /* may already be dead */
    }
  }

  await new Promise((r) => setTimeout(r, 1000));
}

// ─── R2 durability: memory mount ────────────────────────────────────

function isLocalDev(): boolean {
  // `wrangler dev` sets NODE_ENV=development in the local runtime; the
  // production runtime leaves it unset.
  return process.env.NODE_ENV === 'development';
}

/**
 * True when the s3fs memories mount is present AND serving I/O. A mount that
 * exists in /proc/mounts but hangs (stale TCP after a container
 * checkpoint/restore cycle) is NOT healthy — the ls probe catches it.
 */
async function mountHealthy(container: DurableObjectStub): Promise<boolean> {
  try {
    const probe = await (container as any).exec(
      `grep -q " ${MEMORIES_DIR} " /proc/mounts 2>/dev/null && timeout 5 ls ${MEMORIES_DIR} >/dev/null 2>&1`,
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

async function mountMemories(
  container: DurableObjectStub,
  r2: R2Durability,
): Promise<void> {
  if (isLocalDev()) {
    await (container as any).mountBucket('BACKUP_BUCKET', MEMORIES_DIR, {
      localBucket: true,
      prefix: MEMORIES_PREFIX,
    });
  } else {
    await (container as any).mountBucket(r2.bucketName, MEMORIES_DIR, {
      endpoint: r2.endpoint,
      provider: 'r2',
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
      prefix: MEMORIES_PREFIX,
    });
  }
}

/**
 * Ensure the R2 bucket's memories/ prefix is mounted at ~/.hermes/memories
 * and actually serving I/O. Runs on EVERY gateway ensure — including the
 * wake fast path — because an s3fs process does not keep usable R2
 * connections across a container checkpoint/restore cycle: a mount that
 * exists but hangs must be remounted, not trusted.
 *
 * Upgrade bootstrap: local memory files are staged before the mount overlays
 * the directory, then seeded through the mount when the bucket does not have
 * them — so an existing deployment that enables R2 durability does not lose
 * its memories behind the empty mount.
 *
 * Fails closed: throws on mount failure so chat is never served with memory
 * writes silently landing on ephemeral disk.
 */
export async function ensureMemoryMount(
  container: DurableObjectStub,
  r2: R2Durability,
): Promise<void> {
  if (await mountHealthy(container)) return;

  // Stage any pre-existing local memory files before the mount overlays the
  // directory. On the first mount of an upgraded deployment these are the
  // only copies (the bucket is still empty). The timeout guards against a
  // wedged mount hanging the copy.
  await (container as any).exec(
    `rm -rf ${MEMORIES_SEED_DIR} && timeout 5 cp -a ${MEMORIES_DIR} ${MEMORIES_SEED_DIR} 2>/dev/null || true`,
  );

  // Not mounted, or mounted but wedged. Clear any stale registration first
  // (unmount errors are expected on a fully absent mount), then mount fresh.
  try {
    await (container as any).unmountBucket(MEMORIES_DIR);
  } catch {
    /* not mounted — expected */
  }
  await (container as any).exec(`mkdir -p ${MEMORIES_DIR}`);
  await mountMemories(container, r2);

  // Seed: when the bucket lacks a memory file that existed locally before
  // the mount, copy it through the mount so nothing is lost behind it.
  // The ! -L guards refuse to follow symlinks — a planted
  // memories/MEMORY.md -> ../.env would otherwise upload the secret into
  // the bucket.
  await (container as any).exec(
    [
      `if [ -f ${MEMORIES_SEED_DIR}/MEMORY.md ] && [ ! -L ${MEMORIES_SEED_DIR}/MEMORY.md ] && [ ! -f ${MEMORIES_DIR}/MEMORY.md ]; then cp ${MEMORIES_SEED_DIR}/MEMORY.md ${MEMORIES_DIR}/; fi`,
      `if [ -f ${MEMORIES_SEED_DIR}/USER.md ] && [ ! -L ${MEMORIES_SEED_DIR}/USER.md ] && [ ! -f ${MEMORIES_DIR}/USER.md ]; then cp ${MEMORIES_SEED_DIR}/USER.md ${MEMORIES_DIR}/; fi`,
      `rm -rf ${MEMORIES_SEED_DIR}`,
      'true',
    ].join('; '),
  );

  if (!(await mountHealthy(container))) {
    throw new Error(
      `R2 memories mount was established but failed its I/O health probe (${MEMORIES_DIR} not readable)`,
    );
  }
}

// ─── R2 durability: restore on instance replacement ─────────────────

/**
 * Cold boots only: sleep/wake restores /home via the Sandbox snapshot, and
 * an instance replacement starts with an empty disk (ephemeral). When
 * state.db is missing but a backup handle exists in DO storage, restore it
 * before the gateway writes to a fresh home.
 *
 * The backup archive is copied out through a temporary read-only mount of
 * the backups/ prefix, so no archive bytes transit the Worker. `.env` is
 * never restored (excluded from backups) — the boot script re-materialises
 * it from Worker secrets on every boot.
 */
export async function ensureRestored(
  container: DurableObjectStub,
  r2: R2Durability,
): Promise<'restored' | 'skipped'> {
  const state = await (container as any).exec(`test -f ${HERMES_HOME}/state.db`);
  if (state.exitCode === 0) return 'skipped';

  const backupState: BackupState | null = await (container as any).getBackupState();
  const handles = [backupState?.latest, backupState?.previous].filter(
    (h): h is BackupHandle => !!h,
  );
  if (handles.length === 0) return 'skipped'; // first deployment — nothing to restore

  for (const handle of handles) {
    try {
      await restoreHandle(container, r2, handle);
      console.log(`[r2-restore] restored ~/.hermes from backup ${handle.id}`);
      return 'restored';
    } catch (err) {
      console.error(`[r2-restore] generation ${handle.id} failed:`, err);
    }
  }
  // Every generation failed — fail closed rather than booting an empty home
  // that the next backup would persist over the last good one.
  throw new Error('R2 state restore failed for all backup generations');
}

/** Same UUID shape the Sandbox SDK enforces for backup ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function restoreHandle(
  container: DurableObjectStub,
  r2: R2Durability,
  handle: BackupHandle,
): Promise<void> {
  // Defense-in-depth: the id comes from DO storage, but validate it anyway —
  // a corrupted value must never reach a shell string or a filesystem path.
  if (!UUID_RE.test(handle.id)) {
    throw new Error('invalid backup handle id (not a UUID)');
  }
  try {
    await (container as any).unmountBucket(RESTORE_MOUNT);
  } catch {
    /* expected when absent */
  }
  if (isLocalDev()) {
    await (container as any).mountBucket('BACKUP_BUCKET', RESTORE_MOUNT, {
      localBucket: true,
      prefix: BACKUP_PREFIX,
      readOnly: true,
    });
  } else {
    await (container as any).mountBucket(r2.bucketName, RESTORE_MOUNT, {
      endpoint: r2.endpoint,
      provider: 'r2',
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
      prefix: BACKUP_PREFIX,
      readOnly: true,
    });
  }
  try {
    const archive = `${RESTORE_MOUNT}/${handle.id}/data.sqsh`;
    // Staged extraction: unsquashfs into /tmp first, copy into the live home
    // only after the full archive extracts cleanly. A corrupt archive must
    // never leave a partial state.db behind — that would flip the next boot
    // to 'skipped' and let a backup persist the partial home over the last
    // good generation.
    const result = await (container as any).exec(
      [
        `test -f ${archive}`,
        `cp ${archive} /tmp/hermes-restore.sqsh`,
        `rm -rf /tmp/hermes-restore-extract`,
        `unsquashfs -f -no-progress -d /tmp/hermes-restore-extract /tmp/hermes-restore.sqsh`,
        `mkdir -p ${HERMES_HOME}`,
        `cp -a /tmp/hermes-restore-extract/. ${HERMES_HOME}/`,
        `rm -rf /tmp/hermes-restore-extract /tmp/hermes-restore.sqsh`,
      ].join(' && '),
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `restore extraction failed (exit ${result.exitCode}): ${result.stderr ?? '(no stderr)'}`,
      );
    }
  } finally {
    try {
      await (container as any).unmountBucket(RESTORE_MOUNT);
    } catch {
      /* best effort */
    }
  }
}

// ─── R2 durability: periodic backup ─────────────────────────────────

/**
 * Snapshot ~/.hermes into backups/ via the SDK's createBackup (squashfs,
 * presigned-URL upload straight from the container). `.env` and the mounted
 * memories dir are excluded: secrets never leave the Worker secret store,
 * and memories are already durable through the live mount. Keeps two
 * generations (latest + previous) so a corrupt latest can fall back.
 *
 * Non-fatal by design: callers log failures but chat is never blocked by a
 * backup problem.
 */
export async function runBackup(
  container: DurableObjectStub,
  r2: R2Durability,
  options: { force?: boolean } = {},
): Promise<{ skipped: boolean; id?: string; lastBackupAt?: number }> {
  const state: BackupState | null = await (container as any).getBackupState();
  const lastBackupAt = state?.lastBackupAt ?? 0;
  if (!options.force && Date.now() - lastBackupAt < r2.backupIntervalSec * 1000) {
    return { skipped: true, lastBackupAt };
  }

  // Quiesce SQLite so the archived state.db (plus its -wal/-shm siblings)
  // is a consistent set. Non-fatal — the siblings are archived regardless.
  try {
    await (container as any).exec(
      `test -f ${HERMES_HOME}/state.db && python3.11 -c "import sqlite3; c = sqlite3.connect('${HERMES_HOME}/state.db'); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()" || true`,
    );
  } catch {
    /* non-fatal */
  }

  const backup = await (container as any).createBackup({
    dir: HERMES_HOME,
    excludes: ['.env', 'memories'],
    name: 'latest',
    ttl: BACKUP_TTL_SEC,
    ...(isLocalDev() ? { localBucket: true } : {}),
  });

  const newState: BackupState = {
    latest: { id: backup.id, dir: backup.dir },
    previous: state?.latest,
    lastBackupAt: Date.now(),
  };
  await (container as any).setBackupState(newState);

  // Prune the generation that just fell out of the retention window.
  const retired = state?.previous;
  if (retired) {
    try {
      if (r2.bucket) {
        await r2.bucket.delete([
          `backups/${retired.id}/data.sqsh`,
          `backups/${retired.id}/meta.json`,
        ]);
      } else {
        console.warn(
          '[r2-backup] BACKUP_BUCKET binding missing — cannot prune generation',
          retired.id,
        );
      }
    } catch (err) {
      console.warn('[r2-backup] prune of previous generation failed (non-fatal):', err);
    }
  }

  return { skipped: false, id: backup.id, lastBackupAt: newState.lastBackupAt };
}

// ─── Boot ──────────────────────────────────────────────────────────

/**
 * Ensure the Hermes gateway is running. If no process is found, start a fresh
 * one with the supplied environment variables and wait for the API port to
 * become reachable.
 *
 * `providerKeys` carries the user's BYOK secrets (Anthropic / OpenRouter /
 * OpenAI). They are written to ~/.hermes/.env by the startup script.
 */
export async function ensureGateway(
  container: DurableObjectStub,
  options: {
    providerKeys: Record<string, string>;
    gatewayToken?: string;
    defaultModel?: string;
    /** R2 durability config — memory mount + state restore when present. */
    r2?: R2Durability;
  },
): Promise<void> {
  // Memory mount runs on EVERY ensure (fail-closed), including the wake fast
  // path — see ensureMemoryMount for why the probe cannot be cold-path-only.
  if (options.r2) await ensureMemoryMount(container, options.r2);

  // Fast path: existing process is reachable.
  const existing = await findGatewayProcess(container);
  if (existing) {
    try {
      await existing.waitForPort(API_PORT, {
        mode: 'tcp',
        timeout: STARTUP_TIMEOUT_MS,
      });
      return;
    } catch {
      // Process exists but the port isn't open — recycle and try again.
      await killGateway(container);
    }
  }

  // Safety net: the port may already be open even if listProcesses missed it.
  if (await isPortOpen(container, API_PORT)) return;

  // Cold start on a replaced instance: restore ~/.hermes from R2 when this
  // instance came up empty and a backup exists. Local fast-path state
  // (snapshot-restored) is detected via state.db and skipped.
  if (options.r2) await ensureRestored(container, options.r2);

  // Launch with the latest BYOK secrets injected.
  const envVars: Record<string, string> = { ...options.providerKeys };
  if (options.gatewayToken) envVars.HERMES_GATEWAY_TOKEN = options.gatewayToken;
  if (options.defaultModel) envVars.HERMES_DEFAULT_MODEL = options.defaultModel;

  let proc: any;
  try {
    proc = await (container as any).startProcess(STARTUP_SCRIPT, {
      env: envVars,
      autoCleanup: false,
    });
  } catch (err) {
    throw new Error(
      `Failed to start Hermes gateway: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await proc.waitForPort(API_PORT, {
      mode: 'tcp',
      timeout: STARTUP_TIMEOUT_MS,
    });
  } catch {
    try {
      const logs = await proc.getLogs();
      // Raw container stderr can contain a generated gateway token or other
      // secret-looking values — redact before the message reaches a 503 body.
      throw new Error(
        `Hermes gateway failed to start within ${STARTUP_TIMEOUT_MS / 1000}s. stderr: ${redactSecrets(logs.stderr || '(empty)')}`,
      );
    } catch (logErr) {
      if (logErr instanceof Error && logErr.message.includes('failed to start'))
        throw logErr;
      throw new Error(
        `Hermes gateway failed to start within ${STARTUP_TIMEOUT_MS / 1000}s (logs unavailable)`,
      );
    }
  }
}

// ─── Status ────────────────────────────────────────────────────────

export async function getGatewayStatus(
  container: DurableObjectStub,
): Promise<'running' | 'starting' | 'stopped'> {
  const proc = await findGatewayProcess(container);
  if (!proc) {
    if (await isPortOpen(container, API_PORT)) return 'running';
    return 'stopped';
  }
  return proc.status === 'running' ? 'running' : 'starting';
}

// ─── Restart ───────────────────────────────────────────────────────

export async function restartGateway(
  container: DurableObjectStub,
  options: {
    providerKeys: Record<string, string>;
    gatewayToken?: string;
    defaultModel?: string;
    r2?: R2Durability;
  },
): Promise<void> {
  await killGateway(container);
  await ensureGateway(container, options);
}
