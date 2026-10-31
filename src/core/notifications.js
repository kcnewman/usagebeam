import {notificationMilestones} from './thresholds.js';
import {formatQuotaName} from './format.js';

export function formatNotificationBody(alerts) {
    const singleProvider = new Set(alerts.map(alert => alert.provider)).size === 1;
    const lines = [...new Set(alerts.map(alert =>
        `${singleProvider ? '' : `${alert.provider}: `}${alert.label} ${alert.threshold}%`))];
    return [...lines.slice(0, 3), ...(lines.length > 3 ? [`+${lines.length - 3} limits`] : [])].join('\n');
}

const MAX_TRACKED_WINDOWS = 200;

export class QuotaThresholdTracker {
    constructor() {
        this._reachedMilestones = new Map();
    }

    get trackedWindowCount() {
        return this._reachedMilestones.size;
    }

    update(record, threshold = 90) {
        if (!['ready', 'partial'].includes(record.limits.status))
            return [];
        const alerts = [];
        const milestones = notificationMilestones(threshold);
        for (const window of record.limits.windows) {
            if (window.unlimited || !Number.isFinite(window.usedPercent))
                continue;
            const key = `${record.id}:${record.accountKey ?? 'default'}:${window.id}:${window.resetsAt ?? 'unknown'}`;
            const previous = this._reachedMilestones.get(key);
            const reached = milestones.filter(value => window.usedPercent >= value).at(-1) ?? 0;
            if (previous !== undefined && reached > previous)
                alerts.push({provider: record.name, label: formatQuotaName(window), threshold: reached});
            // Refresh insertion order so active windows survive eviction of old periods.
            this._reachedMilestones.delete(key);
            this._reachedMilestones.set(key, Math.max(previous ?? 0, reached));
        }
        while (this._reachedMilestones.size > MAX_TRACKED_WINDOWS)
            this._reachedMilestones.delete(this._reachedMilestones.keys().next().value);
        return alerts;
    }
}
