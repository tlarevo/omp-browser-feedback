# Browser Feedback v2 Linear Plan Redesign

**Date:** 2026-07-16
**Project:** Browser Feedback v2 — Cursor-class Capture UX
**Linear project:** `38681ed776d7`

## Goal

Make the Linear project a trustworthy execution plan without erasing shipped history. Every open issue must own one bounded outcome, use the current architecture, define observable success, and expose its real blockers.

## Decisions

1. Preserve shipped history. THA-108 and THA-124 remain Done.
2. Cancel implemented legacy umbrellas as superseded instead of rebuilding their foundations.
3. Narrow legacy issues that still contain unowned residual work.
4. Add only genuinely missing cross-cutting work: protocol migration, reconnect hardening, and independent Chrome distribution.
5. Encode execution order with milestones and blocking relations rather than relying on prose links.
6. Do not invent estimates, target dates, or cycles.

## Project sequence

1. **M0 — Reliability Foundation:** broker discovery, presence, limits, durable delivery, silent-failure handling, reconnect hardening, and protocol-v2 rollout.
2. **M1 — Images in the Prompt:** attach screenshots to all OMP injection paths.
3. **M2 — In-Page Capture Toolbar:** shortcut, persistent picker, toolbar, basket, and batch submission.
4. **M3 — Screenshot Modes & Annotation:** region, full-page, and annotated captures.
5. **M4 — Richer Agent Context:** accessibility, XPath, framework, console, and computed-style context.
6. **M5 — Onboarding & Product Polish:** pairing history, popup UX, icons, badges, and accessibility.
7. **M6 — Hardening & End-to-End Verification:** routing, recovery, security, and OMP integration coverage.
8. **M7 — Release & Distribution:** documentation, packaging, Chrome repository extraction, protocol synchronization, and Web Store automation.

## Historical issue treatment

### Keep Done and normalize final contract

- **THA-108:** retain the released reconnect core as Done. Replace stale pre-implementation wording with the delivered behavior and link a focused reconnect-hardening follow-up.
- **THA-124:** retain pairing onboarding as Done. Replace the obsolete numeric/manual-root-token contract with the canonical one-time alphanumeric code and per-install browser capability design.

### Cancel as superseded

Each issue receives a comment naming the implemented baseline and canonical residual owners before its state changes to Canceled.

- **THA-9** → THA-22 plus THA-124’s capability architecture.
- **THA-10** → THA-109.
- **THA-11** → THA-112.
- **THA-12** → THA-108 and THA-109.
- **THA-15** → THA-110, THA-111, THA-124, and THA-125.
- **THA-16** → THA-109, THA-116, and THA-125.
- **THA-17** → THA-114 and THA-115.

### Narrow instead of cancel

- **THA-6:** own whole-range compatible-broker reuse, actionable range exhaustion, environment/config inputs, atomic discovery writes, and dead-PID validation. Assign to M0.
- **THA-18:** own selector robustness only: duplicate IDs, stable class use, generated/utility-class filtering, SVG, deterministic priority, uniqueness verification, and bounded fixtures. Assign to M2 and make it block THA-115.

## New issues

### Protocol v2 migration and mixed-version compatibility

**Milestone:** M0  
**Priority:** Urgent

**Goal:** Introduce protocol-v2 fields and events without breaking independently released broker, OMP, and Chrome versions.

**Scope:**

- Add `minProtocolVersion` and `protocolVersion` to broker health/discovery. A v1 peer is treated as supporting `[1, 1]`.
- Make the v2 broker and OMP client dual-stack for v1 and v2; each payload is validated by its declared version using a strict version-specific schema.
- Negotiate the highest shared version before registration or feedback submission. Do not send v2-only fields or event types to a v1 broker.
- Define v2 `browser.feedback.ack`. A v2 broker with v1 OMP accepts only v1 events, marks them delivered on WebSocket send, exposes `deliveryGuarantee: "legacy"`, and rejects v2-only events for that target with an upgrade error; ACK-backed crash-safe replay is v2-to-v2 only.
- Return a structured `protocol_version_unsupported` error containing the local and remote supported ranges when no version overlaps.
- Generate the Chrome-side types, validators, and version-range constants from the OMP-side source of truth.
- Roll out the dual-stack broker/OMP package before the v2 Chrome producer.
- Add mixed-version tests for discovery, registration, feedback ingestion, and WebSocket delivery.

**Success:**

- v1 Chrome continues to discover and submit to the dual-stack v2 broker.
- v2 Chrome negotiates v2 with a v2 broker and shows an explicit upgrade error against a v1-only broker before capture begins.
- Strict schemas reject fields not declared by the negotiated version; no field is silently discarded.
- Contract generation is reproducible and drift-detectable in CI.
- This issue blocks all of THA-30, THA-112, THA-115, THA-117, THA-118, THA-119, THA-120, and THA-122.

### Reconnect hardening and real broker-restart proof

**Milestone:** M0  
**Priority:** High

**Goal:** Close the production and verification gaps left after the released THA-108 reconnect core.

**Scope:**

- Preserve status callbacks when `/bf connect` or `/bf pair` replaces a subscription.
- Reuse the service/protocol compatibility probe during production rediscovery.
- Add bounded jitter and verify the 30-second cap.
- Keep `/bf status` connection state visible when broker status requests fail.
- Treat an external broker crash/replacement as self-healing. Treat `/bf broker stop` as an intentional offline action that cancels reconnect; `/bf broker start` starts only the broker and explicitly instructs the user to run `/bf connect`.
- Add same-port and different-port/new-token real-broker restart integrations.

**Success:**

- A live OMP session recovers from external broker replacement without user action.
- Statusline and `/bf status` report every outage and recovery state.
- Re-registration occurs before subscription on the replacement broker.
- No duplicate prompt is injected after replay.
- No reconnect occurs after shutdown.

### Chrome repository split and independent Web Store delivery

**Milestone:** M7  
**Priority:** Medium

**Goal:** Complete the approved Chrome product boundary and release it independently from the OMP npm package.

**Scope:**

- Create the standalone Chrome repository.
- Move extension source, tests, manifest, and store assets after parity verification.
- Add independent versioning, CI, packaging, and Web Store release automation.
- Consume the generated protocol contract from the canonical source.
- Remove the in-repo Chrome package only after independent build and e2e parity pass.

**Success:**

- Chrome builds, tests, packages, and releases without an npm-package release.
- Protocol synchronization is reproducible and checked for drift.
- The old package is removed only after the standalone extension passes the existing discovery, pairing, picking, and submission flow.

## Existing contract corrections

- **THA-109:** heartbeat every 15 seconds; mark disconnected after 45 seconds without heartbeat or immediately on WebSocket close; derive idle after five minutes without user activity while heartbeats continue; remove after a ten-minute disconnected grace period. Return presence and `lastSeenAt`.
- **THA-110:** measure field limits in Unicode code points and request/container limits in UTF-8 bytes. Client-truncate DOM-derived text/HTML with a marker that counts toward the cap; never truncate user notes. Broker rejects remaining field violations with structured 422 errors and oversized JSON/multipart containers with `413 payload_too_large` before persistence.
- **THA-112:** use idempotent OMP `eventId` acknowledgements. Retain and replay unacknowledged journal entries; commit delivery only after ACK; compact acknowledged entries atomically; delete screenshots only when the acknowledged event is removed by compaction or retention.
- **THA-115:** represent open Shadow DOM paths as ordered `selectorSegments`, each unique within its document/shadow root. Closed shadow roots and cross-origin iframe traversal are unsupported and must produce a clear explanation rather than a wrong selector.
- **THA-119:** serialize annotations in normalized `[0,1]` final-image coordinates with a top-left origin, while also burning them into the raster. Require toolbar, image attachment, region capture, and protocol migration first.
- **THA-120:** collect only after explicit per-origin opt-in; keep no pre-consent buffer. Cap the ring at 20 entries, 8 KiB per entry, and 64 KiB serialized total; feedback attachment processing must add less than 50 ms on the browser fixture.
- **THA-125:** “Forget this browser” clears the local capability and selected session, returning to `unpaired`; global server-side revocation remains `/bf pair reset`. Own popup pairing states, icons, visual session cards, badge, loading presentation, and accessibility; functional loading/error transitions remain THA-111.
- **THA-20:** own two-session browser-to-OMP routing isolation and cross-contamination tests.
- **THA-21:** own broker recovery, ports, stale discovery, capability-registry loss/revocation, and extension reload.
- **THA-22:** own the endpoint/auth security matrix, constant-time secret comparison, pairing race/lockout coverage, redaction, and release-blocking severity policy.
- **THA-23:** move to M7; separate product versions from protocol compatibility and make clean-machine installation plus package contents observable.
- **THA-126:** own `/bf` commands, injection modes, image attachment, and OMP broker lifecycle integration without duplicating THA-20/21 scenarios. `/bf pair` displays the code with a once-per-second countdown in the TUI and marks it expired when the broker-provided expiry is reached.

## Blocking relations

- THA-110 blocks THA-113 and THA-121.
- THA-114 blocks THA-116; THA-116 blocks THA-30.
- THA-113 blocks THA-30, THA-117, THA-118, and THA-119.
- THA-116 blocks THA-117, THA-118, THA-119, and THA-120.
- THA-117 blocks THA-119.
- THA-18 blocks THA-115.
- Protocol-v2 migration blocks THA-30, THA-112, THA-115, THA-117, THA-118, THA-119, THA-120, and THA-122.
- THA-20, THA-21, THA-22, and THA-126 block THA-23.
- THA-125 and the Chrome split issue block THA-23.

## Completion rules

An issue is execution-ready only when:

- its baseline matches current source behavior;
- its scope has one owner and no overlapping umbrella;
- success criteria are externally observable;
- privacy, failure, and compatibility decisions are already made;
- required predecessors are encoded as blocking relations;
- test safeguards prove the promised boundary rather than source plumbing.
