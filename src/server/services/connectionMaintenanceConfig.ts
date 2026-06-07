export type ConnectionMaintenanceStageKey =
  | 'siteAccess'
  | 'accountHealth'
  | 'tokens'
  | 'groupRatios'
  | 'tokenHealth'
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
  tokenHealth: true,
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
