// Total raw upstream fetch attempts for transient same-endpoint failures.
export const FORBIDDEN_SAME_CHANNEL_MAX_ATTEMPTS = 5;
export const FORBIDDEN_SAME_CHANNEL_RETRY_BASE_DELAY_MS = 250;
export const FORBIDDEN_SAME_CHANNEL_RETRY_MAX_DELAY_MS = 1_000;
const SAME_ENDPOINT_RETRYABLE_STATUSES = new Set([403, 502]);

type RetryableResponse = {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  body?: {
    cancel?: (reason?: unknown) => Promise<unknown> | unknown;
  } | null;
};

export function shouldRetryForbiddenOnSameChannel(status: number, retryCount: number): boolean {
  return SAME_ENDPOINT_RETRYABLE_STATUSES.has(status) && retryCount < FORBIDDEN_SAME_CHANNEL_MAX_ATTEMPTS - 1;
}

export function getForbiddenSameChannelRetryDelayMs(retryCount: number): number {
  const normalizedRetryCount = Math.max(0, Math.trunc(retryCount));
  return Math.min(
    FORBIDDEN_SAME_CHANNEL_RETRY_BASE_DELAY_MS * (normalizedRetryCount + 1),
    FORBIDDEN_SAME_CHANNEL_RETRY_MAX_DELAY_MS,
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForbiddenSameChannelRetry(retryCount: number): Promise<void> {
  await sleep(getForbiddenSameChannelRetryDelayMs(retryCount));
}

async function discardResponseBody(response: RetryableResponse): Promise<void> {
  try {
    if (typeof response.text === 'function') {
      await response.text();
      return;
    }
  } catch {
    // Fall back to cancellation below.
  }

  try {
    await response.body?.cancel?.();
  } catch {
    // Best-effort cleanup only; retry behavior should not depend on body drain.
  }
}

export async function retryForbiddenResponseOnSameChannel<T extends RetryableResponse>(
  operation: () => Promise<T>,
): Promise<T> {
  let retryCount = 0;

  while (true) {
    const response = await operation();
    if (!shouldRetryForbiddenOnSameChannel(response.status, retryCount)) {
      return response;
    }
    const currentRetryCount = retryCount;
    retryCount += 1;
    await discardResponseBody(response);
    await waitForbiddenSameChannelRetry(currentRetryCount);
  }
}
