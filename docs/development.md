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
and comments that explain constraints. Inherit GNOME font sizes and colors; use
spacing, font weight, and secondary-text opacity for hierarchy. Only panel usage
severity overrides foreground colors.

Usage alerts retain GNOME's native banner. GNOME 50 exposes no per-notification
duration setting, so the presenter adjusts the timeout only for its current
banner. Keep the source isolation and cleanup smoke checks when updating Shell.

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
python3 tools/smoke-shell.py --archive dist/usagebeam@oo7kc.github.io-2.1.0.zip
python3 tools/smoke-shell.py --archive dist/usagebeam@oo7kc.github.io-2.1.0.zip --matrix
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

## GNOME Extensions submission

Review against the [submission rules](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and [best practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).
Automated checks do not constitute store approval.

Before uploading, resolve permission/provenance for the bundled Codex and Claude
artwork, or replace it with original neutral icons. The repository currently
contains no artwork permission records. Keep the original README screenshots
unchanged; choose a new store screenshot if the submitted artwork changes.
The maintainer must understand and maintain the submitted JavaScript, verify
asset rights, and publish source matching the upload. MIT code may be distributed
by GNOME under GPL-compatible terms; see the store's licensing requirements.
The shipped stylesheet credits Vitals for the menu design inspiration.

GNOME 51 preparation uses the shared popup API and key controllers. The test
companion supports both menu animation signatures. Product metadata remains
GNOME 50-only until the archive passes the native Shell 51 smoke harness; the
installed GNOME 51 Flatpak application runtime does not provide a Shell compositor.

### Reviewer notes

UsageBeam targets GNOME Shell 50. A bundled standalone GJS collector performs
bounded local-history scans and provider requests outside the Shell process.
It is needed to avoid blocking the desktop while reading potentially large
session files. Only GJS, SVG assets, metadata, schema data and the MIT license
are packaged; no provider binaries, build tools, tests or screenshots are bundled.

Codex limits are read through the user's installed `codex app-server` using
JSON-RPC. Claude limits use the saved Claude Code OAuth token for an HTTPS request
to `https://api.anthropic.com/api/oauth/usage`. The token is read only, sent only
to that endpoint, and is not persisted or logged by UsageBeam. Neither provider
CLI is installed automatically. Commands use argument arrays without a shell,
elevated privileges or execution of downloaded code.

History comes from the providers' local JSONL files. Private caches store derived
metrics and hashed identities, not credentials, prompts, replies or raw session
identifiers. No telemetry, clipboard access or custom lock-screen session is used.

Disable removes the scheduler, sleep subscription, settings connections, owned
notifications and widgets. Cancelling a collector synchronously removes its
Shell-side timeout sources and sends SIGTERM. Its handler cancels network/RPC
work and reaps the provider child; native async waiting requires no delayed Shell
cleanup timer. A synchronous history scan can finish its bounded scan segment
before the collector dispatches SIGTERM. Ordinary command cancellation force-stops
the command. User-requested terminal sessions are intentionally independent and
remain open after the extension is disabled.

Notifications retain the native banner. GNOME 50 has no per-notification duration
API, so the presenter uses private tray members only for the currently displayed
owned notification. It restores no global methods or settings; its source and
timers are destroyed on disable. Synthetic smoke checks verify isolation from
other applications' banners.

Never commit credentials or conversations. Use synthetic fixtures. Validate
records before saving them, preserve account/local scope, and retain bounds,
timeouts, cancellation, and private cache permissions when refactoring.
