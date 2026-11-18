import {formatQuotaName, formatResetCountdown} from '../core/format.js';
import {getLocalDate, getRecentDates} from '../core/dates.js';

const CURRENT_STATES = new Set(['ready', 'partial']);
// A saved reading this recent is shown as-is; older readings, and windows that
// have reset since, prefer a projection from local activity when one exists.
export const FRESH_READING_MS = 15 * 60000;

export function getProviderStatus(record, refreshing = false) {
    if (CURRENT_STATES.has(record?.limits?.status))
        return 'Live';
    if (record?.limits?.status === 'stale' || record?.limits?.estimate)
        return 'Cached';
    if (CURRENT_STATES.has(record?.history?.status))
        return 'Local';
    if (record?.limits?.status === 'stale' || record?.history?.status === 'stale')
        return 'Cached';
    return refreshing ? 'Sync' : 'Setup';
}

export function getLatestUpdate(record) {
    const timestamps = [record?.limits?.updatedAt, record?.history?.updatedAt]
        .filter(value => Number.isFinite(value) && value > 0);
    return timestamps.length ? Math.max(...timestamps) : null;
}

export function getHistoryDays(history, now = Date.now()) {
    const today = getLocalDate(now);
    return (history?.days ?? []).filter(day => day.date <= today).reverse();
}

export function getTodayActivity(history, now = Date.now()) {
    return history?.days?.find(day => day.date === getLocalDate(now)) ?? null;
}

export function formatHistoryDate(date, now = Date.now()) {
    const [yesterday, today] = getRecentDates(now, 2);
    if (date === today)
        return 'Today';
    if (date === yesterday)
        return 'Yesterday';
    return new Date(`${date}T12:00:00`).toLocaleDateString(undefined,
        {month: 'short', day: 'numeric', ...(date.slice(0, 4) !== today.slice(0, 4) ? {year: 'numeric'} : {})});
}

// Windows to display, each tagged with where its value came from:
// 'live' (current reading), 'cached' (saved reading) or 'estimate'.
export function getDisplayWindows(record, now = Date.now()) {
    const limits = record?.limits;
    if (!limits || !Array.isArray(limits.windows))
        return [];
    if (CURRENT_STATES.has(limits.status))
        return limits.windows.map(window => ({...window, source: 'live'}));
    const estimates = new Map((limits.estimate?.windows ?? []).map(window => [window.id, window]));
    const freshReading = Number.isFinite(limits.updatedAt) && now - limits.updatedAt < FRESH_READING_MS;
    const shown = [];
    const seen = new Set();
    for (const window of limits.status === 'stale' ? limits.windows : []) {
        seen.add(window.id);
        const estimate = estimates.get(window.id);
        const expired = Number.isFinite(window.resetsAt) && window.resetsAt <= now;
        if (estimate && (expired || !freshReading))
            shown.push({...estimate, source: 'estimate'});
        else if (!expired)
            shown.push({...window, source: 'cached'});
    }
    for (const [id, estimate] of estimates) {
        if (!seen.has(id))
            shown.push({...estimate, source: 'estimate'});
    }
    return shown;
}

export function formatPercent(percent, source) {
    return `${source === 'estimate' ? '~' : ''}${Math.round(percent)}%`;
}

export function getQuotaPresentation(window, now = Date.now()) {
    if (!window)
        return null;
    if (window.unlimited)
        return {name: formatQuotaName(window), value: 'Unlimited', reset: null};
    if (!Number.isFinite(window.usedPercent))
        return null;
    return {
        name: formatQuotaName(window),
        value: formatPercent(window.usedPercent, window.source),
        reset: formatResetCountdown(window.resetsAt, now) ?? 'Unknown',
    };
}

export function getPanelQuota(record, now = Date.now()) {
    let window = null;
    let shortest = Infinity;
    for (const candidate of getDisplayWindows(record, now)) {
        if (candidate.unlimited || !Number.isFinite(candidate.usedPercent))
            continue;
        const duration = Number.isFinite(candidate.durationMinutes) &&
            candidate.durationMinutes > 0 ? candidate.durationMinutes : Infinity;
        if (!window || duration < shortest) {
            window = candidate;
            shortest = duration;
        }
    }
    if (!window)
        return null;
    return {
        percent: Math.round(window.usedPercent),
        reset: formatResetCountdown(window.resetsAt, now),
        source: window.source,
        text: formatPercent(window.usedPercent, window.source),
    };
}
