import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));

let handleStreamRequest;

beforeAll(async () => {
    await import('../src/converters/register-converters.js');
    ({ handleStreamRequest } = await import('../src/utils/common.js'));
});

function response() {
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = jest.fn();
    res.write = jest.fn();
    res.end = jest.fn(function end() { this.writableEnded = true; });
    return res;
}

function chunk(text, finishReason) {
    return {
        candidates: [{
            content: { role: 'model', parts: [{ text }] },
            ...(finishReason ? { finishReason } : {})
        }]
    };
}

function malformedChunk() {
    return {
        candidates: [{
            finishReason: 'MALFORMED_FUNCTION_CALL',
            content: { role: 'model', parts: [{ functionCall: { name: '', args: {} } }] }
        }]
    };
}

function serviceWith(attempts) {
    let call = 0;
    return {
        calls: () => call,
        generateContentStream: jest.fn(() => {
            const items = attempts[call] || [];
            call += 1;
            return (async function* () {
                for (const item of items) yield item;
            })();
        })
    };
}

function pool() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        releaseSlot: jest.fn()
    };
}

async function run(service, fromProvider = 'openai', toProvider = 'gemini-antigravity', model = 'gemini-3.8-flash-high') {
    const res = response();
    await handleStreamRequest(
        res, service, model, {}, fromProvider, toProvider,
        'none', null, pool(), 'only', null,
        { CONFIG: { EMPTY_RESPONSE_RETRY_DELAY_MS: 1 }, maxRetries: 0 }
    );
    return res.write.mock.calls.flat().join('');
}

describe('mid-stream invisible retry', () => {
    test('a malformed call after partial text retries the same request and keeps one response', async () => {
        const service = serviceWith([
            [chunk('partial answer'), malformedChunk()],
            [chunk(' finished', 'STOP')]
        ]);
        const body = await run(service);
        expect(service.calls()).toBe(2);
        expect(body).toContain('partial answer');
        expect(body).toContain(' finished');
        expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
        expect(body).not.toContain('error');
    });

    test('a stream that already has an upstream finish is not requested again', async () => {
        const service = serviceWith([[chunk('complete', 'STOP')]]);
        const body = await run(service);
        expect(service.calls()).toBe(1);
        expect(body).toContain('complete');
        expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
    });

    test('a native Claude message_stop counts as finished', async () => {
        const service = serviceWith([[
            { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' }
        ]]);
        const body = await run(service, 'claude', 'claude-kiro', 'claude-sonnet');
        expect(service.calls()).toBe(1);
        expect(body).toContain('message_stop');
    });
});
