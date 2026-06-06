import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { runMaintenanceWithRetry } from './maintenanceRetry.js';

export type SiteAccessRefreshResult = {
  siteId: number;
  siteName: string;
  url: string;
  status: 'reachable' | 'failed' | 'skipped';
  latencyMs: number | null;
  error: string | null;
  attempts: Array<{ attempt: number; ok: boolean; error: string | null }>;
};

async function probeSiteUrl(url: string, signal: AbortSignal): Promise<number> {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
  });
  if (response.status >= 500) {
    throw new Error(`HTTP ${response.status}`);
  }
  return Date.now() - started;
}

export async function refreshSiteAccessForRow(input: {
  site: typeof schema.sites.$inferSelect;
  retryAttempts: number;
  attemptTimeoutMs: number;
  backoffMs?: (attempt: number) => number;
}): Promise<SiteAccessRefreshResult> {
  const url = String(input.site.url || '').trim();
  if (!url || (input.site.status || 'active') === 'disabled') {
    return {
      siteId: input.site.id,
      siteName: input.site.name,
      url,
      status: 'skipped',
      latencyMs: null,
      error: url ? 'site disabled' : 'missing site url',
      attempts: [],
    };
  }

  const result = await runMaintenanceWithRetry({
    label: `site-access:${input.site.id}`,
    attempts: input.retryAttempts,
    attemptTimeoutMs: input.attemptTimeoutMs,
    backoffMs: input.backoffMs,
    run: async (signal) => probeSiteUrl(url, signal),
  });

  return {
    siteId: input.site.id,
    siteName: input.site.name,
    url,
    status: result.ok ? 'reachable' : 'failed',
    latencyMs: result.ok ? result.value : null,
    error: result.ok ? null : result.error,
    attempts: result.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      ok: attempt.ok,
      error: attempt.error,
    })),
  };
}

export async function refreshAllSiteAccess(options?: {
  retryAttempts?: number;
  attemptTimeoutMs?: number;
  concurrency?: number;
}) {
  const retryAttempts = options?.retryAttempts || 5;
  const attemptTimeoutMs = options?.attemptTimeoutMs || 15_000;
  const concurrency = Math.max(1, Math.trunc(options?.concurrency || 3));
  const sites = await db.select()
    .from(schema.sites)
    .where(eq(schema.sites.status, 'active'))
    .all();
  const results: SiteAccessRefreshResult[] = [];

  for (let offset = 0; offset < sites.length; offset += concurrency) {
    const batch = sites.slice(offset, offset + concurrency);
    results.push(...await Promise.all(batch.map((site) => refreshSiteAccessForRow({
      site,
      retryAttempts,
      attemptTimeoutMs,
    }))));
  }

  return {
    total: results.length,
    reachable: results.filter((item) => item.status === 'reachable').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    results,
  };
}
