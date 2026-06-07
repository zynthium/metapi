import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runConnectionMaintenance } from './connectionMaintenanceService.js';

const refreshSiteAccessMock = vi.hoisted(() => vi.fn());
const executeHealthMock = vi.hoisted(() => vi.fn());
const tokenHealthProbeMock = vi.hoisted(() => vi.fn());
const syncAllTokensMock = vi.hoisted(() => vi.fn());
const refreshGroupRatiosMock = vi.hoisted(() => vi.fn());
const refreshRoutesMock = vi.hoisted(() => vi.fn());
const refreshSnapshotsMock = vi.hoisted(() => vi.fn());
const getAccountsSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('./siteAccessRefreshService.js', () => ({ refreshAllSiteAccess: (...args: unknown[]) => refreshSiteAccessMock(...args) }));
vi.mock('./accountRuntimeHealthRefreshService.js', () => ({ executeRefreshAccountRuntimeHealth: (...args: unknown[]) => executeHealthMock(...args) }));
vi.mock('./accountTokenHealthService.js', () => ({ executeAccountTokenHealthProbeSweep: (...args: unknown[]) => tokenHealthProbeMock(...args) }));
vi.mock('./accountTokenSyncService.js', () => ({ syncAllAccountTokens: (...args: unknown[]) => syncAllTokensMock(...args) }));
vi.mock('./groupRatioRefreshService.js', () => ({ refreshAllAccountGroupRatios: (...args: unknown[]) => refreshGroupRatiosMock(...args) }));
vi.mock('./routeRefreshWorkflow.js', () => ({ refreshModelsAndRebuildRoutes: () => refreshRoutesMock() }));
vi.mock('./routeDecisionRefreshService.js', () => ({ refreshAllRouteDecisionSnapshots: (...args: unknown[]) => refreshSnapshotsMock(...args) }));
vi.mock('./accountsOverviewService.js', () => ({ getAccountsSnapshot: (...args: unknown[]) => getAccountsSnapshotMock(...args) }));

const enabledConfig = {
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
    tokenHealth: true,
    modelCoverage: true,
    routeMultipliers: true,
    routeDecisionSnapshots: true,
    accountsSnapshot: true,
  },
};

describe('connectionMaintenanceService', () => {
  beforeEach(() => {
    refreshSiteAccessMock.mockReset();
    executeHealthMock.mockReset();
    tokenHealthProbeMock.mockReset();
    syncAllTokensMock.mockReset();
    refreshGroupRatiosMock.mockReset();
    refreshRoutesMock.mockReset();
    refreshSnapshotsMock.mockReset();
    getAccountsSnapshotMock.mockReset();
  });

  it('runs enabled stages in dependency order', async () => {
    refreshSiteAccessMock.mockResolvedValue({ total: 0, reachable: 0, failed: 0, results: [] });
    executeHealthMock.mockResolvedValue({ summary: { total: 0 }, results: [] });
    syncAllTokensMock.mockResolvedValue({ summary: { total: 0, synced: 0, skipped: 0, failed: 0 }, results: [] });
    refreshGroupRatiosMock.mockResolvedValue({ total: 0, synced: 0, skipped: 0, failed: 0, results: [] });
    tokenHealthProbeMock.mockResolvedValue({ scanned: 0, probed: 0, healthy: 0, failed: 0, skipped: 0, results: [] });
    refreshRoutesMock.mockResolvedValue({
      refresh: [],
      rebuild: { models: 0, createdRoutes: 0, createdChannels: 0, updatedChannels: 0, removedChannels: 0, removedRoutes: 0 },
    });
    refreshSnapshotsMock.mockResolvedValue({ exactModelCount: 0, wildcardRouteCount: 0 });
    getAccountsSnapshotMock.mockResolvedValue({ cacheStatus: 'miss' });

    const result = await runConnectionMaintenance({ config: enabledConfig });

    expect(result.skipped).toBe(false);
    expect(refreshSiteAccessMock.mock.invocationCallOrder[0]).toBeLessThan(executeHealthMock.mock.invocationCallOrder[0]);
    expect(executeHealthMock.mock.invocationCallOrder[0]).toBeLessThan(syncAllTokensMock.mock.invocationCallOrder[0]);
    expect(syncAllTokensMock.mock.invocationCallOrder[0]).toBeLessThan(refreshGroupRatiosMock.mock.invocationCallOrder[0]);
    expect(refreshGroupRatiosMock.mock.invocationCallOrder[0]).toBeLessThan(tokenHealthProbeMock.mock.invocationCallOrder[0]);
    expect(tokenHealthProbeMock.mock.invocationCallOrder[0]).toBeLessThan(refreshRoutesMock.mock.invocationCallOrder[0]);
    expect(tokenHealthProbeMock).toHaveBeenCalledWith({
      concurrency: 3,
      retryAttempts: 5,
      timeoutMs: 15_000,
    });
    expect(refreshRoutesMock.mock.invocationCallOrder[0]).toBeLessThan(refreshSnapshotsMock.mock.invocationCallOrder[0]);
    expect(getAccountsSnapshotMock).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('skips overlapping runs', async () => {
    let release!: () => void;
    refreshSiteAccessMock.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({ total: 0, reachable: 0, failed: 0, results: [] });
    }));
    executeHealthMock.mockResolvedValue({ summary: { total: 0 }, results: [] });
    syncAllTokensMock.mockResolvedValue({ summary: { total: 0, synced: 0, skipped: 0, failed: 0 }, results: [] });
    refreshGroupRatiosMock.mockResolvedValue({ total: 0, synced: 0, skipped: 0, failed: 0, results: [] });
    tokenHealthProbeMock.mockResolvedValue({ scanned: 0, probed: 0, healthy: 0, failed: 0, skipped: 0, results: [] });
    refreshRoutesMock.mockResolvedValue({
      refresh: [],
      rebuild: { models: 0, createdRoutes: 0, createdChannels: 0, updatedChannels: 0, removedChannels: 0, removedRoutes: 0 },
    });
    refreshSnapshotsMock.mockResolvedValue({ exactModelCount: 0, wildcardRouteCount: 0 });
    getAccountsSnapshotMock.mockResolvedValue({ cacheStatus: 'miss' });

    const first = runConnectionMaintenance({ config: enabledConfig });
    const second = await runConnectionMaintenance({ config: enabledConfig });
    release();
    await first;

    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already_running');
  });
});
