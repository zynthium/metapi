import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateModelUsageBreakdown,
  calculateModelUsageCost,
  fallbackTokenCost,
  fetchGroupRatioForSite,
  type PricingModel,
} from './modelPricingService.js';

describe('modelPricingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calculates token-based cost from model ratio and completion ratio', () => {
    const model: PricingModel = {
      modelName: 'gpt-4o',
      quotaType: 0,
      modelRatio: 2,
      completionRatio: 1.5,
      modelPrice: null,
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      },
      { default: 1, vip: 2 },
    );

    expect(cost).toBe(0.014);
  });

  it('uses an explicit selected channel group multiplier for token-based cost', () => {
    const model: PricingModel = {
      modelName: 'gpt-4o',
      quotaType: 0,
      modelRatio: 2,
      completionRatio: 1.5,
      modelPrice: null,
      enableGroups: ['default', 'vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      },
      { default: 1, vip: 4 },
      0.25,
    );

    expect(cost).toBe(0.00175);
  });

  it('falls back to total tokens when split token usage is missing', () => {
    const model: PricingModel = {
      modelName: 'claude-sonnet',
      quotaType: 0,
      modelRatio: 1,
      completionRatio: 2,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 2000,
      },
      { default: 1 },
    );

    expect(cost).toBe(0.004);
  });

  it('calculates per-call cost when quota type is call-based', () => {
    const model: PricingModel = {
      modelName: 'gpt-image-1',
      quotaType: 1,
      modelRatio: 1,
      completionRatio: 1,
      modelPrice: 0.3,
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      { default: 1, vip: 1.5 },
    );

    expect(cost).toBe(0.45);
  });

  it('calculates times-based per-call cost from input ratio only', () => {
    const model: PricingModel = {
      modelName: 'flux-kontext-pro',
      quotaType: 1,
      modelRatio: 1,
      completionRatio: 1,
      modelPrice: { input: 1, output: 3 },
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      { default: 1, vip: 2 },
    );

    expect(cost).toBe(0.004);
  });

  it('splits cache read and cache creation costs from prompt cost', () => {
    const model: PricingModel = {
      modelName: 'gpt-4o',
      quotaType: 0,
      modelRatio: 2.5,
      completionRatio: 5,
      cacheRatio: 0.1,
      cacheCreationRatio: 1.25,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const detail = calculateModelUsageBreakdown(
      model,
      {
        promptTokens: 146638,
        completionTokens: 172,
        totalTokens: 146810,
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
        promptTokensIncludeCache: true,
      },
      { default: 1 },
    );

    expect(detail).toMatchObject({
      usage: {
        billablePromptTokens: 1,
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
      },
      pricing: {
        modelRatio: 2.5,
        completionRatio: 5,
        cacheRatio: 0.1,
        cacheCreationRatio: 1.25,
        groupRatio: 1,
      },
      breakdown: {
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheCreationPerMillion: 6.25,
        inputCost: 0.000005,
        outputCost: 0.0043,
        cacheReadCost: 0.072846,
        cacheCreationCost: 0.005906,
        totalCost: 0.083057,
      },
    });
  });

  it('keeps prompt tokens intact when upstream reports cache tokens separately', () => {
    const model: PricingModel = {
      modelName: 'claude-sonnet',
      quotaType: 0,
      modelRatio: 3,
      completionRatio: 5,
      cacheRatio: 0.3,
      cacheCreationRatio: 1.25,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cacheReadTokens: 1000,
        cacheCreationTokens: 40,
        promptTokensIncludeCache: false,
      },
      { default: 1 },
    );

    expect(cost).toBe(0.00372);
  });

  it('uses platform-specific fallback token divisor', () => {
    expect(fallbackTokenCost(1500, 'new-api')).toBe(0.003);
    expect(fallbackTokenCost(1500, 'veloera')).toBe(0.0015);
  });

  it('fetches sub2api group rate multipliers from available groups endpoint', async () => {
    let requestedPath = '';
    const server = await new Promise<Server>((resolve) => {
      const instance = createServer((req, res) => {
        requestedPath = req.url || '';
        if (req.url === '/api/v1/groups/available') {
          expect(req.headers.authorization).toBe('Bearer jwt-token');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            message: 'success',
            data: [
              { id: 1, name: 'default', rate_multiplier: 1 },
              { id: 2, name: 'vip', rate_multiplier: 0.3 },
              { id: 3, name: 'premium', rate_multiplier: '2.5' },
            ],
          }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'not found' }));
      });
      instance.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to listen');

    try {
      const groupRatio = await fetchGroupRatioForSite(
        { id: 1, url: `http://127.0.0.1:${address.port}`, platform: 'sub2api' },
        'jwt-token',
      );

      expect(requestedPath).toBe('/api/v1/groups/available');
      expect(groupRatio).toEqual({
        '1': 1,
        '2': 0.3,
        '3': 2.5,
        default: 1,
        vip: 0.3,
        premium: 2.5,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('fetches new-api group ratios from user self groups endpoint', async () => {
    const requestedPaths: string[] = [];
    const server = await new Promise<Server>((resolve) => {
      const instance = createServer((req, res) => {
        requestedPaths.push(req.url || '');
        if (req.url === '/api/user/self/groups') {
          expect(req.headers.authorization).toBe('Bearer session-token');
          expect(req.headers['new-api-user']).toBe('4019');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: [
              { group: 'default', ratio: 1 },
              { name: 'vip', ratio: 0.5 },
              { group_name: 'premium', rate_multiplier: 2 },
            ],
          }));
          return;
        }
        if (req.url === '/api/user/groups') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { stale: { ratio: 9 } } }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'not found' }));
      });
      instance.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to listen');

    try {
      const groupRatio = await fetchGroupRatioForSite(
        { id: 1, url: `http://127.0.0.1:${address.port}`, platform: 'new-api' },
        'session-token',
        4019,
      );

      expect(requestedPaths[0]).toBe('/api/user/self/groups');
      expect(requestedPaths).not.toContain('/api/user/groups');
      expect(groupRatio).toEqual({
        default: 1,
        vip: 0.5,
        premium: 2,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('retries transient new-api group ratio fetch failures', async () => {
    let selfGroupAttempts = 0;
    const requestedPaths: string[] = [];
    const server = await new Promise<Server>((resolve) => {
      const instance = createServer((req, res) => {
        requestedPaths.push(req.url || '');
        if (req.url === '/api/user/self/groups') {
          selfGroupAttempts += 1;
          expect(req.headers.authorization).toBe('Bearer unstable-session-token');
          expect(req.headers['new-api-user']).toBe('198');
          if (selfGroupAttempts === 1) {
            req.socket.destroy();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: {
              default: { ratio: 1 },
              'claude反代kiro': { ratio: 0.07 },
              'codex超低渠道': { ratio: 0.06 },
            },
          }));
          return;
        }
        if (req.url === '/api/user/groups') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { stale: { ratio: 9 } } }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'not found' }));
      });
      instance.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to listen');

    try {
      const groupRatio = await fetchGroupRatioForSite(
        { id: 1, url: `http://127.0.0.1:${address.port}`, platform: 'new-api' },
        'unstable-session-token',
        198,
      );

      expect(selfGroupAttempts).toBe(2);
      expect(requestedPaths).toEqual(['/api/user/self/groups', '/api/user/self/groups']);
      expect(groupRatio).toEqual({
        default: 1,
        'claude反代kiro': 0.07,
        'codex超低渠道': 0.06,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
