import assert from 'node:assert/strict';
import test from 'node:test';
import {collectClaude, parseClaudeEvent, parseClaudeLimits, parseClaudeLogin} from '../../src/providers/claude.js';

test('reads percent-scaled standard and model-scoped Claude windows', () => {
    const result = parseClaudeLimits({
        five_hour: {utilization: 1, resets_at: '2026-09-06T15:00:00Z'},
        seven_day_oauth_apps: {utilization: 24.5, resets_at: '2026-09-13T10:00:00Z'},
        limits: [
            {kind: 'seven_day_scoped', percent: 70, resets_at: '2026-09-13T10:00:00Z',
                scope: {model: {id: 'opus', display_name: 'Opus'}}},
            {kind: 'seven_day_scoped', percent: 70, scope: {model: {id: 'opus', display_name: 'Opus'}}},
        ],
    }, 100);
    assert.equal(result.status, 'ready');
    assert.equal(result.windows.length, 3);
    assert.equal(result.windows[0].usedPercent, 1);
    assert.equal(result.windows[0].durationMinutes, 300);
    assert.equal(result.windows[2].label, 'Opus · Weekly');
});

test('supports older fractional utilization without turning one percent into full usage', () => {
    const result = parseClaudeLimits({five_hour: {utilization: 0.25}, seven_day: {utilization: 0.5}});
    assert.deepEqual(result.windows.map(window => window.usedPercent), [25, 50]);
    assert.equal(parseClaudeLimits({}).status, 'unavailable');
});

test('Claude login exposes only the needed token, expiry and display plan', () => {
    assert.deepEqual(parseClaudeLogin({}), {token: null, expiresAt: null, plan: null});
    assert.deepEqual(parseClaudeLogin({claudeAiOauth: {accessToken: 'secret', expiresAt: 20,
        rateLimitTier: 'default_claude_max_20x', subscriptionType: 'max'}}),
    {token: 'secret', expiresAt: 20, plan: 'Max 20x'});
});

test('parses Claude cache categories independently and provides stable message identity', () => {
    const state = {session: 'file'};
    const event = parseClaudeEvent({type: 'assistant', sessionId: 'session', timestamp: '2026-09-06T10:00:00Z',
        message: {id: 'message', role: 'assistant', model: 'claude-opus', usage: {input_tokens: 2,
            output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 5}}}, state);
    assert.deepEqual({input: event.input, output: event.output, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite},
        {input: 2, output: 3, cacheRead: 40, cacheWrite: 5});
    assert.equal(event.id, 'session:message');
    assert.equal(event.model, 'claude-opus');
});

test('missing or expired Claude auth preserves local history and skips the endpoint', async () => {
    const history = {status: 'ready', days: [], models: []};
    let requests = 0;
    const io = credentials => ({scan: () => history, credentials: () => credentials,
        fingerprint: () => 'hash', http: async () => { requests++; return {status: 200, data: {}}; }});
    const missing = await collectClaude(io(null));
    assert.equal(missing.limits.status, 'missing-auth');
    assert.equal(missing.history, history);
    const expired = await collectClaude(io({claudeAiOauth: {accessToken: 'token', expiresAt: 1}}));
    assert.equal(expired.limits.status, 'missing-auth');
    assert.equal(requests, 0);
    const absent = await collectClaude({...io(null), hasCommand: () => false});
    assert.equal(absent.limits.status, 'unsupported');
});

test('Claude endpoint authentication failure remains independent from history', async () => {
    const result = await collectClaude({scan: () => ({status: 'ready', days: [], models: []}),
        credentials: () => ({claudeAiOauth: {accessToken: 'token'}}), fingerprint: () => 'hash',
        http: async () => ({status: 401, data: {}})});
    assert.equal(result.capabilities.models, true);
    assert.equal(result.limits.status, 'missing-auth');
    assert.equal(result.history.status, 'ready');
});

test('rate limiting reports a bounded retry time and an estimate from the last calibration', async () => {
    const now = Date.parse('2026-11-18T10:00:00Z');
    let saved = null;
    let requests = 0;
    const context = (status, extra = {}) => ({now: () => now, credentials: () => ({claudeAiOauth: {accessToken: 'token'}}),
        fingerprint: () => 'hash', loadState: () => saved, saveState: (_name, value) => { saved = value; },
        scan: (_id, _roots, _parse, options) => {
            options.onEvents([{at: now - 60000, model: 'claude-sonnet', input: 0, output: 1000, cacheRead: 0, cacheWrite: 0}]);
            return {status: 'ready', days: [], models: []};
        },
        http: async () => { requests++; return {status, data: {five_hour: {utilization: 30,
            resets_at: new Date(now + 3600000).toISOString()}}, retryAfterMs: 120000}; },
        ...extra});
    const live = await collectClaude(context(200));
    assert.equal(live.limits.status, 'ready');
    assert.equal(saved.accountKey, 'hash');
    assert.equal(saved.windows['five-hour'].unitsPerPercent, 500);
    const limited = await collectClaude(context(429));
    assert.equal(limited.limits.status, 'unavailable');
    assert.equal(limited.limits.retryAt, now + 120000);
    assert.equal(limited.limits.estimate.windows[0].usedPercent, 30);
    const skipped = await collectClaude(context(200, {skipLimits: true}));
    assert.equal(requests, 2);
    assert.equal(skipped.limits.status, 'loading');
    assert.equal(skipped.limits.estimate.windows[0].id, 'five-hour');
    saved = {...saved, accountKey: 'other'};
    assert.equal((await collectClaude(context(429))).limits.estimate, undefined);
});

test('Claude history events keep their timestamp for quota estimates', () => {
    const event = parseClaudeEvent({type: 'assistant', timestamp: '2026-09-06T10:00:00Z',
        message: {id: 'm', model: 'claude-opus', usage: {output_tokens: 1}}}, {session: 's'});
    assert.equal(event.at, Date.parse('2026-09-06T10:00:00Z'));
});
