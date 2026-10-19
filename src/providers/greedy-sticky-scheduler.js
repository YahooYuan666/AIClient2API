const WEEK_FLOOR_SECONDS = 600;
const STALE_AFTER_MS = 20 * 60 * 1000;
const MAX_IN_FLIGHT = 3;
const SAME_SESSION_QUEUE_MS = 120000;
const TOKEN_REFRESH_WAIT_MS = 30000;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const IDLE_STOP_MS = 15 * 60 * 1000;

// Antigravity 的额度分两本账：gemini-* 模型扣 gemini-weekly / gemini-5h 桶，
// claude-* / gpt-oss-* 模型扣 3p-weekly / 3p-5h 桶。同一会话换模型族时
// （例如从 Gemini 对话切到 Claude），必须按目标模型族的桶重新选号。
export const QUOTA_FAMILY_GEMINI = 'gemini';
export const QUOTA_FAMILY_THIRD_PARTY = 'third-party';

export function quotaFamilyForModel(modelName) {
    const name = String(modelName || '').toLowerCase().replace(/^models\//, '');
    if (name.startsWith('gemini-claude-')) return QUOTA_FAMILY_THIRD_PARTY;
    const base = name.split('(')[0];
    if (base.startsWith('claude-') || base.startsWith('gpt-oss-')) return QUOTA_FAMILY_THIRD_PARTY;
    return QUOTA_FAMILY_GEMINI;
}

export function weeklyGreed(remainingFraction, resetAt, now = Date.now()) {
    if (!isFraction(remainingFraction)) return null;
    const resetMs = Date.parse(resetAt);
    if (!Number.isFinite(resetMs)) return null;
    const seconds = Math.max((resetMs - now) / 1000, WEEK_FLOOR_SECONDS);
    return remainingFraction / seconds;
}

export function extractQuotaWindows(usage) {
    const windows = {};
    const groups = Array.isArray(usage?.groups) ? usage.groups : [];
    for (const group of groups) {
        const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
        for (const bucket of buckets) {
            const bucketId = typeof bucket?.bucketId === 'string' ? bucket.bucketId : '';
            const remaining = Number(bucket.remainingFraction);
            const resetAt = typeof bucket.resetTime === 'string' ? bucket.resetTime : '';
            if (!Number.isFinite(remaining) || !Number.isFinite(Date.parse(resetAt))) continue;
            const window = { remainingFraction: Math.min(1, Math.max(0, remaining)), resetAt };
            const windowsFor = bucketId.startsWith('gemini-') ? 'gemini'
                : (bucketId.startsWith('3p-') ? 'thirdParty' : null);
            if (!windowsFor) continue;
            windows[windowsFor] = windows[windowsFor] || {};
            if (bucketId.includes('5h')) windows[windowsFor].fiveHour = window;
            else if (bucketId.includes('weekly')) windows[windowsFor].weekly = window;
        }
    }
    // 兼容旧调用方：缺省把 gemini 桶铺平到顶层，同时保留按族的完整结构。
    const gemini = windows.gemini || {};
    return {
        weekly: gemini.weekly || null,
        fiveHour: gemini.fiveHour || null,
        gemini: { weekly: gemini.weekly || null, fiveHour: gemini.fiveHour || null },
        thirdParty: {
            weekly: windows.thirdParty?.weekly || null,
            fiveHour: windows.thirdParty?.fiveHour || null
        }
    };
}

export function extractSessionId(requestBody) {
    const raw = requestBody?.metadata?.user_id;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw);
        const sessionId = typeof parsed?.session_id === 'string' ? parsed.session_id.trim() : '';
        return sessionId || null;
    } catch {
        return null;
    }
}

export function accountQuotaState(account, now = Date.now()) {
    const family = account?.family || QUOTA_FAMILY_GEMINI;
    const windows = familyWindows(account, family);
    const weekly = quotaWindowState(windows.weekly, now);
    const fiveHour = quotaWindowState(windows.fiveHour, now);
    if (weekly === 'unknown' || fiveHour === 'unknown') return 'unknown';
    if (weekly === 'exhausted' || fiveHour === 'exhausted') return 'exhausted';
    return 'known';
}

export function quotaWindowState(window, now = Date.now()) {
    if (!window || !isFraction(window.remainingFraction) || !Number.isFinite(Date.parse(window.resetAt || ''))) {
        return 'unknown';
    }
    if (window.remainingFraction > 0) return 'available';
    return Date.parse(window.resetAt) <= now ? 'reset-due' : 'exhausted';
}

export function compareAccounts(left, right, now = Date.now()) {
    const leftRank = freshnessRank(left, now);
    const rightRank = freshnessRank(right, now);
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftWindows = familyWindows(left, left.family);
    const rightWindows = familyWindows(right, right.family);
    const leftScore = weeklyGreed(leftWindows.weekly?.remainingFraction, leftWindows.weekly?.resetAt, now) || 0;
    const rightScore = weeklyGreed(rightWindows.weekly?.remainingFraction, rightWindows.weekly?.resetAt, now) || 0;
    if (leftScore !== rightScore) return rightScore - leftScore;
    const leftHour = isFraction(leftWindows.fiveHour?.remainingFraction) ? leftWindows.fiveHour.remainingFraction : -1;
    const rightHour = isFraction(rightWindows.fiveHour?.remainingFraction) ? rightWindows.fiveHour.remainingFraction : -1;
    if (leftHour !== rightHour) return rightHour - leftHour;
    return String(left.uuid).localeCompare(String(right.uuid));
}

// 读取某个账号在某模型族（gemini / third-party）下的额度窗口。
// 兼容三种数据形态：
// 1. 号池配置的完整结构 { gemini: {...}, thirdParty: {...} }
// 2. 调度视图的扁平结构 { weekly, fiveHour } + family 标记（窗口已按请求族选好）
// 3. 旧一代铺平的 gemini 桶 { weekly, fiveHour }（无 family 标记，按 gemini 处理）
export function familyWindows(account, family = QUOTA_FAMILY_GEMINI) {
    if (!account) return { weekly: null, fiveHour: null };
    const byFamily = account[family === QUOTA_FAMILY_THIRD_PARTY ? 'thirdParty' : 'gemini'];
    if (byFamily && (byFamily.weekly || byFamily.fiveHour)) return byFamily;
    const flat = { weekly: account.weekly || null, fiveHour: account.fiveHour || null };
    if ((flat.weekly || flat.fiveHour) && (account.family ? account.family === family : family === QUOTA_FAMILY_GEMINI)) {
        return flat;
    }
    return { weekly: null, fiveHour: null };
}

export class GreedyStickyScheduler {
    constructor({
        limit = MAX_IN_FLIGHT,
        now = () => Date.now(),
        queueTimeoutMs = SAME_SESSION_QUEUE_MS,
        refreshWaitMs = TOKEN_REFRESH_WAIT_MS
    } = {}) {
        this.limit = limit;
        this.now = now;
        this.queueTimeoutMs = queueTimeoutMs;
        this.refreshWaitMs = refreshWaitMs;
        this.sessions = new Map();
        this.sessionFamilies = new Map();
        this.inFlight = new Map();
        this.queues = new Map();
        this.signals = new Map();
        this.accounts = new Map();
        this.refreshing = new Set();
        this.unhealthy = new Set();
        // 429 冷却按账本（模型族）记录：uuid -> { [family]: cooldownUntilMs }。
        // 一个族的额度耗尽只冷却该族，另一族（如 3p 满额）照常接单。
        this.familyCooldowns = new Map();
        this.lastUserRequestAt = 0;
        this.lastRefreshAt = new Map();
    }

    noteUserRequest() {
        this.lastUserRequestAt = this.now();
    }

    shouldRefresh(uuid, { startup = false } = {}) {
        if (!startup && this.now() - this.lastUserRequestAt > IDLE_STOP_MS) return false;
        const last = this.lastRefreshAt.get(uuid) || 0;
        return this.now() - last >= REFRESH_INTERVAL_MS;
    }

    markRefreshed(uuid) {
        this.lastRefreshAt.set(uuid, this.now());
    }

    updateAccount(uuid, quota) {
        this.accounts.set(uuid, { ...quota, uuid, updatedAt: this.now() });
    }

    // 会话绑定记录模型族：同一会话换族（Gemini <-> Claude）时，旧绑定不适用，
    // 按新族的榜单重新选号，但绑定槽位本身保留（回到原族时仍回到原账号）。
    sessionFamily(sessionId) {
        return sessionId ? this.sessionFamilies.get(sessionId) || null : null;
    }

    setSessionFamily(sessionId, family) {
        if (!sessionId || !family) return;
        this.sessionFamilies.set(sessionId, family);
    }

    markUnhealthy(uuid) {
        this.unhealthy.add(uuid);
        this.forgetSessionsFor(uuid);
    }

    markHealthy(uuid) {
        this.unhealthy.delete(uuid);
    }

    // 按账本级冷却：只屏蔽某号在某模型族上的请求，到点自动解除。
    setFamilyCooldown(uuid, family, untilMs) {
        if (!uuid || !family) return;
        const perFamily = this.familyCooldowns.get(uuid) || {};
        if (untilMs && untilMs > this.now()) {
            perFamily[family] = untilMs;
        } else {
            delete perFamily[family];
        }
        this.familyCooldowns.set(uuid, perFamily);
    }

    familyCooldownActive(uuid, family) {
        const perFamily = this.familyCooldowns.get(uuid);
        if (!perFamily) return false;
        const until = perFamily[family];
        if (!until) return false;
        if (until <= this.now()) {
            delete perFamily[family];
            return false;
        }
        return true;
    }

    clearFamilyCooldown(uuid, family) {
        const perFamily = this.familyCooldowns.get(uuid);
        if (!perFamily) return;
        if (family) delete perFamily[family];
        else this.familyCooldowns.delete(uuid);
    }

    setRefreshing(uuid, refreshing) {
        if (refreshing) this.refreshing.add(uuid);
        else this.refreshing.delete(uuid);
    }

    /**
     * @param {boolean} reserve - true：真正占用并发槽位；false：只探路，不占槽、不排队、
     *   不改会话绑定。上层用 false 回答“还有没有别的号可用”，否则每次探测都会永久
     *   泄漏一个 inFlight 计数，几个 429 之后账号就被判定为满员、再也选不中。
     */
    async acquire({ uuid, sessionId, accounts, family, reserve = true }) {
        const targetFamily = family || QUOTA_FAMILY_GEMINI;
        // 排序与判饱和都用当前请求族的视图：给本地副本打上族标记，
        // 不改调用方传入的对象（同一会话可能先后按不同族调用）。
        const familyAccounts = (accounts || []).map(account => ({ ...account, family: targetFamily }));
        for (const account of familyAccounts) this.updateAccount(account.uuid, account);
        const started = this.now();
        // 粘住的前提：本次请求与上次绑定同一模型族。族切换（如会话从 Gemini
        // 换到 Claude）时旧绑定不适用，按目标族的榜单重新选号。
        let sticky = null;
        const requested = uuid || (sessionId ? this.sessions.get(sessionId) : null);
        // 调用方用 excludeUuids 过滤过候选集：不在候选集里的账号本轮不可选，
        // 即使它仍是粘性目标。刚 429 的账号就是这种情况——内部 accounts 表里
        // 还留着它的额度记录，blocked() 拦不住它，于是它会被再次选中，随后
        // manager 在候选集里 find 不到它而返回 null，上层报“没有健康账号”。
        const requestedSelectable = Boolean(requested && familyAccounts.some(account => account.uuid === requested));
        const boundFamily = sessionId ? this.sessionFamilies.get(sessionId) : null;
        const familySwitched = Boolean(sessionId && boundFamily && boundFamily !== targetFamily);
        if (requested && requestedSelectable && !familySwitched) {
            sticky = requested;
        } else if ((familySwitched || !requestedSelectable) && sessionId && this.sessions.get(sessionId) === requested) {
            this.sessions.delete(sessionId);
        }
        if (!reserve) {
            // 只探路：一次性判断有没有可选的号，不等待、不占用。
            if (sticky && !this.blocked(sticky, targetFamily) && !this.refreshing.has(sticky)) {
                return { status: 'acquired', uuid: sticky };
            }
            const probe = this.rankAvailable(familyAccounts)[0];
            return probe
                ? { status: 'acquired', uuid: probe.uuid }
                : { status: 'quota-exhausted', resetAt: this.earliestReset(familyAccounts, targetFamily) };
        }
        while (this.now() - started <= this.queueTimeoutMs) {
            if (sticky && this.blocked(sticky, targetFamily)) {
                if (sessionId && this.sessions.get(sessionId) === sticky) this.sessions.delete(sessionId);
                sticky = null;
            }
            if (sticky && this.refreshing.has(sticky)) {
                const waitingFor = sticky;
                const refreshed = await this.waitForChange(waitingFor, this.refreshWaitMs);
                if (!refreshed || this.refreshing.has(waitingFor)) {
                    if (sessionId && this.sessions.get(sessionId) === waitingFor) this.sessions.delete(sessionId);
                    sticky = null;
                }
                continue;
            }
            const active = this.inFlight.get(sticky) || 0;
            if (sticky && active < this.limit) {
                this.inFlight.set(sticky, active + 1);
                return { status: 'acquired', uuid: sticky };
            }
            if (sticky && sessionId && this.sessions.get(sessionId) === sticky) {
                const granted = await this.enqueue(sticky);
                if (granted) return { status: 'acquired', uuid: sticky };
                if (this.blocked(sticky, targetFamily)) {
                    this.sessions.delete(sessionId);
                    sticky = null;
                    continue;
                }
                return { status: 'busy' };
            }
            const candidate = this.rankAvailable(familyAccounts)[0];
            if (!candidate) {
                if (this.allCapacityFull(familyAccounts)) {
                    await this.waitForAny(familyAccounts);
                    continue;
                }
                return { status: 'quota-exhausted', resetAt: this.earliestReset(familyAccounts, targetFamily) };
            }
            this.inFlight.set(candidate.uuid, (this.inFlight.get(candidate.uuid) || 0) + 1);
            if (sessionId) {
                this.sessions.set(sessionId, candidate.uuid);
                this.setSessionFamily(sessionId, targetFamily);
            }
            return { status: 'acquired', uuid: candidate.uuid, switched: Boolean(requested && requested !== candidate.uuid) };
        }
        return { status: 'busy' };
    }

    release(uuid) {
        const next = Math.max(0, (this.inFlight.get(uuid) || 0) - 1);
        this.inFlight.set(uuid, next);
        const queue = this.queues.get(uuid) || [];
        const waiter = queue.shift();
        if (waiter && next < this.limit && !this.unhealthy.has(uuid) && !this.refreshing.has(uuid)) {
            this.inFlight.set(uuid, next + 1);
            waiter.grant();
            return;
        }
        this.notify(uuid);
    }

    enqueue(uuid) {
        return new Promise(resolve => {
            let settled = false;
            const finish = granted => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(granted);
            };
            const waiter = { grant: () => finish(true) };
            const timer = setTimeout(() => {
                const queue = this.queues.get(uuid) || [];
                const index = queue.indexOf(waiter);
                if (index >= 0) queue.splice(index, 1);
                finish(false);
            }, this.queueTimeoutMs);
            const queue = this.queues.get(uuid) || [];
            queue.push(waiter);
            this.queues.set(uuid, queue);
        });
    }

    rankAvailable(accounts) {
        const family = accounts[0]?.family || QUOTA_FAMILY_GEMINI;
        return (accounts || [])
            .filter(account => !this.blocked(account.uuid, account.family || family) && (this.inFlight.get(account.uuid) || 0) < this.limit)
            .sort((left, right) => compareAccounts(left, right, this.now()));
    }

    blocked(uuid, family = QUOTA_FAMILY_GEMINI) {
        if (this.unhealthy.has(uuid) || this.refreshing.has(uuid)) return true;
        if (this.familyCooldownActive(uuid, family)) return true;
        const account = this.accounts.get(uuid);
        if (!account) return true;
        return accountQuotaState(account, this.now()) !== 'known';
    }

    allCapacityFull(accounts) {
        const family = accounts[0]?.family || QUOTA_FAMILY_GEMINI;
        const eligible = (accounts || []).filter(account => !this.blocked(account.uuid, account.family || family));
        return eligible.length > 0 && eligible.every(account => (this.inFlight.get(account.uuid) || 0) >= this.limit);
    }

    earliestReset(accounts, family = QUOTA_FAMILY_GEMINI) {
        const times = (accounts || [])
            .map(account => {
                const windows = familyWindows(account, account.family || family);
                return Date.parse(windows.fiveHour?.resetAt || windows.weekly?.resetAt || '');
            })
            .filter(time => Number.isFinite(time) && time > this.now());
        return times.length ? new Date(Math.min(...times)).toISOString() : null;
    }

    forgetSessionsFor(uuid) {
        for (const [sessionId, bound] of this.sessions) {
            if (bound === uuid) {
                this.sessions.delete(sessionId);
                this.sessionFamilies.delete(sessionId);
            }
        }
    }

    waitForAny(accounts) {
        return Promise.race((accounts || []).map(account => this.waitForChange(account.uuid)));
    }

    waitForChange(uuid, timeoutMs = this.queueTimeoutMs) {
        return new Promise(resolve => {
            const signals = this.signals.get(uuid) || [];
            const finish = ok => {
                clearTimeout(timer);
                resolve(ok);
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            signals.push(() => finish(true));
            this.signals.set(uuid, signals);
        });
    }

    notify(uuid) {
        const signals = this.signals.get(uuid) || [];
        this.signals.set(uuid, []);
        for (const signal of signals) signal();
    }
}

function freshnessRank(account, now) {
    const fresh = Number.isFinite(account.updatedAt) && now - account.updatedAt <= STALE_AFTER_MS;
    const windows = familyWindows(account, account.family);
    const known = quotaWindowState(windows.weekly, now) !== 'unknown' && quotaWindowState(windows.fiveHour, now) !== 'unknown';
    return fresh && known ? 0 : 1;
}

function isFraction(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export const GREEDY_STICKY_LIMITS = {
    WEEK_FLOOR_SECONDS,
    STALE_AFTER_MS,
    MAX_IN_FLIGHT,
    SAME_SESSION_QUEUE_MS,
    TOKEN_REFRESH_WAIT_MS,
    REFRESH_INTERVAL_MS,
    IDLE_STOP_MS
};
