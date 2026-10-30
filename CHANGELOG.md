# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-10-30

### Added

- Toggleable overlay on any page (toolbar icon or `Alt+Shift+F`). It stays on across reloads and navigation in the tab.
- Change requests that contain any number of frames and text notes, which can be reordered.
- Each frame records the full page URL (domain, path, query, hash) and title, and both are included in the prompt.
- Frame capture: select a region, then annotate it with pen, arrow, box, highlighter and text in 8 colors and 3 stroke sizes, with undo.
- For each frame: annotated, clean and full-viewport context images, plus DOM hints (selectors, test ids, labels, text).
- Saved annotations are drawn back onto the page they were captured on.
- Review & export page: inline editing, selection of CRs, live prompt preview, editable prompt template.
- ZIP export (`PROMPT.md`, `feedback.json`, `images/`), copy prompt, copy image, and export of a single CR.
