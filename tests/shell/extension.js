// Loaded only in the isolated synthetic desktop, never in the release archive.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {runStress} from './stress.js';

const UUID = 'usagebeam@oo7kc.github.io';
const descendants = actor => [actor, ...actor.get_children().flatMap(descendants)];
const matching = (actor, style) => descendants(actor).filter(child => child.has_style_class_name?.(style));
const bounds = actor => {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export default class UsageBeamUITest extends Extension {
    enable() {
        this._timers = new Map();
        this._output = GLib.getenv('USAGEBEAM_TEST_OUTPUT');
        assert(this._output, 'UI checks require a private output directory');
        this._run().then(result => this._save({ok: true, ...result})).catch(async error => {
            await this._screenshot('failure');
            this._save({ok: false, error: `${error}\n${error.stack ?? ''}`});
        });
    }

    _save(result) {
        GLib.file_set_contents(`${this._output}/ui-results.json`, JSON.stringify(result, null, 2));
    }

    _wait(milliseconds = 150) {
        return new Promise((resolve, reject) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
                this._timers.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.set(id, reject);
        });
    }

    async _screenshot(name) {
        const file = Gio.File.new_for_path(`${this._output}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        try {
            if (name === 'product') {
                const box = bounds(Main.panel.statusArea[UUID].menu.actor);
                await new Shell.Screenshot().screenshot_area(Math.floor(box.x), Math.floor(box.y),
                    Math.ceil(box.width), Math.ceil(box.height), stream);
            } else {
                await new Shell.Screenshot().screenshot(false, stream);
            }
        } finally { stream.close(null); }
    }

    _displayCall(method, parameters = null) {
        return new Promise((resolve, reject) => Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', method,
            parameters, null, Gio.DBusCallFlags.NONE, 5000, null, (connection, result) => {
                try { resolve(connection.call_finish(result).deep_unpack()); } catch (error) { reject(error); }
            }));
    }

    async _run() {
        let indicator;
        for (let attempt = 0; attempt < 80 && !indicator; attempt++) {
            await this._wait();
            indicator = Main.panel.statusArea[UUID];
        }
        assert(indicator, 'UsageBeam did not load');
        indicator._service.destroy();
        const [, fixture] = GLib.file_get_contents(`${this._output}/ui-fixtures.json`);
        const records = JSON.parse(new TextDecoder().decode(fixture));
        let refreshing = false;
        let forcedRefresh = false;
        const service = {enabledProviders: ['codex', 'claude'], recordFor: id => records[id],
            isRefreshing: () => refreshing, refreshAll: force => { forcedRefresh = force; }};
        indicator.attach(service);
        const settings = indicator._settings;
        Main.overview.hide();
        const scale = Number(GLib.getenv('USAGEBEAM_TEST_SCALE') ?? 1);
        if (scale !== 1 || GLib.getenv('USAGEBEAM_SECONDARY_MONITOR') === '1') {
            const [serial, monitors] = await this._displayCall('GetCurrentState');
            let x = 0;
            const configuration = monitors.map(([[connector], modes], index) => {
                const [mode, width] = modes.find(item => item[5].includes(scale)) ?? [];
                assert(mode, `Unsupported virtual scale ${scale}`);
                const entry = [x, 0, scale, 0, index === monitors.length - 1, [[connector, mode, {}]]];
                x += Math.round(width / scale);
                return entry;
            });
            await this._displayCall('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
                [serial, 1, configuration, {}]));
        }
        await this._wait(500);
        const calendar = Main.panel.statusArea.dateMenu.container;
        for (const position of ['left', 'right']) {
            settings.set_string('panel-position', position);
            await this._wait();
            assert(indicator.container.get_parent() === (position === 'left' ? Main.panel._leftBox : Main.panel._rightBox),
                `${position}: wrong panel area`);
            const clock = bounds(calendar);
            const slot = bounds(indicator.container);
            for (const provider of ['codex', 'claude']) {
                settings.set_string('default-provider', provider);
                await this._wait();
                assert(Math.abs(bounds(calendar).x - clock.x) <= 1, 'Provider changes move the calendar');
                assert(Math.abs(bounds(indicator.container).width - slot.width) <= 1, 'Provider changes resize the panel slot');
                const value = indicator._panelReadout.valueLabel;
                const color = indicator.get_theme_node().get_foreground_color().to_string();
                assert(value.get_theme_node().get_foreground_color().to_string() === color, 'Panel metric overrides native color');
                assert(!value.clutter_text.get_layout().is_ellipsized(), 'Panel metric clips');
            }
        }
        settings.set_string('default-provider', 'codex');
        indicator.menu.open(0);
        await this._wait();
        assert([...indicator._providers.keys()].join(',') === 'codex,claude', 'Provider rows do not match the enabled list');
        assert([...indicator._providers.values()].every(state => !state.item.menu.isOpen), 'Menu opens expanded');
        assert(matching(indicator.menu.box, 'usagebeam-icon-action').length === 3, 'Footer must contain three actions');
        const collapsed = bounds(indicator.menu.actor);
        assert(collapsed.width / St.ThemeContext.get_for_stage(global.stage).scale_factor <= 380, 'Popup is too wide');
        await this._screenshot('collapsed');
        const codex = indicator._providers.get('codex');
        const claude = indicator._providers.get('claude');
        codex.item.activate();
        await this._wait(350);
        assert(codex.item.menu.isOpen, 'Provider does not expand');
        assert(!codex.details.actor.visible, 'Activity opens expanded');
        await this._screenshot('product');
        codex.activity.activate();
        await this._wait();
        assert(codex.item.menu.isOpen && codex.details.actor.visible, 'Activity closes its provider');
        assert(matching(codex.details.box, 'usagebeam-model-row').length === 3, 'Missing model rows');
        assert(matching(codex.details.box, 'usagebeam-day-row').length === 7, 'Missing daily rows');
        codex.activity.grab_key_focus();
        records.codex.history.updatedAt++;
        indicator.render();
        await this._wait();
        assert(codex.activity.has_key_focus() && codex.details.actor.visible, 'Refresh loses activity focus or expansion');
        const count = descendants(indicator.menu.box).length;
        for (let iteration = 0; iteration < 30; iteration++)
            indicator.render();
        assert(descendants(indicator.menu.box).length === count, 'Refresh grows the actor tree');
        const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const originalScheme = interfaceSettings.get_string('color-scheme');
        for (const variant of ['dark', 'light']) {
            interfaceSettings.set_string('color-scheme', `prefer-${variant}`);
            await this._wait(300);
            const reference = new St.Widget({style_class: 'popup-menu panel-menu', visible: false});
            const surface = new St.BoxLayout({style_class: 'popup-menu-content'});
            reference.add_child(surface);
            Main.uiGroup.add_child(reference);
            const actual = indicator.menu.box.get_theme_node();
            const expected = surface.get_theme_node();
            assert(actual.get_background_color().to_string() === expected.get_background_color().to_string(), 'Popup overrides native surface');
            assert(actual.get_foreground_color().to_string() === expected.get_foreground_color().to_string(), 'Popup overrides native foreground');
            const font = codex.item.label.get_theme_node().get_font();
            assert(font.get_family().includes(GLib.getenv('USAGEBEAM_EXPECTED_FONT')), 'System font is overridden');
            assert(font.get_size() === expected.get_font().get_size(), 'Native font size is overridden');
            await this._screenshot(`expanded-${variant}`);
            reference.destroy();
        }
        interfaceSettings.set_string('color-scheme', originalScheme);
        claude.item.activate();
        await this._wait(350);
        assert(claude.item.menu.isOpen && !codex.item.menu.isOpen, 'Accordion has multiple open providers');
        assert(settings.get_string('default-provider') === 'claude', 'Expansion does not select provider');
        assert(indicator._terminalButton.accessible_name === 'Open Claude Code in terminal', 'Launcher target is unclear');
        indicator._refreshButton.emit('clicked', 1);
        assert(forcedRefresh === true, 'Refresh does not force a refresh');
        refreshing = true;
        indicator.render();
        assert(!indicator._refreshButton.reactive, 'Refresh remains active while collecting');
        refreshing = false;
        indicator.render();
        let launched = null;
        indicator._launchProvider = async id => { launched = id; };
        indicator._terminalButton.emit('clicked', 1);
        await this._wait();
        assert(launched === 'claude' && !indicator.menu.isOpen, 'Terminal does not launch selected provider and close menu');
        indicator.menu.open(0);
        await this._wait();
        assert([...indicator._providers.values()].every(state => !state.item.menu.isOpen), 'Reopening retains expanded providers');
        assert(settings.get_string('default-provider') === 'claude', 'Closing loses provider selection');
        const stress = GLib.getenv('USAGEBEAM_STRESS') === '1';
        const results = await runStress({indicator, records, service, settings, assert,
            wait: value => this._wait(value), screenshot: name => this._screenshot(name), cycles: stress ? 100 : 10});
        indicator.menu.close(0);
        return {collapsed, scale, ...results};
    }

    disable() {
        for (const [id, reject] of this._timers) {
            GLib.source_remove(id);
            reject(new Error('UI check disabled before completion'));
        }
        this._timers.clear();
    }
}
