import { and, eq, inArray, ne } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { getInsertedRowId } from '../db/insertHelpers.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';
import { getAccountGroupRatioMap } from './accountGroupRatioStore.js';
import {
  buildAccountTokenHealthSummary,
  resolveAccountTokenProbeModel,
} from './accountTokenHealthService.js';
import {
  buildStageCheckSchedule,
  getConnectionMaintenanceScheduleContext,
  resolveTokenHealthNextCheckAt,
} from './maintenanceCheckScheduleService.js';

type UpstreamApiToken = {
  name?: string | null;
  key?: string | null;
  enabled?: boolean | null;
  tokenGroup?: string | null;
  upstreamId?: string | number | null;
  upstreamCreatedAt?: string | number | null;
};

type AccountTokenRow = typeof schema.accountTokens.$inferSelect;
type AccountTokenHealthRow = typeof schema.accountTokenHealth.$inferSelect;

export const ACCOUNT_TOKEN_VALUE_STATUS_READY = 'ready' as const;
export const ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING = 'masked_pending' as const;
export type AccountTokenValueStatus =
  | typeof ACCOUNT_TOKEN_VALUE_STATUS_READY
  | typeof ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;

export function normalizeTokenForDisplay(token?: string | null, platform?: string | null): string {
  if (!token) return '';
  const value = token.trim();
  if (!value) return '';
  if (platform !== undefined) {
    // Keep the parameter for route-level compatibility; display rule is now global.
  }
  if (!value.toLowerCase().startsWith('sk-')) {
    return `sk-${value}`;
  }
  return value;
}

export function maskToken(token?: string | null, platform?: string | null): string {
  const value = normalizeTokenForDisplay(token, platform);
  if (!value) return '';
  if (value.toLowerCase().startsWith('sk-')) {
    if (value.length <= 7) return 'sk-***';
    const visibleMiddle = value.slice(3, Math.min(6, value.length));
    if (value.length <= 12) return `sk-${visibleMiddle}***${value.slice(-2)}`;
    return `sk-${visibleMiddle}***${value.slice(-4)}`;
  }
  if (value.length <= 10) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function normalizeTokenName(name: string | null | undefined, fallbackIndex = 1): string {
  const trimmed = (name || '').trim();
  if (trimmed) return trimmed;
  return fallbackIndex === 1 ? 'default' : `token-${fallbackIndex}`;
}

function normalizeTokenValue(token: string | null | undefined): string | null {
  const trimmed = (token || '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIdentityValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isMaskedTokenValue(token: string | null | undefined): boolean {
  const value = (token || '').trim();
  if (!value) return false;
  return value.includes('*') || value.includes('•');
}

function normalizeMaskedTokenForCompare(token: string | null | undefined): string {
  return normalizeTokenForDisplay(token).replace(/•/g, '*');
}

function matchesMaskedTokenValue(
  fullToken: string | null | undefined,
  maskedToken: string | null | undefined,
): boolean {
  const normalizedFull = normalizeTokenForDisplay(fullToken);
  const normalizedMasked = normalizeMaskedTokenForCompare(maskedToken);
  if (!normalizedFull || !normalizedMasked) return false;

  if (!isMaskedTokenValue(normalizedMasked)) {
    return normalizedFull === normalizedMasked;
  }

  const firstMaskIndex = normalizedMasked.search(/[\*]/);
  const lastMaskIndex = Math.max(
    normalizedMasked.lastIndexOf('*'),
    normalizedMasked.lastIndexOf('•'),
  );
  if (firstMaskIndex < 0 || lastMaskIndex < firstMaskIndex) {
    return normalizedFull === normalizedMasked;
  }

  const prefix = normalizedMasked.slice(0, firstMaskIndex);
  const suffix = normalizedMasked.slice(lastMaskIndex + 1);
  const visiblePrefix = prefix.replace(/^sk-/i, '');
  if (!visiblePrefix && !suffix) return false;
  if (normalizedFull.length < prefix.length + suffix.length) return false;
  if (prefix && !normalizedFull.startsWith(prefix)) return false;
  if (suffix && !normalizedFull.endsWith(suffix)) return false;
  return true;
}

function normalizeTokenValueStatus(value: string | null | undefined): AccountTokenValueStatus {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    : ACCOUNT_TOKEN_VALUE_STATUS_READY;
}

export function resolveAccountTokenValueStatus(
  value: Pick<AccountTokenRow, 'token' | 'valueStatus'> | string | null | undefined,
): AccountTokenValueStatus {
  if (typeof value === 'string' || value == null) {
    return normalizeTokenValueStatus(value);
  }

  const explicit = normalizeTokenValueStatus(value.valueStatus);
  if (explicit === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
    return ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;
  }
  return isMaskedTokenValue(value.token)
    ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    : ACCOUNT_TOKEN_VALUE_STATUS_READY;
}

export function isReadyAccountToken(token: Pick<AccountTokenRow, 'token' | 'valueStatus'> | null | undefined): boolean {
  if (!token) return false;
  return resolveAccountTokenValueStatus(token) === ACCOUNT_TOKEN_VALUE_STATUS_READY
    && !isMaskedTokenValue(token.token);
}

export function isMaskedPendingAccountToken(token: Pick<AccountTokenRow, 'token' | 'valueStatus'> | null | undefined): boolean {
  if (!token) return false;
  return resolveAccountTokenValueStatus(token) === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;
}

export function isUsableAccountToken(token: AccountTokenRow | null | undefined): boolean {
  if (!token) return false;
  return token.enabled === true && isReadyAccountToken(token);
}

function normalizeTokenGroup(value: string | null | undefined, tokenName?: string | null): string | null {
  const explicit = (value || '').trim();
  if (explicit.length > 0) return explicit;

  const name = (tokenName || '').trim();
  if (!name) return null;
  const normalized = name.toLowerCase();
  if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
    return 'default';
  }
  if (/^token-\d+$/.test(normalized)) return null;
  return name;
}

async function updateAccountApiToken(accountId: number, tokenValue: string | null) {
  await db.update(schema.accounts)
    .set({ apiToken: tokenValue || null, updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.id, accountId))
    .run();
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return normalizeTokenValue(account.accessToken) === null;
}

export async function getPreferredAccountToken(accountId: number) {
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, accountId), eq(schema.accountTokens.enabled, true)))
    .all();

  const usableTokens = tokens.filter(isUsableAccountToken);
  if (usableTokens.length === 0) return null;

  const preferred = usableTokens.find((t) => t.isDefault) || usableTokens[0];
  return preferred;
}

export async function ensureDefaultTokenForAccount(
  accountId: number,
  tokenValue: string,
  options?: { name?: string; source?: string; enabled?: boolean; tokenGroup?: string | null },
): Promise<number | null> {
  const normalizedToken = normalizeTokenValue(tokenValue);
  if (!normalizedToken) return null;
  if (isMaskedTokenValue(normalizedToken)) return null;
  const tokenGroup = normalizeTokenGroup(options?.tokenGroup, options?.name) || 'default';

  const now = new Date().toISOString();
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  let target = tokens.find((t) => t.token === normalizedToken) || null;
  if (!target) {
    const inserted = await db.insert(schema.accountTokens)
      .values({
        accountId,
        name: normalizeTokenName(options?.name, tokens.length + 1),
        token: normalizedToken,
        tokenGroup,
        valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
        source: options?.source || 'manual',
        enabled: options?.enabled ?? true,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const insertedId = getInsertedRowId(inserted);
    target = insertedId != null
      ? (await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, insertedId)).get()) ?? null
      : null;
    if (!target) return null;
  } else {
    await db.update(schema.accountTokens)
      .set({
        name: options?.name ? normalizeTokenName(options.name) : target.name,
        tokenGroup,
        valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
        source: options?.source || target.source || 'manual',
        enabled: options?.enabled ?? target.enabled,
        isDefault: true,
        updatedAt: now,
      })
      .where(eq(schema.accountTokens.id, target.id))
      .run();
  }

  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(and(eq(schema.accountTokens.accountId, accountId), ne(schema.accountTokens.id, target.id)))
    .run();

  await updateAccountApiToken(accountId, normalizedToken);
  return target.id;
}

export async function setDefaultToken(tokenId: number): Promise<boolean> {
  const target = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
  if (!target || !isUsableAccountToken(target)) return false;

  const now = new Date().toISOString();
  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(schema.accountTokens.accountId, target.accountId))
    .run();

  await db.update(schema.accountTokens)
    .set({ isDefault: true, enabled: true, updatedAt: now })
    .where(eq(schema.accountTokens.id, tokenId))
    .run();

  await updateAccountApiToken(target.accountId, target.token);
  return true;
}

export async function repairDefaultToken(accountId: number) {
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  const enabled = tokens.filter(isUsableAccountToken);
  if (enabled.length === 0) {
    await updateAccountApiToken(accountId, null);
    return null;
  }

  const currentDefault = enabled.find((t) => t.isDefault) || enabled[0];
  const now = new Date().toISOString();

  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(schema.accountTokens.accountId, accountId))
    .run();

  await db.update(schema.accountTokens)
    .set({ isDefault: true, enabled: true, updatedAt: now })
    .where(eq(schema.accountTokens.id, currentDefault.id))
    .run();

  await updateAccountApiToken(accountId, currentDefault.token);
  return currentDefault;
}

export async function syncTokensFromUpstream(accountId: number, upstreamTokens: UpstreamApiToken[]) {
  const now = new Date().toISOString();
  const existing = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  let created = 0;
  let updated = 0;
  let maskedPending = 0;
  const pendingTokenIds: number[] = [];
  let index = existing.length + 1;

  const removeRowsFromExisting = (rows: AccountTokenRow[]) => {
    for (const row of rows) {
      const rowIndex = existing.findIndex((item) => item.id === row.id);
      if (rowIndex >= 0) existing.splice(rowIndex, 1);
    }
  };

  const deleteStaleMaskedPlaceholders = async (
    target: AccountTokenRow,
    tokenName: string,
    tokenValue: string,
    upstreamTokenId: string | null,
  ) => {
    const staleMaskedPlaceholders = existing.filter((row) => {
      if (row.id === target.id || !isMaskedPendingAccountToken(row)) return false;
      const rowUpstreamTokenId = normalizeIdentityValue(row.upstreamTokenId);
      if (upstreamTokenId && rowUpstreamTokenId === upstreamTokenId) return true;
      return row.name === tokenName && matchesMaskedTokenValue(row.token, tokenValue);
    });

    for (const placeholder of staleMaskedPlaceholders) {
      await db.delete(schema.accountTokens)
        .where(eq(schema.accountTokens.id, placeholder.id))
        .run();
    }
    removeRowsFromExisting(staleMaskedPlaceholders);
  };

  const updateExistingFromUpstream = async (
    target: AccountTokenRow,
    input: {
      tokenName: string;
      tokenValue: string;
      tokenGroup: string | null;
      enabled: boolean;
      nextValueStatus: AccountTokenValueStatus;
      upstreamTokenId: string | null;
      upstreamCreatedAt: string | null;
    },
  ) => {
    const targetWasReady = isReadyAccountToken(target);
    const preserveReadyFullToken = input.nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
      && targetWasReady;
    const storedValueStatus = preserveReadyFullToken
      ? ACCOUNT_TOKEN_VALUE_STATUS_READY
      : input.nextValueStatus;
    const storedToken = preserveReadyFullToken ? target.token : input.tokenValue;
    const storedEnabled = storedValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY
      ? input.enabled
      : false;
    const storedIsDefault = storedValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY && targetWasReady
      ? target.isDefault
      : false;

    await db.update(schema.accountTokens)
      .set({
        name: input.tokenName,
        token: storedToken,
        tokenGroup: input.tokenGroup,
        valueStatus: storedValueStatus,
        upstreamTokenId: input.upstreamTokenId,
        upstreamCreatedAt: input.upstreamCreatedAt,
        source: 'sync',
        enabled: storedEnabled,
        isDefault: storedIsDefault,
        updatedAt: now,
      })
      .where(eq(schema.accountTokens.id, target.id))
      .run();

    target.name = input.tokenName;
    target.token = storedToken;
    target.tokenGroup = input.tokenGroup;
    target.valueStatus = storedValueStatus;
    target.upstreamTokenId = input.upstreamTokenId;
    target.upstreamCreatedAt = input.upstreamCreatedAt;
    target.enabled = storedEnabled;
    target.isDefault = storedIsDefault;
    target.source = 'sync';
    target.updatedAt = now;

    if (storedValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY) {
      await deleteStaleMaskedPlaceholders(target, input.tokenName, input.tokenValue, input.upstreamTokenId);
    }

    return storedValueStatus;
  };

  for (const upstream of upstreamTokens) {
    const tokenValue = normalizeTokenValue(upstream.key);
    if (!tokenValue) continue;
    const tokenName = normalizeTokenName(upstream.name, index);
    const enabled = upstream.enabled ?? true;
    const tokenGroup = normalizeTokenGroup(upstream.tokenGroup, tokenName);
    const upstreamTokenId = normalizeIdentityValue(upstream.upstreamId);
    const upstreamCreatedAt = normalizeIdentityValue(upstream.upstreamCreatedAt);
    const nextValueStatus = isMaskedTokenValue(tokenValue)
      ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
      : ACCOUNT_TOKEN_VALUE_STATUS_READY;
    const updateInput = {
      tokenName,
      tokenValue,
      tokenGroup,
      enabled,
      nextValueStatus,
      upstreamTokenId,
      upstreamCreatedAt,
    };

    const byUpstreamId = upstreamTokenId
      ? existing.find((row) => normalizeIdentityValue(row.upstreamTokenId) === upstreamTokenId)
      : null;
    if (byUpstreamId && isReadyAccountToken(byUpstreamId)) {
      const storedValueStatus = await updateExistingFromUpstream(byUpstreamId, updateInput);
      updated++;
      if (storedValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
        maskedPending++;
        pendingTokenIds.push(byUpstreamId.id);
      }
      continue;
    }

    const byToken = existing.find((row) => (
      row.token === tokenValue
      && resolveAccountTokenValueStatus(row) === ACCOUNT_TOKEN_VALUE_STATUS_READY
    ));
    if (byToken) {
      await updateExistingFromUpstream(byToken, {
        ...updateInput,
        nextValueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
      });
      updated++;
      continue;
    }

    const matchingReadyByMaskedValue = nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
      ? existing.filter((row) => (
        resolveAccountTokenValueStatus(row) === ACCOUNT_TOKEN_VALUE_STATUS_READY
        && matchesMaskedTokenValue(row.token, tokenValue)
        && row.name === tokenName
      ))
      : [];
    const readyMaskedMatch = matchingReadyByMaskedValue.length === 1
      ? matchingReadyByMaskedValue[0]
      : null;
    if (readyMaskedMatch) {
      await updateExistingFromUpstream(readyMaskedMatch, updateInput);
      updated++;
      continue;
    }

    if (byUpstreamId) {
      const storedValueStatus = await updateExistingFromUpstream(byUpstreamId, updateInput);
      updated++;
      if (storedValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
        maskedPending++;
        pendingTokenIds.push(byUpstreamId.id);
      }
      continue;
    }

    const matchingPlaceholder = existing.find((row) => (
      isMaskedPendingAccountToken(row)
      && row.name === tokenName
    ));

    if (matchingPlaceholder) {
      const storedValueStatus = await updateExistingFromUpstream(matchingPlaceholder, updateInput);
      matchingPlaceholder.isDefault = false;
      updated++;
      if (storedValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
        maskedPending++;
        pendingTokenIds.push(matchingPlaceholder.id);
      }
      continue;
    }

    const inserted = await db.insert(schema.accountTokens)
      .values({
        accountId,
        name: tokenName,
        token: tokenValue,
        tokenGroup,
        valueStatus: nextValueStatus,
        upstreamTokenId,
        upstreamCreatedAt,
        source: 'sync',
        enabled: nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY ? enabled : false,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const insertedId = getInsertedRowId(inserted);
    if (insertedId == null) continue;
    const createdRow = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, insertedId)).get();
    if (!createdRow) continue;

    existing.push(createdRow);
    created++;
    index++;
    if (nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
      maskedPending++;
      pendingTokenIds.push(createdRow.id);
    }
  }

  const repaired = await repairDefaultToken(accountId);

  return {
    created,
    updated,
    maskedPending,
    pendingTokenIds,
    total: existing.length,
    defaultTokenId: repaired?.id || null,
  };
}

export async function listTokensWithRelations(accountId?: number) {
  const base = db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id));

  const rows = accountId
    ? await base.where(eq(schema.accountTokens.accountId, accountId)).all()
    : await base.all();

  const groupRatioByAccount = new Map<string, Promise<Awaited<ReturnType<typeof getAccountGroupRatioMap>>>>();
  await Promise.all(
    rows.map((row) => {
      const key = `${row.sites.id}:${row.accounts.id}`;
      if (groupRatioByAccount.has(key)) return groupRatioByAccount.get(key)!;

      const promise = getAccountGroupRatioMap(row.accounts.id, row.sites.id);
      groupRatioByAccount.set(key, promise);
      return promise;
    }),
  );

  const resolvedGroupRatioByAccount = new Map<string, Awaited<ReturnType<typeof getAccountGroupRatioMap>>>();
  for (const [key, promise] of groupRatioByAccount.entries()) {
    resolvedGroupRatioByAccount.set(key, await promise);
  }

  const tokenIds = rows.map((row) => row.account_tokens.id);
  const healthRows: AccountTokenHealthRow[] = tokenIds.length > 0
    ? await db.select()
      .from(schema.accountTokenHealth)
      .where(inArray(schema.accountTokenHealth.tokenId, tokenIds))
      .all()
    : [];
  const healthByTokenId = new Map<number, AccountTokenHealthRow>(
    healthRows.map((row) => [row.tokenId, row]),
  );
  const scheduleContext = getConnectionMaintenanceScheduleContext();
  const modelRows = tokenIds.length > 0
    ? await db.select()
      .from(schema.tokenModelAvailability)
      .where(and(
        inArray(schema.tokenModelAvailability.tokenId, tokenIds),
        eq(schema.tokenModelAvailability.available, true),
      ))
      .all()
    : [];
  const availableModelsByTokenId = new Map<number, Set<string>>();
  for (const row of modelRows) {
    const modelName = row.modelName?.trim();
    if (!modelName) continue;
    const existing = availableModelsByTokenId.get(row.tokenId) || new Set<string>();
    existing.add(modelName);
    availableModelsByTokenId.set(row.tokenId, existing);
  }

  return rows
    .filter((row) => !isApiKeyConnection(row.accounts))
    .map((row) => {
      const { token, tokenGroup, ...tokenMeta } = row.account_tokens;
      const groupRatio = resolvedGroupRatioByAccount.get(`${row.sites.id}:${row.accounts.id}`);
      const ratio = tokenGroup ? groupRatio?.[tokenGroup] : null;
      const groupMultiplier = ratio && typeof ratio.multiplier === 'number'
        ? ratio.multiplier
        : null;
      const valueStatus = resolveAccountTokenValueStatus(row.account_tokens);
      const tokenHealth = healthByTokenId.get(row.account_tokens.id) || null;
      const activeForTokenHealth =
        row.account_tokens.enabled === true
        && valueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY
        && (row.accounts.status || 'active') === 'active'
        && (row.sites.status || 'active') === 'active';
      return {
        ...tokenMeta,
        tokenGroup,
        valueStatus,
        tokenMasked: maskToken(token, row.sites.platform),
        groupMultiplier,
        groupMultiplierRefreshedAt: ratio?.refreshedAt ?? null,
        groupMultiplierLastError: ratio?.lastError ?? null,
        groupMultiplierStale: !!ratio?.lastError,
        availableModels: Array.from(availableModelsByTokenId.get(row.account_tokens.id) || []).sort((left, right) => left.localeCompare(right)),
        health: buildAccountTokenHealthSummary({
          token: row.account_tokens,
          accountStatus: row.accounts.status,
          siteStatus: row.sites.status,
          health: tokenHealth,
          probeModel: resolveAccountTokenProbeModel({
            tokenProbeModel: row.account_tokens.probeModel,
            siteProbeModel: row.sites.tokenHealthProbeModel,
            globalProbeModel: config.tokenHealthProbeModel,
          }),
          staleAfterMs: Math.max(1, Math.trunc(config.tokenHealthStaleHours || 6)) * 60 * 60 * 1000,
        }),
        checkSchedule: buildStageCheckSchedule({
          context: scheduleContext,
          stage: 'tokenHealth',
          subjectEnabled: activeForTokenHealth,
          nextCheckAt: resolveTokenHealthNextCheckAt({
            tokenNextProbeAt: tokenHealth?.nextProbeAt ?? null,
            nextMaintenanceAt: scheduleContext.nextMaintenanceAt,
          }),
        }),
        account: {
          id: row.accounts.id,
          username: row.accounts.username,
          status: row.accounts.status,
        },
        site: {
          id: row.sites.id,
          name: row.sites.name,
          url: row.sites.url,
          platform: row.sites.platform,
        },
      };
    });
}
