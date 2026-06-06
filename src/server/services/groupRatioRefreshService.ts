import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { type AccountWithSiteRow } from './accountTokenSyncService.js';
import {
  markAccountGroupRatioRefreshFailure,
  upsertAccountGroupRatios,
} from './accountGroupRatioStore.js';
import { runMaintenanceWithRetry } from './maintenanceRetry.js';
import { fetchGroupRatioForSite } from './modelPricingService.js';

export type GroupRatioRefreshResult = {
  accountId: number;
  siteId: number;
  status: 'synced' | 'skipped' | 'failed';
  synced: boolean;
  groupCount: number;
  message?: string;
};

export async function refreshGroupRatiosForAccountRow(input: {
  row: AccountWithSiteRow;
  retryAttempts: number;
  attemptTimeoutMs: number;
  backoffMs?: (attempt: number) => number;
}): Promise<GroupRatioRefreshResult> {
  const account = input.row.accounts;
  const site = input.row.sites;
  const token = account.accessToken || account.apiToken || null;

  if ((account.status || 'active') !== 'active' || (site.status || 'active') !== 'active' || !token) {
    return {
      accountId: account.id,
      siteId: site.id,
      status: 'skipped',
      synced: false,
      groupCount: 0,
    };
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const result = await runMaintenanceWithRetry({
    label: `group-ratio:${account.id}`,
    attempts: input.retryAttempts,
    attemptTimeoutMs: input.attemptTimeoutMs,
    backoffMs: input.backoffMs,
    run: async () => {
      const ratios = await fetchGroupRatioForSite(site, token, platformUserId);
      if (!ratios || Object.keys(ratios).length === 0) {
        throw new Error('empty group ratio response');
      }
      return ratios;
    },
  });

  if (!result.ok) {
    await markAccountGroupRatioRefreshFailure({
      accountId: account.id,
      siteId: site.id,
      error: result.error,
      failedAttempts: result.attempts.length,
    });
    return {
      accountId: account.id,
      siteId: site.id,
      status: 'failed',
      synced: false,
      groupCount: 0,
      message: result.error,
    };
  }

  await upsertAccountGroupRatios({
    accountId: account.id,
    siteId: site.id,
    ratios: result.value,
  });
  return {
    accountId: account.id,
    siteId: site.id,
    status: 'synced',
    synced: true,
    groupCount: Object.keys(result.value).length,
  };
}

export async function refreshAllAccountGroupRatios(input: {
  retryAttempts: number;
  attemptTimeoutMs: number;
  concurrency: number;
}): Promise<{
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  results: GroupRatioRefreshResult[];
}> {
  const rows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const results: GroupRatioRefreshResult[] = [];
  const batchSize = Math.max(1, Math.trunc(input.concurrency));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    results.push(...await Promise.all(batch.map((row) => refreshGroupRatiosForAccountRow({
      row,
      retryAttempts: input.retryAttempts,
      attemptTimeoutMs: input.attemptTimeoutMs,
    }))));
  }

  return {
    total: results.length,
    synced: results.filter((item) => item.status === 'synced').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results,
  };
}
