# Changelog

## 1.0.0 — 2026-11-06

First release.

- Full-screen lock over the whole Harness UI (`shell.overlay`), lock button at the sidebar foot
  (`sidebar.footer.action`), `Ctrl/Cmd + Shift + L` shortcut.
- Salted SHA-256 password stored in `localStorage`; optional password; change and remove flows.
- Locked state persists across reloads and syncs between tabs; the page title is hidden while locked.
- Cooldown after three wrong attempts (5 s, doubling, capped at 60 s) with a live countdown.
- Light and dark themes derived from `--dsw-alias-*` tokens; English and 简体中文.
