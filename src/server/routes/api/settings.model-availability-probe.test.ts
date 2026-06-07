import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const { startModelAvailabilityProbeSchedulerMock, stopModelAvailabilityProbeSchedulerMock } = vi.hoisted(() => ({
  startModelAvailabilityProbeSchedulerMock: vi.fn(),
  stopModelAvailabilityProbeSchedulerMock: vi.fn(),
}));

vi.mock('../../services/modelAvailabilityProbeService.js', () => ({
  startModelAvailabilityProbeScheduler: startModelAvailabilityProbeSchedulerMock,
  stopModelAvailabilityProbeScheduler: stopModelAvailabilityProbeSchedulerMock,
}));

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

describe('settings model availability probe runtime setting', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-model-probe-'));
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
    config.modelAvailabilityProbeEnabled = false;
    config.tokenHealthProbeModel = '';
    config.tokenHealthStaleHours = 6;
    startModelAvailabilityProbeSchedulerMock.mockReset();
    stopModelAvailabilityProbeSchedulerMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('persists enabling the model availability probe and starts the scheduler', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        modelAvailabilityProbeEnabled: true,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as { modelAvailabilityProbeEnabled?: boolean };
    expect(updated.modelAvailabilityProbeEnabled).toBe(true);
    expect(config.modelAvailabilityProbeEnabled).toBe(true);
    expect(startModelAvailabilityProbeSchedulerMock).toHaveBeenCalledTimes(1);
    expect(stopModelAvailabilityProbeSchedulerMock).not.toHaveBeenCalled();

    const saved = await db.select().from(schema.settings).where(eq(schema.settings.key, 'model_availability_probe_enabled')).get();
    expect(saved?.value).toBe(JSON.stringify(true));

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
    });
    expect(getResponse.statusCode).toBe(200);
    expect((getResponse.json() as { modelAvailabilityProbeEnabled?: boolean }).modelAvailabilityProbeEnabled).toBe(true);
  });

  it('persists disabling the model availability probe and stops the scheduler', async () => {
    config.modelAvailabilityProbeEnabled = true;

    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        modelAvailabilityProbeEnabled: false,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as { modelAvailabilityProbeEnabled?: boolean };
    expect(updated.modelAvailabilityProbeEnabled).toBe(false);
    expect(config.modelAvailabilityProbeEnabled).toBe(false);
    expect(stopModelAvailabilityProbeSchedulerMock).toHaveBeenCalledTimes(1);
    expect(startModelAvailabilityProbeSchedulerMock).not.toHaveBeenCalled();

    const saved = await db.select().from(schema.settings).where(eq(schema.settings.key, 'model_availability_probe_enabled')).get();
    expect(saved?.value).toBe(JSON.stringify(false));
  });

  it('persists token health probe runtime defaults', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        tokenHealthProbeModel: ' gpt-5-mini ',
        tokenHealthStaleHours: 12,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as {
      tokenHealthProbeModel?: string;
      tokenHealthStaleHours?: number;
    };
    expect(updated.tokenHealthProbeModel).toBe('gpt-5-mini');
    expect(updated.tokenHealthStaleHours).toBe(12);
    expect(config.tokenHealthProbeModel).toBe('gpt-5-mini');
    expect(config.tokenHealthStaleHours).toBe(12);

    const savedModel = await db.select().from(schema.settings).where(eq(schema.settings.key, 'token_health_probe_model')).get();
    expect(savedModel?.value).toBe(JSON.stringify('gpt-5-mini'));
    const savedStaleHours = await db.select().from(schema.settings).where(eq(schema.settings.key, 'token_health_stale_hours')).get();
    expect(savedStaleHours?.value).toBe(JSON.stringify(12));

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      tokenHealthProbeModel: 'gpt-5-mini',
      tokenHealthStaleHours: 12,
    });
  });
});
