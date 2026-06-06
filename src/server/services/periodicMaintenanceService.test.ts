import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshAllBalancesMock = vi.fn();
const syncAllAccountTokensMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const refreshAllRouteDecisionSnapshotsMock = vi.fn();

vi.mock('./balanceService.js', () => ({
  refreshAllBalances: (...args: unknown[]) => refreshAllBalancesMock(...args),
}));

vi.mock('./accountTokenSyncService.js', () => ({
  syncAllAccountTokens: (...args: unknown[]) => syncAllAccountTokensMock(...args),
}));

vi.mock('./routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('./routeDecisionRefreshService.js', () => ({
  refreshAllRouteDecisionSnapshots: (...args: unknown[]) => refreshAllRouteDecisionSnapshotsMock(...args),
}));

describe('periodicMaintenanceService', () => {
  beforeEach(() => {
    refreshAllBalancesMock.mockReset();
    syncAllAccountTokensMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    refreshAllRouteDecisionSnapshotsMock.mockReset();

    refreshAllBalancesMock.mockResolvedValue([{ accountId: 1, success: true }]);
    syncAllAccountTokensMock.mockResolvedValue({
      summary: {
        total: 2,
        synced: 1,
        skipped: 1,
        failed: 0,
        created: 1,
        updated: 1,
      },
      results: [],
      coverageRefresh: {
        refresh: [],
        rebuild: null,
      },
    });
    refreshModelsAndRebuildRoutesMock.mockResolvedValue({
      refresh: [],
      rebuild: { success: true },
    });
    refreshAllRouteDecisionSnapshotsMock.mockResolvedValue({
      exactModelCount: 2,
      wildcardRouteCount: 1,
    });
  });

  it('refreshes balances, account token groups, route multipliers, and decision snapshots in order', async () => {
    const { runPeriodicMaintenance } = await import('./periodicMaintenanceService.js');

    const result = await runPeriodicMaintenance();

    expect(refreshAllBalancesMock).toHaveBeenCalledTimes(1);
    expect(syncAllAccountTokensMock).toHaveBeenCalledTimes(1);
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
    expect(refreshAllRouteDecisionSnapshotsMock).toHaveBeenCalledWith({
      refreshPricingCatalog: true,
    });
    expect(refreshAllBalancesMock.mock.invocationCallOrder[0]).toBeLessThan(syncAllAccountTokensMock.mock.invocationCallOrder[0]);
    expect(syncAllAccountTokensMock.mock.invocationCallOrder[0]).toBeLessThan(refreshModelsAndRebuildRoutesMock.mock.invocationCallOrder[0]);
    expect(refreshModelsAndRebuildRoutesMock.mock.invocationCallOrder[0]).toBeLessThan(refreshAllRouteDecisionSnapshotsMock.mock.invocationCallOrder[0]);
    expect(result.summary).toMatchObject({
      tokenSync: {
        total: 2,
        synced: 1,
        skipped: 1,
        failed: 0,
      },
      routeDecisionSnapshots: {
        exactModelCount: 2,
        wildcardRouteCount: 1,
      },
    });
  });
});
