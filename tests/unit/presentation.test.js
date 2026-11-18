import assert from 'node:assert/strict';
import test from 'node:test';
import {formatQuotaName} from '../../src/core/format.js';
import {notificationMilestones, quotaSeverity} from '../../src/core/thresholds.js';
import {
    getTodayActivity,
    getHistoryDays,
    formatHistoryDate,
    getPanelQuota,
    getDisplayWindows,
    getProviderStatus,
    getQuotaPresentation,
} from '../../src/ui/presentation.js';

test('provider status distinguishes live, local, cached and setup data', () => {
    const value = {limits: {status: 'ready'}, history: {status: 'ready'}};
    assert.equal(getProviderStatus(value), 'Live');
    value.limits.status = 'unavailable';
    assert.equal(getProviderStatus(value), 'Local');
    value.history.status = 'stale';
    assert.equal(getProviderStatus(value), 'Cached');
    value.history.status = 'unsupported';
    assert.equal(getProviderStatus(value), 'Setup');
    assert.equal(getProviderStatus(value, true), 'Sync');
    assert.equal(getProviderStatus(null, true), 'Sync');
    value.limits.status = 'ready';
    assert.equal(getProviderStatus(value, true), 'Live');
});

test('today and daily history never reuse multi-day model totals or yesterday after midnight', () => {
    const now = new Date('2026-09-06T23:59:00').getTime();
    const models = [{model: 'today-model', total: 20}];
    const history = {
        scope: 'local',
        period: {start: '2026-08-31', end: '2026-09-06'},
        days: [{date: '2026-09-05', total: 10}, {date: '2026-09-06', total: 20, models}],
        models: [{model: 'old-model', total: 70}],
    };
    assert.deepEqual(getTodayActivity(history, now), history.days[1]);
    assert.deepEqual(getHistoryDays(history, now).map(day => day.total), [20, 10]);
    assert.equal(formatHistoryDate('2026-09-06', now), 'Today');
    assert.equal(formatHistoryDate('2026-09-05', now), 'Yesterday');
    assert.equal(getTodayActivity(history, now + 120000), null);
    assert.equal(getTodayActivity({...history, days: []}, now), null);
    assert.equal(getTodayActivity(null, now), null);
    const legacy = {...history, days: [{date: '2026-09-06', total: 20}]};
    assert.equal(getTodayActivity(legacy, now).models, undefined);
    assert.deepEqual(history.days.map(day => day.total), [10, 20]);
});

test('activity follows local midnight across daylight saving and year boundaries', () => {
    const originalZone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
        for (const [stamp, date] of [['2026-03-08T04:59:00Z', '2026-03-07'],
            ['2026-03-08T05:01:00Z', '2026-03-08'], ['2026-11-01T05:30:00Z', '2026-11-01'],
            ['2026-11-01T06:30:00Z', '2026-11-01'], ['2027-01-01T04:59:00Z', '2026-12-31']]) {
            const history = {days: [{date, total: 42, models: []}]};
            assert.equal(getTodayActivity(history, Date.parse(stamp)).total, 42);
            assert.equal(formatHistoryDate(date, Date.parse(stamp)), 'Today');
        }
    } finally {
        if (originalZone === undefined)
            delete process.env.TZ;
        else
            process.env.TZ = originalZone;
    }
});

test('quota presentation keeps names concise and reset descriptions explicit', () => {
    const now = 1_000_000;
    const reserve = {id: 'gpt-reserve:primary', label: 'Reserve · Weekly',
        durationMinutes: 10080, usedPercent: 18.2, resetsAt: now + 4 * 86400000 + 22 * 3600000};
    assert.equal(formatQuotaName(reserve), 'Reserve');
    assert.deepEqual(getQuotaPresentation(reserve, now), {
        name: 'Reserve', value: '18%', reset: '4d 22h',
    });
    assert.equal(formatQuotaName({id: 'five-hour', label: 'Session · 5 hours', durationMinutes: 300}),
        '5h Session');
    assert.deepEqual(getQuotaPresentation({id: 'credits', label: 'Credits', unlimited: true}, now), {
        name: 'Credits', value: 'Unlimited', reset: null,
    });
    assert.equal(getQuotaPresentation({id: 'broken', label: 'Broken'}, now), null);
    assert.equal(getQuotaPresentation({...reserve, resetsAt: now - 1}, now).reset,
        'due');
    assert.equal(getQuotaPresentation({...reserve, resetsAt: null}, now).reset,
        'Unknown');
});

test('notification milestones follow quota semantics without duplicate levels', () => {
    for (const [value, severity] of [[null, null], [0, null], [79, null], [80, 'caution'],
        [89, 'caution'], [90, 'warning'], [99, 'warning'], [100, 'danger']])
        assert.equal(quotaSeverity(value), severity);
    assert.deepEqual(notificationMilestones(80), [80, 90, 100]);
    assert.deepEqual(notificationMilestones(90), [90, 100]);
    assert.deepEqual(notificationMilestones(95), [95, 100]);
    assert.deepEqual(notificationMilestones(NaN), [90, 100]);
});

test('panel quota prefers the shortest current quota window at every usage level', () => {
    const now = 1_000_000;
    const record = {limits: {status: 'ready', windows: [
        {id: 'weekly', usedPercent: 96, durationMinutes: 10080,
            resetsAt: now + 15 * 3600000 + 59 * 60000},
        {id: 'five-hour', usedPercent: 15, durationMinutes: 300,
            resetsAt: now + 3600000},
        {usedPercent: null, unlimited: true},
    ]}};
    assert.deepEqual(getPanelQuota(record, now), {percent: 15, reset: '1h 0m', source: 'live', text: '15%'});
    record.limits.windows[1].usedPercent = 100;
    assert.deepEqual(getPanelQuota(record, now), {percent: 100, reset: '1h 0m', source: 'live', text: '100%'});
    record.limits.windows = [
        {id: 'provider-first', usedPercent: 20},
        {id: 'provider-second', usedPercent: 90},
    ];
    assert.deepEqual(getPanelQuota(record, now), {percent: 20, reset: null, source: 'live', text: '20%'});
    assert.equal(getPanelQuota({limits: {...record.limits, status: 'stale', updatedAt: now}}, now).text, '20%');
    assert.equal(getPanelQuota({limits: {...record.limits, status: 'unavailable'}}, now), null);
    assert.equal(getPanelQuota(null, now), null);
});

test('cached readings keep a percentage and yield to estimates once old or reset', () => {
    const now = 10_000_000;
    const session = {id: 'five-hour', label: 'Session · 5 hours', usedPercent: 40, durationMinutes: 300,
        resetsAt: now + 3600000};
    const weekly = {id: 'weekly', label: 'Weekly', usedPercent: 60, durationMinutes: 10080, resetsAt: now + 86400000};
    const estimate = {basedOn: now - 60000, windows: [{...session, usedPercent: 47}, {...weekly, usedPercent: 62}]};
    const record = {limits: {status: 'stale', updatedAt: now - 60000, windows: [session, weekly], estimate},
        history: {status: 'ready'}};
    assert.deepEqual(getPanelQuota(record, now), {percent: 40, reset: '1h 0m', source: 'cached', text: '40%'});
    assert.equal(getProviderStatus(record), 'Cached');
    const old = {...record, limits: {...record.limits, updatedAt: now - 20 * 60000}};
    assert.deepEqual(getPanelQuota(old, now), {percent: 47, reset: '1h 0m', source: 'estimate', text: '~47%'});
    const reset = {...record, limits: {...record.limits, windows: [{...session, resetsAt: now - 1}, weekly],
        estimate: {...estimate, windows: [{...session, usedPercent: 3, resetsAt: now + 4 * 3600000}]}}};
    assert.deepEqual(getDisplayWindows(reset, now).map(window => [window.id, window.source, window.usedPercent]),
        [['five-hour', 'estimate', 3], ['weekly', 'cached', 60]]);
    const expiredOnly = {limits: {status: 'stale', updatedAt: now - 60000, windows: [{...session, resetsAt: now - 1}]}};
    assert.equal(getPanelQuota(expiredOnly, now), null);
    const estimateOnly = {limits: {status: 'unavailable', updatedAt: null, windows: [], estimate}};
    assert.equal(getPanelQuota(estimateOnly, now).text, '~47%');
    assert.equal(getQuotaPresentation(getDisplayWindows(estimateOnly, now)[1], now).value, '~62%');
});
