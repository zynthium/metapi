import { describe, expect, it, vi } from 'vitest';
import { runMaintenanceWithRetry } from './maintenanceRetry.js';

describe('runMaintenanceWithRetry', () => {
  it('returns success after a later attempt succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('temporary-1'))
      .mockRejectedValueOnce(new Error('temporary-2'))
      .mockResolvedValueOnce('ok');

    const result = await runMaintenanceWithRetry({
      label: 'token-sync',
      attempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
      run: fn,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('ok');
    expect(result.attempts).toHaveLength(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns failure only after all attempts fail', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('upstream unavailable'));

    const result = await runMaintenanceWithRetry({
      label: 'health-refresh',
      attempts: 5,
      attemptTimeoutMs: 1000,
      backoffMs: () => 0,
      run: fn,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('upstream unavailable');
    expect(result.attempts).toHaveLength(5);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
