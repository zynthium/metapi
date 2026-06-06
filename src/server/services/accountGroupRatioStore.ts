import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export type AccountGroupRatioRecord = {
  accountId: number;
  siteId: number;
  groupName: string;
  multiplier: number;
  refreshedAt: string | null;
  failedAttempts: number;
  lastError: string | null;
};

function normalizeGroupName(value: string): string {
  return value.trim() || 'default';
}

function normalizeMultiplier(value: unknown): number | null {
  const multiplier = Number(value);
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : null;
}

export async function upsertAccountGroupRatios(input: {
  accountId: number;
  siteId: number;
  ratios: Record<string, number>;
  refreshedAt?: string;
}): Promise<void> {
  const refreshedAt = input.refreshedAt || new Date().toISOString();
  for (const [rawGroupName, rawMultiplier] of Object.entries(input.ratios)) {
    const groupName = normalizeGroupName(rawGroupName);
    const multiplier = normalizeMultiplier(rawMultiplier);
    if (!multiplier) continue;

    const existing = await db.select().from(schema.accountGroupRatios).where(and(
      eq(schema.accountGroupRatios.accountId, input.accountId),
      eq(schema.accountGroupRatios.siteId, input.siteId),
      eq(schema.accountGroupRatios.groupName, groupName),
    )).get();

    if (existing) {
      await db.update(schema.accountGroupRatios).set({
        multiplier,
        refreshedAt,
        failedAttempts: 0,
        lastError: null,
        updatedAt: refreshedAt,
      }).where(eq(schema.accountGroupRatios.id, existing.id)).run();
      continue;
    }

    await db.insert(schema.accountGroupRatios).values({
      accountId: input.accountId,
      siteId: input.siteId,
      groupName,
      multiplier,
      refreshedAt,
      failedAttempts: 0,
      lastError: null,
      createdAt: refreshedAt,
      updatedAt: refreshedAt,
    }).run();
  }
}

export async function markAccountGroupRatioRefreshFailure(input: {
  accountId: number;
  siteId: number;
  groupNames?: string[];
  error: string;
  failedAttempts: number;
}): Promise<void> {
  const rows = await db.select().from(schema.accountGroupRatios).where(and(
    eq(schema.accountGroupRatios.accountId, input.accountId),
    eq(schema.accountGroupRatios.siteId, input.siteId),
  )).all();
  const groupFilter = input.groupNames && input.groupNames.length > 0
    ? new Set(input.groupNames.map(normalizeGroupName))
    : null;
  const now = new Date().toISOString();
  for (const row of rows) {
    if (groupFilter && !groupFilter.has(row.groupName)) continue;
    await db.update(schema.accountGroupRatios).set({
      failedAttempts: input.failedAttempts,
      lastError: input.error.slice(0, 500),
      updatedAt: now,
    }).where(eq(schema.accountGroupRatios.id, row.id)).run();
  }
}

export async function getAccountGroupRatioMap(
  accountId: number,
  siteId: number,
): Promise<Record<string, AccountGroupRatioRecord>> {
  const rows = await db.select().from(schema.accountGroupRatios).where(and(
    eq(schema.accountGroupRatios.accountId, accountId),
    eq(schema.accountGroupRatios.siteId, siteId),
  )).all();
  return Object.fromEntries(rows.map((row) => [row.groupName, {
    accountId: row.accountId,
    siteId: row.siteId,
    groupName: row.groupName,
    multiplier: row.multiplier,
    refreshedAt: row.refreshedAt,
    failedAttempts: row.failedAttempts || 0,
    lastError: row.lastError,
  }]));
}
