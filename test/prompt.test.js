import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, crLabel, exportFolderName, exportLabelFor } from '../src/lib/prompt.js';

const frame = (id, url, extra = {}) => ({
  id,
  type: 'frame',
  url,
  pageTitle: 'Settings',
  note: 'Padding missing here',
  docRect: { x: 10, y: 400, w: 300, h: 120 },
  viewport: { w: 1440, h: 900, dpr: 2 },
  annotations: { counts: { text: 1 }, texts: ['remove this'] },
  images: { annotated: id + '-a', clean: id + '-c', context: id + '-x', overlay: id + '-o' },
  dom: {
    container: { selector: 'main > section.card', text: 'Billing' },
    center: { selector: 'button.btn', text: 'Save', testId: 'save-btn' },
    elements: [
      { selector: 'button.btn', text: 'Save', testId: 'save-btn' },
      { selector: 'button.btn > svg.icon-chevron' },
      { selector: 'label.field', text: 'Plan' },
    ],
  },
  ...extra,
});

const state = {
  projectName: 'Portal',
  promptTemplate: null,
  requests: [
    {
      id: 'r1',
      number: 1,
      title: 'Fix settings card',
      items: [frame('f1', 'http://localhost:3000/settings'), { id: 't1', type: 'text', text: 'Also rename\n"Save" to "Apply"' }],
    },
    { id: 'r2', number: 2, title: '', items: [frame('f2', 'https://staging.example.com/#/home', { note: '' })] },
  ],
};

test('crLabel pads numbers', () => {
  assert.equal(crLabel(7), 'CR-007');
});

test('buildExport renders every request with image references and DOM hints', () => {
  const { markdown, images, data } = buildExport(state, { date: new Date('2026-10-29T12:00:00Z') });
  assert.match(markdown, /^# UI change requests — Portal/);
  assert.match(markdown, /http:\/\/localhost:3000, https:\/\/staging\.example\.com/);
  assert.match(markdown, /## CR-001: Fix settings card/);
  assert.match(markdown, /## CR-002: Untitled change request/);
  assert.match(markdown, /!\[CR-001 frame 1, annotated\]\(images\/CR-001-1-annotated\.png\)/);
  assert.match(markdown, /> Also rename\n> "Save" to "Apply"/);
  assert.match(markdown, /- "remove this"/);
  assert.match(markdown, /test id `save-btn`/);
  assert.match(markdown, /Frame on `\/#\/home`/);
  assert.match(markdown, /`label\.field` — "Plan"/);
  assert.doesNotMatch(markdown, /icon-chevron/, 'unlabelled icons are dropped');
  assert.equal(images.length, 6);
  assert.deepEqual(images[0], { path: 'images/CR-001-1-annotated.png', imageId: 'f1-a' });
  assert.equal(data.requests[0].items[0].images.context, 'images/CR-001-1-context.jpg');
  assert.ok(!images.some((i) => i.imageId.endsWith('-o')), 'on-page overlay layer is not exported');
});

test('buildExport respects selection and options', () => {
  const { markdown, images } = buildExport(state, {
    requestIds: ['r2'],
    includeClean: false,
    includeContext: false,
    includeDomHints: false,
  });
  assert.doesNotMatch(markdown, /CR-001/);
  assert.doesNotMatch(markdown, /- DOM hints:/);
  assert.deepEqual(images.map((i) => i.path), ['images/CR-002-1-annotated.png']);
});

test('custom templates substitute placeholders and append requests when missing', () => {
  const withPlaceholder = buildExport({ ...state, promptTemplate: 'Fix {{count}} things for {{project}}:\n{{requests}}' });
  assert.match(withPlaceholder.markdown, /^Fix 2 things for Portal:\n## CR-001/);
  const without = buildExport({ ...state, promptTemplate: 'Just do it. {{unknown}}' });
  assert.match(without.markdown, /^Just do it\. \{\{unknown\}\}\n\n## CR-001/);
});

test('export names are filesystem friendly', () => {
  assert.equal(exportFolderName(new Date(2026, 9, 29, 9, 5), 'portal'), 'portal-2026-10-29-0905');
  assert.equal(exportLabelFor(state, ['r1']), 'cr-001-fix-settings-card');
  assert.equal(exportLabelFor(state, ['r1', 'r2']), 'portal');
});
