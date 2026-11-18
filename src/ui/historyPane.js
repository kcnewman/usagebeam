import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {formatModelName, formatTokenCount} from '../core/format.js';
import {createDetailRow, UsageBeamActivityItem} from './menuWidgets.js';
import {formatHistoryDate, getHistoryDays} from './presentation.js';
import {createSymbolicIcon} from './widgets.js';

export function addModelRows(menu, models, extensionPath) {
    for (const model of models) {
        const name = formatModelName(model.model);
        menu.addMenuItem(createDetailRow(name, formatTokenCount(model.total), {
            style: 'usagebeam-model-row',
            icon: createSymbolicIcon('model', extensionPath),
            description: `${name}, ${model.total} tokens. Input ${model.input}, output ${model.output}, cache read ${model.cacheRead}, cache write ${model.cacheWrite}.`,
        }));
    }
}

// Reuse the native submenu's scroll view so the footer stays outside the list.
export const UsageBeamHistoryPane = GObject.registerClass(class UsageBeamHistoryPane extends PopupMenu.PopupSubMenuMenuItem {
    _init(extensionPath, back, resize) {
        super._init('History', true);
        this.icon.icon_name = 'go-previous-symbolic';
        this._triangleBin.hide();
        this._back = back;
        this._resize = resize;
        this._extensionPath = extensionPath;
        this._days = [];
        this._expandedDate = null;
        this._key = null;
        this.menu.box.add_style_class_name('usagebeam-history-details');
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            if (symbol !== Clutter.KEY_Left)
                return Clutter.EVENT_PROPAGATE;
            this._back();
            return Clutter.EVENT_STOP;
        });
        this.add_action(keys);
    }

    activate() {
        this._back();
    }

    reset() {
        this._expandedDate = null;
        this._key = null;
    }

    update(provider, history, now) {
        const days = getHistoryDays(history, now);
        const key = JSON.stringify([provider, days, formatHistoryDate(days[0]?.date ?? '2000-01-01', now)]);
        if (key === this._key)
            return;
        const focus = global.stage.get_key_focus();
        const focusName = focus && this.menu.box.contains(focus) ? focus.accessible_name : null;
        if (focusName)
            this.grab_key_focus();
        if (this._provider !== provider)
            this._expandedDate = null;
        this._provider = provider;
        this._key = key;
        this.label.text = `${provider} History`;
        this.accessible_name = `${provider} History, back to providers`;
        this.menu.removeAll();
        this._days = [];
        for (const day of days) {
            const row = new UsageBeamActivityItem(formatHistoryDate(day.date, now), formatTokenCount(day.total),
                createSymbolicIcon('activity', this._extensionPath), expanded => this._expand(day.date, expanded));
            row.accessible_name = `${day.date}, ${day.total} tokens on this device`;
            this.menu.addMenuItem(row);
            const details = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(details);
            this._days.push({date: day.date, row, details, models: day.models});
        }
        if (!days.length)
            this.menu.addMenuItem(createDetailRow('History unavailable', '', {secondary: true}));
        this._expand(this._expandedDate, true);
        if (focusName) {
            const find = actor => actor.accessible_name === focusName ? actor : actor.get_children().map(find).find(Boolean);
            (find(this.menu.box) ?? this).grab_key_focus();
        }
    }

    _expand(date, expanded) {
        this._expandedDate = expanded ? date : null;
        for (const day of this._days) {
            const open = day.date === this._expandedDate;
            day.details.removeAll();
            if (open) {
                addModelRows(day.details, day.models ?? [], this._extensionPath);
                if (!day.models || !day.models.length)
                    day.details.addMenuItem(createDetailRow(day.models ? 'No recorded tokens' : 'Refresh for model details',
                        '', {secondary: true}));
            }
            day.row.setExpanded(open);
            day.details.actor.visible = open;
        }
        this._resize();
    }
});
