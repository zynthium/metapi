import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type HealthModule = typeof import('./accountTokenHealthService.js');

describe('accountTokenHealthService', () => {
  let dataDir = '';
  let originalDataDir: string | undefined;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let health: HealthModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-health-service-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    health = await import('./accountTokenHealthService.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
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

  async function seedToken() {
    const site = await db.insert(schema.sites).values({
      name: 'token-health-site',
      url: 'https://token-health.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'token-health-account',
      accessToken: 'session-token',
      apiToken: 'sk-account-token',
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-token-health',
      valueStatus: 'ready',
      enabled: true,
      isDefault: true,
    }).returning().get();
    return { site, account, token };
  }

  it('resolves probe model as token override before site default before global default', () => {
    expect(health.resolveAccountTokenProbeModel({
      tokenProbeModel: 'token-model',
      siteProbeModel: 'site-model',
      globalProbeModel: 'global-model',
    })).toEqual({ model: 'token-model', source: 'token' });

    expect(health.resolveAccountTokenProbeModel({
      tokenProbeModel: '',
      siteProbeModel: 'site-model',
      globalProbeModel: 'global-model',
    })).toEqual({ model: 'site-model', source: 'site' });

    expect(health.resolveAccountTokenProbeModel({
      tokenProbeModel: '',
      siteProbeModel: '',
      globalProbeModel: 'global-model',
    })).toEqual({ model: 'global-model', source: 'global' });

    expect(health.resolveAccountTokenProbeModel({})).toEqual({ model: null, source: 'missing' });
  });

  it('marks enabled ready token without health row as pending probe', () => {
    const summary = health.buildAccountTokenHealthSummary({
      token: { enabled: true, valueStatus: 'ready', token: 'sk-demo' },
      accountStatus: 'active',
      siteStatus: 'active',
      health: null,
      probeModel: { model: 'gpt-5-mini', source: 'global' },
      nowMs: Date.parse('2026-06-07T00:00:00.000Z'),
      staleAfterMs: 6 * 60 * 60 * 1000,
    });
    expect(summary.status).toBe('pending_probe');
    expect(summary.label).toBe('待探测');
  });

  it('marks disabled or masked tokens as not probeable', () => {
    const summary = health.buildAccountTokenHealthSummary({
      token: { enabled: true, valueStatus: 'masked_pending', token: 'sk-abc***def' },
      accountStatus: 'active',
      siteStatus: 'active',
      health: null,
      probeModel: { model: 'gpt-5-mini', source: 'global' },
      nowMs: Date.parse('2026-06-07T00:00:00.000Z'),
      staleAfterMs: 6 * 60 * 60 * 1000,
    });
    expect(summary.status).toBe('not_probeable');
    expect(summary.label).toBe('不可探测');
  });

  it('records proxy success as healthy and clears failure state', async () => {
    const { token } = await seedToken();
    await health.recordAccountTokenRequestFailure({
      tokenId: token.id,
      modelName: 'gpt-5-mini',
      error: 'temporary failure',
      at: '2026-06-06T23:59:00.000Z',
    });
    await health.recordAccountTokenRequestSuccess({
      tokenId: token.id,
      modelName: 'gpt-5-mini',
      at: '2026-06-07T00:00:00.000Z',
    });

    const row = await db.select()
      .from(schema.accountTokenHealth)
      .where(eq(schema.accountTokenHealth.tokenId, token.id))
      .get();
    expect(row).toMatchObject({
      status: 'healthy',
      failureCount: 0,
      lastUsedModel: 'gpt-5-mini',
      lastError: null,
    });
  });

  it('records proxy failure as pending retry without permanent unhealthy verdict', async () => {
    const { token } = await seedToken();
    await health.recordAccountTokenRequestFailure({
      tokenId: token.id,
      modelName: 'gpt-5-mini',
      error: 'HTTP 401 invalid token',
      at: '2026-06-07T00:00:00.000Z',
    });

    const row = await db.select()
      .from(schema.accountTokenHealth)
      .where(eq(schema.accountTokenHealth.tokenId, token.id))
      .get();
    expect(row?.status).toBe('request_failed_pending_probe');
    expect(row?.lastError).toBe('HTTP 401 invalid token');
    expect(row?.failureCount).toBe(1);
    expect(row?.nextProbeAt).toBe('2026-06-07T00:00:00.000Z');
  });
});
