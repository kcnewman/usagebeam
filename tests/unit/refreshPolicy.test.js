import assert from 'node:assert/strict';
import test from 'node:test';
import {getLimitsNotBefore, getRateLimitRetryAt, getRefreshDelayMs, parseRetryAfter, shouldFetchLimits}
    from '../../src/core/refreshPolicy.js';

test('automatic retry backoff grows per failure and stops at one hour', () => {
    assert.equal(getRefreshDelayMs(120, 0), 120000);
    assert.equal(getRefreshDelayMs(120, 1), 240000);
    assert.equal(getRefreshDelayMs(120, 4), 1920000);
    assert.equal(getRefreshDelayMs(3600, 4), 3600000);
});

test('manual refresh keeps its cooldown independently of automatic backoff', () => {
    for (const failures of [0, 1, 4])
        assert.equal(getRefreshDelayMs(3600, failures, true), 2000);
});

test('Retry-After accepts delay seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-18T10:00:00Z');
    assert.equal(parseRetryAfter('120', now), 120000);
    assert.equal(parseRetryAfter('Wed, 18 Nov 2026 10:05:00 GMT', now), 300000);
    assert.equal(parseRetryAfter('Wed, 18 Nov 2026 09:00:00 GMT', now), 0);
    for (const value of [null, '', 'soon', undefined])
        assert.equal(parseRetryAfter(value, now), null);
});

test('rate-limit retry time defaults to five minutes and stays within one minute to one hour', () => {
    assert.equal(getRateLimitRetryAt(null, 0), 300000);
    assert.equal(getRateLimitRetryAt(1000, 0), 60000);
    assert.equal(getRateLimitRetryAt(7200000, 0), 3600000);
    assert.equal(getRateLimitRetryAt(90000, 0), 90000);
});

test('Claude limits refresh on a slower schedule than history and respect rate limits', () => {
    const now = 1_000_000_000;
    assert.equal(shouldFetchLimits('claude', {now}), true);
    assert.equal(shouldFetchLimits('claude', {now, lastAttemptAt: now - 120000}), false);
    assert.equal(shouldFetchLimits('claude', {now, lastAttemptAt: now - 285000}), true);
    assert.equal(shouldFetchLimits('claude', {now, force: true, lastAttemptAt: now - 30000}), false);
    assert.equal(shouldFetchLimits('claude', {now, force: true, lastAttemptAt: now - 61000}), true);
    assert.equal(shouldFetchLimits('claude', {now, force: true, notBefore: now + 1}), false);
    assert.equal(shouldFetchLimits('codex', {now, lastAttemptAt: now - 1000}), true);
});

test('repeated rate limits back off beyond the server hint and cap at one hour', () => {
    const now = 0;
    assert.equal(getLimitsNotBefore('claude', {now, retryAt: 60000, strikes: 1}), 300000);
    assert.equal(getLimitsNotBefore('claude', {now, retryAt: 900000, strikes: 1}), 900000);
    assert.equal(getLimitsNotBefore('claude', {now, retryAt: null, strikes: 3}), 1200000);
    assert.equal(getLimitsNotBefore('claude', {now, retryAt: null, strikes: 10}), 3600000);
});
