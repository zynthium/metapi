import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Settings from './Settings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    getBrandList: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getUpdateCenterStatus: vi.fn(),
    checkUpdateCenter: vi.fn(),
    saveUpdateCenterConfig: vi.fn(),
    streamUpdateCenterTaskLogs: vi.fn(),
    deployUpdateCenter: vi.fn(),
    rollbackUpdateCenter: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Settings connection maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'cron',
      checkinIntervalHours: 6,
      balanceRefreshCron: '0 * * * *',
      connectionMaintenanceEnabled: true,
      connectionMaintenanceCron: '*/15 * * * *',
      connectionMaintenanceRetryAttempts: 5,
      connectionMaintenanceAttemptTimeoutSec: 20,
      connectionMaintenanceConcurrency: 4,
      connectionMaintenanceStages: {
        accountHealth: true,
        tokens: true,
        groupRatios: true,
      },
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({ success: true });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getUpdateCenterStatus.mockResolvedValue({});
    apiMock.checkUpdateCenter.mockResolvedValue({});
    apiMock.saveUpdateCenterConfig.mockResolvedValue({});
    apiMock.streamUpdateCenterTaskLogs.mockReturnValue(() => {});
    apiMock.deployUpdateCenter.mockResolvedValue({});
    apiMock.rollbackUpdateCenter.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders connection maintenance advanced settings', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      const inputValues = root.root
        .findAll((node) => node.type === 'input')
        .map((node) => node.props.value);
      expect(text).toContain('连接维护');
      expect(inputValues).toContain('*/15 * * * *');
      expect(text).toContain('重试次数');
      expect(text).toContain('并发');
    } finally {
      root?.unmount();
    }
  });
});
