import { refreshAllBalances } from './balanceService.js';
import { syncAllAccountTokens } from './accountTokenSyncService.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';
import { refreshAllRouteDecisionSnapshots } from './routeDecisionRefreshService.js';

export async function runPeriodicMaintenance() {
  const balanceRefresh = await refreshAllBalances();
  const accountTokenSync = await syncAllAccountTokens();
  const routeRefresh = await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
  const routeDecisionSnapshots = await refreshAllRouteDecisionSnapshots({
    refreshPricingCatalog: true,
  });

  return {
    balanceRefresh,
    accountTokenSync,
    routeRefresh,
    routeDecisionSnapshots,
    summary: {
      balances: {
        total: balanceRefresh.length,
        refreshed: balanceRefresh.filter((item) => item.balance != null).length,
        failed: balanceRefresh.filter((item) => item.balance == null).length,
      },
      tokenSync: accountTokenSync.summary,
      routeRefresh: {
        refreshedAccounts: routeRefresh.refresh.length,
        models: routeRefresh.rebuild.models,
        createdRoutes: routeRefresh.rebuild.createdRoutes,
        createdChannels: routeRefresh.rebuild.createdChannels,
        updatedChannels: routeRefresh.rebuild.updatedChannels,
        removedChannels: routeRefresh.rebuild.removedChannels,
        removedRoutes: routeRefresh.rebuild.removedRoutes,
      },
      routeDecisionSnapshots,
    },
  };
}
