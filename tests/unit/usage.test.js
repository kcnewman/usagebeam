import assert from 'node:assert/strict';
import test from 'node:test';
import {aggregateEvents} from '../../src/core/activity.js';
import {getRecentDates, normalizeTimestamp} from '../../src/core/dates.js';
import {
    formatModelName,
    formatResetCountdown,
    formatTokenCount,
} from '../../src/core/format.js';
import {QuotaThresholdTracker, formatNotificationBody} from '../../src/core/notifications.js';
import {getEnabledProviders, normalizeProviderOrder} from '../../src/core/providerRegistry.js';
import {collectionNeedsBackoff, createQuotaWindow, createUsageRecord, mergeUsageRecords} from '../../src/core/usage.js';
import {validateUsageRecord} from '../../src/core/usageValidation.js';
import {parseNonNegativeNumber} from '../../src/core/values.js';

test('unknown metrics are not coerced to zero', () => {
    for (const value of [null, undefined, '', '  ', false, -1, Infinity, 'bad', [1], {value: 1}])
        assert.equal(parseNonNegativeNumber(value), null);
    assert.equal(parseNonNegativeNumber(0), 0);
    assert.equal(createQuotaWindow({id: 'plan', label: 'Plan', used: 0, limit: 0}), null);
});

test('provider selection is ordered, deduplicated and restricted to supported adapters', () => {
    assert.deepEqual(normalizeProviderOrder(['claude', 'unknown', 'claude']), ['claude', 'codex']);
    assert.deepEqual(normalizeProviderOrder(null), ['codex', 'claude']);
    assert.deepEqual(getEnabledProviders(['unknown', 'codex'], ['unknown', 'claude', 'codex']), ['codex']);
    assert.deepEqual(getEnabledProviders(['unknown'], []), []);
    assert.deepEqual(getEnabledProviders(['codex', 'claude', 'unknown'], ['claude', 'codex']),
        ['claude', 'codex']);
    assert.deepEqual(getEnabledProviders(['claude'], []), ['claude']);
    assert.deepEqual(getEnabledProviders(null, ['claude', 'codex']), []);
});

test('unknown, exhausted and unlimited windows remain distinct', () => {
    const exhausted = createQuotaWindow({id: 'x', label: 'X', used: 12, limit: 10});
    assert.equal(exhausted.usedPercent, 120);
    assert.equal(exhausted.state, 'exhausted');
    const unlimited = createQuotaWindow({id: 'x', label: 'X', unlimited: true});
    assert.equal(unlimited.usedPercent, null);
    assert.equal(unlimited.unlimited, true);
    assert.equal(unlimited.state, 'unlimited');
});

test('contract rejects invalid provider IDs and quota values', () => {
    assert.throws(() => createUsageRecord('toString'), /Unsupported provider/);
    assert.throws(() => createUsageRecord('cursor'), /Unsupported provider/);
    assert.throws(() => validateUsageRecord(createUsageRecord('codex'), 'claude'));
    const value = createUsageRecord('codex');
    value.limits.windows.push({id: 'x', label: 'X', state: 'active', usedPercent: null});
    assert.throws(() => validateUsageRecord(value, 'codex'));
});

test('contract accepts complete records and rejects unsafe cached shapes', () => {
    const value = createUsageRecord('codex');
    value.accountKey = 'a'.repeat(64);
    value.capabilities = {limits: true, history: true, models: true};
    value.limits = {status: 'ready', message: '', updatedAt: 100, scope: 'account', source: 'synthetic limits',
        windows: [createQuotaWindow({id: 'weekly', label: 'Weekly', usedPercent: 20})]};
    value.history = {status: 'ready', message: '', updatedAt: 100, scope: 'local',
        source: 'synthetic history', period: {start: '2026-09-05', end: '2026-09-06'},
        days: [{date: '2026-09-05', total: 0, sessions: 0, events: 0},
            {date: '2026-09-06', total: 10, sessions: 1, events: 1}],
        models: [{model: 'test-model', total: 10, input: 6, output: 4, cacheRead: 0, cacheWrite: 0}]};
    assert.equal(validateUsageRecord(value, 'codex'), value);
    value.history.days[0].models = [];
    value.history.days[1].models = structuredClone(value.history.models);
    assert.equal(validateUsageRecord(value, 'codex'), value);
    const invalidDailyModels = structuredClone(value);
    invalidDailyModels.history.days[1].models[0].input++;
    assert.throws(() => validateUsageRecord(invalidDailyModels, 'codex'), /model totals/);
    const mismatchedDay = structuredClone(value);
    mismatchedDay.history.days[1].total++;
    assert.throws(() => validateUsageRecord(mismatchedDay, 'codex'), /daily model totals/);

    const invalidDate = structuredClone(value);
    invalidDate.history.days[1].date = '2026-99-99';
    assert.throws(() => validateUsageRecord(invalidDate, 'codex'), /daily date/);
    const invalidTotal = structuredClone(value);
    invalidTotal.history.models[0].total = 11;
    assert.throws(() => validateUsageRecord(invalidTotal, 'codex'), /model totals/);
    const rawAccount = structuredClone(value);
    rawAccount.accountKey = 'user@example.com';
    assert.throws(() => validateUsageRecord(rawAccount, 'codex'), /account key/);
    const missingSource = structuredClone(value);
    missingSource.limits.source = null;
    assert.throws(() => validateUsageRecord(missingSource, 'codex'), /limits source/);
    const missingFreshness = structuredClone(value);
    missingFreshness.history.updatedAt = 0;
    assert.throws(() => validateUsageRecord(missingFreshness, 'codex'), /history freshness/);
    const unknownField = structuredClone(value);
    unknownField.rawResponse = 'must not persist';
    assert.throws(() => validateUsageRecord(unknownField, 'codex'), /record shape/);
    const duplicateQuota = structuredClone(value);
    duplicateQuota.limits.windows.push(structuredClone(duplicateQuota.limits.windows[0]));
    assert.throws(() => validateUsageRecord(duplicateQuota, 'codex'), /duplicate quota/);
});

test('failure preserves last successful values as stale, account change discards them', () => {
    const old = createUsageRecord('codex');
    old.accountKey = 'one';
    old.limits = {status: 'ready', updatedAt: 100, windows: [{usedPercent: 50}]};
    const next = createUsageRecord('codex');
    next.limits.status = 'unavailable';
    next.limits.message = 'Disconnected';
    const merged = mergeUsageRecords(old, next);
    assert.equal(merged.limits.status, 'stale');
    assert.equal(merged.limits.updatedAt, 100);
    assert.equal(merged.limits.windows[0].usedPercent, 50);
    next.accountKey = 'two';
    assert.equal(mergeUsageRecords(old, next).limits.windows.length, 0);
    next.accountKey = null;
    next.limits.status = 'missing-auth';
    assert.equal(mergeUsageRecords(old, next).limits.windows.length, 0);
    assert.equal(mergeUsageRecords(old, next).accountKey, null);
});

test('stale quota windows are discarded after their reset', () => {
    const old = createUsageRecord('claude');
    old.limits = {status: 'ready', updatedAt: 100, windows: [
        {id: 'expired', resetsAt: 1},
        {id: 'open', resetsAt: 2000},
    ]};
    const next = createUsageRecord('claude');
    next.limits.status = 'unavailable';
    const result = mergeUsageRecords(old, next, 1000);
    assert.equal(result.limits.status, 'stale');
    assert.deepEqual(result.limits.windows.map(window => window.id), ['open']);
});

test('daily and model totals use the same period and deduplicate events', () => {
    const event = {id: 'one', session: 'a', model: 'model-a', date: '2026-09-06', input: 20, output: 5, cacheRead: 10, cacheWrite: 0};
    const yesterday = {...event, id: 'yesterday', date: '2026-09-05', model: 'model-b'};
    const events = [event, event, yesterday, {...event, id: 'older', date: '2026-08-01'}];
    const now = new Date('2026-09-06T12:00:00').getTime();
    const result = aggregateEvents(events, now);
    assert.equal(result.days.length, 1);
    assert.equal(result.days.reduce((sum, d) => sum + d.total, 0), 35);
    assert.equal(result.models[0].total, 35);
    assert.equal(result.days.at(-1).sessions, 1);
    assert.equal(result.period.start, '2026-09-06');
    assert.deepEqual(result.days[0].models, result.models);
    const retained = aggregateEvents(events, now, 30);
    assert.equal(retained.models.reduce((sum, model) => sum + model.total, 0), 70);
    assert.equal(retained.days.at(-2).models[0].model, 'model-b');
    assert.equal(retained.days.at(-1).models[0].model, 'model-a');
});

test('calendar buckets are consecutive across month boundaries', () => {
    assert.deepEqual(getRecentDates(new Date('2026-03-02T12:00:00').getTime(), 3), ['2026-02-28', '2026-03-01', '2026-03-02']);
    assert.equal(normalizeTimestamp('1800000000'), 1800000000000);
});

test('notifications emit every configured milestone once per quota period', () => {
    const tracker = new QuotaThresholdTracker();
    const value = createUsageRecord('codex');
    value.limits = {status: 'ready', windows: [{id: 'weekly', label: 'Weekly', usedPercent: 79, resetsAt: 500}]};
    assert.deepEqual(tracker.update(value, 80), []);
    value.limits.windows[0].usedPercent = 80;
    assert.equal(tracker.update(value, 80)[0].threshold, 80);
    assert.deepEqual(tracker.update(value, 80), []);
    value.limits.windows[0].usedPercent = 90;
    assert.equal(tracker.update(value, 80)[0].threshold, 90);
    assert.deepEqual(tracker.update(value, 80), []);
    value.limits.windows[0].usedPercent = 100;
    assert.equal(tracker.update(value, 80)[0].threshold, 100);
    assert.deepEqual(tracker.update(value, 80), []);
    value.limits.windows[0].usedPercent = 50;
    assert.deepEqual(tracker.update(value, 80), []);
    value.limits.windows[0].usedPercent = 100;
    assert.deepEqual(tracker.update(value, 80), []);
    value.limits.status = 'unavailable';
    assert.deepEqual(tracker.update(value, 80), []);
    value.limits.status = 'ready';
    value.limits.windows[0].resetsAt = 1000;
    assert.deepEqual(tracker.update(value, 80), []);
});

test('simultaneous and repeated alerts produce one concise notification body', () => {
    assert.equal(formatNotificationBody([
        {provider: 'Codex', label: 'Weekly', threshold: 90},
        {provider: 'Codex', label: 'Weekly', threshold: 90},
        {provider: 'Codex', label: '5H Session', threshold: 100},
    ]), 'Weekly 90%\n5H Session 100%');
    assert.equal(formatNotificationBody([
        {provider: 'Codex', label: 'Weekly', threshold: 90},
        {provider: 'Claude Code', label: 'Weekly', threshold: 100},
    ]), 'Codex: Weekly 90%\nClaude Code: Weekly 100%');
    assert.equal(formatNotificationBody([]), '');
    assert.equal(formatNotificationBody(Array.from({length: 8}, (_, index) =>
        ({provider: 'Codex', label: `Limit ${index}`, threshold: 90}))),
    'Limit 0 90%\nLimit 1 90%\nLimit 2 90%\n+5 limits');
});

test('notification eviction retains recently refreshed windows and accepts fresh partial data', () => {
    const tracker = new QuotaThresholdTracker();
    const current = (id, percent) => ({id: 'codex', name: 'Codex', limits: {status: 'partial', windows: [
        {id, label: id, usedPercent: percent, resetsAt: 1000},
    ]}});
    tracker.update(current('active', 79), 80);
    assert.equal(tracker.update(current('active', 90), 80).length, 1);
    for (let id = 0; id < 500; id++) {
        tracker.update(current(String(id), 0), 80);
        assert.deepEqual(tracker.update(current('active', 90), 80), []);
    }
    assert.equal(tracker.trackedWindowCount, 200);
});

test('formatting preserves unknown/reset-due states', () => {
    assert.equal(formatTokenCount(null), '—');
    assert.equal(formatTokenCount(23000000), '23.0M');
    assert.equal(formatTokenCount(999999999), '1000.0M');
    assert.equal(formatTokenCount(1200000000000), '1.2T');
    assert.equal(formatTokenCount(Number.MAX_SAFE_INTEGER), '9.0P');
    assert.equal(formatResetCountdown(null), null);
    assert.equal(formatResetCountdown(null), null);
    assert.equal(formatResetCountdown(100, 200), 'due');
    assert.equal(formatResetCountdown(100 + 4 * 86400000 + 22 * 3600000, 100), '4d 22h');
    assert.equal(formatModelName('gpt-5.6-sol'), 'GPT 5.6 Sol');
    assert.equal(formatModelName('codex_auto-review'), 'Codex Auto Review');
});

test('rate limits carry their retry time and estimate without triggering collection backoff', () => {
    const window = createQuotaWindow({id: 'five-hour', label: 'Session', usedPercent: 30, durationMinutes: 300,
        resetsAt: 5_000_000});
    const old = createUsageRecord('claude');
    old.capabilities.limits = true;
    old.accountKey = 'a'.repeat(64);
    old.limits = {...old.limits, status: 'ready', updatedAt: 100, source: 'Anthropic OAuth usage', windows: [window]};
    const next = createUsageRecord('claude');
    next.capabilities.limits = true;
    next.accountKey = old.accountKey;
    const estimate = {basedOn: 100, windows: [{...window, usedPercent: 35}]};
    next.limits = {...next.limits, status: 'unavailable', message: 'Rate limited', retryAt: 400_000, estimate};
    assert.equal(collectionNeedsBackoff(next), false);
    const merged = mergeUsageRecords(old, next, 1000);
    assert.equal(merged.limits.status, 'stale');
    assert.equal(merged.limits.retryAt, 400_000);
    assert.equal(merged.limits.estimate, estimate);
    assert.equal(validateUsageRecord(merged, 'claude'), merged);
    const recovered = mergeUsageRecords(merged, {...next, limits: {...next.limits, retryAt: undefined, estimate: undefined}}, 1000);
    assert.equal('retryAt' in recovered.limits || 'estimate' in recovered.limits, false);
    delete next.limits.retryAt;
    assert.equal(collectionNeedsBackoff(next), true);
    assert.throws(() => validateUsageRecord({...merged, limits: {...merged.limits, retryAt: -1}}, 'claude'));
    assert.throws(() => validateUsageRecord({...merged, limits: {...merged.limits,
        estimate: {basedOn: 1, windows: [{...window, usedPercent: null}]}}}, 'claude'));
});
