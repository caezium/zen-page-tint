const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function events(target = {}) {
  const listeners = new Map();
  target.addEventListener = (name, handler, options) => {
    if (!listeners.has(name)) listeners.set(name, new Map());
    listeners.get(name).set(handler, options);
  };
  target.removeEventListener = (name, handler) => listeners.get(name)?.delete(handler);
  target.emit = (name, event = {}) => {
    for (const [handler, options] of [...(listeners.get(name) || [])]) {
      if (options?.once) listeners.get(name).delete(handler);
      handler(event);
    }
  };
  return target;
}

function style() {
  const values = new Map();
  return {
    setProperty(name, value, priority = '') { values.set(name, [value, priority]); },
    getPropertyValue(name) { return values.get(name)?.[0] || ''; },
    getPropertyPriority(name) { return values.get(name)?.[1] || ''; },
    removeProperty(name) { values.delete(name); },
  };
}

function chromeHarness(prefs = {}, options = {}) {
  const source = options.source || fs.readFileSync(path.join(__dirname, '../tint.uc.js'), 'utf8');
  const timers = new Map();
  let nextTimer = 0;
  const queue = fn => { timers.set(++nextTimer, fn); return nextTimer; };
  const attrs = new Map();
  const root = {
    style: style(),
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name),
    hasAttribute: name => attrs.has(name),
    getAttribute: name => attrs.get(name),
    appendChild() {},
  };
  for (const [name, value] of Object.entries(options.initialStyle || {})) root.style.setProperty(name, value, 'important');
  const mutations = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const window = events({ matchMedia: () => colorScheme, crypto: require('node:crypto').webcrypto });
  const colorScheme = events({ matches: true });
  const document = { documentElement: root, readyState: options.readyState || 'complete',
    createElement: () => ({ style: style(), remove() {} }),
    createElementNS: () => ({ style: style(), remove() {} }),
    querySelector: () => null, querySelectorAll: () => [] };
  let documentId = 0;
  const browsers = [];
  function addBrowser(url) {
    const messages = new Map();
    const mm = {
      sent: [], loads: 0,
      addMessageListener(name, listener) {
        if (mm.failReady && name.endsWith(':ready')) throw new Error('attach failed');
        if (!messages.has(name)) messages.set(name, new Set());
        messages.get(name).add(listener);
      },
      removeMessageListener: (name, listener) => messages.get(name)?.delete(listener),
      loadFrameScript() { mm.loads++; },
      sendAsyncMessage(name, data) { mm.sent.push({ name, data }); },
      deliver(name, data) {
        for (const listener of messages.get(name) || []) {
          if (typeof listener === 'function') listener({ data });
          else listener.receiveMessage({ data });
        }
      },
      listenerCount: () => [...messages.values()].reduce((n, set) => n + set.size, 0),
    };
    const browser = { currentURI: { spec: url }, messageManager: mm,
      browsingContext: { currentWindowGlobal: { innerWindowId: ++documentId } } };
    browser.tab = { linkedBrowser: browser, linkedPanel: 'panel', hasAttribute: () => false };
    browsers.push(browser);
    return browser;
  }
  const first = addBrowser(options.url || 'https://example.com/');
  const gBrowser = { selectedBrowser: first, selectedTab: first.tab,
    tabs: browsers.map(b => b.tab), tabContainer: events(),
    getTabForBrowser: b => b.tab,
    addProgressListener(listener) { this.progress = listener; },
    removeProgressListener() { this.progress = null; } };
  let prefObserver;
  let cleanup;
  const context = vm.createContext({
    console, URL, document, window, gBrowser, MutationObserver,
    Services: { prefs: {
      getBoolPref: (key, fallback) => prefs[key] ?? fallback,
      getIntPref: (key, fallback) => prefs[key] ?? fallback,
      getStringPref: (key, fallback) => prefs[key] ?? fallback,
      addObserver: (_branch, observer) => { prefObserver = observer; },
      removeObserver: () => { prefObserver = null; },
    } },
    ChromeUtils: { generateQI: () => () => {} },
    Ci: { nsIWebProgressListener: { LOCATION_CHANGE_SAME_DOCUMENT: 1 } },
    getComputedStyle: () => ({ color: 'rgb(32, 32, 32)', getPropertyValue: () => '' }),
    requestAnimationFrame: queue, cancelAnimationFrame: id => timers.delete(id),
    setTimeout: queue, clearTimeout: id => timers.delete(id),
    addUnloadListener: fn => { cleanup = fn; },
  });
  vm.runInContext(source, context, { filename: 'tint.uc.js' });
  return {
    root, first, gBrowser, window, colorScheme, mutations,
    addBrowser(url) { const b = addBrowser(url); gBrowser.tabs.push(b.tab); return b; },
    flush() { for (const [id, fn] of [...timers]) if (timers.delete(id)) fn(); },
    get pending() { return timers.size; },
    select(browser, simulated = true) {
      gBrowser.selectedBrowser = browser; gBrowser.selectedTab = browser.tab;
      gBrowser.tabContainer.emit('TabSelect');
      if (simulated) gBrowser.progress.onLocationChange({ isTopLevel: true }, null, browser.currentURI, 0, true);
    },
    navigate(browser, url, sameDocument = false) {
      browser.currentURI.spec = url;
      if (!sameDocument) browser.browsingContext.currentWindowGlobal.innerWindowId = ++documentId;
      if (browser === gBrowser.selectedBrowser) gBrowser.progress.onLocationChange({ isTopLevel: true }, null, browser.currentURI, sameDocument ? 1 : 0);
    },
    config(browser = first) { return browser.messageManager.sent.findLast(m => m.name.endsWith(':config'))?.data || {}; },
    deliver(browser, bg, extra = {}) {
      const config = this.config(browser);
      browser.messageManager.deliver('zen-page-tint:theme', { bg, href: browser.currentURI.spec, requestId: config.requestId, ...extra });
    },
    pref(name, value) { prefs[name] = value; prefObserver.observe(null, 'nsPref:changed', name); },
    cleanup: () => cleanup(),
    reload: () => vm.runInContext(source, context, { filename: 'tint.uc.js' }),
  };
}

module.exports = { chromeHarness, events };
