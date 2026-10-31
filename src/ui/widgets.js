import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {PROVIDERS} from '../core/providerRegistry.js';

export function createLabel(text, style = '', expand = false) {
    return new St.Label({text: String(text ?? ''), style_class: style,
        y_align: Clutter.ActorAlign.CENTER, x_expand: expand});
}

export function createMetricLabel(text, style = '', expand = false) {
    const actor = createLabel(text, `usagebeam-metric ${style}`.trim(), expand);
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    actor.x_align = Clutter.ActorAlign.END;
    return actor;
}

export function createSymbolicIcon(name, extensionPath) {
    return new Gio.FileIcon({file: Gio.File.new_for_path(`${extensionPath}/icons/${name}-symbolic.svg`)});
}

export function createProviderIcon(provider, extensionPath, style = '') {
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider))
        return null;
    return new St.Icon({
        gicon: new Gio.FileIcon({file: Gio.File.new_for_path(`${extensionPath}/icons/${PROVIDERS[provider].icon}`)}),
        style_class: `usagebeam-provider-icon ${style}`.trim(),
    });
}
