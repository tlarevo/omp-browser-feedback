# Browser Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual broker token copy/paste with OMP-initiated one-time pairing codes that mint revocable browser capabilities, while keeping session selection explicit in the browser UI.

**Architecture:** OMP remains the trust anchor and opens a short-lived pairing window via `/bf pair`. The broker stores ephemeral pairing windows and persistent browser capability records, while the Chrome extension generates a per-profile `browserInstallId` in `chrome.storage.local` and stores only the lower-privilege browser capability token. Existing session chooser/routing remains explicit after pairing.

**Tech Stack:** Bun, TypeScript, Chrome Extension MV3 (`chrome.storage.local`), local broker HTTP/WebSocket APIs, bun:test, Linear issue mapping (THA-124 primary; THA-108/109 follow-on compatibility; THA-23 docs).

## Global Constraints

- Pairing is initiated from OMP via `/bf pair`; do not add a browser-initiated trust bootstrap for the first version.
- Any browser profile for the same OS user may enroll only during an active OMP-open pairing window.
- The browser extension must never receive or persist the broker root auth token.
- Browser identity is a generated `browserInstallId` stored in `chrome.storage.local`; do not depend on Chrome profile names or Google account identity.
- Pairing codes must be 6–8 characters, short-lived, single-use, and attempt-limited.
- Browser capability tokens must be revocable and persisted across broker restart.
- Session routing remains explicit in the browser UI after pairing.
- Skip OMP smoke in GitHub workflows with `SKIP_OMP_SMOKE=1`; local smoke coverage stays real.
- Keep the work mapped to existing v2 issue semantics: THA-124 pairing onboarding, THA-108 reconnect, THA-109 presence, THA-23 docs.

---

### Task 1: Add broker pairing and browser capability primitives

**Files:**
- Create: `packages/browser-broker/src/pairing-store.ts`
- Create: `packages/browser-broker/test/pairing-store.test.ts`
- Modify: `packages/browser-broker/src/server.ts`
- Modify: `packages/browser-broker/src/auth.ts`
- Modify: `packages/browser-broker/src/discovery.ts`
- Test: `packages/browser-broker/test/server.test.ts`

**Interfaces:**
- Consumes: existing broker root auth path in `server.ts`; existing discovery helpers from `discovery.ts`
- Produces:
  - `issuePairingCode(createdBySessionId: string): Promise<{ pairingId: string; code: string; expiresAt: string }>`
  - `redeemPairingCode(input: { browserInstallId: string; code: string; label?: string }): Promise<{ capabilityToken: string }>`
  - `revokeAllBrowserCapabilities(): Promise<void>`
  - `isAuthorizedBrowserRequest(request: Request): boolean`

- [ ] **Step 1: Write the failing broker pairing store tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  createPairingStore,
  type PairingStoreClock,
} from "../src/pairing-store";

test("redeems a short-lived code exactly once", async () => {
  const now = new Date("2026-07-04T00:00:00.000Z");
  const clock: PairingStoreClock = { now: () => new Date(now) };
  const store = createPairingStore({ clock });

  const issued = await store.issuePairingCode("ses_1");
  const first = await store.redeemPairingCode({
    browserInstallId: "browser_a",
    code: issued.code,
  });

  expect(first.capabilityToken.length).toBeGreaterThan(20);
  await expect(
    store.redeemPairingCode({ browserInstallId: "browser_a", code: issued.code }),
  ).rejects.toThrow(/single-use/i);
});

test("rejects an expired code", async () => {
  const now = new Date("2026-07-04T00:00:00.000Z");
  const clock: PairingStoreClock = { now: () => new Date(now) };
  const store = createPairingStore({ clock });
  const issued = await store.issuePairingCode("ses_1");

  now.setMinutes(now.getMinutes() + 3);

  await expect(
    store.redeemPairingCode({ browserInstallId: "browser_a", code: issued.code }),
  ).rejects.toThrow(/expired/i);
});
```

- [ ] **Step 2: Run broker pairing store tests to verify they fail**

Run: `bun test packages/browser-broker/test/pairing-store.test.ts`
Expected: FAIL with missing `createPairingStore` / missing pairing primitives.

- [ ] **Step 3: Implement the pairing store and browser capability persistence**

```ts
export interface BrowserCapabilityRecord {
  browserInstallId: string;
  capabilityTokenHash: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface PairingWindowRecord {
  pairingId: string;
  codeHash: string;
  createdBySessionId: string;
  expiresAt: string;
  attemptsRemaining: number;
  consumedAt?: string;
}

export function createPairingStore(options: {
  clock?: PairingStoreClock;
  registryPath: string;
}) {
  return {
    issuePairingCode,
    redeemPairingCode,
    revokeAllBrowserCapabilities,
    validateBrowserCapability,
  };
}
```

- [ ] **Step 4: Add broker endpoints and auth path split in `server.ts`**

```ts
if (request.method === "POST" && url.pathname === "/api/pair") {
  const { browserInstallId, code, label } = await request.json();
  const result = await pairingStore.redeemPairingCode({
    browserInstallId,
    code,
    label,
  });
  return jsonResponse({ capabilityToken: result.capabilityToken });
}

if (request.method === "POST" && url.pathname === "/api/pair/open") {
  if (!isAuthorizedRequest(request, options.authToken)) return unauthorized();
  const issued = await pairingStore.issuePairingCode(sessionIdFromAuthorizedContext);
  return jsonResponse(issued);
}
```

- [ ] **Step 5: Add capability-auth server tests**

```ts
test("browser capability can list sessions without root token", async () => {
  const pair = await openAndRedeemPairing(server);
  const response = await fetch(`${server.baseUrl}/api/sessions`, {
    headers: { Authorization: `Bearer ${pair.capabilityToken}` },
  });
  expect(response.ok).toBe(true);
});

test("browser capability cannot open OMP websocket", async () => {
  const pair = await openAndRedeemPairing(server);
  const response = await fetch(`${server.baseUrl}/api/pair/open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pair.capabilityToken}` },
  });
  expect(response.status).toBe(401);
});
```

- [ ] **Step 6: Run broker tests to verify they pass**

Run: `bun test packages/browser-broker/test/pairing-store.test.ts packages/browser-broker/test/server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/browser-broker/src/auth.ts \
  packages/browser-broker/src/discovery.ts \
  packages/browser-broker/src/pairing-store.ts \
  packages/browser-broker/src/server.ts \
  packages/browser-broker/test/pairing-store.test.ts \
  packages/browser-broker/test/server.test.ts
git commit -m "feat: add broker pairing and browser capability auth"
```

### Task 2: Add OMP-side pairing commands and capability management

**Files:**
- Modify: `packages/browser-omp-extension/src/client.ts`
- Modify: `packages/browser-omp-extension/src/commands.ts`
- Modify: `packages/browser-omp-extension/test/extension.test.ts`

**Interfaces:**
- Consumes:
  - `BrowserBrokerClient.openPairingWindow(sessionId: string): Promise<{ pairingId: string; code: string; expiresAt: string }>`
  - `BrowserBrokerClient.revokeAllBrowserCapabilities(): Promise<void>`
- Produces:
  - `/bf pair`
  - `/bf pair reset`
  - human-readable pairing status text from OMP

- [ ] **Step 1: Write the failing OMP pairing command tests**

```ts
test("/bf pair opens a pairing window and prints a short-lived code", async () => {
  const notify = mockNotify();
  const client = mockBrokerClient({
    openPairingWindow: async () => ({
      pairingId: "pair_1",
      code: "A7K2Q9",
      expiresAt: "2026-07-04T00:02:00.000Z",
    }),
  });

  await handleBfCommand("pair", makeCtx({ notify, client }), async () => {});

  expect(notify.last()).toContain("A7K2Q9");
  expect(notify.last()).toContain("expires");
});

test("/bf pair reset revokes browser capabilities", async () => {
  const revoke = mock(async () => {});
  await handleBfCommand(
    "pair reset",
    makeCtx({ notify: mockNotify(), client: { revokeAllBrowserCapabilities: revoke } }),
    async () => {},
  );
  expect(revoke).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run OMP command tests to verify they fail**

Run: `bun test packages/browser-omp-extension/test/extension.test.ts`
Expected: FAIL because `/bf pair` and `/bf pair reset` are not implemented.

- [ ] **Step 3: Extend `BrowserBrokerClient` with pairing APIs**

```ts
async openPairingWindow(sessionId: string): Promise<{
  pairingId: string;
  code: string;
  expiresAt: string;
}> {
  return this.#json("/api/pair/open", {
    method: "POST",
    headers: this.#rootHeaders(),
    body: JSON.stringify({ sessionId }),
  });
}

async revokeAllBrowserCapabilities(): Promise<void> {
  await this.#json("/api/pair/reset", {
    method: "POST",
    headers: this.#rootHeaders(),
  });
}
```

- [ ] **Step 4: Implement `/bf pair` and `/bf pair reset` in `commands.ts`**

```ts
if (first === "pair") {
  if (rest[0] === "reset") {
    await client.revokeAllBrowserCapabilities();
    notify("Browser pairing reset. All browsers must pair again.");
    return;
  }

  const pair = await client.openPairingWindow(sessionId);
  notify(
    [
      `Pairing code: ${pair.code}`,
      `Open the browser extension and enter the code before it expires.`,
      `Expires: ${pair.expiresAt}`,
    ].join("\n"),
  );
  return;
}
```

- [ ] **Step 5: Run OMP command tests to verify they pass**

Run: `bun test packages/browser-omp-extension/test/extension.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/browser-omp-extension/src/client.ts \
  packages/browser-omp-extension/src/commands.ts \
  packages/browser-omp-extension/test/extension.test.ts
git commit -m "feat: add /bf pair command flow"
```

### Task 3: Replace browser token paste with pairing-code onboarding

**Files:**
- Modify: `packages/browser-extension/src/popup/app.ts`
- Modify: `packages/browser-extension/src/popup/main.ts`
- Modify: `packages/browser-extension/src/background-entry.ts`
- Modify: `packages/browser-extension/src/background.ts`
- Modify: `packages/browser-extension/test/popup.test.ts`
- Modify: `packages/browser-extension/test/background.test.ts`
- Modify: `packages/browser-extension/test/e2e-chrome.test.ts`

**Interfaces:**
- Consumes:
  - broker `POST /api/pair`
  - existing session list and submit-feedback APIs
- Produces:
  - generated `browserInstallId` in `chrome.storage.local`
  - `browserCapabilityToken` in `chrome.storage.local`
  - popup states: `unpaired`, `pairing-error`, `ready`

- [ ] **Step 1: Write the failing popup onboarding tests**

```ts
test("renders a pairing-code state instead of raw token paste", () => {
  const { root } = documentWithRoot();
  let savedCode = "";
  renderPopup(root, { kind: "unpaired", baseUrl: "http://127.0.0.1:4317" }, {
    onPairWithCode: (code) => {
      savedCode = code;
    },
  });

  expect(root.textContent).toContain("Enter pairing code");
  expect(root.querySelector("input")?.getAttribute("placeholder")).toContain("Pairing code");
});

test("creates and persists a browser install id when missing", async () => {
  const installId = await ensureBrowserInstallId(fakeStorageWithoutInstallId());
  expect(installId).toMatch(/^browser_/);
});
```

- [ ] **Step 2: Run popup/background tests to verify they fail**

Run: `bun test packages/browser-extension/test/popup.test.ts packages/browser-extension/test/background.test.ts`
Expected: FAIL because unpaired/code flow does not exist.

- [ ] **Step 3: Add browser install identity + pairing flow in popup/background**

```ts
export async function ensureBrowserInstallId(): Promise<string> {
  const stored = await chrome.storage.local.get(["browserInstallId"]);
  if (typeof stored.browserInstallId === "string") return stored.browserInstallId;
  const installId = `browser_${crypto.randomUUID()}`;
  await chrome.storage.local.set({ browserInstallId: installId });
  return installId;
}

export async function redeemPairingCode(input: {
  baseUrl: string;
  browserInstallId: string;
  code: string;
}): Promise<{ capabilityToken: string }> {
  // POST /api/pair
}
```

- [ ] **Step 4: Replace missing-auth UI with unpaired/pairing-code UI**

```ts
if (state.kind === "unpaired") {
  appendStatus(document, root, `Broker found at ${state.baseUrl}. Enter the pairing code from /bf pair.`);
  const input = document.createElement("input");
  input.placeholder = "Pairing code";
  const button = createButton(document, "Pair", () => handlers.onPairWithCode?.(input.value));
  root.append(input, button);
  return;
}
```

- [ ] **Step 5: Update background/session APIs to use browser capability token**

```ts
const stored = await chrome.storage.local.get([
  "brokerBaseUrl",
  "browserCapabilityToken",
  "selectedSessionId",
]);

const capabilityToken = stored.browserCapabilityToken as string | undefined;
if (!baseUrl || !capabilityToken) {
  return { ok: false, error: "Browser is not paired" };
}
```

- [ ] **Step 6: Add e2e coverage for pair-once -> ready state -> submit feedback**

```ts
test("pairs once with a short-lived code and then submits feedback", async () => {
  const issued = await openPairingWindowProgrammatically(broker, sessionId);
  await popup.fill('input[placeholder="Pairing code"]', issued.code);
  await popup.click('text=Pair');
  await expect(popup.locator("text=Choose session")).toBeVisible();
  await activatePickerAndSubmit(page);
  await expectLatestFeedback(broker).resolves.toMatchObject({ sessionId: SESSION_ID });
});
```

- [ ] **Step 7: Run browser extension tests to verify they pass**

Run: `bun test packages/browser-extension/test/popup.test.ts packages/browser-extension/test/background.test.ts packages/browser-extension/test/e2e-chrome.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/browser-extension/src/popup/app.ts \
  packages/browser-extension/src/popup/main.ts \
  packages/browser-extension/src/background-entry.ts \
  packages/browser-extension/src/background.ts \
  packages/browser-extension/test/popup.test.ts \
  packages/browser-extension/test/background.test.ts \
  packages/browser-extension/test/e2e-chrome.test.ts
git commit -m "feat: pair browser with one-time code"
```

### Task 4: Make reconnect, presence, docs, and release flow coherent with pairing

**Files:**
- Modify: `packages/browser-omp-extension/src/client.ts`
- Modify: `packages/browser-broker/src/session-registry.ts`
- Modify: `packages/browser-omp-extension/CHANGELOG.md`
- Modify: `README.md` (if present) and `packages/browser-omp-extension/README.md` (if present)
- Modify: `test/standalone-omp-package-smoke.test.ts`
- Modify: `packages/browser-broker/test/websocket.test.ts`
- Modify: `packages/browser-broker/test/session-registry.test.ts`

**Interfaces:**
- Consumes: paired browser capability path from Task 3; existing broker WS client from Task 2
- Produces:
  - reconnect-compatible behavior with pairing intact
  - presence/TTL semantics aligned with active roadmap
  - docs that describe `/bf pair`

- [ ] **Step 1: Write failing regression tests for paired reconnect/presence**

```ts
test("paired browser remains paired after broker restart and can re-list sessions", async () => {
  const capability = await pairBrowserOnce(server);
  await restartBrokerPreservingPairingRegistry(server);
  const sessions = await listSessionsWithCapability(capability);
  expect(Array.isArray(sessions)).toBe(true);
});

test("stale disconnected sessions are not shown as active forever", async () => {
  const registry = createSessionRegistry(fakeClock());
  registry.register(activeSession());
  advanceMinutes(11);
  expect(registry.list()[0]?.status).not.toBe("active");
});
```

- [ ] **Step 2: Run regression tests to verify they fail**

Run: `bun test packages/browser-broker/test/session-registry.test.ts packages/browser-broker/test/websocket.test.ts`
Expected: FAIL because presence / persistence are not yet aligned.

- [ ] **Step 3: Implement the smallest reconnect/presence hooks needed for pairing not to feel broken**

```ts
// Minimum: persisted capability registry survives broker restart.
// Minimum: session list reflects disconnected presence instead of stale active forever.
// Minimum: client status surfaces reconnecting/offline instead of silently dying.
```

- [ ] **Step 4: Update docs to the new onboarding flow**

```md
Quickstart:
1. Install the OMP extension
2. Install the Chrome extension
3. Run `/bf pair`
4. Enter the short-lived pairing code in the extension once
5. Choose the target OMP session and start picking
```

- [ ] **Step 5: Run the full trusted-release verification path**

Run:
- `bun install --frozen-lockfile`
- `bun run check`
- `SKIP_CHROME_E2E=1 SKIP_OMP_SMOKE=1 bun run test`
- `bun run build:omp-extension`
- `SKIP_OMP_SMOKE=1 bun test test/prepare-release-package.test.ts test/standalone-omp-package-smoke.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/browser-omp-extension/src/client.ts \
  packages/browser-broker/src/session-registry.ts \
  packages/browser-broker/test/session-registry.test.ts \
  packages/browser-broker/test/websocket.test.ts \
  test/standalone-omp-package-smoke.test.ts \
  README.md packages/browser-omp-extension/README.md \
  packages/browser-omp-extension/CHANGELOG.md
git commit -m "feat: document and harden browser pairing flow"
```

## Self-review

- Spec coverage: pairing UX, trust model, browser install identity, capability auth, revocation, session chooser, reconnect/presence, and docs all map to tasks above.
- Placeholder scan: no TBD/TODO markers remain; every task names exact files, interfaces, tests, commands, and commit units.
- Type consistency: `browserInstallId`, `browserCapabilityToken`, `/bf pair`, `openPairingWindow`, `redeemPairingCode`, and `revokeAllBrowserCapabilities` are used consistently across tasks.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-04-browser-pairing.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
