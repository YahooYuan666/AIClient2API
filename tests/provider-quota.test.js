jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import { normalizeCodexQuota } from '../src/ui-modules/provider-api.js';

describe('Codex provider quota normalization', () => {
    test('normalizes rate limit windows and durations', () => {
        expect(normalizeCodexQuota({ plan_type: 'Plus', rate_limit: {
            primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_at: 123 },
            secondary_window: { used_percent: 57, limit_window_seconds: 604800, reset_at: 456 }
        } })).toEqual({
            available: true,
            planType: 'Plus',
            windows: [
                { key: '5h', usedPercentage: 32, durationMinutes: 300, resetsAt: 123000 },
                { key: 'weekly', usedPercentage: 57, durationMinutes: 10080, resetsAt: 456000 }
            ]
        });
    });
});
