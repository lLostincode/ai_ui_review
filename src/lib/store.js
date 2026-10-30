// Storage layout shared by the review page. The content script keeps its own
// copy of these keys because content scripts cannot import ES modules.
//
//   wfcr:state       -> { version, projectName, promptTemplate, requests[], activeRequestId, nextNumber }
//   wfcr:img:<uuid>  -> data URL of one image (kept separate so the state stays small)

export const STATE_KEY = 'wfcr:state';
export const IMG_PREFIX = 'wfcr:img:';

export function emptyState() {
  return { version: 1, projectName: '', promptTemplate: null, requests: [], activeRequestId: null, nextNumber: 1 };
}

export async function loadState() {
  const result = await chrome.storage.local.get(STATE_KEY);
  return { ...emptyState(), ...(result[STATE_KEY] ?? {}) };
}

let writeQueue = Promise.resolve();

/** Re-reads the latest state, applies `fn`, and writes it back. Serialized per page. */
export function mutate(fn) {
  const run = writeQueue.then(async () => {
    const state = await loadState();
    fn(state);
    await chrome.storage.local.set({ [STATE_KEY]: state });
    return state;
  });
  writeQueue = run.catch(() => {});
  return run;
}

export async function getImages(ids) {
  const keys = ids.filter(Boolean).map((id) => IMG_PREFIX + id);
  if (!keys.length) return {};
  const result = await chrome.storage.local.get(keys);
  return Object.fromEntries(Object.entries(result).map(([k, v]) => [k.slice(IMG_PREFIX.length), v]));
}

export function imageIdsOf(item) {
  return item.type === 'frame' ? Object.values(item.images ?? {}).filter(Boolean) : [];
}

export async function removeImages(ids) {
  if (ids.length) await chrome.storage.local.remove(ids.map((id) => IMG_PREFIX + id));
}
