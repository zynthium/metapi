import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const updateConnectionMaintenanceCronMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/checkinScheduler.js', () => ({
  updateBalanceRefreshCron: vi.fn(),
  updateCheckinSchedule: vi.fn(),
  updateConnectionMaintenanceCron: (...args: unknown[]) => updateConnectionMaintenanceCronMock(...args),
  updateLogCleanupSettings: vi.fn(),
}));

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

describe('settings connection maintenance runtime setting', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-connection-maintenance-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    updateConnectionMaintenanceCronMock.mockReset();
    Object.assign(config, {
      connectionMaintenanceEnabled: true,
      connectionMaintenanceCron: '0 * * * *',
      connectionMaintenanceRetryAttempts: 5,
      connectionMaintenanceAttemptTimeoutSec: 15,
      connectionMaintenanceConcurrency: 3,
      connectionMaintenanceStages: {
        siteAccess: true,
        accountHealth: true,
        tokens: true,
        groupRatios: true,
        modelCoverage: true,
        routeMultipliers: true,
        routeDecisionSnapshots: true,
        accountsSnapshot: true,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('saves connection maintenance runtime settings', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        connectionMaintenanceEnabled: true,
        connectionMaintenanceCron: '*/15 * * * *',
        connectionMaintenanceRetryAttempts: 5,
        connectionMaintenanceAttemptTimeoutSec: 20,
        connectionMaintenanceConcurrency: 4,
        connectionMaintenanceStages: {
          siteAccess: true,
          accountHealth: true,
          tokens: true,
          groupRatios: true,
          modelCoverage: true,
          routeMultipliers: true,
          routeDecisionSnapshots: true,
          accountsSnapshot: true,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateConnectionMaintenanceCronMock).toHaveBeenCalledWith('*/15 * * * *');

    const runtimeResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
    });
    const body = runtimeResponse.json();
    expect(body.connectionMaintenanceCron).toBe('*/15 * * * *');
    expect(body.connectionMaintenanceRetryAttempts).toBe(5);
    expect(body.connectionMaintenanceAttemptTimeoutSec).toBe(20);
    expect(body.connectionMaintenanceConcurrency).toBe(4);
    expect(body.connectionMaintenanceStages.groupRatios).toBe(true);
  });
});
