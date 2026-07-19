# Compatibility Matrix

Three independent version tracks govern OMP Browser Feedback:

| Track | Current value | Source |
|-------|---------------|--------|
| **Protocol version** | `1` | `packages/browser-protocol/src/version.ts` → `BROWSER_PROTOCOL_VERSION` |
| **Chrome Extension version** | `0.1.0` | `packages/browser-extension/manifest.json` → `version` |
| **OMP Package version** | `0.0.8` | `packages/browser-omp-extension/package.json` → `version` |

## What each version means

- **Protocol version** — the wire format for feedback events and session
  registrations. The broker validates all payloads against this schema.
  Bumped when the event structure changes incompatibly.

- **Chrome Extension version** — the Chrome Web Store release version.
  Independent of the protocol; governs what the user installs from the
  store. Bumped for any Chrome extension change (UI, permissions, features).

- **OMP Package version** — the npm package version of `omp-browser-feedback`.
  Independent of both the protocol and Chrome extension; governs what the
  user installs via `bun add`. Bumped for OMP-side changes (commands,
  broker lifecycle, rendering).

## Supported combinations

The protocol version is the binding constraint. Chrome extensions and OMP
packages that share the same protocol version are interoperable.

| Protocol | Chrome Extension | OMP Package | Status |
|----------|-----------------|-------------|--------|
| 1 | 0.1.0 | 0.0.8 | Current |
| 1 | 0.1.0 | 0.0.7 | Supported (auto-run off only) |
| 1 | 0.1.0 | 0.0.6 | Supported (manual pairing only) |
| 1 | 0.1.0 | 0.0.1 | Supported (initial release) |

## Breaking changes

A protocol version bump (1 → 2) would mean:

- The Chrome extension and OMP package must both be updated.
- Old Chrome extensions cannot send feedback to a new broker.
- Old OMP packages cannot receive feedback from a new Chrome extension.

Protocol version bumps will be rare and documented in the changelog.

## Testing compatibility

```bash
# Typecheck OMP extension against latest OMP host
bun run check:omp-head

# Pin to a specific OMP version
OMP_REF=v16.3.0 bun run check:omp-head
```
