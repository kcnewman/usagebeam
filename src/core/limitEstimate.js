import {createQuotaWindow} from './usage.js';

// Local usage cannot be converted to an exact quota percentage: providers do
// not publish window budgets, and usage from other devices never reaches the
// local logs. Instead, each live reading calibrates how many local "cost
// units" one percent represented, and later local activity is projected
// through that ratio. Estimates therefore undercount when other clients are
// also in use, and are always presented as approximate.

export const ESTIMATED_WINDOW_IDS = Object.freeze(['five-hour', 'weekly']);
const CALIBRATION_MAX_AGE_MS = 14 * 86400000;
const MIN_CALIBRATION_PERCENT = 1;
const MAX_ROLLOVER_STEPS = 4096;

// Relative list-price weights. Only ratios matter because calibration
// divides them out; they keep a cache-heavy session from looking expensive.
function modelWeight(model) {
    const name = String(model ?? '').toLowerCase();
    if (name.includes('opus'))
        return 5;
    if (name.includes('haiku'))
        return 1;
    return 3;
}

export function eventCostUnits(event) {
    const value = field => Number.isFinite(event?.[field]) && event[field] > 0 ? event[field] : 0;
    return modelWeight(event?.model) * (value('input') + value('output') * 5 +
        value('cacheWrite') * 1.25 + value('cacheRead') * 0.1);
}

export function sumCostUnits(events, start, end) {
    let total = 0;
    for (const event of events) {
        if (Number.isFinite(event?.at) && event.at > start && event.at <= end)
            total += eventCostUnits(event);
    }
    return total;
}

// Builds the stored calibration from a live reading. A window whose ratio is
// not measurable (near-zero usage or no timestamped local events) keeps the
// previous ratio so a fresh window can still be projected.
export function calibrateLimits(windows, events, now, previous = null) {
    const calibration = {};
    for (const window of windows ?? []) {
        if (!ESTIMATED_WINDOW_IDS.includes(window?.id) || !Number.isFinite(window.usedPercent) ||
            !Number.isFinite(window.durationMinutes) || window.durationMinutes <= 0)
            continue;
        const duration = window.durationMinutes * 60000;
        const start = Number.isFinite(window.resetsAt) ? window.resetsAt - duration : now - duration;
        const units = sumCostUnits(events, start, now);
        const prior = previous?.[window.id];
        const unitsPerPercent = window.usedPercent >= MIN_CALIBRATION_PERCENT && units > 0
            ? units / window.usedPercent
            : Number.isFinite(prior?.unitsPerPercent) && prior.unitsPerPercent > 0 ? prior.unitsPerPercent : null;
        calibration[window.id] = {label: window.label, percent: window.usedPercent,
            durationMinutes: window.durationMinutes, resetsAt: window.resetsAt ?? null, fetchedAt: now, unitsPerPercent};
    }
    return calibration;
}

// Five-hour sessions begin with the first message after the previous one
// expires; longer windows roll over on a fixed schedule.
function currentPeriod(entry, events, now) {
    const duration = entry.durationMinutes * 60000;
    if (!Number.isFinite(entry.resetsAt))
        return now - entry.fetchedAt < duration ? {start: entry.fetchedAt, resetsAt: null, base: entry.percent} : null;
    if (now < entry.resetsAt)
        return {start: entry.fetchedAt, resetsAt: entry.resetsAt, base: entry.percent};
    if (entry.durationMinutes > 300) {
        const steps = Math.floor((now - entry.resetsAt) / duration) + 1;
        const resetsAt = entry.resetsAt + steps * duration;
        return {start: resetsAt - duration, resetsAt, base: 0};
    }
    const times = events.map(event => event?.at).filter(Number.isFinite).sort((a, b) => a - b);
    let boundary = entry.resetsAt;
    for (let step = 0; step < MAX_ROLLOVER_STEPS; step++) {
        const first = times.find(time => time >= boundary && time <= now);
        if (first === undefined)
            return {start: boundary, resetsAt: null, base: 0};
        if (first + duration > now)
            return {start: first - 1, resetsAt: first + duration, base: 0};
        boundary = first + duration;
    }
    return null;
}

export function estimateLimits(calibration, events, now) {
    const windows = [];
    let basedOn = null;
    for (const id of ESTIMATED_WINDOW_IDS) {
        const entry = calibration?.[id];
        if (!entry || !Number.isFinite(entry.fetchedAt) || !Number.isFinite(entry.percent) ||
            !Number.isFinite(entry.durationMinutes) || entry.durationMinutes <= 0 ||
            now < entry.fetchedAt || now - entry.fetchedAt > CALIBRATION_MAX_AGE_MS)
            continue;
        const period = currentPeriod(entry, events, now);
        if (!period)
            continue;
        const units = sumCostUnits(events, period.start, now);
        const rate = Number.isFinite(entry.unitsPerPercent) && entry.unitsPerPercent > 0 ? entry.unitsPerPercent : null;
        if (units > 0 && !rate)
            continue;
        const usedPercent = Math.min(100, period.base + (units > 0 ? units / rate : 0));
        const window = createQuotaWindow({id, label: entry.label, usedPercent,
            durationMinutes: entry.durationMinutes, resetsAt: period.resetsAt});
        if (window) {
            windows.push(window);
            basedOn = Math.max(basedOn ?? 0, entry.fetchedAt);
        }
    }
    return windows.length ? {basedOn, windows} : null;
}
