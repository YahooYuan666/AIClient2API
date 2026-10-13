const GPT_EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

// Kiro only accepts additionalModelRequestFields for models whose schema exposes
// effort controls. Older Claude 4.5/Haiku models reject the whole field with 400.
const CLAUDE_EFFORT_LEVELS = new Map([
    ['claude-opus-5.5', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-sonnet-5.5', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-opus-5', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-opus-4.8', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-opus-4.7', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-opus-4.6', new Set(['low', 'medium', 'high', 'max'])],
    ['claude-sonnet-5', new Set(['low', 'medium', 'high', 'xhigh', 'max'])],
    ['claude-sonnet-4.6', new Set(['low', 'medium', 'high', 'max'])]
]);

const GPT_EFFORT_MODELS = new Set([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
]);

function normalizeModel(model) {
    return String(model || '').toLowerCase().replace(/^[^:]+:/, '').replace('gpt-5_6', 'gpt-5.6');
}

function normalizeExplicitEffort(outputConfig, reasoningEffort) {
    const effort = reasoningEffort || outputConfig?.effort;
    return typeof effort === 'string' ? effort.toLowerCase().trim() : '';
}

/**
 * Build Kiro's model-specific effort extension. Unsupported models must omit
 * additionalModelRequestFields entirely; Kiro does not ignore unknown fields.
 */
export function buildKiroAdditionalModelRequestFields(model, thinking, outputConfig = null, reasoningEffort = null) {
    const normalizedModel = normalizeModel(model);
    const explicitEffort = normalizeExplicitEffort(outputConfig, reasoningEffort);

    if (GPT_EFFORT_MODELS.has(normalizedModel)) {
        let effort = '';
        if (thinking?.type === 'disabled') {
            effort = 'none';
        } else if (explicitEffort) {
            effort = GPT_EFFORT_LEVELS.has(explicitEffort) ? explicitEffort : 'high';
        }

        return effort ? { reasoning: { effort } } : undefined;
    }

    const supportedLevels = CLAUDE_EFFORT_LEVELS.get(normalizedModel);
    if (!supportedLevels) {
        return undefined;
    }

    let effort = '';
    if (explicitEffort) {
        effort = supportedLevels.has(explicitEffort) ? explicitEffort : 'medium';
    } else if (thinking?.type === 'enabled' || thinking?.type === 'adaptive') {
        effort = 'medium';
    }

    return effort ? { output_config: { effort } } : undefined;
}
