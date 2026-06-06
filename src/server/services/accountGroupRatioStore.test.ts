import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type DbModule = typeof import('../db/index.js');
type StoreModule = typeof import('./accountGroupRatioStore.js');

describe('accountGroupRatioStore', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-group-ratio-store-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const storeModule = await import('./accountGroupRatioStore.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = storeModule;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores and updates last-known-good group multipliers', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ratio-site',
      url: 'https://ratio.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'ratio-account',
      accessToken: 'session-token',
      apiToken: 'sk-token',
    }).returning().get();

    await store.upsertAccountGroupRatios({
      accountId: account.id,
      siteId: site.id,
      ratios: { default: 1, vip: 0.3 },
      refreshedAt: '2026-06-07T00:00:00.000Z',
    });
    await store.upsertAccountGroupRatios({
      accountId: account.id,
      siteId: site.id,
      ratios: { vip: 0.25 },
      refreshedAt: '2026-06-07T01:00:00.000Z',
    });

    const ratios = await store.getAccountGroupRatioMap(account.id, site.id);
    expect(ratios.default?.multiplier).toBe(1);
    expect(ratios.vip?.multiplier).toBe(0.25);
    expect(ratios.vip?.refreshedAt).toBe('2026-06-07T01:00:00.000Z');
    expect(ratios.vip?.failedAttempts).toBe(0);
  });
});
