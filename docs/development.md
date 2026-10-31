# Development

UsageBeam uses native GJS, Gio/GLib, and Soup 3. Node 20+ runs checks and unit
tests; Python 3 packages the extension and runs the optional GNOME smoke harness.
No npm installation or runtime dependency download is required.

## Structure

- `extension.js`, `prefs.js`: GNOME lifecycle entry points.
- `src/core/`: pure usage contracts, aggregation, formatting, and refresh policy.
- `src/providers/`: Codex and Claude response/history adapters.
- `src/collector/`: bounded collection outside the Shell process.
- `src/services/`: I/O, persistence, scheduling, subprocesses, and terminal launch.
- `src/ui/`: native menu, panel readout, and preferences.
- `tests/`: provider/contract unit tests, critical I/O integration, and Shell smoke.
- `tools/`: source checks, one deterministic packager, and the private Shell harness.

Keep entry points thin and modules focused. Core code has no I/O. Provider
adapters receive their dependencies through the collector context. UI code
receives service callbacks instead of launching collection itself. Use descriptive
lowerCamelCase names, PascalCase classes, explicit imports, four-space indentation,
and comments that explain constraints. CSS controls geometry; GNOME controls styling.

## Check and build

```sh
npm run verify
npm run test:stress
```

`verify` checks JavaScript/import boundaries, schemas, usage contracts, providers,
critical GJS integration, and packaging. The stress suite protects history/cache
correctness and bounded subprocess behavior. Add tests for data loss, wrong
totals, privacy failures, or broken lifecycle—not trivial markup or getters.

The only build path is `tools/package.py`. It creates a deterministic ZIP in
`dist/`, including compiled schemas and runtime files only. Set the release
version in `package.json`; product identity stays in `metadata.json`.

On a development machine with GNOME Shell 50, test the archive in a private
desktop with synthetic data:

```sh
python3 tools/smoke-shell.py --archive dist/usagebeam@oo7kc.github.io-2.0.0.zip
python3 tools/smoke-shell.py --archive dist/usagebeam@oo7kc.github.io-2.0.0.zip --matrix
```

The harness covers menu navigation, selection, refresh focus, long-content bounds,
native themes/fonts, preferences, and disable/re-enable. Output belongs in `/tmp`.
Install a verified ZIP with `gnome-extensions install --force`; log in again to
load replaced JavaScript modules reliably.

## Release

Work on `dev`. Update the version, README, screenshot, and changelog; run checks,
stress, deterministic packaging, and exact-archive Shell smoke. Validate available
live provider accounts and document any unverified account types. Require green
CI before tagging the tested commit as `vVERSION`. Publish the CI-built ZIP and
SHA-256 as a normal GitHub release, then verify the downloadable asset. Keep
previous release archives on GitHub for downgrades, not in the source tree.

Never commit credentials or conversations. Use synthetic fixtures. Validate
records before saving them, preserve account/local scope, and retain bounds,
timeouts, cancellation, and private cache permissions when refactoring.
