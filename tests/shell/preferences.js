// Builds the packaged preferences UI against an isolated in-memory schema.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

const assert = (condition, message) => {
    if (!condition)
        throw new Error(message);
};

function descendants(widget) {
    const values = [widget];
    for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling())
        values.push(...descendants(child));
    return values;
}

Gtk.init();
Adw.init();
const extensionPath = GLib.getenv('USAGEBEAM_INSTALL_PATH');
assert(extensionPath, 'Preferences smoke test requires the packaged extension path');
const moduleUri = Gio.File.new_for_path(`${extensionPath}/src/ui/preferences.js`).get_uri();
const {buildPreferencesWindow} = await import(moduleUri);
const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.usagebeam'});
const window = new Adw.PreferencesWindow();
const warning = 'Some local records could not be read. Totals may be incomplete.';
let clears = 0;
const {general, details} = buildPreferencesWindow(window, settings, () => { clears++; return 1; }, () => ({plan: 'Plus',
    limits: {status: 'ready', updatedAt: Date.now()},
    history: {status: 'partial', updatedAt: Date.now(), message: warning}}));

const allWidgets = () => [...descendants(general), ...descendants(details)];
let widgets = allWidgets();
assert(widgets.some(widget => widget instanceof Adw.ActionRow && widget.subtitle === warning),
    'Settings must retain the incomplete-record warning removed from the popup');
assert(widgets.filter(widget => widget instanceof Adw.SwitchRow).length === 3,
    'Preferences must expose two providers and notification control');
const position = widgets.find(widget => widget instanceof Adw.ComboRow && widget.title === 'Panel position');
assert(position.model.get_n_items() === 2, 'Preferences must expose left and right panel areas only');
assert(widgets.filter(widget => widget instanceof Adw.SpinRow).length === 3,
    'Preferences must expose refresh, warning and retention controls');

settings.set_strv('provider-order', ['claude', 'codex']);
settings.set_strv('enabled-providers', ['claude']);
while (GLib.MainContext.default().iteration(false));
widgets = allWidgets();
const providers = widgets.filter(widget => widget instanceof Adw.SwitchRow &&
    ['Claude Code', 'Codex'].includes(widget.title));
const order = widgets.find(widget => widget instanceof Adw.ComboRow && widget.title === 'Menu order');
assert(order.selected === 1 && !order.visible, 'Menu ordering must follow settings and hide for a single provider');
const selected = widgets.find(widget => widget instanceof Adw.ComboRow && widget.title === 'Panel provider');
assert(selected?.model?.get_n_items() === 1, 'Panel provider must include enabled providers only');

settings.set_strv('enabled-providers', []);
assert(!selected.sensitive, 'Empty providers must disable panel selection');
assert(descendants(details).some(widget => widget instanceof Adw.ActionRow && widget.title === 'No providers enabled'),
    'Empty provider diagnostics are missing');
providers.find(row => row.title === 'Codex').active = true;
assert(settings.get_string('default-provider') === 'codex' && settings.get_strv('enabled-providers').join() === 'codex',
    'Enabling a provider must restore a valid panel selection');
providers.find(row => row.title === 'Claude Code').active = true;
order.selected = 0;
assert(settings.get_strv('provider-order').join() === 'codex,claude', 'Menu order does not persist');
selected.selected = 1;
assert(settings.get_string('default-provider') === 'claude', 'Panel selection does not persist');
position.selected = 0;
assert(settings.get_string('panel-position') === 'left', 'Panel position does not persist');
const threshold = widgets.find(widget => widget instanceof Adw.SpinRow && widget.title === 'First alert (%)');
settings.set_boolean('notifications-enabled', false);
assert(!threshold.sensitive, 'Disabled alerts must disable the threshold');
settings.set_boolean('notifications-enabled', true);
threshold.value = 50;
assert(settings.get_int('notification-threshold') === 50 && threshold.subtitle === 'Then at 80%, 90%, 100%.',
    'Alert description must match the actual milestones');
threshold.value = 100;
assert(threshold.subtitle === 'At the limit only.', 'Full-limit alerts have incorrect follow-up text');
threshold.value = 90;

const wait = milliseconds => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
async function capture(name) {
    await wait(350);
    const snapshot = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({widget: window}).snapshot(snapshot, window.get_width(), window.get_height());
    const texture = window.get_renderer().render_texture(snapshot.to_node(), null);
    texture.save_to_png(`${GLib.getenv('USAGEBEAM_TEST_OUTPUT')}/settings-${name}.png`);
}
window.present();
await capture('general');
window.set_visible_page(details);
descendants(details).find(widget => widget instanceof Adw.ExpanderRow).expanded = true;
await capture('details');
const clear = descendants(details).find(widget => widget instanceof Gtk.Button && widget.label === 'Clear…');
const generation = settings.get_uint('clear-data-generation');
clear.emit('clicked');
const dialog = window.get_visible_dialog();
assert(dialog instanceof Adw.AlertDialog, 'Clearing data must require confirmation');
dialog.emit('response', 'cancel');
dialog.close();
assert(clears === 0 && settings.get_uint('clear-data-generation') === generation, 'Cancel clears saved data');
await wait(300);
clear.emit('clicked');
window.get_visible_dialog().emit('response', 'clear');
window.get_visible_dialog().close();
assert(clears === 1 && settings.get_uint('clear-data-generation') === generation + 1, 'Confirmed clear does not invalidate saved usage');

window.close();
print('PASS: packaged preferences construct and react to provider settings');
