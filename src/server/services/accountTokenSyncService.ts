import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getCredentialModeFromExtraConfig, getProxyUrlFromExtraConfig, resolvePlatformUserId } from './accountExtraConfig.js';
import {
  type CoverageBatchRebuildResult,
  convergeAccountMutation,
  refreshAccountCoverageBatch,
} from './accountMutationWorkflow.js';
import { type ModelRefreshResult } from './modelService.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride } from './siteProxy.js';

export type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

export type SyncExecutionResult = {
  accountId: number;
  accountName: string;
  accountStatus: string | null;
  siteId: number;
  siteName: string;
  siteStatus: string | null;
  status: 'synced' | 'skipped' | 'failed';
  reason?: string;
  message?: string;
  synced: boolean;
  created: number;
  updated: number;
  maskedPending?: number;
  pendingTokenIds?: number[];
  total: number;
  defaultTokenId?: number | null;
};

export type CoverageRefreshFailureItem = {
  accountId: number;
  refreshed: false;
  status: 'failed';
  errorCode: 'coverage_refresh_failed';
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  reason: 'coverage_refresh_failed';
  tokenScanned: 0;
  discoveredByCredential: false;
  discoveredApiToken: false;
};

export type CoverageRefreshItem = ModelRefreshResult | CoverageRefreshFailureItem;
export type CoverageRefreshRebuildResult = CoverageBatchRebuildResult;

export const ACCOUNT_TOKEN_SYNC_ALL_BATCH_SIZE = 3;
const TOKEN_SYNC_TIMEOUT_MS = 15_000;

export function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

export function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return !(account.accessToken || '').trim();
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function syncAccountTokensForRow(row: AccountWithSiteRow): Promise<SyncExecutionResult> {
  const accountId = row.accounts.id;
  const base = {
    accountId,
    accountName: row.accounts.username || `account-${accountId}`,
    accountStatus: row.accounts.status,
    siteId: row.sites.id,
    siteName: row.sites.name,
    siteStatus: row.sites.status,
  };

  if (isSiteDisabled(row.sites.status)) {
    return {
      ...base,
      status: 'skipped',
      reason: 'site_disabled',
      message: 'site disabled',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }

  if (isApiKeyConnection(row.accounts)) {
    return {
      ...base,
      status: 'skipped',
      reason: 'apikey_connection',
      message: 'apikey connection does not support account tokens',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }

  if (!row.accounts.accessToken) {
    if (row.accounts.apiToken) {
      try {
        const convergence = await convergeAccountMutation({
          accountId,
          preferredApiToken: row.accounts.apiToken,
          defaultTokenSource: 'legacy',
        });
        if (convergence.defaultTokenId != null) {
          return {
            ...base,
            status: 'synced',
            reason: 'legacy_default_token_restored',
            message: 'restored local default token from legacy api token',
            synced: true,
            created: 0,
            updated: 0,
            total: 0,
            defaultTokenId: convergence.defaultTokenId,
          };
        }
      } catch (error: any) {
        return {
          ...base,
          status: 'failed',
          reason: 'sync_error',
          message: error?.message || 'sync failed',
          synced: false,
          created: 0,
          updated: 0,
          total: 0,
          defaultTokenId: null,
        };
      }
    }
    return {
      ...base,
      status: 'skipped',
      reason: 'missing_access_token',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }

  const adapter = getAdapter(row.sites.platform);
  if (!adapter) {
    return {
      ...base,
      status: 'failed',
      reason: 'unsupported_platform',
      message: `不支持的平台: ${row.sites.platform}`,
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }

  try {
    const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
    const accountProxyUrl = getProxyUrlFromExtraConfig(row.accounts.extraConfig);
    let tokens = await withTimeout(
      () => withAccountProxyOverride(accountProxyUrl,
        () => adapter.getApiTokens(row.sites.url, row.accounts.accessToken, platformUserId)),
      TOKEN_SYNC_TIMEOUT_MS,
      `token sync timeout (${Math.round(TOKEN_SYNC_TIMEOUT_MS / 1000)}s)`,
    );

    if (tokens.length === 0) {
      const fallback = await withTimeout(
        () => withAccountProxyOverride(accountProxyUrl,
          () => adapter.getApiToken(row.sites.url, row.accounts.accessToken, platformUserId)),
        TOKEN_SYNC_TIMEOUT_MS,
        `token sync timeout (${Math.round(TOKEN_SYNC_TIMEOUT_MS / 1000)}s)`,
      );
      if (fallback) {
        tokens = [{ name: 'default', key: fallback, enabled: true, tokenGroup: 'default' }];
      }
    }

    if (tokens.length === 0) {
      return {
        ...base,
        status: 'skipped',
        reason: 'no_upstream_tokens',
        message: 'upstream returned no api tokens',
        synced: false,
        created: 0,
        updated: 0,
        total: 0,
        defaultTokenId: null,
      };
    }

    const convergence = await convergeAccountMutation({
      accountId,
      upstreamTokens: tokens,
    });
    const synced = convergence.tokenSync!;
    if ((synced.maskedPending || 0) > 0) {
      return {
        ...base,
        status: 'synced',
        reason: 'upstream_masked_tokens',
        message: `上游返回 ${synced.maskedPending} 条脱敏令牌，已保存为待补全记录，请手动补全明文 token。`,
        synced: true,
        ...synced,
      };
    }
    return {
      ...base,
      status: 'synced',
      synced: true,
      ...synced,
    };
  } catch (error: any) {
    return {
      ...base,
      status: 'failed',
      reason: 'sync_error',
      message: error?.message || 'sync failed',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }
}

export async function appendTokenSyncEvent(result: SyncExecutionResult) {
  const title = result.status === 'synced'
    ? '令牌同步成功'
    : (result.status === 'skipped' ? '令牌同步跳过' : '令牌同步失败');
  const level = result.status === 'synced'
    ? 'info'
    : (result.status === 'skipped' ? 'warning' : 'error');
  const detail = result.status === 'synced'
    ? `新增 ${result.created}，更新 ${result.updated}，待补全 ${result.maskedPending || 0}，总数 ${result.total}`
    : (result.message || result.reason || 'sync skipped');

  try {
    await db.insert(schema.events).values({
      type: 'token',
      title,
      message: `${result.accountName} @ ${result.siteName}: ${detail}`,
      level,
      relatedId: result.accountId,
      relatedType: 'account',
      createdAt: new Date().toISOString(),
    }).run();
  } catch {}
}

export async function syncAllAccountTokens() {
  const rows = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.status, 'active'))
    .all();

  const results: SyncExecutionResult[] = [];
  for (let offset = 0; offset < rows.length; offset += ACCOUNT_TOKEN_SYNC_ALL_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + ACCOUNT_TOKEN_SYNC_ALL_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (row) => {
        const result = await syncAccountTokensForRow(row);
        void appendTokenSyncEvent(result);
        return result;
      }),
    );
    results.push(...batchResults);
  }

  const coverageRefresh = await refreshCoverageForAccounts(
    results
      .filter((item) => item.status === 'synced')
      .map((item) => item.accountId),
  );

  const summary = {
    total: results.length,
    synced: results.filter((item) => item.status === 'synced').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    created: results.reduce((acc, item) => acc + item.created, 0),
    updated: results.reduce((acc, item) => acc + item.updated, 0),
  };

  return { summary, results, coverageRefresh };
}

export async function refreshCoverageForAccounts(accountIds: number[]) {
  const result = await refreshAccountCoverageBatch({
    accountIds,
    batchSize: ACCOUNT_TOKEN_SYNC_ALL_BATCH_SIZE,
    mapFailure: buildCoverageRefreshFailureItem,
  });

  result.refresh.forEach((item) => {
    if ((item as CoverageRefreshFailureItem).reason === 'coverage_refresh_failed') {
      const failed = item as CoverageRefreshFailureItem;
      console.warn(`[account-tokens] coverage refresh failed for account ${failed.accountId}: ${failed.errorMessage}`);
    }
  });
  if (result.rebuild && !result.rebuild.success) {
    console.warn(`[account-tokens] token route rebuild failed after coverage refresh: ${result.rebuild.error}`);
  }

  return {
    refresh: result.refresh as CoverageRefreshItem[],
    rebuild: result.rebuild as CoverageRefreshRebuildResult | null,
  };
}

function buildCoverageRefreshFailureItem(
  accountId: number,
  errorMessage: string,
): CoverageRefreshFailureItem {
  return {
    accountId,
    refreshed: false,
    status: 'failed',
    errorCode: 'coverage_refresh_failed',
    errorMessage,
    modelCount: 0,
    modelsPreview: [],
    reason: 'coverage_refresh_failed',
    tokenScanned: 0,
    discoveredByCredential: false,
    discoveredApiToken: false,
  };
}
