// Turns the stored change requests into an AI-ready prompt (Markdown) plus the
// list of image files that belong next to it. Pure: no chrome.* access.

export const DEFAULT_TEMPLATE = `# UI change requests{{projectSuffix}}

I reviewed the running web app ({{origins}}) and recorded {{count}} change request(s) below.
Please implement them in this codebase.

How to read this feedback:
- Each change request (CR) is one coherent change. It contains frames and/or text notes, in order.
- A frame is a screenshot of a region of the page. My annotations (freehand strokes, arrows,
  boxes, highlights and handwritten text) are drawn on top of the real UI in the "annotated" image.
  They are instructions, not part of the design: crossed-out = remove, arrows = move/point at,
  boxes = "this element", text = what I want.
- The "clean" image shows the same region without my drawings, and the "context" image shows the
  whole viewport with the region outlined, so you can see where it is on the page.
- Each frame lists the full URL it was captured on. Its path, query and hash tell you which route
  (and which page state) to look at.
- "DOM hints" list selectors, test ids and visible text of elements inside the region. Use them to
  find the responsible components in the code (search for the text, test ids or class names).

How to work:
1. For each CR, locate the relevant code, then make the smallest change that satisfies it.
   Match the existing design system, components and styling conventions.
2. If a CR is ambiguous, make a reasonable choice and state the assumption.
3. When done, list per CR what you changed (files) and anything you could not resolve.

{{requests}}`;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const MARKER = /\u0000IMG(\d+)\u0000/;

function imageMarker(index) {
  return `\u0000IMG${index}\u0000`;
}

export function crLabel(number) {
  return 'CR-' + String(number).padStart(3, '0');
}

function slug(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function exportFolderName(date, label = 'web-feedback') {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${label}-${stamp}`;
}

function quote(text) {
  return text
    .trim()
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
}

function inlineCode(text) {
  const s = String(text).replace(/\s+/g, ' ');
  const fence = s.includes('`') ? '``' : '`';
  return `${fence}${s}${fence}`;
}

function describeHint(d) {
  const bits = [inlineCode(d.selector)];
  if (d.testId) bits.push(`test id ${inlineCode(d.testId)}`);
  if (d.ariaLabel) bits.push(`aria-label "${d.ariaLabel}"`);
  if (d.alt) bits.push(`alt "${d.alt}"`);
  if (d.placeholder) bits.push(`placeholder "${d.placeholder}"`);
  if (d.href) bits.push(`href ${inlineCode(d.href)}`);
  if (d.text) bits.push(`"${d.text}"`);
  return bits.join(' — ');
}

// Bare icons and wrappers without text or labels only add noise to the prompt.
function isIdentifiable(d) {
  return Boolean(d.text || d.testId || d.ariaLabel || d.alt || d.placeholder || d.href);
}

function pagePath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * @param {object} state stored extension state
 * @param {object} [options]
 * @param {string[]} [options.requestIds] which CRs to include (default: all)
 * @param {boolean} [options.includeClean=true]
 * @param {boolean} [options.includeContext=true]
 * @param {boolean} [options.includeDomHints=true]
 * @param {Date} [options.date]
 * @param {boolean} [options.imageMarkers=false] reference images with IMAGE_MARKER tokens instead of file paths
 * @returns {{markdown: string, images: {path: string, imageId: string, label: string}[], data: object}}
 */
export function buildExport(state, options = {}) {
  const {
    requestIds = null,
    includeClean = true,
    includeContext = true,
    includeDomHints = true,
    date = new Date(),
    imageMarkers = false,
  } = options;

  const requests = state.requests.filter((r) => !requestIds || requestIds.includes(r.id));
  const images = [];
  const sections = [];
  const origins = new Set();

  for (const req of requests) {
    const label = crLabel(req.number);
    const lines = [`## ${label}: ${req.title?.trim() || 'Untitled change request'}`, ''];
    let frameNo = 0;

    if (req.items.length === 0) lines.push('_No frames or notes were added to this change request._', '');

    req.items.forEach((item, index) => {
      const step = index + 1;
      if (item.type === 'text') {
        lines.push(`### ${label}.${step} Note`, '', item.text?.trim() ? quote(item.text) : '_(empty note)_', '');
        return;
      }

      frameNo += 1;
      const origin = originOf(item.url);
      if (origin) origins.add(origin);
      const base = `images/${label}-${frameNo}`;
      const add = (kind, ext, description) => {
        const imageId = item.images?.[kind];
        if (!imageId) return null;
        const path = `${base}-${kind}.${ext}`;
        images.push({ path, imageId, label: `${label} frame ${frameNo}, ${description}` });
        return { path, marker: imageMarker(images.length - 1) };
      };
      // Inline mention of an image: a marker for paste sequences, else its file path.
      const mention = (ref) => (imageMarkers ? ref.marker : `\`${ref.path}\``);
      const annotated = add('annotated', 'png', 'annotated');
      const clean = includeClean ? add('clean', 'png', 'without annotations') : null;
      const context = includeContext ? add('context', 'jpg', 'full viewport') : null;

      lines.push(`### ${label}.${step} Frame on \`${pagePath(item.url)}\``, '');
      if (annotated) {
        lines.push(imageMarkers ? annotated.marker : `![${label} frame ${frameNo}, annotated](${annotated.path})`, '');
      }
      if (item.note?.trim()) lines.push(quote(item.note), '');

      const texts = item.annotations?.texts?.filter((t) => t.trim()) ?? [];
      if (texts.length) {
        lines.push('Text written on the screenshot:');
        texts.forEach((t) => lines.push(`- "${t.replace(/\s+/g, ' ').trim()}"`));
        lines.push('');
      }

      const r = item.docRect ?? item.rect;
      lines.push(`- URL: \`${item.url}\``);
      if (item.pageTitle) lines.push(`- Page title: ${item.pageTitle}`);
      if (r && item.viewport) {
        lines.push(
          `- Region: ${Math.round(r.w)}×${Math.round(r.h)} CSS px at x=${Math.round(r.x)}, y=${Math.round(r.y)} (document), viewport ${item.viewport.w}×${item.viewport.h} @${item.viewport.dpr}x`,
        );
      }
      if (clean) lines.push(`- Without annotations: ${mention(clean)}`);
      if (context) lines.push(`- Full viewport for context: ${mention(context)}`);

      const dom = item.dom;
      if (includeDomHints && dom && !dom.error) {
        const hints = [];
        if (dom.container) hints.push(`  - Region container: ${describeHint(dom.container)}`);
        if (dom.center && dom.center.selector !== dom.container?.selector) {
          hints.push(`  - Element at region centre: ${describeHint(dom.center)}`);
        }
        const shown = new Set([dom.container?.selector, dom.center?.selector]);
        for (const el of dom.elements ?? []) {
          if (!shown.has(el.selector) && isIdentifiable(el)) hints.push(`  - ${describeHint(el)}`);
        }
        if (hints.length) lines.push('- DOM hints:', ...hints);
      }
      lines.push('');
    });

    sections.push(lines.join('\n').trimEnd());
  }

  const requestsMarkdown = sections.join('\n\n---\n\n');
  const template = state.promptTemplate?.trim() ? state.promptTemplate : DEFAULT_TEMPLATE;
  const values = {
    project: state.projectName?.trim() ?? '',
    projectSuffix: state.projectName?.trim() ? ` — ${state.projectName.trim()}` : '',
    date: date.toISOString().slice(0, 10),
    count: String(requests.length),
    origins: origins.size ? [...origins].join(', ') : 'the web app',
    requests: requestsMarkdown,
  };
  let markdown = template.replace(PLACEHOLDER, (match, key) => (key in values ? values[key] : match));
  if (!template.includes('{{requests}}')) markdown = markdown.trimEnd() + '\n\n' + requestsMarkdown;

  const data = {
    project: values.project,
    exportedAt: date.toISOString(),
    requests: requests.map((req) => {
      let frameNo = 0;
      return {
        id: crLabel(req.number),
        title: req.title,
        items: req.items.map((item) => {
          if (item.type === 'text') return { type: 'text', text: item.text };
          frameNo += 1;
          const base = `images/${crLabel(req.number)}-${frameNo}`;
          return {
            type: 'frame',
            url: item.url,
            pageTitle: item.pageTitle,
            note: item.note,
            annotatedText: item.annotations?.texts ?? [],
            region: item.docRect,
            viewport: item.viewport,
            images: {
              annotated: item.images?.annotated ? `${base}-annotated.png` : undefined,
              clean: includeClean && item.images?.clean ? `${base}-clean.png` : undefined,
              context: includeContext && item.images?.context ? `${base}-context.jpg` : undefined,
            },
            dom: includeDomHints ? item.dom : undefined,
          };
        }),
      };
    }),
  };

  return { markdown: markdown.trimEnd() + '\n', images, data };
}

export function exportLabelFor(state, requestIds) {
  if (requestIds?.length === 1) {
    const req = state.requests.find((r) => r.id === requestIds[0]);
    if (req) return [crLabel(req.number).toLowerCase(), slug(req.title)].filter(Boolean).join('-');
  }
  return slug(state.projectName) || 'web-feedback';
}

/**
 * Splits the prompt into clipboard steps for chat UIs that embed pasted images
 * (Claude Code, claude.ai, …). The clipboard holds one image at a time, so the
 * user copies and pastes step by step.
 *
 * layout 'interleaved': text → image 1 → text → image 2 → … (each image right after its label)
 * layout 'text-first':  the full text with [Image N: …] labels → image 1 → … → image N
 *
 * @returns {{steps: ({type: 'text', text: string} | {type: 'image', imageId: string, label: string, number: number})[], images: object[]}}
 */
export function buildPasteSequence(state, options = {}) {
  const { layout = 'interleaved', ...rest } = options;
  const { markdown, images } = buildExport(state, { ...rest, imageMarkers: true });
  const label = (i) => `[Image ${i + 1}: ${images[i].label}]`;
  const imageStep = (i) => ({ type: 'image', imageId: images[i].imageId, label: images[i].label, number: i + 1 });
  // split() with a capture group alternates text and marker indices: [text, i, text, i, …, text]
  const parts = markdown.split(new RegExp(MARKER.source, 'g'));
  const steps = [];

  if (layout === 'text-first') {
    let text = parts.map((part, k) => (k % 2 ? label(Number(part)) : part)).join('').trimEnd();
    if (images.length) {
      text += `\n\nThe ${images.length} image(s) referenced above as [Image 1]…[Image ${images.length}] follow in that order.`;
    }
    steps.push({ type: 'text', text: text + '\n' });
    images.forEach((_, i) => steps.push(imageStep(i)));
    return { steps, images };
  }

  for (let k = 0; k < parts.length; k += 2) {
    const index = k + 1 < parts.length ? Number(parts[k + 1]) : null;
    const text = (parts[k] + (index === null ? '' : label(index))).trim();
    if (text) steps.push({ type: 'text', text: text + '\n' });
    if (index !== null) steps.push(imageStep(index));
  }
  return { steps, images };
}
