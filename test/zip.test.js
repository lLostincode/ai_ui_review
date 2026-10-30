import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, createZip, dataUrlToBytes } from '../src/lib/zip.js';

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('createZip produces an archive that unzip can verify and extract', (t) => {
  let hasUnzip = true;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { hasUnzip = false; }
  if (!hasUnzip) return t.skip('unzip not installed');

  const binary = new Uint8Array(1000).map((_, i) => (i * 7) % 256);
  const zip = createZip([
    { path: 'out/PROMPT.md', data: '# Hällo\n' },
    { path: 'out/images/a.png', data: binary },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'wfcr-zip-'));
  writeFileSync(join(dir, 'x.zip'), zip);
  execFileSync('unzip', ['-tq', 'x.zip'], { cwd: dir });
  execFileSync('unzip', ['-q', 'x.zip'], { cwd: dir });
  assert.equal(readFileSync(join(dir, 'out/PROMPT.md'), 'utf8'), '# Hällo\n');
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'out/images/a.png'))), binary);
});

test('dataUrlToBytes decodes base64 payloads', () => {
  assert.deepEqual([...dataUrlToBytes('data:image/png;base64,AAEC/w==')], [0, 1, 2, 255]);
});
