import { runConnectionMaintenance } from './connectionMaintenanceService.js';

export async function runPeriodicMaintenance() {
  return runConnectionMaintenance();
}
