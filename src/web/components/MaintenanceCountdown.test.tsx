import { describe, expect, it } from 'vitest';
import { formatMaintenanceCountdownLabel } from './MaintenanceCountdown.js';

describe('formatMaintenanceCountdownLabel', () => {
  const nowMs = Date.parse('2026-06-07T15:00:00.000Z');

  it('formats an enabled upcoming check countdown', () => {
    expect(formatMaintenanceCountdownLabel({
      schedule: {
        enabled: true,
        nextCheckAt: '2026-06-07T15:20:00.000Z',
        reason: null,
      },
      nowMs,
    })).toBe('下次检测 20 分钟后');
  });

  it('shows disabled subjects as not participating', () => {
    expect(formatMaintenanceCountdownLabel({
      schedule: {
        enabled: false,
        nextCheckAt: null,
        reason: 'subject_disabled',
      },
      nowMs,
    })).toBe('未参与检测');
  });

  it('shows disabled maintenance as not enabled', () => {
    expect(formatMaintenanceCountdownLabel({
      schedule: {
        enabled: false,
        nextCheckAt: null,
        reason: 'maintenance_disabled',
      },
      nowMs,
    })).toBe('未启用');
  });
});
