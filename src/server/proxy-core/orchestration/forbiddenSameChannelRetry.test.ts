import { describe, expect, it, vi } from 'vitest';
import { retryForbiddenResponseOnSameChannel } from './forbiddenSameChannelRetry.js';

describe('retryForbiddenResponseOnSameChannel', () => {
  it('uses at most five same-endpoint attempts for transient 403 responses', async () => {
    const operation = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden 1', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 2', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 3', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden 4', { status: 403 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await retryForbiddenResponseOnSameChannel(operation);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it('returns the final 403 after five same-endpoint attempts are exhausted', async () => {
    const operation = vi.fn()
      .mockImplementation(() => Promise.resolve(new Response('still forbidden', { status: 403 })));

    const response = await retryForbiddenResponseOnSameChannel(operation);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('still forbidden');
    expect(operation).toHaveBeenCalledTimes(5);
  });
});
