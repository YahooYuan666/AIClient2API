import { t } from './i18n.js';

const statusKeys = {
    not_returned: 'models.status.notReturned',
    tier_restricted: 'models.status.tierRestricted',
    unknown: 'models.status.unknown'
};

// Display-only decoration: never use the resulting label as a request/model ID.
export function formatModelLabel(modelId, status) {
    const key = statusKeys[status];
    return key ? `${modelId} ${t(key)}` : modelId;
}
