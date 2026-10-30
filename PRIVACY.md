# Privacy

Web Feedback Change Requests Note Taker runs entirely in your browser.

## What is stored

| Data | Where | When it is deleted |
| --- | --- | --- |
| Change requests: titles, notes, frame comments, page URLs and titles, region coordinates, DOM hints | `chrome.storage.local` | When you delete them on the panel or review page, or uninstall the extension |
| Screenshots: annotated, clean and context images per frame | `chrome.storage.local` | Same as above |
| Which tabs currently have the overlay on | `chrome.storage.session` | When the browser closes |

## What is sent anywhere

Nothing. The extension makes no network requests, has no analytics or telemetry, and needs no account.
Data leaves your browser only when **you** download an export ZIP or copy a prompt or image to the clipboard.

Screenshots can contain whatever is on the page, such as customer data on a staging system. Check an export before you share it.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `<all_urls>` (host permission) | To inject the overlay into the page you choose and to take screenshots with `captureVisibleTab` after you navigate, without clicking the icon again. The overlay is only injected into tabs where you turned it on. |
| `scripting` | To inject the overlay script. |
| `activeTab` | To act on the current tab when you click the icon or use a shortcut. |
| `storage`, `unlimitedStorage` | To keep change requests and screenshots locally. Screenshots can exceed the default quota. |
| `contextMenus` | For the *Review & export change requests* entry on the extension icon. |
