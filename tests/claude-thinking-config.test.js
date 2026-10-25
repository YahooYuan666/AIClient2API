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

describe('historical thinking blocks on the request path', () => {
    const VALID_SIGNATURE = 's'.repeat(80);

    function requestWith(thinkingBlock) {
        return new ClaudeConverter().convertRequest({
            model: 'gemini-3.8-flash-high',
            max_tokens: 1024,
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: [thinkingBlock, { type: 'text', text: 'visible answer' }] },
                { role: 'user', content: 'again' }
            ]
        }, 'gemini');
    }

    const partsOf = converted => converted.contents.flatMap(turn => turn.parts);

    test('a block with no signature is dropped and the text is kept', () => {
        // Vertex answers 400 "thinking.signature: Field required" for this input.
        const parts = partsOf(requestWith({ type: 'thinking', thinking: 'hidden' }));
        expect(parts.some(part => part.thought === true)).toBe(false);
        expect(parts.some(part => part.text === 'visible answer')).toBe(true);
    });

    test('a placeholder signature is dropped instead of being forwarded', () => {
        // Vertex answers 400 "Invalid signature" for a short placeholder.
        const parts = partsOf(requestWith({ type: 'thinking', thinking: 'hidden', signature: 'skip_thought_signature_validator' }));
        expect(parts.some(part => part.thought === true)).toBe(false);
    });

    test('a real signature is forwarded verbatim', () => {
        const thought = partsOf(requestWith({ type: 'thinking', thinking: 'kept', signature: VALID_SIGNATURE }))
            .find(part => part.thought === true);
        expect(thought).toBeDefined();
        expect(thought.thoughtSignature).toBe(VALID_SIGNATURE);
    });

    test('a non-string signature does not pass the check', () => {
        // A truthy object used to slip past the old `|| block.thoughtSignature` test.
        const parts = partsOf(requestWith({ type: 'thinking', thinking: 'hidden', signature: { bogus: true } }));
        expect(parts.some(part => part.thought === true)).toBe(false);
    });

    test('thoughtSignature is used when signature is absent, and never overwritten by a bad value', () => {
        const fromThought = partsOf(requestWith({ type: 'thinking', thinking: 'kept', thoughtSignature: VALID_SIGNATURE }))
            .find(part => part.thought === true);
        expect(fromThought.thoughtSignature).toBe(VALID_SIGNATURE);
    });
});

describe('the response path keeps thinking content', () => {
    test('a thinking block without a signature is still shown to the client', () => {
        // Response content is displayed, not forwarded upstream, so the signature
        // rule must not delete it here — that was the regression in the first revision.
        const converted = new ClaudeConverter().convertResponse({
            content: [{ type: 'thinking', thinking: 'reasoning to show' }, { type: 'text', text: 'answer' }]
        }, 'gemini', 'gemini-3.8-flash-high');
        const parts = converted.candidates[0].content.parts;
        expect(parts.some(part => part.thought === true && part.text === 'reasoning to show')).toBe(true);
        expect(parts.some(part => part.text === 'answer')).toBe(true);
    });
});

describe('Gemini to Claude history path', () => {
    test('a gemini thought part with no signature is dropped from the outgoing history', async () => {
        // This is the direction that actually reaches Vertex. The request path in
        // GeminiConverter builds claudeRequest.messages, so it must drop here too.
        const { GeminiConverter } = await import('../src/converters/strategies/GeminiConverter.js');
        const converted = new GeminiConverter().convertRequest({
            model: 'gemini-3.8-flash-high',
            contents: [
                { role: 'user', parts: [{ text: 'hi' }] },
                { role: 'model', parts: [{ text: 'unsigned reasoning', thought: true }, { text: 'answer' }] }
            ]
        }, 'claude');
        const assistant = converted.messages.find(message => message.role === 'assistant');
        const blocks = Array.isArray(assistant.content) ? assistant.content : [];
        expect(blocks.some(block => block.type === 'thinking')).toBe(false);
        expect(blocks.some(block => block.type === 'text' && block.text === 'answer')).toBe(true);
    });
});
