export const CODEX_QUOTA_CACHE_TTL_MS = 60_000;

export function createCodexQuotaBadgeLoader({ apiClient, translate, now = () => Date.now() }) {
    const cache = new Map();
    const requests = new Map();
    const t = (key, params) => translate(key, params);
    const render = (badge, result) => {
        if (!badge.isConnected && badge.isConnected !== undefined) return;
        const quota = result?.response?.quota;
        if (result?.error || !quota?.available || !quota.windows?.length) {
            badge.textContent = t('providers.codexQuota.unavailable');
            badge.title = t('providers.codexQuota.unavailable');
            return;
        }
        const labels = { '5h': 'providers.codexQuota.fiveHour', weekly: 'providers.codexQuota.weekly', monthly: 'providers.codexQuota.monthly', other: 'providers.codexQuota.other' };
        badge.textContent = quota.windows.map(window => `${t(labels[window.key] || labels.other)} ${Math.round(window.usedPercentage)}% ${t('providers.codexQuota.windowUsed')}`).join(' · ');
        const plan = quota.planType || t('providers.codexQuota.unknownPlan');
        const details = quota.windows.map(window => {
            const reset = window.resetsAt ? new Date(window.resetsAt).toLocaleString() : t('providers.codexQuota.unknownReset');
            return `${t(labels[window.key] || labels.other)}: ${Math.round(window.usedPercentage)}% · ${reset}`;
        }).join('\n');
        badge.title = `${t('providers.codexQuota.details')}: ${plan}\n${details}`;
    };
    return function loadCodexQuotaBadges(container) {
        if (!container) return Promise.resolve();
        const badges = container.querySelectorAll('.codex-quota-badge[data-provider-uuid]');
        const promises = Array.from(badges).map(badge => {
            const uuid = badge.dataset.providerUuid;
            const cached = cache.get(uuid);
            if (cached && now() - cached.cachedAt < CODEX_QUOTA_CACHE_TTL_MS) {
                render(badge, cached.result);
                return Promise.resolve();
            }
            badge.textContent = t('providers.codexQuota.loading');
            let request = requests.get(uuid);
            if (!request) {
                request = apiClient.get(`/providers/openai-codex-oauth/${encodeURIComponent(uuid)}/quota`)
                    .then(response => ({ response }))
                    .catch(() => ({ error: true }))
                    .then(result => { cache.set(uuid, { cachedAt: now(), result }); return result; })
                    .finally(() => requests.delete(uuid));
                requests.set(uuid, request);
            }
            return request.then(result => render(badge, result));
        });
        return Promise.all(promises);
    };
}
