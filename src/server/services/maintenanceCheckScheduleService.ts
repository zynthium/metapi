import cron from 'node-cron';
import { config } from '../config.js';
import {
  DEFAULT_CONNECTION_MAINTENANCE_STAGES,
  type ConnectionMaintenanceStageKey,
} from './connectionMaintenanceConfig.js';

export type MaintenanceCheckScheduleReason =
  | 'maintenance_disabled'
  | 'stage_disabled'
  | 'subject_disabled'
  | 'not_scheduled';

export type MaintenanceCheckSchedule = {
  enabled: boolean;
  nextCheckAt: string | null;
  reason: MaintenanceCheckScheduleReason | null;
};

export type ConnectionMaintenanceScheduleContext = {
  maintenanceEnabled: boolean;
  cron: string;
  nextMaintenanceAt: string | null;
  stages: Record<ConnectionMaintenanceStageKey, boolean>;
};

type CachedNextRun = {
  cron: string;
  computedAtMs: number;
  nextRunAt: string | null;
};

let cachedNextRun: CachedNextRun | null = null;

function normalizeIsoTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function resolveTokenHealthNextCheckAt(input: {
  tokenNextProbeAt?: string | Date | null;
  nextMaintenanceAt?: string | Date | null;
}): string | null {
  return normalizeIsoTimestamp(input.tokenNextProbeAt)
    ?? normalizeIsoTimestamp(input.nextMaintenanceAt);
}

export function buildMaintenanceCheckSchedule(input: {
  maintenanceEnabled: boolean;
  stageEnabled?: boolean;
  subjectEnabled?: boolean;
  nextMaintenanceAt?: string | Date | null;
  nextCheckAt?: string | Date | null;
}): MaintenanceCheckSchedule {
  if (input.subjectEnabled === false) {
    return { enabled: false, nextCheckAt: null, reason: 'subject_disabled' };
  }
  if (!input.maintenanceEnabled) {
    return { enabled: false, nextCheckAt: null, reason: 'maintenance_disabled' };
  }
  if (input.stageEnabled === false) {
    return { enabled: false, nextCheckAt: null, reason: 'stage_disabled' };
  }

  const nextCheckAt = normalizeIsoTimestamp(input.nextCheckAt)
    ?? normalizeIsoTimestamp(input.nextMaintenanceAt);
  if (!nextCheckAt) {
    return { enabled: false, nextCheckAt: null, reason: 'not_scheduled' };
  }

  return { enabled: true, nextCheckAt, reason: null };
}

function calculateNextCronRunAt(cronExpr: string): string | null {
  if (!cron.validate(cronExpr)) return null;
  let task: cron.ScheduledTask | null = null;
  try {
    task = cron.schedule(cronExpr, () => {});
    return task.getNextRun()?.toISOString() ?? null;
  } catch {
    return null;
  } finally {
    try {
      task?.stop();
      task?.destroy();
    } catch {}
  }
}

export function getNextConnectionMaintenanceRunAt(cronExpr = config.connectionMaintenanceCron): string | null {
  const normalizedCron = String(cronExpr || '').trim();
  if (!normalizedCron) return null;

  const nowMs = Date.now();
  if (
    cachedNextRun
    && cachedNextRun.cron === normalizedCron
    && cachedNextRun.nextRunAt
    && Date.parse(cachedNextRun.nextRunAt) > nowMs
    && nowMs - cachedNextRun.computedAtMs < 30_000
  ) {
    return cachedNextRun.nextRunAt;
  }

  const nextRunAt = calculateNextCronRunAt(normalizedCron);
  cachedNextRun = {
    cron: normalizedCron,
    computedAtMs: nowMs,
    nextRunAt,
  };
  return nextRunAt;
}

export function getConnectionMaintenanceScheduleContext(): ConnectionMaintenanceScheduleContext {
  const stages = {
    ...DEFAULT_CONNECTION_MAINTENANCE_STAGES,
    ...config.connectionMaintenanceStages,
  };
  return {
    maintenanceEnabled: config.connectionMaintenanceEnabled,
    cron: config.connectionMaintenanceCron,
    nextMaintenanceAt: config.connectionMaintenanceEnabled
      ? getNextConnectionMaintenanceRunAt(config.connectionMaintenanceCron)
      : null,
    stages,
  };
}

export function buildStageCheckSchedule(input: {
  context: ConnectionMaintenanceScheduleContext;
  stage: ConnectionMaintenanceStageKey;
  subjectEnabled?: boolean;
  nextCheckAt?: string | Date | null;
}): MaintenanceCheckSchedule {
  return buildMaintenanceCheckSchedule({
    maintenanceEnabled: input.context.maintenanceEnabled,
    stageEnabled: input.context.stages[input.stage] !== false,
    subjectEnabled: input.subjectEnabled,
    nextMaintenanceAt: input.context.nextMaintenanceAt,
    nextCheckAt: input.nextCheckAt,
  });
}
