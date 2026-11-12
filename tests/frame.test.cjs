'use strict';
// Independent behavioral harness: the actual frame script runs without source rewriting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frame.js'), 'utf8');

function createHarness({host = 'example.com', configure = true} = {}) {
  let now = 10_000;
  let nextId = 0;
  let flipped = false;
  let videos = [];
  const messages = [];
  const timers = new Map();
  const observers = [];
  const draws = [];
  const messageListeners = new Map();
  function target(extra = {}) {
    const listeners = new Map();
    return Object.assign({
      addEventListener(type, fn, options) {
        const handlers = listeners.get(type) || [];
        handlers.push({fn, once: !!options?.once, capture: options === true || !!options?.capture});
        listeners.set(type, handlers);
      },
      removeEventListener(type, fn) {
        listeners.set(type, (listeners.get(type) || []).filter(h => h.fn !== fn));
      },
      fireCaptured(type, data = {}) {
        for (const h of [...(listeners.get(type) || [])]) {
          if (h.capture) h.fn({type, target:this, ...data});
        }
      },
      fire(type, data = {}) {
        for (const h of [...(listeners.get(type) || [])]) {
          if (h.once) this.removeEventListener(type, h.fn);
          h.fn({type, target: this, ...data});
        }
      },
    }, extra);
  }
  const context2d = {
    DRAWWINDOW_DRAW_VIEW: 4,
    setTransform() {}, clearRect() {},
    drawWindow(win, ...args) { draws.push({document:win.document, args}); },
    getImageData() {
      const data = new Uint8ClampedArray(16 * 16 * 4);
      // Equal red/blue halves, with a mean invariant under a left/right swap.
      for (let i = 0; i < 256; i++) {
        data[4 * i + ((i % 16 < 8) !== flipped ? 0 : 2)] = 255;
        data[4 * i + 3] = 255;
      }
      return {data};
    },
  };
  const makeDoc = () => target({
    readyState:'complete', visibilityState:'visible',
    body:target({nodeName:'BODY'}), documentElement:target({nodeName:'HTML'}), head:target({nodeName:'HEAD'}),
    createElementNS() { return {getContext() { return context2d; }}; },
    querySelectorAll(selector) { return selector === 'video' ? videos : []; },
    getElementById() {return null;}, querySelector() {return null;},
  });
  const document = makeDoc();
  function setTimer(fn, delay = 0) { const id = ++nextId; timers.set(id, {fn, at: now + delay}); return id; }
  function clearTimer(id) {timers.delete(id);}
  const content = target({
    document, innerWidth:1000, innerHeight:800, scrollX:0, scrollY:0,
    location:{href:`https://${host}/`, hostname:host},
    windowGlobalChild:{innerWindowId:1},
    setTimeout:setTimer, clearTimeout:clearTimer,
    MutationObserver: class {
      constructor(fn) {this.fn = fn; this.observed = []; this.connected = false; observers.push(this);}
      observe(node, options) {this.connected = true; this.observed.push({node, options});}
      disconnect() {this.connected = false;}
      emit(records) {if (this.connected) this.fn(records);}
    },
  });
  document.defaultView = content;
  document.documentURI = content.location.href;
  document.URL = content.location.href;
  class FakeDate extends Date {static now() {return now;}}
  const sandbox = {
    content, console, Date:FakeDate,
    setTimeout:setTimer, clearTimeout:clearTimer,
    addMessageListener(name, listener) {messageListeners.set(name, listener);},
    removeMessageListener(name, listener) {if (messageListeners.get(name) === listener) messageListeners.delete(name);},
    sendAsyncMessage(name, data) {messages.push({name, data});},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, {filename:'frame.js'});
  let config = {requestId:'fixture', ytAmbient:true};
  if (configure) messageListeners.get('zen-page-tint:config').receiveMessage({data:config});
  return {
    document, content, messages, timers, observers, draws,
    configure(data) {
      config = {requestId:'fixture', ytAmbient:true, ...data};
      messageListeners.get('zen-page-tint:config').receiveMessage({data:config});
    },
    samples() {return messages.filter(m => m.name === 'zen-page-tint:theme');},
    reload() {
      vm.runInContext(source, sandbox);
      messageListeners.get('zen-page-tint:config').receiveMessage({data:config});
    },
    flip() {flipped = !flipped;},
    setVideos(next) {videos = next;},
    advance(ms) {
      const end = now + ms;
      let count = 0;
      while (true) {
        const next = [...timers.entries()].sort((a,b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        if (++count > 1000) throw new Error('Unbounded timer loop');
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
    navigate(url) {
      const next = makeDoc();
      next.defaultView = content; next.documentURI = next.URL = url;
      content.document = next; content.location = new URL(url);
      content.windowGlobalChild = {innerWindowId:content.windowGlobalChild.innerWindowId + 1};
      return next;
    },
  };
}

function youtubeHarness(visible = true) {
  const h = createHarness({host:'www.youtube.com'});
  let ambientVisible = visible;
  const watchPage = {parentElement:null};
  const container = {parentElement:watchPage, checkVisibility() {return ambientVisible;}};
  const video = {videoWidth:1920, videoHeight:1080,
    getBoundingClientRect() {return {left:50, top:60, width:800, height:450};},
  };
  h.document.getElementById = id => id === 'cinematics' ? container : null;
  h.document.querySelector = selector => selector.includes('video') ? video : null;
  h.configure({requestId:'youtube', ytAmbient:true});
  return Object.assign(h, {
    setAmbient(visible, target = container) {
      ambientVisible = visible;
      for (const observer of h.observers.filter(o => o.observed.some(t => t.node === target))) {
        observer.emit([{type:'attributes', attributeName:target === container ? 'style' : 'cinematics-active', target}]);
      }
    },
    watchPage,
  });
}

const cases = [
  ['cold startup samples only after the config handshake', () => {
    const h = createHarness({configure:false});
    assert.equal(h.draws.length, 0);
    h.configure({edges:true});
    assert.equal(h.draws.length, 1);
    assert.ok(h.samples()[0].data.edges);
  }],
  ['sampling config is applied to an already-complete idle document', () => {
    const h = createHarness(); h.configure({edges:true}); h.advance(300);
    assert.ok(h.samples().at(-1).data.edges, 'Enabling edges must publish edges without requiring a video or mutation');
    const count = h.samples().length;
    h.configure({edges:true}); h.advance(300);
    assert.equal(h.samples().length, count, 'Repeated identical config must be idempotent');
  }],
  ['directional colors update when the overall mean is unchanged', () => {
    const h = createHarness(); h.configure({edges:true, liveRateMs:100, alwaysOn:true});
    // Reload starts using stored config, isolating edge-change detection from the first-config bug.
    h.reload();
    const first = h.samples().at(-1).data.edges;
    assert.ok(first, 'Fixture must have an initial directional color');
    h.flip(); h.advance(100);
    const latest = h.samples().at(-1).data.edges;
    assert.notEqual(latest.l, first.l, 'A red/blue swap must move the directional glow even though bg is identical');
    assert.equal(latest.l, first.r);
  }],
  ['delayed load samples do not draw or send while hidden', () => {
    const h = createHarness(); const draws = h.draws.length, samples = h.samples().length;
    h.content.fire('load'); h.document.visibilityState = 'hidden'; h.advance(2100);
    assert.equal(h.draws.length, draws, 'Load timers must defer pixel readback in background');
    assert.equal(h.samples().length, samples, 'Load timers must defer IPC in background');
    h.document.visibilityState = 'visible'; h.document.fire('visibilitychange'); h.advance(300);
    assert.ok(h.draws.length > draws, 'Deferred load sampling must occur on foreground');
  }],
  ['mutation debounce rechecks visibility at execution time', () => {
    const h = createHarness(); const draws = h.draws.length;
    const observer = h.observers.find(o => o.observed.some(t => t.node === h.document.body));
    observer.emit([{type:'attributes', attributeName:'class', target:h.document.body}]);
    h.document.visibilityState = 'hidden'; h.advance(300);
    assert.equal(h.draws.length, draws, 'A visible-to-hidden race must not drawWindow in background');
  }],
  ['hidden title changes do not dirty a cached tab', () => {
    const h = createHarness(); const draws = h.draws.length;
    h.document.visibilityState = 'hidden';
    const observer = h.observers.find(o => o.observed.some(t => t.node === h.document.head));
    observer.emit([{type:'characterData', target:{nodeName:'#text', parentNode:{nodeName:'TITLE'}}}]);
    h.document.visibilityState = 'visible'; h.document.fire('visibilitychange'); h.advance(300);
    assert.equal(h.draws.length, draws, 'Title churn must be filtered before hidden dirty handling');
  }],
  ['video-gated polling stops after the playing video is removed', () => {
    const h = createHarness(); h.setVideos([{paused:false, ended:false, readyState:4}]);
    h.configure({liveRateMs:100});
    h.setVideos([]); h.advance(100);
    const draws = h.draws.length;
    h.advance(1000);
    assert.equal(h.draws.length, draws, 'Detached video must not keep the document polling forever');
  }],
  ['changing video frames never accelerates the configured polling interval', () => {
    const h = createHarness();
    h.setVideos([{paused:false, ended:false, readyState:4}]);
    h.configure({liveRateMs:2000, threshold:0, edges:true});
    const draws = h.draws.length;
    for (let i = 0; i < 4; i++) {
      h.flip(); h.advance(1999);
      assert.equal(h.draws.length, draws + i, 'A scene change must not shorten the polling interval');
      h.advance(1);
      assert.equal(h.draws.length, draws + i + 1);
    }
    h.document.visibilityState = 'hidden'; h.document.fire('visibilitychange');
    h.advance(10_000);
    assert.equal(h.draws.length, draws + 4, 'Hidden playback must suspend readback');
  }],
  ['late external stylesheet load triggers a new sample', () => {
    const h = createHarness();
    const link = {
      nodeName:'LINK', localName:'link', tagName:'LINK', rel:'stylesheet', ownerDocument:h.document,
      relList:{contains(value) {return value === 'stylesheet';}},
      getAttribute(name) {return name === 'rel' ? 'stylesheet' : name === 'href' ? 'dark.css' : null;},
    };
    const observer = h.observers.find(o => o.observed.some(t => t.node === h.document.head));
    observer.emit([{type:'attributes', attributeName:'href', target:link}]);
    h.advance(1000); // The mutation sample ran while the old sheet still applied.
    const draws = h.draws.length;
    for (const node of [h.content, h.document, h.document.head]) node.fireCaptured('load', {target:link});
    h.advance(300);
    assert.ok(h.draws.length > draws, 'A theme stylesheet arriving after the mutation debounce must be resampled');
  }],
  ['old document timers cannot sample the next document', () => {
    const h = createHarness(); h.content.fire('load'); const oldDoc = h.document;
    h.navigate('https://other.example/'); h.advance(2100);
    assert.ok(h.draws.every(draw => draw.document === oldDoc), 'Old document instance must not sample through a navigated WindowProxy');
  }],
  ['pixel capture uses viewport coordinates explicitly', () => {
    const h = createHarness();
    const args = h.draws[0].args;
    assert.ok(args[5] & 4, 'Gecko drawWindow defaults document coordinates; pass DRAWWINDOW_DRAW_VIEW');
  }],
  ['a hidden YouTube ambient container falls back to page sampling', () => {
    const h = youtubeHarness(false);
    assert.equal(h.samples().at(-1).data.source, 'pixel', 'YouTube keeps #cinematics when Ambient mode is off');
  }],
  ['YouTube Ambient mode changes resample even while playback is paused', () => {
    const h = youtubeHarness();
    assert.equal(h.samples().at(-1).data.source, 'yt-ambient');
    h.setAmbient(false); h.advance(300);
    assert.equal(h.samples().at(-1).data.source, 'pixel');
    h.setAmbient(true); h.advance(300);
    assert.equal(h.samples().at(-1).data.source, 'yt-ambient');
    const count = h.draws.length;
    h.setAmbient(true); h.advance(300);
    assert.equal(h.draws.length, count, 'Unchanged visibility must not trigger extra pixel reads');
  }],
  ['YouTube watch-page state changes update inherited ambient visibility', () => {
    const h = youtubeHarness();
    h.setAmbient(false, h.watchPage); h.advance(300);
    assert.equal(h.samples().at(-1).data.source, 'pixel', 'YouTube toggles cinematics-active on ytd-watch-flexy');
  }],
];
for (const [name, fn] of cases) {
  test(name, fn);
}
