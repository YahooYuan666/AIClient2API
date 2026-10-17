import { weeklyGreed, quotaWindowState, compareAccounts, extractSessionId, extractQuotaWindows, quotaFamilyForModel, QUOTA_FAMILY_GEMINI, QUOTA_FAMILY_THIRD_PARTY, familyWindows, GreedyStickyScheduler } from '../src/providers/greedy-sticky-scheduler.js';

const now = Date.parse('2026-10-11T12:00:00.000Z');
const weekly = (remaining, minutes) => ({ remainingFraction: remaining, resetAt: new Date(now + minutes * 60000).toISOString() });
const account = (uuid, weekRemaining, weekMinutes, hourRemaining = 1, updatedAt = now) => ({
    uuid,
    weekly: weekly(weekRemaining, weekMinutes),
    fiveHour: weekly(hourRemaining, 60),
    updatedAt
});

describe('weekly greed and eligibility', () => {
    test('closer reset and higher quota score higher, with a 600 second floor', () => {
        expect(weeklyGreed(0.8, new Date(now + 600000).toISOString(), now))
            .toBeGreaterThan(weeklyGreed(0.8, new Date(now + 3600000).toISOString(), now));
        expect(weeklyGreed(0.2, new Date(now + 1000).toISOString(), now)).toBeCloseTo(0.2 / 600);
        expect(weeklyGreed(2, new Date(now + 600000).toISOString(), now)).toBeNull();
    });

    test('an exhausted window whose reset already passed is eligible again', () => {
        expect(quotaWindowState({ remainingFraction: 0, resetAt: new Date(now - 1000).toISOString() }, now)).toBe('reset-due');
        expect(quotaWindowState({ remainingFraction: 0, resetAt: new Date(now + 1000).toISOString() }, now)).toBe('exhausted');
        expect(quotaWindowState({ remainingFraction: 'bad', resetAt: null }, now)).toBe('unknown');
    });

    test('fresh complete quota outranks stale quota', () => {
        const ranked = [account('stale', 1, 10, 1, now - 21 * 60000), account('fresh', 0.1, 100)].sort((a, b) => compareAccounts(a, b, now));
        expect(ranked.map(item => item.uuid)).toEqual(['fresh', 'stale']);
    });

    test('reads only the gemini weekly and five-hour buckets', () => {
        const windows = extractQuotaWindows({
            groups: [{
                buckets: [
                    { bucketId: 'gemini-weekly', remainingFraction: 0.9, resetTime: '2026-10-18T12:00:00Z' },
                    { bucketId: 'gemini-5h', remainingFraction: 1.4, resetTime: '2026-10-11T17:00:00Z' },
                    { bucketId: '3p-weekly', remainingFraction: 0.2, resetTime: '2026-10-18T12:00:00Z' }
                ]
            }]
        });
        expect(windows.weekly.remainingFraction).toBeCloseTo(0.9);
        expect(windows.fiveHour.remainingFraction).toBe(1);
        expect(extractQuotaWindows({ models: {} })).toEqual({
            weekly: null, fiveHour: null,
            gemini: { weekly: null, fiveHour: null },
            thirdParty: { weekly: null, fiveHour: null }
        });
    });

    test('third-party buckets land in their own family', () => {
        const windows = extractQuotaWindows({
            groups: [{
                buckets: [
                    { bucketId: 'gemini-weekly', remainingFraction: 0.9, resetTime: '2026-10-18T12:00:00Z' },
                    { bucketId: 'gemini-5h', remainingFraction: 0.8, resetTime: '2026-10-11T17:00:00Z' },
                    { bucketId: '3p-weekly', remainingFraction: 0.7, resetTime: '2026-10-18T12:00:00Z' },
                    { bucketId: '3p-5h', remainingFraction: 0.6, resetTime: '2026-10-11T17:00:00Z' }
                ]
            }]
        });
        expect(windows.gemini.weekly.remainingFraction).toBeCloseTo(0.9);
        expect(windows.gemini.fiveHour.remainingFraction).toBeCloseTo(0.8);
        expect(windows.thirdParty.weekly.remainingFraction).toBeCloseTo(0.7);
        expect(windows.thirdParty.fiveHour.remainingFraction).toBeCloseTo(0.6);
        expect(quotaFamilyForModel('gemini-claude-sonnet-4-6')).toBe(QUOTA_FAMILY_THIRD_PARTY);
        expect(quotaFamilyForModel('gemini-claude-opus-4-6-thinking')).toBe(QUOTA_FAMILY_THIRD_PARTY);
        expect(quotaFamilyForModel('claude-sonnet-4-6')).toBe(QUOTA_FAMILY_THIRD_PARTY);
        expect(quotaFamilyForModel('gpt-oss-120b-medium')).toBe(QUOTA_FAMILY_THIRD_PARTY);
        expect(quotaFamilyForModel('models/claude-sonnet-4-6')).toBe(QUOTA_FAMILY_THIRD_PARTY);
        expect(quotaFamilyForModel('gemini-3.8-flash-high')).toBe(QUOTA_FAMILY_GEMINI);
        expect(quotaFamilyForModel('gemini-3.1-pro-high')).toBe(QUOTA_FAMILY_GEMINI);
        expect(quotaFamilyForModel(null)).toBe(QUOTA_FAMILY_GEMINI);
    });

    test('the same account ranks differently per quota family', () => {
        const perFamily = {
            uuid: 'mixed',
            gemini: { weekly: { remainingFraction: 0.1, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } },
            thirdParty: { weekly: { remainingFraction: 0.95, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } },
            updatedAt: now
        };
        expect(familyWindows(perFamily, QUOTA_FAMILY_THIRD_PARTY).weekly.remainingFraction).toBeCloseTo(0.95);
        expect(familyWindows(perFamily, QUOTA_FAMILY_GEMINI).weekly.remainingFraction).toBeCloseTo(0.1);
        const rival = {
            uuid: 'other',
            gemini: { weekly: { remainingFraction: 0.5, resetAt: perFamily.gemini.weekly.resetAt }, fiveHour: perFamily.gemini.fiveHour },
            thirdParty: { weekly: { remainingFraction: 0.5, resetAt: perFamily.thirdParty.weekly.resetAt }, fiveHour: perFamily.thirdParty.fiveHour },
            updatedAt: now
        };
        // Gemini 视角：mixed 只剩 10%，排在 50% 的 rival 之后。
        const geminiRanking = compareAccounts({ ...perFamily, family: QUOTA_FAMILY_GEMINI }, { ...rival, family: QUOTA_FAMILY_GEMINI }, now);
        expect(geminiRanking).toBeGreaterThan(0);
        // 3p 视角：mixed 有 95%，反超 rival 排到前面。
        const thirdPartyRanking = compareAccounts({ ...perFamily, family: QUOTA_FAMILY_THIRD_PARTY }, { ...rival, family: QUOTA_FAMILY_THIRD_PARTY }, now);
        expect(thirdPartyRanking).toBeLessThan(0);
    });

    test('reads the session id embedded in ZCode metadata', () => {
        expect(extractSessionId({ metadata: { user_id: JSON.stringify({ session_id: ' sess-1 ' }) } })).toBe('sess-1');
        expect(extractSessionId({ metadata: { user_id: 'plain' } })).toBeNull();
    });
});

describe('greedy sticky assignment', () => {
    function scheduler() {
        return new GreedyStickyScheduler({ now: () => now, queueTimeoutMs: 20 });
    }

    test('a bound conversation stays put when another account later ranks higher', async () => {
        const gate = scheduler();
        await gate.acquire({ accounts: [account('old', 0.9, 20), account('new', 0.2, 100)], sessionId: 'conversation' });
        const next = await gate.acquire({ accounts: [account('old', 0.2, 100), account('new', 0.9, 20)], sessionId: 'conversation' });
        expect(next.uuid).toBe('old');
    });

    test('a new conversation uses the highest greed account and then sticks to it', async () => {
        const gate = scheduler();
        const accounts = [account('low', 0.2, 100), account('high', 0.9, 20)];
        const first = await gate.acquire({ accounts, sessionId: 'conversation' });
        const second = await gate.acquire({ accounts: accounts.reverse(), sessionId: 'conversation' });
        expect(first.uuid).toBe('high');
        expect(second.uuid).toBe('high');
    });

    test('the fourth new conversation skips a full account', async () => {
        const gate = scheduler();
        const accounts = [account('best', 1, 10), account('next', 0.5, 10)];
        for (let i = 0; i < 3; i += 1) await gate.acquire({ accounts, sessionId: `new-${i}` });
        const fourth = await gate.acquire({ accounts, sessionId: 'new-4' });
        expect(fourth.uuid).toBe('next');
    });

    test('the same conversation queues on its own full account instead of moving', async () => {
        const gate = scheduler();
        const accounts = [account('only', 1, 10), account('other', 0.1, 10)];
        const held = [];
        for (let i = 0; i < 3; i += 1) held.push(await gate.acquire({ accounts, sessionId: 'conversation' }));
        let released = false;
        const queued = gate.acquire({ uuid: 'only', accounts, sessionId: 'conversation' }).then(result => {
            expect(released).toBe(true);
            return result;
        });
        released = true;
        gate.release(held[0].uuid);
        await expect(queued).resolves.toMatchObject({ uuid: 'only' });
    });

    test('queueing gives up instead of waiting forever', async () => {
        const gate = scheduler();
        const accounts = [account('only', 1, 10)];
        for (let i = 0; i < 3; i += 1) await gate.acquire({ accounts, sessionId: 'conversation' });
        await expect(gate.acquire({ uuid: 'only', accounts, sessionId: 'conversation' })).resolves.toMatchObject({ status: 'busy' });
    });

    test('an account is not usable until both quota windows are known', async () => {
        const gate = scheduler();
        const unknown = { uuid: 'unknown', weekly: null, fiveHour: null, updatedAt: now };
        const known = account('known', 0.2, 100);
        await expect(gate.acquire({ accounts: [unknown, known], sessionId: 'conversation' })).resolves.toMatchObject({ uuid: 'known' });
    });

    test('all exhausted accounts return the earliest reset instead of waiting', async () => {
        const gate = scheduler();
        const accounts = [account('one', 0, 30, 0), account('two', 0, 10, 0)];
        await expect(gate.acquire({ accounts, sessionId: 'conversation' })).resolves.toMatchObject({
            status: 'quota-exhausted',
            resetAt: accounts[1].fiveHour.resetAt
        });
    });

    test('an unhealthy sticky account is replaced', async () => {
        const gate = scheduler();
        const accounts = [account('old', 1, 10), account('new', 0.4, 10)];
        await gate.acquire({ accounts, sessionId: 'conversation' });
        gate.markUnhealthy('old');
        await expect(gate.acquire({ uuid: 'old', accounts, sessionId: 'conversation' })).resolves.toMatchObject({ uuid: 'new', switched: true });
    });

    test('token refresh waits briefly and then leaves the stuck account', async () => {
        const gate = new GreedyStickyScheduler({ now: () => now, queueTimeoutMs: 20, refreshWaitMs: 20 });
        gate.setRefreshing('old', true);
        await expect(gate.acquire({ uuid: 'old', accounts: [account('old', 1, 10), account('fresh', 0.4, 10)], sessionId: 'conversation' })).resolves.toMatchObject({ uuid: 'fresh' });
        expect(gate.sessions.get('conversation')).toBe('fresh');
    });

    test('a conversation switching from Gemini to Claude re-picks by the Claude ranking', async () => {
        const gate = scheduler();
        // 1 号 Gemini 桶最肥，Claude 桶最瘦；2 号相反。会话先按 Gemini 榜单粘上 1 号。
        const accounts = [
            { uuid: 'one', gemini: { weekly: { remainingFraction: 0.9, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, thirdParty: { weekly: { remainingFraction: 0.05, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, updatedAt: now },
            { uuid: 'two', gemini: { weekly: { remainingFraction: 0.2, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, thirdParty: { weekly: { remainingFraction: 0.8, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, updatedAt: now }
        ];
        const onGemini = await gate.acquire({ accounts, sessionId: 'conversation', family: QUOTA_FAMILY_GEMINI });
        expect(onGemini.uuid).toBe('one');
        gate.release(onGemini.uuid);
        // 换成 Claude 后必须按 3p 榜单重新选号，而不是沿用 Gemini 时代的绑定。
        const onClaude = await gate.acquire({ accounts, sessionId: 'conversation', family: QUOTA_FAMILY_THIRD_PARTY });
        expect(onClaude.uuid).toBe('two');
        gate.release(onClaude.uuid);
        // 切回 Gemini 时回到原绑定账号。
        const backToGemini = await gate.acquire({ accounts, sessionId: 'conversation', family: QUOTA_FAMILY_GEMINI });
        expect(backToGemini.uuid).toBe('one');
        gate.release(backToGemini.uuid);
    });

    test('a Claude request skips accounts whose 3p bucket is exhausted even if Gemini quota is full', async () => {
        const gate = scheduler();
        const accounts = [
            { uuid: 'dry3p', gemini: { weekly: { remainingFraction: 1, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, thirdParty: { weekly: { remainingFraction: 0, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, updatedAt: now },
            { uuid: 'spare', gemini: { weekly: { remainingFraction: 0.2, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, thirdParty: { weekly: { remainingFraction: 0.5, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, updatedAt: now }
        ];
        await expect(gate.acquire({ accounts, sessionId: 'conversation', family: QUOTA_FAMILY_THIRD_PARTY })).resolves.toMatchObject({ uuid: 'spare' });
    });

    test('a 429 family cooldown blocks only that family and expires on time', async () => {
        let clock = now;
        const gate = new GreedyStickyScheduler({ now: () => clock, queueTimeoutMs: 20 });
        const accounts = [
            { uuid: 'a', gemini: { weekly: { remainingFraction: 1, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, thirdParty: { weekly: { remainingFraction: 1, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, updatedAt: now },
            { uuid: 'b', gemini: { weekly: { remainingFraction: 0.5, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, thirdParty: { weekly: { remainingFraction: 0.5, resetAt: new Date(now + 600000).toISOString() }, fiveHour: { remainingFraction: 1, resetAt: new Date(now + 3600000).toISOString() } }, updatedAt: now }
        ];
        // a 号 gemini 桶被打入冷却到 now + 5 分钟
        gate.setFamilyCooldown('a', QUOTA_FAMILY_GEMINI, now + 5 * 60000);
        // gemini 请求避开 a，选 b
        await expect(gate.acquire({ accounts, sessionId: 'g-1', family: QUOTA_FAMILY_GEMINI })).resolves.toMatchObject({ uuid: 'b' });
        // 同一时刻 3p 请求仍然可以选 a（另一本账没被冷却）
        const onThreeP = await gate.acquire({ accounts, sessionId: 'p-1', family: QUOTA_FAMILY_THIRD_PARTY });
        expect(onThreeP.uuid).toBe('a');
        gate.release(onThreeP.uuid);
        // 冷却到期后 gemini 请求又能选回 a
        clock = now + 5 * 60000 + 1;
        const backOnA = await gate.acquire({ accounts, sessionId: 'g-2', family: QUOTA_FAMILY_GEMINI });
        expect(backOnA.uuid).toBe('a');
        gate.release(backOnA.uuid);
    });

    test('clearFamilyCooldowns lifts the block immediately', async () => {
        const gate = scheduler();
        const accounts = [account('a', 1, 10)];
        gate.updateAccount('a', { ...accounts[0], family: QUOTA_FAMILY_THIRD_PARTY });
        gate.setFamilyCooldown('a', QUOTA_FAMILY_THIRD_PARTY, now + 600000);
        expect(gate.blocked('a', QUOTA_FAMILY_THIRD_PARTY)).toBe(true);
        gate.clearFamilyCooldown('a', QUOTA_FAMILY_THIRD_PARTY);
        expect(gate.blocked('a', QUOTA_FAMILY_THIRD_PARTY)).toBe(false);
    });

    test('missing session identity follows the current ranking without pretending to stick', async () => {
        const gate = scheduler();
        const first = await gate.acquire({ accounts: [account('a', 0.2, 10), account('b', 0.9, 10)] });
        gate.release(first.uuid);
        const second = await gate.acquire({ accounts: [account('a', 0.9, 10), account('b', 0.2, 10)] });
        expect(first.uuid).toBe('b');
        expect(second.uuid).toBe('a');
    });

    test('background quota refresh stops while idle and staggers accounts', () => {
        let clock = now;
        const gate = new GreedyStickyScheduler({ now: () => clock });
        expect(gate.shouldRefresh('startup', { startup: true })).toBe(true);
        gate.noteUserRequest();
        expect(gate.shouldRefresh('a')).toBe(true);
        gate.markRefreshed('a');
        expect(gate.shouldRefresh('a')).toBe(false);
        clock += 15 * 60000;
        expect(gate.shouldRefresh('b')).toBe(true);
        clock += 16 * 60000;
        expect(gate.shouldRefresh('a')).toBe(false);
    });
});
