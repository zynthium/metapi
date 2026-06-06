import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSiteAccessForRow } from './siteAccessRefreshService.js';

describe('siteAccessRefreshService', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks a site reachable after a later retry succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ status: 200 });

    const result = await refreshSiteAccessForRow({
      site: {
        id: 1,
        name: 'site',
        url: 'https://site.example.com',
        status: 'active',
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(result.status).toBe('reachable');
    expect(result.error).toBeNull();
    expect(result.attempts).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks a site failed only after all retry attempts fail', async () => {
    fetchMock.mockResolvedValue({ status: 502 });

    const result = await refreshSiteAccessForRow({
      site: {
        id: 1,
        name: 'site',
        url: 'https://site.example.com',
        status: 'active',
      } as any,
      retryAttempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('HTTP 502');
    expect(result.attempts).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
