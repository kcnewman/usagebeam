const MANUAL_REFRESH_COOLDOWN_MS = 2000;
const MAX_BACKOFF_SECONDS = 3600;
export const MAX_CONSECUTIVE_FAILURES = 4;

// Account limit endpoints that rate limit independently of local history.
// Limits refresh no faster than minIntervalSeconds on the automatic schedule
// and manualCooldownSeconds on explicit refreshes; history keeps the normal cadence.
export const LIMITS_POLICY = Object.freeze({
    claude: Object.freeze({minIntervalSeconds: 300, manualCooldownSeconds: 60}),
});
// Scheduler ticks land a few seconds late; allow that much slack so a five
// minute interval does not slip to the following refresh.
const LIMITS_INTERVAL_SLACK = 0.9;
const RATE_LIMIT_DEFAULT_MS = 300000;
const RATE_LIMIT_MIN_MS = 60000;
const RATE_LIMIT_MAX_MS = 3600000;

export function getRefreshDelayMs(intervalSeconds, failureCount, force = false) {
    return force ? MANUAL_REFRESH_COOLDOWN_MS
        : Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * 2 ** failureCount) * 1000;
}

// Retry-After is either delay-seconds or an HTTP-date (RFC 9110 §10.2.3).
export function parseRetryAfter(value, now = Date.now()) {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const text = value.trim();
    if (/^\d+$/.test(text)) {
        const seconds = Number(text);
        return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
    }
    const date = Date.parse(text);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function getRateLimitRetryAt(retryAfterMs, now = Date.now()) {
    const delay = Number.isFinite(retryAfterMs) ? retryAfterMs : RATE_LIMIT_DEFAULT_MS;
    return now + Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, Math.round(delay)));
}

export function shouldFetchLimits(providerId, {now, force = false, lastAttemptAt = null, notBefore = null}) {
    if (Number.isFinite(notBefore) && now < notBefore)
        return false;
    const policy = LIMITS_POLICY[providerId];
    if (!policy || !Number.isFinite(lastAttemptAt))
        return true;
    const elapsed = now - lastAttemptAt;
    if (elapsed < 0)
        return true;
    const seconds = force ? policy.manualCooldownSeconds : policy.minIntervalSeconds * LIMITS_INTERVAL_SLACK;
    return elapsed >= seconds * 1000;
}

// Consecutive rate limits double the wait so one success does not drop
// straight back to a cadence the endpoint has just rejected.
export function getLimitsNotBefore(providerId, {now, retryAt = null, strikes = 1}) {
    const base = LIMITS_POLICY[providerId]?.minIntervalSeconds ?? 0;
    const backoff = Math.min(MAX_BACKOFF_SECONDS, base * 2 ** Math.max(0, strikes - 1)) * 1000;
    return Math.max(Number.isFinite(retryAt) ? retryAt : 0, now + backoff);
}
