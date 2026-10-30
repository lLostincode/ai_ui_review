import { loadState, mutate, getImages, imageIdsOf, removeImages, STATE_KEY } from '../lib/store.js';
import { buildExport, crLabel, DEFAULT_TEMPLATE, exportFolderName, exportLabelFor } from '../lib/prompt.js';
import { createZip, dataUrlToBytes } from '../lib/zip.js';

const $ = (id) => document.getElementById(id);
const els = {
  requests: $('requests'),
  project: $('project-name'),
  stats: $('stats'),
  selectedCount: $('selected-count'),
  template: $('template'),
  preview: $('preview'),
  optClean: $('opt-clean'),
  optContext: $('opt-context'),
  optDom: $('opt-dom'),
  lightbox: $('lightbox'),
  toast: $('toast'),
};

let state = await loadState();
let images = {};
const deselected = new Set(); // CR ids excluded from the export
const pendingEdits = new Map(); // debounce key -> { fn, timer }
let pendingRender = false;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || (k in el && typeof v !== 'string')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (els.toast.hidden = true), 2400);
}

// Writes flush pending debounced edits too, so nothing typed gets lost.
async function save(fn) {
  const pending = [...pendingEdits.values()].map((p) => (clearTimeout(p.timer), p.fn));
  pendingEdits.clear();
  const apply = (s) => { pending.forEach((f) => f(s)); fn(s); };
  apply(state);
  state = await mutate(apply);
}

function saveSoon(key, fn) {
  fn(state);
  clearTimeout(pendingEdits.get(key)?.timer);
  pendingEdits.set(key, { fn, timer: setTimeout(() => save(() => {}), 350) });
  renderPreview();
}

function selectedIds() {
  return state.requests.filter((r) => !deselected.has(r.id)).map((r) => r.id);
}

function exportOptions(requestIds) {
  return {
    requestIds,
    includeClean: els.optClean.checked,
    includeContext: els.optContext.checked,
    includeDomHints: els.optDom.checked,
  };
}

// ------------------------------------------------------------------ render

async function render() {
  const ids = state.requests.flatMap((r) => r.items.flatMap(imageIdsOf));
  const missing = ids.filter((id) => !(id in images));
  if (missing.length) Object.assign(images, await getImages(missing));

  els.project.value = state.projectName ?? '';
  if (document.activeElement !== els.template) els.template.value = state.promptTemplate ?? DEFAULT_TEMPLATE;

  const frames = state.requests.reduce((n, r) => n + r.items.filter((i) => i.type === 'frame').length, 0);
  els.stats.textContent = `${state.requests.length} change request(s) · ${frames} frame(s)`;

  els.requests.replaceChildren(
    ...(state.requests.length
      ? state.requests.map(renderRequest)
      : [
          h('div', { class: 'empty card' },
            h('h2', {}, 'No change requests yet'),
            h('p', {}, 'Open your app (localhost, staging, …), click the extension icon or press Alt+Shift+F to show the overlay, then create a change request and add frames and notes.'),
          ),
        ]),
  );
  renderPreview();
}

function renderPreview() {
  const ids = selectedIds();
  els.selectedCount.textContent = String(ids.length);
  els.preview.textContent = ids.length ? buildExport(state, exportOptions(ids)).markdown : 'Select at least one change request.';
}

function renderRequest(req) {
  const label = crLabel(req.number);
  const included = !deselected.has(req.id);
  let frameNo = 0;
  return h('article', { class: 'card request' + (included ? '' : ' excluded') },
    h('header', { class: 'request-head' },
      h('input', {
        type: 'checkbox',
        checked: included,
        title: 'Include in export',
        onchange: (e) => { e.target.checked ? deselected.delete(req.id) : deselected.add(req.id); render(); },
      }),
      h('span', { class: 'badge' }, label),
      h('input', {
        class: 'title',
        value: req.title,
        placeholder: 'Untitled change request',
        oninput: (e) => saveSoon('title:' + req.id, (s) => { const r = s.requests.find((x) => x.id === req.id); if (r) r.title = e.target.value; }),
      }),
      h('div', { class: 'request-actions' },
        h('button', { onclick: () => downloadZip([req.id]) }, 'ZIP'),
        h('button', { onclick: () => copyPrompt([req.id]) }, 'Copy prompt'),
        h('button', { class: 'ghost danger', title: 'Delete change request', onclick: () => deleteRequest(req) }, 'Delete'),
      ),
    ),
    req.items.length === 0 ? h('p', { class: 'muted' }, 'Empty — add frames or text from the on-page overlay.') : null,
    ...req.items.map((item, index) => {
      if (item.type === 'text') {
        return h('div', { class: 'item' },
          h('div', { class: 'item-head' },
            h('span', { class: 'kind' }, `${label}.${index + 1} · Note`),
            h('button', { class: 'ghost small danger', onclick: () => deleteItem(req.id, item) }, 'Remove'),
          ),
          h('textarea', {
            rows: 3,
            value: item.text,
            oninput: (e) => saveSoon('text:' + item.id, (s) => {
              const it = s.requests.find((x) => x.id === req.id)?.items.find((x) => x.id === item.id);
              if (it) it.text = e.target.value;
            }),
          }),
        );
      }
      frameNo += 1;
      const src = images[item.images?.annotated];
      return h('div', { class: 'item frame' },
        h('div', { class: 'item-head' },
          h('span', { class: 'kind' }, `${label}.${index + 1} · Frame ${frameNo}`),
          h('a', { class: 'url', href: item.url, target: '_blank', rel: 'noreferrer', title: item.url }, item.pageTitle || item.url),
          h('button', { class: 'ghost small', onclick: () => copyImage(item.images?.annotated) }, 'Copy image'),
          h('button', { class: 'ghost small danger', onclick: () => deleteItem(req.id, item) }, 'Remove'),
        ),
        src ? h('img', { class: 'shot', src, alt: `${label} frame ${frameNo}`, onclick: () => openLightbox(src) }) : h('p', { class: 'muted' }, 'Image missing'),
        h('textarea', {
          rows: 2,
          placeholder: 'Comment for this frame…',
          value: item.note ?? '',
          oninput: (e) => saveSoon('note:' + item.id, (s) => {
            const it = s.requests.find((x) => x.id === req.id)?.items.find((x) => x.id === item.id);
            if (it) it.note = e.target.value;
          }),
        }),
        item.annotations?.texts?.length
          ? h('p', { class: 'muted small' }, 'Written on image: ', item.annotations.texts.map((t) => `“${t}”`).join(', '))
          : null,
      );
    }),
  );
}

// ------------------------------------------------------------------ actions

async function deleteRequest(req) {
  if (!confirm(`Delete ${crLabel(req.number)}${req.title ? ` “${req.title}”` : ''}?`)) return;
  await save((s) => {
    s.requests = s.requests.filter((r) => r.id !== req.id);
    if (s.activeRequestId === req.id) s.activeRequestId = s.requests.at(-1)?.id ?? null;
  });
  await removeImages(req.items.flatMap(imageIdsOf));
  render();
}

async function deleteItem(requestId, item) {
  await save((s) => {
    const r = s.requests.find((x) => x.id === requestId);
    if (r) r.items = r.items.filter((i) => i.id !== item.id);
  });
  await removeImages(imageIdsOf(item));
  render();
}

async function deleteAll() {
  if (!state.requests.length) return;
  if (!confirm(`Delete all ${state.requests.length} change request(s) and their screenshots? This cannot be undone.`)) return;
  const ids = state.requests.flatMap((r) => r.items.flatMap(imageIdsOf));
  await save((s) => {
    s.requests = [];
    s.activeRequestId = null;
    s.nextNumber = 1;
  });
  await removeImages(ids);
  images = {};
  render();
}

async function downloadZip(requestIds) {
  if (!requestIds.length) return toast('Nothing selected');
  const date = new Date();
  const { markdown, images: files, data } = buildExport(state, { ...exportOptions(requestIds), date });
  const folder = exportFolderName(date, exportLabelFor(state, requestIds));
  const stored = await getImages(files.map((f) => f.imageId));
  const missing = files.filter((f) => !stored[f.imageId]);
  const entries = [
    { path: `${folder}/PROMPT.md`, data: markdown },
    { path: `${folder}/feedback.json`, data: JSON.stringify(data, null, 2) },
    ...files.filter((f) => stored[f.imageId]).map((f) => ({ path: `${folder}/${f.path}`, data: dataUrlToBytes(stored[f.imageId]) })),
  ];
  const blob = new Blob([createZip(entries, date)], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  h('a', { href: url, download: `${folder}.zip` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(missing.length ? `Downloaded ${folder}.zip (${missing.length} image(s) missing)` : `Downloaded ${folder}.zip`);
}

async function copyPrompt(requestIds) {
  if (!requestIds.length) return toast('Nothing selected');
  const { markdown } = buildExport(state, exportOptions(requestIds));
  await navigator.clipboard.writeText(markdown);
  toast('Prompt copied — image paths refer to the ZIP export');
}

async function copyImage(imageId) {
  const src = images[imageId] ?? (await getImages([imageId]))[imageId];
  if (!src) return toast('Image missing');
  const blob = await (await fetch(src)).blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  toast('Image copied to clipboard');
}

function openLightbox(src) {
  els.lightbox.querySelector('img').src = src;
  els.lightbox.hidden = false;
}

// ------------------------------------------------------------------ wiring

els.lightbox.addEventListener('click', () => (els.lightbox.hidden = true));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.lightbox.hidden = true; });

els.project.addEventListener('input', (e) => saveSoon('project', (s) => { s.projectName = e.target.value; }));
els.template.addEventListener('input', (e) => saveSoon('template', (s) => {
  s.promptTemplate = e.target.value.trim() === DEFAULT_TEMPLATE.trim() ? null : e.target.value;
}));
$('reset-template').addEventListener('click', async () => {
  await save((s) => { s.promptTemplate = null; });
  els.template.value = DEFAULT_TEMPLATE;
  renderPreview();
});
for (const opt of [els.optClean, els.optContext, els.optDom]) opt.addEventListener('change', renderPreview);
$('download-zip').addEventListener('click', () => downloadZip(selectedIds()));
$('copy-prompt').addEventListener('click', () => copyPrompt(selectedIds()));
$('select-all').addEventListener('click', () => { deselected.clear(); render(); });
$('select-none').addEventListener('click', () => { state.requests.forEach((r) => deselected.add(r.id)); render(); });
$('delete-all').addEventListener('click', deleteAll);

// Live updates while frames are being captured in other tabs. Defer while the
// user is typing so the field does not lose focus.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STATE_KEY]) return;
  const next = changes[STATE_KEY].newValue;
  if (JSON.stringify(next) === JSON.stringify(state)) return; // our own write
  state = { ...state, ...(next ?? {}) };
  for (const { fn } of pendingEdits.values()) fn(state);
  const typing = document.activeElement?.matches?.('input:not([type=checkbox]), textarea');
  if (typing) pendingRender = true;
  else render();
});
document.addEventListener('focusout', () => {
  if (!pendingRender) return;
  pendingRender = false;
  setTimeout(render, 0);
});

render();
