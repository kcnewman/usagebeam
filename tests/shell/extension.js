// Loaded only in the isolated synthetic desktop, never in the release archive.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {runStress} from './stress.js';

const UUID = 'usagebeam@oo7kc.github.io';
const NO_ANIMATION = Number(Config.PACKAGE_VERSION.split('.')[0]) >= 51 ? {animate: false} : 0;
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
            if (['product', 'collapsed', 'activity', 'single-provider'].includes(name) || name.startsWith('panel-') || name === 'notification') {
                const indicator = Main.panel.statusArea[UUID];
                const box = bounds(name === 'notification' ? Main.messageTray._banner :
                    name.startsWith('panel-') ? indicator : indicator.menu.actor);
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
                if (records[provider].limits.windows[0].usedPercent < 80)
                    assert(value.get_theme_node().get_foreground_color().to_string() === color, 'Normal panel usage overrides native color');
                assert(!value.clutter_text.get_layout().is_ellipsized(), 'Panel metric clips');
            }
        }
        settings.set_string('default-provider', 'codex');
        indicator.menu.open(NO_ANIMATION);
        await this._wait();
        assert([...indicator._providers.keys()].join(',') === 'codex,claude', 'Provider rows do not match the enabled list');
        assert([...indicator._providers.values()].every(state => !state.item.menu.isOpen), 'Menu opens expanded');
        assert(matching(indicator.menu.box, 'usagebeam-icon-action').length === 3, 'Footer must contain three actions');
        const collapsed = bounds(indicator.menu.actor);
        for (const [id, state] of indicator._providers) {
            assert(state.reset.visible && state.reset.label.text.length > 0,
                `${id}: first popup omits the reset countdown`);
            const timer = bounds(state.reset);
            const metric = bounds(state.value);
            assert(timer.x + timer.width <= metric.x && metric.x + metric.width <= collapsed.x + collapsed.width,
                `${id}: summary timer crowds the percentage or leaves the popup`);
        }
        await this._screenshot('collapsed');
        service.enabledProviders = ['codex'];
        indicator.render();
        await this._wait();
        await this._screenshot('single-provider');
        service.enabledProviders = ['codex', 'claude'];
        indicator.render();
        await this._wait();
        const codex = indicator._providers.get('codex');
        const claude = indicator._providers.get('claude');
        codex.item.activate();
        await this._wait(350);
        assert(codex.item.menu.isOpen, 'Provider does not expand');
        assert(!codex.details.actor.visible, 'Activity opens expanded');
        assert(codex.reset.label.text === codex.quotas[0].resetLabel.text,
            'Summary countdown does not match the displayed quota window');
        const realNow = Date.now;
        const originalCountdown = codex.quotas[0].resetLabel.text;
        try {
            Date.now = () => realNow() + 600000;
            indicator.render();
            assert(codex.reset.label.text === codex.quotas[0].resetLabel.text &&
                codex.quotas[0].resetLabel.text !== originalCountdown,
            'Unchanged records leave quota countdowns stale');
        } finally {
            Date.now = realNow;
            indicator.render();
        }
        assert(matching(indicator.menu.box, 'usagebeam-freshness').length === 0 &&
            matching(indicator.menu.box, 'usagebeam-activity-source').length === 0,
        'Diagnostic metadata still clutters the popup');
        const firstPopup = bounds(indicator.menu.actor);
        for (const row of matching(codex.item.menu.box, 'usagebeam-limit-row')) {
            const value = bounds(row.valueLabel);
            assert(value.x + value.width <= firstPopup.x + firstPopup.width,
                `Collapsed quota value leaves popup: ${JSON.stringify({value, firstPopup})}`);
        }
        await this._screenshot('product');
        codex.activity.activate();
        await this._wait();
        assert(codex.item.menu.isOpen && codex.details.actor.visible, 'Activity closes its provider');
        const keyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        codex.activity.grab_key_focus();
        const pressKey = async symbol => {
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
            await this._wait();
        };
        await pressKey(Clutter.KEY_Left);
        assert(codex.item.menu.isOpen && !codex.details.actor.visible, 'Left arrow does not collapse Activity');
        await pressKey(Clutter.KEY_Right);
        assert(codex.item.menu.isOpen && codex.details.actor.visible, 'Right arrow does not expand Activity');
        assert(matching(codex.details.box, 'usagebeam-model-row').length === 3, 'Missing model rows');
        assert(matching(codex.details.box, 'usagebeam-day-row').length === 0, 'Daily rows remain in the compact activity view');
        assert(codex.activity.accessible_name.startsWith('Activity (7d)'), 'Activity period is unclear');
        assert(!codex.activity.label.clutter_text.get_layout().is_ellipsized(), 'Activity title is clipped');
        const quotaRows = matching(codex.item.menu.box, 'usagebeam-limit-row');
        const values = [...quotaRows.map(row => row.valueLabel),
            ...matching(codex.details.box, 'usagebeam-model-row').map(row => row.valueLabel)];
        const rightEdges = values.map(actor => { const box = bounds(actor); return box.x + box.width; });
        assert(Math.max(...rightEdges) - Math.min(...rightEdges) <= 1,
            `Plain rows do not align to their own container: ${JSON.stringify(rightEdges)}`);
        for (const row of [...quotaRows, ...matching(codex.details.box, 'usagebeam-model-row')]) {
            const container = bounds(row);
            const value = bounds(row.valueLabel);
            const inset = row.get_theme_node().get_padding(St.Side.RIGHT) + row.get_theme_node().get_border_width(St.Side.RIGHT);
            assert(Math.abs(container.x + container.width - inset - value.x - value.width) <= 1,
                'Plain metric reserves an invisible disclosure gutter');
        }
        for (const [row, value, arrow] of [[codex.item, codex.value, codex.item.get_last_child()],
            [codex.activity, codex.activity.valueLabel, codex.activity._arrow]]) {
            const metric = bounds(value);
            assert(bounds(arrow).x - metric.x - metric.width <= 8 * scale,
                'Disclosure is too far from its value');
            assert(bounds(row).x + bounds(row).width - metric.x - metric.width > 12 * scale,
                'Expandable metric does not reserve its disclosure');
        }
        assert(matching(codex.details.box, 'usagebeam-token-scope').length === 0,
            'Activity includes a redundant scope heading');
        const actions = matching(indicator.menu.box, 'usagebeam-actions')[0];
        const slots = actions.get_children().map(bounds);
        assert(Math.max(...slots.map(slot => slot.width)) - Math.min(...slots.map(slot => slot.width)) <= 1,
            'Footer action slots do not share the available width');
        assert(quotaRows.every(row => row.resetLabel && !row.accessible_name.includes('Resets in') &&
            Math.abs(bounds(row.label).y - bounds(row.resetLabel).y) <= 1),
        'Quota title and countdown must share one row without reset prose');
        assert(quotaRows.every(row => row.label.clutter_text.get_preferred_width(-1)[1] <= row.label.width + 1),
            'Short quota headings are clipped');
        for (const row of quotaRows) {
            const label = bounds(row.label);
            assert(bounds(row.resetLabel).x - label.x - label.width <= 9 * scale,
                'Countdown does not immediately follow its heading');
        }
        const highlightedModel = matching(codex.details.box, 'usagebeam-model-row')[0];
        highlightedModel.add_style_pseudo_class('hover');
        await this._wait();
        await this._screenshot('activity');
        highlightedModel.remove_style_pseudo_class('hover');
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
            const shortest = records.codex.limits.windows[0];
            const originalPercent = shortest.usedPercent;
            const severityColors = [];
            for (const [percent, severity] of [[0, null], [80, 'caution'], [90, 'warning'], [100, 'danger']]) {
                shortest.usedPercent = percent;
                indicator.render();
                await this._wait(30);
                const value = indicator._panelReadout.valueLabel;
                if (severity)
                    assert(value.has_style_class_name(`usagebeam-${severity}`), 'Panel severity threshold is incorrect');
                severityColors.push(value.get_theme_node().get_foreground_color().to_string());
                await this._screenshot(`panel-${variant}-${percent}`);
            }
            assert(new Set(severityColors).size === 4, `${variant}: usage alert colors do not change`);
            shortest.usedPercent = originalPercent;
            indicator.render();
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
        indicator.menu.open(NO_ANIMATION);
        await this._wait();
        assert([...indicator._providers.values()].every(state => !state.item.menu.isOpen), 'Reopening retains expanded providers');
        assert(settings.get_string('default-provider') === 'claude', 'Closing loses provider selection');
        indicator.menu.close(NO_ANIMATION);
        const notifications = Main.extensionManager.lookup(UUID).stateObj._notifications;
        const tray = Main.messageTray;
        const waitForBanner = async matches => {
            // Other desktop sources may already have a banner in the native queue.
            // Keep the private seat active so those banners can expire normally.
            for (let attempt = 0; attempt < 100 && !matches(tray._notification); attempt++)
                await pressKey(Clutter.KEY_Control_L);
            assert(matches(tray._notification), 'Expected notification did not reach the native banner');
            await this._wait(350);
        };
        notifications.show([{provider: 'Codex', label: '5h Session', threshold: 100}]);
        await waitForBanner(notification => notification?.source === notifications._source);
        const notification = tray._notification;
        assert(notification?.source === notifications._source, 'Usage notification was not displayed');
        assert(tray._banner.has_style_class_name('usagebeam-toast'), 'Usage toast keeps the large default size');
        const remaining = GLib.MainContext.default().find_source_by_id(tray._notificationTimeoutId).get_ready_time() - GLib.get_monotonic_time();
        assert(remaining > 7_000_000 && remaining <= 8_000_000, 'Usage toast did not receive its extended display time');
        assert(notification.title === 'Codex' && notification.body === '5h Session 100%',
            'Usage toast contains verbose text');
        await this._screenshot('notification');
        notification.destroy();
        assert(notifications._timers.size === 0, 'Dismissed notification retains a timer');
        await this._wait(300);
        Main.notify('Other application', 'Unaffected notification');
        await waitForBanner(notification => notification?.title === 'Other application');
        assert(!tray._banner.has_style_class_name('usagebeam-toast'), 'Usage toast styling leaks to other sources');
        tray._notification.destroy();
        await this._wait(300);
        notifications.show([{provider: 'Claude Code', label: 'Weekly', threshold: 90}]);
        notifications.destroy();
        assert(notifications._timers.size === 0 && !notifications._source,
            'Notification shutdown leaves a source or timer');
        indicator.menu.open(NO_ANIMATION);
        await this._wait();
        const stress = GLib.getenv('USAGEBEAM_STRESS') === '1';
        const results = await runStress({indicator, records, service, settings, assert,
            wait: value => this._wait(value), screenshot: name => this._screenshot(name),
            animation: NO_ANIMATION, cycles: stress ? 100 : 10});
        indicator.menu.close(NO_ANIMATION);
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
