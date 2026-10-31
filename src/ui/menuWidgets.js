import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {createLabel, createMetricLabel} from './widgets.js';

const UsageBeamDetailItem = GObject.registerClass(class UsageBeamDetailItem extends PopupMenu.PopupBaseMenuItem {
    activate() {
        // Informational rows remain keyboard reachable without closing the menu.
    }
});

function createRowIcon(gicon) {
    return new St.Icon({gicon, style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER});
}

export function createResetMetric(reset) {
    const timer = new St.BoxLayout({style_class: 'usagebeam-reset', y_align: Clutter.ActorAlign.CENTER});
    timer.opacity = 180;
    timer.label = createMetricLabel('', 'usagebeam-reset-time');
    timer.add_child(timer.label);
    timer.setCountdown = value => { timer.label.text = value === 'due' ? 'Due' : value ?? 'Unknown'; };
    timer.setCountdown(reset);
    return timer;
}

export function createRowHeading(label, reset = null) {
    const heading = new St.BoxLayout({style_class: 'usagebeam-row-heading', x_expand: true});
    label.x_expand = false;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    heading.add_child(label);
    if (reset)
        heading.add_child(reset);
    return heading;
}

export function createDetailRow(name, value = '', {description = '', style = '', secondary = false,
    reset = null, icon = null} = {}) {
    const row = new UsageBeamDetailItem({can_focus: true,
        style_class: `usagebeam-detail ${style}`.trim()});
    if (icon)
        row.add_child(createRowIcon(icon));
    const label = createLabel(name, secondary ? 'usagebeam-secondary' : '');
    if (secondary)
        label.opacity = 165;
    row.label = label;
    let timer = null;
    if (reset) {
        timer = createResetMetric(reset);
        row.resetLabel = timer.label;
    }
    row.add_child(createRowHeading(label, timer));
    if (value) {
        const metric = createMetricLabel(value, 'usagebeam-value');
        row.add_child(metric);
        row.valueLabel = metric;
    }
    row.setReset = countdown => {
        timer?.setCountdown(countdown);
        row.accessible_name = description || `${name}${value ? `, ${value}` : ''}${countdown ? `, reset ${countdown}` : ''}`;
    };
    row.setReset(reset);
    return row;
}

// A disclosure inside the provider's one scrollable submenu. Native nested
// submenus share the top-level accordion slot and would close their own parent.
export const UsageBeamActivityItem = GObject.registerClass(class UsageBeamActivityItem extends PopupMenu.PopupBaseMenuItem {
    _init(label, value, icon, toggle) {
        super._init({style_class: 'usagebeam-activity-toggle'});
        this._toggle = toggle;
        this.add_child(createRowIcon(icon));
        this.label = createLabel(label, '', true);
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.valueLabel = createMetricLabel(value, 'usagebeam-value');
        this.add_child(this.label);
        this.add_child(this.valueLabel);
        this._arrow = new St.Icon({icon_name: 'pan-end-symbolic', style_class: 'popup-menu-arrow'});
        this.add_child(this._arrow);
        this.accessible_name = `${label}, ${value} tokens`;
        this.add_accessible_state(Atk.StateType.EXPANDABLE);
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            if (symbol === Clutter.KEY_Right || (symbol === Clutter.KEY_Left && this._expanded)) {
                this._toggle(symbol === Clutter.KEY_Right);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.add_action(keys);
    }

    setExpanded(expanded) {
        this._expanded = expanded;
        this._arrow.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
        if (expanded)
            this.add_accessible_state(Atk.StateType.EXPANDED);
        else
            this.remove_accessible_state(Atk.StateType.EXPANDED);
        if (expanded)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
    }

    activate() {
        this._toggle(!this._expanded);
    }
});

export function createIconAction(icon, name, callback) {
    const button = new St.Button({style_class: 'button usagebeam-icon-action',
        accessible_name: name, can_focus: true, reactive: true, track_hover: true,
        child: new St.Icon({icon_name: icon})});
    button.setActionName = value => { button.accessible_name = value; };
    button.connect('clicked', callback);
    return button;
}
