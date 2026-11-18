import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {getLocalDate} from '../core/dates.js';
import {QuotaThresholdTracker} from '../core/notifications.js';
import {getEnabledProviders} from '../core/providerRegistry.js';
import {MAX_CONSECUTIVE_FAILURES, getLimitsNotBefore, getRefreshDelayMs, shouldFetchLimits} from '../core/refreshPolicy.js';
import {collectionNeedsBackoff, createUsageRecord, createUsageSection, mergeUsageRecords} from '../core/usage.js';
import {validateUsageRecord} from '../core/usageValidation.js';
import {createCommandSpec} from './commands.js';
import {buildPath} from './files.js';
import {runCommand} from './process.js';
import {loadProviderSnapshot, saveProviderSnapshot} from './snapshotStore.js';

const SCHEDULER_TICK_SECONDS = 15;

export class UsageService {
    constructor({settings, extensionPath, onChanged, onAlerts}) {
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._onChanged = onChanged;
        this._onAlerts = onAlerts;
        this._recordsByProvider = {};
        this._pendingCollections = new Map();
        this._lastAttemptAt = new Map();
        this._failureCounts = new Map();
        this._limitsAttemptAt = new Map();
        this._limitsNotBefore = new Map();
        this._rateLimitStrikes = new Map();
        this._snapshotLoads = new Map();
        this._snapshotSaves = new Map();
        this._thresholdTracker = new QuotaThresholdTracker();
        this._destroyed = false;
        this._enabledProviderIds = [];
        this._calendarDate = getLocalDate(Date.now());
        this.configure();
        this._refreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SCHEDULER_TICK_SECONDS, () => {
            const date = getLocalDate(Date.now());
            const dayChanged = date !== this._calendarDate;
            this._calendarDate = date;
            if (dayChanged)
                this._emitChanged();
            for (const id of this._enabledProviderIds) {
                if (dayChanged)
                    this._lastAttemptAt.delete(id);
                this.refresh(id, dayChanged);
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._sleepSubscriptionId = Gio.DBus.system.signal_subscribe('org.freedesktop.login1', 'org.freedesktop.login1.Manager',
            'PrepareForSleep', '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, params) => {
                if (!params.get_child_value(0).get_boolean())
                    this.refreshAll(true);
            });
    }

    get enabledProviders() {
        return [...this._enabledProviderIds];
    }

    recordFor(id) {
        return this._recordsByProvider[id] ?? null;
    }

    isRefreshing(id) {
        return this._pendingCollections.has(id);
    }

    _emitChanged() {
        try {
            this._onChanged();
        } catch (error) {
            console.error('UsageBeam could not update its panel', error);
        }
    }

    _emitAlerts(alerts) {
        try {
            this._onAlerts(alerts);
        } catch (error) {
            console.error('UsageBeam could not display a usage alert', error);
        }
    }

    configure() {
        if (this._destroyed)
            return;
        this._enabledProviderIds = getEnabledProviders(this._settings.get_strv('enabled-providers'),
            this._settings.get_strv('provider-order'));
        for (const [id, job] of this._pendingCollections) {
            if (!this._enabledProviderIds.includes(id)) {
                job.cancel();
                this._pendingCollections.delete(id);
            }
        }
        for (const id of Object.keys(this._recordsByProvider)) {
            if (!this._enabledProviderIds.includes(id)) {
                delete this._recordsByProvider[id];
                this._snapshotLoads.delete(id);
                this._lastAttemptAt.delete(id);
                this._failureCounts.delete(id);
                this._forgetLimitsSchedule(id);
            }
        }
        for (const id of this._enabledProviderIds) {
            if (this._recordsByProvider[id])
                continue;
            const placeholder = createUsageRecord(id);
            this._recordsByProvider[id] = placeholder;
            const load = loadProviderSnapshot(id).then(snapshot => {
                if (this._destroyed || this._snapshotLoads.get(id) !== load)
                    return;
                this._snapshotLoads.delete(id);
                if (this._recordsByProvider[id] !== placeholder)
                    return;
                this._recordsByProvider[id] = snapshot;
                // A saved rate-limit window survives Shell restarts.
                const retryAt = snapshot.limits.retryAt;
                if (Number.isFinite(retryAt) && retryAt > Date.now())
                    this._limitsNotBefore.set(id, retryAt);
                this._emitChanged();
            }, () => {
                if (this._snapshotLoads.get(id) === load)
                    this._snapshotLoads.delete(id);
            });
            this._snapshotLoads.set(id, load);
        }
    }

    // Writes for one provider are serialized so an older record cannot land last.
    _persistSnapshot(id) {
        const record = this._recordsByProvider[id];
        const save = (this._snapshotSaves.get(id) ?? Promise.resolve())
            .then(() => saveProviderSnapshot(record));
        this._snapshotSaves.set(id, save);
        save.finally(() => {
            if (this._snapshotSaves.get(id) === save)
                this._snapshotSaves.delete(id);
        });
    }

    _forgetLimitsSchedule(id) {
        this._limitsAttemptAt.delete(id);
        this._limitsNotBefore.delete(id);
        this._rateLimitStrikes.delete(id);
    }

    _updateLimitsSchedule(id, limits, now) {
        if (Number.isFinite(limits.retryAt)) {
            const strikes = (this._rateLimitStrikes.get(id) ?? 0) + 1;
            this._rateLimitStrikes.set(id, strikes);
            this._limitsNotBefore.set(id, getLimitsNotBefore(id, {now, retryAt: limits.retryAt, strikes}));
        } else if (['ready', 'partial'].includes(limits.status)) {
            this._rateLimitStrikes.delete(id);
            this._limitsNotBefore.delete(id);
        }
    }

    refreshAll(force = false) {
        for (const id of this._enabledProviderIds)
            this.refresh(id, force);
    }

    clearSavedData() {
        if (this._destroyed)
            return;
        for (const job of this._pendingCollections.values())
            job.cancel();
        this._pendingCollections.clear();
        this._lastAttemptAt.clear();
        this._failureCounts.clear();
        this._limitsAttemptAt.clear();
        this._limitsNotBefore.clear();
        this._rateLimitStrikes.clear();
        this._snapshotLoads?.clear();
        this._thresholdTracker = new QuotaThresholdTracker();
        this._recordsByProvider = Object.fromEntries(this._enabledProviderIds.map(id => [id, createUsageRecord(id)]));
        this._emitChanged();
        this.refreshAll(true);
    }

    async refresh(id, force = false) {
        if (this._destroyed || !this._enabledProviderIds.includes(id) || this._pendingCollections.has(id))
            return;
        const now = Date.now();
        const elapsed = now - (this._lastAttemptAt.get(id) ?? 0);
        const delayMs = getRefreshDelayMs(this._settings.get_int('refresh-interval'),
            this._failureCounts.get(id) ?? 0, force);
        if (elapsed >= 0 && elapsed < delayMs)
            return;
        const job = new Gio.Cancellable();
        this._pendingCollections.set(id, job);
        this._lastAttemptAt.set(id, now);
        this._emitChanged();
        try {
            // The saved snapshot carries any rate-limit window and the record to merge into.
            await this._snapshotLoads.get(id);
            if (this._destroyed || job.is_cancelled() || this._pendingCollections.get(id) !== job)
                return;
            // Local history always refreshes; rate-limited account limits only when due.
            const skipLimits = !shouldFetchLimits(id, {now, force, lastAttemptAt: this._limitsAttemptAt.get(id) ?? null,
                notBefore: this._limitsNotBefore.get(id) ?? null});
            if (!skipLimits)
                this._limitsAttemptAt.set(id, now);
            const collector = createCommandSpec('gjs', ['-m', buildPath(this._extensionPath, 'src', 'collector', 'main.js'),
                id, String(this._settings.get_int('history-retention-days')), ...(skipLimits ? ['--skip-limits'] : [])]);
            // The owned GJS collector handles SIGTERM and reaps its CLI child.
            // Cancellation removes Shell timers synchronously; reaping is native async I/O.
            const stdout = await runCommand(collector, {cancellable: job, timeout: 45000, gracefulCancellation: true});
            if (this._destroyed || job.is_cancelled() || this._pendingCollections.get(id) !== job)
                return;
            let result = validateUsageRecord(JSON.parse(stdout), id);
            const previous = this._recordsByProvider[id];
            const sameAccount = !previous?.accountKey || !result.accountKey || previous.accountKey === result.accountKey;
            if (skipLimits && !sameAccount)
                this._forgetLimitsSchedule(id);
            if (skipLimits && sameAccount && previous && result.limits.status === 'loading') {
                const {estimate: _estimate, ...kept} = previous.limits;
                result = {...result, limits: {...kept, ...(result.limits.estimate ? {estimate: result.limits.estimate} : {})},
                    plan: result.plan ?? previous.plan,
                    accountKey: result.accountKey ?? previous.accountKey};
            } else {
                this._updateLimitsSchedule(id, result.limits, now);
            }
            const failed = collectionNeedsBackoff(result);
            this._failureCounts.set(id, failed ? Math.min(MAX_CONSECUTIVE_FAILURES, (this._failureCounts.get(id) ?? 0) + 1) : 0);
            const alerts = this._thresholdTracker.update(result, this._settings.get_int('notification-threshold'));
            this._recordsByProvider[id] = mergeUsageRecords(this._recordsByProvider[id], result);
            this._persistSnapshot(id);
            if (this._settings.get_boolean('notifications-enabled') && alerts.length)
                this._emitAlerts(alerts);
        } catch {
            if (!this._destroyed && !job.is_cancelled()) {
                const failure = createUsageRecord(id);
                failure.limits = {...failure.limits,
                    ...createUsageSection('unavailable', 'Collection failed or timed out. Retry from the panel.')};
                failure.history = {...failure.history, ...createUsageSection('unavailable', 'History could not be refreshed.')};
                this._recordsByProvider[id] = mergeUsageRecords(this._recordsByProvider[id], failure);
                this._failureCounts.set(id, Math.min(MAX_CONSECUTIVE_FAILURES, (this._failureCounts.get(id) ?? 0) + 1));
            }
        } finally {
            if (this._pendingCollections.get(id) === job)
                this._pendingCollections.delete(id);
            if (getLocalDate(now) !== getLocalDate(Date.now()))
                this._lastAttemptAt.delete(id);
            if (!this._destroyed)
                this._emitChanged();
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._refreshTimerId) {
            GLib.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        if (this._sleepSubscriptionId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSubscriptionId);
            this._sleepSubscriptionId = 0;
        }
        for (const job of this._pendingCollections.values())
            job.cancel();
        this._pendingCollections.clear();
        this._onChanged = () => {};
        this._onAlerts = () => {};
    }
}
