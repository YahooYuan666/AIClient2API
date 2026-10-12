import { jest } from '@jest/globals';

jest.mock('../src/utils/proxy-utils.js', () => ({
    getProxyConfig: jest.fn()
}));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

let ProviderPoolManager;

beforeAll(async () => {
    ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));
});

const now = Date.now();
const later = minutes => new Date(now + minutes * 60000).toISOString();

const managers = [];

function pool(scheduler) {
    const manager = new ProviderPoolManager({
        'openai-custom': [
            node('high', 0.9, 20),
            node('low', 0.2, 100)
        ]
    }, {
        globalConfig: { ACCOUNT_SCHEDULER: scheduler },
        saveDebounceTime: 100000
    });
    manager._getBaseProviderType = () => 'gemini-antigravity';
    manager._debouncedSave = () => {};
    managers.push(manager);
    return manager;
}

afterEach(() => {
    for (const manager of managers) clearTimeout(manager.saveTimer);
    managers.length = 0;
});

function node(uuid, remaining, minutes) {
    return {
        uuid,
        isHealthy: true,
        isDisabled: false,
        quotaWindows: {
            weekly: { remainingFraction: remaining, resetAt: later(minutes) },
            fiveHour: { remainingFraction: 1, resetAt: later(60) }
        },
        quotaWindowsUpdatedAt: now
    };
}

describe('optional greedy sticky pool selection', () => {
    test('the default scheduler keeps the existing least-recently-used rotation', async () => {
        const manager = pool('lru');
        const first = await manager.acquireSlot('openai-custom', null, { sessionId: 'conversation' });
        const second = await manager.acquireSlot('openai-custom', null, { sessionId: 'conversation' });
        expect(first.uuid).not.toBe(second.uuid);
    });

    test('greedy sticky keeps one conversation on the greediest account', async () => {
        const manager = pool('greedy-sticky');
        const first = await manager.acquireSlot('openai-custom', null, { sessionId: 'conversation' });
        const second = await manager.acquireSlot('openai-custom', null, { sessionId: 'conversation' });
        expect(first.uuid).toBe('high');
        expect(second.uuid).toBe('high');
        manager.releaseSlot('openai-custom', first.uuid);
        manager.releaseSlot('openai-custom', second.uuid);
    });

    test('a full account sends a different conversation to the next account', async () => {
        const manager = pool('greedy-sticky');
        for (let i = 0; i < 3; i += 1) {
            await manager.acquireSlot('openai-custom', null, { sessionId: `conversation-${i}` });
        }
        const fourth = await manager.acquireSlot('openai-custom', null, { sessionId: 'conversation-4' });
        expect(fourth.uuid).toBe('low');
    });
});
