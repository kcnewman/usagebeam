import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {PROVIDER_IDS, PROVIDER_NAMES, getEnabledProviders, normalizeProviderOrder} from '../core/providerRegistry.js';
import {formatUpdateAge} from '../core/format.js';
import {notificationMilestones} from '../core/thresholds.js';
import {getLatestUpdate} from './presentation.js';

function describeSection(section, readyText) {
    return section?.message || ({ready: readyText, partial: 'Incomplete', stale: 'Cached',
        'missing-auth': 'Sign-in required', unsupported: 'Not supported',
        loading: 'Checking usage', unavailable: 'Unavailable'})[section?.status] || 'No saved usage';
}

function bindChoice(settings, key, row, choices, signals) {
    let syncing = false;
    const sync = () => {
        syncing = true;
        row.selected = Math.max(0, choices.indexOf(settings.get_string(key)));
        syncing = false;
    };
    row.connect('notify::selected', () => {
        if (!syncing && choices[row.selected] !== undefined)
            settings.set_string(key, choices[row.selected]);
    });
    signals.push(settings.connect(`changed::${key}`, sync));
    sync();
}

function buildProviderGroup(page, settings, signals) {
    const group = new Adw.PreferencesGroup({title: 'Providers',
        description: 'Use providers signed in through their CLI on this device.'});
    page.add(group);
    let syncing = false;
    const rows = PROVIDER_IDS.map(id => {
        const row = new Adw.SwitchRow({title: PROVIDER_NAMES[id]});
        row.connect('notify::active', () => {
            if (syncing)
                return;
            const selected = new Set(settings.get_strv('enabled-providers'));
            if (row.active)
                selected.add(id);
            else
                selected.delete(id);
            const enabled = getEnabledProviders([...selected], settings.get_strv('provider-order'));
            if (enabled.length && !selected.has(settings.get_string('default-provider')))
                settings.set_string('default-provider', enabled[0]);
            settings.set_strv('enabled-providers', enabled);
        });
        group.add(row);
        return {id, row};
    });
    const orderRow = new Adw.ComboRow({title: 'Menu order',
        model: Gtk.StringList.new(['Codex first', 'Claude Code first'])});
    group.add(orderRow);
    orderRow.connect('notify::selected', () => {
        if (!syncing)
            settings.set_strv('provider-order', orderRow.selected === 0 ? ['codex', 'claude'] : ['claude', 'codex']);
    });
    const sync = () => {
        syncing = true;
        const enabled = new Set(settings.get_strv('enabled-providers'));
        for (const {id, row} of rows)
            row.active = enabled.has(id);
        orderRow.selected = normalizeProviderOrder(settings.get_strv('provider-order'))[0] === 'codex' ? 0 : 1;
        orderRow.visible = enabled.size > 1;
        syncing = false;
    };
    for (const key of ['enabled-providers', 'provider-order'])
        signals.push(settings.connect(`changed::${key}`, sync));
    sync();
}

function buildPanelGroup(page, settings, signals) {
    const group = new Adw.PreferencesGroup({title: 'Panel &amp; updates'});
    page.add(group);
    const position = new Adw.ComboRow({title: 'Panel position', model: Gtk.StringList.new(['Left', 'Right'])});
    bindChoice(settings, 'panel-position', position, ['left', 'right'], signals);
    group.add(position);
    const provider = new Adw.ComboRow({title: 'Panel provider', subtitle: 'Also used by the terminal shortcut'});
    group.add(provider);
    let syncing = false;
    const enabled = () => getEnabledProviders(settings.get_strv('enabled-providers'), settings.get_strv('provider-order'));
    const sync = () => {
        syncing = true;
        const providers = enabled();
        provider.model = Gtk.StringList.new(providers.length
            ? providers.map(id => PROVIDER_NAMES[id]) : ['No providers enabled']);
        provider.sensitive = providers.length > 0;
        provider.selected = Math.max(0, providers.indexOf(settings.get_string('default-provider')));
        syncing = false;
    };
    provider.connect('notify::selected', () => {
        if (!syncing && enabled()[provider.selected])
            settings.set_string('default-provider', enabled()[provider.selected]);
    });
    for (const key of ['enabled-providers', 'provider-order', 'default-provider'])
        signals.push(settings.connect(`changed::${key}`, sync));
    sync();
    const interval = new Adw.SpinRow({title: 'Refresh interval', subtitle: 'Seconds between usage checks',
        adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 10, page_increment: 60})});
    settings.bind('refresh-interval', interval, 'value', 0);
    group.add(interval);
}

function buildAlertsGroup(page, settings, signals) {
    const group = new Adw.PreferencesGroup({title: 'Alerts'});
    page.add(group);
    const alerts = new Adw.SwitchRow({title: 'Usage alerts', subtitle: 'Once per milestone in each limit period'});
    settings.bind('notifications-enabled', alerts, 'active', 0);
    group.add(alerts);
    const threshold = new Adw.SpinRow({title: 'First alert (%)',
        adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5, page_increment: 10})});
    settings.bind('notification-threshold', threshold, 'value', 0);
    settings.bind('notifications-enabled', threshold, 'sensitive', 0);
    const sync = () => {
        const next = notificationMilestones(settings.get_int('notification-threshold')).slice(1);
        threshold.subtitle = next.length ? `Then at ${next.map(value => `${value}%`).join(', ')}.` : 'At the limit only.';
    };
    signals.push(settings.connect('changed::notification-threshold', sync));
    sync();
    group.add(threshold);
}

function buildDataGroup(page, window, settings, clearData) {
    const group = new Adw.PreferencesGroup({title: 'Saved data'});
    page.add(group);
    const retention = new Adw.SpinRow({title: 'Retention (days)',
        subtitle: 'Local metadata only. Activity always shows the past 7 days.',
        adjustment: new Gtk.Adjustment({lower: 7, upper: 90, step_increment: 1, page_increment: 7})});
    settings.bind('history-retention-days', retention, 'value', 0);
    group.add(retention);
    const clear = new Adw.ActionRow({title: 'Clear saved usage', subtitle: 'Provider history and sign-in are kept'});
    const button = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
    button.connect('clicked', () => {
        const dialog = new Adw.AlertDialog({heading: 'Clear saved usage?',
            body: 'Remove UsageBeam snapshots and local metadata. Usage rebuilds on the next refresh.'});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('clear', 'Clear');
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'clear')
                return;
            const removed = clearData();
            settings.set_uint('clear-data-generation', (settings.get_uint('clear-data-generation') + 1) >>> 0);
            window.add_toast(new Adw.Toast({title: removed ? 'Saved usage cleared' : 'No saved usage to clear'}));
        });
        dialog.present(window);
    });
    clear.add_suffix(button);
    group.add(clear);
}

function buildUsageDetails(page, settings, signals, readRecord) {
    const group = new Adw.PreferencesGroup({title: 'Provider status',
        description: 'Saved results. Refresh usage from the panel for new data.'});
    page.add(group);
    let rows = [];
    const render = () => {
        const expanded = new Set(rows.filter(row => row.expanded).map(row => row.title));
        rows.forEach(row => group.remove(row));
        rows = getEnabledProviders(settings.get_strv('enabled-providers'), settings.get_strv('provider-order')).map(id => {
            const record = readRecord(id);
            const row = new Adw.ExpanderRow({title: PROVIDER_NAMES[id],
                subtitle: record ? formatUpdateAge(getLatestUpdate(record)) : 'No saved usage',
                expanded: expanded.has(PROVIDER_NAMES[id])});
            if (record?.plan)
                row.add_row(new Adw.ActionRow({title: 'Plan', subtitle: record.plan}));
            row.add_row(new Adw.ActionRow({title: 'Account limits',
                subtitle: describeSection(record?.limits, 'Available')}));
            row.add_row(new Adw.ActionRow({title: 'Local activity',
                subtitle: describeSection(record?.history, 'Past 7 days on this device')}));
            group.add(row);
            return row;
        });
        if (!rows.length) {
            const empty = new Adw.ActionRow({title: 'No providers enabled', subtitle: 'Enable a provider in General.'});
            group.add(empty);
            rows.push(empty);
        }
    };
    const reload = new Gtk.Button({label: 'Reload', valign: Gtk.Align.CENTER, tooltip_text: 'Reload saved results'});
    reload.connect('clicked', render);
    group.set_header_suffix(reload);
    for (const key of ['enabled-providers', 'provider-order', 'clear-data-generation'])
        signals.push(settings.connect(`changed::${key}`, render));
    render();
}

export function buildPreferencesWindow(window, settings, clearData, readRecord = () => null) {
    window.set_default_size(620, 740);
    window.search_enabled = true;
    const general = new Adw.PreferencesPage({name: 'general', title: 'General', icon_name: 'preferences-system-symbolic'});
    const details = new Adw.PreferencesPage({name: 'details', title: 'Usage details', icon_name: 'dialog-information-symbolic'});
    const signals = [];
    buildProviderGroup(general, settings, signals);
    buildPanelGroup(general, settings, signals);
    buildAlertsGroup(general, settings, signals);
    buildUsageDetails(details, settings, signals, readRecord);
    buildDataGroup(details, window, settings, clearData);
    window.add(general);
    window.add(details);
    window.connect('close-request', () => {
        signals.splice(0).forEach(id => settings.disconnect(id));
        return false;
    });
    return {general, details};
}
