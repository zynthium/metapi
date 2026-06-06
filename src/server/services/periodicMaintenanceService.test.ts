import { beforeEach, describe, expect, it, vi } from 'vitest';

const runConnectionMaintenanceMock = vi.fn();

vi.mock('./connectionMaintenanceService.js', () => ({
  runConnectionMaintenance: (...args: unknown[]) => runConnectionMaintenanceMock(...args),
}));

describe('periodicMaintenanceService', () => {
  beforeEach(() => {
    runConnectionMaintenanceMock.mockReset();
    runConnectionMaintenanceMock.mockResolvedValue({
      skipped: false,
      stages: {
        siteAccess: { total: 1 },
      },
      summary: {
        siteAccess: { total: 1 },
      },
    });
  });

  it('delegates periodic maintenance to the connection maintenance orchestrator', async () => {
    const { runPeriodicMaintenance } = await import('./periodicMaintenanceService.js');

    const result = await runPeriodicMaintenance();

    expect(runConnectionMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runConnectionMaintenanceMock).toHaveBeenCalledWith();
    expect(result).toMatchObject({
      skipped: false,
      summary: {
        siteAccess: { total: 1 },
      },
    });
  });
});
