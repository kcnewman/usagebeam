import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import Soup from 'gi://Soup?version=3.0';
import {createQuotaWindow, createUsageRecord} from '../../src/core/usage.js';
import {loadProviderSnapshot, readProviderSnapshot, saveProviderSnapshot} from '../../src/services/snapshotStore.js';
import {parseClaudeEvent} from '../../src/providers/claude.js';
import {parseCodexEvent} from '../../src/providers/codex.js';
import {createCommandSpec, findCommand} from '../../src/services/commands.js';
import {buildPath, clearDerivedData, readJson, writeJson} from '../../src/services/files.js';
import {scanJsonlHistory} from '../../src/services/history.js';
import {requestJson} from '../../src/services/http.js';
import {normalizeSettings} from '../../src/services/settings.js';
import {getProviderTerminalSpec} from '../../src/services/terminalLauncher.js';
import {runCommand} from '../../src/services/process.js';
import {RpcClient} from '../../src/services/rpcClient.js';
import {UsageService} from '../../src/services/usageService.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}
const scratch = GLib.dir_make_tmp('usagebeam-integration-XXXXXX');
const sessions = buildPath(scratch, 'sessions');
GLib.mkdir_with_parents(sessions, 0o700);
const fixture = buildPath(sessions, 'synthetic.jsonl');
const cachePath = buildPath(scratch, 'cache.json');
const now = new Date('2026-09-06T12:00:00').getTime();
const event = total => JSON.stringify({type: 'event_msg', timestamp: '2026-09-06T10:00:00Z', payload: {type: 'token_count',
    info: {total_token_usage: {input_tokens: total, output_tokens: 0, cached_input_tokens: 0, total_tokens: total}}}});
const text = `${JSON.stringify({type: 'session_meta', payload: {id: 'synthetic'}})}\n${event(100)}\n`;
GLib.file_set_contents(fixture, text);
const first = scanJsonlHistory('codex', [sessions], parseCodexEvent, {now, cachePath});
assert(first.days.at(-1).total === 100, 'initial scan');
const second = scanJsonlHistory('codex', [sessions], parseCodexEvent, {now, cachePath});
assert(second.scannedFiles === 0 && second.days.at(-1).total === 100, 'unchanged file must reuse cache');
GLib.file_set_contents(fixture, `${text}${event(180)}\n{"partial":`);
const third = scanJsonlHistory('codex', [sessions], parseCodexEvent, {now, cachePath});
assert(third.days.at(-1).total === 180, 'append must count delta only');
const cache = readJson(cachePath);
assert(cache.version === 6, 'versioned cache');
assert(!JSON.stringify(cache).includes('synthetic'), 'session identity must be sanitized in cache');
assert(third.days.at(-1).sessions === 1, 'resumed scans must retain one stable private session identity');
const privateDirectory = buildPath(scratch, 'private-state');
GLib.mkdir_with_parents(privateDirectory, 0o755);
GLib.chmod(privateDirectory, 0o755);
const privateRecord = buildPath(privateDirectory, 'record.json');
writeJson(privateRecord, {safe: true});
assert(readJson(privateRecord).safe, 'atomic JSON roundtrip');
const directoryInfo = Gio.File.new_for_path(privateDirectory).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
assert((directoryInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o700, 'private JSON directory mode');
const stateInfo = Gio.File.new_for_path(privateRecord).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
assert((stateInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o600, 'private JSON file mode');
print('PASS: GJS history initial scan, cached scan, append, partial line, and private JSON cache');

const snapshotDirectory = buildPath(scratch, 'snapshots');
const snapshot = createUsageRecord('codex');
snapshot.capabilities.limits = true;
snapshot.limits = {...snapshot.limits, status: 'ready', updatedAt: now, source: 'Synthetic account limits',
    windows: [createQuotaWindow({id: 'weekly', label: 'Weekly', usedPercent: 25, resetsAt: now + 60000})]};
assert(saveProviderSnapshot(snapshot, snapshotDirectory), 'snapshot persistence must succeed in a private directory');
assert(readProviderSnapshot('codex', snapshotDirectory).limits.status === 'ready',
    'Settings diagnostics must preserve saved status instead of applying the live-cache stale transition');
const restoredSnapshot = loadProviderSnapshot('codex', snapshotDirectory);
assert(restoredSnapshot.limits.status === 'stale' && restoredSnapshot.limits.updatedAt === now &&
    restoredSnapshot.limits.windows[0].usedPercent === 25,
    'snapshot restore must retain usage and freshness while marking saved data stale');
writeJson(buildPath(snapshotDirectory, 'codex.json'), {rawResponse: 'REJECTED_SYNTHETIC_FIELD'});
assert(loadProviderSnapshot('codex', snapshotDirectory).limits.status === 'loading',
    'invalid snapshots must produce an empty contract instead of exposing unknown fields');
assert(!saveProviderSnapshot(snapshot, privateRecord),
    'snapshot persistence failures must remain independent from live usage');
print('PASS: GJS snapshot validation, stale restoration, and persistence failure isolation');

const clearState = buildPath(scratch, 'clear-state');
const clearCache = buildPath(scratch, 'clear-cache');
writeJson(buildPath(clearState, 'codex.json'), {provider: 'codex'});
writeJson(buildPath(clearCache, 'unrelated.json'), {preserve: true});
GLib.mkdir_with_parents(buildPath(clearState, 'claude.json'), 0o700);
Gio.File.new_for_path(buildPath(clearCache, 'history-claude.json'))
    .make_symbolic_link(buildPath(clearCache, 'unrelated.json'), null);
assert(clearDerivedData({state: clearState, cache: clearCache}) === 2,
    'clear data must remove only recognized regular files and links');
assert(!Gio.File.new_for_path(buildPath(clearState, 'codex.json')).query_exists(null),
    'clear data must remove provider state');
assert(!Gio.File.new_for_path(buildPath(clearCache, 'history-claude.json'))
    .query_exists(null), 'clear data must unlink recognized cache links');
assert(Gio.File.new_for_path(buildPath(clearState, 'claude.json')).query_exists(null) &&
    readJson(buildPath(clearCache, 'unrelated.json')).preserve,
    'clear data must retain directories and unrelated files');
print('PASS: GJS safe derived-data clearing');

const savedSettings = new Map([
    ['enabled-providers', ['unknown', 'claude', 'codex']],
    ['provider-order', ['claude', 'unknown', 'codex']],
    ['default-provider', 'unknown'], ['panel-position', 'retired-position'],
]);
const settings = {
    get_user_value: key => savedSettings.get(key) ?? null,
    get_strv: key => savedSettings.get(key),
    set_strv: (key, value) => savedSettings.set(key, value),
    get_string: key => savedSettings.get(key),
    set_string: (key, value) => savedSettings.set(key, value),
};
normalizeSettings(settings);
assert(savedSettings.get('enabled-providers').join(',') === 'claude,codex' &&
    savedSettings.get('provider-order').join(',') === 'claude,codex', 'Upgrade must retain supported provider order');
assert(savedSettings.get('default-provider') === 'claude' && savedSettings.get('panel-position') === 'right',
    'Upgrade must replace unknown provider and panel settings');
savedSettings.set('enabled-providers', []);
normalizeSettings(settings);
assert(savedSettings.get('enabled-providers').length === 0, 'Upgrade must preserve explicitly disabled providers');
print('PASS: GJS settings upgrade preserves valid choices');

const providerPath = '/synthetic path/with $literal/claude';
const resolveProvider = name => ({argv: [name === 'claude' ? providerPath : '/fixture/codex'], environment: {PATH: '/fixture/bin'}});
const terminalSpec = getProviderTerminalSpec('claude', {resolveProvider,
    resolveTerminal: name => { if (name === 'xdg-terminal-exec') return '/fixture/terminal'; throw new Error('missing'); }});
assert(JSON.stringify(terminalSpec.argv) === JSON.stringify(['/fixture/terminal', '--', providerPath]),
    'Terminal commands must preserve paths as literal arguments');
assert(terminalSpec.environment.PATH === '/fixture/bin', 'Terminal must inherit resolved provider runtime paths');
const fallbackSpec = getProviderTerminalSpec('codex', {resolveProvider,
    resolveTerminal: name => { if (name === 'gnome-terminal') return '/fixture/gnome-terminal'; throw new Error('missing'); }});
assert(JSON.stringify(fallbackSpec.argv) === '["/fixture/gnome-terminal","--window","--","/fixture/codex"]',
    'Terminal fallback must open the selected provider');
for (const options of [
    {resolveProvider: () => { throw new Error('missing'); }},
    {resolveProvider, resolveTerminal: () => { throw new Error('missing'); }},
]) {
    let failed = false;
    try { getProviderTerminalSpec('codex', options); } catch { failed = true; }
    assert(failed, 'Missing CLI or terminal must produce an actionable failure');
}
let retiredRejected = false;
try { getProviderTerminalSpec('unknown', {resolveProvider}); } catch { retiredRejected = true; }
assert(retiredRejected, 'Unknown providers must not launch');
print('PASS: GJS literal terminal command selection');

let cancelledJob = false;
let changedRecords = 0;
let forcedRefresh = null;
const previousThresholds = {};
const service = Object.assign(Object.create(UsageService.prototype), {
    _destroyed: false,
    _enabledProviderIds: ['claude', 'codex'],
    _pendingCollections: new Map([['codex', {cancel: () => { cancelledJob = true; }}]]),
    _lastAttemptAt: new Map([['codex', 1]]),
    _failureCounts: new Map([['codex', 2]]),
    _thresholdTracker: previousThresholds,
    _recordsByProvider: {codex: {saved: true}},
    _emitChanged: () => { changedRecords++; },
    refreshAll: force => { forcedRefresh = force; },
});
service.clearSavedData();
assert(cancelledJob && !service._pendingCollections.size && !service._lastAttemptAt.size && !service._failureCounts.size,
    'clear data must cancel in-flight work and reset scheduler state');
assert(Object.keys(service._recordsByProvider).join(',') === 'claude,codex' &&
    Object.values(service._recordsByProvider).every(value => value.schemaVersion === 2),
    'clear data must replace saved records with clean provider contracts');
assert(service._thresholdTracker !== previousThresholds && changedRecords === 1 && forcedRefresh,
    'clear data must reset alerts, update the panel and rebuild provider data');
print('PASS: GJS in-memory usage clearing');

const replacementRoot = buildPath(scratch, 'replacement');
GLib.mkdir_with_parents(replacementRoot, 0o700);
const replacement = buildPath(replacementRoot, 'same-size.jsonl');
const replacementCache = buildPath(scratch, 'replacement-cache.json');
GLib.file_set_contents(replacement, `${event(100)}\n`);
assert(scanJsonlHistory('codex', [replacementRoot], parseCodexEvent, {now, cachePath: replacementCache})
    .days.at(-1).total === 100, 'same-size baseline');
GLib.usleep(2000);
GLib.file_set_contents(replacement, `${event(200)}\n`);
assert(scanJsonlHistory('codex', [replacementRoot], parseCodexEvent, {now, cachePath: replacementCache})
    .days.at(-1).total === 200, 'same-size replacement must invalidate the cache');
Gio.File.new_for_path(replacement).delete(null);
const saved = scanJsonlHistory('codex', [replacementRoot], parseCodexEvent, {now: now + 1000, cachePath: replacementCache});
assert(saved.status === 'stale' && saved.days.at(-1).total === 200, 'missing source must retain recent cached history');
print('PASS: GJS history replacement detection and stale-source recovery');

const claudeProjects = buildPath(scratch, 'claude-projects');
GLib.mkdir_with_parents(claudeProjects, 0o700);
const claudeLine = JSON.stringify({type: 'assistant', sessionId: 'claude-session', timestamp: '2026-09-06T11:00:00Z',
    message: {id: 'claude-message', role: 'assistant', model: 'claude-test', usage: {input_tokens: 2,
        output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 5}}});
GLib.file_set_contents(buildPath(claudeProjects, 'session.jsonl'), `${claudeLine}\n${claudeLine}\n`);
const claudeCache = buildPath(scratch, 'claude-cache.json');
const claude = scanJsonlHistory('claude', [claudeProjects], parseClaudeEvent, {now, cachePath: claudeCache});
assert(claude.days.at(-1).total === 50, 'duplicate Claude messages must count once');
assert(claude.models[0].cacheRead === 40 && claude.models[0].cacheWrite === 5, 'Claude cache categories');
assert(!JSON.stringify(readJson(claudeCache)).includes('claude-session'), 'Claude session identity must be sanitized');
print('PASS: GJS Claude history deduplication, model totals, and private cache');

for (const version of ['v20.12.0', 'v24.16.0']) {
    const bin = buildPath(scratch, '.local', 'share', 'fnm', 'node-versions', version, 'installation', 'bin');
    GLib.mkdir_with_parents(bin, 0o700);
    const command = buildPath(bin, 'fixture-cli');
    GLib.file_set_contents(command, '#!/usr/bin/env fixture-runtime\n');
    GLib.chmod(command, 0o700);
    const runtime = buildPath(bin, 'fixture-runtime');
    GLib.file_set_contents(runtime, `#!/bin/sh\nprintf '${version}'\n`);
    GLib.chmod(runtime, 0o700);
}
assert(findCommand('fixture-cli', {home: scratch, usePath: false}).includes('v24.16.0'),
    'version-manager lookup must choose the newest installed runtime');
let invalidName = false;
try {
    findCommand('..');
} catch {
    invalidName = true;
}
assert(invalidName, 'command discovery must reject path-like command names');
const fixtureSpec = createCommandSpec('fixture-cli', ['status'], {home: scratch, usePath: false});
assert(fixtureSpec.argv[0].endsWith('/fixture-cli') && fixtureSpec.argv[1] === 'status',
    'version-managed command must retain its native entry point');
assert(fixtureSpec.environment.PATH.split(':')[0].endsWith('/v24.16.0/installation/bin'),
    'version-managed command directory must lead the child search path');
const npmBin = buildPath(scratch, '.npm-global', 'bin');
GLib.mkdir_with_parents(npmBin, 0o700);
const runtimeCli = buildPath(npmBin, 'runtime-cli');
GLib.file_set_contents(runtimeCli, '#!/usr/bin/env fixture-runtime\n');
GLib.chmod(runtimeCli, 0o700);
const runtimeSpec = createCommandSpec('runtime-cli', [],
    {home: scratch, usePath: false, runtimes: ['fixture-runtime']});
assert(runtimeSpec.environment.PATH.includes('/v24.16.0/installation/bin'),
    'user-local commands must receive a discovered runtime path');
print('PASS: GJS version-manager command discovery');

const loop = new GLib.MainLoop(null, false);
let failed = false;
(async () => {
    try {
        assert((await runCommand(['/bin/echo', 'fixture'])).trim() === 'fixture', 'subprocess output');
        assert((await runCommand(fixtureSpec)).trim() === 'v24.16.0',
            'command environment must resolve its sibling runtime');
        assert((await runCommand(runtimeSpec)).trim() === 'v24.16.0',
            'user-local command environment must resolve a version-managed runtime');
        let invalidEnvironment = false;
        try {
            await runCommand({argv: ['/bin/echo', 'fixture'], environment: {PATH: 10}});
        } catch (error) {
            invalidEnvironment = error.code === 'INVALID_COMMAND';
        }
        assert(invalidEnvironment, 'subprocess environments must contain only strings');
        let timedOut = false;
        try {
            await runCommand(['/bin/sleep', '5'], {timeout: 50});
        } catch (error) {
            timedOut = error.code === 'TIMED_OUT';
        }
        assert(timedOut, 'subprocess timeout');
        let limited = false;
        try {
            await runCommand(['/bin/echo', 'too-large'], {maxOutputBytes: 3});
        } catch (error) {
            limited = error.code === 'OUTPUT_LIMIT';
        }
        assert(limited, 'subprocess output limit');
        const addTimeout = GLib.timeout_add;
        const removeSource = GLib.source_remove;
        const commandSources = new Set();
        GLib.timeout_add = (priority, delay, callback) => {
            const id = addTimeout(priority, delay, () => {
                commandSources.delete(id);
                return callback();
            });
            commandSources.add(id);
            return id;
        };
        GLib.source_remove = id => {
            commandSources.delete(id);
            return removeSource(id);
        };
        try {
            const shutdown = new Gio.Cancellable();
            const operation = runCommand(['/bin/sleep', '5'], {cancellable: shutdown, gracefulCancellation: true});
            assert(commandSources.size === 1, 'Command deadline was not tracked');
            shutdown.cancel();
            assert(commandSources.size === 0, 'Cancellation leaves a Shell main-loop source alive');
            const error = await operation.catch(error => error);
            assert(error.code === 'CANCELLED' && commandSources.size === 0,
                'Cancelled command creates a delayed cleanup source');
        } finally {
            GLib.timeout_add = addTimeout;
            GLib.source_remove = removeSource;
        }
        print('PASS: GJS cancellation removes command sources synchronously');
        const mockBin = buildPath(scratch, 'shutdown-bin');
        const childPidPath = buildPath(scratch, 'shutdown-child.pid');
        GLib.mkdir_with_parents(mockBin, 0o700);
        const mockCodex = buildPath(mockBin, 'codex');
        GLib.file_set_contents(mockCodex, '#!/usr/bin/gjs -m\n' +
            'import Gio from "gi://Gio";\nimport GLib from "gi://GLib";\n' +
            'GLib.file_set_contents(GLib.getenv("USAGEBEAM_MOCK_PID"), String(new Gio.Credentials().get_unix_pid()));\n' +
            'new GLib.MainLoop(null, false).run();\n');
        GLib.chmod(mockCodex, 0o700);
        const collectorCancellation = new Gio.Cancellable();
        const collectorShutdown = runCommand({argv: ['/usr/bin/gjs', '-m',
            buildPath(GLib.get_current_dir(), 'src', 'collector', 'main.js'), 'codex'], environment: {
            PATH: `${mockBin}:/usr/bin:/bin`, CODEX_HOME: buildPath(scratch, 'shutdown-history'),
            XDG_CACHE_HOME: buildPath(scratch, 'shutdown-cache'), USAGEBEAM_MOCK_PID: childPidPath,
        }}, {cancellable: collectorCancellation, gracefulCancellation: true});
        try {
            await new Promise((resolve, reject) => {
                let attempts = 0;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                    if (Gio.File.new_for_path(childPidPath).query_exists(null)) {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    }
                    if (++attempts >= 200) {
                        reject(new Error('Synthetic provider child did not start'));
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                });
            });
        } finally {
            collectorCancellation.cancel();
            await collectorShutdown.catch(() => {});
        }
        const [, pidBytes] = GLib.file_get_contents(childPidPath);
        const childPid = new TextDecoder().decode(pidBytes).trim();
        assert(/^\d+$/.test(childPid) && !Gio.File.new_for_path(`/proc/${childPid}`).query_exists(null),
            'Collector shutdown leaves a provider child running or unreaped');
        print('PASS: GJS collector shutdown reaps its provider child');
        const cancelled = new Gio.Cancellable();
        cancelled.cancel();
        let cancellationReported = false;
        try {
            await runCommand(['/bin/sleep', '5'], {cancellable: cancelled});
        } catch (error) {
            cancellationReported = error.code === 'CANCELLED';
        }
        assert(cancellationReported, 'pre-cancelled subprocess must report cancellation');
        const rpc = new RpcClient(['/bin/cat'], cancelled);
        assert(rpc.isClosed, 'pre-cancelled RPC client must close during construction');
        rpc.close();
        let insecureEndpoint = false;
        try {
            await requestJson('http://example.invalid');
        } catch (error) {
            insecureEndpoint = error.message.includes('HTTPS');
        }
        assert(insecureEndpoint, 'provider requests must reject insecure endpoints before network access');
        // Feed synthetic response streams through the HTTP reader without a network request.
        const send = Soup.Session.prototype.send_async;
        const finish = Soup.Session.prototype.send_finish;
        let response = '{"value":"✓"}';
        let stream;
        Soup.Session.prototype.send_async = function (_message, _priority, _cancel, callback) {
            stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new TextEncoder().encode(response)));
            callback(this, null);
        };
        Soup.Session.prototype.send_finish = () => stream;
        try {
            assert((await requestJson('https://example.invalid')).data.value === '✓', 'HTTP JSON decoding changed');
            assert(stream.is_closed(), 'Successful HTTP response stream stays open');
            response = 'x'.repeat(256 * 1024);
            let oversized = false;
            try {
                await requestJson('https://example.invalid', {maxResponseBytes: 4096});
            } catch (error) {
                oversized = error.message.includes('exceeded');
            }
            assert(oversized && stream.tell() < response.length && stream.is_closed(),
                'Oversized HTTP response was fully buffered or left open');
        } finally {
            Soup.Session.prototype.send_async = send;
            Soup.Session.prototype.send_finish = finish;
        }
        print('PASS: GJS bounded HTTP response reading and cleanup');
        print('PASS: GJS subprocess communication, deadline and termination');
    } catch (error) {
        printerr(error.message);
        failed = true;
    } finally {
        loop.quit();
    }
})();
loop.run();
function remove(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const entries = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let entry;
        while ((entry = entries.next_file(null)))
            remove(file.get_child(entry.get_name()));
        entries.close(null);
    }
    file.delete(null);
}
remove(Gio.File.new_for_path(scratch));
System.exit(failed ? 1 : 0);
