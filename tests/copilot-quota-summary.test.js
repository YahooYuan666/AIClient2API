import { createCopilotQuotaUsageLoader } from '../static/app/copilot-quota-summary.js';

describe('Copilot quota summary loader', () => {
    const accounts = [
        { uuid: 'one', isHealthy: true, isDisabled: false },
        { uuid: 'two', isHealthy: true, isDisabled: false },
        { uuid: 'unhealthy', isHealthy: false, isDisabled: false },
        { uuid: 'disabled', isHealthy: true, isDisabled: true }
    ];

    test('aggregates healthy enabled account percentages', async () => {
        const apiClient = {
            get: jest.fn()
                .mockResolvedValueOnce({ quota: { usedPercentage: 25, isUnlimited: false } })
                .mockResolvedValueOnce({ quota: { usedPercentage: 40, isUnlimited: false } })
        };

        await expect(createCopilotQuotaUsageLoader({ apiClient })(accounts)).resolves.toEqual({
            available: true,
            usedPercent: 65,
            totalPercent: 200
        });
        expect(apiClient.get).toHaveBeenCalledTimes(2);
        expect(apiClient.get).toHaveBeenNthCalledWith(1, '/providers/github-copilot/one/quota');
    });

    test('returns an unavailable summary when an account is unlimited', async () => {
        const apiClient = { get: jest.fn()
            .mockResolvedValueOnce({ quota: { usedPercentage: 25, isUnlimited: false } })
            .mockResolvedValueOnce({ quota: { usedPercentage: null, isUnlimited: true } }) };

        await expect(createCopilotQuotaUsageLoader({ apiClient })(accounts)).resolves.toEqual({
            available: false,
            usedPercent: null,
            totalPercent: null
        });
    });

    test('returns an unavailable summary when a quota request fails', async () => {
        const apiClient = { get: jest.fn().mockRejectedValue(new Error('failed')) };

        await expect(createCopilotQuotaUsageLoader({ apiClient })(accounts)).resolves.toEqual({
            available: false,
            usedPercent: null,
            totalPercent: null
        });
    });

    test('returns an empty available summary when there are no eligible accounts', async () => {
        const apiClient = { get: jest.fn() };
        await expect(createCopilotQuotaUsageLoader({ apiClient })([])).resolves.toEqual({
            available: true,
            usedPercent: 0,
            totalPercent: 0
        });
        expect(apiClient.get).not.toHaveBeenCalled();
    });
});
