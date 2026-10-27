/**
 * Antigravity exposes two independent quota books:
 * - gemini: first-party Gemini models
 * - 3p: third-party Claude/GPT models
 */
export function quotaFamilyForModel(model) {
    const normalized = String(model || '').toLowerCase();
    return normalized.startsWith('claude-') || normalized.startsWith('gpt-oss-') || normalized.startsWith('gemini-claude-')
        ? '3p'
        : 'gemini';
}
