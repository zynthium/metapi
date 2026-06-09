import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const getApiTokenMock = vi.fn();
const getModelsMock = vi.fn();
const probeRuntimeModelMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

vi.mock('./runtimeModelProbe.js', () => ({
  MODEL_UNAVAILABLE_CONFIRMATION_ATTEMPTS: 5,
  probeRuntimeModel: (...args: unknown[]) => probeRuntimeModelMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('modelService invalidation confirmation', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let probeSiteModels: ModelServiceModule['probeSiteModels'];
  let refreshModelsForAccount: ModelServiceModule['refreshModelsForAccount'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-invalidation-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    probeSiteModels = modelService.probeSiteModels;
    refreshModelsForAccount = modelService.refreshModelsForAccount;
  });

  beforeEach(async () => {
    getApiTokenMock.mockReset();
    getModelsMock.mockReset();
    probeRuntimeModelMock.mockReset();
    getApiTokenMock.mockResolvedValue(null);
    probeRuntimeModelMock.mockResolvedValue({
      status: 'inconclusive',
      latencyMs: null,
      reason: 'probe timeout',
    });

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  it('does not disable a model when manual probing is inconclusive', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'manual-probe-site',
      url: 'https://manual-probe.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'manual-probe-user',
      accessToken: '',
      apiToken: 'sk-manual-probe',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-flaky',
      available: true,
      checkedAt: '2026-06-01T00:00:00.000Z',
    }).run();

    const result = await probeSiteModels(site.id, {
      modelName: 'gpt-flaky',
      concurrency: 1,
    });

    expect(result).toMatchObject({
      success: true,
      probed: 1,
      unsupported: 0,
    });
    expect(result.details[0]).toMatchObject({ modelName: 'gpt-flaky', status: 'inconclusive' });
    expect(probeRuntimeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'gpt-flaky',
      retryAttempts: 5,
    }));

    const availability = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .get();
    expect(availability?.available).toBe(true);

    const disabledModels = await db.select().from(schema.siteDisabledModels).all();
    expect(disabledModels).toHaveLength(0);
  });

  it('does not disable a model when post-refresh probing is inconclusive', async () => {
    getModelsMock.mockResolvedValue(['gpt-flaky']);

    const site = await db.insert(schema.sites).values({
      name: 'post-probe-site',
      url: 'https://post-probe.example.com',
      platform: 'new-api',
      status: 'active',
      postRefreshProbeEnabled: true,
      postRefreshProbeScope: 'all',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'post-probe-user',
      accessToken: '',
      apiToken: 'sk-post-probe',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result.status).toBe('success');
    expect(result.postProbeResult).toMatchObject({
      probed: 1,
      unsupported: 0,
    });
    expect(probeRuntimeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'gpt-flaky',
      retryAttempts: 5,
    }));

    const availability = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .get();
    expect(availability?.available).toBe(true);

    const disabledModels = await db.select().from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, site.id))
      .all();
    expect(disabledModels).toHaveLength(0);
  });

  it('restores previous model availability when refresh fails', async () => {
    getModelsMock.mockRejectedValue(new Error('HTTP 401: invalid api key'));

    const site = await db.insert(schema.sites).values({
      name: 'refresh-failure-site',
      url: 'https://refresh-failure.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'refresh-failure-user',
      accessToken: '',
      apiToken: 'sk-refresh-failure',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-existing',
      available: true,
      checkedAt: '2026-06-01T00:00:00.000Z',
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result.status).toBe('failed');

    const availabilityRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(availabilityRows.map((row) => row.modelName)).toEqual(['gpt-existing']);
    expect(availabilityRows[0]?.available).toBe(true);
  });
});
