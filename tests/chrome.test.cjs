const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromeHarness } = require('./chrome-harness.cjs');
const bg = h => h.root.style.getPropertyValue('--zen-tab-header-background');

test('every saved tint strength initializes, including zero and partial strength', () => {
  for (const amount of [0, 1, 50, 99, 100]) {
    const h = chromeHarness({ 'zen.page-tint.mix-amount': amount });
    assert.equal(h.root.getAttribute('zen-page-tint-active'), 'on');
    assert.ok(Number.isFinite(parseFloat(h.root.style.getPropertyValue('--zpt-strength'))));
    h.cleanup();
  }
});

test('Zen simulated location changes on tab selection preserve zero-IPC cache hits', () => {
  const h = chromeHarness(); h.flush();
  h.deliver(h.first, 'rgb(20, 30, 40)');
  const second = h.addBrowser('https://other.example/');
  h.select(second); h.flush(); h.deliver(second, 'rgb(60, 70, 80)');
  const before = [h.first.messageManager.loads, h.first.messageManager.sent.length];
  h.select(h.first); h.flush();
  assert.equal(bg(h), 'rgb(20, 30, 40)');
  assert.deepEqual([h.first.messageManager.loads, h.first.messageManager.sent.length], before);
});

test('query routes have separate cache entries and stale route messages cannot paint', () => {
  const h = chromeHarness({}, { url: 'https://example.com/watch?v=old' }); h.flush();
  h.deliver(h.first, 'rgb(10, 20, 30)');
  const second = h.addBrowser('https://example.com/watch?v=new');
  h.select(second); h.flush(); h.deliver(second, 'rgb(70, 80, 90)');
  h.select(h.first); h.flush();
  assert.equal(bg(h), 'rgb(10, 20, 30)');
  h.deliver(h.first, 'rgb(255, 0, 0)', { href: 'https://example.com/watch?v=new' });
  assert.equal(bg(h), 'rgb(10, 20, 30)');
});

test('duplicate-URL tabs restore their own sampled colors without IPC', () => {
  const h = chromeHarness(); h.flush();
  h.deliver(h.first, 'rgb(180, 30, 20)');
  const second = h.addBrowser(h.first.currentURI.spec);
  h.select(second); h.flush(); h.deliver(second, 'rgb(20, 40, 180)');
  const traffic = () => [h.first, second].map(b => [b.messageManager.loads, b.messageManager.sent.length]);
  const before = traffic();
  h.select(h.first); h.flush();
  assert.equal(bg(h), 'rgb(180, 30, 20)');
  h.select(second); h.flush();
  assert.equal(bg(h), 'rgb(20, 40, 180)');
  assert.deepEqual(traffic(), before);
});

test('a sampled colorless tab does not borrow a duplicate URL tint', () => {
  const h = chromeHarness(); h.flush(); h.deliver(h.first, null);
  const second = h.addBrowser(h.first.currentURI.spec);
  h.select(second); h.flush(); h.deliver(second, 'rgb(20, 40, 180)');
  const loads = h.first.messageManager.loads;
  h.select(h.first); h.flush();
  assert.equal(h.root.hasAttribute('zen-page-tint'), false);
  assert.equal(h.first.messageManager.loads, loads);
});

test('background same-document routes invalidate the tab-local sample', () => {
  const h = chromeHarness(); h.flush(); h.deliver(h.first, 'rgb(180, 30, 20)');
  const second = h.addBrowser('https://example.com/#second');
  h.select(second); h.flush(); h.deliver(second, 'rgb(20, 40, 180)');
  h.navigate(h.first, second.currentURI.spec, true);
  const loads = h.first.messageManager.loads;
  h.select(h.first); h.flush();
  assert.equal(bg(h), 'rgb(20, 40, 180)');
  assert.equal(h.first.messageManager.loads, loads + 1);
});

test('same-document navigation requests a fresh sample', () => {
  const h = chromeHarness(); h.flush();
  const loads = h.first.messageManager.loads;
  h.navigate(h.first, 'https://example.com/#new-route', true); h.flush();
  assert.equal(h.first.messageManager.loads, loads + 1);
});

test('a stale sample from the previous request cannot repaint after reloading the same URL', () => {
  const h = chromeHarness(); h.flush();
  const old = h.config();
  h.navigate(h.first, h.first.currentURI.spec); h.flush();
  h.deliver(h.first, 'rgb(50, 60, 70)');
  h.deliver(h.first, 'rgb(255, 0, 0)', { requestId: old.requestId });
  assert.equal(bg(h), 'rgb(50, 60, 70)');
});

test('queued samples cannot collide with request IDs after a mod hot reload', () => {
  const h = chromeHarness(); h.flush();
  const old = h.config();
  h.cleanup(); h.reload(); h.flush();
  h.deliver(h.first, 'rgb(50, 60, 70)');
  h.deliver(h.first, 'rgb(255, 0, 0)', { requestId: old.requestId });
  assert.equal(bg(h), 'rgb(50, 60, 70)');
});

test('settings invalidation rejects background samples and refreshes duplicate-URL tabs', () => {
  const h = chromeHarness(); h.flush();
  h.deliver(h.first, 'rgb(20, 20, 20)');
  const second = h.addBrowser(h.first.currentURI.spec);
  h.select(second); h.flush(); h.deliver(second, 'rgb(20, 20, 20)');
  h.select(h.first); h.flush();
  h.pref('zen.page-tint.light-average', true); h.flush();
  h.deliver(h.first, 'rgb(100, 100, 100)');
  h.deliver(second, 'rgb(20, 20, 20)');
  const loads = second.messageManager.loads;
  h.select(second); h.flush();
  assert.equal(bg(h), 'rgb(100, 100, 100)');
  assert.equal(second.messageManager.loads, loads + 1);
});

test('a background document replacement reloads the sampler even on a cache hit', () => {
  const h = chromeHarness(); h.flush(); h.deliver(h.first, 'rgb(20, 20, 20)');
  const second = h.addBrowser('https://other.example/');
  h.select(second); h.flush();
  h.navigate(h.first, h.first.currentURI.spec);
  const loads = h.first.messageManager.loads;
  h.select(h.first); h.flush();
  assert.equal(h.first.messageManager.loads, loads + 1);
});

test('partially failed listener registration is rolled back before retry', () => {
  const h = chromeHarness(); h.first.messageManager.failReady = true; h.flush();
  assert.equal(h.first.messageManager.listenerCount(), 0);
  assert.equal(h.first.messageManager.loads, 0);
  h.first.messageManager.failReady = false;
  h.select(h.first); h.flush();
  assert.equal(h.first.messageManager.listenerCount(), 2);
});

test('cleanup cancels pending startup and restores the original inline CSS', () => {
  const initialStyle = { '--zpt-frame-gap': '7px', '--zen-tab-header-background': 'rgb(1, 2, 3)' };
  const h = chromeHarness({}, { readyState: 'loading', initialStyle });
  h.cleanup(); h.window.emit('load'); h.flush();
  assert.equal(h.first.messageManager.loads, 0);
  for (const [name, value] of Object.entries(initialStyle)) {
    assert.equal(h.root.style.getPropertyValue(name), value);
    assert.equal(h.root.style.getPropertyPriority(name), 'important');
  }
  assert.equal(h.root.style.getPropertyValue('--zpt-live-smoothing-ms'), '');
});

test('foreground uses contrast ratios for saturated and midtone backgrounds', () => {
  const h = chromeHarness(); h.flush();
  for (const color of ['rgb(255, 0, 0)', 'rgb(0, 180, 0)', 'rgb(128, 128, 128)']) {
    h.deliver(h.first, color);
    assert.equal(h.root.style.getPropertyValue('--zen-tab-header-foreground'), '#000', color);
  }
  h.deliver(h.first, 'rgb(0, 0, 80)');
  assert.equal(h.root.style.getPropertyValue('--zen-tab-header-foreground'), '#fff');
});

test('brightness and contrast reapply the raw cached color within lightness bounds', () => {
  const h = chromeHarness(); h.flush(); h.deliver(h.first, 'rgb(100, 100, 100)');
  const loads = h.first.messageManager.loads;
  const messages = h.first.messageManager.sent.length;
  h.pref('zen.page-tint.brightness', 200);
  assert.equal(bg(h), 'rgb(200, 200, 200)');
  h.pref('zen.page-tint.brightness', 100);
  assert.equal(bg(h), 'rgb(100, 100, 100)', 'Appearance edits must not compound on a previously transformed color');
  h.pref('zen.page-tint.contrast', 0);
  assert.equal(bg(h), 'rgb(128, 128, 128)');
  h.pref('zen.page-tint.contrast', 100);
  h.pref('zen.page-tint.min-lightness', 60);
  assert.equal(bg(h), 'rgb(153, 153, 153)');
  h.pref('zen.page-tint.max-lightness', 70);
  h.pref('zen.page-tint.brightness', 300);
  assert.equal(bg(h), 'rgb(179, 179, 179)', 'Brightness must respect the final lightness cap');
  assert.equal(h.first.messageManager.loads, loads);
  assert.equal(h.first.messageManager.sent.length, messages, 'Appearance edits must not resample the page');
});

test('disabling a host tears down its sampler and reenabling restores it', () => {
  const h = chromeHarness(); h.flush(); h.deliver(h.first, 'rgb(40, 50, 60)');
  h.pref('zen.page-tint.disable-hosts', 'example.com'); h.flush();
  assert.equal(h.root.hasAttribute('zen-page-tint'), false);
  assert.equal(h.first.messageManager.listenerCount(), 0);
  assert.ok(h.first.messageManager.sent.some(m => m.name.endsWith(':teardown')));
  const loads = h.first.messageManager.loads;
  h.pref('zen.page-tint.disable-hosts', ''); h.flush();
  assert.equal(h.first.messageManager.loads, loads + 1);
  assert.equal(bg(h), 'rgb(40, 50, 60)');
});

test('changing spread and teardown never instantiate restored lazy tabs', () => {
  const h = chromeHarness(); h.flush();
  let lazyAccesses = 0;
  for (let i = 0; i < 1700; i++) {
    h.gBrowser.tabs.push({
      linkedPanel: null,
      get linkedBrowser() { lazyAccesses++; throw new Error('Lazy browser was accessed'); },
      hasAttribute() { return true; },
    });
  }
  // Browser enumeration itself is hazardous in Gecko; use only realized tabs.
  Object.defineProperty(h.gBrowser, 'browsers', {
    get() { lazyAccesses++; throw new Error('All browsers were enumerated'); },
  });
  const loads = h.first.messageManager.loads;
  for (const spread of [100, 0, 100]) {
    h.pref('zen.page-tint.ambient-spread', spread); h.flush();
  }
  assert.equal(h.first.messageManager.loads, loads + 3);
  h.cleanup();
  assert.equal(lazyAccesses, 0, 'Even a caught property access would instantiate a real lazy browser');
});

test('ambient edges preserve the chosen foreground contrast', () => {
  const h = chromeHarness({ 'zen.page-tint.ambient-spread': 100 }); h.flush();
  h.deliver(h.first, 'rgb(0, 0, 0)', { edges: { l: 'rgb(255, 255, 255)', r: 'rgb(255, 255, 255)', t: 'rgb(255, 255, 255)', b: 'rgb(255, 255, 255)' } });
  const alpha = Number(h.root.style.getPropertyValue('--zpt-edge-l').match(/, ([\d.]+)\)$/)[1]);
  const linear = ((alpha + 0.055) / 1.055) ** 2.4;
  assert.ok(1.05 / (linear + 0.05) >= 4.5);

  h.deliver(h.first, 'rgb(0, 153, 0)', { edges: { l: 'rgb(255, 51, 255)', r: 'rgb(255, 51, 255)', t: 'rgb(255, 51, 255)', b: 'rgb(255, 51, 255)' } });
  const limit = Number(h.root.style.getPropertyValue('--zpt-edge-l').match(/, ([\d.]+)\)$/)[1]);
  for (let step = 0; step <= 20; step++) {
    const t = limit * step / 20;
    const channels = [255 * t, 153 - 102 * t, 255 * t];
    const luminance = channels.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    assert.ok((luminance + .05) / .05 >= 4.5, `Unreadable gradient at ${t}`);
  }
});
