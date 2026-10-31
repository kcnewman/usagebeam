import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {formatNotificationBody} from '../core/notifications.js';

const BANNER_DURATION_MS = 8000;

export class UsageNotifications {
    constructor() {
        this._timers = new Map();
    }

    show(alerts) {
        const body = formatNotificationBody(alerts);
        if (!body)
            return;
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'UsageBeam', iconName: 'dialog-information-symbolic'});
            this._source.connect('destroy', () => { this._source = null; });
            Main.messageTray.add(this._source);
        }
        const providers = [...new Set(alerts.map(alert => alert.provider))];
        const notification = new MessageTray.Notification({source: this._source,
            title: providers.length === 1 ? providers[0] : 'Usage alert', body, isTransient: true});
        notification.connect('notify::acknowledged', () => {
            if (!notification.acknowledged || Main.messageTray._notification !== notification)
                return;
            Main.messageTray._banner.add_style_class_name('usagebeam-toast');
            const work = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            // em sizing follows the theme; the work-area cap also protects narrow displays.
            Main.messageTray._banner.style = `max-width: ${work.width / scale - 24}px;`;
            this._clearTimer(notification);
            // GNOME 50 has no per-notification duration API. Extend only this
            // banner after its entrance animation installs the native timeout.
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MessageTray.ANIMATION_TIME + 50, () => {
                this._timers.delete(notification);
                if (Main.messageTray._notification === notification &&
                    Main.messageTray._notificationState === MessageTray.State.SHOWN)
                    Main.messageTray._updateNotificationTimeout(BANNER_DURATION_MS);
                return GLib.SOURCE_REMOVE;
            });
            this._timers.set(notification, id);
        });
        notification.connect('destroy', () => this._clearTimer(notification));
        this._source.addNotification(notification);
    }

    _clearTimer(notification) {
        const id = this._timers.get(notification);
        if (id)
            GLib.source_remove(id);
        this._timers.delete(notification);
    }

    destroy() {
        for (const notification of this._timers.keys())
            this._clearTimer(notification);
        this._source?.destroy();
    }
}
