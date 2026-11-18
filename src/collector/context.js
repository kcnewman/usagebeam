import GLib from 'gi://GLib';
import {createCommandSpec, findCommand} from '../services/commands.js';
import {buildPath, fingerprint, stateDirectory} from '../services/files.js';
import {readJson, writeJson} from '../services/syncFiles.js';
import {scanJsonlHistory} from '../services/history.js';
import {requestJson} from '../services/http.js';
import {RpcClient} from '../services/rpcClient.js';

// Adapters receive capabilities, never Shell actors or scheduling state.
const STATE_NAMES = new Set(['claude-calibration']);

function statePath(name) {
    if (!STATE_NAMES.has(name))
        throw new Error(`Unsupported collector state: ${name}`);
    return buildPath(stateDirectory(), `${name}.json`);
}

export function createCollectorContext({cancellable, retentionDays, skipLimits = false}) {
    const historyRoots = {
        codex: GLib.getenv('CODEX_HOME') || buildPath(GLib.get_home_dir(), '.codex'),
        claude: GLib.getenv('CLAUDE_CONFIG_DIR') || buildPath(GLib.get_home_dir(), '.claude'),
    };

    return {
        fingerprint,
        skipLimits,
        now: () => Date.now(),
        loadState: name => readJson(statePath(name), null, 256 * 1024),
        saveState: (name, value) => writeJson(statePath(name), value),
        hasCommand(name) {
            try {
                findCommand(name);
                return true;
            } catch {
                return false;
            }
        },
        scan(providerId, suffixes, parser, options = {}) {
            const root = historyRoots[providerId];
            if (!root)
                throw new Error(`Unsupported local history provider: ${providerId}`);
            const roots = suffixes.map(suffix => buildPath(root, suffix));
            return scanJsonlHistory(providerId, roots, parser, {...options, retention: retentionDays});
        },
        credentials(providerId) {
            return providerId === 'claude'
                ? readJson(buildPath(historyRoots.claude, '.credentials.json'), null, 1024 * 1024)
                : null;
        },
        codexClient: () => new RpcClient(
            createCommandSpec('codex', ['app-server'], {runtimes: ['node']}), cancellable),
        http: (url, options) => requestJson(url, {...options, cancellable}),
    };
}
