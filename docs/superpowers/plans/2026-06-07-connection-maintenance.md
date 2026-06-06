# Connection Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a configurable, retry-safe connection maintenance workflow that periodically refreshes account health, account tokens, token groups, group multipliers, model coverage, route multipliers, and route decision snapshots.

**Architecture:** Add a focused connection maintenance layer that owns configuration, retry policy, singleflight locking, stage ordering, and summaries. Persist group multipliers in a first-class table so account-token UI, route rebuilds, and billing-related route decisions share the same last-known-good source of truth. Keep existing routes and scheduler APIs as thin adapters around service modules.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, sqlite/mysql/postgres runtime compatibility, node-cron, Vitest, React settings page.

---

## File Structure

- Create `src/server/services/connectionMaintenanceConfig.ts`: normalize runtime settings and defaults for connection maintenance.
- Create `src/server/services/maintenanceRetry.ts`: shared retry helper with per-attempt timeout, backoff, and attempt logs.
- Create `src/server/services/accountGroupRatioStore.ts`: CRUD and last-known-good helpers for `account_group_ratios`.
- Create `src/server/services/accountRuntimeHealthRefreshService.ts`: extracted account health refresh logic shared by manual route and maintenance.
- Create `src/server/services/siteAccessRefreshService.ts`: active-site reachability probe with retry summaries that never auto-disables sites.
- Create `src/server/services/groupRatioRefreshService.ts`: fetch and persist token group multipliers per account/site.
- Create `src/server/services/connectionMaintenanceService.ts`: stage orchestration, singleflight lock, stage summaries, forced account snapshot refresh.
- Modify `src/server/db/schema.ts`: add `accountGroupRatios`.
- Modify `src/server/db/index.ts`: add sqlite compatibility creation for the new table and include it in numeric-id tables.
- Modify `src/server/services/databaseMigrationService.ts`: include `account_group_ratios` in backup/restore snapshots.
- Modify `src/server/services/accountTokenService.ts`: read persisted multipliers in `listTokensWithRelations`.
- Modify `src/server/services/modelService.ts`: update route channel multipliers from persisted last-known-good ratios and never overwrite with `1.0` when refresh failed.
- Modify `src/server/services/balanceService.ts`: stop marking `unhealthy` on a single balance refresh failure when called from maintenance.
- Modify `src/server/routes/api/accounts.ts`: replace embedded health refresh implementation with service calls.
- Modify `src/server/services/periodicMaintenanceService.ts`: delegate to `runConnectionMaintenance`.
- Modify `src/server/services/checkinScheduler.ts`: rename runtime semantics to connection maintenance while preserving `balance_refresh_cron` fallback.
- Modify `src/server/config.ts`, `src/server/runtimeSettingsHydration.ts`, `src/server/routes/api/settings.ts`: expose new runtime settings.
- Modify `src/web/pages/Settings.tsx`: add connection maintenance advanced settings.
- Update generated schema artifacts with `npm run schema:generate`.

---

### Task 1: Maintenance Config And Retry Foundation

**Files:**
- Create: `src/server/services/connectionMaintenanceConfig.ts`
- Create: `src/server/services/maintenanceRetry.ts`
- Test: `src/server/services/connectionMaintenanceConfig.test.ts`
- Test: `src/server/services/maintenanceRetry.test.ts`

- [ ] **Step 1: Write failing config tests**

Create `src/server/services/connectionMaintenanceConfig.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONNECTION_MAINTENANCE_CONFIG,
  normalizeConnectionMaintenanceConfig,
} from './connectionMaintenanceConfig.js';

describe('connectionMaintenanceConfig', () => {
  it('uses safe defaults with all stages enabled', () => {
    const config = normalizeConnectionMaintenanceConfig({});
    expect(config).toEqual(DEFAULT_CONNECTION_MAINTENANCE_CONFIG);
    expect(Object.values(config.stages).every(Boolean)).toBe(true);
  });

  it('clamps retry, timeout, and concurrency settings', () => {
    const config = normalizeConnectionMaintenanceConfig({
      enabled: true,
      cron: '*/5 * * * *',
      retryAttempts: 99,
      attemptTimeoutSec: 1,
      concurrency: 99,
      stages: { tokens: false, routeDecisionSnapshots: false },
    });
    expect(config.retryAttempts).toBe(10);
    expect(config.attemptTimeoutSec).toBe(3);
    expect(config.concurrency).toBe(16);
    expect(config.stages.tokens).toBe(false);
    expect(config.stages.routeDecisionSnapshots).toBe(false);
    expect(config.stages.accountHealth).toBe(true);
  });

  it('falls back to the legacy balance cron when no new cron exists', () => {
    const config = normalizeConnectionMaintenanceConfig({}, { legacyBalanceCron: '0 * * * *' });
    expect(config.cron).toBe('0 * * * *');
  });
});
```

- [ ] **Step 2: Write failing retry tests**

Create `src/server/services/maintenanceRetry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runMaintenanceWithRetry } from './maintenanceRetry.js';

describe('runMaintenanceWithRetry', () => {
  it('returns success after a later attempt succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('temporary-1'))
      .mockRejectedValueOnce(new Error('temporary-2'))
      .mockResolvedValueOnce('ok');

    const result = await runMaintenanceWithRetry({
      label: 'token-sync',
      attempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
      run: fn,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('ok');
    expect(result.attempts).toHaveLength(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns failure only after all attempts fail', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('upstream unavailable'));

    const result = await runMaintenanceWithRetry({
      label: 'health-refresh',
      attempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
      run: fn,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('upstream unavailable');
    expect(result.attempts).toHaveLength(5);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- src/server/services/connectionMaintenanceConfig.test.ts src/server/services/maintenanceRetry.test.ts
```

Expected: both test files fail because the new modules do not exist.

- [ ] **Step 4: Implement config module**

Create `src/server/services/connectionMaintenanceConfig.ts`:

```ts
export type ConnectionMaintenanceStageKey =
  | 'siteAccess'
  | 'accountHealth'
  | 'tokens'
  | 'groupRatios'
  | 'modelCoverage'
  | 'routeMultipliers'
  | 'routeDecisionSnapshots'
  | 'accountsSnapshot';

export type ConnectionMaintenanceStages = Record<ConnectionMaintenanceStageKey, boolean>;

export type ConnectionMaintenanceConfig = {
  enabled: boolean;
  cron: string;
  retryAttempts: number;
  attemptTimeoutSec: number;
  concurrency: number;
  stages: ConnectionMaintenanceStages;
};

export const DEFAULT_CONNECTION_MAINTENANCE_STAGES: ConnectionMaintenanceStages = {
  siteAccess: true,
  accountHealth: true,
  tokens: true,
  groupRatios: true,
  modelCoverage: true,
  routeMultipliers: true,
  routeDecisionSnapshots: true,
  accountsSnapshot: true,
};

export const DEFAULT_CONNECTION_MAINTENANCE_CONFIG: ConnectionMaintenanceConfig = {
  enabled: true,
  cron: '0 * * * *',
  retryAttempts: 5,
  attemptTimeoutSec: 15,
  concurrency: 3,
  stages: DEFAULT_CONNECTION_MAINTENANCE_STAGES,
};

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeStages(value: unknown): ConnectionMaintenanceStages {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_CONNECTION_MAINTENANCE_STAGES).map(([key, defaultEnabled]) => [
      key,
      typeof raw[key] === 'boolean' ? raw[key] : defaultEnabled,
    ]),
  ) as ConnectionMaintenanceStages;
}

export function normalizeConnectionMaintenanceConfig(
  value: Partial<ConnectionMaintenanceConfig> | Record<string, unknown>,
  fallback?: { legacyBalanceCron?: string | null },
): ConnectionMaintenanceConfig {
  const cron = typeof value.cron === 'string' && value.cron.trim()
    ? value.cron.trim()
    : (fallback?.legacyBalanceCron || DEFAULT_CONNECTION_MAINTENANCE_CONFIG.cron);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    cron,
    retryAttempts: clampInteger(value.retryAttempts, 5, 1, 10),
    attemptTimeoutSec: clampInteger(value.attemptTimeoutSec, 15, 3, 120),
    concurrency: clampInteger(value.concurrency, 3, 1, 16),
    stages: normalizeStages(value.stages),
  };
}
```

- [ ] **Step 5: Implement retry helper**

Create `src/server/services/maintenanceRetry.ts`:

```ts
export type MaintenanceRetryAttempt = {
  attempt: number;
  ok: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string;
};

export type MaintenanceRetrySuccess<T> = {
  ok: true;
  value: T;
  attempts: MaintenanceRetryAttempt[];
};

export type MaintenanceRetryFailure = {
  ok: false;
  error: string;
  attempts: MaintenanceRetryAttempt[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error || 'unknown error');
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timeout (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runMaintenanceWithRetry<T>(input: {
  label: string;
  attempts: number;
  attemptTimeoutMs: number;
  backoffMs?: (attempt: number) => number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<MaintenanceRetrySuccess<T> | MaintenanceRetryFailure> {
  const maxAttempts = Math.max(1, Math.trunc(input.attempts));
  const attempts: MaintenanceRetryAttempt[] = [];
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = new Date().toISOString();
    try {
      const value = await withTimeout(input.run, input.attemptTimeoutMs, input.label);
      attempts.push({ attempt, ok: true, error: null, startedAt, finishedAt: new Date().toISOString() });
      return { ok: true, value, attempts };
    } catch (error) {
      lastError = errorMessage(error);
      attempts.push({ attempt, ok: false, error: lastError, startedAt, finishedAt: new Date().toISOString() });
      if (attempt < maxAttempts) {
        await sleep(input.backoffMs?.(attempt) ?? Math.min(250 * attempt, 1000));
      }
    }
  }

  return { ok: false, error: lastError, attempts };
}
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
npm test -- src/server/services/connectionMaintenanceConfig.test.ts src/server/services/maintenanceRetry.test.ts
npm run typecheck:server
```

Expected: tests and server typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/services/connectionMaintenanceConfig.ts src/server/services/connectionMaintenanceConfig.test.ts src/server/services/maintenanceRetry.ts src/server/services/maintenanceRetry.test.ts
git commit -m "feat(server): add connection maintenance retry config"
```

---

### Task 2: Persist Account Group Ratios

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/index.ts`
- Modify: `src/server/services/databaseMigrationService.ts`
- Create: `src/server/services/accountGroupRatioStore.ts`
- Test: `src/server/services/accountGroupRatioStore.test.ts`
- Update generated artifacts via `npm run schema:generate`

- [ ] **Step 1: Write failing store tests**

Create `src/server/services/accountGroupRatioStore.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertAccountGroupRatios, getAccountGroupRatioMap } from './accountGroupRatioStore.js';

describe('accountGroupRatioStore', () => {
  let dataDir = '';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-group-ratio-store-'));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
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

    await upsertAccountGroupRatios({
      accountId: account.id,
      siteId: site.id,
      ratios: { default: 1, vip: 0.3 },
      refreshedAt: '2026-06-07T00:00:00.000Z',
    });
    await upsertAccountGroupRatios({
      accountId: account.id,
      siteId: site.id,
      ratios: { vip: 0.25 },
      refreshedAt: '2026-06-07T01:00:00.000Z',
    });

    const ratios = await getAccountGroupRatioMap(account.id, site.id);
    expect(ratios.default?.multiplier).toBe(1);
    expect(ratios.vip?.multiplier).toBe(0.25);
    expect(ratios.vip?.refreshedAt).toBe('2026-06-07T01:00:00.000Z');
    expect(ratios.vip?.failedAttempts).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- src/server/services/accountGroupRatioStore.test.ts
```

Expected: FAIL because `accountGroupRatios` schema and store do not exist.

- [ ] **Step 3: Add schema table**

In `src/server/db/schema.ts`, add after `accountTokens`:

```ts
export const accountGroupRatios = sqliteTable('account_group_ratios', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  groupName: text('group_name').notNull(),
  multiplier: real('multiplier').notNull(),
  refreshedAt: text('refreshed_at'),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  accountSiteGroupUnique: uniqueIndex('account_group_ratios_account_site_group_unique').on(table.accountId, table.siteId, table.groupName),
  accountSiteIdx: index('account_group_ratios_account_site_idx').on(table.accountId, table.siteId),
  siteGroupIdx: index('account_group_ratios_site_group_idx').on(table.siteId, table.groupName),
  multiplierPositive: check('account_group_ratios_multiplier_positive', sql`${table.multiplier} > 0`),
}));
```

In `src/server/db/index.ts`, add `'account_group_ratios'` to `TABLES_WITH_NUMERIC_ID`.

- [ ] **Step 4: Add sqlite compatibility creation**

In `src/server/db/index.ts`, add an `ensureAccountGroupRatiosSchema()` helper near other legacy compatibility helpers:

```ts
function ensureAccountGroupRatiosSchema() {
  if (!tableExists('account_group_ratios')) {
    execSqliteLegacyCompat(`
      CREATE TABLE IF NOT EXISTS account_group_ratios (
        id integer PRIMARY KEY AUTOINCREMENT,
        account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        site_id integer NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        group_name text NOT NULL,
        multiplier real NOT NULL,
        refreshed_at text,
        failed_attempts integer NOT NULL DEFAULT 0,
        last_error text,
        created_at text DEFAULT (datetime('now')),
        updated_at text DEFAULT (datetime('now')),
        CHECK (multiplier > 0)
      );
    `);
  }
  execSqliteLegacyCompat(`CREATE UNIQUE INDEX IF NOT EXISTS account_group_ratios_account_site_group_unique ON account_group_ratios(account_id, site_id, group_name);`);
  execSqliteLegacyCompat(`CREATE INDEX IF NOT EXISTS account_group_ratios_account_site_idx ON account_group_ratios(account_id, site_id);`);
  execSqliteLegacyCompat(`CREATE INDEX IF NOT EXISTS account_group_ratios_site_group_idx ON account_group_ratios(site_id, group_name);`);
}
```

In `initSqliteDb()`, insert `ensureAccountGroupRatiosSchema();` immediately after the existing `ensureRouteGroupingSchema();` call and before `ensureDownstreamApiKeySchema();`:

```ts
  ensureRouteGroupingSchema();
  ensureAccountGroupRatiosSchema();
  ensureDownstreamApiKeySchema();
```

- [ ] **Step 5: Implement store**

Create `src/server/services/accountGroupRatioStore.ts`:

```ts
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

export async function getAccountGroupRatioMap(accountId: number, siteId: number): Promise<Record<string, AccountGroupRatioRecord>> {
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
```

- [ ] **Step 6: Include table in backup/restore**

Modify `src/server/services/databaseMigrationService.ts` in these exact places:

1. Add `accountGroupRatios` to the snapshot type:

```ts
accountGroupRatios: Array<Record<string, unknown>>;
```

2. In `buildSnapshotFromCurrentDatabase()`, read the new table immediately after `accountTokens`:

```ts
accountTokens: await db.select().from(schema.accountTokens).all() as Array<Record<string, unknown>>,
accountGroupRatios: await db.select().from(schema.accountGroupRatios).all() as Array<Record<string, unknown>>,
checkinLogs: await db.select().from(schema.checkinLogs).all() as Array<Record<string, unknown>>,
```

3. In `clearTargetData()`, delete the table before `account_tokens`:

```ts
'account_group_ratios',
'account_tokens',
```

4. In `buildStatements()`, insert rows after the `account_tokens` loop:

```ts
for (const row of (snapshot.accounts.accountGroupRatios || [])) {
  statements.push({
    table: 'account_group_ratios',
    columns: ['id', 'account_id', 'site_id', 'group_name', 'multiplier', 'refreshed_at', 'failed_attempts', 'last_error', 'created_at', 'updated_at'],
    values: [
      asNumber(row.id, 0),
      asNumber(row.accountId, 0),
      asNumber(row.siteId, 0),
      asNullableString(row.groupName) ?? 'default',
      asNumber(row.multiplier, 1),
      asNullableString(row.refreshedAt),
      asNumber(row.failedAttempts, 0),
      asNullableString(row.lastError),
      asNullableString(row.createdAt),
      asNullableString(row.updatedAt),
    ],
  });
}
```

5. In `syncPostgresSequences()`, add:

```ts
'account_group_ratios',
```

6. In the migration summary, add `accountGroupRatios: snapshot.accounts.accountGroupRatios.length`.

Modify `src/server/services/databaseMigrationService.test.ts`:

- Add `accountGroupRatios: { __table: 'accountGroupRatios' },` to the mocked schema object.
- Add `accountGroupRatios: []` to each inline snapshot fixture that currently includes `accountTokens`.
- Add a test that seeds `accountGroupRatios` in the snapshot and asserts an insert into `account_group_ratios` is generated:

```ts
expect(executedSql.some((item) => item.includes('INSERT INTO account_group_ratios'))).toBe(true);
```

- [ ] **Step 7: Regenerate schema artifacts**

Run:

```bash
npm run schema:generate
```

Expected: generated sqlite/mysql/postgres schema artifacts include `account_group_ratios`.

- [ ] **Step 8: Run tests**

Run:

```bash
npm test -- src/server/services/accountGroupRatioStore.test.ts src/server/services/databaseMigrationService.test.ts
npm run typecheck:server
```

Expected: tests and typecheck pass.

- [ ] **Step 9: Commit**

```bash
git add src/server/db src/server/services/accountGroupRatioStore.ts src/server/services/accountGroupRatioStore.test.ts src/server/services/databaseMigrationService.ts src/server/services/databaseMigrationService.test.ts
git commit -m "feat(server): persist account group multipliers"
```

---

### Task 3: Extract Account Health Refresh And Prevent Single-Failure Pollution

**Files:**
- Create: `src/server/services/accountRuntimeHealthRefreshService.ts`
- Modify: `src/server/routes/api/accounts.ts`
- Modify: `src/server/services/balanceService.ts`
- Test: `src/server/services/accountRuntimeHealthRefreshService.test.ts`
- Test: `src/server/services/balanceService.autoRelogin.test.ts`
- Test: `src/server/routes/api/accounts.healthRefreshRuntimeState.test.ts`

- [ ] **Step 1: Write failing health service tests**

Create `src/server/services/accountRuntimeHealthRefreshService.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { refreshRuntimeHealthForAccountRow } from './accountRuntimeHealthRefreshService.js';

const refreshBalanceMock = vi.hoisted(() => vi.fn());
const setAccountRuntimeHealthMock = vi.hoisted(() => vi.fn());

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./accountHealthService.js', async () => {
  const actual = await vi.importActual<typeof import('./accountHealthService.js')>('./accountHealthService.js');
  return {
    ...actual,
    setAccountRuntimeHealth: (...args: unknown[]) => setAccountRuntimeHealthMock(...args),
  };
});

describe('accountRuntimeHealthRefreshService', () => {
  it('marks unhealthy only after the configured retry attempts fail', async () => {
    refreshBalanceMock.mockRejectedValue(new Error('temporary network failure'));
    setAccountRuntimeHealthMock.mockResolvedValue({
      state: 'unhealthy',
      reason: 'temporary network failure',
      source: 'health-refresh',
      checkedAt: '2026-06-07T00:00:00.000Z',
    });

    const result = await refreshRuntimeHealthForAccountRow({
      row: {
        accounts: {
          id: 1,
          username: 'health-user',
          status: 'active',
          accessToken: 'session-token',
          apiToken: 'sk-token',
          extraConfig: null,
        },
        sites: {
          id: 2,
          name: 'health-site',
          status: 'active',
        },
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(refreshBalanceMock).toHaveBeenCalledTimes(5);
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledTimes(1);
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledWith(1, expect.objectContaining({
      state: 'unhealthy',
      source: 'health-refresh',
    }));
    expect(result.status).toBe('failed');
  });

  it('does not mark unhealthy when a later retry succeeds', async () => {
    refreshBalanceMock
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce({ balance: 10, used: 1, quota: 20 });
    setAccountRuntimeHealthMock.mockResolvedValue({
      state: 'healthy',
      reason: '健康检查通过',
      source: 'health-refresh',
      checkedAt: '2026-06-07T00:00:00.000Z',
    });

    const result = await refreshRuntimeHealthForAccountRow({
      row: {
        accounts: {
          id: 1,
          username: 'health-user',
          status: 'active',
          accessToken: 'session-token',
          apiToken: 'sk-token',
          extraConfig: null,
        },
        sites: {
          id: 2,
          name: 'health-site',
          status: 'active',
        },
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(refreshBalanceMock).toHaveBeenCalledTimes(3);
    expect(setAccountRuntimeHealthMock).not.toHaveBeenCalledWith(1, expect.objectContaining({ state: 'unhealthy' }));
    expect(result.status).toBe('success');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- src/server/services/accountRuntimeHealthRefreshService.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement health refresh service**

Create `src/server/services/accountRuntimeHealthRefreshService.ts` by moving the current health refresh helper logic out of `src/server/routes/api/accounts.ts`. Export:

```ts
export type AccountHealthRefreshResult = {
  accountId: number;
  username: string | null;
  siteName: string;
  status: 'success' | 'failed' | 'skipped';
  state: 'healthy' | 'unhealthy' | 'degraded' | 'unknown' | 'disabled';
  message: string;
  attempts?: Array<{ attempt: number; ok: boolean; error: string | null }>;
};

export async function refreshRuntimeHealthForAccountRow(input: {
  row: AccountWithSiteRow;
  retryAttempts: number;
  attemptTimeoutMs: number;
  backoffMs?: (attempt: number) => number;
}): Promise<AccountHealthRefreshResult>;

export async function executeRefreshAccountRuntimeHealth(input?: {
  accountId?: number;
  retryAttempts?: number;
  attemptTimeoutMs?: number;
  concurrency?: number;
}): Promise<{ summary: AccountHealthRefreshSummary; results: AccountHealthRefreshResult[] }>;
```

Use `runMaintenanceWithRetry()` for balance-backed health checks. The service must call `setAccountRuntimeHealth(... unhealthy ...)` only after `runMaintenanceWithRetry()` returns `ok: false`.

- [ ] **Step 4: Update accounts route**

Modify `src/server/routes/api/accounts.ts`:

```ts
import {
  executeRefreshAccountRuntimeHealth,
  summarizeAccountHealthRefresh,
} from '../../services/accountRuntimeHealthRefreshService.js';
```

Remove the local `refreshRuntimeHealthForRow`, `executeRefreshAccountRuntimeHealth`, and `summarizeAccountHealthRefresh` implementations from the route file. Keep request parsing and background task behavior in the route.

- [ ] **Step 5: Prevent balance refresh from writing unhealthy in maintenance mode**

Modify `src/server/services/balanceService.ts`:

```ts
export async function refreshBalance(accountId: number, options: { updateRuntimeHealthOnFailure?: boolean } = {}) {
  const updateRuntimeHealthOnFailure = options.updateRuntimeHealthOnFailure !== false;
  // existing logic
  const handleBalanceError = async (err: any) => {
    const message = appendSessionTokenRebindHint(err?.message || 'unknown error');
    if (updateRuntimeHealthOnFailure) {
      setAccountRuntimeHealth(account.id, {
        state: 'unhealthy',
        reason: message,
        source: 'balance',
      });
    }
    // existing expired-token alert logic remains
    throw new Error(message);
  };
}
```

In `accountRuntimeHealthRefreshService`, call:

```ts
refreshBalance(accountId, { updateRuntimeHealthOnFailure: false })
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- src/server/services/accountRuntimeHealthRefreshService.test.ts src/server/routes/api/accounts.healthRefreshRuntimeState.test.ts src/server/services/balanceService.autoRelogin.test.ts
npm run typecheck:server
```

Expected: tests and server typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/services/accountRuntimeHealthRefreshService.ts src/server/services/accountRuntimeHealthRefreshService.test.ts src/server/routes/api/accounts.ts src/server/routes/api/accounts.healthRefreshRuntimeState.test.ts src/server/services/balanceService.ts src/server/services/balanceService.autoRelogin.test.ts
git commit -m "fix(server): retry account health before marking unhealthy"
```

---

### Task 4: Refresh And Consume Last-Known-Good Group Ratios

**Files:**
- Create: `src/server/services/groupRatioRefreshService.ts`
- Modify: `src/server/services/accountTokenService.ts`
- Modify: `src/server/services/modelService.ts`
- Test: `src/server/services/groupRatioRefreshService.test.ts`
- Test: `src/server/routes/api/accountTokens.sync.test.ts`
- Test: `src/server/services/modelService.test.ts`

- [ ] **Step 1: Write failing group ratio refresh tests**

Create `src/server/services/groupRatioRefreshService.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { refreshGroupRatiosForAccountRow } from './groupRatioRefreshService.js';

const fetchGroupRatioForSiteMock = vi.hoisted(() => vi.fn());
const upsertAccountGroupRatiosMock = vi.hoisted(() => vi.fn());
const markFailureMock = vi.hoisted(() => vi.fn());

vi.mock('./modelPricingService.js', () => ({
  fetchGroupRatioForSite: (...args: unknown[]) => fetchGroupRatioForSiteMock(...args),
}));

vi.mock('./accountGroupRatioStore.js', () => ({
  upsertAccountGroupRatios: (...args: unknown[]) => upsertAccountGroupRatiosMock(...args),
  markAccountGroupRatioRefreshFailure: (...args: unknown[]) => markFailureMock(...args),
}));

describe('groupRatioRefreshService', () => {
  it('persists group ratios after retry success', async () => {
    fetchGroupRatioForSiteMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ default: 1, vip: 0.3 });

    const result = await refreshGroupRatiosForAccountRow({
      row: {
        accounts: { id: 1, username: 'u', accessToken: 'session', apiToken: 'sk', extraConfig: null, status: 'active' },
        sites: { id: 2, name: 'site', url: 'https://site.example.com', platform: 'new-api', status: 'active' },
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(result.status).toBe('synced');
    expect(upsertAccountGroupRatiosMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 1,
      siteId: 2,
      ratios: { default: 1, vip: 0.3 },
    }));
    expect(markFailureMock).not.toHaveBeenCalled();
  });

  it('marks refresh failure without overwriting last-known-good ratios', async () => {
    fetchGroupRatioForSiteMock.mockRejectedValue(new Error('upstream down'));

    const result = await refreshGroupRatiosForAccountRow({
      row: {
        accounts: { id: 1, username: 'u', accessToken: 'session', apiToken: 'sk', extraConfig: null, status: 'active' },
        sites: { id: 2, name: 'site', url: 'https://site.example.com', platform: 'new-api', status: 'active' },
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(result.status).toBe('failed');
    expect(fetchGroupRatioForSiteMock).toHaveBeenCalledTimes(5);
    expect(upsertAccountGroupRatiosMock).not.toHaveBeenCalled();
    expect(markFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 1,
      siteId: 2,
      failedAttempts: 5,
    }));
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- src/server/services/groupRatioRefreshService.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement group ratio refresh service**

Create `src/server/services/groupRatioRefreshService.ts`:

```ts
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
    return { accountId: account.id, siteId: site.id, status: 'skipped', synced: false, groupCount: 0 };
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const result = await runMaintenanceWithRetry({
    label: `group-ratio:${account.id}`,
    attempts: input.retryAttempts,
    attemptTimeoutMs: input.attemptTimeoutMs,
    backoffMs: input.backoffMs,
    run: async () => {
      const ratios = await fetchGroupRatioForSite(site, token, platformUserId);
      if (!ratios || Object.keys(ratios).length === 0) throw new Error('empty group ratio response');
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
    return { accountId: account.id, siteId: site.id, status: 'failed', synced: false, groupCount: 0, message: result.error };
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
}): Promise<{ total: number; synced: number; skipped: number; failed: number; results: GroupRatioRefreshResult[] }> {
  const rows = await db.select().from(schema.accounts)
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
```

- [ ] **Step 4: Use persisted ratios in account token listing**

Modify `src/server/services/accountTokenService.ts` `listTokensWithRelations()`:

```ts
import { getAccountGroupRatioMap } from './accountGroupRatioStore.js';
```

Replace live `fetchGroupRatioForSite()` calls with persisted store reads:

```ts
const ratioMap = await getAccountGroupRatioMap(row.accounts.id, row.sites.id);
const ratio = tokenGroup ? ratioMap[tokenGroup] : null;
const groupMultiplier = ratio?.multiplier ?? null;
return {
  ...tokenMeta,
  tokenGroup,
  groupMultiplier,
  groupMultiplierRefreshedAt: ratio?.refreshedAt ?? null,
  groupMultiplierLastError: ratio?.lastError ?? null,
  groupMultiplierStale: !!ratio?.lastError,
  // existing account/site payload
};
```

- [ ] **Step 5: Use persisted ratios in route rebuild**

Modify `src/server/services/modelService.ts` route rebuild multiplier resolution:

```ts
import { getAccountGroupRatioMap } from './accountGroupRatioStore.js';
```

When collecting group ratios, read from the store instead of calling `fetchGroupRatioForSite()` inside route rebuild. If no stored value exists for a token group, keep the existing channel multiplier for existing automatic channels and use `1.0` only when creating a new channel with no last-known-good value.

The update condition must be:

```ts
if (!existing.manualOverride && channelMultiplier != null && existing.multiplier !== channelMultiplier) {
  await db.update(schema.routeChannels)
    .set({ multiplier: channelMultiplier })
    .where(eq(schema.routeChannels.id, existing.id))
    .run();
}
```

`resolveChannelMultiplier()` should return `number | null`, not `number`.

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- src/server/services/groupRatioRefreshService.test.ts src/server/routes/api/accountTokens.sync.test.ts src/server/services/modelService.test.ts
npm run typecheck:server
```

Expected: tests and server typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/services/groupRatioRefreshService.ts src/server/services/groupRatioRefreshService.test.ts src/server/services/accountTokenService.ts src/server/routes/api/accountTokens.sync.test.ts src/server/services/modelService.ts src/server/services/modelService.test.ts
git commit -m "fix(server): keep last known group multipliers"
```

---

### Task 5: Connection Maintenance Orchestrator And Scheduler Integration

**Files:**
- Create: `src/server/services/siteAccessRefreshService.ts`
- Create: `src/server/services/connectionMaintenanceService.ts`
- Modify: `src/server/services/periodicMaintenanceService.ts`
- Modify: `src/server/services/checkinScheduler.ts`
- Modify: `src/server/services/checkinScheduler.test.ts`
- Test: `src/server/services/siteAccessRefreshService.test.ts`
- Test: `src/server/services/connectionMaintenanceService.test.ts`
- Test: `src/server/services/periodicMaintenanceService.test.ts`

- [ ] **Step 1: Write failing orchestrator tests**

Create `src/server/services/connectionMaintenanceService.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runConnectionMaintenance } from './connectionMaintenanceService.js';

const refreshSiteAccessMock = vi.hoisted(() => vi.fn());
const executeHealthMock = vi.hoisted(() => vi.fn());
const syncAllTokensMock = vi.hoisted(() => vi.fn());
const refreshGroupRatiosMock = vi.hoisted(() => vi.fn());
const refreshRoutesMock = vi.hoisted(() => vi.fn());
const refreshSnapshotsMock = vi.hoisted(() => vi.fn());
const getAccountsSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('./siteAccessRefreshService.js', () => ({ refreshAllSiteAccess: (...args: unknown[]) => refreshSiteAccessMock(...args) }));
vi.mock('./accountRuntimeHealthRefreshService.js', () => ({ executeRefreshAccountRuntimeHealth: (...args: unknown[]) => executeHealthMock(...args) }));
vi.mock('./accountTokenSyncService.js', () => ({ syncAllAccountTokens: (...args: unknown[]) => syncAllTokensMock(...args) }));
vi.mock('./groupRatioRefreshService.js', () => ({ refreshAllAccountGroupRatios: (...args: unknown[]) => refreshGroupRatiosMock(...args) }));
vi.mock('./routeRefreshWorkflow.js', () => ({ refreshModelsAndRebuildRoutes: () => refreshRoutesMock() }));
vi.mock('./routeDecisionRefreshService.js', () => ({ refreshAllRouteDecisionSnapshots: (...args: unknown[]) => refreshSnapshotsMock(...args) }));
vi.mock('./accountsOverviewService.js', () => ({ getAccountsSnapshot: (...args: unknown[]) => getAccountsSnapshotMock(...args) }));

describe('connectionMaintenanceService', () => {
  it('runs enabled stages in dependency order', async () => {
    refreshSiteAccessMock.mockResolvedValue({ total: 0, reachable: 0, failed: 0, results: [] });
    executeHealthMock.mockResolvedValue({ summary: { total: 0 }, results: [] });
    syncAllTokensMock.mockResolvedValue({ summary: { total: 0, synced: 0, skipped: 0, failed: 0 }, results: [] });
    refreshGroupRatiosMock.mockResolvedValue({ total: 0, synced: 0, skipped: 0, failed: 0, results: [] });
    refreshRoutesMock.mockResolvedValue({ refresh: [], rebuild: { models: 0, createdRoutes: 0, createdChannels: 0, updatedChannels: 0, removedChannels: 0, removedRoutes: 0 } });
    refreshSnapshotsMock.mockResolvedValue({ exactModelCount: 0, wildcardRouteCount: 0 });
    getAccountsSnapshotMock.mockResolvedValue({ cacheStatus: 'miss' });

    const result = await runConnectionMaintenance({
      config: {
        enabled: true,
        cron: '0 * * * *',
        retryAttempts: 5,
        attemptTimeoutSec: 15,
        concurrency: 3,
        stages: {
          siteAccess: true,
          accountHealth: true,
          tokens: true,
          groupRatios: true,
          modelCoverage: true,
          routeMultipliers: true,
          routeDecisionSnapshots: true,
          accountsSnapshot: true,
        },
      },
    });

    expect(result.skipped).toBe(false);
    expect(refreshSiteAccessMock.mock.invocationCallOrder[0]).toBeLessThan(executeHealthMock.mock.invocationCallOrder[0]);
    expect(executeHealthMock.mock.invocationCallOrder[0]).toBeLessThan(syncAllTokensMock.mock.invocationCallOrder[0]);
    expect(refreshGroupRatiosMock.mock.invocationCallOrder[0]).toBeLessThan(refreshRoutesMock.mock.invocationCallOrder[0]);
    expect(refreshRoutesMock.mock.invocationCallOrder[0]).toBeLessThan(refreshSnapshotsMock.mock.invocationCallOrder[0]);
    expect(getAccountsSnapshotMock).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('skips overlapping runs', async () => {
    let release!: () => void;
    refreshSiteAccessMock.mockReturnValue(new Promise((resolve) => {
      release = () => resolve([]);
    }));

    const first = runConnectionMaintenance();
    const second = await runConnectionMaintenance();
    release();
    await first;

    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already_running');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- src/server/services/connectionMaintenanceService.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement orchestrator**

Create `src/server/services/siteAccessRefreshService.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { runMaintenanceWithRetry } from './maintenanceRetry.js';

export type SiteAccessRefreshResult = {
  siteId: number;
  siteName: string;
  url: string;
  status: 'reachable' | 'failed' | 'skipped';
  latencyMs: number | null;
  error: string | null;
  attempts: Array<{ attempt: number; ok: boolean; error: string | null }>;
};

async function probeSiteUrl(url: string, signal: AbortSignal): Promise<number> {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
  });
  if (response.status >= 500) {
    throw new Error(`HTTP ${response.status}`);
  }
  return Date.now() - started;
}

export async function refreshSiteAccessForRow(input: {
  site: typeof schema.sites.$inferSelect;
  retryAttempts: number;
  attemptTimeoutMs: number;
  backoffMs?: (attempt: number) => number;
}): Promise<SiteAccessRefreshResult> {
  const url = String(input.site.url || '').trim();
  if (!url || (input.site.status || 'active') === 'disabled') {
    return {
      siteId: input.site.id,
      siteName: input.site.name,
      url,
      status: 'skipped',
      latencyMs: null,
      error: url ? 'site disabled' : 'missing site url',
      attempts: [],
    };
  }

  const result = await runMaintenanceWithRetry({
    label: `site-access:${input.site.id}`,
    attempts: input.retryAttempts,
    attemptTimeoutMs: input.attemptTimeoutMs,
    backoffMs: input.backoffMs,
    run: async (signal) => probeSiteUrl(url, signal),
  });

  return {
    siteId: input.site.id,
    siteName: input.site.name,
    url,
    status: result.ok ? 'reachable' : 'failed',
    latencyMs: result.ok ? result.value : null,
    error: result.ok ? null : result.error,
    attempts: result.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      ok: attempt.ok,
      error: attempt.error,
    })),
  };
}

export async function refreshAllSiteAccess(options?: {
  retryAttempts?: number;
  attemptTimeoutMs?: number;
  concurrency?: number;
}) {
  const retryAttempts = options?.retryAttempts || 5;
  const attemptTimeoutMs = options?.attemptTimeoutMs || 15_000;
  const concurrency = options?.concurrency || 3;
  const sites = await db.select().from(schema.sites).where(eq(schema.sites.status, 'active')).all();
  const results: SiteAccessRefreshResult[] = [];

  for (let offset = 0; offset < sites.length; offset += concurrency) {
    const batch = sites.slice(offset, offset + concurrency);
    results.push(...await Promise.all(batch.map((site) => refreshSiteAccessForRow({
      site,
      retryAttempts,
      attemptTimeoutMs,
    }))));
  }

  return {
    total: results.length,
    reachable: results.filter((item) => item.status === 'reachable').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    results,
  };
}
```

Do not update `sites.status` in this service. `sites.status` remains the manual enable/disable flag controlled by the Sites page.

Create `src/server/services/connectionMaintenanceService.ts`:

```ts
import { config as runtimeConfig } from '../config.js';
import { getAccountsSnapshot } from './accountsOverviewService.js';
import { executeRefreshAccountRuntimeHealth } from './accountRuntimeHealthRefreshService.js';
import { syncAllAccountTokens } from './accountTokenSyncService.js';
import {
  DEFAULT_CONNECTION_MAINTENANCE_CONFIG,
  type ConnectionMaintenanceConfig,
} from './connectionMaintenanceConfig.js';
import { refreshAllAccountGroupRatios } from './groupRatioRefreshService.js';
import { refreshAllRouteDecisionSnapshots } from './routeDecisionRefreshService.js';
import { refreshAllSiteAccess } from './siteAccessRefreshService.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';

let running: Promise<ConnectionMaintenanceResult> | null = null;

export type ConnectionMaintenanceResult = {
  skipped: boolean;
  reason?: 'disabled' | 'already_running';
  startedAt: string;
  finishedAt: string;
  stages: Record<string, unknown>;
  summary: Record<string, unknown>;
};

function activeConfig(input?: ConnectionMaintenanceConfig): ConnectionMaintenanceConfig {
  return input || {
    ...DEFAULT_CONNECTION_MAINTENANCE_CONFIG,
    cron: runtimeConfig.balanceRefreshCron,
  };
}

async function execute(config: ConnectionMaintenanceConfig): Promise<ConnectionMaintenanceResult> {
  const startedAt = new Date().toISOString();
  const stages: Record<string, unknown> = {};

  if (!config.enabled) {
    return { skipped: true, reason: 'disabled', startedAt, finishedAt: new Date().toISOString(), stages, summary: {} };
  }

  if (config.stages.siteAccess) {
    stages.siteAccess = await refreshAllSiteAccess({
      retryAttempts: config.retryAttempts,
      attemptTimeoutMs: config.attemptTimeoutSec * 1000,
      concurrency: config.concurrency,
    });
  }

  if (config.stages.accountHealth) {
    stages.accountHealth = await executeRefreshAccountRuntimeHealth({
      retryAttempts: config.retryAttempts,
      attemptTimeoutMs: config.attemptTimeoutSec * 1000,
      concurrency: config.concurrency,
    });
  }

  if (config.stages.tokens) {
    stages.tokens = await syncAllAccountTokens({
      retryAttempts: config.retryAttempts,
      attemptTimeoutMs: config.attemptTimeoutSec * 1000,
      concurrency: config.concurrency,
    });
  }

  if (config.stages.groupRatios) {
    stages.groupRatios = await refreshAllAccountGroupRatios({
      retryAttempts: config.retryAttempts,
      attemptTimeoutMs: config.attemptTimeoutSec * 1000,
      concurrency: config.concurrency,
    });
  }

  if (config.stages.modelCoverage || config.stages.routeMultipliers) {
    stages.routeRefresh = await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
  }

  if (config.stages.routeDecisionSnapshots) {
    stages.routeDecisionSnapshots = await refreshAllRouteDecisionSnapshots({ refreshPricingCatalog: true });
  }

  if (config.stages.accountsSnapshot) {
    stages.accountsSnapshot = await getAccountsSnapshot({ forceRefresh: true });
  }

  return {
    skipped: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    stages,
    summary: stages,
  };
}

export async function runConnectionMaintenance(input?: { config?: ConnectionMaintenanceConfig }): Promise<ConnectionMaintenanceResult> {
  if (running) {
    return {
      skipped: true,
      reason: 'already_running',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stages: {},
      summary: {},
    };
  }
  running = execute(activeConfig(input?.config));
  try {
    return await running;
  } finally {
    running = null;
  }
}
```

Do not call `refreshAllBalances()` from `connectionMaintenanceService`. Balance-backed health refresh is owned by `executeRefreshAccountRuntimeHealth()`, which calls `refreshBalance(accountId, { updateRuntimeHealthOnFailure: false })` and applies unhealthy state only after retry exhaustion.

- [ ] **Step 4: Update token sync signature**

Modify `src/server/services/accountTokenSyncService.ts`:

```ts
export async function syncAllAccountTokens(options?: {
  retryAttempts?: number;
  attemptTimeoutMs?: number;
  concurrency?: number;
}) {
  const batchSize = options?.concurrency || ACCOUNT_TOKEN_SYNC_ALL_BATCH_SIZE;
  // use runMaintenanceWithRetry around syncAccountTokensForRow
}
```

Each row should return failed only after retry attempts are exhausted.

- [ ] **Step 5: Delegate periodic maintenance**

Modify `src/server/services/periodicMaintenanceService.ts`:

```ts
import { runConnectionMaintenance } from './connectionMaintenanceService.js';

export async function runPeriodicMaintenance() {
  return runConnectionMaintenance();
}
```

Update `src/server/services/periodicMaintenanceService.test.ts` so it asserts the wrapper delegates to `runConnectionMaintenance`.

- [ ] **Step 6: Update scheduler log wording**

Modify `src/server/services/checkinScheduler.ts` log strings:

```ts
console.log(`[Scheduler] Running connection maintenance at ${new Date().toISOString()}`);
console.log(`[Scheduler] Connection maintenance complete: ...`);
```

Keep the existing function `updateBalanceRefreshCron` as a compatibility wrapper and add:

```ts
export function updateConnectionMaintenanceCron(cronExpr: string) {
  updateBalanceRefreshCron(cronExpr);
}
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- src/server/services/connectionMaintenanceService.test.ts src/server/services/periodicMaintenanceService.test.ts src/server/services/checkinScheduler.test.ts src/server/routes/api/accountTokens.sync.test.ts
npm run typecheck:server
```

Expected: tests and typecheck pass.

- [ ] **Step 8: Commit**

```bash
git add src/server/services/connectionMaintenanceService.ts src/server/services/connectionMaintenanceService.test.ts src/server/services/periodicMaintenanceService.ts src/server/services/periodicMaintenanceService.test.ts src/server/services/checkinScheduler.ts src/server/services/checkinScheduler.test.ts src/server/services/accountTokenSyncService.ts src/server/routes/api/accountTokens.sync.test.ts
git commit -m "feat(server): orchestrate connection maintenance"
```

---

### Task 6: Runtime Settings API And Settings Page

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/runtimeSettingsHydration.ts`
- Modify: `src/server/routes/api/settings.ts`
- Modify: `src/web/pages/Settings.tsx`
- Test: `src/server/routes/api/settings.test.ts`
- Test: `src/web/pages/settings.connection-maintenance.test.tsx`

- [ ] **Step 1: Write failing settings API tests**

Add to `src/server/routes/api/settings.test.ts`:

```ts
it('saves connection maintenance runtime settings', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/settings/runtime',
    headers: { authorization: `Bearer ${authToken}` },
    payload: {
      connectionMaintenanceEnabled: true,
      connectionMaintenanceCron: '*/15 * * * *',
      connectionMaintenanceRetryAttempts: 5,
      connectionMaintenanceAttemptTimeoutSec: 20,
      connectionMaintenanceConcurrency: 4,
      connectionMaintenanceStages: {
        siteAccess: true,
        accountHealth: true,
        tokens: true,
        groupRatios: true,
        modelCoverage: true,
        routeMultipliers: true,
        routeDecisionSnapshots: true,
        accountsSnapshot: true,
      },
    },
  });

  expect(response.statusCode).toBe(200);
  const runtimeResponse = await app.inject({
    method: 'GET',
    url: '/api/settings/runtime',
    headers: { authorization: `Bearer ${authToken}` },
  });
  const body = runtimeResponse.json();
  expect(body.connectionMaintenanceCron).toBe('*/15 * * * *');
  expect(body.connectionMaintenanceRetryAttempts).toBe(5);
  expect(body.connectionMaintenanceAttemptTimeoutSec).toBe(20);
  expect(body.connectionMaintenanceConcurrency).toBe(4);
  expect(body.connectionMaintenanceStages.groupRatios).toBe(true);
});
```

- [ ] **Step 2: Run API test to verify failure**

Run:

```bash
npm test -- src/server/routes/api/settings.test.ts
```

Expected: FAIL because runtime settings do not include connection maintenance fields.

- [ ] **Step 3: Add config fields**

Modify `src/server/config.ts` in `buildConfig()`:

```ts
connectionMaintenanceEnabled: parseBoolean(env.CONNECTION_MAINTENANCE_ENABLED, true),
connectionMaintenanceCron: env.CONNECTION_MAINTENANCE_CRON || env.BALANCE_REFRESH_CRON || '0 * * * *',
connectionMaintenanceRetryAttempts: Math.min(10, Math.max(1, Math.trunc(parseNumber(env.CONNECTION_MAINTENANCE_RETRY_ATTEMPTS, 5)))),
connectionMaintenanceAttemptTimeoutSec: Math.min(120, Math.max(3, Math.trunc(parseNumber(env.CONNECTION_MAINTENANCE_ATTEMPT_TIMEOUT_SEC, 15)))),
connectionMaintenanceConcurrency: Math.min(16, Math.max(1, Math.trunc(parseNumber(env.CONNECTION_MAINTENANCE_CONCURRENCY, 3)))),
connectionMaintenanceStages: normalizeConnectionMaintenanceConfig({}).stages,
```

Import `normalizeConnectionMaintenanceConfig`.

- [ ] **Step 4: Hydrate runtime settings**

Modify `src/server/runtimeSettingsHydration.ts` to parse:

```ts
connection_maintenance_enabled
connection_maintenance_cron
connection_maintenance_retry_attempts
connection_maintenance_attempt_timeout_sec
connection_maintenance_concurrency
connection_maintenance_stages
```

Use `normalizeConnectionMaintenanceConfig()` before assigning to `config`.

- [ ] **Step 5: Add settings route fields**

Modify `src/server/contracts/settingsRoutePayloads.ts` runtime payload schema:

```ts
const connectionMaintenanceStagesSchema = z.record(z.string(), z.boolean());

const runtimeSettingsPayloadSchema = z.object({
  modelAvailabilityProbeEnabled: z.boolean().optional(),
  connectionMaintenanceEnabled: z.boolean().optional(),
  connectionMaintenanceCron: z.string().optional(),
  connectionMaintenanceRetryAttempts: z.number().optional(),
  connectionMaintenanceAttemptTimeoutSec: z.number().optional(),
  connectionMaintenanceConcurrency: z.number().optional(),
  connectionMaintenanceStages: connectionMaintenanceStagesSchema.optional(),
  webhookEnabled: z.boolean().optional(),
  barkEnabled: z.boolean().optional(),
  serverChanEnabled: z.boolean().optional(),
  telegramEnabled: z.boolean().optional(),
  telegramUseSystemProxy: z.boolean().optional(),
  smtpEnabled: z.boolean().optional(),
  smtpSecure: z.boolean().optional(),
  logCleanupUsageLogsEnabled: z.boolean().optional(),
  logCleanupProgramLogsEnabled: z.boolean().optional(),
}).passthrough();
```

Add formatter cases:

```ts
if (firstPath === 'connectionMaintenanceEnabled') {
  return '连接维护开关格式无效：需要 boolean';
}
if (firstPath === 'connectionMaintenanceCron') {
  return '连接维护 Cron 格式无效：需要 string';
}
if (firstPath === 'connectionMaintenanceRetryAttempts') {
  return '连接维护重试次数格式无效：需要 number';
}
if (firstPath === 'connectionMaintenanceAttemptTimeoutSec') {
  return '连接维护单次超时格式无效：需要 number';
}
if (firstPath === 'connectionMaintenanceConcurrency') {
  return '连接维护并发格式无效：需要 number';
}
if (firstPath === 'connectionMaintenanceStages') {
  return '连接维护阶段配置格式无效：需要对象，值为 boolean';
}
```

Modify `src/server/routes/api/settings.ts` `RuntimeSettingsBody`:

```ts
connectionMaintenanceEnabled?: boolean;
connectionMaintenanceCron?: string;
connectionMaintenanceRetryAttempts?: number;
connectionMaintenanceAttemptTimeoutSec?: number;
connectionMaintenanceConcurrency?: number;
connectionMaintenanceStages?: Record<string, boolean>;
```

Modify `src/server/routes/api/settings.ts` runtime GET response to include:

```ts
connectionMaintenanceEnabled: config.connectionMaintenanceEnabled,
connectionMaintenanceCron: config.connectionMaintenanceCron,
connectionMaintenanceRetryAttempts: config.connectionMaintenanceRetryAttempts,
connectionMaintenanceAttemptTimeoutSec: config.connectionMaintenanceAttemptTimeoutSec,
connectionMaintenanceConcurrency: config.connectionMaintenanceConcurrency,
connectionMaintenanceStages: config.connectionMaintenanceStages,
```

In the `PUT /api/settings/runtime` handler, insert this block after the legacy `balanceRefreshCron` block:

```ts
const connectionMaintenanceTouched =
  body.connectionMaintenanceEnabled !== undefined
  || body.connectionMaintenanceCron !== undefined
  || body.connectionMaintenanceRetryAttempts !== undefined
  || body.connectionMaintenanceAttemptTimeoutSec !== undefined
  || body.connectionMaintenanceConcurrency !== undefined
  || body.connectionMaintenanceStages !== undefined;

if (connectionMaintenanceTouched) {
  const readBoundedInteger = (value: unknown, fallback: number, min: number, max: number, label: string): number => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${label}必须是 ${min} 到 ${max} 的整数`);
    }
    return parsed;
  };

  const nextCron = body.connectionMaintenanceCron !== undefined
    ? String(body.connectionMaintenanceCron || '').trim()
    : config.connectionMaintenanceCron;
  if (!cron.validate(nextCron)) {
    return reply.code(400).send({ success: false, message: '连接维护 Cron 表达式无效' });
  }

  let nextRetryAttempts: number;
  let nextAttemptTimeoutSec: number;
  let nextConcurrency: number;
  try {
    nextRetryAttempts = readBoundedInteger(body.connectionMaintenanceRetryAttempts, config.connectionMaintenanceRetryAttempts, 1, 10, '连接维护重试次数');
    nextAttemptTimeoutSec = readBoundedInteger(body.connectionMaintenanceAttemptTimeoutSec, config.connectionMaintenanceAttemptTimeoutSec, 3, 120, '连接维护单次超时');
    nextConcurrency = readBoundedInteger(body.connectionMaintenanceConcurrency, config.connectionMaintenanceConcurrency, 1, 16, '连接维护并发');
  } catch (error: any) {
    return reply.code(400).send({ success: false, message: error?.message || '连接维护配置无效' });
  }

  const nextConfig = normalizeConnectionMaintenanceConfig({
    enabled: body.connectionMaintenanceEnabled ?? config.connectionMaintenanceEnabled,
    cron: nextCron,
    retryAttempts: nextRetryAttempts,
    attemptTimeoutSec: nextAttemptTimeoutSec,
    concurrency: nextConcurrency,
    stages: body.connectionMaintenanceStages ?? config.connectionMaintenanceStages,
  });

  config.connectionMaintenanceEnabled = nextConfig.enabled;
  config.connectionMaintenanceCron = nextConfig.cron;
  config.connectionMaintenanceRetryAttempts = nextConfig.retryAttempts;
  config.connectionMaintenanceAttemptTimeoutSec = nextConfig.attemptTimeoutSec;
  config.connectionMaintenanceConcurrency = nextConfig.concurrency;
  config.connectionMaintenanceStages = nextConfig.stages;

  updateConnectionMaintenanceCron(nextConfig.cron);
  upsertSetting('connection_maintenance_enabled', nextConfig.enabled);
  upsertSetting('connection_maintenance_cron', nextConfig.cron);
  upsertSetting('connection_maintenance_retry_attempts', nextConfig.retryAttempts);
  upsertSetting('connection_maintenance_attempt_timeout_sec', nextConfig.attemptTimeoutSec);
  upsertSetting('connection_maintenance_concurrency', nextConfig.concurrency);
  upsertSetting('connection_maintenance_stages', nextConfig.stages);
  changedLabels.push('连接维护计划');
}
```

Import `normalizeConnectionMaintenanceConfig` from `src/server/services/connectionMaintenanceConfig.ts` and `updateConnectionMaintenanceCron` from `src/server/services/checkinScheduler.ts`.

- [ ] **Step 6: Add frontend state and form**

Modify `src/web/pages/Settings.tsx` `RuntimeSettings` type:

```ts
connectionMaintenanceEnabled: boolean;
connectionMaintenanceCron: string;
connectionMaintenanceRetryAttempts: number;
connectionMaintenanceAttemptTimeoutSec: number;
connectionMaintenanceConcurrency: number;
connectionMaintenanceStages: Record<string, boolean>;
```

In `loadSettings()`, populate from runtime response with defaults:

```ts
connectionMaintenanceEnabled: runtimeInfo.connectionMaintenanceEnabled !== false,
connectionMaintenanceCron: runtimeInfo.connectionMaintenanceCron || runtimeInfo.balanceRefreshCron || '0 * * * *',
connectionMaintenanceRetryAttempts: Math.min(10, Math.max(1, Math.trunc(Number(runtimeInfo.connectionMaintenanceRetryAttempts) || 5))),
connectionMaintenanceAttemptTimeoutSec: Math.min(120, Math.max(3, Math.trunc(Number(runtimeInfo.connectionMaintenanceAttemptTimeoutSec) || 15))),
connectionMaintenanceConcurrency: Math.min(16, Math.max(1, Math.trunc(Number(runtimeInfo.connectionMaintenanceConcurrency) || 3))),
connectionMaintenanceStages: runtimeInfo.connectionMaintenanceStages || DEFAULT_CONNECTION_MAINTENANCE_STAGES,
```

Add a settings card below the existing scheduled tasks section titled `连接维护`. It contains:

- checkbox for enabled
- cron input
- number inputs for retry attempts, attempt timeout, concurrency
- checkboxes for stage names
- helper text that `balance_refresh_cron` remains fallback

- [ ] **Step 7: Write frontend test**

Create `src/web/pages/settings.connection-maintenance.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import Settings from './Settings.js';

vi.mock('../lib/api.js', () => ({
  api: {
    getAuthInfo: vi.fn().mockResolvedValue({ masked: '****' }),
    getRuntimeSettings: vi.fn().mockResolvedValue({
      connectionMaintenanceEnabled: true,
      connectionMaintenanceCron: '*/15 * * * *',
      connectionMaintenanceRetryAttempts: 5,
      connectionMaintenanceAttemptTimeoutSec: 20,
      connectionMaintenanceConcurrency: 4,
      connectionMaintenanceStages: { accountHealth: true, tokens: true, groupRatios: true },
    }),
    getRuntimeDatabaseConfig: vi.fn().mockResolvedValue({}),
    updateRuntimeSettings: vi.fn().mockResolvedValue({ success: true }),
  },
}));

describe('Settings connection maintenance', () => {
  it('renders connection maintenance advanced settings', async () => {
    let root: any;
    await act(async () => {
      root = create(<Settings />);
    });
    const text = JSON.stringify(root.toJSON());
    expect(text).toContain('连接维护');
    expect(text).toContain('*/15 * * * *');
    expect(text).toContain('重试次数');
    expect(text).toContain('并发');
  });
});
```

- [ ] **Step 8: Run tests**

Run:

```bash
npm test -- src/server/routes/api/settings.test.ts src/web/pages/settings.connection-maintenance.test.tsx
npm run typecheck
```

Expected: tests and full typecheck pass.

- [ ] **Step 9: Commit**

```bash
git add src/server/config.ts src/server/runtimeSettingsHydration.ts src/server/routes/api/settings.ts src/server/routes/api/settings.test.ts src/web/pages/Settings.tsx src/web/pages/settings.connection-maintenance.test.tsx
git commit -m "feat(settings): configure connection maintenance"
```

---

### Task 7: Final Integration Verification

**Files:**
- Modify tests only if final integration exposes a missing assertion.
- No production code changes unless a previous task left a verified bug.

- [ ] **Step 1: Run focused backend suite**

Run:

```bash
npm test -- src/server/services/connectionMaintenanceConfig.test.ts src/server/services/maintenanceRetry.test.ts src/server/services/accountGroupRatioStore.test.ts src/server/services/accountRuntimeHealthRefreshService.test.ts src/server/services/groupRatioRefreshService.test.ts src/server/services/connectionMaintenanceService.test.ts src/server/services/periodicMaintenanceService.test.ts src/server/services/checkinScheduler.test.ts src/server/routes/api/accountTokens.sync.test.ts src/server/services/modelService.test.ts src/server/routes/api/accounts.healthRefreshRuntimeState.test.ts src/server/routes/api/settings.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run frontend settings and multiplier tests**

Run:

```bash
npm test -- src/web/pages/settings.connection-maintenance.test.tsx src/web/pages/helpers/multiplierFormat.test.ts src/web/pages/accounts.segmented-connections.test.tsx src/web/pages/tokens.edit-and-select.test.tsx
```

Expected: all listed tests pass.

- [ ] **Step 3: Run typechecks**

Run:

```bash
npm run typecheck
```

Expected: all TypeScript projects pass.

- [ ] **Step 4: Run build-sensitive check**

Run:

```bash
npm run build:server
```

Expected: server builds and generated runtime DB files copy successfully.

- [ ] **Step 5: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- status only shows intended files.
- diff contains no whitespace errors.
- generated schema artifacts are included if `schema:generate` changed them.

- [ ] **Step 6: Confirm no final verification edits remain**

Run:

```bash
git status --short
```

Expected: no uncommitted files remain after the task commits above. If this command shows files, do not create a generic final commit. Return to the task that owns those files, make the fix there, rerun that task's tests, and amend or create the task-specific commit named in that task.

---

## Self-Review

Spec coverage:

- Configurable Cron, retry count, timeout, concurrency, and stage toggles are covered in Task 1 and Task 6.
- Five-attempt failure semantics are covered in Task 1, Task 3, Task 4, and Task 5.
- Persisted last-known-good group multipliers are covered in Task 2 and Task 4.
- Account health periodic refresh is covered in Task 3 and Task 5.
- Scheduler singleflight is covered in Task 5.
- Settings page placement is covered in Task 6.
- Snapshot refresh and route decision refresh are covered in Task 5.
- Verification is covered in Task 7.

Completeness scan:

- This plan contains no unresolved implementation gaps.

Type consistency:

- Runtime setting keys use snake_case in the database and camelCase over the settings API.
- Service types use `ConnectionMaintenanceConfig`, `ConnectionMaintenanceStages`, and `AccountHealthRefreshResult` consistently.
- Group ratio storage uses `accountGroupRatios` in Drizzle and `account_group_ratios` in SQL.
