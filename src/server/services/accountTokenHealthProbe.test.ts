import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const probeRuntimeModelMock = vi.hoisted(() => vi.fn());

vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: (...args: unknown[]) => probeRuntimeModelMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type HealthModule = typeof import('./accountTokenHealthService.js');

describe('account token health probe', () => {
  let dataDir = '';
  let originalDataDir: string | undefined;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let health: HealthModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-health-probe-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    health = await import('./accountTokenHealthService.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    probeRuntimeModelMock.mockReset();
    probeRuntimeModelMock.mockResolvedValue({
      status: 'supported',
      latencyMs: 12,
      reason: 'probe succeeded',
    });
    await db.delete(schema.accountTokenHealth).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedAccountWithTokens() {
    const site = await db.insert(schema.sites).values({
      name: 'token-health-probe-site',
      url: 'https://token-health-probe.example.com',
      platform: 'new-api',
      status: 'active',
      tokenHealthProbeModel: 'site-probe-model',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'token-health-probe-account',
      accessToken: 'session-token',
      apiToken: 'sk-account-token',
      status: 'active',
    }).returning().get();
    const readyNever = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'ready-never',
      token: 'sk-ready-never',
      valueStatus: 'ready',
      enabled: true,
      isDefault: true,
    }).returning().get();
    const recentHealthy = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'recent-healthy',
      token: 'sk-recent-healthy',
      valueStatus: 'ready',
      enabled: true,
    }).returning().get();
    const staleHealthy = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'stale-healthy',
      token: 'sk-stale-healthy',
      valueStatus: 'ready',
      enabled: true,
      probeModel: 'token-probe-model',
    }).returning().get();
    const failedPending = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'failed-pending',
      token: 'sk-failed-pending',
      valueStatus: 'ready',
      enabled: true,
    }).returning().get();
    const disabled = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'disabled',
      token: 'sk-disabled',
      valueStatus: 'ready',
      enabled: false,
    }).returning().get();
    const masked = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked',
      token: 'sk-mas***sked',
      valueStatus: 'masked_pending',
      enabled: true,
    }).returning().get();

    await db.insert(schema.accountTokenHealth).values({
      tokenId: recentHealthy.id,
      status: 'healthy',
      lastSuccessAt: '2026-06-07T05:59:00.000Z',
      lastProbeAt: '2026-06-07T05:59:00.000Z',
      failureCount: 0,
      updatedAt: '2026-06-07T05:59:00.000Z',
    }).run();
    await db.insert(schema.accountTokenHealth).values({
      tokenId: staleHealthy.id,
      status: 'healthy',
      lastSuccessAt: '2026-06-06T00:00:00.000Z',
      lastProbeAt: '2026-06-06T00:00:00.000Z',
      failureCount: 0,
      updatedAt: '2026-06-06T00:00:00.000Z',
    }).run();
    await db.insert(schema.accountTokenHealth).values({
      tokenId: failedPending.id,
      status: 'request_failed_pending_probe',
      lastFailureAt: '2026-06-07T05:55:00.000Z',
      failureCount: 1,
      nextProbeAt: '2026-06-07T05:55:00.000Z',
      updatedAt: '2026-06-07T05:55:00.000Z',
    }).run();

    return {
      site,
      account,
      readyNever,
      recentHealthy,
      staleHealthy,
      failedPending,
      disabled,
      masked,
    };
  }

  it('selects only ready due tokens for scheduled probing', async () => {
    const seeded = await seedAccountWithTokens();

    const targets = await health.loadAccountTokenHealthProbeTargets({
      nowMs: Date.parse('2026-06-07T06:00:00.000Z'),
      staleAfterMs: 6 * 60 * 60 * 1000,
    });

    expect(targets.map((target) => target.tokenId)).toEqual([
      seeded.readyNever.id,
      seeded.staleHealthy.id,
      seeded.failedPending.id,
    ]);
    expect(targets.find((target) => target.tokenId === seeded.staleHealthy.id)?.probeModel).toBe('token-probe-model');
    expect(targets.find((target) => target.tokenId === seeded.readyNever.id)?.probeModel).toBe('site-probe-model');
    expect(targets.map((target) => target.tokenId)).not.toContain(seeded.recentHealthy.id);
    expect(targets.map((target) => target.tokenId)).not.toContain(seeded.disabled.id);
    expect(targets.map((target) => target.tokenId)).not.toContain(seeded.masked.id);
  });

  it('records a successful probe as healthy with token-health probe mode', async () => {
    const { readyNever } = await seedAccountWithTokens();

    const result = await health.probeAccountTokenHealth({
      tokenId: readyNever.id,
      nowMs: Date.parse('2026-06-07T06:00:00.000Z'),
      scheduled: true,
    });

    expect(result).toMatchObject({
      tokenId: readyNever.id,
      status: 'healthy',
      probeStatus: 'supported',
      reason: 'probe succeeded',
    });
    expect(probeRuntimeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'site-probe-model',
      tokenValue: 'sk-ready-never',
      probeKind: 'token-health',
    }));
    const row = await db.select()
      .from(schema.accountTokenHealth)
      .where(eq(schema.accountTokenHealth.tokenId, readyNever.id))
      .get();
    expect(row).toMatchObject({
      status: 'healthy',
      failureCount: 0,
      lastProbeAt: '2026-06-07T06:00:00.000Z',
      lastProbeModel: 'site-probe-model',
      lastError: null,
    });
  });

  it('retries retryable token probes and enforces a stable timeout floor', async () => {
    const { readyNever } = await seedAccountWithTokens();
    probeRuntimeModelMock
      .mockResolvedValueOnce({
        status: 'inconclusive',
        latencyMs: 15_000,
        reason: 'runtime model probe timeout (15s)',
        retryable: true,
      })
      .mockResolvedValueOnce({
        status: 'supported',
        latencyMs: 16,
        reason: 'probe succeeded',
      });

    const result = await health.probeAccountTokenHealth({
      tokenId: readyNever.id,
      nowMs: Date.parse('2026-06-07T06:00:00.000Z'),
      scheduled: true,
      timeoutMs: 3_000,
      retryAttempts: 3,
      backoffMs: () => 0,
    });

    expect(result.status).toBe('healthy');
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(2);
    expect(probeRuntimeModelMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      timeoutMs: 15_000,
    }));
    expect(probeRuntimeModelMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      timeoutMs: 15_000,
    }));
  });

  it('does not immediately retry non-retryable quota or permission probe results', async () => {
    const { readyNever } = await seedAccountWithTokens();
    probeRuntimeModelMock.mockResolvedValue({
      status: 'unsupported',
      latencyMs: 21,
      reason: 'model access denied by permission policy',
      retryable: false,
    });

    const result = await health.probeAccountTokenHealth({
      tokenId: readyNever.id,
      nowMs: Date.parse('2026-06-07T06:00:00.000Z'),
      scheduled: true,
      retryAttempts: 5,
      backoffMs: () => 0,
    });

    expect(result.status).toBe('request_failed_pending_probe');
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    const row = await db.select()
      .from(schema.accountTokenHealth)
      .where(eq(schema.accountTokenHealth.tokenId, readyNever.id))
      .get();
    expect(row).toMatchObject({
      status: 'request_failed_pending_probe',
      failureCount: 1,
      nextProbeAt: '2026-06-07T06:00:00.000Z',
    });
  });

  it('requires five scheduled failures before marking a token probe failed', async () => {
    const { readyNever } = await seedAccountWithTokens();
    probeRuntimeModelMock.mockResolvedValue({
      status: 'inconclusive',
      latencyMs: 8,
      reason: 'HTTP 401 invalid token',
    });

    for (let index = 1; index <= 4; index += 1) {
      const result = await health.probeAccountTokenHealth({
        tokenId: readyNever.id,
        nowMs: Date.parse(`2026-06-07T06:0${index}:00.000Z`),
        scheduled: true,
      });
      expect(result.status).toBe('request_failed_pending_probe');
    }

    const final = await health.probeAccountTokenHealth({
      tokenId: readyNever.id,
      nowMs: Date.parse('2026-06-07T06:05:00.000Z'),
      scheduled: true,
    });

    expect(final.status).toBe('probe_failed');
    const row = await db.select()
      .from(schema.accountTokenHealth)
      .where(eq(schema.accountTokenHealth.tokenId, readyNever.id))
      .get();
    expect(row).toMatchObject({
      status: 'probe_failed',
      failureCount: 5,
      lastProbeAt: '2026-06-07T06:05:00.000Z',
      lastProbeModel: 'site-probe-model',
      lastError: 'HTTP 401 invalid token',
    });
  });
});
