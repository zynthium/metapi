import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronStopMock = vi.fn();
const scheduleMock = vi.fn(() => ({
  stop: cronStopMock,
}));
const validateMock = vi.fn(() => true);
const allMock = vi.fn();
const runPeriodicMaintenanceMock = vi.fn();
const refreshAllBalancesMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => scheduleMock(...args),
    validate: (...args: unknown[]) => validateMock(...args),
  },
}));

vi.mock('../db/index.js', () => {
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    all: () => [],
    from: () => queryChain,
    innerJoin: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key' },
      accounts: { checkinEnabled: 'checkinEnabled', status: 'status' },
      sites: { id: 'id' },
    },
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => allMock(...args),
}));

vi.mock('./periodicMaintenanceService.js', () => ({
  runPeriodicMaintenance: (...args: unknown[]) => runPeriodicMaintenanceMock(...args),
}));

vi.mock('./balanceService.js', () => ({
  refreshAllBalances: (...args: unknown[]) => refreshAllBalancesMock(...args),
}));

vi.mock('./routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

describe('checkinScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cronStopMock.mockReset();
    scheduleMock.mockClear();
    validateMock.mockClear();
    allMock.mockReset();
    runPeriodicMaintenanceMock.mockReset();
    refreshAllBalancesMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    runPeriodicMaintenanceMock.mockResolvedValue({
      skipped: false,
      summary: {
        siteAccess: {
          total: 1,
          reachable: 1,
          failed: 0,
        },
        accountHealth: {
          summary: {
            total: 2,
            healthy: 2,
            unhealthy: 0,
            failed: 0,
          },
        },
        tokens: {
          summary: {
            total: 3,
            synced: 2,
            skipped: 1,
            failed: 0,
          },
        },
        groupRatios: {
          total: 3,
          synced: 3,
          skipped: 0,
          failed: 0,
        },
        routeDecisionSnapshots: {
          exactModelCount: 0,
          wildcardRouteCount: 0,
        },
      },
    });
  });

  afterEach(async () => {
    const scheduler = await import('./checkinScheduler.js');
    scheduler.__resetCheckinSchedulerForTests();
    vi.useRealTimers();
  });

  it('switches from cron mode to interval mode and back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '5 9 * * *',
      intervalHours: 6,
    });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
  });

  it('selects due accounts from the last successful checkin time', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-03-20T12:00:00.000Z');

    expect(scheduler.selectDueIntervalCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T05:59:59.000Z' },
      { id: 3, lastCheckinAt: '2026-03-20T06:30:00.000Z' },
    ], 6, now)).toEqual([1, 2]);
  });

  it('runs connection maintenance from the compatible balance refresh schedule', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateConnectionMaintenanceCron('*/5 * * * *');
    const scheduledCallback = scheduleMock.mock.calls.at(-1)?.[1] as (() => Promise<void>) | undefined;
    expect(scheduledCallback).toBeTypeOf('function');

    await scheduledCallback!();

    expect(runPeriodicMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(refreshAllBalancesMock).not.toHaveBeenCalled();
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Running connection maintenance'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Connection maintenance complete'));
    logSpy.mockRestore();
  });
});
