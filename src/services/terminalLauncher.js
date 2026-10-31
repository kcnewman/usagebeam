import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {isProviderId, PROVIDER_NAMES} from '../core/providerRegistry.js';
import {createCommandSpec, findCommand} from './commands.js';

const TERMINALS = Object.freeze([
    ['xdg-terminal-exec', ['--']],
    ['ptyxis', ['--new-window', '--']],
    ['kgx', ['--']],
    ['gnome-terminal', ['--window', '--']],
    ['konsole', ['--new-tab', '-e']],
    ['xterm', ['-e']],
]);

export function getProviderTerminalSpec(id, {resolveProvider = createCommandSpec, resolveTerminal = findCommand} = {}) {
    if (!isProviderId(id))
        throw new Error('Choose Codex or Claude before opening a terminal.');
    let provider;
    try {
        provider = resolveProvider(id, [], {runtimes: ['node']});
    } catch {
        throw new Error(`Install the ${PROVIDER_NAMES[id]} CLI before opening it in a terminal.`);
    }
    for (const [name, args] of TERMINALS) {
        let terminal;
        try {
            terminal = resolveTerminal(name);
        } catch {
            continue;
        }
        return {argv: [terminal, ...args, ...provider.argv], environment: provider.environment};
    }
    throw new Error('Install a terminal or configure xdg-terminal-exec to open your provider.');
}

export async function launchProviderTerminal(id) {
    const spec = getProviderTerminalSpec(id);
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.set_cwd(GLib.get_home_dir());
    for (const [key, value] of Object.entries(spec.environment))
        launcher.setenv(key, value, true);
    try {
        const process = launcher.spawnv(spec.argv);
        await new Promise((resolve, reject) => process.wait_check_async(null, (child, result) => {
            try {
                child.wait_check_finish(result);
                resolve();
            } catch {
                reject(new Error('The terminal could not start the provider. Check your terminal configuration and CLI installation.'));
            }
        }));
    } catch {
        throw new Error('The terminal could not start the provider. Check your terminal configuration and CLI installation.');
    } finally {
        launcher.close();
    }
}
