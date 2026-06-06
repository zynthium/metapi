export function formatMultiplier(value: unknown, fallback = '-'): string {
  const multiplier = Number(value);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return fallback;
  return `${Number.parseFloat(multiplier.toFixed(6)).toString()}x`;
}
