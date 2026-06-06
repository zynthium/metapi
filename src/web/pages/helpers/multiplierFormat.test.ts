import { describe, expect, it } from 'vitest';
import { formatMultiplier } from './multiplierFormat.js';

describe('formatMultiplier', () => {
  it('formats multipliers with suffix x and up to six decimals', () => {
    expect(formatMultiplier(1)).toBe('1x');
    expect(formatMultiplier(0.3)).toBe('0.3x');
    expect(formatMultiplier(0.001)).toBe('0.001x');
    expect(formatMultiplier(0.3333337)).toBe('0.333334x');
  });

  it('uses fallback for missing or invalid multipliers', () => {
    expect(formatMultiplier(null)).toBe('-');
    expect(formatMultiplier(undefined, '自动')).toBe('自动');
    expect(formatMultiplier(0, '自动')).toBe('自动');
    expect(formatMultiplier(Number.NaN, '自动')).toBe('自动');
  });
});
