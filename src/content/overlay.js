// Content script (classic script, injected on demand by the service worker).
// Renders the feedback panel, the region-capture/drawing flow and the on-page
// "pins" that re-show saved annotations when the overlay is toggled on.
// Everything lives in a shadow root so page CSS cannot leak in or out.

(() => {
  if (window.__wfcr) return;

  // Keep in sync with src/lib/store.js (content scripts cannot import modules).
  const STATE_KEY = 'wfcr:state';
  const IMG_PREFIX = 'wfcr:img:';

  const COLORS = ['#ff2d55', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#111111', '#ffffff'];
  const WIDTHS = { S: 2, M: 4, L: 8 };
  const TOOLS = [
    { id: 'pen', label: '✎', title: 'Pen (P)' },
    { id: 'arrow', label: '➚', title: 'Arrow (A)' },
    { id: 'box', label: '▭', title: 'Box (B)' },
    { id: 'highlight', label: '▮', title: 'Highlighter (H)' },
    { id: 'text', label: 'T', title: 'Text (T)' },
  ];

  let state = emptyState();
  const ownWrites = new Set(); // JSON of recent writes, to ignore their onChanged echo
  let writeQueue = Promise.resolve();
  let enabled = false;
  let showPins = true;
  let collapsed = false;
  let capturing = false;
  let host = null;
  let root = null;
  let lastHref = location.href;
  let hrefTimer = null;
  const imageCache = new Map();

  // ---------------------------------------------------------------- state

  function emptyState() {
    return { version: 1, projectName: '', promptTemplate: null, requests: [], activeRequestId: null, nextNumber: 1 };
  }

  function uid() {
    return crypto.randomUUID();
  }

  async function loadState() {
    const result = await chrome.storage.local.get(STATE_KEY);
    state = { ...emptyState(), ...(result[STATE_KEY] ?? {}) };
  }

  // Re-read before every write so several tabs can edit the same project.
  // Pending (debounced) field edits are flushed into the same write.
  // Writes are serialized so overlapping calls in this tab cannot lose updates.
  function mutate(fn) {
    const run = writeQueue.then(async () => {
      await loadState();
      takePendingFieldSaves().forEach((f) => f(state));
      fn(state);
      const json = JSON.stringify(state);
      ownWrites.add(json);
      setTimeout(() => ownWrites.delete(json), 5000);
      await chrome.storage.local.set({ [STATE_KEY]: state });
    });
    writeQueue = run.catch(() => {});
    return run;
  }

  let pendingFieldSave = null; // { fns, timer }
  function saveFieldSoon(fn) {
    fn(state); // optimistic, so a re-render before the write keeps the text
    const fns = pendingFieldSave?.fns ?? [];
    clearTimeout(pendingFieldSave?.timer);
    fns.push(fn);
    pendingFieldSave = { fns, timer: setTimeout(() => mutate(() => {}), 350) };
  }

  function takePendingFieldSaves() {
    if (!pendingFieldSave) return [];
    clearTimeout(pendingFieldSave.timer);
    const { fns } = pendingFieldSave;
    pendingFieldSave = null;
    return fns;
  }

  function findRequest(s, id) {
    return s.requests.find((r) => r.id === id);
  }

  function findItem(s, requestId, itemId) {
    return findRequest(s, requestId)?.items.find((i) => i.id === itemId);
  }

  function urlKey(href) {
    const u = new URL(href);
    // Hash routers (#/route) identify a page; plain anchors (#section) do not.
    const hash = u.hash.startsWith('#/') || u.hash.startsWith('#!/') ? u.hash : '';
    return u.origin + u.pathname + hash;
  }

  async function getImage(id) {
    if (!id) return null;
    if (imageCache.has(id)) return imageCache.get(id);
    const key = IMG_PREFIX + id;
    const result = await chrome.storage.local.get(key);
    const dataUrl = result[key] ?? null;
    if (dataUrl) imageCache.set(id, dataUrl);
    return dataUrl;
  }

  function imageIdsOf(item) {
    return item.type === 'frame' ? Object.values(item.images ?? {}).filter(Boolean) : [];
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STATE_KEY] || !enabled) return;
    const next = changes[STATE_KEY].newValue;
    if (ownWrites.has(JSON.stringify(next))) return;
    state = { ...emptyState(), ...(next ?? {}) };
    if (pendingFieldSave) pendingFieldSave.fns.forEach((f) => f(state));
    render();
  });

  // ---------------------------------------------------------------- dom helpers

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || (k in el && typeof v !== 'string')) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function crNumber(n) {
    return 'CR-' + String(n).padStart(3, '0');
  }

  function toast(message) {
    const el = h('div', { class: 'toast' }, message);
    root.append(el);
    setTimeout(() => el.remove(), 2200);
  }

  // ---------------------------------------------------------------- mount

  function mount() {
    if (host) return;
    host = document.createElement('wfcr-overlay');
    host.style.cssText =
      'all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    root = host.attachShadow({ mode: 'open' });
    root.append(h('style', {}, STYLES));
    root.append(h('div', { class: 'pins' }), h('div', { class: 'panel' }));
    // Typing in our fields must not trigger the page's own keyboard shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
    // Clicking our buttons or the capture stage must not steal focus from the page's
    // focused field (which would close its autocomplete menu, popovers, etc.), and the
    // page's "click outside" handlers must not see these clicks either.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      root.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'mousedown' && !e.composedPath().some((el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          e.preventDefault();
        }
      });
    }
    document.documentElement.append(host);
  }

  async function enable() {
    if (enabled) return;
    enabled = true;
    await loadState();
    mount();
    render();
    lastHref = location.href;
    // Single-page apps change the URL without a page load.
    hrefTimer = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        renderPins();
      }
    }, 600);
  }

  function disable() {
    enabled = false;
    clearInterval(hrefTimer);
    host?.remove();
    host = root = null;
  }

  // ---------------------------------------------------------------- panel

  function render() {
    if (!root || capturing) return;
    renderPanel();
    renderPins();
  }

  function renderPanel() {
    const panel = root.querySelector('.panel');
    const scrollTop = panel.querySelector('.body')?.scrollTop ?? 0;
    const focused = root.activeElement;
    const focusKey = focused?.dataset?.focusKey;
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;

    panel.replaceChildren();
    panel.classList.toggle('collapsed', collapsed);

    const header = h(
      'div',
      { class: 'header' },
      h('div', { class: 'brand', title: 'Web Feedback Change Requests Note Taker' }, h('span', { class: 'dot' }), 'Web Feedback'),
      h(
        'div',
        { class: 'header-actions' },
        h('button', { class: 'icon', title: showPins ? 'Hide annotations on page' : 'Show annotations on page', onclick: () => { showPins = !showPins; render(); } }, showPins ? '◉' : '○'),
        h('button', { class: 'icon', title: 'Review & export', onclick: () => chrome.runtime.sendMessage({ type: 'wfcr:open-review' }) }, '⇪'),
        h('button', { class: 'icon', title: collapsed ? 'Expand' : 'Minimize', onclick: () => { collapsed = !collapsed; render(); } }, collapsed ? '▢' : '–'),
        h('button', { class: 'icon', title: 'Turn overlay off (Alt+Shift+F)', onclick: () => chrome.runtime.sendMessage({ type: 'wfcr:disable' }).then(disable) }, '✕'),
      ),
    );
    panel.append(header);
    if (collapsed) return;

    const body = h('div', { class: 'body' });
    if (state.requests.length === 0) {
      body.append(
        h('div', { class: 'empty' },
          h('p', {}, 'No change requests yet.'),
          h('p', { class: 'muted' }, 'Create one, then add frames (annotated screenshots of a region) and text notes.'),
        ),
      );
    }
    for (const req of state.requests) body.append(renderRequest(req));
    panel.append(body);

    panel.append(
      h('div', { class: 'footer' },
        h('button', { class: 'primary', onclick: newRequest }, '+ New change request'),
        h('span', { class: 'muted small' }, `${state.requests.length} request${state.requests.length === 1 ? '' : 's'}`),
      ),
    );

    body.scrollTop = scrollTop;
    if (focusKey) {
      const el = panel.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (el) {
        el.focus();
        if (selection) el.setSelectionRange(...selection);
      }
    }
  }

  function renderRequest(req) {
    const active = req.id === state.activeRequestId;
    const frames = req.items.filter((i) => i.type === 'frame').length;
    const notes = req.items.length - frames;
    const card = h('div', { class: 'request' + (active ? ' active' : ''), 'data-request': req.id });

    card.append(
      h('div', { class: 'request-head', onclick: (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') activate(req.id); } },
        h('span', { class: 'badge' }, crNumber(req.number)),
        h('input', {
          class: 'title',
          value: req.title,
          placeholder: 'What should change?',
          'data-focus-key': 'title:' + req.id,
          onfocus: () => { if (!active) activate(req.id); },
          oninput: (e) => { const v = e.target.value; saveFieldSoon((s) => { const r = findRequest(s, req.id); if (r) r.title = v; }); },
        }),
        h('button', { class: 'icon small', title: 'Delete change request', onclick: () => deleteRequest(req) }, '🗑'),
      ),
    );

    if (!active) {
      card.append(h('div', { class: 'summary muted small' }, `${frames} frame${frames === 1 ? '' : 's'} · ${notes} note${notes === 1 ? '' : 's'}`));
      return card;
    }

    const list = h('div', { class: 'items' });
    req.items.forEach((item, index) => list.append(renderItem(req, item, index)));
    card.append(list);
    card.append(
      h('div', { class: 'add-row' },
        h('button', { onclick: () => startFrame(req.id), title: 'Select a region of the page, draw on it, capture it (Alt+Shift+S)' }, '+ Frame'),
        h('button', { onclick: () => addText(req.id) }, '+ Text'),
      ),
    );
    return card;
  }

  function renderItem(req, item, index) {
    const move = (delta) => moveItem(req.id, item.id, delta);
    const tools = h('div', { class: 'item-tools' },
      h('button', { class: 'icon small', title: 'Move up', disabled: index === 0, onclick: () => move(-1) }, '↑'),
      h('button', { class: 'icon small', title: 'Move down', disabled: index === req.items.length - 1, onclick: () => move(1) }, '↓'),
      h('button', { class: 'icon small', title: 'Delete', onclick: () => deleteItem(req.id, item.id) }, '🗑'),
    );

    if (item.type === 'text') {
      return h('div', { class: 'item text-item' },
        h('div', { class: 'item-head' }, h('span', { class: 'kind' }, 'Text'), tools),
        h('textarea', {
          rows: 3,
          placeholder: 'Describe the change…',
          'data-focus-key': 'text:' + item.id,
          value: item.text,
          oninput: (e) => { const v = e.target.value; saveFieldSoon((s) => { const it = findItem(s, req.id, item.id); if (it) it.text = v; }); },
        }),
      );
    }

    const img = h('img', { class: 'thumb', alt: 'Annotated frame', title: 'Show on page', onclick: () => goToFrame(req, item) });
    getImage(item.images?.annotated).then((src) => { if (src) img.src = src; });
    const path = (() => { try { const u = new URL(item.url); return u.pathname + u.search + u.hash; } catch { return item.url; } })();
    return h('div', { class: 'item frame-item' },
      h('div', { class: 'item-head' },
        h('span', { class: 'kind' }, 'Frame'),
        h('span', { class: 'path muted small', title: item.url }, path),
        tools,
      ),
      img,
      h('textarea', {
        rows: 2,
        placeholder: 'Comment for this frame (optional)…',
        'data-focus-key': 'note:' + item.id,
        value: item.note ?? '',
        oninput: (e) => { const v = e.target.value; saveFieldSoon((s) => { const it = findItem(s, req.id, item.id); if (it) it.note = v; }); },
      }),
    );
  }

  async function newRequest() {
    let id;
    await mutate((s) => {
      id = uid();
      s.requests.push({ id, number: s.nextNumber++, title: '', createdAt: new Date().toISOString(), items: [] });
      s.activeRequestId = id;
    });
    render();
    root.querySelector(`[data-focus-key="title:${id}"]`)?.focus();
  }

  async function activate(id) {
    await mutate((s) => { s.activeRequestId = id; });
    render();
  }

  async function deleteRequest(req) {
    if (req.items.length && !confirm(`Delete ${crNumber(req.number)} and its ${req.items.length} item(s)?`)) return;
    const imageKeys = req.items.flatMap(imageIdsOf).map((id) => IMG_PREFIX + id);
    await mutate((s) => {
      s.requests = s.requests.filter((r) => r.id !== req.id);
      if (s.activeRequestId === req.id) s.activeRequestId = s.requests.at(-1)?.id ?? null;
    });
    if (imageKeys.length) await chrome.storage.local.remove(imageKeys);
    render();
  }

  async function addText(requestId) {
    const id = uid();
    await mutate((s) => findRequest(s, requestId)?.items.push({ id, type: 'text', text: '', createdAt: new Date().toISOString() }));
    render();
    root.querySelector(`[data-focus-key="text:${id}"]`)?.focus();
  }

  async function deleteItem(requestId, itemId) {
    const item = findItem(state, requestId, itemId);
    if (!item) return;
    await mutate((s) => {
      const r = findRequest(s, requestId);
      if (r) r.items = r.items.filter((i) => i.id !== itemId);
    });
    const keys = imageIdsOf(item).map((id) => IMG_PREFIX + id);
    if (keys.length) await chrome.storage.local.remove(keys);
    render();
  }

  async function moveItem(requestId, itemId, delta) {
    await mutate((s) => {
      const items = findRequest(s, requestId)?.items;
      if (!items) return;
      const from = items.findIndex((i) => i.id === itemId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= items.length) return;
      items.splice(to, 0, items.splice(from, 1)[0]);
    });
    render();
  }

  function goToFrame(req, item) {
    if (urlKey(item.url) !== urlKey(location.href)) {
      location.href = item.url;
      return;
    }
    const r = item.docRect;
    window.scrollTo({ left: Math.max(0, r.x - 40), top: Math.max(0, r.y - 80), behavior: 'smooth' });
    showPins = true;
    renderPins();
    const pin = root.querySelector(`[data-pin="${item.id}"]`);
    pin?.classList.remove('flash');
    void pin?.offsetWidth;
    pin?.classList.add('flash');
  }

  // ---------------------------------------------------------------- pins

  function renderPins() {
    if (!root) return;
    const layer = root.querySelector('.pins');
    layer.replaceChildren();
    if (!showPins || capturing) return;
    const here = urlKey(location.href);
    for (const req of state.requests) {
      req.items.forEach((item) => {
        if (item.type !== 'frame' || urlKey(item.url) !== here) return;
        const r = item.docRect;
        const frameIndex = req.items.filter((i) => i.type === 'frame').indexOf(item) + 1;
        const overlay = h('img', { class: 'pin-overlay', alt: '' });
        getImage(item.images?.overlay).then((src) => { if (src) overlay.src = src; });
        layer.append(
          h('div', {
            class: 'pin' + (req.id === state.activeRequestId ? ' active' : ''),
            'data-pin': item.id,
            style: { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' },
          },
            overlay,
            h('button', {
              class: 'pin-label',
              title: [req.title, item.note].filter(Boolean).join(' — ') || 'Open change request',
              onclick: () => { collapsed = false; activate(req.id); },
            }, `${crNumber(req.number)} · ${frameIndex}`),
          ),
        );
      });
    }
  }

  // ---------------------------------------------------------------- capture flow

  async function startFrame(requestId) {
    if (!enabled) await enable();
    if (capturing) return;
    if (!requestId) {
      requestId = state.activeRequestId && findRequest(state, state.activeRequestId) ? state.activeRequestId : null;
      if (!requestId) {
        await newRequest();
        requestId = state.activeRequestId;
      }
    }
    capturing = true;
    root.querySelector('.panel').style.display = 'none';
    root.querySelector('.pins').replaceChildren();

    const rect = await selectRegion();
    if (!rect) return endCapture();
    const result = await annotate(rect);
    if (!result) return endCapture();
    try {
      await saveFrame(requestId, rect, result);
    } catch (err) {
      console.error('[wfcr] capture failed', err);
      endCapture();
      toast('Capture failed: ' + (err?.message ?? err));
      return;
    }
    endCapture();
    toast('Frame added to ' + crNumber(findRequest(state, requestId)?.number ?? 0));
  }

  function endCapture() {
    capturing = false;
    if (!root) return;
    root.querySelector('.stage')?.remove();
    root.querySelector('.panel').style.display = '';
    render();
  }

  function blockScroll(el) {
    el.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  function selectRegion() {
    return new Promise((resolve) => {
      const box = h('div', { class: 'sel-box' });
      const hint = h('div', { class: 'hint' }, 'Drag to select a region · Enter = whole viewport · Esc = cancel');
      const stage = h('div', { class: 'stage selecting' }, box, hint);
      blockScroll(stage);
      root.append(stage);
      let start = null;
      let rect = null;

      const finish = (value) => {
        window.removeEventListener('keydown', onKey, true);
        stage.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish({ x: 0, y: 0, w: innerWidth, h: innerHeight }); }
      };
      window.addEventListener('keydown', onKey, true);

      stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        stage.setPointerCapture(e.pointerId);
        start = { x: e.clientX, y: e.clientY };
        hint.style.display = 'none';
      });
      stage.addEventListener('pointermove', (e) => {
        if (!start) return;
        const x = Math.max(0, Math.min(start.x, e.clientX));
        const y = Math.max(0, Math.min(start.y, e.clientY));
        rect = {
          x, y,
          w: Math.min(innerWidth, Math.max(start.x, e.clientX)) - x,
          h: Math.min(innerHeight, Math.max(start.y, e.clientY)) - y,
        };
        Object.assign(box.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
      });
      const onSelectEnd = () => {
        if (!start) return;
        start = null;
        if (!rect || rect.w < 8 || rect.h < 8) {
          box.style.display = 'none';
          hint.style.display = '';
          rect = null;
          return;
        }
        finish(rect);
      };
      stage.addEventListener('pointerup', onSelectEnd);
      stage.addEventListener('pointercancel', onSelectEnd);
    });
  }

  function annotate(rect) {
    return new Promise((resolve) => {
      const dpr = window.devicePixelRatio || 1;
      const ops = [];
      let tool = 'pen';
      let color = COLORS[0];
      let width = WIDTHS.M;
      let drawing = null;

      const canvas = h('canvas', { class: 'draw', width: Math.round(rect.w * dpr), height: Math.round(rect.h * dpr) });
      Object.assign(canvas.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
      const ctx = canvas.getContext('2d');
      const frameBox = h('div', { class: 'frame-box', style: { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' } });
      const caption = h('input', { class: 'caption', placeholder: 'Comment for this frame (optional)' });

      const redraw = () => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawOps(ctx, drawing ? [...ops, drawing] : ops, dpr, 0, 0);
      };

      const toolButtons = TOOLS.map((t) =>
        h('button', { class: 'tool', title: t.title, 'data-tool': t.id, onclick: () => setTool(t.id) }, t.label),
      );
      const colorButtons = COLORS.map((c) =>
        h('button', { class: 'swatch', title: c, style: { background: c }, 'data-color': c, onclick: () => { color = c; sync(); } }),
      );
      const widthButtons = Object.entries(WIDTHS).map(([label, w]) =>
        h('button', { class: 'tool width', 'data-width': String(w), title: 'Stroke ' + label, onclick: () => { width = w; sync(); } }, label),
      );
      const setTool = (id) => { tool = id; sync(); };
      const sync = () => {
        toolButtons.forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
        colorButtons.forEach((b) => b.classList.toggle('on', b.dataset.color === color));
        widthButtons.forEach((b) => b.classList.toggle('on', Number(b.dataset.width) === width));
        canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
      };

      const undo = () => { commitText(); ops.pop(); redraw(); };
      const clearAll = () => { commitText(); ops.length = 0; redraw(); };
      const cancel = () => finish(null);
      const save = () => { commitText(); finish({ ops: [...ops], caption: caption.value.trim(), dpr }); };

      const toolbar = h('div', { class: 'toolbar' },
        h('div', { class: 'group' }, toolButtons),
        h('div', { class: 'group' }, colorButtons),
        h('div', { class: 'group' }, widthButtons),
        h('div', { class: 'group' },
          h('button', { class: 'tool', title: 'Undo (Ctrl+Z)', onclick: undo }, '↶'),
          h('button', { class: 'tool', title: 'Clear drawing', onclick: clearAll }, '⌫'),
        ),
        caption,
        h('div', { class: 'group' },
          h('button', { class: 'ghost', onclick: cancel }, 'Cancel'),
          h('button', { class: 'primary', onclick: save, title: 'Capture (Ctrl+Enter)' }, 'Capture frame'),
        ),
      );

      const mask = h('div', { class: 'mask', style: { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' } });
      const stage = h('div', { class: 'stage annotating' }, mask, frameBox, canvas, toolbar);
      blockScroll(stage);
      root.append(stage);

      // Place the toolbar below the region, above it, or inside at the bottom.
      requestAnimationFrame(() => {
        const tb = toolbar.getBoundingClientRect();
        let top = rect.y + rect.h + 10;
        if (top + tb.height > innerHeight - 6) top = rect.y - tb.height - 10;
        if (top < 6) top = Math.min(innerHeight - tb.height - 6, rect.y + rect.h - tb.height - 10);
        const left = Math.max(6, Math.min(rect.x, innerWidth - tb.width - 6));
        Object.assign(toolbar.style, { top: Math.max(6, top) + 'px', left: left + 'px', visibility: 'visible' });
      });

      // --- text tool: an inline editor that commits onto the canvas
      let textEditor = null;
      const commitText = () => {
        if (!textEditor) return;
        const { el, x, y } = textEditor;
        textEditor = null;
        const text = el.value.replace(/\s+$/, '');
        el.remove();
        if (text) ops.push({ type: 'text', x, y, text, color, size: 10 + width * 2 });
        redraw();
      };
      const openText = (x, y) => {
        commitText();
        const size = 10 + width * 2;
        const el = h('textarea', {
          class: 'text-editor',
          rows: 1,
          style: { left: rect.x + x + 'px', top: rect.y + y + 'px', color, fontSize: size + 'px', lineHeight: size * 1.25 + 'px' },
        });
        el.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { el.value = ''; commitText(); }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
        });
        el.addEventListener('input', () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; });
        stage.append(el);
        textEditor = { el, x, y };
        setTimeout(() => el.focus(), 0);
      };

      const local = (e) => {
        const b = canvas.getBoundingClientRect();
        return { x: Math.max(0, Math.min(rect.w, e.clientX - b.left)), y: Math.max(0, Math.min(rect.h, e.clientY - b.top)) };
      };
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const p = local(e);
        if (tool === 'text') {
          e.preventDefault();
          if (textEditor) commitText();
          else openText(p.x, p.y);
          return;
        }
        commitText();
        canvas.setPointerCapture(e.pointerId);
        if (tool === 'pen' || tool === 'highlight') drawing = { type: tool, color, width: tool === 'highlight' ? width * 4 : width, points: [p] };
        else drawing = { type: tool, color, width, from: p, to: p };
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const p = local(e);
        if (drawing.points) drawing.points.push(p);
        else drawing.to = p;
        redraw();
      });
      const onDrawEnd = () => {
        if (!drawing) return;
        const d = drawing;
        drawing = null;
        const tiny = d.points ? d.points.length < 2 : Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 4;
        if (!tiny || d.points) ops.push(d.points && d.points.length === 1 ? { ...d, points: [d.points[0], { x: d.points[0].x + 0.1, y: d.points[0].y }] } : d);
        redraw();
      };
      canvas.addEventListener('pointerup', onDrawEnd);
      canvas.addEventListener('pointercancel', onDrawEnd);

      const onKey = (e) => {
        // At window level shadow-DOM events are retargeted to the host element.
        const target = e.composedPath()[0];
        if (textEditor || target === caption) {
          if (target === caption && e.key === 'Enter') { e.preventDefault(); save(); }
          if (target === caption && e.key === 'Escape') { e.preventDefault(); caption.blur(); }
          return;
        }
        const key = e.key.toLowerCase();
        if (e.key === 'Escape') cancel();
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        else if (key === 'z' && (e.ctrlKey || e.metaKey)) undo();
        else if (!e.ctrlKey && !e.metaKey && !e.altKey && { p: 1, a: 1, b: 1, h: 1, t: 1 }[key]) {
          setTool({ p: 'pen', a: 'arrow', b: 'box', h: 'highlight', t: 'text' }[key]);
        } else return;
        e.preventDefault();
        e.stopPropagation();
      };
      window.addEventListener('keydown', onKey, true);

      function finish(value) {
        window.removeEventListener('keydown', onKey, true);
        stage.remove();
        resolve(value);
      }

      sync();
    });
  }

  // Ops are stored in CSS pixels relative to the frame's top-left corner.
  function drawOps(ctx, ops, scale, offsetX, offsetY) {
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const op of ops) {
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.globalAlpha = op.type === 'highlight' ? 0.35 : 1;
      if (op.type === 'pen' || op.type === 'highlight') {
        ctx.beginPath();
        op.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      } else if (op.type === 'box') {
        ctx.strokeRect(op.from.x, op.from.y, op.to.x - op.from.x, op.to.y - op.from.y);
      } else if (op.type === 'arrow') {
        const angle = Math.atan2(op.to.y - op.from.y, op.to.x - op.from.x);
        const head = 8 + op.width * 2.5;
        ctx.beginPath();
        ctx.moveTo(op.from.x, op.from.y);
        ctx.lineTo(op.to.x - Math.cos(angle) * head * 0.6, op.to.y - Math.sin(angle) * head * 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(op.to.x, op.to.y);
        ctx.lineTo(op.to.x - head * Math.cos(angle - Math.PI / 7), op.to.y - head * Math.sin(angle - Math.PI / 7));
        ctx.lineTo(op.to.x - head * Math.cos(angle + Math.PI / 7), op.to.y - head * Math.sin(angle + Math.PI / 7));
        ctx.closePath();
        ctx.fill();
      } else if (op.type === 'text') {
        ctx.font = `600 ${op.size}px system-ui, -apple-system, Segoe UI, sans-serif`;
        ctx.textBaseline = 'top';
        const lineHeight = op.size * 1.25;
        op.text.split('\n').forEach((line, i) => {
          const y = op.y + i * lineHeight;
          ctx.lineWidth = Math.max(3, op.size / 4);
          ctx.strokeStyle = isDark(op.color) ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.85)';
          ctx.strokeText(line, op.x, y);
          ctx.fillText(line, op.x, y);
        });
      }
    }
    ctx.restore();
  }

  function isDark(hex) {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 150;
  }

  async function captureViewport() {
    host.style.visibility = 'hidden';
    await nextFrame();
    await nextFrame();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'wfcr:capture' });
      if (!response || response.error) throw new Error(response?.error ?? 'no response from extension');
      return response.dataUrl;
    } finally {
      host.style.visibility = '';
    }
  }

  async function saveFrame(requestId, rect, { ops, caption }) {
    const dom = describeRegion(rect);
    const shot = await loadImage(await captureViewport());
    const scale = shot.naturalWidth / innerWidth;
    const sx = Math.round(rect.x * scale);
    const sy = Math.round(rect.y * scale);
    const sw = Math.max(1, Math.round(rect.w * scale));
    const sh = Math.max(1, Math.round(rect.h * scale));

    const canvasOf = (w, hgt) => Object.assign(document.createElement('canvas'), { width: w, height: hgt });

    const clean = canvasOf(sw, sh);
    clean.getContext('2d').drawImage(shot, sx, sy, sw, sh, 0, 0, sw, sh);

    const annotated = canvasOf(sw, sh);
    const actx = annotated.getContext('2d');
    actx.drawImage(clean, 0, 0);
    drawOps(actx, ops, scale, 0, 0);

    const overlay = canvasOf(sw, sh);
    drawOps(overlay.getContext('2d'), ops, scale, 0, 0);

    // Whole viewport with the region outlined, so the AI sees where it is.
    const ctxScale = Math.min(1, 1600 / shot.naturalWidth);
    const context = canvasOf(Math.round(shot.naturalWidth * ctxScale), Math.round(shot.naturalHeight * ctxScale));
    const cctx = context.getContext('2d');
    cctx.drawImage(shot, 0, 0, context.width, context.height);
    const k = scale * ctxScale;
    drawOps(cctx, ops, k, rect.x * k, rect.y * k);
    cctx.setLineDash([8, 5]);
    cctx.lineWidth = 3;
    cctx.strokeStyle = '#ff2d55';
    cctx.strokeRect(rect.x * k, rect.y * k, rect.w * k, rect.h * k);

    const images = { annotated: uid(), clean: uid(), overlay: uid(), context: uid() };
    const payload = {
      [IMG_PREFIX + images.annotated]: annotated.toDataURL('image/png'),
      [IMG_PREFIX + images.clean]: clean.toDataURL('image/png'),
      [IMG_PREFIX + images.overlay]: overlay.toDataURL('image/png'),
      [IMG_PREFIX + images.context]: context.toDataURL('image/jpeg', 0.85),
    };
    await chrome.storage.local.set(payload);
    for (const [key, value] of Object.entries(payload)) imageCache.set(key.slice(IMG_PREFIX.length), value);

    const frame = {
      id: uid(),
      type: 'frame',
      url: location.href,
      pageTitle: document.title,
      note: caption,
      rect: { ...rect },
      docRect: { x: rect.x + scrollX, y: rect.y + scrollY, w: rect.w, h: rect.h },
      viewport: { w: innerWidth, h: innerHeight, dpr: window.devicePixelRatio || 1 },
      imageSize: { w: sw, h: sh },
      annotations: summarizeOps(ops),
      dom,
      images,
      createdAt: new Date().toISOString(),
    };
    try {
      await mutate((s) => {
        const req = findRequest(s, requestId);
        if (!req) throw new Error('change request no longer exists');
        req.items.push(frame);
        s.activeRequestId = requestId;
      });
    } catch (err) {
      await chrome.storage.local.remove(Object.keys(payload));
      throw err;
    }
  }

  function summarizeOps(ops) {
    const counts = {};
    for (const op of ops) counts[op.type] = (counts[op.type] ?? 0) + 1;
    return { counts, texts: ops.filter((o) => o.type === 'text').map((o) => o.text) };
  }

  // ---------------------------------------------------------------- DOM hints

  // Give the AI something it can grep for: selectors, test ids and visible
  // text of the elements inside the captured region.
  function describeRegion(rect) {
    try {
      const inside = (b) => b.left >= rect.x - 1 && b.top >= rect.y - 1 && b.right <= rect.x + rect.w + 1 && b.bottom <= rect.y + rect.h + 1;
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const atCenter = document.elementsFromPoint(cx, cy).filter((el) => el !== host && !host.contains(el));
      const center = atCenter[0] ?? null;

      let container = center;
      while (container && container !== document.documentElement) {
        const b = container.getBoundingClientRect();
        if (b.left <= rect.x + 1 && b.top <= rect.y + 1 && b.right >= rect.x + rect.w - 1 && b.bottom >= rect.y + rect.h - 1) break;
        container = container.parentElement;
      }

      const interesting = 'a,button,input,select,textarea,label,img,svg,h1,h2,h3,h4,h5,h6,[role],[data-testid],[data-test],[data-cy],[aria-label]';
      const elements = [];
      const seen = new Set();
      for (const el of (container ?? document.body).querySelectorAll(interesting)) {
        if (elements.length >= 25) break;
        if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0 || !inside(b)) continue;
        const d = describeElement(el);
        const sig = d.selector + '|' + d.text;
        if (seen.has(sig)) continue;
        seen.add(sig);
        elements.push(d);
      }
      return {
        container: container && container !== document.documentElement ? describeElement(container) : null,
        center: center ? describeElement(center) : null,
        elements,
      };
    } catch (err) {
      return { error: String(err) };
    }
  }

  function describeElement(el) {
    const text = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const attr = (name) => el.getAttribute(name) || undefined;
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: text.length > 120 ? text.slice(0, 117) + '…' : text || undefined,
      testId: attr('data-testid') ?? attr('data-test') ?? attr('data-cy'),
      ariaLabel: attr('aria-label'),
      role: attr('role'),
      alt: attr('alt'),
      href: el.tagName === 'A' ? attr('href') : undefined,
      placeholder: attr('placeholder'),
    };
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      const tag = node.tagName.toLowerCase();
      if (node.id && !/\d{3,}/.test(node.id)) {
        parts.unshift(`${tag}#${CSS.escape(node.id)}`);
        break;
      }
      const testId = node.getAttribute('data-testid');
      if (testId) {
        parts.unshift(`${tag}[data-testid="${testId}"]`);
        break;
      }
      const classes = [...node.classList].filter((c) => !/^(css|sc|jsx|svelte)-|[0-9a-f]{5,}/i.test(c)).slice(0, 2);
      let part = tag + classes.map((c) => '.' + CSS.escape(c)).join('');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
      if (tag === 'body') break;
    }
    return parts.join(' > ');
  }

  // ---------------------------------------------------------------- styles

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    button { font: inherit; cursor: pointer; border: 1px solid #d4d4d8; background: #fff; color: #18181b; border-radius: 6px; padding: 5px 10px; font-size: 12px; line-height: 1.2; }
    button:hover:not(:disabled) { background: #f4f4f5; }
    button:disabled { opacity: .35; cursor: default; }
    button.primary { background: #e11d48; border-color: #e11d48; color: #fff; font-weight: 600; }
    button.primary:hover { background: #be123c; }
    button.ghost { background: transparent; }
    button.icon { border: none; background: transparent; padding: 4px 6px; font-size: 14px; color: inherit; }
    button.icon:hover:not(:disabled) { background: rgba(0,0,0,.07); }
    button.small { font-size: 11px; padding: 2px 5px; }
    .muted { color: #71717a; }
    .small { font-size: 11px; }

    .panel { position: fixed; top: 12px; right: 12px; width: 340px; max-height: calc(100vh - 24px); display: flex; flex-direction: column;
      background: #fff; color: #18181b; border: 1px solid #e4e4e7; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.18); font-size: 13px; overflow: hidden; }
    .panel.collapsed { width: auto; }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 8px 8px 12px; background: #18181b; color: #fafafa; }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; letter-spacing: .01em; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #e11d48; box-shadow: 0 0 0 3px rgba(225,29,72,.3); }
    .header-actions { display: flex; gap: 2px; }
    .header-actions button:hover { background: rgba(255,255,255,.12) !important; }
    .body { overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .empty { text-align: center; padding: 18px 8px; }
    .empty p { margin: 4px 0; }
    .footer { display: flex; align-items: center; justify-content: space-between; padding: 10px; border-top: 1px solid #f4f4f5; }

    .request { border: 1px solid #e4e4e7; border-radius: 10px; padding: 8px; background: #fafafa; }
    .request.active { border-color: #e11d48; background: #fff; box-shadow: 0 0 0 3px rgba(225,29,72,.08); }
    .request-head { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .badge { font-size: 10px; font-weight: 700; background: #18181b; color: #fff; padding: 3px 6px; border-radius: 5px; white-space: nowrap; }
    .request.active .badge { background: #e11d48; }
    input.title { flex: 1; min-width: 0; border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 4px 6px; font-size: 13px; font-weight: 600; color: #18181b; }
    input.title:hover, input.title:focus { border-color: #d4d4d8; background: #fff; outline: none; }
    .summary { padding: 4px 2px 0 2px; }
    .items { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .item { border: 1px solid #e4e4e7; border-radius: 8px; padding: 6px; background: #fff; }
    .item-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .kind { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #52525b; }
    .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .text-item .item-head { justify-content: space-between; }
    .item-tools { display: flex; margin-left: auto; }
    .thumb { display: block; width: 100%; max-height: 180px; object-fit: contain; background: repeating-conic-gradient(#f4f4f5 0 25%, #fff 0 50%) 0 0/12px 12px; border-radius: 6px; border: 1px solid #f4f4f5; cursor: zoom-in; min-height: 40px; }
    textarea { width: 100%; resize: vertical; border: 1px solid #e4e4e7; border-radius: 6px; padding: 6px; font-size: 12px; color: #18181b; background: #fff; margin-top: 4px; }
    textarea:focus, .caption:focus { outline: 2px solid rgba(225,29,72,.35); border-color: #e11d48; }
    .add-row { display: flex; gap: 6px; margin-top: 8px; }
    .add-row button { flex: 1; border-style: dashed; }

    .pins { position: absolute; top: 0; left: 0; width: 0; height: 0; }
    .pin { position: absolute; outline: 2px dashed rgba(225,29,72,.75); outline-offset: 1px; pointer-events: none; border-radius: 2px; }
    .pin:not(.active) { outline-color: rgba(113,113,122,.6); }
    .pin-overlay { position: absolute; inset: 0; width: 100%; height: 100%; }
    .pin-label { position: absolute; top: -22px; left: -2px; pointer-events: auto; font-size: 10px; font-weight: 700; padding: 3px 6px; border: none; border-radius: 4px 4px 0 0; background: #71717a; color: #fff; }
    .pin.active .pin-label { background: #e11d48; }
    .pin-label:hover { filter: brightness(1.1); background: #e11d48 !important; }
    .pin.flash { animation: flash 1.2s ease-out 1; }
    @keyframes flash { 0%, 40% { box-shadow: 0 0 0 6px rgba(225,29,72,.45); } 100% { box-shadow: 0 0 0 0 rgba(225,29,72,0); } }

    .stage { position: fixed; inset: 0; z-index: 1; }
    .stage.selecting { cursor: crosshair; background: rgba(0,0,0,.15); }
    .sel-box { position: absolute; display: none; border: 2px solid #e11d48; background: rgba(225,29,72,.06); box-shadow: 0 0 0 99999px rgba(0,0,0,.25); }
    .hint { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); background: #18181b; color: #fff; padding: 8px 14px; border-radius: 999px; font-size: 13px; box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: none; }
    .mask { position: absolute; box-shadow: 0 0 0 99999px rgba(0,0,0,.35); pointer-events: none; }
    .frame-box { position: absolute; outline: 2px solid #e11d48; pointer-events: none; }
    canvas.draw { position: absolute; touch-action: none; }
    .toolbar { position: absolute; visibility: hidden; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: min(760px, calc(100vw - 12px)); padding: 8px; background: #18181b; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
    .toolbar .group { display: flex; gap: 3px; align-items: center; }
    .toolbar .tool { background: #27272a; border-color: #3f3f46; color: #fafafa; min-width: 28px; padding: 5px 7px; }
    .toolbar .tool:hover { background: #3f3f46; }
    .toolbar .tool.on { background: #e11d48; border-color: #e11d48; }
    .toolbar .swatch { width: 20px; height: 20px; padding: 0; border-radius: 50%; border: 2px solid #3f3f46; }
    .toolbar .swatch.on { border-color: #fff; box-shadow: 0 0 0 2px #e11d48; }
    .toolbar .ghost { color: #fafafa; border-color: #3f3f46; }
    .toolbar .ghost:hover { background: #27272a; }
    .caption { flex: 1; min-width: 180px; border: 1px solid #3f3f46; background: #27272a; color: #fafafa; border-radius: 6px; padding: 6px 8px; font-size: 12px; }
    .text-editor { position: absolute; margin: 0; padding: 0 2px; width: 240px; min-width: 120px; background: rgba(255,255,255,.85); border: 1px dashed #e11d48; border-radius: 3px; font-weight: 600; resize: none; overflow: hidden; outline: none; }

    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #18181b; color: #fff; padding: 9px 16px; border-radius: 999px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.3); z-index: 2; }
  `;

  window.__wfcr = { enable, disable, startFrame: () => startFrame() };
})();
