# Changelog

## [0.0.1] - 2026-07-04

### Added

- Shared browser feedback protocol: event schemas and validators
  (`validateFeedbackEvent`) for `dom.selection`, `screenshot`,
  `console.error`, and `page.error` events, plus session-registration
  schemas.
- `BROWSER_PROTOCOL_VERSION` and payload limits (`BROWSER_FEEDBACK_LIMITS`):
  capped note/element-text/outer-HTML lengths, attribute/computed-style
  counts, and a 10 MB screenshot size ceiling.
