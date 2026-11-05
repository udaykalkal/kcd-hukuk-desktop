// Tests the injected bridge (src-tauri/src/host.js) against a mock Claude page.
// Run: NODE_PATH=$(npm root -g) node tests/bridge.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const HOST_JS = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'host.js'), 'utf8')
  .split('__KCD_VERSION__').join('2.0.0')
  .split('__KCD_PLATFORM__').join('darwin');

// Stands in for Tauri's IPC in the top frame only.
const MOCK_IPC = `
  if (window.top === window && location.hostname === 'claude.ai') {
    window.__calls = [];
    window.__TAURI_INTERNALS__ = { invoke: function (cmd, args) {
      window.__calls.push({ cmd: cmd, args: args });
      if (cmd === 'kcd_config') return Promise.resolve({ version: '2.0.0', platform: 'darwin', url: location.href });
      if (cmd === 'kcd_save_file') return Promise.resolve('/Users/test/Downloads/' + args.name);
      return Promise.resolve(null);
    } };
  }`;

const TOP_HTML = `<!doctype html><html><head><title>Claude</title></head><body style="margin:0">
  <div id="app-root">
    <header id="claude-header" style="height:56px;background:#eee">Claude header</header>
    <div id="layout" style="display:flex;transform:translateZ(0)">
      <nav id="claude-side" style="width:220px">sidebar</nav>
      <section id="viewer" style="flex:1;padding:24px">
        <div class="toolbar">Share · Copy</div>
        <iframe id="art" src="https://abc.claudeusercontent.com/app.html" style="width:900px;height:500px;border:1px solid #ccc"></iframe>
      </section>
    </div>
  </div>
</body></html>`;

const APP_HTML = `<!doctype html><html><body><h1>kcdAI</h1><script>
  window.__events = [];
  window.__ready = new Promise(function (r) { setTimeout(r, 50); });
  if (window.kcdHost) window.kcdHost.on('update', function (d) { window.__events.push(d); });
</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(MOCK_IPC);
  await context.addInitScript(HOST_JS);
  await context.route('https://claude.ai/**', (r) => r.fulfill({ contentType: 'text/html', body: TOP_HTML }));
  await context.route('https://abc.claudeusercontent.com/**', (r) => r.fulfill({ contentType: 'text/html', body: APP_HTML }));
  const page = await context.newPage();
  await page.goto('https://claude.ai/artifact/test');
  await page.waitForTimeout(400);

  // 1. Only the kcdAI frame shows, full window.
  const state = await page.evaluate(() => {
    const f = document.getElementById('art');
    const r = f.getBoundingClientRect();
    return {
      shell: document.documentElement.classList.contains('kcd-shell'),
      marked: f.classList.contains('kcd-app-frame'),
      rect: [r.left, r.top, r.width, r.height],
      header: getComputedStyle(document.getElementById('claude-header')).display,
      side: getComputedStyle(document.getElementById('claude-side')).display,
      toolbar: getComputedStyle(document.querySelector('.toolbar')).display,
    };
  });
  assert.ok(state.shell, 'shell class set');
  assert.ok(state.marked, 'frame marked');
  assert.deepStrictEqual(state.rect, [0, 0, 1280, 800], 'frame fills the window');
  assert.strictEqual(state.header, 'none', 'Claude header hidden');
  assert.strictEqual(state.side, 'none', 'Claude sidebar hidden');
  assert.strictEqual(state.toolbar, 'none', 'viewer toolbar hidden');

  // 2. kcdHost in the kcdAI frame, with the old contract and the new calls.
  const frame = page.frames().find((f) => f.url().startsWith('https://abc.claudeusercontent.com'));
  assert.ok(frame, 'app frame found');
  const host = await frame.evaluate(() => ({
    ok: !!window.kcdHost && window.kcdHost.isWrapper === true,
    version: window.kcdHost && window.kcdHost.version,
    platform: window.kcdHost && window.kcdHost.platform,
  }));
  assert.deepStrictEqual(host, { ok: true, version: '2.0.0', platform: 'darwin' });

  const saved = await frame.evaluate(() => window.kcdHost.saveFile('dilekce.udf', 'UEsDBA=='));
  assert.strictEqual(saved, '/Users/test/Downloads/dilekce.udf');
  await frame.evaluate(() => window.kcdHost.notify('kcdAI', 'Süre yarın doluyor'));
  const calls = await page.evaluate(() => window.__calls.map((c) => c.cmd));
  assert.ok(calls.includes('kcd_save_file') && calls.includes('kcd_notify'), 'native calls forwarded: ' + calls.join(','));

  // 3. reveal(true) shows Claude's page; reveal(false) hides it again.
  await frame.evaluate(() => window.kcdHost.reveal(true));
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('claude-header')).display), 'block');
  await frame.evaluate(() => window.kcdHost.reveal(false));
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('claude-header')).display), 'none');

  // 4. A Claude permission dialog is lifted above kcdAI.
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'portal';
    d.style.cssText = 'position:fixed;inset:0;z-index:50';
    d.innerHTML = '<div role="dialog">Allow Soorgla?</div>';
    document.body.appendChild(d);
  });
  await page.waitForTimeout(200);
  const lifted = await page.evaluate(() => {
    const p = document.getElementById('portal');
    return { cls: p.classList.contains('kcd-lift'), z: getComputedStyle(p).zIndex, top: document.elementFromPoint(640, 400) === p || p.contains(document.elementFromPoint(640, 400)) };
  });
  assert.ok(lifted.cls && lifted.z === '2147483600' && lifted.top, 'dialog lifted: ' + JSON.stringify(lifted));

  // 5. Events from the native app reach the kcdAI frame.
  await page.evaluate(() => window.__kcdShellEmit('update', { status: 'ready', version: '2.0.1' }));
  await page.waitForTimeout(100);
  const events = await frame.evaluate(() => window.__events);
  assert.deepStrictEqual(events, [{ status: 'ready', version: '2.0.1' }]);

  // 6. Unknown frames cannot call the host.
  await page.evaluate(() => {
    const evil = document.createElement('iframe');
    evil.setAttribute('sandbox', 'allow-scripts'); // opaque origin, like a third-party frame
    evil.srcdoc = '<script>window.top.postMessage({ns:"kcd-shell",type:"rpc",id:1,method:"notify",args:{title:"x"}},"*")<\/script>';
    document.body.appendChild(evil);
  });
  await page.waitForTimeout(200);
  const notifies = await page.evaluate(() => window.__calls.filter((c) => c.cmd === 'kcd_notify').length);
  assert.strictEqual(notifies, 1, 'foreign frame ignored');

  // 7. Claude's newer layout: artifact on claudemcpcontent.com, ancestors that would trap a
  //    fixed child (container-type, will-change), a header at body level, a dialog portal,
  //    and a Cloudflare check frame that must stay untouched.
  const TOP2 = `<!doctype html><html><head><title>Claude</title></head><body style="margin:0">
    <header id="h2" style="position:sticky;top:0;height:48px;background:#eee;z-index:50">kcdAI · Chat · Share</header>
    <main id="m2" style="container-type:inline-size;will-change:transform;height:calc(100vh - 48px)">
      <div class="wrap" style="backdrop-filter:blur(2px);height:100%"><iframe id="art2" src="https://xyz.claudemcpcontent.com/app.html" style="width:100%;height:100%;border:0"></iframe></div>
    </main>
    <div id="portal2"></div>
    <iframe id="cf" src="https://challenges.cloudflare.com/x.html" style="width:300px;height:65px"></iframe>
  </body></html>`;
  await context.route('https://claude.ai/**', (r) => r.fulfill({ contentType: 'text/html', body: TOP2 }));
  await context.route('https://xyz.claudemcpcontent.com/**', (r) => r.fulfill({ contentType: 'text/html', body: APP_HTML }));
  await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>cf</p>' }));
  const page2 = await context.newPage();
  await page2.goto('https://claude.ai/artifact/new');
  await page2.waitForTimeout(500);
  const s2 = await page2.evaluate(() => {
    const f = document.getElementById('art2'); const r = f.getBoundingClientRect();
    return { rect: [r.left, r.top, r.width, r.height], header: getComputedStyle(document.getElementById('h2')).display, topEl: document.elementFromPoint(640, 10) === f };
  });
  assert.deepStrictEqual(s2.rect, [0, 0, 1280, 800], 'new layout: frame fills the window ' + JSON.stringify(s2));
  assert.strictEqual(s2.header, 'none', 'new layout: body-level header hidden');
  assert.ok(s2.topEl, 'new layout: the kcdAI frame is on top');
  const f2 = page2.frames().find((f) => f.url().startsWith('https://xyz.claudemcpcontent.com'));
  assert.ok(await f2.evaluate(() => !!window.kcdHost && window.kcdHost.isWrapper === true), 'kcdHost on claudemcpcontent.com');
  const cf = page2.frames().find((f) => f.url().startsWith('https://challenges.cloudflare.com'));
  assert.ok(await cf.evaluate(() => typeof window.kcdHost === 'undefined'), 'Cloudflare frame untouched');
  await page2.evaluate(() => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.textContent = 'Allow?'; document.getElementById('portal2').appendChild(d); });
  await page2.waitForTimeout(150);
  const d2 = await page2.evaluate(() => { const p = document.getElementById('portal2'); return { shown: getComputedStyle(p).display !== 'none', lifted: p.classList.contains('kcd-lift') }; });
  assert.ok(d2.shown && d2.lifted, 'new layout: Claude dialog stays visible ' + JSON.stringify(d2));
  await page2.evaluate(() => window.__kcdShellReport());
  const reports = await page2.evaluate(() => window.__calls.filter((c) => c.cmd === 'kcd_save_file').map((c) => c.args.name));
  assert.deepStrictEqual(reports, ['kcdAI-tanilama.txt'], 'diagnostic report saved');

  // 8. Claude draws its artifact page (bar included) inside its own claude.ai frame.
  const TOP3 = `<!doctype html><html><head><title>Claude</title></head><body style="margin:0">
    <iframe id="shell" src="https://claude.ai/inner/page" style="width:100%;height:100vh;border:0;display:block"></iframe></body></html>`;
  const INNER = `<!doctype html><html><head></head><body style="margin:0">
    <header id="bar" style="height:52px;background:#ddd">kcdAI · Chat · Share</header>
    <div style="container-type:inline-size;height:calc(100vh - 52px)"><iframe id="art3" src="https://nest.claudemcpcontent.com/app.html" style="width:100%;height:100%;border:0"></iframe></div>
  </body></html>`;
  await context.route('https://claude.ai/artifact/nested', (r) => r.fulfill({ contentType: 'text/html', body: TOP3 }));
  await context.route('https://claude.ai/inner/**', (r) => r.fulfill({ contentType: 'text/html', body: INNER }));
  await context.route('https://nest.claudemcpcontent.com/**', (r) => r.fulfill({ contentType: 'text/html', body: APP_HTML }));
  const page3 = await context.newPage();
  await page3.goto('https://claude.ai/artifact/nested');
  await page3.waitForTimeout(600);
  const inner = page3.frames().find((f) => f.url().startsWith('https://claude.ai/inner'));
  const s3 = await inner.evaluate(() => { const f = document.getElementById('art3'); const r = f.getBoundingClientRect(); return { bar: getComputedStyle(document.getElementById('bar')).display, rect: [r.left, r.top, r.width, r.height], shell: document.documentElement.classList.contains('kcd-shell') }; });
  assert.ok(s3.shell && s3.bar === 'none', 'nested: Claude bar inside the inner frame hidden ' + JSON.stringify(s3));
  assert.deepStrictEqual(s3.rect, [0, 0, 1280, 800], 'nested: kcdAI frame fills the window');
  const app3 = page3.frames().find((f) => f.url().startsWith('https://nest.claudemcpcontent.com'));
  await app3.evaluate(() => window.kcdHost.reveal(true));
  await page3.waitForTimeout(200);
  assert.ok(await inner.evaluate(() => document.documentElement.classList.contains('kcd-revealed')), 'nested: reveal reaches the inner frame');
  await app3.evaluate(() => window.kcdHost.reveal(false));
  const rep3 = await app3.evaluate(() => window.kcdHost.report());
  assert.ok(/İÇ ÇERÇEVE/.test(rep3) && /claudemcpcontent/.test(rep3), 'nested: report reads the inner frame');

  // 9. Claude's real layout (from a 2.0.4 report) with its Content-Security-Policy: injected
  //    <style> elements are blocked, and the page's own CSS uses !important.
  const CSS4 = `body{margin:0;overflow:hidden} #top-edge{height:4px} #hdr{display:flex!important;height:45px;background:#eee}
    main{position:absolute!important;top:45px;left:0;right:0;bottom:0;display:flex} #frame-slot{position:relative;flex:1}
    #frame-content{position:absolute!important;inset:0;width:100%;height:100%;border:0}`;
  const TOP4 = `<!doctype html><html><head><link rel="stylesheet" href="/s.css"></head><body>
    <div id="top-edge"></div><header id="hdr">kcdAI · Chat · Share</header><div id="hdr-degraded"></div>
    <main><div id="frame-slot"><iframe id="frame-content" src="https://bb6.frame.claudeusercontent.com/_f/1/"></iframe></div></main>
    <div class="cds-root"></div></body></html>`;
  const csp = { 'content-security-policy': "default-src 'self' https:; style-src 'self'; script-src 'self'" };
  await context.route('https://claude.ai/artifact/csp', (r) => r.fulfill({ contentType: 'text/html', headers: csp, body: TOP4 }));
  await context.route('https://claude.ai/s.css', (r) => r.fulfill({ contentType: 'text/css', body: CSS4 }));
  await context.route('https://bb6.frame.claudeusercontent.com/**', (r) => r.fulfill({ contentType: 'text/html', body: APP_HTML }));
  const page4 = await context.newPage();
  await page4.goto('https://claude.ai/artifact/csp');
  await page4.waitForTimeout(600);
  const s4 = await page4.evaluate(() => { const f = document.getElementById('frame-content'); const r = f.getBoundingClientRect(); return { hdr: getComputedStyle(document.getElementById('hdr')).display, rect: [r.left, r.top, r.width, r.height], top: document.elementFromPoint(640, 10) === f, styleBlocked: !document.getElementById('kcd-shell-base') || !document.getElementById('kcd-shell-base').sheet || document.getElementById('kcd-shell-base').sheet.cssRules.length === 0 }; });
  assert.ok(s4.styleBlocked, 'CSP: injected <style> is blocked in this test, like on Claude');
  assert.strictEqual(s4.hdr, 'none', 'CSP: Claude bar hidden despite CSP and !important ' + JSON.stringify(s4));
  assert.deepStrictEqual(s4.rect, [0, 0, 1280, 800], 'CSP: kcdAI frame fills the window');
  assert.ok(s4.top, 'CSP: kcdAI frame on top');
  const app4 = page4.frames().find((f) => f.url().startsWith('https://bb6.frame.claudeusercontent.com'));
  await app4.evaluate(() => window.kcdHost.reveal(true)); await page4.waitForTimeout(150);
  assert.strictEqual(await page4.evaluate(() => getComputedStyle(document.getElementById('hdr')).display), 'flex', 'CSP: reveal shows Claude again');
  await app4.evaluate(() => window.kcdHost.reveal(false)); await page4.waitForTimeout(150);
  assert.strictEqual(await page4.evaluate(() => getComputedStyle(document.getElementById('hdr')).display), 'none', 'CSP: hidden again after reveal');

  await browser.close();
  console.log('bridge tests passed (9 groups)');
})().catch((e) => { console.error(e); process.exit(1); });

