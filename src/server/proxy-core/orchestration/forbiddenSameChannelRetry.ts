// Total raw upstream fetch attempts for transient 403s on the same endpoint.
export const FORBIDDEN_SAME_CHANNEL_MAX_ATTEMPTS = 5;

type RetryableResponse = {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  body?: {
    cancel?: (reason?: unknown) => Promise<unknown> | unknown;
  } | null;
};

export function shouldRetryForbiddenOnSameChannel(status: number, retryCount: number): boolean {
  return status === 403 && retryCount < FORBIDDEN_SAME_CHANNEL_MAX_ATTEMPTS - 1;
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
    retryCount += 1;
    await discardResponseBody(response);
  }
}
