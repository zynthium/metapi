import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getCredentialModeFromExtraConfig,
  hasOauthProvider,
} from './accountExtraConfig.js';
import {
  buildRuntimeHealthForAccount,
  setAccountRuntimeHealth,
  type RuntimeHealthState,
} from './accountHealthService.js';
import { refreshBalance } from './balanceService.js';
import { runMaintenanceWithRetry, type MaintenanceRetryAttempt } from './maintenanceRetry.js';

export type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

export type AccountHealthRefreshResult = {
  accountId: number;
  username: string | null;
  siteName: string;
  status: 'success' | 'failed' | 'skipped';
  state: RuntimeHealthState;
  message: string;
  attempts?: Array<{ attempt: number; ok: boolean; error: string | null }>;
};

export type AccountHealthRefreshSummary = {
  total: number;
  healthy: number;
  unhealthy: number;
  degraded: number;
  disabled: number;
  unknown: number;
  success: number;
  failed: number;
  skipped: number;
};

function hasSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveStoredCredentialMode(account: typeof schema.accounts.$inferSelect): 'auto' | 'session' | 'apikey' {
  const fromConfig = getCredentialModeFromExtraConfig(account.extraConfig);
  if (fromConfig && fromConfig !== 'auto') return fromConfig;
  return hasSessionTokenValue(account.accessToken) ? 'session' : 'apikey';
}

function canRefreshBalance(account: typeof schema.accounts.$inferSelect): boolean {
  if (hasOauthProvider(account)) return false;
  const credentialMode = resolveStoredCredentialMode(account);
  if (credentialMode === 'session') return hasSessionTokenValue(account.accessToken);
  if (credentialMode === 'apikey') return false;
  return hasSessionTokenValue(account.accessToken);
}

function toAttempts(attempts: MaintenanceRetryAttempt[]): Array<{ attempt: number; ok: boolean; error: string | null }> {
  return attempts.map((attempt) => ({
    attempt: attempt.attempt,
    ok: attempt.ok,
    error: attempt.error,
  }));
}

export function summarizeAccountHealthRefresh(
  results: AccountHealthRefreshResult[],
): AccountHealthRefreshSummary {
  return {
    total: results.length,
    healthy: results.filter((item) => item.state === 'healthy').length,
    unhealthy: results.filter((item) => item.state === 'unhealthy').length,
    degraded: results.filter((item) => item.state === 'degraded').length,
    disabled: results.filter((item) => item.state === 'disabled').length,
    unknown: results.filter((item) => item.state === 'unknown').length,
    success: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
  };
}

export async function refreshRuntimeHealthForAccountRow(input: {
  row: AccountWithSiteRow;
  retryAttempts: number;
  attemptTimeoutMs: number;
  backoffMs?: (attempt: number) => number;
}): Promise<AccountHealthRefreshResult> {
  const { row } = input;
  const accountId = row.accounts.id;
  const username = row.accounts.username;
  const siteName = row.sites.name;
  const sessionCapable = canRefreshBalance(row.accounts);

  if (
    (row.accounts.status || 'active') === 'disabled'
    || (row.sites.status || 'active') === 'disabled'
  ) {
    const health = await setAccountRuntimeHealth(accountId, {
      state: 'disabled',
      reason: '账号或站点已禁用',
      source: 'health-refresh',
    });
    return {
      accountId,
      username,
      siteName,
      status: 'skipped',
      state: health?.state || 'disabled',
      message: health?.reason || '账号或站点已禁用',
    };
  }

  if (!sessionCapable) {
    return {
      accountId,
      username,
      siteName,
      status: 'skipped',
      state: 'unknown',
      message: '仅代理账号不支持会话健康检查',
    };
  }

  const retry = await runMaintenanceWithRetry({
    label: `account-health:${accountId}`,
    attempts: input.retryAttempts,
    attemptTimeoutMs: input.attemptTimeoutMs,
    backoffMs: input.backoffMs,
    run: () => refreshBalance(accountId, { updateRuntimeHealthOnFailure: false }),
  });

  if (!retry.ok) {
    const health = await setAccountRuntimeHealth(accountId, {
      state: 'unhealthy',
      reason: retry.error,
      source: 'health-refresh',
    });
    return {
      accountId,
      username,
      siteName,
      status: 'failed',
      state: health?.state || 'unhealthy',
      message: health?.reason || retry.error,
      attempts: toAttempts(retry.attempts),
    };
  }

  const runtimeHealth = buildRuntimeHealthForAccount({
    accountStatus: row.accounts.status,
    siteStatus: row.sites.status,
    extraConfig: row.accounts.extraConfig,
    sessionCapable,
  });

  if (runtimeHealth.state === 'unknown') {
    const health = await setAccountRuntimeHealth(accountId, {
      state: 'healthy',
      reason: '健康检查通过',
      source: 'health-refresh',
    });
    return {
      accountId,
      username,
      siteName,
      status: 'success',
      state: health?.state || 'healthy',
      message: health?.reason || '健康检查通过',
      attempts: toAttempts(retry.attempts),
    };
  }

  return {
    accountId,
    username,
    siteName,
    status: runtimeHealth.state === 'unhealthy' ? 'failed' : 'success',
    state: runtimeHealth.state,
    message: runtimeHealth.reason,
    attempts: toAttempts(retry.attempts),
  };
}

export async function executeRefreshAccountRuntimeHealth(input?: {
  accountId?: number;
  retryAttempts?: number;
  attemptTimeoutMs?: number;
  concurrency?: number;
}): Promise<{ summary: AccountHealthRefreshSummary; results: AccountHealthRefreshResult[] }> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const targetRows = Number.isFinite(input?.accountId)
    ? rows.filter((row) => row.accounts.id === input?.accountId)
    : rows;
  const retryAttempts = input?.retryAttempts || 5;
  const attemptTimeoutMs = input?.attemptTimeoutMs || 15_000;
  const concurrency = Math.max(1, Math.trunc(input?.concurrency || 3));
  const results: AccountHealthRefreshResult[] = [];

  for (let offset = 0; offset < targetRows.length; offset += concurrency) {
    const batch = targetRows.slice(offset, offset + concurrency);
    results.push(...await Promise.all(batch.map((row) => refreshRuntimeHealthForAccountRow({
      row,
      retryAttempts,
      attemptTimeoutMs,
    }))));
  }

  return {
    summary: summarizeAccountHealthRefresh(results),
    results,
  };
}
