# Chrome Web Store Listing

## Store name

OMP Browser Feedback

## Short description

Pick any element on a web page and send feedback to your OMP coding agent — without leaving the terminal.

## Detailed description

OMP Browser Feedback connects your browser to an active Oh My Pi (OMP) coding session. Click any element on a web page, annotate it with instructions, and the agent receives a structured prompt it can act on immediately.

**How it works:**

1. Install this extension and the `omp-browser-feedback` OMP package.
2. Start an OMP session in your project directory.
3. Run `/bf pair` in OMP to get a pairing code.
4. Click the extension icon, enter the code, and select your session.
5. Click "Pick element" — a crosshair cursor appears.
6. Click any element on the page. The agent receives the element selector, HTML context, accessibility tree, and your annotation.

**Features:**

- DOM element picker with unique CSS selector generation
- Element context capture (attributes, computed styles, accessibility)
- Cropped screenshots around selected elements
- Optional annotation notes
- Session routing — multiple OMP sessions supported
- Auto-run mode for hands-free feedback
- All traffic stays on your machine (loopback only)

**Requires:**

- Oh My Pi (OMP) coding agent running in a terminal
- The `omp-browser-feedback` npm package (`bun add omp-browser-feedback`)

## Category

Developer Tools

## Language

English

## Permission justifications

| Permission | Justification |
|------------|---------------|
| `activeTab` | Required to access the current tab's DOM when the user clicks the extension icon. No background tab monitoring. |
| `scripting` | Required to inject the element picker overlay into the page on demand. |
| `storage` | Required to persist the broker connection URL, browser capability token, and selected session across popup opens. |
| `tabs` | Required to capture screenshots of the visible tab via `chrome.tabs.captureVisibleTab`. |
| `host_permissions: http://127.0.0.1:*/*` | Required to communicate with the locally-running OMP browser broker on loopback. No external network access. |

## Privacy practices

- **Data collection**: The extension captures DOM element data (selector, HTML, attributes, styles, accessibility) and optional screenshots only when the user actively clicks an element with the picker enabled.
- **Data usage**: Captured data is sent to a local broker (127.0.0.1) and forwarded to an active OMP session. No data leaves the user's machine.
- **Data storage**: Broker URL and capability token stored in `chrome.storage.local`. Screenshots stored in `/tmp/omp-browser-screenshots/` until broker shutdown. Feedback events are in-memory only.
- **Remote code execution**: None. The extension runs only its bundled code.
- **Third-party data sharing**: None. All communication is loopback-only.

## Screenshots

_Required for store submission. Capture these from a working install:_

1. **Popup with session list** — The extension popup showing paired sessions.
2. **Picker overlay** — The crosshair cursor active on a sample page.
3. **Element highlight** — An element highlighted by the picker.
4. **Agent prompt** — The OMP terminal showing received feedback.

## Release notes template

```
## [version] - [date]

### What's new
- [feature or fix]

### Compatibility
- Protocol version: [N]
- Requires omp-browser-feedback >= [version]
```

## Support link

https://github.com/tlarevo/omp-browser-feedback/issues

## Homepage

https://omp.sh
