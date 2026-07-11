# OMP Browser Pairing Architecture Design

**Context:** `omp-browser-feedback` currently requires manual copy/paste of the broker bearer token from `/bf connect` into the Chrome extension popup. The broker discovery file (`~/.omp/browser-broker.json`) already gives the OMP side broker location and root auth, but the browser side stops in a `missing-auth` popup state and stores a pasted token in `chrome.storage.local`.

## Problem

The current onboarding path is secure enough to avoid silent browser trust, but it is clunky and easy to get wrong:

- users must copy a long bearer token from OMP into the browser popup
- the popup currently stores the broker root token directly
- the root token is stronger than the browser actually needs
- repeated broker restarts / token rotations require another copy/paste cycle
- the live product now has a trusted publish/release path, but browser onboarding is still the worst first-run UX

## Decision

Adopt an **OMP-initiated one-time pairing code** flow.

Key properties:

- pairing begins only when OMP explicitly opens a short-lived pairing window
- any browser profile for the same OS user may enroll during that window
- each enrolling browser profile gets its **own generated install identity** stored in `chrome.storage.local`
- the browser never receives the broker root token
- the broker mints a **revocable browser capability token** scoped to that browser install identity
- after pairing, the browser lists OMP sessions and the user chooses one for routing

## Non-goals

- no native desktop app or OS-specific windowing
- no machine-wide credential cloning across browser profiles
- no dependence on Chrome account identity or profile names like `Default` / `Profile 1`
- no zero-typing approval flow in the first iteration
- no per-profile trust isolation in policy; any profile may enroll, but only during an OMP-open pairing window

## Why this architecture

### Rejected: store the broker root token in the browser after one-time entry

This removes repeated copy/paste but still puts the master credential in browser storage. That preserves too much blast radius if browser profile storage is compromised.

### Rejected: zero-typing trust flow as the first version

This would likely be great UX eventually, but it needs more localhost hardening, more approval-state machinery, and more recovery/debug UX. The one-time pairing code reaches the target UX much faster while preserving the right security seams.

### Chosen: short-lived pairing code -> browser capability

This is the smallest design that fixes the UX without weakening the architecture:

- OMP remains the trust anchor
- browser trust is explicit and time-bounded at enrollment
- browser gets a lower-privilege credential than OMP
- later per-profile locking can be added by tightening the enrollment policy instead of redesigning the whole flow

## Trust model

### Root authority

The broker root auth token remains OMP-owned and is never exposed to the extension popup or content scripts.

### Browser identity

Each browser profile generates and persists a local `browserInstallId` in `chrome.storage.local`. This acts as the profile/installation identity. It works for:

- default Chrome profile
- unsigned-in Chrome
- multiple profiles on the same OS user

### Enrollment policy

For the first version, **any browser profile may enroll** while a pairing window is open. That does **not** mean one profile silently grants credentials to every profile forever. Each profile still gets its own stored capability token.

### Browser capability

The broker mints a revocable browser capability token after successful pairing. The extension uses that token for browser-originated broker calls such as:

- list sessions
- submit feedback
- start picker / routing-related extension calls

OMP-originated calls continue using the stronger broker root auth through the existing OMP-side broker client.

## Security invariants

1. The long-lived broker root token never crosses into browser storage.
2. Pairing is possible only while OMP has explicitly opened a short-lived pairing window.
3. Pairing codes are single-use, short-lived, and attempt-limited.
4. Browser capability tokens are revocable and separately persisted from pairing windows.
5. Browser-originated auth is scoped to browser capability validation, not full OMP authority.
6. Loopback endpoints must assume any webpage can probe localhost; pairing must not trust origin alone.
7. Session routing remains explicit in the browser UI; trust does not imply automatic routing to a hidden default session.

## High-level flow

### Pairing

1. User runs `/bf pair` in OMP.
2. OMP ensures broker is running and asks the broker to open a pairing window.
3. Broker generates:
   - `pairingId`
   - 6-8 character `pairingCode`
   - `expiresAt`
   - attempt counter state
4. OMP shows the code and countdown in the TUI.
5. Browser popup in `unpaired` state prompts for the code.
6. Browser submits:
   - `browserInstallId`
   - `pairingCode`
   - optional label metadata
7. Broker validates the pairing window and returns a browser capability token.
8. Browser stores:
   - `browserInstallId`
   - `browserCapabilityToken`
9. Browser refreshes into the `ready` / session-selection state.

### Normal use after pairing

1. Browser popup uses the browser capability to list sessions.
2. User picks an OMP session.
3. Browser stores selected routing state in `chrome.storage.local`.
4. Picks and screenshots are submitted with the browser capability.
5. Broker routes feedback to the chosen OMP session.

### Recovery

- `/bf pair reset` revokes all browser capabilities
- browser-side `Forget this browser` clears local capability and returns to `unpaired`
- broker restart does not require re-pairing if browser capability persistence survives restart
- if broker-side capability persistence is missing/corrupt, popup shows a clear re-pair state

## Data model

### Browser-side (`chrome.storage.local`)

- `browserInstallId: string`
- `browserCapabilityToken: string`
- `selectedSessionId?: string`
- `selectedSessionDisplayName?: string` (optional UX-only cache)

### Broker-side pairing window store

Ephemeral, in-memory state:

- `pairingId: string`
- `codeHash: string`
- `expiresAt: string`
- `attemptsRemaining: number`
- `createdBySessionId: string`

### Broker-side browser capability store

Persisted on disk with user-only permissions:

- `browserInstallId: string`
- `capabilityTokenHash: string`
- `label?: string`
- `createdAt: string`
- `lastUsedAt?: string`
- `revokedAt?: string`

## Codebase impact

### Broker

New responsibilities:

- pairing window issuance + validation
- persistent browser capability registry
- browser-capability auth path separate from OMP root auth path

Likely files:

- create `packages/browser-broker/src/pairing-store.ts`
- modify `packages/browser-broker/src/server.ts`
- possibly extend `packages/browser-broker/src/auth.ts` for browser-capability authorization helpers
- possibly extend `packages/browser-broker/src/discovery.ts` only for broker metadata reuse, not for browser auth storage

### OMP extension

New responsibilities:

- `/bf pair`
- `/bf pair reset`
- pairing status / reset UI text
- keep root broker auth entirely on the OMP side

Likely files:

- modify `packages/browser-omp-extension/src/commands.ts`
- modify `packages/browser-omp-extension/src/client.ts`

### Chrome extension

New responsibilities:

- generate `browserInstallId`
- replace `missing-auth` token field with pairing-code flow
- use browser capability token instead of root broker token
- expose `Forget this browser`

Likely files:

- modify `packages/browser-extension/src/popup/main.ts`
- modify `packages/browser-extension/src/popup/app.ts`
- modify `packages/browser-extension/src/background-entry.ts`
- modify `packages/browser-extension/src/background.ts`

## Existing Linear mapping

This design maps onto existing v2 work; no new backlog should be created just to describe the same problems:

- **THA-124**: `/bf pair` onboarding -> primary pairing/onboarding issue
- **THA-108**: reconnect/re-register/statusline -> still relevant after pairing
- **THA-109**: heartbeats/TTL/presence -> still relevant after pairing
- **THA-23**: packaging/docs/troubleshooting -> document paired flow after implementation

## Testing strategy

### Broker tests

- pairing code lifecycle: create -> validate -> single-use -> expire
- attempt lockout after repeated failures
- race test: only one winner can redeem the same code
- capability persistence across broker restart
- capability revocation
- browser capability cannot access OMP-only flows

### Extension tests

- install ID generation/persistence in `chrome.storage.local`
- popup transitions: `unpaired` -> `pairing-error` -> `ready`
- `Forget this browser` cleanup
- selected session persistence independent of auth pairing

### End-to-end tests

- fresh profile -> `/bf pair` -> enter code -> session list appears
- broker restart -> paired browser still lists sessions
- revoked capability -> popup returns to re-pair flow
- feedback submit after pairing reaches the chosen OMP session

## Failure and support cases

The design must make these obvious in UI and logs:

- code expired
- code already used
- too many wrong attempts
- broker restarted during pairing
- browser capability revoked
- session target removed / renamed / disconnected
- stale browser routing state after capability remains valid

## Recommended next implementation target

Architecturally, the next execution should start with **THA-124** and deliberately fold in the seams needed for THA-108 / THA-109, rather than shipping pairing in isolation and bolting reliability on afterward.
