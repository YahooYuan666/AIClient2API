jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: config => config,
    isTLSSidecarEnabledForProvider: () => false,
    getProxyConfigForProvider: () => null
}));
jest.mock('../src/utils/tls-sidecar.js', () => ({
    ensureSidecarRunning: jest.fn(),
    stopSidecar: jest.fn()
}));
jest.mock('../src/providers/gemini/antigravity-core.js', () => ({
    isAntigravityModelRetired: jest.fn(() => false)
}));

import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { MODEL_PROVIDER } from '../src/utils/constants.js';

function createPoolManager(accounts) {
    const manager = new ProviderPoolManager({});
    manager.providerStatus[MODEL_PROVIDER.ANTIGRAVITY] = accounts.map(account => ({
        uuid: account.uuid,
        type: MODEL_PROVIDER.ANTIGRAVITY,
        config: {
            uuid: account.uuid,
            customName: account.uuid,
            isHealthy: true,
            isDisabled: false,
            needsRefresh: false,
            usageCount: 0,
            lastUsed: account.lastUsed || new Date(0).toISOString(),
            _lastSelectionSeq: account.sequence || 0
        },
        state: { activeCount: 0, waitingCount: 0, queue: [] }
    }));
    manager._debouncedSave = jest.fn();
    return manager;
}

describe('Antigravity family-scoped quota cooldowns', () => {
    test('keeps an account available for Claude after Gemini quota is exhausted', async () => {
        const pool = createPoolManager([{ uuid: 'shared-account' }]);
        const resetTime = new Date(Date.now() + 60 * 60 * 1000);
        pool.markAntigravityQuotaExhausted(MODEL_PROVIDER.ANTIGRAVITY, { uuid: 'shared-account' }, {
            model: 'gemini-3.8-flash-low',
            recoveryTime: resetTime,
            errorMessage: 'quota exhausted'
        });

        expect(pool.providerStatus[MODEL_PROVIDER.ANTIGRAVITY][0].config.isHealthy).toBe(true);
        await expect(pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low'))
            .resolves.toBeNull();
        await expect(pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'claude-sonnet-4-6'))
            .resolves.toMatchObject({ uuid: 'shared-account' });
    });

    test('reuses an account after its family quota cooldown expires', async () => {
        const pool = createPoolManager([{ uuid: 'recovered-account' }]);
        pool.markAntigravityQuotaExhausted(MODEL_PROVIDER.ANTIGRAVITY, { uuid: 'recovered-account' }, {
            model: 'gemini-3.8-flash-low',
            recoveryTime: new Date(Date.now() - 1000)
        });

        await expect(pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low'))
            .resolves.toMatchObject({ uuid: 'recovered-account' });
        expect(pool.providerStatus[MODEL_PROVIDER.ANTIGRAVITY][0].config.quotaExhaustionByFamily)
            .toBeNull();
    });

    test('migrates legacy account-wide Antigravity quota cooldowns to family-scoped tracking', async () => {
        const pool = createPoolManager([{ uuid: 'legacy-account' }]);
        const config = pool.providerStatus[MODEL_PROVIDER.ANTIGRAVITY][0].config;
        config.isHealthy = false;
        config.scheduledRecoveryTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        config.lastErrorMessage = '429 RESOURCE_EXHAUSTED - quota recovery scheduled';

        await expect(pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'claude-sonnet-4-6'))
            .resolves.toMatchObject({ uuid: 'legacy-account' });
        expect(config.isHealthy).toBe(true);
        expect(config.scheduledRecoveryTime).toBeNull();
        expect(config.quotaExhaustionByFamily).toBeUndefined();
    });
});
