import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {formatModelName, formatTokenCount} from '../core/format.js';
import {PROVIDERS} from '../core/providerRegistry.js';
import {UsageBeamPanelReadout} from './panelReadout.js';
import {createDetailRow, createIconAction, createResetMetric, createRowHeading, UsageBeamActivityItem} from './menuWidgets.js';
import {getHistoryOverview, getPanelQuota, getProviderStatus, getQuotaPresentation} from './presentation.js';
import {createMetricLabel, createProviderIcon, createSymbolicIcon} from './widgets.js';

export const UsageBeamIndicator = GObject.registerClass(class UsageBeamIndicator extends PanelMenu.Button {
    _init(settings, extensionPath, openPreferences, launchProvider) {
        super._init(0.5, 'UsageBeam usage monitor');
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._openPreferences = openPreferences;
        this._launchProvider = launchProvider;
        this._providers = new Map();
        this.connect('destroy', () => { this._disposed = true; });
        this._panelReadout = new UsageBeamPanelReadout(extensionPath);
        this.add_child(this._panelReadout);
        this.menu.actor.add_style_class_name('usagebeam-menu');
        Main.layoutManager.connectObject('monitors-changed', () => this.resize(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('changed', () => this.render(), this);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this.render();
                this._service?.refreshAll();
            } else {
                for (const state of this._providers.values()) {
                    state.item.menu.close();
                    this._setActivityExpanded(state, false);
                }
            }
        });
    }

    attach(service) {
        this._service = service;
        this.render();
    }

    render() {
        if (this._disposed)
            return;
        const enabled = this._service?.enabledProviders ?? [];
        const requested = this._settings.get_string('default-provider');
        this._selectedProvider = enabled.includes(requested) ? requested : enabled[0];
        const record = this._service?.recordFor(this._selectedProvider);
        this.accessible_name = this._panelReadout.update(enabled, this._selectedProvider, record,
            this._service?.isRefreshing(this._selectedProvider) ?? false);
        if (this._providerKey !== enabled.join(','))
            this._buildMenu(enabled);
        if (!this.menu.isOpen)
            return;
        for (const [id, state] of this._providers) {
            const current = this._service.recordFor(id);
            const busy = this._service.isRefreshing(id);
            const quota = getPanelQuota(current);
            state.value.text = quota ? `${quota.percent}%` : getProviderStatus(current, busy);
            state.reset.setCountdown(quota?.reset);
            state.reset.visible = Boolean(quota);
            state.item.accessible_name = `${PROVIDERS[id].name}, ${state.value.text}${quota ? `, reset ${state.reset.label.text}` : ''}`;
            const key = JSON.stringify(current);
            if (state.recordKey !== key) {
                this._renderDetails(state, current);
                state.recordKey = key;
            }
            for (const row of state.quotas)
                row.setReset(getQuotaPresentation(row.quotaWindow).reset);
        }
        const refreshing = enabled.some(id => this._service.isRefreshing(id));
        this._refreshButton.reactive = !refreshing;
        this._refreshButton.can_focus = !refreshing;
        this._refreshButton.setActionName(refreshing ? 'Refreshing usage…' : 'Refresh usage');
        if (refreshing)
            this._refreshButton.add_style_pseudo_class('insensitive');
        else
            this._refreshButton.remove_style_pseudo_class('insensitive');
        this._terminalButton.reactive = Boolean(this._selectedProvider);
        this._terminalButton.can_focus = Boolean(this._selectedProvider);
        this._terminalButton.setActionName(this._selectedProvider
            ? `Open ${PROVIDERS[this._selectedProvider].name} in terminal` : 'Enable a provider to open a terminal');
        if (this._selectedProvider)
            this._terminalButton.remove_style_pseudo_class('insensitive');
        else
            this._terminalButton.add_style_pseudo_class('insensitive');
        this.resize();
    }

    _buildMenu(enabled) {
        const focus = global.stage.get_key_focus();
        const hadFocus = focus && this.menu.box.contains(focus);
        if (hadFocus)
            this.grab_key_focus();
        this.menu.removeAll();
        this._providers.clear();
        this._providerKey = enabled.join(',');
        for (const id of enabled) {
            const item = new PopupMenu.PopupSubMenuMenuItem(PROVIDERS[id].name, true);
            item.add_style_class_name('usagebeam-provider-row');
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const icon = createProviderIcon(id, this._extensionPath);
            item.icon.gicon = icon.gicon;
            icon.destroy();
            const reset = createResetMetric(null);
            reset.hide();
            const expander = item.get_children().find(child => child.has_style_class_name('popup-menu-item-expander'));
            expander.destroy();
            item.remove_child(item.label);
            item.insert_child_below(createRowHeading(item.label, reset), item.get_last_child());
            const value = createMetricLabel('—', 'usagebeam-provider-value usagebeam-value');
            item.insert_child_below(value, item.get_last_child());
            this.menu.addMenuItem(item);
            item.menu.box.add_style_class_name('usagebeam-provider-details');
            item.menu.actor.connect('notify::mapped', () => {
                if (item.menu.actor.mapped)
                    this.resize();
            });
            const state = {id, item, reset, value, activityExpanded: false};
            this._providers.set(id, state);
            item.menu.connect('open-state-changed', (_menu, open) => {
                if (open) {
                    this._selectedProvider = id;
                    this._settings.set_string('default-provider', id);
                } else {
                    this._setActivityExpanded(state, false);
                }
                this.resize();
            });
        }
        if (!enabled.length)
            this.menu.addMenuItem(createDetailRow('Enable a provider in Settings.'));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        footer.add_style_class_name('usagebeam-footer');
        const actions = new St.BoxLayout({style_class: 'usagebeam-actions', x_expand: true,
            layout_manager: new Clutter.BoxLayout({homogeneous: true})});
        this._refreshButton = createIconAction('view-refresh-symbolic', 'Refresh usage',
            () => this._service?.refreshAll(true));
        this._terminalButton = createIconAction('utilities-terminal-symbolic', 'Open provider in terminal',
            () => this._openTerminal());
        const preferences = createIconAction('preferences-system-symbolic', 'Open UsageBeam settings', () => {
            this.menu.close();
            this._openPreferences();
        });
        for (const button of [this._refreshButton, this._terminalButton, preferences]) {
            const slot = new St.Bin({x_expand: true});
            button.x_align = Clutter.ActorAlign.CENTER;
            slot.set_child(button);
            actions.add_child(slot);
        }
        footer.add_child(actions);
        this.menu.addMenuItem(footer);
        if (hadFocus)
            this.menu.firstMenuItem?.grab_key_focus();
    }

    _renderDetails(state, record) {
        const focus = global.stage.get_key_focus();
        const focusName = focus && state.item.menu.box.contains(focus) ? focus.accessible_name : null;
        const menu = state.item.menu;
        // Clear the native parent-menu active chain before disposing a focused
        // descendant, then restore focus to its replacement below.
        if (focusName)
            state.item.grab_key_focus();
        menu.removeAll();
        state.activity = state.details = null;
        state.quotas = [];
        if (record) {
            for (const window of record.limits.windows) {
                const view = getQuotaPresentation(window);
                if (!view)
                    continue;
                const row = createDetailRow(view.name, view.value, {
                    style: 'usagebeam-limit-row', reset: view.reset,
                    icon: createSymbolicIcon(window.durationMinutes === 300 ? 'session' : 'weekly', this._extensionPath),
                });
                row.quotaWindow = window;
                state.quotas.push(row);
                menu.addMenuItem(row);
            }
            if (record.limits.status !== 'ready')
                this._addMessage(menu, record.limits.message || 'Account limits unavailable.');
            const overview = getHistoryOverview(record.history);
            if (overview) {
                const label = 'Activity (7d)';
                state.activity = new UsageBeamActivityItem(label, formatTokenCount(overview.total),
                    createSymbolicIcon('activity', this._extensionPath),
                    expanded => { this._setActivityExpanded(state, expanded); this.resize(); });
                menu.addMenuItem(state.activity);
                state.details = new PopupMenu.PopupMenuSection();
                state.details.box.add_style_class_name('usagebeam-model-details');
                menu.addMenuItem(state.details);
                if (record.history.message)
                    state.activity.accessible_name += `. ${record.history.message}`;
                for (const model of record.history.models) {
                    const name = formatModelName(model.model);
                    state.details.addMenuItem(createDetailRow(name, formatTokenCount(model.total), {
                        style: 'usagebeam-model-row',
                        icon: createSymbolicIcon('model', this._extensionPath),
                        description: `${name}, ${model.total} tokens. Input ${model.input}, output ${model.output}, cache read ${model.cacheRead}, cache write ${model.cacheWrite}.`,
                    }));
                }
                this._setActivityExpanded(state, state.activityExpanded);
            } else {
                state.activity = state.details = null;
                state.activityExpanded = false;
            }
            if (!overview && record.history.status !== 'ready')
                menu.addMenuItem(createDetailRow('Activity unavailable', '', {secondary: true,
                    description: record.history.message || 'No local activity is available yet.'}));
        } else {
            this._addMessage(menu, 'Checking usage…');
        }
        if (focusName) {
            const find = actor => actor.accessible_name === focusName ? actor :
                actor.get_children().map(find).find(Boolean);
            (find(menu.box) ?? state.activity ?? state.item).grab_key_focus();
        }
    }

    _addMessage(menu, text) {
        const row = createDetailRow(text, '', {secondary: true, style: 'usagebeam-message'});
        row.label.x_expand = true;
        row.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        row.label.clutter_text.line_wrap = true;
        row.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        menu.addMenuItem(row);
    }

    _setActivityExpanded(state, expanded) {
        state.activityExpanded = expanded;
        state.activity?.setExpanded(expanded);
        if (state.details)
            state.details.actor.visible = expanded;
    }

    resize() {
        if (!this.menu.isOpen)
            return;
        const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const states = [...this._providers.values()];
        const quotas = states.flatMap(state => state.quotas ?? []);
        for (const row of quotas)
            row.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const contentWidth = Math.max(0, ...states.flatMap(state =>
            [state.item, state.activity, ...(state.quotas ?? [])]).filter(Boolean).map(row => row.get_preferred_width(-1)[1]));
        const summaryWidth = Math.max(0, ...states.flatMap(state => [state.item, state.activity])
            .filter(Boolean).map(row => row.get_preferred_width(-1)[1]));
        const desiredWidth = Math.max(240, contentWidth / scale + 12);
        const width = Math.min(desiredWidth, Math.max(320, summaryWidth / scale + 32),
            Math.max(160, work.width / scale - 48));
        if (desiredWidth > width) {
            for (const row of quotas)
                row.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
        this.menu.box.style = `width: ${width}px;`;
        this.menu.actor.style = `max-height: ${Math.floor(work.height / scale - 16)}px;`;
        const submenus = [...this._providers.values()].map(state => state.item.menu.actor);
        const fixed = this.menu.box.get_children().filter(actor => !submenus.includes(actor))
            .reduce((height, actor) => height + actor.get_preferred_height(width * scale)[1], 0);
        const available = Math.max(60, Math.floor((work.height - fixed) / scale - 64));
        for (const actor of submenus) {
            actor.style = `max-height: ${available}px;`;
            actor.vscrollbar_policy = St.PolicyType.AUTOMATIC;
            actor.overlay_scrollbars = true;
        }
    }

    async _openTerminal() {
        const id = this._selectedProvider;
        if (!id)
            return;
        this.menu.close();
        try {
            await this._launchProvider(id);
        } catch (error) {
            if (!this._disposed)
                Main.notifyError(`Could not open ${PROVIDERS[id].name}`, error.message);
        }
    }
});
