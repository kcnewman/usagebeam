import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {formatModelName, formatTokenCount, formatUpdateAge} from '../core/format.js';
import {PROVIDERS} from '../core/providerRegistry.js';
import {UsageBeamPanelReadout} from './panelReadout.js';
import {createDetailRow, createIconAction, UsageBeamActivityItem} from './menuWidgets.js';
import {getHistoryOverview, getLatestUpdate, getPanelQuota, getProviderStatus, getQuotaPresentation} from './presentation.js';
import {createMetricLabel, createProviderIcon} from './widgets.js';

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
        St.ThemeContext.get_for_stage(global.stage).connectObject('changed', () => this.resize(), this);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this.render();
                this._service?.refreshAll();
            } else {
                for (const state of this._providers.values()) {
                    state.item.menu.close(false);
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
            state.item.accessible_name = `${PROVIDERS[id].name}, ${state.value.text}`;
            const key = JSON.stringify([current, busy]);
            if (state.recordKey !== key) {
                this._renderDetails(state, current, busy);
                state.recordKey = key;
            }
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
            const icon = createProviderIcon(id, this._extensionPath);
            item.icon.gicon = icon.gicon;
            icon.destroy();
            const value = createMetricLabel('—', 'usagebeam-provider-value');
            item.insert_child_below(value, item.get_last_child());
            this.menu.addMenuItem(item);
            const state = {id, item, value, activityExpanded: false};
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
        const actions = new St.BoxLayout({style_class: 'usagebeam-actions', x_expand: true,
            x_align: Clutter.ActorAlign.CENTER});
        this._refreshButton = createIconAction('view-refresh-symbolic', 'Refresh usage',
            () => this._service?.refreshAll(true));
        this._terminalButton = createIconAction('utilities-terminal-symbolic', 'Open provider in terminal',
            () => this._openTerminal());
        actions.add_child(this._refreshButton);
        actions.add_child(this._terminalButton);
        actions.add_child(createIconAction('preferences-system-symbolic', 'Open UsageBeam settings', () => {
            this.menu.close();
            this._openPreferences();
        }));
        footer.add_child(actions);
        this.menu.addMenuItem(footer);
        if (hadFocus)
            this.menu.firstMenuItem?.grab_key_focus();
    }

    _renderDetails(state, record, busy) {
        const focus = global.stage.get_key_focus();
        const focusName = focus && state.item.menu.box.contains(focus) ? focus.accessible_name : null;
        const menu = state.item.menu;
        // Clear the native parent-menu active chain before disposing a focused
        // descendant, then restore focus to its replacement below.
        if (focusName)
            state.item.grab_key_focus();
        menu.removeAll();
        state.activity = state.details = null;
        if (record) {
            for (const window of record.limits.windows) {
                const view = getQuotaPresentation(window);
                if (!view)
                    continue;
                menu.addMenuItem(createDetailRow(view.name, view.value, {style: 'usagebeam-limit-row'}));
                if (view.reset)
                    menu.addMenuItem(createDetailRow(view.reset, '', {secondary: true, style: 'usagebeam-reset-row'}));
            }
            if (record.limits.status !== 'ready')
                this._addMessage(menu, record.limits.message || 'Account limits unavailable.');
            const overview = getHistoryOverview(record.history);
            if (overview) {
                const label = `Activity · ${overview.days ?? 7}d ${overview.scope === 'local' ? 'local' : 'account'}`;
                state.activity = new UsageBeamActivityItem(label, formatTokenCount(overview.total),
                    expanded => { this._setActivityExpanded(state, expanded); this.resize(); });
                menu.addMenuItem(state.activity);
                state.details = new PopupMenu.PopupMenuSection();
                menu.addMenuItem(state.details);
                for (const model of record.history.models) {
                    const name = formatModelName(model.model);
                    state.details.addMenuItem(createDetailRow(name, formatTokenCount(model.total), {
                        style: 'usagebeam-model-row',
                        description: `${name}, ${model.total} tokens. Input ${model.input}, output ${model.output}, cache read ${model.cacheRead}, cache write ${model.cacheWrite}.`,
                    }));
                }
                if (record.history.days.length) {
                    state.details.addMenuItem(createDetailRow('Daily activity', '', {secondary: true}));
                    for (const day of record.history.days) {
                        const date = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
                        state.details.addMenuItem(createDetailRow(date, formatTokenCount(day.total), {
                            style: 'usagebeam-day-row', description: `${day.date}, ${day.total} ${overview.scope} tokens`,
                        }));
                    }
                }
                this._setActivityExpanded(state, state.activityExpanded);
            } else {
                state.activity = state.details = null;
                state.activityExpanded = false;
            }
            if (record.history.message && record.history.status !== 'ready')
                this._addMessage(menu, record.history.message);
        } else {
            this._addMessage(menu, 'Checking usage…');
        }
        const status = getProviderStatus(record, busy);
        menu.addMenuItem(createDetailRow(`${status}${record?.plan ? ` · ${record.plan}` : ''} · ${formatUpdateAge(getLatestUpdate(record))}`,
            '', {secondary: true, style: 'usagebeam-freshness'}));
        if (focusName) {
            const find = actor => actor.accessible_name === focusName ? actor :
                actor.get_children().map(find).find(Boolean);
            (find(menu.box) ?? state.activity ?? state.item).grab_key_focus();
        }
    }

    _addMessage(menu, text) {
        const row = createDetailRow(text, '', {secondary: true, style: 'usagebeam-message'});
        row.label.clutter_text.line_wrap = true;
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
        const width = Math.min(300, Math.max(160, work.width / scale - 48));
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
