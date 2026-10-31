import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {quotaSeverity} from '../core/thresholds.js';
import {PROVIDER_IDS, PROVIDERS} from '../core/providerRegistry.js';
import {getPanelQuota, getProviderStatus} from './presentation.js';
import {createLabel, createMetricLabel, createProviderIcon} from './widgets.js';

export const UsageBeamPanelReadout = GObject.registerClass(class UsageBeamPanelReadout extends St.Widget {
    _init(extensionPath) {
        super._init({style_class: 'usagebeam-panel-slot', layout_manager: new Clutter.BinLayout()});
        this._extensionPath = extensionPath;
        this.statusRow = new St.BoxLayout({style_class: 'usagebeam-panel-status',
            x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this.iconBin = new St.Bin({style_class: 'usagebeam-panel-icon-slot', y_align: Clutter.ActorAlign.CENTER});
        this.valueLabel = createMetricLabel('—', 'usagebeam-panel-value');
        for (const actor of [this.iconBin, this.valueLabel])
            this.statusRow.add_child(actor);
        this._providerId = null;
        // An invisible overlay reserves the widest supported readout. This keeps
        // the panel stable while allowing the configured system font to size
        // the indicator naturally instead of relying on a hard-coded width.
        // Center the visible row so unused reservation is shared by both ends.
        this._measurementActor = new St.Widget({
            opacity: 0,
            reactive: false,
            accessible_role: Atk.Role.REDUNDANT_OBJECT,
            layout_manager: new Clutter.BinLayout(),
        });
        this.add_child(this._measurementActor);
        this.add_child(this.statusRow);
    }

    update(enabledProviders, id, record, refreshing = false) {
        this._syncSizer(enabledProviders);
        const name = PROVIDERS[id]?.label ?? 'UsageBeam';
        if (this._providerId !== id) {
            this.iconBin.get_child()?.destroy();
            this.iconBin.set_child(createProviderIcon(id, this._extensionPath, 'usagebeam-panel-icon') ??
                createLabel(PROVIDERS[id]?.mark ?? 'AI', 'usagebeam-panel-mark'));
            this._providerId = id;
        }
        const quota = getPanelQuota(record);
        this.valueLabel.text = quota ? `${quota.percent}%` : '—';
        const severity = quotaSeverity(quota?.percent);
        const variant = Main.getStyleVariant();
        this.valueLabel.style_class = `usagebeam-metric usagebeam-panel-value${severity ? ` usagebeam-${severity}` : ''} usagebeam-${variant}`;
        const resetDescription = quota?.reset === 'due' ? ', reset due' :
            quota?.reset ? `, resets in ${quota.reset}` : '';
        const status = getProviderStatus(record, refreshing).toLowerCase();
        return `UsageBeam, ${name}, ${status}${quota ? `, ${quota.percent} percent used${resetDescription}` :
            ', usage unavailable'}`;
    }

    _syncSizer(enabled) {
        const providers = enabled.length ? enabled : PROVIDER_IDS;
        const key = providers.join('\u0000');
        if (this._measurementKey === key)
            return;
        this._measurementKey = key;
        this._measurementActor.destroy_all_children();
        for (const id of providers) {
            const sample = '999%';
            const row = new St.BoxLayout({style_class: 'usagebeam-panel-status'});
            const icon = new St.Bin({style_class: 'usagebeam-panel-icon-slot',
                y_align: Clutter.ActorAlign.CENTER});
            icon.set_child(createProviderIcon(id, this._extensionPath, 'usagebeam-panel-icon') ??
                createLabel(PROVIDERS[id]?.mark ?? 'AI', 'usagebeam-panel-mark'));
            for (const actor of [icon, createMetricLabel(sample, 'usagebeam-panel-value')])
                row.add_child(actor);
            this._measurementActor.add_child(row);
        }
    }

});
