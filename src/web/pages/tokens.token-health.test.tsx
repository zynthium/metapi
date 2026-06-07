import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { TokensPanel } from './Tokens.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountTokens: vi.fn(),
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    getAccountTokenValue: vi.fn(),
    getAccountTokenGroups: vi.fn(),
    updateAccountToken: vi.fn(),
    probeAccountTokenHealth: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
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

function buildRoot(): ReactTestRenderer {
  return create(
    <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
      <ToastProvider>
        <TokensPanel />
      </ToastProvider>
    </MemoryRouter>,
    {
      createNodeMock: (element) => {
        if (element.type === 'tr' || element.type === 'div') {
          return {
            scrollIntoView: () => undefined,
          };
        }
        return {};
      },
    },
  );
}

describe('Tokens account token health UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'codex-user',
        accessToken: 'session-token',
        status: 'active',
        credentialMode: 'session',
        site: { id: 10, name: 'newapi', platform: 'new-api', status: 'active', url: 'https://newapi.example.com' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'newapi', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([
      {
        id: 11,
        accountId: 1,
        name: 'codex-day',
        tokenMasked: 'sk-abc***1234',
        valueStatus: 'ready',
        enabled: true,
        isDefault: false,
        tokenGroup: 'default',
        groupMultiplier: 1,
        probeModel: 'gpt-5-mini',
        updatedAt: '2026-06-07T00:00:00.000Z',
        account: { username: 'codex-user' },
        site: { name: 'newapi', url: 'https://newapi.example.com' },
        health: {
          status: 'request_failed_pending_probe',
          label: '业务失败待复检',
          probeModel: 'gpt-5-mini',
          probeModelSource: 'token',
          lastFailureAt: '2026-06-07T00:00:00.000Z',
          lastError: 'HTTP 429 quota exhausted',
        },
      },
    ]);
    apiMock.getAccountTokenValue.mockResolvedValue({
      success: true,
      token: 'sk-real-token',
    });
    apiMock.getAccountTokenGroups.mockResolvedValue({
      success: true,
      groups: ['default'],
    });
    apiMock.updateAccountToken.mockResolvedValue({ success: true });
    apiMock.probeAccountTokenHealth.mockResolvedValue({
      success: true,
      result: { tokenId: 11, status: 'healthy' },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders token health and effective probe model', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();

      const renderedText = collectText(root.root);
      expect(renderedText).toContain('业务失败待复检');
      expect(renderedText).toContain('探测模型：gpt-5-mini（令牌）');
      expect(renderedText).toContain('HTTP 429 quota exhausted');
    } finally {
      root?.unmount();
    }
  });

  it('can manually probe a token and reload the list', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();
      const loadCountBeforeProbe = apiMock.getAccountTokens.mock.calls.length;

      const probeButton = root.root.find((node) => (
        node.type === 'button'
        && collectText(node).trim() === '探测'
      ));
      await act(async () => {
        probeButton.props.onClick({ stopPropagation: () => undefined });
      });
      await flushMicrotasks();

      expect(apiMock.probeAccountTokenHealth).toHaveBeenCalledWith(11, true);
      expect(apiMock.getAccountTokens).toHaveBeenCalledTimes(loadCountBeforeProbe + 1);
    } finally {
      root?.unmount();
    }
  });

  it('can save custom token probe model', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();

      const editButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => collectText(node).includes('编辑'));
      expect(editButton).toBeTruthy();

      await act(async () => {
        editButton!.props.onClick({ stopPropagation: () => undefined });
      });
      await flushMicrotasks();

      const customMode = root.root.find((node) => (
        node.type === 'input'
        && node.props.type === 'radio'
        && node.props.value === 'custom'
      ));
      await act(async () => {
        customMode.props.onChange({ target: { checked: true } });
      });

      const probeModelInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '例如 gpt-5-mini'
      ));
      await act(async () => {
        probeModelInput.props.onChange({ target: { value: 'gpt-5' } });
      });

      const saveButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => collectText(node).includes('保存修改'));
      expect(saveButton).toBeTruthy();

      await act(async () => {
        saveButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateAccountToken).toHaveBeenCalledWith(11, expect.objectContaining({
        probeModel: 'gpt-5',
      }));
    } finally {
      root?.unmount();
    }
  });
});
