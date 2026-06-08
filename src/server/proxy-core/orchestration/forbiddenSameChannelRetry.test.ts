import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORBIDDEN_SAME_CHANNEL_MAX_ATTEMPTS,
  getForbiddenSameChannelRetryDelayMs,
  retryForbiddenResponseOnSameChannel,
} from './forbiddenSameChannelRetry.js';

function totalRetryDelayMs(): number {
  return Array.from({ length: FORBIDDEN_SAME_CHANNEL_MAX_ATTEMPTS - 1 })
    .reduce((total, _value, retryCount) => total + getForbiddenSameChannelRetryDelayMs(retryCount), 0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('retryForbiddenResponseOnSameChannel', () => {
  it('uses at most five same-endpoint attempts for transient 403 responses', async () => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden 1', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 2', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 3', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 4', { status: 403 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const responsePromise = retryForbiddenResponseOnSameChannel(operation);
    await vi.advanceTimersByTimeAsync(totalRetryDelayMs());
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it('returns the final 403 after five same-endpoint attempts are exhausted', async () => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockImplementation(() => Promise.resolve(new Response('still forbidden', { status: 403 })));

    const responsePromise = retryForbiddenResponseOnSameChannel(operation);
    await vi.advanceTimersByTimeAsync(totalRetryDelayMs());
    const response = await responsePromise;

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('still forbidden');
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it('waits before retrying a transient 403 on the same endpoint', async () => {
    vi.useFakeTimers();
    const firstDelayMs = getForbiddenSameChannelRetryDelayMs(0);
    const operation = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden 1', { status: 403 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const responsePromise = retryForbiddenResponseOnSameChannel(operation);
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(firstDelayMs - 1);
    expect(operation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
