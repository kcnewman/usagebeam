import assert from 'node:assert/strict';
import test from 'node:test';
import {calibrateLimits, eventCostUnits, estimateLimits} from '../../src/core/limitEstimate.js';

const HOUR = 3600000;
const BASE = Date.parse('2026-11-18T00:00:00Z');
const event = (at, output = 1000, model = 'claude-sonnet') => ({at, model, input: 0, output, cacheRead: 0, cacheWrite: 0});

test('cost units weight output, cache categories and model tier', () => {
    assert.equal(eventCostUnits({model: 'claude-haiku', input: 10, output: 0, cacheRead: 0, cacheWrite: 0}), 10);
    assert.equal(eventCostUnits({model: 'claude-opus', input: 0, output: 1, cacheRead: 0, cacheWrite: 0}), 25);
    assert.equal(eventCostUnits({model: 'claude-haiku', input: 0, output: 0, cacheRead: 100, cacheWrite: 8}), 20);
    assert.equal(eventCostUnits({}), 0);
});

test('projects new activity through the ratio from the last live reading', () => {
    const now = BASE;
    const session = {id: 'five-hour', label: 'Session · 5 hours', usedPercent: 20, durationMinutes: 300,
        resetsAt: now + 2 * HOUR};
    const before = [event(now - HOUR), event(now - 2 * HOUR)];
    const calibration = calibrateLimits([session], before, now);
    assert.equal(calibration['five-hour'].unitsPerPercent, 1500);
    const later = [...before, event(now + 10 * 60000), event(now + 20 * 60000)];
    const estimate = estimateLimits(calibration, later, now + 30 * 60000);
    assert.equal(estimate.basedOn, now);
    assert.equal(estimate.windows[0].usedPercent, 40);
    assert.equal(estimate.windows[0].resetsAt, now + 2 * HOUR);
    assert.equal(estimateLimits(calibration, before, now + 30 * 60000).windows[0].usedPercent, 20);
});

test('a reset session starts from zero at the first message after the reset', () => {
    const now = BASE;
    const calibration = calibrateLimits([{id: 'five-hour', label: 'Session', usedPercent: 50,
        durationMinutes: 300, resetsAt: now + HOUR}], [event(now - HOUR, 2000)], now);
    const idle = estimateLimits(calibration, [], now + 2 * HOUR);
    assert.deepEqual([idle.windows[0].usedPercent, idle.windows[0].resetsAt], [0, null]);
    const first = now + 2 * HOUR;
    const resumed = estimateLimits(calibration, [event(first, 1500)], now + 3 * HOUR);
    assert.equal(resumed.windows[0].usedPercent, 37.5);
    assert.equal(resumed.windows[0].resetsAt, first + 5 * HOUR);
});

test('weekly windows roll over on their fixed schedule', () => {
    const now = BASE;
    const week = 168 * HOUR;
    const calibration = calibrateLimits([{id: 'weekly', label: 'Weekly', usedPercent: 10, durationMinutes: 10080,
        resetsAt: now + HOUR}], [event(now - HOUR, 2000)], now);
    const later = now + 2 * HOUR;
    const result = estimateLimits(calibration, [event(now + 90 * 60000, 600)], later);
    assert.equal(result.windows[0].resetsAt, now + HOUR + week);
    assert.equal(result.windows[0].usedPercent, 3);
});

test('no estimate without a measurable ratio, a matching window or a recent calibration', () => {
    const now = BASE;
    const window = {id: 'five-hour', label: 'Session', usedPercent: 0, durationMinutes: 300, resetsAt: now + HOUR};
    const calibration = calibrateLimits([window, {id: 'scoped:opus', usedPercent: 50, durationMinutes: 10080}], [], now);
    assert.deepEqual(Object.keys(calibration), ['five-hour']);
    assert.equal(estimateLimits(calibration, [event(now + 1)], now + 2), null);
    assert.equal(estimateLimits(calibration, [], now + 2).windows[0].usedPercent, 0);
    const kept = calibrateLimits([window], [], now, {'five-hour': {unitsPerPercent: 300}});
    assert.equal(estimateLimits(kept, [event(now + 1)], now + 2).windows[0].usedPercent, 50);
    assert.equal(estimateLimits(kept, [], now + 15 * 86400000), null);
    assert.equal(estimateLimits(null, [], now), null);
});
