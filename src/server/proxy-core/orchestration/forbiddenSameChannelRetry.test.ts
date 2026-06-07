import { describe, expect, it, vi } from 'vitest';
import { retryForbiddenResponseOnSameChannel } from './forbiddenSameChannelRetry.js';

describe('retryForbiddenResponseOnSameChannel', () => {
  it('retries five transient 403 responses before returning a same-channel success', async () => {
    const operation = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden 1', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 2', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 3', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 4', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 5', { status: 403 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await retryForbiddenResponseOnSameChannel(operation);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(6);
  });

  it('returns the final 403 after five same-channel retries are exhausted', async () => {
    const operation = vi.fn()
      .mockImplementation(() => Promise.resolve(new Response('still forbidden', { status: 403 })));

    const response = await retryForbiddenResponseOnSameChannel(operation);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('still forbidden');
    expect(operation).toHaveBeenCalledTimes(6);
  });
});
