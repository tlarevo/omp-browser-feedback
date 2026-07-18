# Browser Feedback v2 Linear Plan Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Browser Feedback v2 Linear project into an implementation-current, dependency-encoded execution plan while preserving shipped history.

**Architecture:** Linear remains the source of execution state. Existing shipped issues remain Done, implemented umbrella issues become Canceled with replacement comments, residual legacy issues are narrowed, and three missing cross-cutting issues are added. Milestones and `blocks` relations encode the complete delivery path.

**Tech Stack:** Linear CLI 2.0.0, Linear GraphQL through `linear api`, Markdown description files, Bun only for local JSON/text preparation.

## Global Constraints

- Workspace: `tharindu-abeydeera`; team: `THA`; project slug: `38681ed776d7`.
- Preserve THA-108 and THA-124 as Done.
- Do not delete issues, comments, or milestones. Remove a relation only when converting `related` to the approved directional `blocks` edge, or when an active issue blocks a canceled/superseded target and a comment records the canonical replacement.
- Do not invent estimates, cycles, due dates, start dates, or target dates.
- Multi-line descriptions and comments must use `--description-file` and `--body-file`.
- Every modified open issue must contain `## Goal`, `## Scope`, either `## Success criteria` or `## Acceptance criteria`, and explicit observable test safeguards in a dedicated section or acceptance bullets.
- Add relations only after checking existing relations; do not create duplicate edges.
- The approved design is `docs/superpowers/specs/2026-07-16-browser-feedback-v2-linear-plan-redesign.md`.

---

### Task 1: Capture a reversible Linear snapshot

**Artifacts:**
- Create temporary: `local://browser-feedback-v2-before.json`
- Read: project `38681ed776d7`, all 33 current issues, milestones, comments, parents, and relations

**Interfaces:**
- Consumes: authenticated `linear` CLI workspace.
- Produces: immutable pre-change JSON used to verify states, descriptions, and relations.

- [ ] **Step 1: Verify workspace**

Run: `linear auth whoami`

Expected: workspace slug `tharindu-abeydeera`.

- [ ] **Step 2: Export project and issue state through GraphQL**

Request project description, milestones, and every issue’s identifier, title, description, priority, state, milestone, parent, comments, and relations. Save the unmodified JSON to `local://browser-feedback-v2-before.json`.

Expected: 33 issues, 2 completed, 31 backlog before mutation.

- [ ] **Step 3: Record current milestone IDs**

Run: `linear milestone list --project 38681ed776d7`

Expected: M0 through M6, including M5 ID `5ac80adc-3381-48c0-b413-d55458a48699` and M6 ID `283f1381-676e-44ce-8357-25e346e9b498`.

---

### Task 2: Restructure milestones and create missing issues

**Artifacts:**
- Create temporary description files for three new issues.
- Modify Linear milestones M5 and M6.
- Create Linear milestone M7.
- Create three Linear issues.

**Interfaces:**
- Consumes: approved new-issue contracts from the design spec.
- Produces: identifiers `PROTOCOL_V2_ISSUE`, `RECONNECT_HARDENING_ISSUE`, and `CHROME_SPLIT_ISSUE` for later relation wiring.

- [ ] **Step 1: Rename M5 and M6**

Run:

```bash
linear milestone update 5ac80adc-3381-48c0-b413-d55458a48699 --name "M5. Onboarding & Product Polish"
linear milestone update 283f1381-676e-44ce-8357-25e346e9b498 --name "M6. Hardening & End-to-End Verification"
```

Expected: both commands succeed without changing target dates.

- [ ] **Step 2: Create M7**

Run:

```bash
linear milestone create \
  --project 38681ed776d7 \
  --name "M7. Release & Distribution" \
  --description "Final documentation, packaging, independent Chrome delivery, protocol synchronization, and release verification after product hardening."
```

Expected: one new milestone named exactly `M7. Release & Distribution`.

- [ ] **Step 3: Create the protocol-v2 issue**

Create an Urgent, Backlog, self-assigned M0 issue titled `Protocol v2 migration: mixed-version negotiation, rollout, and contract sync`.

Its description must contain the exact policy approved in the design:

- health/discovery exposes `minProtocolVersion` and `protocolVersion`;
- v1 peers are treated as `[1,1]`;
- v2 broker and OMP are dual-stack with strict version-specific schemas;
- peers negotiate the highest shared version;
- incompatibility returns `protocol_version_unsupported` with local/remote ranges;
- OMP-side source generates Chrome types, validators, and range constants;
- dual-stack broker/OMP ships before v2 Chrome;
- mixed-version discovery, registration, feedback, ACK, legacy mark-on-send, and WebSocket tests;
- success explicitly covers v1 Chrome→v2 broker, v2 Chrome→v2 broker, v2 Chrome→v1 broker failure before capture, v2 broker→v1 OMP legacy delivery, and v2 broker→v2 OMP ACK-backed delivery.

Record the returned identifier as `PROTOCOL_V2_ISSUE`.

- [ ] **Step 4: Create the reconnect-hardening issue**

Create a High, Backlog, self-assigned M0 issue titled `Reconnect hardening: status propagation, compatibility probing, and real broker restart tests`.

Its description must require:

- status callbacks survive `/bf connect` and `/bf pair` subscription replacement;
- production rediscovery performs service/protocol compatibility probing;
- bounded jitter and 30-second cap coverage;
- `/bf status` retains connection information when broker status calls fail;
- external broker replacement self-heals;
- `/bf broker stop` intentionally cancels reconnect;
- `/bf broker start` starts only the broker and instructs `/bf connect`;
- real same-port and different-port/new-token restart integrations;
- re-registration before subscription, no duplicate prompt, and no reconnect after shutdown.

Record the returned identifier as `RECONNECT_HARDENING_ISSUE`.

- [ ] **Step 5: Create the Chrome distribution issue**

Create a Medium, Backlog, self-assigned M7 issue titled `Extract Chrome extension repository and add independent Web Store delivery`.

Its description must require:

- standalone Chrome repository;
- extension source/tests/manifest/store assets moved only after parity;
- independent versioning, CI, packaging, and Web Store automation;
- generated protocol contract from the OMP-side source;
- removal of the in-repo package only after independent build and existing discovery→pairing→pick→submission e2e;
- reproducible contract sync and drift detection.

Record the returned identifier as `CHROME_SPLIT_ISSUE`.

---

### Task 3: Normalize shipped and legacy issue history

**Artifacts:**
- Modify descriptions: THA-6, THA-18, THA-108, THA-124.
- Add comments and change state: THA-9, 10, 11, 12, 15, 16, 17.

**Interfaces:**
- Consumes: new reconnect identifier from Task 2.
- Produces: no open umbrella issue whose implemented baseline overlaps a canonical v2 issue.

- [ ] **Step 1: Normalize THA-108 without reopening it**

Replace THA-108’s description with a historical delivered contract:

- goal: released self-healing reconnect core;
- delivered scope: close/error handling, bounded exponential retry/reset, rediscovery and re-registration seams, event-ID dedupe, status state, close timer cancellation;
- verification: existing focused unit safeguards and release evidence;
- residual section: link `RECONNECT_HARDENING_ISSUE` for jitter, production compatibility probing, manual-path status propagation, and real restart tests.

Keep state Done and milestone M0. Add a comment explaining that the contract was normalized after implementation audit while preserving the release record.

- [ ] **Step 2: Normalize THA-124 without reopening it**

Replace THA-124’s description with the canonical shipped contract:

- OMP opens a two-minute enrollment window;
- six-character unambiguous alphanumeric code, single-use and five-attempt limited;
- browser generates/persists `browserInstallId`;
- broker returns a lower-privilege persisted browser capability, never the root token;
- capability lists sessions/submits feedback but cannot access root-only routes;
- normal broker restart preserves pairing;
- `/bf pair reset` revokes all capabilities;
- real Chrome pairing→session→pick→feedback journey is the principal success proof.

Remove numeric-code, manual-root-token fallback, per-source 429, and ordinary-restart re-pair requirements. Keep state Done and M5. Add a comment linking residual ownership: THA-125 for popup Forget/pairing states, THA-22 for race/security coverage, THA-21/126 for restart and command e2e.

- [ ] **Step 3: Narrow THA-6 and move it to M0**

Retitle to `Broker discovery hardening: whole-range reuse, exhaustion errors, and atomic metadata`.

Description scope and success must be limited to:

- scan configured range for an already-compatible broker;
- never fall back to OS port `0` after configured-range exhaustion;
- report attempted range and exact custom-port command;
- support CLI, environment, and config-file precedence;
- atomically replace 0600 discovery metadata;
- validate stale PID/process metadata without deleting another live broker’s file;
- deterministic tests for reuse, unrelated occupied ports, exhaustion, overrides, stale PID, and concurrent discovery writes.

Assign M0; keep Backlog and High.

- [ ] **Step 4: Narrow THA-18 and move it to M2**

Retitle to `Selector robustness: stable priority, generated-class filtering, SVG, and uniqueness fixtures`.

Description must own only selector generation:

- deterministic priority: test attributes, stable ID, accessible attributes, stable attributes/classes, ancestor qualification, positional fallback;
- verify every accepted selector in its own root;
- handle duplicate IDs, generated classes, utility-class noise, nested structures, and SVG;
- do not duplicate XPath/a11y, Shadow DOM descriptor, styles, redaction, or payload-limit work;
- fixtures assert exact selector and uniqueness.

Assign M2; keep Backlog and High.

- [ ] **Step 5: Supersede seven legacy umbrellas**

For each issue, add a comment before state change, then set state `canceled`:

| Issue | Replacement comment must name |
|---|---|
| THA-9 | THA-22 and THA-124 |
| THA-10 | THA-109 |
| THA-11 | THA-112 |
| THA-12 | THA-108, THA-109, and `RECONNECT_HARDENING_ISSUE` |
| THA-15 | THA-110, THA-111, THA-124, THA-125 |
| THA-16 | THA-109, THA-116, THA-125 |
| THA-17 | THA-114, THA-115 |

Each comment must say the implemented foundation remains in source, remaining acceptance moved to the named canonical issues, and cancellation prevents duplicate implementation.

---

### Task 4: Tighten active issue contracts

**Artifacts:**
- Modify descriptions: THA-20, 21, 22, 23, 109, 110, 112, 115, 119, 120, 125, 126.
- Move THA-23 to M7.

**Interfaces:**
- Consumes: approved numeric/security/compatibility decisions.
- Produces: execution-ready active issues with non-overlapping boundaries.

- [ ] **Step 1: Tighten M0 contracts**

Update:

- **THA-109:** 15-second heartbeat, 45-second timeout or immediate WS-close disconnect, five-minute idle threshold while heartbeat remains fresh, ten-minute disconnected expiry, stable identity on reconnect, `presence` and `lastSeenAt` response fields, deterministic fake-clock tests.
- **THA-110:** Unicode-code-point field limits, UTF-8 request/container limits, client truncation only for DOM-derived values with marker included, user notes never truncated, 422 structured field errors, `413 payload_too_large` before persistence, per-boundary tests.
- **THA-112:** idempotent v2 OMP ACK by `eventId`, retain/replay until ACK, commit delivery only after ACK, atomic compaction, screenshots removed only with acknowledged event compaction/retention, and crash tests before/after ACK. For v1 OMP, use THA-216’s explicit `deliveryGuarantee: legacy` mark-on-send behavior; do not claim crash-safe replay.

- [ ] **Step 2: Tighten interaction and context contracts**

Update:

- **THA-115:** ordered `selectorSegments`, each unique in its document/shadow root; open roots only; closed roots and cross-origin iframe traversal return a clear unsupported explanation; protocol-v2 blocker.
- **THA-119:** annotations stored in normalized `[0,1]` final-image coordinates with top-left origin and burned into raster; toolbar, image, region, and protocol blockers explicit.
- **THA-120:** no capture before per-origin opt-in; 20 entries, 8 KiB per entry, 64 KiB serialized total, less than 50 ms attachment work on fixture; disabling stops collection immediately.
- **THA-125:** own popup pairing states and `Forget this browser` local cleanup, icons, session cards, badge, visual loading, focus/zoom accessibility; leave functional state/error ownership in THA-111; remove countdown ownership.

- [ ] **Step 3: Separate end-to-end ownership**

Update:

- **THA-20:** real Chrome plus two independently registered OMP targets; routing, duplicate-name isolation, ordering, reconnect, and no cross-contamination; no `/bf` command assertions.
- **THA-21:** broker range exhaustion, compatible reuse, stale discovery, external restart, capability registry preserved/lost/revoked, extension reload; expected user action explicitly differs for each recovery case.
- **THA-22:** endpoint/auth matrix, constant-time root comparison, pairing concurrent redeem/lockout/no-secret errors, DOM redaction, console opt-in privacy, traversal/oversize/WS abuse, severity policy where critical/high blocks release and lower severities require follow-up issues.
- **THA-126:** `/bf` commands, manual/auto injection, image paths, and OMP lifecycle only; `/bf pair` TUI shows code plus once-per-second countdown using broker expiry; no duplicate THA-20/21 scenarios.

- [ ] **Step 4: Make THA-23 the final release contract**

Move THA-23 to M7 and update it to require:

- clean profile with only released OMP package and Web Store Chrome extension;
- exact quickstart from install through `/bf pair`, session choice, pick, annotation, and agent image receipt;
- product versions independent from protocol compatibility;
- deterministic zip contents and manifest version equal to Chrome product release version, not protocol version;
- troubleshooting for port conflicts, discovery, pairing revocation/loss, session presence, and MV3 idle;
- privacy inventory and executable command/docs cross-check;
- blockers from M6, THA-125, and `CHROME_SPLIT_ISSUE`.

---

### Task 5: Encode the blocking graph

**Artifacts:**
- Modify Linear issue relations only.

**Interfaces:**
- Consumes: all identifiers and normalized issue ownership.
- Produces: an acyclic milestone-aligned dependency graph.

- [ ] **Step 1: Remove stale blockers and convert related-only edges**

Remove THA-6 blocker edges to canceled THA-7, THA-8, THA-9, and THA-15 after commenting on THA-6 that THA-21 owns the remaining recovery verification. Then delete `related` edges before adding these `blocks` edges:

- THA-109 blocks THA-125.
- THA-111 blocks THA-125 and THA-126.
- THA-30 blocks THA-125.

- [ ] **Step 2: Add foundation and interaction edges**

Add missing `blocks` relations:

- THA-6 → THA-21.
- THA-18 → THA-115.
- THA-109 → THA-20, THA-21.
- THA-110 → THA-113, THA-121.
- THA-112 → THA-20, THA-21.
- THA-113 → THA-30, THA-117, THA-118, THA-126; retain existing THA-113 → THA-119.
- THA-114 → THA-116.
- THA-116 → THA-120; retain its existing edges to THA-30/117/118/119.
- THA-117 → THA-119.
- `RECONNECT_HARDENING_ISSUE` → THA-21.

- [ ] **Step 3: Add protocol blocker edges**

Add `PROTOCOL_V2_ISSUE` blocks:

- THA-30, THA-112, THA-115, THA-117, THA-118, THA-119, THA-120, THA-122.

Relations block whole issues; do not encode partial-scope dependencies.

- [ ] **Step 4: Add final-release edges**

Ensure these issues block THA-23:

- THA-20, THA-21, THA-22, THA-126, THA-125, and `CHROME_SPLIT_ISSUE`.

Retain existing THA-20/21/22 → THA-23 edges and add only missing ones.

---

### Task 6: Update project-level guidance and verify

**Artifacts:**
- Modify Linear project description.
- Create temporary: `local://browser-feedback-v2-after.json`

**Interfaces:**
- Consumes: final milestone and relation graph.
- Produces: auditable proof that the Linear plan matches the approved design.

- [ ] **Step 1: Replace project description**

Set the project description to include:

- the Cursor-class product goal;
- canonical OMP-root/browser-capability trust model;
- milestone sequence M0→M7;
- execution rule that blockers are authoritative and Done issues preserve shipped history;
- current next step: finish M0, beginning with protocol migration/reconnect/discovery/presence/limits/persistence/error visibility.

Use `linear project update 38681ed776d7 --description "$DESCRIPTION"` with the multiline value passed through an environment variable.

- [ ] **Step 2: Export the final state**

Repeat Task 1’s GraphQL export and save it to `local://browser-feedback-v2-after.json`.

- [ ] **Step 3: Verify issue accounting**

Expected:

- 36 project issues: original 33 plus three new issues.
- THA-108 and THA-124 remain Done.
- THA-9/10/11/12/15/16/17 are Canceled.
- No other issue state changes.
- THA-6 and THA-18 have milestones and narrowed titles.
- THA-23 is in M7.
- M5/M6 names match the design; M7 exists once.

- [ ] **Step 4: Verify descriptions**

Programmatically assert every non-canceled open issue contains Goal, Scope, and either Success criteria or Acceptance criteria. For every description modified by this plan, also assert that observable test safeguards are present in a dedicated section or explicit acceptance bullets. Assert no description contains the obsolete THA-124 manual-root-token fallback or claims that v1 strict schemas harmlessly ignore v2 fields.

- [ ] **Step 5: Verify relation graph**

Assert all Task 5 edges exist once, no relation points from an active issue to canceled THA-9/10/11/12/15/16/17 as a blocker, and the graph is acyclic.

- [ ] **Step 6: Record a project update**

Add a project update summarizing:

- history preserved;
- superseded umbrellas canceled;
- protocol/reconnect/distribution work added;
- M0→M7 sequence encoded;
- next execution starts in M0.

If the CLI lacks project-update creation, use the Linear GraphQL API after inspecting the current schema; do not substitute an issue comment.
