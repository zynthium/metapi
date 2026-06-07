import { and, asc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import {
  probeRuntimeModel,
  type RuntimeModelProbeStatus,
} from './runtimeModelProbe.js';

type AccountTokenRow = typeof schema.accountTokens.$inferSelect;
type AccountTokenHealthRow = typeof schema.accountTokenHealth.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;

const DEFAULT_TOKEN_HEALTH_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const TOKEN_HEALTH_FAILURE_THRESHOLD = 5;

export type AccountTokenHealthStatus =
  | 'healthy'
  | 'pending_probe'
  | 'request_failed_pending_probe'
  | 'probe_failed'
  | 'not_probeable';

export type ProbeModelSource = 'token' | 'site' | 'global' | 'missing';

export type ResolvedProbeModel = {
  model: string | null;
  source: ProbeModelSource;
};

export type AccountTokenHealthSummary = {
  status: AccountTokenHealthStatus;
  label: string;
  probeModel: string | null;
  probeModelSource: ProbeModelSource;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastProbeAt: string | null;
  lastProbeModel: string | null;
  lastUsedModel: string | null;
  lastError: string | null;
  stale: boolean;
};

export type AccountTokenHealthProbeTarget = {
  tokenId: number;
  tokenValue: string;
  account: AccountRow;
  site: SiteRow;
  probeModel: string;
  probeModelSource: ProbeModelSource;
  health: AccountTokenHealthRow | null;
};

export type AccountTokenHealthProbeResult = {
  tokenId: number;
  status: AccountTokenHealthStatus;
  probeStatus?: RuntimeModelProbeStatus;
  latencyMs?: number | null;
  reason: string;
};

export type AccountTokenHealthProbeSweepResult = {
  scanned: number;
  probed: number;
  healthy: number;
  failed: number;
  skipped: number;
  results: AccountTokenHealthProbeResult[];
};

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function isMaskedTokenValue(value: string | null | undefined): boolean {
  const normalized = String(value || '').trim();
  return normalized.includes('*') || normalized.includes('•');
}

function isReadyAccountToken(token: Pick<AccountTokenRow, 'token' | 'valueStatus'> | null | undefined): boolean {
  if (!token) return false;
  return (token.valueStatus || 'ready') === 'ready' && !isMaskedTokenValue(token.token);
}

function truncateError(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  return normalized.length > 500 ? normalized.slice(0, 500) : normalized;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoFromMs(nowMs: number | null | undefined): string {
  return Number.isFinite(nowMs as number)
    ? new Date(Math.trunc(nowMs as number)).toISOString()
    : nowIso();
}

function resolveStaleAfterMs(input?: number): number {
  if (Number.isFinite(input)) return Math.max(1, input!);
  const configuredHours = Number((config as unknown as { tokenHealthStaleHours?: number }).tokenHealthStaleHours);
  if (Number.isFinite(configuredHours) && configuredHours >= 1) {
    return Math.trunc(configuredHours) * 60 * 60 * 1000;
  }
  return DEFAULT_TOKEN_HEALTH_STALE_AFTER_MS;
}

function statusLabel(status: AccountTokenHealthStatus): string {
  switch (status) {
    case 'healthy':
      return '可用';
    case 'pending_probe':
      return '待探测';
    case 'request_failed_pending_probe':
      return '业务失败待复检';
    case 'probe_failed':
      return '探测失败';
    case 'not_probeable':
      return '不可探测';
    default:
      return '未知';
  }
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveGlobalProbeModel(input?: string | null): string | null {
  const explicit = normalizeOptionalText(input);
  if (explicit) return explicit;
  return normalizeOptionalText((config as unknown as { tokenHealthProbeModel?: string | null }).tokenHealthProbeModel);
}

function isActiveStatus(value: string | null | undefined): boolean {
  return (value || 'active') === 'active';
}

function isHealthRowStale(
  health: AccountTokenHealthRow | null | undefined,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  if (!health) return true;
  const lastSuccessMs = parseTimestampMs(health.lastSuccessAt);
  const lastProbeMs = parseTimestampMs(health.lastProbeAt);
  const latestHealthyMs = Math.max(lastSuccessMs ?? 0, lastProbeMs ?? 0);
  return latestHealthyMs <= 0 || nowMs - latestHealthyMs > staleAfterMs;
}

function isProbeDue(
  health: AccountTokenHealthRow | null,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  if (!health) return true;
  if (health.status === 'healthy') {
    return isHealthRowStale(health, nowMs, staleAfterMs);
  }
  if (health.status === 'request_failed_pending_probe' || health.status === 'probe_failed') {
    const nextProbeMs = parseTimestampMs(health.nextProbeAt);
    return nextProbeMs == null || nextProbeMs <= nowMs || isHealthRowStale(health, nowMs, staleAfterMs);
  }
  if (health.status === 'not_probeable') {
    return isHealthRowStale(health, nowMs, staleAfterMs);
  }
  return true;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Math.trunc(concurrency || 1)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex] as T, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  return results;
}

export function resolveAccountTokenProbeModel(input: {
  tokenProbeModel?: string | null;
  siteProbeModel?: string | null;
  globalProbeModel?: string | null;
}): ResolvedProbeModel {
  const tokenModel = normalizeOptionalText(input.tokenProbeModel);
  if (tokenModel) return { model: tokenModel, source: 'token' };

  const siteModel = normalizeOptionalText(input.siteProbeModel);
  if (siteModel) return { model: siteModel, source: 'site' };

  const globalModel = normalizeOptionalText(input.globalProbeModel);
  if (globalModel) return { model: globalModel, source: 'global' };

  return { model: null, source: 'missing' };
}

export function buildAccountTokenHealthSummary(input: {
  token: Pick<AccountTokenRow, 'enabled' | 'token' | 'valueStatus'>;
  accountStatus?: string | null;
  siteStatus?: string | null;
  health: AccountTokenHealthRow | null;
  probeModel: ResolvedProbeModel;
  nowMs?: number;
  staleAfterMs?: number;
}): AccountTokenHealthSummary {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs! : Date.now();
  const staleAfterMs = resolveStaleAfterMs(input.staleAfterMs);
  const lastSuccessMs = parseTimestampMs(input.health?.lastSuccessAt);
  const lastProbeMs = parseTimestampMs(input.health?.lastProbeAt);
  const latestHealthyMs = Math.max(lastSuccessMs ?? 0, lastProbeMs ?? 0);
  const stale = latestHealthyMs <= 0 || nowMs - latestHealthyMs > staleAfterMs;

  let status: AccountTokenHealthStatus;
  if (
    input.token.enabled !== true
    || !isReadyAccountToken(input.token)
    || (input.accountStatus && input.accountStatus !== 'active')
    || (input.siteStatus && input.siteStatus !== 'active')
    || !input.probeModel.model
  ) {
    status = 'not_probeable';
  } else if (!input.health) {
    status = 'pending_probe';
  } else if (input.health.status === 'request_failed_pending_probe') {
    status = 'request_failed_pending_probe';
  } else if (input.health.status === 'probe_failed') {
    status = stale ? 'probe_failed' : 'probe_failed';
  } else if (input.health.status === 'healthy' && !stale) {
    status = 'healthy';
  } else {
    status = 'pending_probe';
  }

  return {
    status,
    label: statusLabel(status),
    probeModel: input.probeModel.model,
    probeModelSource: input.probeModel.source,
    lastSuccessAt: input.health?.lastSuccessAt ?? null,
    lastFailureAt: input.health?.lastFailureAt ?? null,
    lastProbeAt: input.health?.lastProbeAt ?? null,
    lastProbeModel: input.health?.lastProbeModel ?? null,
    lastUsedModel: input.health?.lastUsedModel ?? null,
    lastError: input.health?.lastError ?? null,
    stale,
  };
}

export async function loadAccountTokenHealthProbeTargets(input: {
  nowMs?: number;
  staleAfterMs?: number;
  limit?: number;
  globalProbeModel?: string | null;
} = {}): Promise<AccountTokenHealthProbeTarget[]> {
  const nowMs = Number.isFinite(input.nowMs as number) ? Math.trunc(input.nowMs as number) : Date.now();
  const staleAfterMs = resolveStaleAfterMs(input.staleAfterMs);
  const limit = Number.isFinite(input.limit as number)
    ? Math.max(0, Math.trunc(input.limit as number))
    : 200;
  const globalProbeModel = resolveGlobalProbeModel(input.globalProbeModel);

  const rows = await db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokenHealth, eq(schema.accountTokens.id, schema.accountTokenHealth.tokenId))
    .where(and(
      eq(schema.accountTokens.enabled, true),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    ))
    .orderBy(asc(schema.accountTokens.id))
    .all();

  const targets: AccountTokenHealthProbeTarget[] = [];
  for (const row of rows) {
    const token = row.account_tokens;
    const account = row.accounts;
    const site = row.sites;
    const health = row.account_token_health;
    if (!isReadyAccountToken(token)) continue;
    if (!isActiveStatus(account.status) || !isActiveStatus(site.status)) continue;
    if (!isProbeDue(health, nowMs, staleAfterMs)) continue;

    const tokenValue = normalizeOptionalText(token.token);
    if (!tokenValue) continue;
    const probeModel = resolveAccountTokenProbeModel({
      tokenProbeModel: token.probeModel,
      siteProbeModel: site.tokenHealthProbeModel,
      globalProbeModel,
    });
    if (!probeModel.model) continue;
    targets.push({
      tokenId: token.id,
      tokenValue,
      account,
      site,
      probeModel: probeModel.model,
      probeModelSource: probeModel.source,
      health,
    });
    if (limit > 0 && targets.length >= limit) break;
  }

  return targets;
}

async function upsertAccountTokenHealth(
  tokenId: number,
  values: Partial<typeof schema.accountTokenHealth.$inferInsert>,
): Promise<void> {
  const existing = await db.select()
    .from(schema.accountTokenHealth)
    .where(eq(schema.accountTokenHealth.tokenId, tokenId))
    .get();
  if (existing) {
    await db.update(schema.accountTokenHealth)
      .set(values)
      .where(eq(schema.accountTokenHealth.tokenId, tokenId))
      .run();
    return;
  }
  await db.insert(schema.accountTokenHealth)
    .values({
      tokenId,
      status: 'unknown',
      failureCount: 0,
      ...values,
    })
    .run();
}

export async function recordAccountTokenRequestSuccess(input: {
  tokenId: number | null | undefined;
  modelName?: string | null;
  at?: string;
}): Promise<void> {
  const tokenId = Number(input.tokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) return;
  const at = normalizeOptionalText(input.at) || nowIso();
  await upsertAccountTokenHealth(tokenId, {
    status: 'healthy',
    lastSuccessAt: at,
    lastUsedModel: normalizeOptionalText(input.modelName),
    lastError: null,
    failureCount: 0,
    nextProbeAt: null,
    updatedAt: at,
  });
}

export async function recordAccountTokenRequestFailure(input: {
  tokenId: number | null | undefined;
  modelName?: string | null;
  error?: string | null;
  at?: string;
}): Promise<void> {
  const tokenId = Number(input.tokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) return;
  const at = normalizeOptionalText(input.at) || nowIso();
  const existing = await db.select()
    .from(schema.accountTokenHealth)
    .where(eq(schema.accountTokenHealth.tokenId, tokenId))
    .get();
  await upsertAccountTokenHealth(tokenId, {
    status: 'request_failed_pending_probe',
    lastFailureAt: at,
    lastUsedModel: normalizeOptionalText(input.modelName) ?? existing?.lastUsedModel ?? null,
    lastError: truncateError(input.error),
    failureCount: Math.max(0, existing?.failureCount ?? 0) + 1,
    nextProbeAt: at,
    updatedAt: at,
  });
}

async function loadAccountTokenProbeTargetById(input: {
  tokenId: number;
  nowMs: number;
  globalProbeModel?: string | null;
}): Promise<AccountTokenHealthProbeTarget | null> {
  const row = await db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokenHealth, eq(schema.accountTokens.id, schema.accountTokenHealth.tokenId))
    .where(eq(schema.accountTokens.id, input.tokenId))
    .get();
  if (!row) return null;

  const token = row.account_tokens;
  const account = row.accounts;
  const site = row.sites;
  const globalProbeModel = resolveGlobalProbeModel(input.globalProbeModel);
  const probeModel = resolveAccountTokenProbeModel({
    tokenProbeModel: token.probeModel,
    siteProbeModel: site.tokenHealthProbeModel,
    globalProbeModel,
  });
  const tokenValue = normalizeOptionalText(token.token);
  if (
    token.enabled !== true
    || !isReadyAccountToken(token)
    || !isActiveStatus(account.status)
    || !isActiveStatus(site.status)
    || !tokenValue
    || !probeModel.model
  ) {
    return {
      tokenId: token.id,
      tokenValue: tokenValue || '',
      account,
      site,
      probeModel: probeModel.model || '',
      probeModelSource: probeModel.source,
      health: row.account_token_health,
    };
  }

  return {
    tokenId: token.id,
    tokenValue,
    account,
    site,
    probeModel: probeModel.model,
    probeModelSource: probeModel.source,
    health: row.account_token_health,
  };
}

export async function probeAccountTokenHealth(input: {
  tokenId: number | null | undefined;
  scheduled?: boolean;
  nowMs?: number;
  timeoutMs?: number;
  globalProbeModel?: string | null;
}): Promise<AccountTokenHealthProbeResult> {
  const tokenId = Number(input.tokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    return {
      tokenId: 0,
      status: 'not_probeable',
      reason: 'invalid token id',
    };
  }

  const nowMs = Number.isFinite(input.nowMs as number) ? Math.trunc(input.nowMs as number) : Date.now();
  const at = isoFromMs(nowMs);
  const target = await loadAccountTokenProbeTargetById({
    tokenId,
    nowMs,
    globalProbeModel: input.globalProbeModel,
  });
  if (!target) {
    return {
      tokenId,
      status: 'not_probeable',
      reason: 'token not found',
    };
  }
  if (!target.tokenValue || !target.probeModel) {
    await upsertAccountTokenHealth(tokenId, {
      status: 'not_probeable',
      lastProbeAt: at,
      lastProbeModel: target.probeModel || null,
      lastError: 'token is not probeable',
      updatedAt: at,
    });
    return {
      tokenId,
      status: 'not_probeable',
      reason: 'token is not probeable',
    };
  }

  const probe = await probeRuntimeModel({
    site: target.site,
    account: target.account,
    modelName: target.probeModel,
    timeoutMs: Math.max(3_000, Math.trunc(input.timeoutMs || config.modelAvailabilityProbeTimeoutMs)),
    tokenValue: target.tokenValue,
    probeKind: 'token-health',
  });

  if (probe.status === 'supported') {
    await upsertAccountTokenHealth(tokenId, {
      status: 'healthy',
      lastSuccessAt: at,
      lastProbeAt: at,
      lastProbeModel: target.probeModel,
      lastError: null,
      failureCount: 0,
      nextProbeAt: null,
      updatedAt: at,
    });
    return {
      tokenId,
      status: 'healthy',
      probeStatus: probe.status,
      latencyMs: probe.latencyMs,
      reason: probe.reason,
    };
  }

  if (probe.status === 'skipped') {
    await upsertAccountTokenHealth(tokenId, {
      status: 'not_probeable',
      lastProbeAt: at,
      lastProbeModel: target.probeModel,
      lastError: truncateError(probe.reason),
      updatedAt: at,
    });
    return {
      tokenId,
      status: 'not_probeable',
      probeStatus: probe.status,
      latencyMs: probe.latencyMs,
      reason: probe.reason,
    };
  }

  const failureCount = Math.max(0, target.health?.failureCount ?? 0) + 1;
  const nextStatus: AccountTokenHealthStatus = input.scheduled && failureCount >= TOKEN_HEALTH_FAILURE_THRESHOLD
    ? 'probe_failed'
    : 'request_failed_pending_probe';
  await upsertAccountTokenHealth(tokenId, {
    status: nextStatus,
    lastFailureAt: at,
    lastProbeAt: at,
    lastProbeModel: target.probeModel,
    lastError: truncateError(probe.reason),
    failureCount,
    nextProbeAt: at,
    updatedAt: at,
  });

  return {
    tokenId,
    status: nextStatus,
    probeStatus: probe.status,
    latencyMs: probe.latencyMs,
    reason: probe.reason,
  };
}

export async function executeAccountTokenHealthProbeSweep(input: {
  concurrency?: number;
  limit?: number;
  nowMs?: number;
  staleAfterMs?: number;
  globalProbeModel?: string | null;
} = {}): Promise<AccountTokenHealthProbeSweepResult> {
  const nowMs = Number.isFinite(input.nowMs as number) ? Math.trunc(input.nowMs as number) : Date.now();
  const targets = await loadAccountTokenHealthProbeTargets({
    nowMs,
    staleAfterMs: input.staleAfterMs,
    limit: input.limit,
    globalProbeModel: input.globalProbeModel,
  });
  const results = await mapWithConcurrency(
    targets,
    input.concurrency || 3,
    async (target) => probeAccountTokenHealth({
      tokenId: target.tokenId,
      scheduled: true,
      nowMs,
      globalProbeModel: input.globalProbeModel,
    }),
  );

  return {
    scanned: targets.length,
    probed: results.filter((item) => item.probeStatus !== undefined).length,
    healthy: results.filter((item) => item.status === 'healthy').length,
    failed: results.filter((item) => item.status === 'probe_failed').length,
    skipped: results.filter((item) => item.status === 'not_probeable').length,
    results,
  };
}
