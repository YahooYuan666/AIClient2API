import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));

const mockRetryService = {
    generateContentStream: jest.fn()
};
const mockGetApiServiceWithFallback = jest.fn();
jest.mock('../src/services/service-manager.js', () => ({
    getApiServiceWithFallback: mockGetApiServiceWithFallback
}));

let handleStreamRequest;

beforeAll(async () => {
    await import('../src/converters/register-converters.js');
    ({ handleStreamRequest } = await import('../src/utils/common.js'));
});

function geminiChunk({ text, thought = false, call, finishReason } = {}) {
    const parts = [];
    if (text !== undefined) parts.push({ text, ...(thought ? { thought: true } : {}) });
    if (call) parts.push({ functionCall: call });
    return {
        candidates: [{
            content: { role: 'model', parts },
            ...(finishReason ? { finishReason } : {})
        }]
    };
}

function streamOf(items) {
    return (async function* () {
        for (const item of items) {
            if (item instanceof Error) throw item;
            yield item;
        }
    })();
}

function response() {
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = jest.fn();
    res.write = jest.fn();
    res.end = jest.fn(function end() { this.writableEnded = true; });
    return res;
}

function pool() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        releaseSlot: jest.fn()
    };
}

function events(res) {
    const raw = res.write.mock.calls.flat().join('');
    const result = [];
    let eventType = null;
    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        if (line.startsWith('data: ')) {
            try { result.push({ event: eventType, data: JSON.parse(line.slice(6)) }); } catch {}
            eventType = null;
        }
    }
    return result;
}

async function run({ nativeChunks, fromProvider = 'claude', toProvider = 'gemini-antigravity', serviceOverride, retryContext } = {}) {
    const res = response();
    const service = serviceOverride || { generateContentStream: jest.fn(() => streamOf(nativeChunks)) };
    const manager = pool();
    await handleStreamRequest(
        res, service, 'gemini-3.8-flash-high', {}, fromProvider, toProvider,
        'none', null, manager, 'test-account', null,
        retryContext || { CONFIG: { EMPTY_RESPONSE_RETRY_DELAY_MS: 1 }, maxRetries: 1 }
    );
    return { res, service, manager, out: events(res) };
}

function starts(out) { return out.filter(x => x.data?.type === 'content_block_start'); }
function stops(out) { return out.filter(x => x.data?.type === 'content_block_stop'); }
function deltas(out) { return out.filter(x => x.data?.type === 'content_block_delta'); }

describe('Gemini → Claude stream protocol (#718)', () => {
    beforeEach(() => {
        mockGetApiServiceWithFallback.mockReset();
        mockRetryService.generateContentStream.mockReset();
    });

    test('real Gemini plain text gets message start, text start/delta/stop, terminal sequence', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ text: 'hello', finishReason: 'STOP' })
        ] });
        expect(out.filter(x => x.data?.type === 'message_start')).toHaveLength(1);
        expect(starts(out)).toHaveLength(1);
        expect(starts(out)[0].data.content_block.type).toBe('text');
        expect(deltas(out)[0].data.index).toBe(starts(out)[0].data.index);
        expect(stops(out)).toHaveLength(1);
        expect(out.some(x => x.data?.type === 'message_delta' && x.data.delta?.stop_reason === 'end_turn')).toBe(true);
        expect(out.filter(x => x.data?.type === 'message_stop')).toHaveLength(1);
    });

    test('thinking then text creates two correctly paired blocks with different indexes', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ text: 'reason', thought: true }),
            geminiChunk({ text: 'answer', finishReason: 'STOP' })
        ] });
        const blockStarts = starts(out);
        expect(blockStarts.map(x => x.data.content_block.type)).toEqual(['thinking', 'text']);
        expect(blockStarts.map(x => x.data.index)).toEqual([0, 1]);
        expect(stops(out).map(x => x.data.index)).toEqual([0, 1]);
        expect(deltas(out).map(x => x.data.index)).toEqual([0, 1]);
    });

    test('two Gemini function calls receive independent Claude block indexes', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ call: { id: 'tool-a', name: 'Read', args: { file_path: 'a.png' } } }),
            geminiChunk({ call: { id: 'tool-b', name: 'Bash', args: { command: 'dir' } }, finishReason: 'STOP' })
        ] });
        const blockStarts = starts(out).filter(x => x.data.content_block.type === 'tool_use');
        expect(blockStarts).toHaveLength(2);
        expect(blockStarts.map(x => x.data.index)).toEqual([0, 1]);
        expect(blockStarts.map(x => x.data.content_block.name)).toEqual(['Read', 'Bash']);
        const jsonDeltas = deltas(out).filter(x => x.data.delta?.type === 'input_json_delta');
        expect(jsonDeltas.map(x => x.data.index)).toEqual([0, 1]);
        expect(stops(out).map(x => x.data.index)).toEqual([0, 1]);
        expect(out.some(x => x.data?.type === 'message_delta' && x.data.delta?.stop_reason === 'tool_use')).toBe(true);
    });

    test('native Claude stream is passed through without duplicate starts or stops', async () => {
        const native = [
            { type: 'message_start', message: { id: 'native', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native text' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' }
        ];
        const { out } = await run({ nativeChunks: native, fromProvider: 'claude', toProvider: 'claude' });
        expect(out.filter(x => x.data?.type === 'message_start')).toHaveLength(1);
        expect(starts(out)).toHaveLength(1);
        expect(stops(out)).toHaveLength(1);
        expect(out.filter(x => x.data?.type === 'message_stop')).toHaveLength(1);
        expect(out.find(x => x.data?.type === 'content_block_start').data.index).toBe(0);
    });

    test('server_tool_use input_json_delta stays server tool and never invents an empty-name tool', async () => {
        const native = [
            { type: 'message_start', message: { id: 'native', type: 'message', role: 'assistant', content: [], usage: {} } },
            { type: 'content_block_start', index: 3, content_block: { type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: {} } },
            { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"query":"zcode"}' } },
            { type: 'content_block_stop', index: 3 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            { type: 'message_stop' }
        ];
        const { out } = await run({ nativeChunks: native, fromProvider: 'claude', toProvider: 'claude' });
        const serverStart = starts(out).find(x => x.data.content_block.type === 'server_tool_use');
        expect(serverStart.data.content_block.name).toBe('web_search');
        expect(deltas(out).find(x => x.data.delta?.type === 'input_json_delta').data.index).toBe(3);
        expect(starts(out).some(x => x.data.content_block.type === 'tool_use' && !x.data.content_block.name)).toBe(false);
    });

    test('interleaved Responses tool arguments stay on their own calls', async () => {
        const native = [
            { type: 'response.created', response: { id: 'resp-1', model: 'gpt' } },
            { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-a', name: 'get_city' } },
            { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call-b', name: 'get_country' } },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call-a', delta: '{"city":"' },
            { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'call-b', delta: '{"country":"' },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call-a', delta: 'Paris"}' },
            { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'call-b', delta: 'France"}' },
            { type: 'response.function_call_arguments.done', output_index: 0 },
            { type: 'response.function_call_arguments.done', output_index: 1 },
            { type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } }
        ];
        const { out } = await run({
            nativeChunks: native,
            fromProvider: 'claude',
            toProvider: 'grok-cli-oauth'
        });
        const tools = starts(out).filter(x => x.data.content_block.type === 'tool_use');
        expect(tools.map(x => x.data.content_block.id)).toEqual(['call-a', 'call-b']);
        expect(tools.map(x => x.data.content_block.name)).toEqual(['get_city', 'get_country']);
        const args = index => deltas(out)
            .filter(x => x.data.index === index && x.data.delta?.type === 'input_json_delta')
            .map(x => x.data.delta.partial_json)
            .join('');
        expect(JSON.parse(args(tools[0].data.index))).toEqual({ city: 'Paris' });
        expect(JSON.parse(args(tools[1].data.index))).toEqual({ country: 'France' });
        expect(stops(out)).toHaveLength(2);
    });

    function responsesMixed({ textFirst, thinking = false }) {
        const textIndex = textFirst ? 0 : 1;
        const toolIndex = textFirst ? 1 : 0;
        const textOpen = thinking
            ? { type: 'response.reasoning_summary_text.delta', output_index: textIndex, item_id: 'msg-a', delta: 'Checking Paris' }
            : { type: 'response.content_part.added', output_index: textIndex, item_id: 'msg-a', content_index: 0, part: { type: 'output_text' } };
        const textDelta = thinking
            ? null
            : { type: 'response.output_text.delta', output_index: textIndex, item_id: 'msg-a', content_index: 0, delta: 'Checking Paris' };
        const textDone = thinking
            ? { type: 'response.reasoning_summary_text.done', output_index: textIndex, item_id: 'msg-a' }
            : { type: 'response.output_text.done', output_index: textIndex, item_id: 'msg-a', content_index: 0 };
        const textItem = [textOpen, textDelta, textDone].filter(Boolean);
        const toolItem = [
            { type: 'response.output_item.added', output_index: toolIndex, item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'get_city' } },
            { type: 'response.function_call_arguments.delta', output_index: toolIndex, item_id: 'item-a', delta: '{"city":"' },
            { type: 'response.function_call_arguments.delta', output_index: toolIndex, item_id: 'item-a', delta: 'Paris"}' },
            { type: 'response.function_call_arguments.done', output_index: toolIndex, item_id: 'item-a' },
            { type: 'response.output_item.done', output_index: toolIndex, item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'get_city', arguments: '{"city":"Paris"}' } }
        ];
        const opened = textFirst ? [...textItem.slice(0, 1), ...toolItem.slice(0, 1)] : [...toolItem.slice(0, 1), ...textItem.slice(0, 1)];
        const middle = [
            toolItem[1],
            ...(thinking ? [] : [textItem[1]]),
            toolItem[2]
        ];
        const closed = textFirst
            ? [textItem[textItem.length - 1], ...toolItem.slice(3)]
            : [...toolItem.slice(3), textItem[textItem.length - 1]];
        return [
            { type: 'response.created', response: { id: 'resp-1', model: 'gpt' } },
            ...opened,
            ...middle,
            ...closed,
            { type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } }
        ];
    }

    async function expectMixedResponses(native, textType) {
        const { out } = await run({
            nativeChunks: native,
            fromProvider: 'claude',
            toProvider: 'grok-cli-oauth'
        });
        const tool = starts(out).find(x => x.data.content_block.type === 'tool_use');
        const text = starts(out).find(x => x.data.content_block.type === textType);
        const joined = (index, deltaType, field) => deltas(out)
            .filter(x => x.data.index === index && x.data.delta?.type === deltaType)
            .map(x => x.data.delta[field])
            .join('');
        expect(JSON.parse(joined(tool.data.index, 'input_json_delta', 'partial_json'))).toEqual({ city: 'Paris' });
        expect(joined(text.data.index, textType === 'thinking' ? 'thinking_delta' : 'text_delta', textType === 'thinking' ? 'thinking' : 'text')).toBe('Checking Paris');
        expect(starts(out)).toHaveLength(2);
        expect(stops(out)).toHaveLength(2);
        const startIndexes = starts(out).map(x => x.data.index);
        expect(new Set(stops(out).map(x => x.data.index))).toEqual(new Set(startIndexes));
    }

    test('Responses tool opened before text keeps both blocks when their deltas interleave', async () => {
        await expectMixedResponses(responsesMixed({ textFirst: false }), 'text');
    });

    test('Responses text opened before the tool keeps the tool arguments parseable', async () => {
        await expectMixedResponses(responsesMixed({ textFirst: true }), 'text');
    });

    test('Responses thinking opened before the tool keeps the tool arguments parseable', async () => {
        await expectMixedResponses(responsesMixed({ textFirst: true, thinking: true }), 'thinking');
    });

    test('synthetic text block closes when the message ends even without a tool call', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ text: 'Hello' }),
            geminiChunk({ finishReason: 'STOP' })
        ] });
        const started = starts(out).map(x => x.data.index);
        const closed = stops(out).map(x => x.data.index);
        expect(started).toEqual([0]);
        expect(closed).toEqual([0]);
        expect(out.filter(x => x.data?.type === 'message_stop')).toHaveLength(1);
    });

    test('synthetic text block closes before a following tool block opens', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ text: 'Let me look that up.' }),
            geminiChunk({ call: { id: 'a', name: 'lookup', args: { a: 1 } }, finishReason: 'STOP' })
        ] });
        const started = starts(out).map(x => x.data.index);
        const closed = stops(out).map(x => x.data.index);
        expect(started).toEqual([0, 1]);
        expect(closed).toEqual([0, 1]);
        const events = out.map(x => x.data?.type);
        expect(events.indexOf('content_block_stop')).toBeLessThan(events.lastIndexOf('content_block_start'));
    });

    test('synthetic thinking block closes before a following tool block opens', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ text: 'Thinking', thought: true }),
            geminiChunk({ call: { id: 'a', name: 'lookup', args: { a: 1 } }, finishReason: 'STOP' })
        ] });
        const started = starts(out).map(x => x.data.index);
        const closed = stops(out).map(x => x.data.index);
        expect(started).toEqual([0, 1]);
        expect(closed).toEqual([0, 1]);
        expect(out.find(x => x.data?.type === 'content_block_start').data.content_block.type).toBe('thinking');
    });

    test('empty first stream then recursive retry emits one complete shared Claude sequence', async () => {
        const first = { generateContentStream: jest.fn(() => streamOf([])) };
        mockRetryService.generateContentStream.mockImplementation(() => streamOf([
            geminiChunk({ text: 'retry result', finishReason: 'STOP' })
        ]));
        mockGetApiServiceWithFallback.mockResolvedValue({
            service: mockRetryService,
            actualModel: 'gemini-3.8-flash-high',
            actualProviderType: 'gemini-antigravity',
            uuid: 'retry-account',
            serviceConfig: {}
        });

        const { out } = await run({
            serviceOverride: first,
            retryContext: { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1, EMPTY_RESPONSE_RETRY_DELAY_MS: 1 }, maxRetries: 1 }
        });
        expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(out.filter(x => x.data?.type === 'message_start')).toHaveLength(1);
        expect(starts(out)).toHaveLength(1);
        expect(stops(out)).toHaveLength(1);
        expect(out.filter(x => x.data?.type === 'message_stop')).toHaveLength(1);
    });
});
