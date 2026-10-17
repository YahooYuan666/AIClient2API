jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import { createCodexQuotaBadgeLoader } from '../static/app/codex-quota-badges.js';
import { normalizeCodexQuota } from '../src/ui-modules/provider-api.js';

describe('Codex quota badge loader', () => {
    const badge = () => ({
        dataset: { providerUuid: 'account-1' },
        isConnected: true,
        textContent: '',
        title: ''
    });
    const container = item => ({ querySelectorAll: () => [item] });

    test('loads and caches a provider quota', async () => {
        const apiClient = { get: jest.fn().mockResolvedValue({ quota: { available: true, planType: 'Plus', windows: [
            { key: '5h', usedPercentage: 32, resetsAt: null }, { key: 'weekly', usedPercentage: 57, resetsAt: null }
        ] } }) };
        const b = badge();
        const load = createCodexQuotaBadgeLoader({ apiClient, translate: key => key, now: () => 0 });
        await load(container(b));
        await Promise.resolve();
        expect(apiClient.get).toHaveBeenCalledTimes(1);
        expect(b.textContent).toContain('32%');
        await load(container(b));
        expect(apiClient.get).toHaveBeenCalledTimes(1);
    });

    test('renders unavailable when the request fails', async () => {
        const b = badge();
        const load = createCodexQuotaBadgeLoader({ apiClient: { get: jest.fn().mockRejectedValue(new Error('offline')) }, translate: key => key });
        await load(container(b));
        await Promise.resolve();
        expect(b.textContent).toBe('providers.codexQuota.unavailable');
    });

    test('normalizes Unix-second reset times before rendering the badge', async () => {
        const quota = normalizeCodexQuota({
            plan_type: 'plus',
            rate_limit: {
                primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_at: 1800003600 },
                secondary_window: { used_percent: 57, limit_window_seconds: 604800, reset_at: 1800604800 }
            }
        });
        const apiClient = { get: jest.fn().mockResolvedValue({ quota }) };
        const b = badge();
        const load = createCodexQuotaBadgeLoader({ apiClient, translate: key => key });

        await load(container(b));

        expect(quota.windows.map(window => window.resetsAt)).toEqual([1800003600000, 1800604800000]);
        expect(b.title).toContain(new Date(1800003600000).toLocaleString());
        expect(b.title).toContain(new Date(1800604800000).toLocaleString());
        expect(b.title).not.toContain(new Date(1800003600).toLocaleString());
    });

    test.each([null, '', true, 'not-a-number'])('rejects malformed used_percent value %p', usedPercent => {
        const quota = normalizeCodexQuota({ rate_limit: { primary_window: { used_percent: usedPercent } } });

        expect(quota.available).toBe(false);
        expect(quota.windows).toEqual([]);
    });
});
