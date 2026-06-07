export const DEFAULT_REMOTE_RETRY_ATTEMPTS = 3;

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

const RETRYABLE_REMOTE_PATTERNS: RegExp[] = [
  /network error/i,
  /fetch failed/i,
  /socket hang up/i,
  /econnreset/i,
  /etimedout/i,
  /econnrefused/i,
  /enotfound/i,
  /ehostunreach/i,
  /request timed out/i,
  /connection timed out/i,
  /read timeout/i,
  /\btimed out\b/i,
  /timeout/i,
  /temporar(?:y|ily)/i,
  /try again/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway time-?out/i,
  /too many requests/i,
  /rate limit/i,
  /connection reset/i,
  /connection refused/i,
  /临时/,
  /超时/,
  /稍后重试/,
];

const NON_RETRYABLE_REMOTE_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /invalid access token/i,
  /access token required/i,
  /new-api-user required/i,
  /unauthorized/i,
  /forbidden/i,
  /permission denied/i,
  /invalid request/i,
  /missing required/i,
  /validation/i,
  /malformed/i,
  /invalid json/i,
  /无权/,
  /未授权/,
  /凭证无效/,
];

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '');
}

function parseHttpStatus(message: string): number | null {
  const match = message.match(/\bHTTP\s+(\d{3})\b/i) || message.match(/\bstatus(?:\s+code)?[:=]?\s*(\d{3})\b/i);
  if (!match) return null;
  const status = Number.parseInt(match[1] || '', 10);
  return Number.isFinite(status) ? status : null;
}

function matchesAny(patterns: RegExp[], message: string): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function isRetryableRemoteMessage(message?: string | null, status?: number | null): boolean {
  const text = (message || '').trim();
  const resolvedStatus = typeof status === 'number' && Number.isFinite(status)
    ? status
    : parseHttpStatus(text);

  if (resolvedStatus !== null) {
    if (RETRYABLE_STATUS_CODES.has(resolvedStatus)) return true;
    if (NON_RETRYABLE_STATUS_CODES.has(resolvedStatus)) return false;
  }

  if (!text) return false;
  if (matchesAny(NON_RETRYABLE_REMOTE_PATTERNS, text)) return false;
  return matchesAny(RETRYABLE_REMOTE_PATTERNS, text);
}

export function isRetryableRemoteError(error: unknown): boolean {
  return isRetryableRemoteMessage(messageFromError(error));
}

export async function retryRemoteOperation<T>(input: {
  label: string;
  attempts?: number;
  backoffMs?: (attempt: number) => number;
  run: (attempt: number) => Promise<T>;
  shouldRetryError?: (error: unknown, attempt: number) => boolean;
  shouldRetryResult?: (result: T, attempt: number) => boolean;
}): Promise<T> {
  const attempts = Math.max(1, Math.trunc(input.attempts || DEFAULT_REMOTE_RETRY_ATTEMPTS));
  const shouldRetryError = input.shouldRetryError || isRetryableRemoteError;
  let lastResult: T | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await input.run(attempt);
      lastResult = result;
      if (attempt < attempts && input.shouldRetryResult?.(result, attempt)) {
        await sleep(input.backoffMs?.(attempt) ?? Math.min(50 * attempt, 250));
        continue;
      }
      return result;
    } catch (error) {
      if (attempt >= attempts || !shouldRetryError(error, attempt)) {
        throw error;
      }
      await sleep(input.backoffMs?.(attempt) ?? Math.min(50 * attempt, 250));
    }
  }

  return lastResult as T;
}
