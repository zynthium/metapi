import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isReadyAccountToken } from './accountTokenService.js';

type AccountTokenRow = typeof schema.accountTokens.$inferSelect;
type AccountTokenHealthRow = typeof schema.accountTokenHealth.$inferSelect;

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

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function truncateError(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  return normalized.length > 500 ? normalized.slice(0, 500) : normalized;
}

function nowIso(): string {
  return new Date().toISOString();
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
  const staleAfterMs = Number.isFinite(input.staleAfterMs)
    ? Math.max(1, input.staleAfterMs!)
    : 6 * 60 * 60 * 1000;
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
