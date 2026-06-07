import { describe, expect, it } from 'vitest';
import { classifyLegacyCompatMutation } from './legacySchemaCompat.js';

describe('legacy schema compat boundary', () => {
  it('allows only explicitly registered legacy upgrade shims', () => {
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN billing_details text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN is_stream integer;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN first_byte_latency_ms integer;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN client_app_id text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE INDEX proxy_logs_client_app_id_created_at_idx ON proxy_logs(client_app_id, created_at);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE account_tokens ADD COLUMN upstream_token_id text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE account_tokens ADD COLUMN probe_model text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN token_health_probe_model text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE TABLE IF NOT EXISTS account_token_health (id integer PRIMARY KEY AUTOINCREMENT NOT NULL);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE UNIQUE INDEX account_token_health_token_unique ON account_token_health(token_id);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE INDEX account_token_health_status_idx ON account_token_health(status);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE INDEX account_tokens_account_upstream_token_idx ON account_tokens(account_id, upstream_token_id);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "use_system_proxy" = FALSE WHERE "use_system_proxy" IS NULL')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN brand_new_column text;')).toBe('forbidden');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "brand_new_column" = 1')).toBe('forbidden');
  });
});
