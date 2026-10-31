import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {UsageBeamIndicator} from './src/ui/indicator.js';
import {UsageNotifications} from './src/ui/usageNotifications.js';
import {placeIndicator} from './src/ui/panelPlacement.js';
import {normalizeSettings} from './src/services/settings.js';
import {UsageService} from './src/services/usageService.js';
import {launchProviderTerminal} from './src/services/terminalLauncher.js';

export default class UsageBeamExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        normalizeSettings(this._settings);
        this._indicator = new UsageBeamIndicator(this._settings, this.path, () => this.openPreferences(),
            id => launchProviderTerminal(id));
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._placeIndicator();
        this._notifications = new UsageNotifications();
        this._service = new UsageService({
            settings: this._settings,
            extensionPath: this.path,
            onChanged: () => this._indicator?.render(),
            onAlerts: alerts => this._notifications?.show(alerts),
        });
        this._indicator.attach(this._service);
        this._settingsIds = [];
        const configureProviders = () => {
            this._service.configure();
            this._indicator.render();
            this._service.refreshAll();
        };
        for (const key of ['enabled-providers', 'provider-order'])
            this._settingsIds.push(this._settings.connect(`changed::${key}`, configureProviders));
        this._settingsIds.push(this._settings.connect('changed::default-provider', () => this._indicator.render()));
        this._settingsIds.push(this._settings.connect('changed::panel-position', () => this._placeIndicator()));
        this._settingsIds.push(this._settings.connect('changed::clear-data-generation', () =>
            this._service.clearSavedData()));
        this._settingsIds.push(this._settings.connect('changed::history-retention-days', () =>
            this._service.refreshAll(true)));
        this._service.refreshAll();
    }

    _placeIndicator() {
        placeIndicator(this._indicator, this._settings.get_string('panel-position'));
    }

    disable() {
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;
        this._service?.destroy();
        this._service = null;
        this._notifications?.destroy();
        this._notifications = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
