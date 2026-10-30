# Contributing

Thanks for helping improve Web Feedback Change Requests Note Taker!

## Getting started

1. Fork and clone the repository.
2. Load it unpacked in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → select the repo folder.
3. Make your change. Then click ↻ on the extension card and turn the overlay off and on again in the tab you are testing.
4. Run the tests:
   ```sh
   npm test
   ```

There is no build step: the files in `src/` are exactly what Chrome loads.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/background.js` | Service worker: toggling, re-injection, screenshots |
| `src/content/overlay.js` | The injected UI. It is a *classic* script (content scripts cannot import modules), so it is self-contained. |
| `src/review/` | Review & export page (ES modules) |
| `src/lib/` | Pure modules shared with tests: prompt generation, ZIP writer, storage keys |
| `test/` | `node --test` unit tests |
| `docs/` | README screenshots and an example export |

## Guidelines

- **Keep it dependency-free.** Anyone should be able to load the repo unpacked without installing anything.
- **Keep `src/lib/` pure** (no `chrome.*` calls) so it stays unit-testable. Add or extend tests for any change there.
- **Storage format:** if you change the shape of `wfcr:state`, keep reading old data, because existing users have saved change requests.
- **Overlay UI** stays inside the shadow root. Never add global styles or listeners to the host page that remain after the overlay is turned off.
- Match the existing code style: 2-space indentation, single quotes, semicolons, small functions.

## Reporting bugs

Please include the browser and version, the page type (for example a React SPA on localhost), the steps to reproduce, and any errors from the extension's service worker console (`chrome://extensions` → *Inspect views: service worker*) or the page console.
