import {getEnabledProviders, normalizeProviderOrder} from '../core/providerRegistry.js';

// Normalize saved settings when upgrading without importing retired providers
// or changing a user's explicit choice to disable all providers.
export function normalizeSettings(settings) {
    const enabled = settings.get_strv('enabled-providers');
    const savedOrder = settings.get_strv('provider-order');
    const order = normalizeProviderOrder(settings.get_user_value('provider-order') === null ? enabled : savedOrder);
    const available = getEnabledProviders(enabled, order);
    if (JSON.stringify(enabled) !== JSON.stringify(available))
        settings.set_strv('enabled-providers', available);
    if (JSON.stringify(savedOrder) !== JSON.stringify(order))
        settings.set_strv('provider-order', order);
    if (!available.includes(settings.get_string('default-provider')))
        settings.set_string('default-provider', available[0] ?? 'codex');
    const savedPosition = settings.get_user_value('panel-position');
    const position = savedPosition?.deepUnpack?.() ?? savedPosition?.deep_unpack?.() ?? savedPosition;
    if (position && !['left', 'right'].includes(position))
        settings.set_string('panel-position', 'right');
}
