import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {listFiles} from './sourceChecks.js';

export function checkRepository() {
    const metadata = JSON.parse(readFileSync('metadata.json', 'utf8'));
    if (metadata.uuid !== 'usagebeam@oo7kc.github.io' || metadata.name !== 'UsageBeam' ||
        metadata['settings-schema'] !== 'org.gnome.shell.extensions.usagebeam')
        throw new Error('UsageBeam product identity is inconsistent');
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(JSON.parse(readFileSync('package.json', 'utf8')).version))
        throw new Error('Invalid release version');
    if (/font-(?:family|size|weight)\s*:|(?:^|[;{\s])(?:color|background-color)\s*:/m.test(readFileSync('stylesheet.css', 'utf8')))
        throw new Error('Fonts and colors must come from the GNOME theme');
    for (const file of ['README.md', 'CHANGELOG.md', 'docs/development.md']) {
        if (!existsSync(file))
            throw new Error(`Missing documentation: ${file}`);
    }
    for (const file of ['README.md', 'CHANGELOG.md', ...listFiles('docs')].filter(path => path.endsWith('.md'))) {
        for (const [, target] of readFileSync(file, 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
            if (/^(?:https?:|#|mailto:)/.test(target))
                continue;
            const path = target.split('#')[0];
            if (path && !existsSync(resolve(dirname(file), path)))
                throw new Error(`${file}: broken relative link ${target}`);
        }
    }
    execFileSync('glib-compile-schemas', ['--strict', '--dry-run', 'schemas']);
}
