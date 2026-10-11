import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));

let ClaudeConverter;

beforeAll(async () => {
    ({ ClaudeConverter } = await import('../src/converters/strategies/ClaudeConverter.js'));
});

function convert(thinking) {
    const converter = new ClaudeConverter();
    return converter.convertRequest({
        model: 'gemini-3.8-flash-high',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
        ...(thinking ? { thinking } : {})
    }, 'gemini');
}

describe('Claude thinking parameter maps to one camelCase includeThoughts', () => {
    test('enabled thinking sets includeThoughts and never the snake_case twin', () => {
        const { generationConfig } = convert({ type: 'enabled', budget_tokens: 2048 });
        expect(generationConfig.thinkingConfig.includeThoughts).toBe(true);
        expect(generationConfig.thinkingConfig).not.toHaveProperty('include_thoughts');
        expect(generationConfig.thinkingConfig.thinkingBudget).toBe(2048);
    });

    test('disabled or absent thinking adds no thinking config', () => {
        expect(convert({ type: 'disabled' }).generationConfig?.thinkingConfig).toBeUndefined();
        expect(convert(null).generationConfig?.thinkingConfig).toBeUndefined();
    });
});
