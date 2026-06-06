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
