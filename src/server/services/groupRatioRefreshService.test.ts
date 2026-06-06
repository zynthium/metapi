import { describe, expect, it, vi, beforeEach } from 'vitest';
import { refreshGroupRatiosForAccountRow } from './groupRatioRefreshService.js';

const fetchGroupRatioForSiteMock = vi.hoisted(() => vi.fn());
const upsertAccountGroupRatiosMock = vi.hoisted(() => vi.fn());
const markFailureMock = vi.hoisted(() => vi.fn());

vi.mock('./modelPricingService.js', () => ({
  fetchGroupRatioForSite: (...args: unknown[]) => fetchGroupRatioForSiteMock(...args),
}));

vi.mock('./accountGroupRatioStore.js', () => ({
  upsertAccountGroupRatios: (...args: unknown[]) => upsertAccountGroupRatiosMock(...args),
  markAccountGroupRatioRefreshFailure: (...args: unknown[]) => markFailureMock(...args),
}));

describe('groupRatioRefreshService', () => {
  beforeEach(() => {
    fetchGroupRatioForSiteMock.mockReset();
    upsertAccountGroupRatiosMock.mockReset();
    markFailureMock.mockReset();
  });

  it('persists group ratios after retry success', async () => {
    fetchGroupRatioForSiteMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ default: 1, vip: 0.3 });

    const result = await refreshGroupRatiosForAccountRow({
      row: {
        accounts: { id: 1, username: 'u', accessToken: 'session', apiToken: 'sk', extraConfig: null, status: 'active' },
        sites: { id: 2, name: 'site', url: 'https://site.example.com', platform: 'new-api', status: 'active' },
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(result.status).toBe('synced');
    expect(upsertAccountGroupRatiosMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 1,
      siteId: 2,
      ratios: { default: 1, vip: 0.3 },
    }));
    expect(markFailureMock).not.toHaveBeenCalled();
  });

  it('marks refresh failure without overwriting last-known-good ratios', async () => {
    fetchGroupRatioForSiteMock.mockRejectedValue(new Error('upstream down'));

    const result = await refreshGroupRatiosForAccountRow({
      row: {
        accounts: { id: 1, username: 'u', accessToken: 'session', apiToken: 'sk', extraConfig: null, status: 'active' },
        sites: { id: 2, name: 'site', url: 'https://site.example.com', platform: 'new-api', status: 'active' },
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(result.status).toBe('failed');
    expect(fetchGroupRatioForSiteMock).toHaveBeenCalledTimes(5);
    expect(upsertAccountGroupRatiosMock).not.toHaveBeenCalled();
    expect(markFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 1,
      siteId: 2,
      failedAttempts: 5,
    }));
  });
});
