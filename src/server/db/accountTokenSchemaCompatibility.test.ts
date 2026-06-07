import { describe, expect, it } from 'vitest';
import { ACCOUNT_TOKEN_COLUMN_COMPATIBILITY_SPECS } from './accountTokenSchemaCompatibility.js';

describe('account token schema compatibility specs', () => {
  it('keeps mysql upstream-created-at shim aligned with generated datetime DDL', () => {
    const spec = ACCOUNT_TOKEN_COLUMN_COMPATIBILITY_SPECS.find((item) => item.column === 'upstream_created_at');

    expect(spec?.addSql.mysql).toBe(
      'ALTER TABLE `account_tokens` ADD COLUMN `upstream_created_at` VARCHAR(191) NULL',
    );
  });
});
