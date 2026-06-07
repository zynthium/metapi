import { useEffect, useState } from 'react';

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

function formatRemainingTime(diffMs: number): string {
  const safeDiffMs = Math.max(0, diffMs);
  const totalMinutes = Math.ceil(safeDiffMs / 60_000);
  if (totalMinutes <= 1) return '1 分钟内';
  if (totalMinutes < 60) return `${totalMinutes} 分钟后`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0
      ? `${totalHours} 小时 ${minutes} 分钟后`
      : `${totalHours} 小时后`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days} 天 ${hours} 小时后` : `${days} 天后`;
}

export function formatMaintenanceCountdownLabel(input: {
  schedule?: MaintenanceCheckSchedule | null;
  nowMs?: number;
  prefix?: string;
}): string {
  const schedule = input.schedule;
  if (!schedule) return '';

  if (schedule.reason === 'subject_disabled') return '未参与检测';
  if (schedule.reason === 'maintenance_disabled') return '未启用';
  if (schedule.reason === 'stage_disabled') return '检测已关闭';
  if (!schedule.enabled || !schedule.nextCheckAt) return '未排期';

  const nextMs = Date.parse(schedule.nextCheckAt);
  if (!Number.isFinite(nextMs)) return '未排期';

  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs! : Date.now();
  const prefix = input.prefix || '下次检测';
  if (nextMs <= nowMs) return `${prefix} 等待调度`;
  return `${prefix} ${formatRemainingTime(nextMs - nowMs)}`;
}

function resolveBadgeClass(schedule?: MaintenanceCheckSchedule | null): string {
  if (!schedule) return 'badge-muted';
  if (schedule.reason === 'subject_disabled' || schedule.reason === 'maintenance_disabled') {
    return 'badge-muted';
  }
  if (schedule.reason === 'stage_disabled' || schedule.reason === 'not_scheduled') {
    return 'badge-warning';
  }
  return schedule.enabled ? 'badge-info' : 'badge-muted';
}

export default function MaintenanceCountdown({
  schedule,
  prefix = '下次检测',
}: {
  schedule?: MaintenanceCheckSchedule | null;
  prefix?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const label = formatMaintenanceCountdownLabel({ schedule, nowMs, prefix });
  if (!label) return null;

  return (
    <span
      className={`badge ${resolveBadgeClass(schedule)}`}
      title={schedule?.nextCheckAt ? `下次检测时间：${schedule.nextCheckAt}` : label}
      style={{ fontSize: 11, whiteSpace: 'nowrap' }}
    >
      {label}
    </span>
  );
}
