import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PROVIDER_IDS} from '../core/providerRegistry.js';

export const buildPath = (...parts) => GLib.build_filenamev(parts);
export const fingerprint = value => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, String(value), -1);

const PRODUCT_DIRECTORY = 'usagebeam';
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

export async function readJsonAsync(path, fallback = null, maxBytes = DEFAULT_MAX_BYTES, cancellable = null) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
        throw new Error('File size limit must be a positive integer');
    try {
        const file = Gio.File.new_for_path(path);
        const info = await file.query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable);
        if (info.get_size() > maxBytes)
            return fallback;
        const [bytes] = await file.load_contents_async(cancellable);
        if (bytes.length > maxBytes)
            return fallback;
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return fallback;
    }
}

function preparePrivateParent(file) {
    const parentPath = file.get_parent()?.get_path();
    if (!parentPath || GLib.mkdir_with_parents(parentPath, 0o700) < 0 || GLib.chmod(parentPath, 0o700) < 0)
        throw new Error('Could not secure the private data directory');
}

export async function writeJsonAsync(path, value, cancellable = null) {
    const file = Gio.File.new_for_path(path);
    preparePrivateParent(file);
    await file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(JSON.stringify(value))), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
    if (GLib.chmod(path, 0o600) < 0)
        throw new Error('Could not secure the private data file');
}


export function stateDirectory() {
    return buildPath(GLib.get_user_state_dir(), PRODUCT_DIRECTORY);
}

export function cacheDirectory() {
    return buildPath(GLib.get_user_cache_dir(), PRODUCT_DIRECTORY);
}

export async function clearDerivedData({state = stateDirectory(), cache = cacheDirectory()} = {}) {
    const paths = [
        ...PROVIDER_IDS.map(id => buildPath(state, `${id}.json`)),
        buildPath(state, 'claude-calibration.json'),
        ...PROVIDER_IDS.map(id => buildPath(cache, `history-${id}.json`)),
    ];
    let removed = 0;
    for (const path of paths) {
        const file = Gio.File.new_for_path(path);
        try {
            const info = await file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, null);
            if (![Gio.FileType.REGULAR, Gio.FileType.SYMBOLIC_LINK].includes(info.get_file_type()))
                continue;
            await file.delete_async(GLib.PRIORITY_DEFAULT, null);
            removed++;
        } catch {
            // Missing or inaccessible cache files do not make clearing unsafe.
        }
    }
    return removed;
}
