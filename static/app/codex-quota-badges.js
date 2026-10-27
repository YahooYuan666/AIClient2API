export const CODEX_QUOTA_CACHE_TTL_MS = 60_000;

const sharedQuotaClients = new WeakMap();

export function createCodexQuotaClient({ apiClient, now = () => Date.now(), maxConcurrentRequests = 4 } = {}) {
    const cache = new Map();
    const requests = new Map();
    const waiting = [];
    const concurrencyLimit = Math.max(1, Number(maxConcurrentRequests) || 4);
    let activeRequests = 0;

    function runWithConcurrency(task) {
        return new Promise((resolve, reject) => {
            const run = () => {
                Promise.resolve().then(task).then(resolve, reject).finally(() => {
                    const next = waiting.shift();
                    if (next) next();
                    else activeRequests -= 1;
                });
            };

            if (activeRequests < concurrencyLimit) {
                activeRequests += 1;
                run();
            } else {
                waiting.push(run);
            }
        });
    }

    function getQuota(providerUuid, { forceRefresh = false } = {}) {
        if (!providerUuid) return Promise.resolve({ error: true });
        const cached = cache.get(providerUuid);
        if (!forceRefresh && cached && now() - cached.cachedAt < CODEX_QUOTA_CACHE_TTL_MS) {
            return Promise.resolve(cached.result);
        }

        const inFlight = requests.get(providerUuid);
        if (inFlight) return inFlight;

        const request = runWithConcurrency(() => apiClient.get(
            `/providers/openai-codex-oauth/${encodeURIComponent(providerUuid)}/quota`
        ))
            .then(response => ({ response }))
            .catch(() => ({ error: true }))
            .then(result => {
                cache.set(providerUuid, { cachedAt: now(), result });
                return result;
            })
            .finally(() => requests.delete(providerUuid));
        requests.set(providerUuid, request);
        return request;
    }

    return { getQuota };
}

function getSharedCodexQuotaClient(apiClient, now) {
    if (!apiClient || typeof apiClient !== 'object') {
        throw new TypeError('An API client is required to load Codex quota.');
    }

    let client = sharedQuotaClients.get(apiClient);
    if (!client) {
        client = createCodexQuotaClient({ apiClient, now });
        sharedQuotaClients.set(apiClient, client);
    }
    return client;
}

export function createCodexQuotaUsageLoader({ apiClient, quotaClient: suppliedQuotaClient, now } = {}) {
    const quotaClient = suppliedQuotaClient || getSharedCodexQuotaClient(apiClient, now);

    return async function loadCodexQuotaUsage(providers = []) {
        const eligibleProviders = providers.filter(provider => provider?.isHealthy && !provider.isDisabled);
        const accountUsage = await Promise.all(eligibleProviders.map(async provider => {
            if (!provider.uuid) return null;

            const result = await quotaClient.getQuota(provider.uuid);
            const quota = result?.response?.quota;
            if (result?.error || !quota?.available || !Array.isArray(quota.windows) || quota.windows.length === 0) {
                return null;
            }

            const percentages = quota.windows.map(window => window?.usedPercentage);
            if (percentages.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
            return Math.round(Math.max(...percentages.map(value => Math.min(100, Math.max(0, value)))));
        }));

        const totalPercent = eligibleProviders.length * 100;
        if (accountUsage.some(value => value === null)) {
            return { available: false, usedPercent: null, totalPercent };
        }

        return {
            available: true,
            usedPercent: accountUsage.reduce((sum, value) => sum + value, 0),
            totalPercent
        };
    };
}

export function createCodexQuotaBadgeLoader({ apiClient, quotaClient: suppliedQuotaClient, translate, now = () => Date.now() } = {}) {
    const quotaClient = suppliedQuotaClient || getSharedCodexQuotaClient(apiClient, now);
    const t = (key, params) => translate(key, params);
    const labels = {
        '5h': 'providers.codexQuota.fiveHour',
        fiveHour: 'providers.codexQuota.fiveHour',
        weekly: 'providers.codexQuota.weekly',
        monthly: 'providers.codexQuota.monthly',
        other: 'providers.codexQuota.other'
    };

    function renderBadge(badge, result) {
        if (!badge.isConnected && badge.isConnected !== undefined) return;
        const quota = result?.response?.quota;
        if (result?.error || !quota?.available || !Array.isArray(quota.windows) || quota.windows.length === 0) {
            badge.textContent = t('providers.codexQuota.unavailable');
            badge.title = quota?.message || t('providers.codexQuota.unavailable');
            return;
        }

        badge.textContent = quota.windows.map(window => t('providers.codexQuota.windowUsed', {
            window: t(labels[window.key] || labels.other),
            percent: Math.round(window.usedPercentage)
        })).join(' · ');
        const details = quota.windows.map(window => {
            const reset = window.resetsAt
                ? new Date(window.resetsAt).toLocaleString()
                : t('providers.codexQuota.unknownReset');
            return `${t(labels[window.key] || labels.other)}: ${Math.round(window.usedPercentage)}% (${reset})`;
        }).join(' · ');
        badge.title = t('providers.codexQuota.details', {
            plan: quota.planType || t('providers.codexQuota.unknownPlan'),
            windows: details
        });
    }

    return function loadCodexQuotaBadges(container, {
        requestMissing = true,
        forceRefresh = false,
        providers = []
    } = {}) {
        if (!container?.querySelectorAll) return Promise.resolve();

        const badges = Array.from(container.querySelectorAll('.codex-quota-badge[data-provider-uuid]'));
        const providerUuids = new Set([
            ...badges.map(badge => badge.dataset.providerUuid),
            ...providers.map(provider => provider?.uuid).filter(Boolean)
        ]);
        const pending = [];

        providerUuids.forEach(providerUuid => {
            const accountBadges = badges.filter(badge => badge.dataset.providerUuid === providerUuid);
            if (!requestMissing && !forceRefresh) {
                accountBadges.forEach(badge => {
                    badge.textContent = t('providers.codexQuota.unavailable');
                    badge.title = t('providers.codexQuota.unavailable');
                });
                return;
            }

            accountBadges.forEach(badge => {
                badge.textContent = t('providers.codexQuota.loading');
            });
            pending.push(quotaClient.getQuota(providerUuid, { forceRefresh }).then(result => {
                accountBadges.forEach(badge => renderBadge(badge, result));
            }));
        });

        return Promise.all(pending);
    };
}
