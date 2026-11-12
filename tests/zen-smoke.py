"""Run renderer and IPC checks in a disposable headless Zen profile.

Usage: python3 tests/zen-smoke.py [path/to/zen/binary]
Only Python's standard library is required. The user's profile is never opened.
"""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
binary = sys.argv[1] if len(sys.argv) > 1 else "/Applications/Zen.app/Contents/MacOS/zen"
work = Path(tempfile.mkdtemp(prefix="zpt-smoke-"))
profile = work / "profile"
profile.mkdir()
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
prefs = {
    "marionette.port": port,
    "browser.shell.checkDefaultBrowser": False,
    "browser.startup.homepage": "about:blank",
    "browser.startup.page": 0,
    "datareporting.policy.dataSubmissionEnabled": False,
    "toolkit.telemetry.enabled": False,
    "zen.welcome-screen.seen": True,
    "zen.page-tint.mix-amount": 50,
    "zen.page-tint.live-mode-smoothing-ms": 0,
    "zen.view.compact.hide-tabbar": True,
}
(profile / "user.js").write_text("\n".join(
    f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()
))
log = (work / "zen.log").open("w")
process = subprocess.Popen([
    binary, "--headless", "--no-remote", "--profile", str(profile),
    "--marionette", "--remote-allow-system-access", "about:blank",
], stdout=log, stderr=log, env={
    **os.environ,
    # Recent Gecko requires this environment opt-in; the command-line flag above
    # remains for older versions. It applies only to this disposable test process.
    "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1",
})
sock = None
sequence = 0


def receive():
    prefix = b""
    while not prefix.endswith(b":"):
        byte = sock.recv(1)
        if not byte:
            raise RuntimeError("Zen closed the Marionette connection")
        prefix += byte
    length = int(prefix[:-1])
    payload = b""
    while len(payload) < length:
        chunk = sock.recv(length - len(payload))
        if not chunk:
            raise RuntimeError("Incomplete Marionette response")
        payload += chunk
    return json.loads(payload)


def command(name, params=None):
    global sequence
    sequence += 1
    payload = json.dumps([0, sequence, name, params or {}]).encode()
    sock.sendall(str(len(payload)).encode() + b":" + payload)
    result = receive()
    if result[2]:
        raise RuntimeError(json.dumps(result[2]))
    return result[3]


def js(script, *args):
    result = command("WebDriver:ExecuteScript", {
        "script": script, "args": list(args), "sandbox": "system", "newSandbox": True,
    })
    return result.get("value")


def wait_for(script, description):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if js(script):
            print(f"PASS {description}")
            return
        time.sleep(0.05)
    raise AssertionError(description)


def in_content(script):
    handle = js("return window.ChromeUtils.importESModule('chrome://remote/content/shared/NavigableManager.sys.mjs').NavigableManager.getIdForBrowser(window.gBrowser.selectedBrowser)")
    command("Marionette:SetContext", {"value": "content"})
    try:
        command("WebDriver:SwitchToWindow", {"handle": handle})
        return js(script)
    finally:
        command("Marionette:SetContext", {"value": "chrome"})


try:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=1)
            break
        except OSError:
            # Zen can restart its launcher after an update. A clean launcher exit
            # does not mean the browser using this profile failed to start.
            if process.poll() not in (None, 0):
                raise RuntimeError((work / "zen.log").read_text())
            time.sleep(0.1)
    if sock is None:
        raise RuntimeError("Zen did not start Marionette")
    sock.settimeout(20)
    receive()
    command("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
    command("Marionette:SetContext", {"value": "chrome"})
    wait_for("return !!window.gBrowser && document.readyState === 'complete'", "browser startup")

    # Sine's package is absent in this fresh profile. Substitute only the transport
    # URL with the exact frame.js bytes; both scripts execute without source edits.
    js("""
      const win = window;
      win.__zptLoads = 0;
      const source = 'data:application/javascript,' + encodeURIComponent(arguments[0]);
      const hook = browser => {
        const mm = browser.messageManager;
        if (Object.hasOwn(mm, '__zptHooked')) return;
        mm.__zptHooked = true;
        const load = mm.loadFrameScript.bind(mm);
        mm.loadFrameScript = (uri, ...args) => {
          if (uri === 'chrome://sine/content/zen-page-tint/frame.js') {
            win.__zptLoads++;
            uri = source;
          }
          return load(uri, ...args);
        };
      };
      for (const tab of win.gBrowser.tabs) if (tab.linkedPanel) hook(tab.linkedBrowser);
      win.gBrowser.tabContainer.addEventListener('TabOpen', event => hook(event.target.linkedBrowser));
      win.gBrowser.tabContainer.addEventListener('TabSelect', () => hook(win.gBrowser.selectedBrowser));
      win.addUnloadListener = fn => { win.__zptCleanup = fn; };
      win.windowUtils.loadSheetUsingURIString('data:text/css,' + encodeURIComponent(arguments[1]), 1);
      // Gecko 155 rejects untrusted file: scripts in browser chrome. Register the
      // test directory as a trusted resource package, like Sine's chrome package.
      win.Services.io.getProtocolHandler('resource').QueryInterface(win.Ci.nsIResProtocolHandler)
        .setSubstitution('zpt-smoke', win.Services.io.newURI(arguments[2]));
      win.Services.scriptloader.loadSubScript('resource://zpt-smoke/tint.uc.js', win);
      win.__zptOpen = color => {
        const html = '<html><body style="margin:0;height:300vh;background:' + color + '"></body></html>';
        const tab = win.gBrowser.addTab('data:text/html,' + encodeURIComponent(html), {
          triggeringPrincipal: win.Services.scriptSecurityManager.getSystemPrincipal(),
        });
        win.gBrowser.selectedTab = tab;
        return tab;
      };
      win.__zptFirst = win.__zptOpen('rgb(180, 30, 20)');
    """, (REPO / "frame.js").read_text(), (REPO / "style.css").read_text(), REPO.as_uri() + "/")
    wait_for("return document.documentElement.style.getPropertyValue('--zen-tab-header-background') === 'rgb(180, 30, 20)'", "native frame sampling and config handshake")

    js("window.__zptSecond = window.__zptOpen('rgb(20, 40, 180)')")
    wait_for("return document.documentElement.style.getPropertyValue('--zen-tab-header-background') === 'rgb(20, 40, 180)'", "second tab sampling")
    before = js("return window.__zptLoads")
    js("window.gBrowser.selectedTab = window.__zptFirst")
    wait_for("return document.documentElement.style.getPropertyValue('--zen-tab-header-background') === 'rgb(180, 30, 20)'", "native tab switch restores cached color")
    assert js("return window.__zptLoads") == before, "Tab switch reloaded a cached sampler"

    in_content("document.body.style.background = 'linear-gradient(rgb(180,30,20) 0px, rgb(180,30,20) 800px, rgb(20,40,180) 800px)'; window.scrollTo(0, 1500)")
    wait_for("return document.documentElement.style.getPropertyValue('--zen-tab-header-background') === 'rgb(20, 40, 180)'", "pixel sampling follows viewport scrolling")
    in_content("document.body.style.background = 'rgb(180,30,20)'; window.scrollTo(0, 0)")
    wait_for("return document.documentElement.style.getPropertyValue('--zen-tab-header-background') === 'rgb(180, 30, 20)'", "page sampling restores after scrolling")

    js("""
      const backdrop = document.querySelector('#zen-browser-background');
      backdrop.style.setProperty('--zen-main-browser-background', 'linear-gradient(rgb(10,30,50),rgb(80,100,120))');
      backdrop.style.setProperty('--zen-background-opacity', '1');
      window.__zptPixel = (x, y) => {
        const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        c.width = c.height = 1;
        const ctx = c.getContext('2d');
        ctx.drawWindow(window, x, y, 1, 1, 'white', ctx.DRAWWINDOW_DRAW_VIEW);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      window.Services.prefs.setIntPref('zen.page-tint.mix-amount', 0);
    """)
    native = js("return [window.__zptPixel(3, 300), window.__zptPixel(3, 500)]")
    assert native[0] != native[1], f"Fixture workspace gradient is not visible: {native}"
    js("window.Services.prefs.setIntPref('zen.page-tint.mix-amount', 50)")
    tinted = js("return [window.__zptPixel(3, 300), window.__zptPixel(3, 500)]")
    for base, actual in zip(native, tinted):
        expected = [(b + p) / 2 for b, p in zip(base, [180, 30, 20])]
        assert all(abs(a - e) <= 3 for a, e in zip(actual, expected)), (base, actual, expected)
    print("PASS 50% compositing preserves the native workspace gradient")

    # Strength is the opacity of the complete tint, including ambient spread.
    # Compare rendered pixels with both endpoints rather than counting DOM layers.
    in_content("document.body.style.height = '100vh'; document.body.style.background = 'linear-gradient(rgb(140,60,20),rgb(20,50,110))'")
    js("window.Services.prefs.setIntPref('zen.page-tint.ambient-spread', 100)")
    wait_for("return document.documentElement.getAttribute('zen-page-tint-ambient') === 'on' && document.documentElement.style.getPropertyValue('--zpt-edge-t') !== document.documentElement.style.getPropertyValue('--zpt-edge-b')", "directional color fixture")
    js("""
      // Hide button artwork only while measuring the top/footer backdrops.
      // Their containers and backgrounds keep their actual production styles.
      window.windowUtils.loadSheetUsingURIString('data:text/css,' + encodeURIComponent(
        ':root[data-zpt-pixel-fixture] :is(#zen-sidebar-top-buttons, #zen-sidebar-foot-buttons) > * { visibility:hidden !important; }'), 1);
      document.documentElement.setAttribute('data-zpt-pixel-fixture', '');
      window.__zptRegionPixels = () => {
        const points = [80,300,500,window.innerHeight-50].flatMap(y => [[3,y],[window.innerWidth-3,y]]);
        const sidebar = document.querySelector('#navigator-toolbox').getBoundingClientRect();
        points.push([sidebar.left+sidebar.width/2,500]);
        for (const selector of ['#zen-sidebar-top-buttons', '#zen-sidebar-foot-buttons']) {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          if (box?.width && box.height) points.push([box.left+box.width/2,box.top+box.height/2]);
        }
        if (document.documentElement.getAttribute('zen-single-toolbar') !== 'true') {
          const nav = document.querySelector('#zen-appcontent-navbar-wrapper').getBoundingClientRect();
          points.push([nav.left+nav.width*.15,nav.top+2],[nav.left+nav.width*.85,nav.top+2]);
        }
        return points.map(([x,y]) => window.__zptPixel(Math.floor(x),Math.floor(y)));
      };
    """)
    matrix = []
    for single, right in [(True, False), (True, True), (False, False), (False, True)]:
        js("window.Services.prefs.setBoolPref('zen.view.use-single-toolbar', arguments[0])", single)
        expected = "true" if single else "false"
        wait_for(f"return (document.documentElement.getAttribute('zen-single-toolbar') === 'true') === {expected}", f"opacity fixture toolbar {'single' if single else 'multiple'}")
        js("window.Services.prefs.setBoolPref('zen.tabs.vertical.right-side', arguments[0])", right)
        expected = "true" if right else "false"
        wait_for(f"return (document.documentElement.getAttribute('zen-right-side') === 'true') === {expected}", f"sidebar position {'right' if right else 'left'}")
        # Native toolbar changes reparent controls and animate their geometry.
        # Wait for those transitions before comparing identical pixel locations.
        time.sleep(0.1)
        wait_for("return document.getAnimations().every(a => !(a instanceof window.CSSTransition) || a.playState !== 'running')", "native toolbar geometry settles")
        if not single and right:
            # Changing sides can move the navbar without resizing it. Check
            # before any tint preference change can hide stale clip coordinates.
            geometry = js("""
              const overlay = document.querySelector('#zen-browser-background > .zen-page-tint-backdrop');
              const bounds = overlay.getBoundingClientRect();
              const bar = document.querySelector('#zen-appcontent-navbar-wrapper').getBoundingClientRect();
              return {
                actual: overlay.style.getPropertyValue('--zpt-navbar-inset').trim().split(/\\s+/).map(parseFloat),
                expected: [bar.top - bounds.top, bounds.right - bar.right, bounds.bottom - bar.bottom, bar.left - bounds.left],
              };
            """)
            assert len(geometry['actual']) == 4 and all(
                abs(actual - expected) <= 1
                for actual, expected in zip(geometry['actual'], geometry['expected'])
            ), f"Ambient clip did not follow the sidebar move: {geometry}"
            print("PASS ambient navbar geometry follows sidebar relocation")
        for spread in [0, 100]:
            js("window.Services.prefs.setIntPref('zen.page-tint.ambient-spread', arguments[0])", spread)
            if spread:
                wait_for("return document.documentElement.getAttribute('zen-page-tint-ambient') === 'on'", "ambient source ready")
            pixels = {}
            for strength in [0, 100, 1, 50]:
                js("window.Services.prefs.setIntPref('zen.page-tint.mix-amount', arguments[0])", strength)
                pixels[strength] = js("return window.__zptRegionPixels()")
            for strength in [1, 50]:
                for region, (base, full, actual) in enumerate(zip(pixels[0], pixels[100], pixels[strength])):
                    expected_pixel = [b + (f - b) * strength / 100 for b, f in zip(base, full)]
                    assert all(abs(a - e) <= 3 for a, e in zip(actual, expected_pixel)), {
                        "sidebar": "right" if right else "left", "single": single, "spread": spread,
                        "strength": strength, "region": region, "native": base, "full": full,
                        "actual": actual, "expected": expected_pixel,
                    }
            matrix.append({"right": right, "single": single, "spread": spread, "pixels": pixels})
            if spread:
                js("document.documentElement.removeAttribute('data-zpt-pixel-fixture')")
                screenshot = command("WebDriver:TakeScreenshot", {"full": False})
                (work / f"ambient-{'right' if right else 'left'}-{'single' if single else 'multiple'}.png").write_bytes(base64.b64decode(screenshot["value"]))
                js("document.documentElement.setAttribute('data-zpt-pixel-fixture', '')")
    (work / "strength-matrix.json").write_text(json.dumps(matrix, indent=2))
    print("PASS strength 1/50/100 preserves opacity with spread 0/100 on either sidebar side")
    js("document.documentElement.removeAttribute('data-zpt-pixel-fixture')")
    js("window.Services.prefs.setBoolPref('zen.tabs.vertical.right-side', false)")

    js("window.Services.prefs.setIntPref('zen.page-tint.ambient-spread', 70)")
    wait_for("return document.documentElement.getAttribute('zen-page-tint-ambient') === 'on'", "idle-page sampling preference applies live")
    assert js("return getComputedStyle(document.querySelector('#zen-browser-background > .zen-page-tint-backdrop'), '::after').backgroundImage !== 'none'")

    js("window.Services.prefs.setIntPref('zen.page-tint.mix-amount', 100)")
    in_content("document.body.style.background = 'white'")
    wait_for("return document.documentElement.style.getPropertyValue('--zen-tab-header-foreground') === '#000'", "light page selects a dark foreground")
    js("document.activeElement?.blur(); document.querySelector('#urlbar').removeAttribute('breakout-extend')")
    for single in [True, False]:
        js("window.Services.prefs.setBoolPref('zen.view.use-single-toolbar', arguments[0])", single)
        expected = "true" if single else "false"
        wait_for(f"return (document.documentElement.getAttribute('zen-single-toolbar') === 'true') === {expected}", f"toolbar mode {'single' if single else 'multiple'}")
        assert js("return getComputedStyle(document.querySelector('#urlbar-input')).color === 'rgb(0, 0, 0)'"), "URL input ignores the sampled foreground"
        assert js("return [...document.querySelectorAll('#zen-browser-background, .zen-toolbar-background')].every(el => el.querySelectorAll(':scope > .zen-page-tint-backdrop').length === 1)")
    assert js("return getComputedStyle(document.querySelector('#zen-browser-background > .zen-page-tint-backdrop'), '::after').clipPath.startsWith('polygon(evenodd')"), "Docked URL bar receives two ambient layers"
    print("PASS URL contrast and separate ambient surfaces in both toolbar layouts")

    js("""
      window.Services.prefs.setIntPref('zen.page-tint.frame-gap', 13);
      window.Services.prefs.setIntPref('zen.page-tint.frame-radius', 21);
    """)
    assert js("const s = getComputedStyle(document.querySelector('#zen-appcontent-wrapper')); return s.marginTop === '13px' && s.borderRadius === '21px'")
    print("PASS frame geometry settings apply live")

    js("window.Services.prefs.setBoolPref('zen.view.use-single-toolbar', true)")
    wait_for("return document.documentElement.getAttribute('zen-single-toolbar') === 'true'", "compact fixture toolbar mode")

    js("""
      window.gZenCompactModeManager.preference = true;
      document.querySelector('#navigator-toolbox').setAttribute('zen-user-show', 'true');
    """)
    wait_for("return !document.documentElement.hasAttribute('zen-compact-animating')", "native compact layout settles")
    wait_for("return getComputedStyle(document.querySelector('.zen-toolbar-background')).display !== 'none'", "compact panel appears")
    assert js("""
      return ['#navigator-toolbox', '#titlebar'].every(sel => getComputedStyle(document.querySelector(sel)).backgroundColor === 'rgba(0, 0, 0, 0)')
        && getComputedStyle(document.querySelector('.zen-toolbar-background')).overflow === 'clip'
        && getComputedStyle(document.querySelector('.zen-toolbar-background')).borderRadius !== '0px';
    """), "Tint escapes native compact panel geometry"
    print("PASS compact panel keeps native clipping and rounded corners")

    image = command("WebDriver:TakeScreenshot", {"full": False})
    (work / "compact-tinted.png").write_bytes(base64.b64decode(image.get("value", "")))

    js("""
      window.Services.prefs.setIntPref('zen.page-tint.ambient-spread', 0);
      document.documentElement.style.setProperty('--zpt-live-smoothing-ms', '300ms');
      window.__zptTransitionStart = getComputedStyle(document.querySelector('.zen-page-tint-backdrop')).opacity;
      window.Services.prefs.setIntPref('zen.page-tint.mix-amount', 0);
    """)
    time.sleep(0.08)
    opacity = float(js("return getComputedStyle(document.querySelector('.zen-page-tint-backdrop')).opacity"))
    assert 0 < opacity < float(js("return window.__zptTransitionStart")), opacity
    print("PASS compact tint fades when returning to the native theme")

    js("document.documentElement.setAttribute('inDOMFullscreen', 'true')")
    assert js("""
      const s = getComputedStyle(document.querySelector('#zen-appcontent-wrapper'));
      return s.margin === '0px' && s.borderRadius === '0px' && s.boxShadow === 'none';
    """), "Fullscreen still has an inset frame"
    print("PASS fullscreen has no frame gap or shadow")
    js("document.documentElement.removeAttribute('inDOMFullscreen')")

    image = command("WebDriver:TakeScreenshot", {"full": False})
    (work / "compact.png").write_bytes(base64.b64decode(image.get("value", "")))
    js("window.__zptCleanup()")
    assert js("return !document.querySelector('.zen-page-tint-backdrop') && !document.documentElement.hasAttribute('zen-page-tint-active')")
    print("PASS teardown removes overlays and active state")
    print(f"Artifacts: {work}")
finally:
    if sock:
        try:
            # Quit the connected disposable browser, including a replacement
            # process created by Zen after the original launcher exited.
            command("Marionette:SetContext", {"value": "chrome"})
            js("window.Services.startup.quit(window.Ci.nsIAppStartup.eForceQuit)")
        except (OSError, RuntimeError):
            pass
        sock.close()
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    log.close()
