import { config as runtimeConfig } from '../config.js';
import { getAccountsSnapshot } from './accountsOverviewService.js';
import { executeRefreshAccountRuntimeHealth } from './accountRuntimeHealthRefreshService.js';
import { executeAccountTokenHealthProbeSweep } from './accountTokenHealthService.js';
import { syncAllAccountTokens } from './accountTokenSyncService.js';
import {
  DEFAULT_CONNECTION_MAINTENANCE_CONFIG,
  type ConnectionMaintenanceConfig,
} from './connectionMaintenanceConfig.js';
import { refreshAllAccountGroupRatios } from './groupRatioRefreshService.js';
import { refreshAllRouteDecisionSnapshots } from './routeDecisionRefreshService.js';
import { refreshAllSiteAccess } from './siteAccessRefreshService.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';

export type ConnectionMaintenanceResult = {
  skipped: boolean;
  reason?: 'disabled' | 'already_running';
  startedAt: string;
  finishedAt: string;
  stages: Record<string, unknown>;
  summary: Record<string, unknown>;
};

let running: Promise<ConnectionMaintenanceResult> | null = null;

function activeConfig(input?: ConnectionMaintenanceConfig): ConnectionMaintenanceConfig {
  if (input) return input;
  return {
    enabled: runtimeConfig.connectionMaintenanceEnabled,
    cron: runtimeConfig.connectionMaintenanceCron || runtimeConfig.balanceRefreshCron || DEFAULT_CONNECTION_MAINTENANCE_CONFIG.cron,
    retryAttempts: runtimeConfig.connectionMaintenanceRetryAttempts,
    attemptTimeoutSec: runtimeConfig.connectionMaintenanceAttemptTimeoutSec,
    concurrency: runtimeConfig.connectionMaintenanceConcurrency,
    stages: {
      ...DEFAULT_CONNECTION_MAINTENANCE_CONFIG.stages,
      ...runtimeConfig.connectionMaintenanceStages,
    },
  };
}

async function execute(config: ConnectionMaintenanceConfig): Promise<ConnectionMaintenanceResult> {
  const startedAt = new Date().toISOString();
  const stages: Record<string, unknown> = {};

  if (!config.enabled) {
    return {
      skipped: true,
      reason: 'disabled',
      startedAt,
      finishedAt: new Date().toISOString(),
      stages,
      summary: {},
    };
  }

  const attemptTimeoutMs = config.attemptTimeoutSec * 1000;

  if (config.stages.siteAccess) {
    stages.siteAccess = await refreshAllSiteAccess({
      retryAttempts: config.retryAttempts,
      attemptTimeoutMs,
      concurrency: config.concurrency,
    });
  }

  if (config.stages.accountHealth) {
    stages.accountHealth = await executeRefreshAccountRuntimeHealth({
      retryAttempts: config.retryAttempts,
      attemptTimeoutMs,
      concurrency: config.concurrency,
    });
  }

  if (config.stages.tokens) {
    stages.tokens = await syncAllAccountTokens({
      retryAttempts: config.retryAttempts,
      attemptTimeoutMs,
      concurrency: config.concurrency,
    });
  }

  if (config.stages.groupRatios) {
    stages.groupRatios = await refreshAllAccountGroupRatios({
      retryAttempts: config.retryAttempts,
      attemptTimeoutMs,
      concurrency: config.concurrency,
    });
  }

  if (config.stages.tokenHealth) {
    stages.tokenHealth = await executeAccountTokenHealthProbeSweep({
      concurrency: config.concurrency,
    });
  }

  if (config.stages.modelCoverage || config.stages.routeMultipliers) {
    stages.routeRefresh = await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
  }

  if (config.stages.routeDecisionSnapshots) {
    stages.routeDecisionSnapshots = await refreshAllRouteDecisionSnapshots({
      refreshPricingCatalog: true,
    });
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

export async function runConnectionMaintenance(input?: {
  config?: ConnectionMaintenanceConfig;
}): Promise<ConnectionMaintenanceResult> {
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
