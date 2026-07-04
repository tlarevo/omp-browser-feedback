# Changelog

## [0.0.1] - 2026-07-04

### Added

- `/bf` command family: `connect`, `disconnect`, `status`, `broker start|stop|status`,
  `latest`, `list`, `use <id>`, `clear`, `rename <name>`, and
  `settings auto-run on|off`.
- Auto-starts (or reuses) an in-process broker on `session_start`, registers
  the session, and subscribes to feedback events for the session's lifetime;
  tears the subscription and broker down on `session_shutdown`.
- Feedback rendering: incoming `dom.selection`/`screenshot`/`console.error`/
  `page.error` events are formatted into an agent-readable prompt
  (`formatFeedbackAsPrompt`). With `autoRun` off (default), the prompt
  prefills the editor and notifies the user; with `autoRun` on, it is sent
  directly as a user message.

### Fixed

- The extension now ships as a bundled `dist/extension.js` (built via
  `bun run build`). Previously `omp.extensions`/`main` pointed at the raw
  `src/extension.ts`, which the omp host's extension loader cannot resolve
  when that file imports another package's raw TypeScript source (here:
  `@oh-my-pi/browser-broker`, `@oh-my-pi/browser-protocol`) — the extension
  silently failed to load for every consumer, via `omp -e`, `omp plugin
  link`, and `omp plugin install` alike, with no error surfaced anywhere.
