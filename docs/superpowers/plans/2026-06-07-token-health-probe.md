# Token Health Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build independent account-token health probing with token/site/global probe-model inheritance, low-cost scheduled probes, real request health feedback, API exposure, and account-token UI status.

**Architecture:** Add a focused token-health service with its own persistent status table, while keeping token model coverage in `token_model_availability`. Store the per-token probe-model override on `account_tokens`, site default on `sites`, and global default in runtime settings. Feed health from both active proxy traffic and a connection-maintenance stage that only probes stale, failed, or never-checked tokens.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, sqlite/mysql/postgres runtime compatibility, node-cron connection maintenance, Vitest, React.

---

## File Structure

- Modify `src/server/db/schema.ts`: add `accountTokenHealth`, `account_tokens.probe_model`, and `sites.token_health_probe_model`.
- Modify `src/server/db/index.ts`: add SQLite compatibility DDL for the new table/columns and numeric-id table registration.
- Add migration SQL under `drizzle/`: add `account_token_health` table and probe-model columns.
- Regenerate schema artifacts with `npm run schema:generate`.
- Create `src/server/services/accountTokenHealthService.ts`: status derivation, inheritance resolution, probe queue selection, success/failure recording, manual/scheduled probe execution.
- Modify `src/server/services/runtimeModelProbe.ts`: add a token-health probe mode that sends the cheapest request shape.
- Modify `src/server/services/connectionMaintenanceConfig.ts`: add `tokenHealth` stage.
- Modify `src/server/services/connectionMaintenanceService.ts`: call scheduled token-health probes.
- Modify `src/server/routes/api/accountTokens.ts`: return token health summary, accept per-token probe model, and add manual probe endpoint.
- Modify `src/server/contracts/accountTokensRoutePayloads.ts`: validate `probeModel`.
- Modify `src/server/config.ts`, `src/server/runtimeSettingsHydration.ts`, `src/server/routes/api/settings.ts`: expose global token-health probe settings.
- Modify `src/server/routes/api/sites.ts`: expose site-level token-health probe model.
- Modify `src/server/services/proxyLogStore.ts` or proxy route log call sites: record token-health success/failure from real proxy attempts.
- Modify `src/web/api.ts`: add token-health probe and setting fields.
- Modify `src/web/pages/Tokens.tsx`: show token health, probe model, and manual probe action.
- Modify `src/web/pages/Settings.tsx` and `src/web/pages/Sites.tsx`: configure global and site defaults.

---

### Task 1: Schema And Compatibility

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/index.ts`
- Create: `drizzle/0029_token_health_probe.sql`
- Test: `src/server/db/schemaContract.test.ts`
- Generated: `src/server/db/generated/schemaContract.json`
- Generated: `src/server/db/generated/mysql.bootstrap.sql`
- Generated: `src/server/db/generated/postgres.bootstrap.sql`

- [ ] **Step 1: Write schema contract expectations**

Modify `src/server/db/schemaContract.test.ts` and add assertions:

```ts
expect(contract.tables.account_tokens.columns.probe_model).toMatchObject({
  name: 'probe_model',
  type: expect.any(String),
  notNull: false,
});

expect(contract.tables.sites.columns.token_health_probe_model).toMatchObject({
  name: 'token_health_probe_model',
  type: expect.any(String),
  notNull: false,
});

expect(contract.tables.account_token_health.columns.token_id).toBeDefined();
expect(contract.tables.account_token_health.columns.status).toBeDefined();
expect(contract.tables.account_token_health.columns.last_success_at).toBeDefined();
expect(contract.tables.account_token_health.columns.last_failure_at).toBeDefined();
expect(contract.tables.account_token_health.columns.failure_count).toBeDefined();
expect(contract.tables.account_token_health.indexes).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ name: 'account_token_health_token_unique', unique: true }),
    expect.objectContaining({ name: 'account_token_health_status_idx', unique: false }),
    expect.objectContaining({ name: 'account_token_health_next_probe_idx', unique: false }),
  ]),
);
```

- [ ] **Step 2: Run schema test to verify failure**

Run:

```bash
npm test -- src/server/db/schemaContract.test.ts
```

Expected: FAIL because the new table and columns do not exist.

- [ ] **Step 3: Add Drizzle schema**

In `src/server/db/schema.ts`, add `probeModel` to `accountTokens`, add `tokenHealthProbeModel` to `sites`, and define:

```ts
export const accountTokenHealth = sqliteTable('account_token_health', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenId: integer('token_id').notNull().references(() => accountTokens.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('unknown'),
  lastSuccessAt: text('last_success_at'),
  lastFailureAt: text('last_failure_at'),
  lastProbeAt: text('last_probe_at'),
  lastProbeModel: text('last_probe_model'),
  lastUsedModel: text('last_used_model'),
  lastError: text('last_error'),
  failureCount: integer('failure_count').notNull().default(0),
  nextProbeAt: text('next_probe_at'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  tokenUnique: uniqueIndex('account_token_health_token_unique').on(table.tokenId),
  statusIdx: index('account_token_health_status_idx').on(table.status),
  nextProbeIdx: index('account_token_health_next_probe_idx').on(table.nextProbeAt),
}));
```

- [ ] **Step 4: Add migration SQL**

Create `drizzle/0029_token_health_probe.sql`:

```sql
ALTER TABLE `account_tokens` ADD `probe_model` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `token_health_probe_model` text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `account_token_health` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `token_id` integer NOT NULL,
  `status` text DEFAULT 'unknown' NOT NULL,
  `last_success_at` text,
  `last_failure_at` text,
  `last_probe_at` text,
  `last_probe_model` text,
  `last_used_model` text,
  `last_error` text,
  `failure_count` integer DEFAULT 0 NOT NULL,
  `next_probe_at` text,
  `updated_at` text DEFAULT (datetime('now')),
  FOREIGN KEY (`token_id`) REFERENCES `account_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `account_token_health_token_unique` ON `account_token_health` (`token_id`);--> statement-breakpoint
CREATE INDEX `account_token_health_status_idx` ON `account_token_health` (`status`);--> statement-breakpoint
CREATE INDEX `account_token_health_next_probe_idx` ON `account_token_health` (`next_probe_at`);
```

- [ ] **Step 5: Add runtime SQLite compatibility**

In `src/server/db/index.ts`, include `account_token_health` in `TABLES_WITH_NUMERIC_ID` and add compatibility DDL beside the existing schema bootstrap logic:

```ts
executeLegacyCompatSync(sqlite, [
  'ALTER TABLE account_tokens ADD COLUMN probe_model text;',
  'ALTER TABLE sites ADD COLUMN token_health_probe_model text;',
  'CREATE TABLE IF NOT EXISTS account_token_health (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, token_id integer NOT NULL REFERENCES account_tokens(id) ON DELETE cascade, status text NOT NULL DEFAULT \\'unknown\\', last_success_at text, last_failure_at text, last_probe_at text, last_probe_model text, last_used_model text, last_error text, failure_count integer NOT NULL DEFAULT 0, next_probe_at text, updated_at text DEFAULT (datetime(\\'now\\')));',
  'CREATE UNIQUE INDEX IF NOT EXISTS account_token_health_token_unique ON account_token_health(token_id);',
  'CREATE INDEX IF NOT EXISTS account_token_health_status_idx ON account_token_health(status);',
  'CREATE INDEX IF NOT EXISTS account_token_health_next_probe_idx ON account_token_health(next_probe_at);',
]);
```

Use the local compatibility helper style already present in this file; do not add a new migration runner.

- [ ] **Step 6: Generate artifacts and run schema tests**

Run:

```bash
npm run schema:generate
npm test -- src/server/db/schemaContract.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/schema.ts src/server/db/index.ts src/server/db/schemaContract.test.ts drizzle/0029_token_health_probe.sql src/server/db/generated
git commit -m "feat: add account token health schema"
```

---

### Task 2: Token Health Service

**Files:**
- Create: `src/server/services/accountTokenHealthService.ts`
- Test: `src/server/services/accountTokenHealthService.test.ts`

- [ ] **Step 1: Write service tests**

Create `src/server/services/accountTokenHealthService.test.ts` with tests for:

```ts
it('resolves probe model as token override before site default before global default', async () => {
  const result = await resolveAccountTokenProbeModel({
    tokenProbeModel: 'token-model',
    siteProbeModel: 'site-model',
    globalProbeModel: 'global-model',
  });
  expect(result).toEqual({ model: 'token-model', source: 'token' });
});

it('marks enabled ready token without health row as pending probe', async () => {
  const summary = buildAccountTokenHealthSummary({
    token: { enabled: true, valueStatus: 'ready', token: 'sk-demo' } as any,
    accountStatus: 'active',
    siteStatus: 'active',
    health: null,
    probeModel: { model: 'gpt-5-mini', source: 'global' },
    nowMs: Date.parse('2026-06-07T00:00:00.000Z'),
    staleAfterMs: 6 * 60 * 60 * 1000,
  });
  expect(summary.status).toBe('pending_probe');
});

it('marks disabled or masked tokens as not probeable', async () => {
  const summary = buildAccountTokenHealthSummary({
    token: { enabled: true, valueStatus: 'masked_pending', token: 'sk-abc***def' } as any,
    accountStatus: 'active',
    siteStatus: 'active',
    health: null,
    probeModel: { model: 'gpt-5-mini', source: 'global' },
    nowMs: Date.now(),
    staleAfterMs: 6 * 60 * 60 * 1000,
  });
  expect(summary.status).toBe('not_probeable');
});

it('records proxy success as healthy and clears failure state', async () => {
  await recordAccountTokenRequestSuccess({ tokenId: 1, modelName: 'gpt-5-mini', at: '2026-06-07T00:00:00.000Z' });
  const row = await db.select().from(schema.accountTokenHealth).where(eq(schema.accountTokenHealth.tokenId, 1)).get();
  expect(row).toMatchObject({ status: 'healthy', failureCount: 0, lastUsedModel: 'gpt-5-mini' });
});

it('records proxy failure as pending retry without permanent unhealthy verdict', async () => {
  await recordAccountTokenRequestFailure({ tokenId: 1, modelName: 'gpt-5-mini', error: 'HTTP 401 invalid token', at: '2026-06-07T00:00:00.000Z' });
  const row = await db.select().from(schema.accountTokenHealth).where(eq(schema.accountTokenHealth.tokenId, 1)).get();
  expect(row?.status).toBe('request_failed_pending_probe');
  expect(row?.lastError).toBe('HTTP 401 invalid token');
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- src/server/services/accountTokenHealthService.test.ts
```

Expected: FAIL because service functions do not exist.

- [ ] **Step 3: Implement service contracts**

Create `src/server/services/accountTokenHealthService.ts` with exported types:

```ts
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
```

Implement:

```ts
export function resolveAccountTokenProbeModel(input: {
  tokenProbeModel?: string | null;
  siteProbeModel?: string | null;
  globalProbeModel?: string | null;
}): ResolvedProbeModel;

export function buildAccountTokenHealthSummary(input: {
  token: Pick<typeof schema.accountTokens.$inferSelect, 'enabled' | 'token' | 'valueStatus'>;
  accountStatus?: string | null;
  siteStatus?: string | null;
  health: typeof schema.accountTokenHealth.$inferSelect | null;
  probeModel: ResolvedProbeModel;
  nowMs?: number;
  staleAfterMs?: number;
}): AccountTokenHealthSummary;

export async function recordAccountTokenRequestSuccess(input: {
  tokenId: number | null | undefined;
  modelName?: string | null;
  at?: string;
}): Promise<void>;

export async function recordAccountTokenRequestFailure(input: {
  tokenId: number | null | undefined;
  modelName?: string | null;
  error?: string | null;
  at?: string;
}): Promise<void>;
```

Use `insert ... onConflictDoUpdate` if supported locally; otherwise select existing row then insert/update. Truncate `lastError` to 500 chars.

- [ ] **Step 4: Run service tests**

Run:

```bash
npm test -- src/server/services/accountTokenHealthService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/accountTokenHealthService.ts src/server/services/accountTokenHealthService.test.ts
git commit -m "feat: track account token health"
```

---

### Task 3: Low-Cost Probe Execution And Scheduler Stage

**Files:**
- Modify: `src/server/services/runtimeModelProbe.ts`
- Modify: `src/server/services/accountTokenHealthService.ts`
- Modify: `src/server/services/connectionMaintenanceConfig.ts`
- Modify: `src/server/services/connectionMaintenanceService.ts`
- Test: `src/server/services/accountTokenHealthProbe.test.ts`
- Test: `src/server/services/connectionMaintenanceConfig.test.ts`

- [ ] **Step 1: Write probe execution tests**

Create `src/server/services/accountTokenHealthProbe.test.ts`:

```ts
it('selects only stale, failed, or never-probed ready tokens for scheduled probes', async () => {
  const targets = await loadAccountTokenHealthProbeTargets({
    nowMs: Date.parse('2026-06-07T00:00:00.000Z'),
    staleAfterMs: 60 * 60 * 1000,
    limit: 100,
  });
  expect(targets.map((target) => target.tokenId)).toEqual([readyNeverProbedId, staleTokenId, failedTokenId]);
});

it('skips recently successful real-traffic tokens', async () => {
  await recordAccountTokenRequestSuccess({
    tokenId: recentSuccessTokenId,
    modelName: 'gpt-5-mini',
    at: '2026-06-06T23:55:00.000Z',
  });
  const targets = await loadAccountTokenHealthProbeTargets({
    nowMs: Date.parse('2026-06-07T00:00:00.000Z'),
    staleAfterMs: 60 * 60 * 1000,
    limit: 100,
  });
  expect(targets.some((target) => target.tokenId === recentSuccessTokenId)).toBe(false);
});

it('records probe success as healthy', async () => {
  probeRuntimeModelMock.mockResolvedValue({ status: 'supported', latencyMs: 12, reason: 'ok' });
  const result = await probeAccountTokenHealth({ tokenId: readyNeverProbedId });
  expect(result.status).toBe('healthy');
});

it('requires five scheduled failures before final probe_failed status', async () => {
  probeRuntimeModelMock.mockResolvedValue({ status: 'unsupported', latencyMs: 12, reason: 'invalid token' });
  for (let index = 0; index < 4; index += 1) {
    await probeAccountTokenHealth({ tokenId: readyNeverProbedId, scheduled: true });
  }
  let row = await db.select().from(schema.accountTokenHealth).where(eq(schema.accountTokenHealth.tokenId, readyNeverProbedId)).get();
  expect(row?.status).toBe('request_failed_pending_probe');
  await probeAccountTokenHealth({ tokenId: readyNeverProbedId, scheduled: true });
  row = await db.select().from(schema.accountTokenHealth).where(eq(schema.accountTokenHealth.tokenId, readyNeverProbedId)).get();
  expect(row?.status).toBe('probe_failed');
});
```

- [ ] **Step 2: Run probe tests to verify failure**

Run:

```bash
npm test -- src/server/services/accountTokenHealthProbe.test.ts
```

Expected: FAIL because probe target/execution functions do not exist.

- [ ] **Step 3: Add low-cost probe mode**

In `src/server/services/runtimeModelProbe.ts`, add an optional mode:

```ts
probeKind?: 'model-availability' | 'token-health';
```

When `probeKind === 'token-health'`, build the minimum body:

```ts
{
  model: input.modelName,
  messages: [{ role: 'user', content: '1' }],
  max_tokens: 1,
  stream: false,
}
```

Keep endpoint resolution and request building unchanged. If a platform maps to Responses or Claude internally, rely on `buildUpstreamEndpointRequest` to translate the minimal OpenAI body.

- [ ] **Step 4: Implement token-health probe functions**

In `src/server/services/accountTokenHealthService.ts`, add:

```ts
export async function loadAccountTokenHealthProbeTargets(input?: {
  nowMs?: number;
  staleAfterMs?: number;
  limit?: number;
}): Promise<AccountTokenHealthProbeTarget[]>;

export async function probeAccountTokenHealth(input: {
  tokenId: number;
  scheduled?: boolean;
}): Promise<AccountTokenHealthProbeResult>;

export async function executeAccountTokenHealthProbeSweep(input?: {
  concurrency?: number;
  limit?: number;
  staleAfterMs?: number;
}): Promise<AccountTokenHealthProbeSweepResult>;
```

Target query joins `account_tokens`, `accounts`, `sites`, and left joins `account_token_health`. Skip disabled tokens, masked tokens, disabled accounts, and disabled sites. Resolve probe model using token/site/global settings. Missing probe model returns `not_probeable` and does not send upstream traffic.

- [ ] **Step 5: Add connection maintenance stage**

In `src/server/services/connectionMaintenanceConfig.ts`, extend stage key with:

```ts
| 'tokenHealth'
```

Set default `tokenHealth: true`.

In `src/server/services/connectionMaintenanceService.ts`, add after `tokens` and `groupRatios`:

```ts
if (config.stages.tokenHealth) {
  stages.tokenHealth = await executeAccountTokenHealthProbeSweep({
    concurrency: config.concurrency,
  });
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- src/server/services/accountTokenHealthProbe.test.ts src/server/services/connectionMaintenanceConfig.test.ts src/server/services/modelAvailabilityProbeService.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/services/runtimeModelProbe.ts src/server/services/accountTokenHealthService.ts src/server/services/accountTokenHealthProbe.test.ts src/server/services/connectionMaintenanceConfig.ts src/server/services/connectionMaintenanceService.ts src/server/services/connectionMaintenanceConfig.test.ts
git commit -m "feat: probe account token health"
```

---

### Task 4: API, Settings, And Real Request Feedback

**Files:**
- Modify: `src/server/contracts/accountTokensRoutePayloads.ts`
- Modify: `src/server/routes/api/accountTokens.ts`
- Modify: `src/server/config.ts`
- Modify: `src/server/runtimeSettingsHydration.ts`
- Modify: `src/server/routes/api/settings.ts`
- Modify: `src/server/routes/api/sites.ts`
- Modify: proxy routes using `insertProxyLog`
- Test: `src/server/routes/api/accountTokens.health.test.ts`
- Test: existing proxy route tests with token channels

- [ ] **Step 1: Write account token API tests**

Create `src/server/routes/api/accountTokens.health.test.ts`:

```ts
it('returns health summary and effective probe model in token list', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/account-tokens',
    headers: authHeaders,
  });
  const body = response.json();
  expect(body[0].health).toMatchObject({
    status: 'pending_probe',
    probeModel: 'gpt-5-mini',
    probeModelSource: 'global',
  });
});

it('updates per-token probe model', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/account-tokens/${tokenId}`,
    headers: authHeaders,
    payload: { probeModel: 'custom-probe-model' },
  });
  expect(response.statusCode).toBe(200);
  const row = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
  expect(row?.probeModel).toBe('custom-probe-model');
});

it('manually probes one token and returns result', async () => {
  probeRuntimeModelMock.mockResolvedValue({ status: 'supported', latencyMs: 10, reason: 'ok' });
  const response = await app.inject({
    method: 'POST',
    url: `/api/account-tokens/${tokenId}/health/probe`,
    headers: authHeaders,
    payload: { wait: true },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().result.status).toBe('healthy');
});
```

- [ ] **Step 2: Run API test to verify failure**

Run:

```bash
npm test -- src/server/routes/api/accountTokens.health.test.ts
```

Expected: FAIL because response fields and endpoint do not exist.

- [ ] **Step 3: Extend account token payload contract**

In `src/server/contracts/accountTokensRoutePayloads.ts`, add:

```ts
probeModel: z.string().optional(),
```

to create and update payloads. Normalize blank strings to `null` in route handling.

- [ ] **Step 4: Extend `/api/account-tokens` response and update route**

In `src/server/routes/api/accountTokens.ts`:

- Include `probeModel` on create/update.
- Join or batch-load `account_token_health` in `listTokensWithRelations` or add a service helper that decorates results.
- Return `health` summary from `buildAccountTokenHealthSummary`.
- Add:

```ts
app.post<{ Params: { id: string }; Body?: { wait?: boolean } }>(
  '/api/account-tokens/:id/health/probe',
  async (request, reply) => {
    const tokenId = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }
    const result = await probeAccountTokenHealth({ tokenId, scheduled: false });
    return { success: true, result };
  },
);
```

Background-task mode can be added after wait-mode passes; keep first implementation synchronous for one token.

- [ ] **Step 5: Add global and site settings**

In `src/server/config.ts`, add:

```ts
tokenHealthProbeModel: (env.TOKEN_HEALTH_PROBE_MODEL || '').trim(),
tokenHealthStaleHours: Math.max(1, Math.trunc(parseNumber(env.TOKEN_HEALTH_STALE_HOURS, 6))),
```

Hydrate/store settings keys:

- `token_health_probe_model`
- `token_health_stale_hours`

In `src/server/routes/api/sites.ts`, include `tokenHealthProbeModel` in site create/update/list payloads.

- [ ] **Step 6: Record health from real proxy traffic**

At each proxy route `logProxy` helper or shared `insertProxyLog` call site, after proxy result is known:

```ts
if (selected?.channel?.tokenId) {
  if (status === 'success') {
    await recordAccountTokenRequestSuccess({
      tokenId: selected.channel.tokenId,
      modelName: modelActual || modelRequested,
    });
  } else {
    await recordAccountTokenRequestFailure({
      tokenId: selected.channel.tokenId,
      modelName: modelActual || modelRequested,
      error: errorMessage,
    });
  }
}
```

If a route has multiple attempts, record success for the successful token and failure for failed token-attempts where the token id is known. Do not record health for account-level OAuth/API-key routes with no `account_tokens.id`.

- [ ] **Step 7: Run server tests**

Run:

```bash
npm test -- src/server/routes/api/accountTokens.health.test.ts src/server/routes/proxy/chat.stream.test.ts src/server/routes/proxy/completions.usage-source.test.ts src/server/routes/proxy/embeddings.siteApiEndpoint.test.ts
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/contracts/accountTokensRoutePayloads.ts src/server/routes/api/accountTokens.ts src/server/config.ts src/server/runtimeSettingsHydration.ts src/server/routes/api/settings.ts src/server/routes/api/sites.ts src/server/routes/proxy src/server/services/accountTokenService.ts src/server/routes/api/accountTokens.health.test.ts
git commit -m "feat: expose account token health api"
```

---

### Task 5: Account Token UI

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/pages/Tokens.tsx`
- Modify: `src/web/pages/Settings.tsx`
- Modify: `src/web/pages/Sites.tsx`
- Test: `src/web/pages/tokens.token-health.test.tsx`
- Test: existing token page tests

- [ ] **Step 1: Write UI test**

Create `src/web/pages/tokens.token-health.test.tsx`:

```tsx
it('renders token health and effective probe model', async () => {
  apiMock.getAccountTokens.mockResolvedValue([
    {
      id: 11,
      name: 'codex-day',
      tokenMasked: 'sk-abc***1234',
      enabled: true,
      valueStatus: 'ready',
      tokenGroup: 'default',
      groupMultiplier: 1,
      updatedAt: '2026-06-07T00:00:00.000Z',
      account: { username: 'codex' },
      site: { name: 'newapi' },
      health: {
        status: 'request_failed_pending_probe',
        label: '业务失败待复检',
        probeModel: 'gpt-5-mini',
        probeModelSource: 'token',
        lastFailureAt: '2026-06-07T00:00:00.000Z',
        lastError: 'HTTP 429 quota exhausted',
      },
    },
  ]);
  render(<TokensPanel />);
  expect(await screen.findByText('业务失败待复检')).toBeInTheDocument();
  expect(screen.getByText('gpt-5-mini')).toBeInTheDocument();
});

it('can save custom token probe model', async () => {
  await openEditPanelForToken(11);
  await userEvent.click(screen.getByLabelText('自定义探测模型'));
  await userEvent.clear(screen.getByLabelText('探测模型'));
  await userEvent.type(screen.getByLabelText('探测模型'), 'gpt-5-mini');
  await userEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(apiMock.updateAccountToken).toHaveBeenCalledWith(11, expect.objectContaining({
    probeModel: 'gpt-5-mini',
  }));
});
```

- [ ] **Step 2: Run UI test to verify failure**

Run:

```bash
npm test -- src/web/pages/tokens.token-health.test.tsx
```

Expected: FAIL because UI does not render health fields.

- [ ] **Step 3: Extend web API**

In `src/web/api.ts`, add:

```ts
probeAccountTokenHealth: (id: number, wait = true) =>
  request(`/api/account-tokens/${id}/health/probe`, {
    method: 'POST',
    body: JSON.stringify({ wait }),
    timeoutMs: 120_000,
  }),
```

Include global/site probe settings in existing settings/site payload helpers.

- [ ] **Step 4: Render health in desktop and mobile token lists**

In `src/web/pages/Tokens.tsx`:

- Add a `健康` column after `状态`.
- Mobile cards add `MobileField label="健康"`.
- Render health badge by status:
  - `healthy` -> `badge-success`
  - `pending_probe` -> `badge-muted`
  - `request_failed_pending_probe` -> `badge-warning`
  - `probe_failed` -> `badge-danger`
  - `not_probeable` -> `badge-muted`
- Show probe model text as `探测模型：gpt-5-mini（令牌）` or `继承站点/全局`.
- Add row action `探测` that calls `api.probeAccountTokenHealth(token.id, true)`, reloads list, and shows toast.

- [ ] **Step 5: Add edit controls**

Extend `editForm` with:

```ts
probeModelMode: 'inherit' | 'custom',
probeModel: '',
```

When opening edit panel:

```ts
probeModelMode: token.probeModel ? 'custom' : 'inherit',
probeModel: token.probeModel || token.health?.probeModel || '',
```

When saving:

```ts
probeModel: editForm.probeModelMode === 'custom' ? editForm.probeModel.trim() : '',
```

Display helper text with effective inherited model when mode is `inherit`.

- [ ] **Step 6: Add settings and site controls**

In `src/web/pages/Settings.tsx`, add an input near connection maintenance settings:

- Label: `全局令牌健康探测模型`
- Placeholder: `例如 gpt-5-mini`
- Save key: `tokenHealthProbeModel`

In `src/web/pages/Sites.tsx`, add site-level field:

- Label: `站点令牌健康探测模型`
- Placeholder: `留空则继承全局默认`

- [ ] **Step 7: Run UI tests and typecheck**

Run:

```bash
npm test -- src/web/pages/tokens.token-health.test.tsx src/web/pages/tokens.edit-and-select.test.tsx src/web/pages/tokens.mobile-actions.test.tsx src/web/pages/settings.model-availability-probe.test.tsx
npm run typecheck:web
npm run typecheck:web:test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/api.ts src/web/pages/Tokens.tsx src/web/pages/Settings.tsx src/web/pages/Sites.tsx src/web/pages/tokens.token-health.test.tsx
git commit -m "feat: show account token health"
```

---

### Task 6: Backup, Import, And Final Verification

**Files:**
- Modify: `src/server/services/backupService.ts`
- Modify: `src/server/services/databaseMigrationService.ts`
- Test: `src/server/services/backupService.test.ts`
- Test: `src/server/services/databaseMigrationService.test.ts`

- [ ] **Step 1: Extend backup and migration snapshots**

Include `account_token_health`, `account_tokens.probe_model`, and `sites.token_health_probe_model` in backup/export and database migration flows. Preserve nulls and do not export token plaintext beyond existing behavior.

- [ ] **Step 2: Add backup tests**

Add assertions that export/import round-trips:

```ts
expect(restoredToken.probeModel).toBe('gpt-5-mini');
expect(restoredSite.tokenHealthProbeModel).toBe('gpt-5-mini');
expect(restoredHealth).toMatchObject({
  tokenId: restoredToken.id,
  status: 'healthy',
  lastProbeModel: 'gpt-5-mini',
});
```

- [ ] **Step 3: Run focused persistence tests**

Run:

```bash
npm test -- src/server/services/backupService.test.ts src/server/services/databaseMigrationService.test.ts
```

Expected: PASS.

- [ ] **Step 4: Full verification**

Run:

```bash
npm run typecheck
npm test -- src/server/services/accountTokenHealthService.test.ts src/server/services/accountTokenHealthProbe.test.ts src/server/routes/api/accountTokens.health.test.ts src/web/pages/tokens.token-health.test.tsx
npm run build
```

Expected: all commands PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/backupService.ts src/server/services/databaseMigrationService.ts src/server/services/backupService.test.ts src/server/services/databaseMigrationService.test.ts
git commit -m "feat: preserve token health metadata"
```

---

## Self-Review

- Spec coverage: plan covers independent token health, probe-model inheritance, low-cost probes, scheduled stale/failed probing, real request success/failure feedback, UI display, manual probe API, settings, and persistence.
- Scope: this is one feature with backend schema/service/API plus UI; tasks are split so each commit leaves a coherent checkpoint.
- Risk control: model coverage remains separate in `token_model_availability`; route eligibility remains separate and is not mixed into token health.
- Verification: focused tests are listed per task, with final `typecheck`, focused tests, and `build`.
