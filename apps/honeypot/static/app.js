/* Meridian client bundle */
(function () {
  "use strict";
  var ENDPOINT = "/api/v1/rum";
  var SDK = "1.1.0";
  var T0 = performance.now();
  // The server mints a page-load id per HTML response (rendering ladder). Without one we send
  // pl: null rather than inventing an id: the server only trusts ids it served to this visitor.
  var SERVER_PL = (function () { try { var m = document.querySelector('meta[name="request-id"]'); var c = m && m.getAttribute("content"); return c && /^[A-Za-z0-9_-]{16,40}$/.test(c) ? c : null; } catch (e) { return null; } })();
  var PL = SERVER_PL;
  // "JavaScript ran" rung: as early as possible, as an image so it survives blocked fetch/beacon APIs.
  if (SERVER_PL) { try { new Image(1, 1).src = "/assets/img/sp/" + SERVER_PL + ".gif"; } catch (e) {} }
  var MAX_SENDS = 15;
  var sends = 0;

  function now() { return Math.round(performance.now() - T0); }
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback === undefined ? null : fallback; } }
  function hash(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  function short(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
  function send(kind, data, useBeacon) {
    if (sends >= MAX_SENDS) return;
    sends++;
    var body;
    try { body = JSON.stringify({ v: 1, sdk: SDK, kind: kind, pl: PL, path: location.pathname + location.search, t: now(), data: data }); } catch (e) { return; }
    try {
      if (useBeacon && navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, body)) return;
      fetch(ENDPOINT, { method: "POST", body: body, keepalive: true, credentials: "same-origin", headers: { "Content-Type": "text/plain" } }).catch(function () {});
    } catch (e) {}
  }
  function withTimeout(p, ms) {
    return Promise.race([Promise.resolve(p).catch(function () { return null; }), new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]);
  }

  var KNOWN_ARTIFACTS = {
    "claude-agent-stop-container": "claude-in-chrome",
    "claude-agent-animation-styles": "claude-in-chrome",
    "pplx-agent-overlay-stop-button": "perplexity-comet"
  };
  var AGENT_WORDS = /claude|anthropic|pplx|perplexity|comet|openai|chatgpt|atlas|gemini|mariner|copilot|browser-?use|stagehand|browserbase|operator|manus|genspark|nova-act|agent/i;
  var artifacts = [];
  var foreign = [];
  var foreignCount = 0;
  function describe(el) {
    var attrs = [];
    if (el.attributes) for (var i = 0; i < el.attributes.length && i < 12; i++) attrs.push(el.attributes[i].name);
    return { tag: short(el.tagName, 40), id: short(el.id, 80), cls: short(typeof el.className === "string" ? el.className : "", 120), attrs: attrs, shadow: !!el.shadowRoot, text: (el.textContent || "").length };
  }
  function checkArtifact(el, how) {
    if (!el || el.nodeType !== 1 || el.id === "hp-probe") return;
    var id = el.id || "";
    var known = KNOWN_ARTIFACTS[id];
    var cls = typeof el.className === "string" ? el.className : "";
    if (known || AGENT_WORDS.test(id) || AGENT_WORDS.test(cls) || AGENT_WORDS.test(el.tagName)) {
      if (artifacts.length < 30) { var d = describe(el); d.t = now(); d.how = how; d.known = known || null; artifacts.push(d); }
      if (known) { behaviorDirty = true; flush(false); }
    }
  }
  function initialScan() {
    for (var id in KNOWN_ARTIFACTS) { var el = document.getElementById(id); if (el) checkArtifact(el, "initial"); }
    var all = document.querySelectorAll("[id],[class]");
    for (var i = 0; i < all.length && i < 2000; i++) checkArtifact(all[i], "initial");
  }
  function rootAttrs(el) {
    var out = {};
    if (!el || !el.attributes) return out;
    for (var i = 0; i < el.attributes.length && i < 20; i++) out[el.attributes[i].name] = short(el.attributes[i].value, 80);
    return out;
  }
  safe(function () {
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === "attributes") {
          if (foreign.length < 60) foreign.push({ t: now(), attr: r.attributeName, on: r.target.tagName });
          foreignCount++;
          continue;
        }
        for (var j = 0; j < r.addedNodes.length; j++) {
          var n = r.addedNodes[j];
          if (n.nodeType !== 1 || n.id === "hp-probe") continue;
          foreignCount++;
          if (foreign.length < 60) { var d = describe(n); d.t = now(); d.parent = r.target.tagName; foreign.push(d); }
          checkArtifact(n, "added");
          if (n.querySelectorAll) { var kids = n.querySelectorAll("[id],[class]"); for (var k = 0; k < kids.length && k < 200; k++) checkArtifact(kids[k], "added"); }
        }
      }
      behaviorDirty = true;
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  });

  var behaviorDirty = false;
  var b = {
    firstInteraction: null, mouseMoves: 0, mouseDistance: 0, maxSpeed: 0, moveUntrusted: 0,
    clicks: [], clickCount: 0, pointerDowns: 0, mouseDowns: 0,
    keyDowns: 0, keyUntrusted: 0, keyIntervals: [], keyKinds: { printable: 0, nav: 0, modifier: 0, enter: 0, other: 0 },
    inputs: {}, inputWithoutKey: 0, inputFieldTypes: {}, pastes: 0, copies: 0,
    scrolls: 0, scrollUntrusted: 0, maxScrollY: 0, wheels: 0, touches: 0,
    focus: 0, blur: 0, visibility: [], resizes: 0, selections: 0, contextMenus: 0
  };
  var lastMove = null, lastMoveAt = 0, movesWindow = [], lastKeyAt = 0, lastPointerDown = null, lastMouseDown = null;
  function touch() { if (b.firstInteraction === null) b.firstInteraction = now(); behaviorDirty = true; }
  function on(target, type, fn) { safe(function () { target.addEventListener(type, function (e) { safe(function () { fn(e); }); }, { capture: true, passive: true }); }); }

  on(document, "mousemove", function (e) {
    b.mouseMoves++; if (!e.isTrusted) b.moveUntrusted++;
    var t = performance.now();
    if (lastMove) {
      var d = Math.sqrt(Math.pow(e.clientX - lastMove.x, 2) + Math.pow(e.clientY - lastMove.y, 2));
      b.mouseDistance += d;
      var dt = t - lastMoveAt; if (dt > 0) b.maxSpeed = Math.max(b.maxSpeed, Math.round(d / dt * 1000));
    }
    lastMove = { x: e.clientX, y: e.clientY }; lastMoveAt = t;
    movesWindow.push(t); if (movesWindow.length > 50) movesWindow.shift();
    touch();
  });
  on(document, "pointerdown", function (e) { b.pointerDowns++; lastPointerDown = { t: performance.now(), type: e.pointerType }; touch(); });
  on(document, "mousedown", function () { b.mouseDowns++; lastMouseDown = performance.now(); });
  on(document, "click", function (e) {
    b.clickCount++; touch();
    if (b.clicks.length >= 25) return;
    var t = performance.now();
    var el = e.target && e.target.nodeType === 1 ? e.target : null;
    var rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    var recent = 0; for (var i = 0; i < movesWindow.length; i++) if (t - movesWindow[i] < 1000) recent++;
    b.clicks.push({
      t: now(), trusted: e.isTrusted, x: Math.round(e.clientX), y: Math.round(e.clientY), detail: e.detail,
      pointer: lastPointerDown && t - lastPointerDown.t < 1000 ? lastPointerDown.type : null,
      hadMouseDown: lastMouseDown !== null && t - lastMouseDown < 1000,
      movesLast1s: recent, msSinceMove: lastMove ? Math.round(t - lastMoveAt) : null,
      target: el ? short(el.tagName, 20) + (el.id ? "#" + short(el.id, 40) : "") : null,
      dx: rect && rect.width ? Math.round((e.clientX - rect.left - rect.width / 2) / rect.width * 1000) / 1000 : null,
      dy: rect && rect.height ? Math.round((e.clientY - rect.top - rect.height / 2) / rect.height * 1000) / 1000 : null,
      zeroCoords: e.clientX === 0 && e.clientY === 0
    });
  });
  on(document, "keydown", function (e) {
    b.keyDowns++; if (!e.isTrusted) b.keyUntrusted++;
    var t = performance.now();
    if (lastKeyAt && b.keyIntervals.length < 80) b.keyIntervals.push(Math.round(t - lastKeyAt));
    lastKeyAt = t;
    var k = e.key || "";
    if (k === "Enter") b.keyKinds.enter++;
    else if (k.length === 1) b.keyKinds.printable++;
    else if (/^(Arrow|Tab|Home|End|Page|Backspace|Delete)/.test(k)) b.keyKinds.nav++;
    else if (/^(Shift|Control|Alt|Meta|CapsLock)$/.test(k)) b.keyKinds.modifier++;
    else b.keyKinds.other++;
    touch();
  });
  on(document, "input", function (e) {
    var type = e.inputType || "none";
    b.inputs[type] = (b.inputs[type] || 0) + 1;
    if (/^insert/.test(type) && type !== "insertFromPaste" && performance.now() - lastKeyAt > 150) b.inputWithoutKey++;
    var tgt = e.target;
    if (tgt && tgt.type) b.inputFieldTypes[tgt.type] = (b.inputFieldTypes[tgt.type] || 0) + 1;
    touch();
  });
  on(document, "paste", function () { b.pastes++; touch(); });
  on(document, "copy", function () { b.copies++; });
  on(window, "scroll", function (e) { b.scrolls++; if (!e.isTrusted) b.scrollUntrusted++; b.maxScrollY = Math.max(b.maxScrollY, Math.round(window.scrollY)); touch(); });
  on(window, "wheel", function () { b.wheels++; touch(); });
  on(document, "touchstart", function () { b.touches++; touch(); });
  on(window, "focus", function () { b.focus++; behaviorDirty = true; });
  on(window, "blur", function () { b.blur++; behaviorDirty = true; });
  on(window, "resize", function () { b.resizes++; behaviorDirty = true; });
  on(document, "selectionchange", function () { b.selections++; });
  on(document, "contextmenu", function () { b.contextMenus++; });
  on(document, "visibilitychange", function () {
    if (b.visibility.length < 20) b.visibility.push([now(), document.visibilityState]);
    behaviorDirty = true;
    if (document.visibilityState === "hidden") flush(true);
  });
  on(window, "pagehide", function () { flush(true); });

  function behaviorSnapshot() {
    return {
      behavior: b,
      artifacts: artifacts,
      foreign: { count: foreignCount, items: foreign },
      focus: safe(function () { return document.hasFocus(); }),
      visibility: document.visibilityState,
      scrollHeight: safe(function () { return document.documentElement.scrollHeight; })
    };
  }
  function flush(useBeacon) {
    if (!behaviorDirty) return;
    behaviorDirty = false;
    send("behavior", behaviorSnapshot(), useBeacon);
  }
  setInterval(function () { flush(false); }, 15000);

  function navInfo() {
    var n = navigator;
    var plugins = [];
    safe(function () { for (var i = 0; i < n.plugins.length && i < 10; i++) plugins.push(n.plugins[i].name); });
    return {
      ua: n.userAgent, appVersion: n.appVersion, platform: n.platform, vendor: n.vendor, product: n.product, productSub: n.productSub,
      oscpu: n.oscpu || null, buildID: n.buildID || null, languages: safe(function () { return Array.prototype.slice.call(n.languages || []); }),
      language: n.language, hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory || null,
      maxTouchPoints: n.maxTouchPoints, cookieEnabled: n.cookieEnabled, doNotTrack: n.doNotTrack, gpc: n.globalPrivacyControl === undefined ? null : n.globalPrivacyControl,
      pdfViewerEnabled: n.pdfViewerEnabled === undefined ? null : n.pdfViewerEnabled, onLine: n.onLine,
      webdriver: n.webdriver === undefined ? null : n.webdriver, plugins: plugins, mimeTypes: safe(function () { return n.mimeTypes.length; }),
      connection: safe(function () { var c = n.connection; return c ? { type: c.effectiveType, rtt: c.rtt, downlink: c.downlink, saveData: c.saveData } : null; })
    };
  }
  function screenInfo() {
    var s = window.screen;
    return {
      w: s.width, h: s.height, aw: s.availWidth, ah: s.availHeight, colorDepth: s.colorDepth, pixelDepth: s.pixelDepth,
      dpr: window.devicePixelRatio, orientation: safe(function () { return s.orientation.type; }),
      innerW: window.innerWidth, innerH: window.innerHeight, outerW: window.outerWidth, outerH: window.outerHeight,
      screenX: window.screenX, screenY: window.screenY
    };
  }
  function intlInfo() {
    var o = safe(function () { return Intl.DateTimeFormat().resolvedOptions(); }, {});
    return { tz: o.timeZone, locale: o.locale, calendar: o.calendar, numbering: o.numberingSystem, tzOffset: new Date().getTimezoneOffset() };
  }
  function mediaQueries() {
    var q = { pointerFine: "(pointer: fine)", pointerCoarse: "(pointer: coarse)", hover: "(hover: hover)", dark: "(prefers-color-scheme: dark)",
      reducedMotion: "(prefers-reduced-motion: reduce)", forcedColors: "(forced-colors: active)", standalone: "(display-mode: standalone)" };
    var out = {};
    for (var k in q) out[k] = safe(function () { return window.matchMedia(q[k]).matches; });
    return out;
  }
  function webgl() {
    return safe(function () {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return { supported: false };
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        supported: true, webgl2: !!document.createElement("canvas").getContext("webgl2"),
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), extensions: (gl.getSupportedExtensions() || []).length
      };
    });
  }
  function canvasHash() {
    return safe(function () {
      var c = document.createElement("canvas"); c.width = 240; c.height = 60;
      var x = c.getContext("2d");
      x.textBaseline = "top"; x.font = "16px 'Arial'"; x.fillStyle = "#f60"; x.fillRect(100, 1, 62, 20);
      x.fillStyle = "#069"; x.fillText("Meridian ✓ 😃 Cwm fjordbank", 2, 15);
      x.fillStyle = "rgba(102, 204, 0, 0.7)"; x.fillText("Meridian ✓ 😃 Cwm fjordbank", 4, 17);
      x.globalCompositeOperation = "multiply"; x.fillStyle = "rgb(255,0,255)"; x.beginPath(); x.arc(50, 50, 50, 0, Math.PI * 2); x.fill();
      return hash(c.toDataURL());
    });
  }
  function audioHash() {
    return new Promise(function (resolve) {
      try {
        var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) return resolve(null);
        var ctx = new Ctx(1, 5000, 44100);
        var osc = ctx.createOscillator(); osc.type = "triangle"; osc.frequency.value = 10000;
        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12; comp.attack.value = 0; comp.release.value = 0.25;
        osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
        ctx.oncomplete = function (ev) { var d = ev.renderedBuffer.getChannelData(0); var s = 0; for (var i = 4500; i < 5000; i++) s += Math.abs(d[i]); resolve(s.toString()); };
        ctx.startRendering();
      } catch (e) { resolve(null); }
    });
  }
  function fonts() {
    return safe(function () {
      var list = ["Arial", "Helvetica Neue", "Times New Roman", "Courier New", "Verdana", "Georgia", "Segoe UI", "Roboto", "Ubuntu", "Cantarell",
        "DejaVu Sans", "Liberation Sans", "Noto Sans", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "SF Pro Text", "Menlo", "Monaco",
        "Consolas", "Calibri", "Cambria", "Tahoma", "Trebuchet MS", "Lucida Grande", "Gill Sans", "Futura", "Helvetica", "Droid Sans", "Arimo"];
      var c = document.createElement("canvas").getContext("2d");
      var text = "mmmmmmmmmmlli1WWW";
      var base = {};
      ["monospace", "serif", "sans-serif"].forEach(function (f) { c.font = "72px " + f; base[f] = c.measureText(text).width; });
      return list.filter(function (font) {
        return ["monospace", "serif", "sans-serif"].some(function (f) { c.font = "72px '" + font + "'," + f; return c.measureText(text).width !== base[f]; });
      });
    }, []);
  }
  function automation() {
    var w = window;
    var names = ["__playwright__binding__", "__pwInitScripts", "__playwright_evaluate", "_playwrightRecorder", "__puppeteer_evaluation_script__",
      "callPhantom", "_phantom", "__nightmare", "domAutomation", "domAutomationController", "_Selenium_IDE_Recorder", "_selenium", "calledSelenium",
      "__webdriver_evaluate", "__selenium_evaluate", "__webdriver_script_function", "__webdriver_script_func", "__webdriver_script_fn",
      "__fxdriver_evaluate", "__driver_unwrapped", "__webdriver_unwrapped", "__driver_evaluate", "__selenium_unwrapped", "__fxdriver_unwrapped",
      "__lastWatirAlert", "__lastWatirConfirm", "__lastWatirPrompt", "__stagehand", "__browserUse", "Buffer", "emit", "spawn"];
    var present = names.filter(function (n) { return safe(function () { return n in w; }, false); });
    var scan = safe(function () {
      return Object.getOwnPropertyNames(w).filter(function (k) { return /cdc_|\$cdc|selenium|webdriver|playwright|puppeteer|__pw|stagehand|browser_?use|browserbase/i.test(k); }).slice(0, 20);
    }, []);
    var docScan = safe(function () { return Object.keys(document).filter(function (k) { return /\$cdc_|\$wdc_|cdc_/.test(k); }); }, []);
    var wdDesc = safe(function () { return Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver"); });
    var cdp = false;
    safe(function () {
      var e = new Error("");
      Object.defineProperty(e, "stack", { configurable: false, enumerable: false, get: function () { cdp = true; return ""; } });
      console.debug(e);
    });
    return {
      globals: present, globalScan: scan, documentScan: docScan,
      webdriverGetterNative: wdDesc && wdDesc.get ? /\[native code\]/.test(Function.prototype.toString.call(wdDesc.get)) : null,
      webdriverOwnProp: safe(function () { return Object.prototype.hasOwnProperty.call(navigator, "webdriver"); }),
      fnToStringNative: safe(function () { return /\[native code\]/.test(Function.prototype.toString.toString()); }),
      cdpRuntime: cdp,
      chrome: safe(function () { var c = w.chrome; return c ? { runtime: !!c.runtime, app: !!c.app, csi: typeof c.csi, loadTimes: typeof c.loadTimes, keys: Object.keys(c).slice(0, 15) } : null; }),
      notificationPermission: safe(function () { return Notification.permission; }),
      historyLength: history.length,
      outerZero: window.outerWidth === 0 && window.outerHeight === 0
    };
  }
  function globalsDiff() {
    return safe(function () {
      var f = document.createElement("iframe");
      f.id = "hp-probe"; f.style.display = "none"; f.setAttribute("aria-hidden", "true");
      document.body.appendChild(f);
      var clean = {};
      Object.getOwnPropertyNames(f.contentWindow).forEach(function (k) { clean[k] = true; });
      document.body.removeChild(f);
      return Object.getOwnPropertyNames(window).filter(function (k) { return !clean[k]; }).slice(0, 80);
    }, []);
  }
  function navTiming() {
    return safe(function () {
      var e = performance.getEntriesByType("navigation")[0];
      if (!e) return null;
      return { protocol: e.nextHopProtocol, type: e.type, transferSize: e.transferSize, redirects: e.redirectCount,
        ttfb: Math.round(e.responseStart), domInteractive: Math.round(e.domInteractive), dcl: Math.round(e.domContentLoadedEventEnd) };
    });
  }

  function collect() {
    var asyncParts = {
      uaData: safe(function () {
        var d = navigator.userAgentData;
        if (!d) return null;
        var low = { brands: d.brands, mobile: d.mobile, platform: d.platform };
        return d.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "fullVersionList", "wow64", "formFactors", "uaFullVersion"])
          .then(function (hi) { hi.low = low; return hi; }, function () { return low; });
      }),
      audio: audioHash(),
      storage: safe(function () { return navigator.storage.estimate().then(function (e) { return { quota: e.quota }; }); }),
      battery: safe(function () { return navigator.getBattery().then(function (x) { return { charging: x.charging, level: x.level, chargingTime: x.chargingTime }; }); }),
      devices: safe(function () { return navigator.mediaDevices.enumerateDevices().then(function (ds) { var c = {}; ds.forEach(function (d) { c[d.kind] = (c[d.kind] || 0) + 1; }); return c; }); }),
      permNotifications: safe(function () { return navigator.permissions.query({ name: "notifications" }).then(function (p) { return p.state; }); }),
      permGeolocation: safe(function () { return navigator.permissions.query({ name: "geolocation" }).then(function (p) { return p.state; }); })
    };
    var keys = Object.keys(asyncParts);
    Promise.all(keys.map(function (k) { return withTimeout(asyncParts[k], 2500); })).then(function (vals) {
      var fp = {
        nav: navInfo(), screen: screenInfo(), intl: intlInfo(), media: mediaQueries(), webgl: webgl(),
        canvas: canvasHash(), fonts: fonts(), automation: automation(), globalsDiff: globalsDiff(), timing: navTiming(),
        voices: safe(function () { return speechSynthesis.getVoices().length; }),
        doc: { referrer: short(document.referrer, 300), hasFocus: safe(function () { return document.hasFocus(); }), visibility: document.visibilityState,
          htmlAttrs: rootAttrs(document.documentElement), bodyAttrs: rootAttrs(document.body) }
      };
      keys.forEach(function (k, i) { fp[k] = vals[i]; });
      initialScan();
      fp.artifacts = artifacts;
      send("fp", fp, false);
    });
  }

  function start() { setTimeout(collect, 1200); }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
