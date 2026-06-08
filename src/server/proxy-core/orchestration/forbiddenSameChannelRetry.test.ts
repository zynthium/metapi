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
  it.each([403, 502])('uses at most five same-endpoint attempts for transient %s responses', async (status) => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockResolvedValueOnce(new Response('upstream failed 1', { status }))
      .mockResolvedValueOnce(new Response('upstream failed 2', { status }))
      .mockResolvedValueOnce(new Response('upstream failed 3', { status }))
      .mockResolvedValueOnce(new Response('upstream failed 4', { status }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const responsePromise = retryForbiddenResponseOnSameChannel(operation);
    await vi.advanceTimersByTimeAsync(totalRetryDelayMs());
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it.each([403, 502])('returns the final %s after five same-endpoint attempts are exhausted', async (status) => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockImplementation(() => Promise.resolve(new Response('still failing', { status })));

    const responsePromise = retryForbiddenResponseOnSameChannel(operation);
    await vi.advanceTimersByTimeAsync(totalRetryDelayMs());
    const response = await responsePromise;

    expect(response.status).toBe(status);
    expect(await response.text()).toBe('still failing');
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it.each([403, 502])('waits before retrying a transient %s on the same endpoint', async (status) => {
    vi.useFakeTimers();
    const firstDelayMs = getForbiddenSameChannelRetryDelayMs(0);
    const operation = vi.fn()
      .mockResolvedValueOnce(new Response('upstream failed 1', { status }))
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
