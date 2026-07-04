# Standalone Publishing and Chrome Repo Split Design

Date: 2026-07-04
Project: omp-browser-feedback
Status: Approved in chat, pending written-spec review

## Goal

Fix publishing by collapsing the OMP side to one public npm package, then split the Chrome extension into its own repository so Chrome Web Store releases and versioning can move independently.

## Decisions

1. The public OMP install surface will be **one npm package**.
2. That OMP package will **own and start the local broker runtime**.
3. The Chrome extension will be distributed through the **Chrome Web Store** as a normal browser extension.
4. The Chrome extension should eventually move to its own repository at `~/Documents/omp-browser-feedback-chrome-extension`.
5. The Chrome repo split is mainly to support **independent releases/version management**.
6. The Chrome repo split should **not** use a git submodule, subtree, or other embedded-repo arrangement as the long-term architecture.

7. “Standalone” means **one self-contained browser-feedback package for OMP**, not a package that runs without OMP itself. The package will continue to integrate with OMP through `@oh-my-pi/pi-coding-agent`.

## Current State

The repo currently has four workspace packages:

- `packages/browser-omp-extension`
- `packages/browser-broker`
- `packages/browser-protocol`
- `packages/browser-extension`

Current `release.yml` publishes three npm packages:

- `@oh-my-pi/browser-protocol`
- `@oh-my-pi/browser-broker`
- `@oh-my-pi/browser-omp-extension`

The OMP package currently imports broker/protocol code from separate workspace packages. The Chrome extension mostly communicates with the broker over the wire protocol and is already a distinct product boundary.

The OMP package also has a peer dependency on `@oh-my-pi/pi-coding-agent`. That dependency is intentional and remains part of the target design because the package is an OMP extension. The standalone requirement is about removing separate browser-feedback package installs, not removing the OMP host dependency.

## Target Product Boundary

### OMP side

There will be one public npm package for OMP users.

That package contains:

- the OMP extension entry
- broker lifecycle/startup
- broker server implementation
- protocol types/validation required by that runtime

It still requires the OMP host integration surface provided by `@oh-my-pi/pi-coding-agent`. In other words, the package becomes standalone **within the browser-feedback product line**, but it is not intended to run outside an OMP installation.

`browser-broker` and `browser-protocol` stop being public release artifacts. During migration they may remain as workspace modules, but they become internal implementation details rather than separate public products.

### Chrome side

The Chrome extension becomes a separate browser product:

- installed from the Chrome Web Store
- versioned independently
- released independently
- hosted in its own repository at `~/Documents/omp-browser-feedback-chrome-extension`

That repo owns:

- `manifest.json`
- popup/background/content scripts
- store assets
- Chrome-specific CI and release automation

### Protocol boundary

The stable seam between the products remains the broker wire contract:

- broker discovery
- session listing
- feedback submission
- auth token usage
- screenshot payload rules
- protocol version compatibility

The protocol stays shared, but it does **not** imply three public npm packages.

## Recommended Approach

### Phase 1: Fix publishing in the current repo

Do not split repositories first. First simplify the publish surface.

#### Phase 1 changes

1. Change the release workflow to publish only the OMP package.
2. Stop public publishing of `browser-broker` and `browser-protocol`.
3. Make the OMP package self-contained so install/use does not require separately published broker/protocol packages.
4. Rename the public package away from the `@oh-my-pi/*` scope as part of the standalone cutover. The exact package name will be chosen in the implementation plan.
5. Keep the Chrome extension in this repo temporarily while phase 1 lands.

#### Why phase 1 comes first

If repo-split work and publish-surface work happen together, there are two moving boundaries at once:

- package boundaries
- repository boundaries

That increases release risk. The safer order is:

1. collapse to one public OMP package
2. verify it works
3. then extract the Chrome repo

### Phase 2: Extract the Chrome extension repo

After phase 1 is stable:

1. create `~/Documents/omp-browser-feedback-chrome-extension`
2. move `packages/browser-extension` there
3. give it independent versioning and CI
4. add Chrome Web Store release automation there
5. remove the old in-repo Chrome package after the new repo is verified

## Protocol Sharing Strategy

### Recommendation

Use **one source of truth with explicit sync**, not a submodule.

### Source of truth

Initially, keep the protocol source of truth on the OMP/plugin side because the broker and OMP runtime own the authoritative server/client contract.

### Preferred sync model

Generate a small contract snapshot for the Chrome repo containing the items it needs, such as:

- TypeScript types
- validators or JSON schema if needed
- protocol version constant
- endpoint/auth metadata

That generated artifact is then synced into the Chrome repo by script or release automation.

### Temporary migration fallback

A temporary shared package dependency is acceptable only during migration if it reduces risk, but it should not become the steady-state architecture because it reintroduces the multi-package public surface we are trying to remove.

### Explicitly rejected

The long-term design rejects:

- git submodules
- subtree-based coupling as the primary sharing mechanism
- unmanaged copy/paste
- two independent protocol sources of truth

## Versioning and Release Model

### OMP/plugin repo

Owns:

- one npm package
- broker runtime
- protocol source of truth

Release when:

- OMP install behavior changes
- broker/runtime behavior changes
- protocol changes require plugin-side release

### Chrome repo

Owns:

- Chrome extension code
- manifest version
- store assets/release notes

Release when:

- browser UX/behavior changes
- Chrome-specific permissions/manifest/store packaging changes
- protocol-compatible browser changes ship independently

### Compatibility rule

Compatibility must remain explicit through the protocol version constant and runtime compatibility checks so separate release cadences do not silently drift into breakage.

## Concrete Implementation Shape

### Phase 1 implementation shape

1. Update `release.yml` to publish only the OMP package.
2. Change package boundaries so the published OMP artifact is self-contained.
3. Keep workspace layout temporarily if it helps development, but mark broker/protocol packages as non-published/internal.
4. Rename the public package if desired.
5. Validate the release artifact in a clean environment.

### Phase 2 implementation shape

1. Create the new Chrome repo.
2. Move browser-extension sources there.
3. Add protocol snapshot generation/sync.
4. Add independent CI and Chrome Web Store release flow.
5. Remove the in-repo Chrome package after parity verification.

## Risks and Mitigations

### Risk: the “standalone” package still depends on old published packages

Mitigation: inspect the packed release artifact and do a clean install smoke test outside the workspace.

### Risk: protocol drift after repo split

Mitigation: single source of truth plus generated/synced contract artifact plus compatibility checks.

### Risk: repo split slows the urgent publishing fix

Mitigation: phase the work. Publish-surface fix first, repo extraction second.

### Risk: submodule makes releases harder rather than easier

Mitigation: do not use a submodule/subrepo architecture.

## Verification Requirements

Before phase 1 is complete:

1. `bun run build:omp-extension`
2. release-artifact inspection showing the OMP package is self-contained
3. clean-environment install of the published-style package
4. OMP smoke test proving `/bf` registers and broker starts from the single package
5. Chrome-extension smoke test proving discovery, session listing, and feedback submission still work

Before phase 2 is complete:

1. Chrome repo builds independently
2. protocol sync/generation is reproducible
3. Chrome extension release/version flow works without npm-package release coupling
4. old in-repo Chrome package is removed only after parity is confirmed

## Summary

Recommended sequence:

1. Fix npm publishing by collapsing to one public OMP package.
2. Keep broker ownership inside that package.
3. Move the Chrome extension to its own repository afterward.
4. Do not use a submodule/subrepo for the split.
5. Share protocol through one source of truth and explicit generated/synced contract artifacts.
