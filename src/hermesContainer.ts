import { Sandbox } from '@cloudflare/sandbox';

/**
 * Backup handle persisted in Durable Object storage so the Worker can restore
 * after an instance replacement. Mirrors the SDK's DirectoryBackup shape
 * ({ id, dir }) — kept as a local type so JSON round-trips through RPC stay
 * explicit. Two generations are kept: latest + previous (fallback on a
 * corrupt latest).
 */
export interface BackupHandle {
  id: string;
  dir: string;
}

export interface BackupState {
  latest?: BackupHandle;
  previous?: BackupHandle;
  /** Unix ms of the last successful backup (debounce for post-chat runs). */
  lastBackupAt?: number;
}

/**
 * Durable Object that owns the Hermes Sandbox container.
 *
 * In hermesworkers there is exactly one container per Worker deployment
 * (single-tenant mode). The Worker resolves this DO by a fixed instance
 * name (see `getContainer()` in `lib/container.ts`) and all chat / dashboard
 * traffic flows through the same stub.
 *
 * The Hermes process itself is launched on-demand from `container-lifecycle.ts`
 * by calling `startProcess('/usr/local/bin/start-hermes.sh', ...)`.
 *
 * Provider API keys (Anthropic / OpenRouter / OpenAI) are injected through
 * env vars at process start, not baked into the image — see `ensureGateway()`.
 */
export class HermesInstance extends Sandbox {
  defaultPort = 18789;
  sleepAfter = '4h';

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as any, env as any);
    // No baseline env required here — keys are injected at process start.
  }

  /** Latest backup-handle state (undefined when no backup exists yet). */
  async getBackupState(): Promise<BackupState | null> {
    return (await this.ctx.storage.get<BackupState>('r2-backup-state')) ?? null;
  }

  async setBackupState(state: BackupState): Promise<void> {
    await this.ctx.storage.put('r2-backup-state', state);
  }
}
