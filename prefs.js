import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {clearDerivedData} from './src/services/files.js';
import {readProviderSnapshot} from './src/services/snapshotStore.js';
import {buildPreferencesWindow} from './src/ui/preferences.js';

export default class UsageBeamPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        buildPreferencesWindow(window, settings, () => clearDerivedData(), id => readProviderSnapshot(id));
    }
}
