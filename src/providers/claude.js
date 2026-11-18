import {getLocalDate, normalizeTimestamp} from '../core/dates.js';
import {calibrateLimits, estimateLimits} from '../core/limitEstimate.js';
import {getRateLimitRetryAt} from '../core/refreshPolicy.js';
import {createQuotaWindow, createUsageRecord, createUsageSection} from '../core/usage.js';
import {parseNonNegativeNumber, sanitizeText} from '../core/values.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MAX_WINDOWS = 32;
const CALIBRATION_STATE = 'claude-calibration';

function planLabel(tier, subscription) {
    const match = sanitizeText(tier, '', 160)?.match(/max_(\d+x)/i);
    if (match)
        return `Max ${match[1]}`;
    const value = sanitizeText(subscription, '', 79);
    return value ? value[0].toUpperCase() + value.slice(1) : null;
}

export function parseClaudeLogin(credentials) {
    const login = credentials?.claudeAiOauth;
    if (!login || typeof login !== 'object')
        return {token: null, expiresAt: null, plan: null};
    return {token: sanitizeText(login.accessToken, null, 8192),
        expiresAt: parseNonNegativeNumber(login.expiresAt),
        plan: planLabel(login.rateLimitTier, login.subscriptionType)};
}

function rawUtilization(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const result = Number(String(value).trim().replace('%', ''));
    return Number.isFinite(result) && result >= 0 ? result : null;
}

function utilization(value, percentScale) {
    const result = rawUtilization(value);
    if (result === null)
        return null;
    return Math.min(100, percentScale || result > 1 ? result : result * 100);
}

function scopedDuration(kind) {
    const value = String(kind || '').toLowerCase();
    if (value.includes('month'))
        return {label: 'Monthly', minutes: 43200};
    if (value.includes('week') || value.includes('day'))
        return {label: 'Weekly', minutes: 10080};
    if (value.includes('hour') || value.includes('session'))
        return {label: 'Session', minutes: 300};
    return {label: '', minutes: null};
}

export function parseClaudeLimits(payload, now = Date.now()) {
    if (!payload || typeof payload !== 'object')
        return {...createUsageSection('unavailable', 'Claude did not report any quota windows.'),
            scope: 'account', source: 'Anthropic OAuth usage', windows: []};
    const session = payload.five_hour;
    const weekly = payload.seven_day_oauth_apps ?? payload.seven_day;
    const scoped = Array.isArray(payload.limits) ? payload.limits : [];
    const raw = [session?.utilization, weekly?.utilization,
        ...scoped.map(item => item?.percent)].map(rawUtilization).filter(value => value !== null);
    const percentScale = raw.some(value => value >= 1);
    const windows = [];
    let truncated = false;
    const add = (id, label, bucket, durationMinutes) => {
        if (!bucket || typeof bucket !== 'object')
            return;
        const item = createQuotaWindow({id, label, usedPercent: utilization(bucket.utilization, percentScale),
            durationMinutes, resetsAt: normalizeTimestamp(bucket.resets_at)});
        if (item)
            windows.push(item);
    };
    add('five-hour', 'Session · 5 hours', session, 300);
    add('weekly', 'Weekly', weekly, 10080);
    const seen = new Set();
    for (const item of scoped) {
        if (windows.length >= MAX_WINDOWS) {
            truncated = true;
            break;
        }
        const model = item?.scope?.model;
        const name = sanitizeText(model?.display_name ?? model?.id, '', 100);
        const kind = sanitizeText(item?.kind, '', 40);
        const key = `${name}:${kind}`;
        if (!name || seen.has(key))
            continue;
        const duration = scopedDuration(kind);
        const value = createQuotaWindow({id: `scoped:${key}`, label: `${name}${duration.label ? ` · ${duration.label}` : ''}`,
            usedPercent: utilization(item.percent, percentScale), durationMinutes: duration.minutes,
            resetsAt: normalizeTimestamp(item.resets_at)});
        if (value) {
            seen.add(key);
            windows.push(value);
        }
    }
    return windows.length
        ? {...createUsageSection(truncated ? 'partial' : 'ready',
            truncated ? 'Some Claude quota windows were omitted to keep the response bounded.' : ''),
        updatedAt: now, scope: 'account', source: 'Anthropic OAuth usage', windows}
        : {...createUsageSection('unavailable', 'Claude did not report any supported quota windows.'),
            scope: 'account', source: 'Anthropic OAuth usage', windows: []};
}

export function parseClaudeEvent(entry, state) {
    const message = entry?.message && typeof entry.message === 'object' ? entry.message : {};
    if (entry?.type !== 'assistant' && message.role !== 'assistant')
        return null;
    const usage = message.usage ?? entry.usage;
    if (!usage || typeof usage !== 'object')
        return null;
    if (typeof entry.sessionId === 'string' && entry.sessionId)
        state.session = entry.sessionId;
    const timestamp = entry.timestamp ?? message.timestamp;
    const date = getLocalDate(timestamp);
    if (!date)
        return null;
    const input = parseNonNegativeNumber(usage.input_tokens ?? usage.inputTokens) ?? 0;
    const output = parseNonNegativeNumber(usage.output_tokens ?? usage.outputTokens) ?? 0;
    const cacheRead = parseNonNegativeNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) ?? 0;
    const cacheWrite = parseNonNegativeNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) ?? 0;
    if (input + output + cacheRead + cacheWrite === 0)
        return null;
    const model = sanitizeText(message.model ?? entry.model ?? state.model, 'Unknown model', 160);
    state.model = model;
    const identity = message.id ?? entry.messageId ?? entry.uuid ?? entry.requestId ?? `${timestamp}:${JSON.stringify(usage)}`;
    return {id: `${state.session}:${identity}`, session: state.session, date, model,
        at: normalizeTimestamp(timestamp), input, output, cacheRead, cacheWrite};
}

function loadCalibration(context, accountKey) {
    const saved = context.loadState?.(CALIBRATION_STATE);
    return saved?.accountKey === accountKey && saved.windows && typeof saved.windows === 'object'
        ? saved.windows : null;
}

export async function collectClaude(context) {
    const now = context.now?.() ?? Date.now();
    const result = createUsageRecord('claude');
    result.capabilities = {limits: true, history: true, models: true};
    const events = [];
    result.history = context.scan('claude', ['projects'], parseClaudeEvent,
        {onEvents: items => events.push(...items)});
    const login = parseClaudeLogin(context.credentials('claude'));
    result.plan = login.plan;
    if (!login.token) {
        const installed = context.hasCommand?.('claude') !== false;
        result.limits = {...result.limits, ...createUsageSection(installed ? 'missing-auth' : 'unsupported',
            installed ? 'Run claude auth login to read account limits.' : 'Install Claude Code, then sign in to read account limits.')};
        return result;
    }
    result.accountKey = context.fingerprint(login.token);
    const calibration = loadCalibration(context, result.accountKey);
    const withEstimate = section => {
        const estimate = estimateLimits(calibration, events, now);
        return estimate ? {...section, estimate} : section;
    };
    if (context.skipLimits) {
        // The service keeps the previous limits; only a fresh projection is reported.
        result.limits = withEstimate({...result.limits, ...createUsageSection('loading', '')});
        return result;
    }
    if (login.expiresAt && login.expiresAt <= now) {
        result.limits = withEstimate({...result.limits,
            ...createUsageSection('missing-auth', 'Claude Code sign-in expired. Start Claude Code or run claude auth login.')});
        return result;
    }
    try {
        const response = await context.http(USAGE_URL, {headers: {
            Authorization: `Bearer ${login.token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            Accept: 'application/json',
        }});
        if (response.status === 200) {
            result.limits = parseClaudeLimits(response.data, now);
            if (['ready', 'partial'].includes(result.limits.status)) {
                try {
                    context.saveState?.(CALIBRATION_STATE, {accountKey: result.accountKey,
                        windows: calibrateLimits(result.limits.windows, events, now, calibration)});
                } catch {
                    /* Estimates are optional; a live reading must not fail on them. */
                }
            }
        } else if (response.status === 429) {
            result.limits = withEstimate({...result.limits,
                ...createUsageSection('unavailable', 'Anthropic is rate limiting usage checks. Showing the last reading.'),
                retryAt: getRateLimitRetryAt(response.retryAfterMs, now)});
        } else {
            const auth = [401, 403].includes(response.status);
            result.limits = withEstimate({...result.limits, ...createUsageSection(auth ? 'missing-auth' : 'unavailable',
                auth ? 'Reconnect Claude Code to read account limits.' :
                    `Claude usage endpoint unavailable (HTTP ${response.status}).`)});
        }
    } catch {
        result.limits = withEstimate({...result.limits,
            ...createUsageSection('unavailable', 'Could not reach Claude usage. Showing the last reading.')});
    }
    return result;
}
