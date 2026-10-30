// Builds the downloadable extension ZIP and its release notes:
//   dist/web-feedback-cr-v<version>.zip   (one folder inside, ready for "Load unpacked")
//   dist/RELEASE_NOTES.md                 (CHANGELOG section + install steps)
// Run: node tools/package.mjs   — used by `npm run package` and the release workflow.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createZip } from '../src/lib/zip.js';

const ROOT = new URL('..', import.meta.url).pathname;
const INCLUDE = ['manifest.json', 'icons', 'src', 'README.md', 'LICENSE', 'PRIVACY.md'];

const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const name = `web-feedback-cr-v${version}`;

function walk(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap((entry) => walk(join(path, entry)));
}

const files = INCLUDE.flatMap((entry) => walk(join(ROOT, entry))).map((path) => ({
  path: `${name}/${relative(ROOT, path)}`,
  data: new Uint8Array(readFileSync(path)),
}));

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const zipPath = join(ROOT, 'dist', `${name}.zip`);
writeFileSync(zipPath, createZip(files));

// "## [0.1.0] - 2026-10-30" up to the next "## [" heading.
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const section = changelog.split(/^## /m).find((part) => part.startsWith(`[${version}]`));
if (!section) throw new Error(`CHANGELOG.md has no section for ${version}`);
const changes = section.slice(section.indexOf('\n') + 1).trim();

writeFileSync(
  join(ROOT, 'dist', 'RELEASE_NOTES.md'),
  `## Install

1. Download **${name}.zip** below and unzip it.
2. Open \`chrome://extensions\` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped \`${name}\` folder.
4. Pin the extension, open your app and press **Alt+Shift+F**.

To update, remove the old version (or replace the folder's contents), then click ↻ on the extension card.

## Changes

${changes}
`,
);

console.log(`${relative(ROOT, zipPath)} (${files.length} files)`);
