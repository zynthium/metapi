import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshRuntimeHealthForAccountRow } from './accountRuntimeHealthRefreshService.js';

const refreshBalanceMock = vi.hoisted(() => vi.fn());
const setAccountRuntimeHealthMock = vi.hoisted(() => vi.fn());
const buildRuntimeHealthForAccountMock = vi.hoisted(() => vi.fn());

vi.mock('../db/index.js', () => ({
  db: {},
  schema: {
    accounts: { id: 'accounts.id', siteId: 'accounts.siteId' },
    sites: { id: 'sites.id' },
  },
}));

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./accountHealthService.js', () => ({
  buildRuntimeHealthForAccount: (...args: unknown[]) => buildRuntimeHealthForAccountMock(...args),
  setAccountRuntimeHealth: (...args: unknown[]) => setAccountRuntimeHealthMock(...args),
}));

describe('accountRuntimeHealthRefreshService', () => {
  beforeEach(() => {
    refreshBalanceMock.mockReset();
    setAccountRuntimeHealthMock.mockReset();
    buildRuntimeHealthForAccountMock.mockReset();
  });

  it('marks unhealthy only after the configured retry attempts fail', async () => {
    refreshBalanceMock.mockRejectedValue(new Error('temporary network failure'));
    setAccountRuntimeHealthMock.mockResolvedValue({
      state: 'unhealthy',
      reason: 'temporary network failure',
      source: 'health-refresh',
      checkedAt: '2026-06-07T00:00:00.000Z',
    });

    const result = await refreshRuntimeHealthForAccountRow({
      row: {
        accounts: {
          id: 1,
          username: 'health-user',
          status: 'active',
          accessToken: 'session-token',
          apiToken: 'sk-token',
          extraConfig: null,
        },
        sites: {
          id: 2,
          name: 'health-site',
          status: 'active',
        },
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(refreshBalanceMock).toHaveBeenCalledTimes(5);
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledTimes(1);
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledWith(1, expect.objectContaining({
      state: 'unhealthy',
      source: 'health-refresh',
    }));
    expect(result.status).toBe('failed');
  });

  it('does not mark unhealthy when a later retry succeeds', async () => {
    refreshBalanceMock
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce({ balance: 10, used: 1, quota: 20 });
    buildRuntimeHealthForAccountMock.mockReturnValue({
      state: 'unknown',
      reason: '尚未检测',
      source: 'none',
      checkedAt: null,
    });
    setAccountRuntimeHealthMock.mockResolvedValue({
      state: 'healthy',
      reason: '健康检查通过',
      source: 'health-refresh',
      checkedAt: '2026-06-07T00:00:00.000Z',
    });

    const result = await refreshRuntimeHealthForAccountRow({
      row: {
        accounts: {
          id: 1,
          username: 'health-user',
          status: 'active',
          accessToken: 'session-token',
          apiToken: 'sk-token',
          extraConfig: null,
        },
        sites: {
          id: 2,
          name: 'health-site',
          status: 'active',
        },
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(refreshBalanceMock).toHaveBeenCalledTimes(3);
    expect(setAccountRuntimeHealthMock).not.toHaveBeenCalledWith(1, expect.objectContaining({ state: 'unhealthy' }));
    expect(result.status).toBe('success');
  });
});
