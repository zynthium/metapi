export type MaintenanceRetryAttempt = {
  attempt: number;
  ok: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string;
};

export type MaintenanceRetrySuccess<T> = {
  ok: true;
  value: T;
  attempts: MaintenanceRetryAttempt[];
};

export type MaintenanceRetryFailure = {
  ok: false;
  error: string;
  attempts: MaintenanceRetryAttempt[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error || 'unknown error');
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timeout (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runMaintenanceWithRetry<T>(input: {
  label: string;
  attempts: number;
  attemptTimeoutMs: number;
  backoffMs?: (attempt: number) => number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<MaintenanceRetrySuccess<T> | MaintenanceRetryFailure> {
  const maxAttempts = Math.max(1, Math.trunc(input.attempts));
  const attempts: MaintenanceRetryAttempt[] = [];
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = new Date().toISOString();
    try {
      const value = await withTimeout(input.run, input.attemptTimeoutMs, input.label);
      attempts.push({ attempt, ok: true, error: null, startedAt, finishedAt: new Date().toISOString() });
      return { ok: true, value, attempts };
    } catch (error) {
      lastError = errorMessage(error);
      attempts.push({ attempt, ok: false, error: lastError, startedAt, finishedAt: new Date().toISOString() });
      if (attempt < maxAttempts) {
        await sleep(input.backoffMs?.(attempt) ?? Math.min(250 * attempt, 1000));
      }
    }
  }

  return { ok: false, error: lastError, attempts };
}
