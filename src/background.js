// Service worker: tracks which tabs have the overlay enabled, (re)injects the
// content script after navigation, and performs screenshots on request.

const CONTENT_SCRIPT = 'src/content/overlay.js';
const REVIEW_PAGE = 'src/review/review.html';
const SESSION_KEY = 'enabledTabs';

async function getEnabledTabs() {
  const result = await chrome.storage.session.get(SESSION_KEY);
  return new Set(result[SESSION_KEY] ?? []);
}

async function setTabEnabled(tabId, enabled) {
  const tabs = await getEnabledTabs();
  if (enabled) tabs.add(tabId);
  else tabs.delete(tabId);
  await chrome.storage.session.set({ [SESSION_KEY]: [...tabs] });
  await chrome.action.setBadgeText({ tabId, text: enabled ? 'ON' : '' });
  if (enabled) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e11d48' });
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
}

async function callOverlay(tabId, method) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (name) => window.__wfcr?.[name]?.(),
    args: [method],
  });
}

async function enableOn(tabId) {
  await inject(tabId);
  await callOverlay(tabId, 'enable');
}

async function toggle(tab) {
  if (!tab?.id) return;
  const enabled = (await getEnabledTabs()).has(tab.id);
  try {
    if (enabled) {
      await callOverlay(tab.id, 'disable').catch(() => {});
      await setTabEnabled(tab.id, false);
    } else {
      await enableOn(tab.id);
      await setTabEnabled(tab.id, true);
    }
  } catch (err) {
    // chrome://, the Web Store and other restricted pages cannot be scripted.
    console.warn('[wfcr] cannot toggle overlay on this page:', err);
    await chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2000);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

chrome.action.onClicked.addListener(toggle);

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (!tab?.id) return;
  if (command === 'toggle-overlay') return toggle(tab);
  if (command === 'new-frame') {
    if (!(await getEnabledTabs()).has(tab.id)) await toggle(tab);
    await callOverlay(tab.id, 'startFrame').catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'open-review',
    title: 'Review & export change requests',
    contexts: ['action'],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-review') chrome.tabs.create({ url: chrome.runtime.getURL(REVIEW_PAGE) });
});

// Keep the overlay alive across full page loads in tabs where it is enabled.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  if (!(await getEnabledTabs()).has(tabId)) return;
  try {
    await enableOn(tabId);
    await chrome.action.setBadgeText({ tabId, text: 'ON' });
  } catch {
    await setTabEnabled(tabId, false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getEnabledTabs().then((tabs) => {
    if (tabs.delete(tabId)) chrome.storage.session.set({ [SESSION_KEY]: [...tabs] });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'wfcr:capture':
      chrome.tabs
        .captureVisibleTab(sender.tab.windowId, { format: 'png' })
        .then((dataUrl) => sendResponse({ dataUrl }))
        .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
      return true;
    case 'wfcr:disable':
      setTabEnabled(sender.tab.id, false).then(() => sendResponse({ ok: true }));
      return true;
    case 'wfcr:open-review':
      chrome.tabs.create({ url: chrome.runtime.getURL(REVIEW_PAGE) });
      return false;
    default:
      return false;
  }
});
