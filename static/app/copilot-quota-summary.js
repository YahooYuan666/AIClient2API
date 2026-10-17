/**
 * Create a loader for the aggregate GitHub Copilot quota summary.
 *
 * @param {{ apiClient: { get: (path: string) => Promise<any> } }} options
 * @returns {(providers: Array<Object>) => Promise<Object>}
 */
export function createCopilotQuotaUsageLoader({ apiClient }) {
    return async function loadCopilotQuotaUsage(providers = []) {
        const accounts = providers.filter(provider => provider?.isHealthy && !provider?.isDisabled);

        if (accounts.length === 0) {
            return { available: true, usedPercent: 0, totalPercent: 0 };
        }

        try {
            const quotas = await Promise.all(accounts.map(async account => {
                const result = await apiClient.get(
                    `/providers/github-copilot/${encodeURIComponent(account.uuid)}/quota`
                );
                return result?.quota || result;
            }));

            if (quotas.some(quota => !quota || quota.isUnlimited || typeof quota.usedPercentage !== 'number')) {
                return { available: false, usedPercent: null, totalPercent: null };
            }

            const usedPercent = quotas.reduce((sum, quota) => sum + quota.usedPercentage, 0);
            const totalPercent = accounts.length * 100;
            return {
                available: true,
                usedPercent,
                totalPercent
            };
        } catch (error) {
            return { available: false, usedPercent: null, totalPercent: null };
        }
    };
}
