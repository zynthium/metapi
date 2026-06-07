import { describe, expect, it } from 'vitest';
import {
  buildMaintenanceCheckSchedule,
  resolveTokenHealthNextCheckAt,
} from './maintenanceCheckScheduleService.js';

describe('maintenance check schedule metadata', () => {
  const nextMaintenanceAt = '2026-06-07T16:00:00.000Z';

  it('uses the next maintenance run for enabled subjects and stages', () => {
    expect(buildMaintenanceCheckSchedule({
      maintenanceEnabled: true,
      stageEnabled: true,
      subjectEnabled: true,
      nextMaintenanceAt,
    })).toEqual({
      enabled: true,
      nextCheckAt: nextMaintenanceAt,
      reason: null,
    });
  });

  it('marks disabled subjects as not participating in checks', () => {
    expect(buildMaintenanceCheckSchedule({
      maintenanceEnabled: true,
      stageEnabled: true,
      subjectEnabled: false,
      nextMaintenanceAt,
    })).toEqual({
      enabled: false,
      nextCheckAt: null,
      reason: 'subject_disabled',
    });
  });

  it('marks disabled stages as not scheduled', () => {
    expect(buildMaintenanceCheckSchedule({
      maintenanceEnabled: true,
      stageEnabled: false,
      subjectEnabled: true,
      nextMaintenanceAt,
    })).toEqual({
      enabled: false,
      nextCheckAt: null,
      reason: 'stage_disabled',
    });
  });

  it('prefers a token-specific next probe time over the global maintenance run', () => {
    expect(resolveTokenHealthNextCheckAt({
      tokenNextProbeAt: '2026-06-07T15:35:00.000Z',
      nextMaintenanceAt,
    })).toBe('2026-06-07T15:35:00.000Z');
  });
});
