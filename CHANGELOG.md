# Changelog

## 2.2.0 — 2026-11-18

- Keep Claude account limits visible when Anthropic rate limits usage checks.
  The panel shows the last reading in italics, then an estimate such as `~47%`
  projected from local activity once that reading is over 15 minutes old or its
  limit period has renewed.
- Check Claude limits at most every five minutes. Honor `Retry-After`, back off
  on repeated rate limits, keep manual refreshes from bypassing the wait, and
  keep refreshing local history while limits are paused.
- Add a History view with per-day model breakdowns.
- Address extensions.gnome.org review warnings: no blocking file IO in Shell or
  preferences code, no compiled schemas in the package, and Shell-tracked
  settings signals.
- Local history caches are rebuilt once after upgrading to record event times.

## 2.1.0 — 2026-10-31

- Prepare GNOME 51 menu and keyboard compatibility; native Shell 51 validation
  is still pending before declaring release support.
- Tighten subprocess cleanup for store review, identify the standalone GJS
  collector, and check Shell/preferences import separation.
- Organize settings into General and Usage details. Simplify provider ordering,
  clarify panel selection and alert milestones, and separate data controls.
- Refine the compact menu with native typography, aligned metrics, filled icons,
  responsive footer spacing and reset countdowns beside headings and providers.
- Simplify Activity to seven-day model totals with indented rows; move status
  and incomplete-record notices to settings.
- Restore panel warning colors at 80%, 90% and 100%. Use smaller eight-second
  alerts and remove footer tooltips.
- Keep countdowns current between data updates and bound HTTP bodies while reading.
- Rewrite the product README with original full-resolution screenshots.

## 2.0.0 — 2026-10-31

- Native GNOME menu for Codex and Claude Code account limits and reset times.
- Compact provider accordion, local model totals, and daily activity.
- Refresh, selected-provider terminal, and settings shortcuts.
- Provider ordering, panel placement, usage alerts, and safe derived-data clearing.
- Private, bounded collection with cache recovery and explicit unavailable states.
- Removed experimental providers, obsolete UI, legacy migrations, duplicate
  build tooling, and superseded screenshots and documentation.

Earlier prereleases remain available in
[GitHub Releases](https://github.com/kcnewman/usagebeam/releases).
