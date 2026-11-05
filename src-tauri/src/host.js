/*
 * kcdAI shell bridge. Injected by the Mac and Windows apps into every frame.
 *
 * Top frame (claude.ai): shows only the kcdAI frame, lifts Claude's own dialogs
 * above it, and forwards requests from the kcdAI frame to the native app.
 * Claude's own sub-frames (claude.ai, claudeusercontent.com): define window.kcdHost,
 * which talks to the top frame with postMessage. Other frames are left untouched. The kcdAI build uses window.kcdHost; nothing here holds client data.
 *
 * The version and platform placeholders below are filled in by the native app.
 */
(function () {
  'use strict';
  var VERSION = '__KCD_VERSION__';
  var PLATFORM = '__KCD_PLATFORM__';
  var MSG = 'kcd-shell';
  var isTop;
  try { isTop = window.top === window; } catch (e) { isTop = false; }

  if (isTop) {
    var host = String(location.hostname || '');
    if (!/(^|\.)claude\.(ai|com)$/i.test(host)) return; // splash page, login providers: nothing to do
    if (window.__kcdShellTop) return;
    window.__kcdShellTop = true;
    /* Stay on the KCD Hukuk app: any other claude.ai page (chat, home, projects, the page
       Claude opens after sign-in, the artifact page's close button) sends the window back.
       Sign-in, verification and Claude's own API/checks are left alone. Claude switches pages
       without reloading, so the address is checked continuously. */
    var APP_URL = '__KCD_APP_URL__';
    var ALLOWED = /^\/(artifact\/|login|logout|magic-link|verify|auth|oauth|sso|api\/|cdn-cgi\/|onboarding|invite|accept-invite|legal|download)/i;
    var leaving = false;
    function guard() {
      if (leaving) return;
      var p = String(location.pathname || '/');
      if (ALLOWED.test(p)) return;
      leaving = true;
      try { location.replace(APP_URL); } catch (e) { location.href = APP_URL; }
    }
    guard();
    if (!leaving) {
      ['pushState', 'replaceState'].forEach(function (k) {
        var orig = history[k];
        if (typeof orig === 'function') history[k] = function () { var r = orig.apply(this, arguments); setTimeout(guard, 0); return r; };
      });
      window.addEventListener('popstate', function () { setTimeout(guard, 0); });
      setInterval(guard, 1000);
      topFrame();
    }
  } else if (/(^|\.)(claude\.ai|claude\.com|claudeusercontent\.com|claudemcpcontent\.com)$/i.test(String(location.hostname || ''))) {
    subFrame(); // only Claude's own frames, where the kcdAI build runs; third-party frames
                // (Cloudflare's browser check, payments, help widgets) are left untouched
    /* Claude may draw its artifact page (bar included) inside its own claude.ai frame:
       hide Claude's bar there too, keeping only the kcdAI frame */
    if (/(^|\.)claude\.(ai|com)$/i.test(String(location.hostname || '')) && !window.__kcdShellInner) { window.__kcdShellInner = true; innerFrame(); }
  }

  /* ------------------------------------------------------------------ inline enforcement */
  /* Claude's page has a Content-Security-Policy that blocks injected <style> elements, so the
     classes alone change nothing there. Each marked element also gets its rules as inline
     !important styles through the CSSOM, which CSP allows and which outrank the page's own CSS.
     Original inline values are kept and put back on reveal or when an element is no longer marked. */
  var STY = new Map();
  var PATH_CSS = { position: 'static', transform: 'none', filter: 'none', contain: 'none', margin: '0', padding: '0', border: '0', 'max-width': 'none', 'max-height': 'none', 'will-change': 'auto', 'backdrop-filter': 'none', '-webkit-backdrop-filter': 'none', perspective: 'none', 'container-type': 'normal', 'content-visibility': 'visible', 'clip-path': 'none', mask: 'none', '-webkit-mask': 'none' };
  var FRAME_CSS = { position: 'fixed', left: '0', top: '0', right: '0', bottom: '0', width: '100vw', height: '100vh', 'max-width': 'none', 'max-height': 'none', margin: '0', border: '0', 'border-radius': '0', 'box-shadow': 'none', transform: 'none', visibility: 'visible', opacity: '1', 'z-index': '2147483000' };
  function imp(el, props) {
    var rec = STY.get(el); if (!rec) { rec = {}; STY.set(el, rec); }
    for (var k in props) {
      if (!(k in rec)) rec[k] = [el.style.getPropertyValue(k), el.style.getPropertyPriority(k)];
      if (el.style.getPropertyValue(k) !== props[k] || el.style.getPropertyPriority(k) !== 'important') el.style.setProperty(k, props[k], 'important');
    }
  }
  function unimp(el) {
    var rec = STY.get(el); if (!rec) return;
    for (var k in rec) { if (rec[k][0]) el.style.setProperty(k, rec[k][0], rec[k][1]); else el.style.removeProperty(k); }
    STY.delete(el);
  }
  function enforce(frame, revealed) {
    var keep = new Set();
    if (frame && !revealed) {
      [document.documentElement, document.body].forEach(function (el) { if (el) { imp(el, { overflow: 'hidden' }); keep.add(el); } });
      imp(frame, FRAME_CSS); keep.add(frame);
      var i, list = document.querySelectorAll('.kcd-path');
      for (i = 0; i < list.length; i++) { imp(list[i], PATH_CSS); keep.add(list[i]); }
      list = document.querySelectorAll('.kcd-hide');
      for (i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.classList.contains('kcd-lift')) { var r = STY.get(el); if (r && 'display' in r) unimp(el); continue; }
        imp(el, { display: 'none' }); keep.add(el);
      }
      list = document.querySelectorAll('.kcd-lift');
      for (i = 0; i < list.length; i++) { var l = list[i]; imp(l, l.classList.contains('kcd-lift-pos') ? { 'z-index': '2147483600', position: 'relative' } : { 'z-index': '2147483600' }); keep.add(l); }
    }
    STY.forEach(function (_, el) { if (!keep.has(el)) unimp(el); });
  }

  /* ------------------------------------------------------------------ top frame */
  function topFrame() {
    function R() { return document.documentElement; }
    var cfg = {
      css: '',
      dialogSelector: '[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
      frameHint: 'claudeusercontent|claudemcpcontent'
    };
    var current = null;      // the kcdAI iframe
    var revealed = false;    // Claude's full page shown on request
    var children = [];       // frames that said hello (for events)

    function ipc(cmd, args) {
      var t = window.__TAURI_INTERNALS__;
      if (!t || typeof t.invoke !== 'function') return Promise.reject(new Error('Masaüstü köprüsü hazır değil.'));
      return t.invoke(cmd, args || {});
    }

    var BASE_CSS = [
      'html.kcd-shell:not(.kcd-revealed), html.kcd-shell:not(.kcd-revealed) body { overflow: hidden !important; }',
      'html.kcd-shell:not(.kcd-revealed) .kcd-hide:not(.kcd-lift) { display: none !important; }',
      'html.kcd-shell:not(.kcd-revealed) .kcd-path { position: static !important; transform: none !important; filter: none !important; ' +
        'contain: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; max-width: none !important; max-height: none !important; ' +
        /* anything that would make a fixed child fixed to this box instead of the window */
        'will-change: auto !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; perspective: none !important; ' +
        'container-type: normal !important; content-visibility: visible !important; clip-path: none !important; mask: none !important; -webkit-mask: none !important; }',
      'html.kcd-shell:not(.kcd-revealed) iframe.kcd-app-frame { position: fixed !important; left: 0 !important; top: 0 !important; right: 0 !important; bottom: 0 !important; ' +
        'width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; margin: 0 !important; border: 0 !important; ' +
        'border-radius: 0 !important; box-shadow: none !important; transform: none !important; visibility: visible !important; opacity: 1 !important; ' +
        'z-index: 2147483000 !important; background: transparent; }',
      'html.kcd-shell:not(.kcd-revealed) .kcd-lift { z-index: 2147483600 !important; }',
      'html.kcd-shell:not(.kcd-revealed) .kcd-lift-pos { position: relative !important; }'
    ].join('\n');

    var baseStyle = null, extraStyle = null;
    function ensureStyles() {
      var head = document.head || R();
      if (!head) return;
      if (!baseStyle || !baseStyle.isConnected) {
        baseStyle = document.createElement('style');
        baseStyle.id = 'kcd-shell-base';
        baseStyle.textContent = BASE_CSS;
        head.appendChild(baseStyle);
      }
      if (!extraStyle || !extraStyle.isConnected) {
        extraStyle = document.createElement('style');
        extraStyle.id = 'kcd-shell-extra';
        head.appendChild(extraStyle);
      }
      if (extraStyle.textContent !== (cfg.css || '')) extraStyle.textContent = cfg.css || '';
    }

    function findFrame() {
      var frames = document.querySelectorAll('iframe');
      var best = null, bestScore = 0;
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var src = f.getAttribute('src') || '';
        var r = f.getBoundingClientRect();
        var score = r.width * r.height;
        if (f === current) score = Infinity;
        else if (cfg.frameHint && String(cfg.frameHint).split('|').some(function (h) { return h && src.indexOf(h) !== -1; })) score += 1e12;
        if (score > bestScore && (f === current || (r.width >= 240 && r.height >= 160))) { best = f; bestScore = score; }
      }
      return best;
    }

    function clearMarks() {
      var marked = document.querySelectorAll('.kcd-hide, .kcd-path, .kcd-app-frame');
      for (var i = 0; i < marked.length; i++) marked[i].classList.remove('kcd-hide', 'kcd-path', 'kcd-app-frame');
    }

    function markPath(frame) {
      frame.classList.add('kcd-app-frame');
      var node = frame;
      while (node && node.parentElement) {
        var parent = node.parentElement;
        if (parent === R()) break;
        var sibs = parent.children;
        for (var i = 0; i < sibs.length; i++) {
          var s = sibs[i];
          if (s !== node && s.tagName !== 'SCRIPT' && s.tagName !== 'STYLE' && s.tagName !== 'LINK') s.classList.add('kcd-hide');
        }
        if (parent === document.body) break; // body itself stays as it is; its other children are hidden above
        parent.classList.add('kcd-path');
        node = parent;
      }
    }

    function liftDialogs() {
      var body = document.body;
      if (!body) return;
      var kids = body.children;
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (current && k.contains(current)) continue;
        var isDialog = false;
        try { isDialog = !!cfg.dialogSelector && (k.matches(cfg.dialogSelector) || !!k.querySelector(cfg.dialogSelector)); } catch (e) { isDialog = false; }
        if (isDialog) {
          k.classList.add('kcd-lift');
          if (getComputedStyle(k).position === 'static') k.classList.add('kcd-lift-pos');
        } else {
          k.classList.remove('kcd-lift', 'kcd-lift-pos');
        }
      }
    }

    function apply() {
      ensureStyles();
      var f = findFrame();
      if (!f) { R().classList.remove('kcd-shell'); enforce(null, revealed); return; }
      if (f !== current) { clearMarks(); current = f; }
      markPath(f);
      R().classList.add('kcd-shell');
      R().classList.toggle('kcd-revealed', revealed);
      liftDialogs();
      enforce(current, revealed);
    }

    var queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      (window.requestAnimationFrame || setTimeout)(function () { queued = false; try { apply(); } catch (e) { } }, 16);
    }
    function start() {
      apply();
      try {
        new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { }
      setInterval(schedule, 1500);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    /* diagnostic report (Mac menu: Tanılama raporu): what the page looks like, saved to Downloads */
    window.__kcdShellReportText = function () {
      function desc(el) { return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 6).join('.') : ''); }
      function box(el) { var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); }
      var cs = function (el) { var c = getComputedStyle(el); return ['position', 'display', 'transform', 'filter', 'contain', 'container-type', 'will-change', 'backdrop-filter', 'z-index', 'overflow'].map(function (k) { return k + '=' + c.getPropertyValue(k); }).join(' '); };
      var out = ['KCD Hukuk tanılama raporu', 'sürüm ' + VERSION + ' · ' + PLATFORM + ' · ' + new Date().toISOString(), 'adres ' + location.origin + location.pathname,
        'html sınıfları: ' + R().className, 'pencere ' + innerWidth + 'x' + innerHeight, 'satır içi kurallar: ' + STY.size + ' öğe', '', 'IFRAME LİSTESİ'];
      var fr = document.querySelectorAll('iframe');
      for (var i = 0; i < fr.length; i++) { var src = fr[i].getAttribute('src') || ''; out.push((fr[i] === current ? '* ' : '  ') + src.replace(/[?#].*$/, '').slice(0, 120) + ' [' + box(fr[i]) + '] ' + desc(fr[i]).slice(0, 160)); }
      out.push('', 'SEÇİLEN ÇERÇEVENİN ATALARI');
      for (var n = current; n && n !== document; n = n.parentElement) out.push(desc(n).slice(0, 160) + ' [' + box(n) + '] ' + cs(n));
      out.push('', 'BODY ÇOCUKLARI');
      var kids = document.body ? document.body.children : [];
      for (var k = 0; k < kids.length; k++) out.push(desc(kids[k]).slice(0, 160) + ' [' + box(kids[k]) + '] display=' + getComputedStyle(kids[k]).display);
      out.push('', 'EKRANIN ÜSTÜNDEKİ ÖĞELER');
      [[innerWidth / 2, 10], [innerWidth - 60, 30], [40, 30]].forEach(function (pt) { var e = document.elementFromPoint(pt[0], pt[1]); out.push(pt.join(',') + ' → ' + (e ? desc(e).slice(0, 160) : '-')); });
      /* Claude's own frames on the same address can be read directly */
      for (var j = 0; j < fr.length; j++) {
        var d2 = null; try { d2 = fr[j].contentDocument; } catch (e) { d2 = null; }
        if (!d2 || !d2.documentElement) continue;
        out.push('', 'İÇ ÇERÇEVE ' + j + ': ' + (fr[j].getAttribute('src') || '').replace(/[?#].*$/, '').slice(0, 120) + ' · sınıflar: ' + d2.documentElement.className);
        var fr2 = d2.querySelectorAll('iframe');
        for (var q = 0; q < fr2.length; q++) out.push('  iframe ' + (fr2[q].getAttribute('src') || '').replace(/[?#].*$/, '').slice(0, 120) + ' [' + box(fr2[q]) + ']');
        var b2 = d2.body ? d2.body.children : [];
        for (var z = 0; z < b2.length && z < 20; z++) out.push('  body > ' + desc(b2[z]).slice(0, 140) + ' [' + box(b2[z]) + ']');
        var w2 = fr[j].contentWindow;
        [[w2.innerWidth / 2, 10], [w2.innerWidth - 60, 30]].forEach(function (pt) { var e = d2.elementFromPoint(pt[0], pt[1]); out.push('  üstte ' + pt.map(Math.round).join(',') + ' → ' + (e ? desc(e).slice(0, 140) : '-')); });
      }
      return out.join('\n');
    };
    window.__kcdShellReport = function () {
      var b64 = btoa(unescape(encodeURIComponent(window.__kcdShellReportText())));
      return ipc('kcd_save_file', { name: 'KCD-Hukuk-tanilama.txt', data: b64 }).then(function (path) { return ipc('kcd_show_file', { path: path }); });
    };

    /* the kcdAI frame and its descendants may talk to the host */
    function fromApp(w) {
      var target = current && current.contentWindow;
      for (var i = 0; w && i < 12; i++) {
        if (w === target) return true;
        var p;
        try { p = w.parent; } catch (e) { return false; }
        if (!p || p === w) return false;
        w = p;
      }
      return false;
    }
    function trustedOrigin(origin) {
      return /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claude\.com|claudeusercontent\.com|claudemcpcontent\.com|anthropic\.com)$/i.test(String(origin || ''));
    }
    function post(win, msg) { try { win.postMessage(msg, '*'); } catch (e) { } }
    function broadcast(msg) { var fr = document.querySelectorAll('iframe'); for (var i = 0; i < fr.length; i++) post(fr[i].contentWindow, msg); }

    var methods = {
      info: function () { return ipc('kcd_config'); },
      setConfig: function (a) {
        a = a || {};
        var changed = {};
        ['css', 'dialogSelector', 'frameHint', 'url'].forEach(function (k) {
          if (typeof a[k] === 'string' && a[k].trim()) { changed[k] = a[k]; if (k !== 'url') cfg[k] = a[k]; }
        });
        broadcast({ ns: MSG, type: 'cfg', cfg: { css: cfg.css, dialogSelector: cfg.dialogSelector, frameHint: cfg.frameHint } });
        schedule();
        return Object.keys(changed).length ? ipc('kcd_set_config', { cfg: changed }) : Promise.resolve(null);
      },
      reveal: function (a) {
        revealed = !!(a && a.on);
        if (R()) R().classList.toggle('kcd-revealed', revealed);
        enforce(current, revealed);
        broadcast({ ns: MSG, type: 'reveal', on: revealed });
        return Promise.resolve(revealed);
      },
      report: function () { return Promise.resolve(window.__kcdShellReportText()); },
      notify: function (a) { return ipc('kcd_notify', { title: String(a && a.title || 'KCD Hukuk'), body: String(a && a.body || '') }); },
      openExternal: function (a) { return ipc('kcd_open_external', { url: String(a && a.url || '') }); },
      saveFile: function (a) { return ipc('kcd_save_file', { name: String(a && a.name || 'KCD-Hukuk-dosya'), data: String(a && a.data || '') }); },
      showFile: function (a) { return ipc('kcd_show_file', { path: String(a && a.path || '') }); },
      checkUpdate: function () { return ipc('kcd_check_update'); },
      restart: function () { return ipc('kcd_restart'); },
      badge: function (a) { return ipc('kcd_badge', { count: Math.max(0, (a && a.count) | 0) }); },
      logout: function () { return ipc('kcd_logout'); }
    };

    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (!d || typeof d !== 'object' || d.ns !== MSG) return;
      if (!fromApp(ev.source) && !trustedOrigin(ev.origin)) return;
      var src = ev.source;
      if (d.type === 'hello') {
        if (children.indexOf(src) === -1) children.push(src);
        post(src, { ns: MSG, type: 'hello', version: VERSION, platform: PLATFORM, shell: 2 });
        return;
      }
      if (d.type !== 'rpc') return;
      var fn = Object.prototype.hasOwnProperty.call(methods, d.method) ? methods[d.method] : null;
      var p = fn ? Promise.resolve().then(function () { return fn(d.args || {}); }) : Promise.reject(new Error('Bilinmeyen işlem: ' + d.method));
      p.then(function (value) {
        post(src, { ns: MSG, type: 'rpc-result', id: d.id, ok: true, value: value === undefined ? null : value });
      }, function (err) {
        post(src, { ns: MSG, type: 'rpc-result', id: d.id, ok: false, error: String(err && err.message || err) });
      });
    });

    /* events from the native app (updates, downloads) */
    window.__kcdShellEmit = function (name, data) {
      var msg = { ns: MSG, type: 'event', name: String(name), data: data === undefined ? null : data };
      var sent = [];
      children = children.filter(function (w) { return w && !w.closed; });
      children.forEach(function (w) { post(w, msg); sent.push(w); });
      if (current && current.contentWindow && sent.indexOf(current.contentWindow) === -1) post(current.contentWindow, msg);
    };

    ipc('kcd_config').then(function (c) {
      if (!c) return;
      if (c.css) cfg.css = c.css;
      if (c.dialogSelector) cfg.dialogSelector = c.dialogSelector;
      if (c.frameHint) cfg.frameHint = c.frameHint;
      schedule();
    }, function () { });
  }

  /* ------------------------------------------------------------------ Claude's inner frames */
  /* Inside a claude.ai frame that holds the kcdAI frame: same rules as the top page, so
     Claude's bar drawn in this frame is hidden too. Reveal and settings follow the top page. */
  function innerFrame() {
    function R() { return document.documentElement; }
    var cfg = { css: '', dialogSelector: '[role="dialog"],[role="alertdialog"],[aria-modal="true"]', frameHint: 'claudeusercontent|claudemcpcontent' };
    var current = null, revealed = false;
    var CSS = [
      'html.kcd-shell:not(.kcd-revealed), html.kcd-shell:not(.kcd-revealed) body { overflow: hidden !important; }',
      'html.kcd-shell:not(.kcd-revealed) .kcd-hide:not(.kcd-lift) { display: none !important; }',
      'html.kcd-shell:not(.kcd-revealed) .kcd-path { position: static !important; transform: none !important; filter: none !important; contain: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; max-width: none !important; max-height: none !important; will-change: auto !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; perspective: none !important; container-type: normal !important; content-visibility: visible !important; clip-path: none !important; mask: none !important; -webkit-mask: none !important; }',
      'html.kcd-shell:not(.kcd-revealed) iframe.kcd-app-frame { position: fixed !important; left: 0 !important; top: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; transform: none !important; visibility: visible !important; opacity: 1 !important; z-index: 2147483000 !important; }',
      'html.kcd-shell:not(.kcd-revealed) .kcd-lift { z-index: 2147483600 !important; }',
      'html.kcd-shell:not(.kcd-revealed) .kcd-lift-pos { position: relative !important; }'
    ].join('\n');
    var style = null, extra = null;
    function styles() {
      var head = document.head || R(); if (!head) return;
      if (!style || !style.isConnected) { style = document.createElement('style'); style.textContent = CSS; head.appendChild(style); }
      if (!extra || !extra.isConnected) { extra = document.createElement('style'); head.appendChild(extra); }
      if (extra.textContent !== (cfg.css || '')) extra.textContent = cfg.css || '';
    }
    function hinted(f) { var src = f.getAttribute('src') || ''; return String(cfg.frameHint).split('|').some(function (h) { return h && src.indexOf(h) !== -1; }); }
    function find() {
      var fr = document.querySelectorAll('iframe'), best = null, area = 0;
      for (var i = 0; i < fr.length; i++) {
        if (fr[i] === current) return current;
        if (!hinted(fr[i])) continue; // only a kcdAI-type frame, never Claude's other frames
        var r = fr[i].getBoundingClientRect(); if (r.width * r.height > area) { best = fr[i]; area = r.width * r.height; }
      }
      return best;
    }
    function apply() {
      styles();
      var f = find();
      if (!f) { R().classList.remove('kcd-shell'); enforce(null, revealed); return; }
      if (f !== current) { var m = document.querySelectorAll('.kcd-hide, .kcd-path, .kcd-app-frame'); for (var i = 0; i < m.length; i++) m[i].classList.remove('kcd-hide', 'kcd-path', 'kcd-app-frame'); current = f; }
      f.classList.add('kcd-app-frame');
      for (var node = f; node && node.parentElement && node.parentElement !== R(); node = node.parentElement) {
        var parent = node.parentElement, sibs = parent.children;
        for (var j = 0; j < sibs.length; j++) if (sibs[j] !== node && !/^(SCRIPT|STYLE|LINK)$/.test(sibs[j].tagName)) sibs[j].classList.add('kcd-hide');
        if (parent === document.body) break;
        parent.classList.add('kcd-path');
      }
      var kids = document.body ? document.body.children : [];
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].contains(f)) continue;
        var dlg = false; try { dlg = kids[k].matches(cfg.dialogSelector) || !!kids[k].querySelector(cfg.dialogSelector); } catch (e) { }
        kids[k].classList.toggle('kcd-lift', dlg); if (dlg && getComputedStyle(kids[k]).position === 'static') kids[k].classList.add('kcd-lift-pos');
      }
      R().classList.add('kcd-shell'); R().classList.toggle('kcd-revealed', revealed);
      enforce(current, revealed);
    }
    var queued = false;
    function schedule() { if (queued) return; queued = true; (window.requestAnimationFrame || setTimeout)(function () { queued = false; try { apply(); } catch (e) { } }, 16); }
    window.addEventListener('message', function (ev) {
      if (ev.source !== window.parent) return;
      var d = ev.data; if (!d || typeof d !== 'object' || d.ns !== MSG) return;
      if (d.type === 'reveal') { revealed = !!d.on; schedule(); }
      else if (d.type === 'cfg' && d.cfg) { ['css', 'dialogSelector', 'frameHint'].forEach(function (k) { if (typeof d.cfg[k] === 'string' && d.cfg[k]) cfg[k] = d.cfg[k]; }); schedule(); }
    });
    function start() { apply(); try { new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { } setInterval(schedule, 1500); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }

  /* ------------------------------------------------------------------ other frames */
  function subFrame() {
    if (window.kcdHost) return;
    var seq = 0, pending = {}, listeners = {};
    function top() { try { return window.top; } catch (e) { return null; } }
    function call(method, args) {
      return new Promise(function (resolve, reject) {
        var t = top();
        if (!t) { reject(new Error('Masaüstü köprüsü yok.')); return; }
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        try { t.postMessage({ ns: MSG, type: 'rpc', id: id, method: method, args: args || {} }, '*'); }
        catch (e) { delete pending[id]; reject(e); return; }
        setTimeout(function () {
          if (pending[id]) { delete pending[id]; reject(new Error('Masaüstü uygulaması yanıt vermedi.')); }
        }, method === 'checkUpdate' ? 180000 : 60000);
      });
    }
    window.addEventListener('message', function (ev) {
      if (ev.source !== top()) return;
      var d = ev.data;
      if (!d || typeof d !== 'object' || d.ns !== MSG) return;
      if (d.type === 'rpc-result' && pending[d.id]) {
        var p = pending[d.id];
        delete pending[d.id];
        if (d.ok) p.resolve(d.value); else p.reject(new Error(d.error || 'Hata'));
      } else if (d.type === 'event') {
        (listeners[d.name] || []).slice().forEach(function (fn) { try { fn(d.data); } catch (e) { } });
      }
    });
    var api = {
      isWrapper: true,
      shell: 2,
      version: VERSION,
      platform: PLATFORM,
      setConfig: function (c) { return call('setConfig', c || {}); },
      reveal: function (on) { return call('reveal', { on: !!on }); },
      info: function () { return call('info'); },
      notify: function (title, body) { return call('notify', { title: title, body: body }); },
      openExternal: function (url) { return call('openExternal', { url: url }); },
      logout: function () { return call('logout'); },
      saveFile: function (name, base64) { return call('saveFile', { name: name, data: base64 }); },
      showFile: function (path) { return call('showFile', { path: path }); },
      checkUpdate: function () { return call('checkUpdate'); },
      restart: function () { return call('restart'); },
      badge: function (count) { return call('badge', { count: count }); },
      report: function () { return call('report'); },
      on: function (name, fn) {
        if (typeof fn !== 'function') return function () { };
        (listeners[name] = listeners[name] || []).push(fn);
        return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); };
      }
    };
    try {
      Object.defineProperty(window, 'kcdHost', { value: Object.freeze(api), configurable: false, enumerable: false, writable: false });
    } catch (e) { window.kcdHost = api; }
    try { var t0 = top(); if (t0) t0.postMessage({ ns: MSG, type: 'hello' }, '*'); } catch (e) { }
  }
})();

