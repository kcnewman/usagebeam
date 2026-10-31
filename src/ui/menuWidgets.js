import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {createLabel, createMetricLabel} from './widgets.js';

const UsageBeamDetailItem = GObject.registerClass(class UsageBeamDetailItem extends PopupMenu.PopupBaseMenuItem {
    activate() {
        // Informational rows remain keyboard reachable without closing the menu.
    }
});

export function createDetailRow(name, value = '', {description = '', style = '', secondary = false} = {}) {
    const row = new UsageBeamDetailItem({can_focus: true,
        style_class: `usagebeam-detail ${style}`.trim()});
    const label = createLabel(name, secondary ? 'dim-label' : '', true);
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(label);
    row.label = label;
    if (value)
        row.add_child(createMetricLabel(value));
    row.accessible_name = description || `${name}${value ? `, ${value}` : ''}`;
    return row;
}

// A disclosure inside the provider's one scrollable submenu. Native nested
// submenus share the top-level accordion slot and would close their own parent.
export const UsageBeamActivityItem = GObject.registerClass(class UsageBeamActivityItem extends PopupMenu.PopupBaseMenuItem {
    _init(label, value, toggle) {
        super._init({style_class: 'usagebeam-activity-toggle'});
        this._toggle = toggle;
        this.add_child(createLabel(label, '', true));
        this.add_child(createMetricLabel(value));
        this._arrow = new St.Icon({icon_name: 'pan-end-symbolic', style_class: 'popup-menu-arrow'});
        this.add_child(this._arrow);
        this.accessible_name = `${label}, ${value} tokens`;
        this.add_accessible_state(Atk.StateType.EXPANDABLE);
    }

    setExpanded(expanded) {
        this._expanded = expanded;
        this._arrow.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
        if (expanded)
            this.add_accessible_state(Atk.StateType.EXPANDED);
        else
            this.remove_accessible_state(Atk.StateType.EXPANDED);
    }

    activate() {
        this._toggle(!this._expanded);
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Right || (key === Clutter.KEY_Left && this._expanded)) {
            this._toggle(key === Clutter.KEY_Right);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

export function createIconAction(icon, name, callback) {
    const button = new St.Button({style_class: 'button usagebeam-icon-action',
        accessible_name: name, can_focus: true, reactive: true, track_hover: true,
        child: new St.Icon({icon_name: icon})});
    const tooltip = new St.Label({style_class: 'dash-label', text: name, visible: false,
        reactive: false});
    Main.uiGroup.add_child(tooltip);
    button.setActionName = value => {
        button.accessible_name = value;
        tooltip.text = value;
    };
    const showTooltip = () => {
        if (!button.mapped || (!button.hover && !button.has_key_focus())) {
            tooltip.hide();
            return;
        }
        tooltip.show();
        const [x, y] = button.get_transformed_position();
        const monitor = Main.layoutManager.findMonitorForActor(button);
        tooltip.set_position(Math.max(monitor.x, Math.min(x + (button.width - tooltip.width) / 2,
            monitor.x + monitor.width - tooltip.width)), y + button.height + 6);
    };
    button.connect('notify::hover', showTooltip);
    button.connect('key-focus-in', showTooltip);
    button.connect('key-focus-out', () => tooltip.hide());
    button.connect('notify::mapped', showTooltip);
    button.connect('destroy', () => tooltip.destroy());
    button.connect('clicked', () => { tooltip.hide(); callback(); });
    return button;
}
