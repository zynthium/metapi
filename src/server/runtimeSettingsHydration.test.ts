import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config.js';
import { applyRuntimeSettings } from './runtimeSettingsHydration.js';

const originalConfig = structuredClone(config);

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig));
});

describe('applyRuntimeSettings', () => {
  it('hydrates persisted runtime settings that should survive restarts', () => {
    config.disableCrossProtocolFallback = false;
    config.responsesCompactFallbackToResponsesEnabled = false;
    config.webhookEnabled = true;
    config.barkEnabled = true;
    config.serverChanEnabled = true;
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['disable_cross_protocol_fallback', JSON.stringify(true)],
      ['responses_compact_fallback_to_responses_enabled', JSON.stringify(true)],
      ['webhook_enabled', JSON.stringify(false)],
      ['bark_enabled', JSON.stringify(false)],
      ['serverchan_enabled', JSON.stringify(false)],
      ['global_allowed_models', JSON.stringify(['gpt-5.4', ' claude-3.7-sonnet '])],
    ]));

    expect(config.disableCrossProtocolFallback).toBe(true);
    expect(config.responsesCompactFallbackToResponsesEnabled).toBe(true);
    expect(config.webhookEnabled).toBe(false);
    expect(config.barkEnabled).toBe(false);
    expect(config.serverChanEnabled).toBe(false);
    expect(config.globalAllowedModels).toEqual(['gpt-5.4', 'claude-3.7-sonnet']);
  });

  it('normalizes smtpPort to a positive integer during hydration', () => {
    config.smtpPort = 587;

    applyRuntimeSettings(new Map([
      ['smtp_port', JSON.stringify(587.9)],
    ]));

    expect(config.smtpPort).toBe(587);
  });

  it('hydrates legacy double-encoded global model allowlist values', () => {
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['global_allowed_models', JSON.stringify(JSON.stringify(['model-alpha', ' model-beta ', 'model-gamma']))],
    ]));

    expect(config.globalAllowedModels).toEqual(['model-alpha', 'model-beta', 'model-gamma']);
  });

  it('hydrates connection maintenance settings and keeps the legacy cron in sync', () => {
    config.connectionMaintenanceEnabled = false;
    config.connectionMaintenanceCron = '0 * * * *';
    config.connectionMaintenanceRetryAttempts = 5;
    config.connectionMaintenanceAttemptTimeoutSec = 15;
    config.connectionMaintenanceConcurrency = 3;
    config.connectionMaintenanceStages = {
      siteAccess: true,
      accountHealth: true,
      tokens: true,
      groupRatios: true,
      modelCoverage: true,
      routeMultipliers: true,
      routeDecisionSnapshots: true,
      accountsSnapshot: true,
    };

    applyRuntimeSettings(new Map([
      ['connection_maintenance_enabled', JSON.stringify(true)],
      ['connection_maintenance_cron', JSON.stringify('*/15 * * * *')],
      ['connection_maintenance_retry_attempts', JSON.stringify(7)],
      ['connection_maintenance_attempt_timeout_sec', JSON.stringify(20)],
      ['connection_maintenance_concurrency', JSON.stringify(4)],
      ['connection_maintenance_stages', JSON.stringify({ tokens: false, groupRatios: true })],
    ]));

    expect(config.connectionMaintenanceEnabled).toBe(true);
    expect(config.connectionMaintenanceCron).toBe('*/15 * * * *');
    expect(config.balanceRefreshCron).toBe('*/15 * * * *');
    expect(config.connectionMaintenanceRetryAttempts).toBe(7);
    expect(config.connectionMaintenanceAttemptTimeoutSec).toBe(20);
    expect(config.connectionMaintenanceConcurrency).toBe(4);
    expect(config.connectionMaintenanceStages.tokens).toBe(false);
    expect(config.connectionMaintenanceStages.groupRatios).toBe(true);
    expect(config.connectionMaintenanceStages.accountHealth).toBe(true);
  });

  it('uses the legacy balance refresh cron as connection maintenance fallback', () => {
    config.connectionMaintenanceCron = '0 * * * *';
    config.balanceRefreshCron = '0 * * * *';

    applyRuntimeSettings(new Map([
      ['balance_refresh_cron', JSON.stringify('5 * * * *')],
    ]));

    expect(config.connectionMaintenanceCron).toBe('5 * * * *');
    expect(config.balanceRefreshCron).toBe('5 * * * *');
  });
});
