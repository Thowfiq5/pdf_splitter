(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  var state = { name: "", bytes: null, pdf: null, libDoc: null, pages: [], cards: [], manual: new Map(), scanned: false, cols: 1, rows: 1, thumbChain: Promise.resolve(), observer: null, busy: false, dl: null };

  if (typeof pdfjsLib === "undefined" || typeof PDFLib === "undefined" || typeof JSZip === "undefined") {
    var e = $("#loaderr"); e.hidden = false;
    e.textContent = "The PDF libraries did not load. Reload the page and try again.";
  } else {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  /* Normal browser download (works on any website). */
  state.dl = {
    save: function (o) {
      return new Promise(function (resolve) {
        var url = URL.createObjectURL(o.data), a = document.createElement("a");
        a.href = url; a.download = o.filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        resolve({ status: "saved" });
      });
    }
  };

  /* ---------- ID detection ---------- */
  var VAL = "((?=[A-Za-z0-9\\-\\/_.]*\\d)[A-Za-z0-9][A-Za-z0-9\\-\\/_.]{1,30})";
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function clean(s) { return String(s).replace(/[.\-_\/]+$/, ""); }
  function findId(text, label, custom) {
    if (custom.trim()) {
      try { var m0 = new RegExp(custom, "i").exec(text); if (m0) return clean(m0[1] !== undefined ? m0[1] : m0[0]); } catch (err) { /* bad pattern */ }
      return "";
    }
    var tries = [], l = label.trim();
    if (l) tries.push(new RegExp(esc(l).replace(/\s+/g, "\\s*") + "\\s*[:#\\-.]?\\s*" + VAL, "i"));
    tries.push(new RegExp("(?:employee|emp|staff)\\s*\\.?\\s*(?:id|no|number|code)\\b\\.?\\s*[:#\\-.]?\\s*" + VAL, "i"));
    for (var i = 0; i < tries.length; i++) { var m = tries[i].exec(text); if (m) return clean(m[1]); }
    return "";
  }
  function linesText(items) {
    var s = items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    var lines = [];
    s.forEach(function (it) {
      var L = lines[lines.length - 1];
      if (L && Math.abs(L.y - it.y) < 3) L.items.push(it); else lines.push({ y: it.y, items: [it] });
    });
    return lines.map(function (L) {
      return L.items.sort(function (a, b) { return a.x - b.x; }).map(function (i) { return i.str.trim(); }).join(" ");
    }).join("\n");
  }

  /* ---------- Loading ---------- */
  function setProgress(f) {
    var p = $("#progress"); p.hidden = f === null;
    if (f !== null) p.firstElementChild.style.width = Math.round(f * 100) + "%";
  }
  function say(t) { $("#msg").textContent = t || ""; }

  async function loadFile(file) {
    if (!file) return;
    if (state.busy) return;
    state.busy = true;
    $("#loaderr").hidden = true;
    try {
      state.name = file.name.replace(/\.pdf$/i, "");
      $("#fileinfo").textContent = file.name + " · " + (file.size / 1048576).toFixed(1) + " MB";
      state.bytes = new Uint8Array(await file.arrayBuffer());
      state.libDoc = null; state.manual = new Map(); state.pages = [];
      state.pdf = await pdfjsLib.getDocument({ data: state.bytes.slice() }).promise;
      var n = state.pdf.numPages, textCount = 0;
      for (var i = 1; i <= n; i++) {
        var page = await state.pdf.getPage(i);
        var vp = page.getViewport({ scale: 1 });
        var tc = await page.getTextContent();
        var items = [];
        tc.items.forEach(function (it) {
          if (!it.str || !it.str.trim()) return;
          var pt = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
          items.push({ str: it.str, x: pt[0], y: pt[1] });
        });
        textCount += items.length;
        state.pages.push({ page: page, vp: vp, items: items });
        setProgress(i / n);
        if (i % 4 === 0) await tick();
      }
      state.scanned = textCount < n;
      $("#scannednote").hidden = !state.scanned;
      $("#settings").hidden = false; $("#review").hidden = false; $("#bar").hidden = false;
      $("#example").hidden = true;
      buildCards();
    } catch (err) {
      var box = $("#loaderr"); box.hidden = false;
      box.textContent = "This file could not be read. Check that it is a PDF without a password. (" + (err && err.message ? err.message : err) + ")";
    } finally {
      setProgress(null); state.busy = false;
    }
  }

  /* ---------- Cards ---------- */
  function num(id, lo, hi) {
    var v = parseInt($(id).value, 10); if (isNaN(v)) v = 1;
    return Math.max(lo, Math.min(hi, v));
  }
  function buildCards() {
    if (!state.pages.length) return;
    var cols = num("#cols", 1, 6), rows = num("#rows", 1, 8);
    state.cols = cols; state.rows = rows;
    var label = $("#label").value, custom = $("#custom").value, merge = $("#merge").checked && !state.scanned;
    $("#gridnote").hidden = cols * rows === 1;
    var cards = [];
    state.pages.forEach(function (p, pi) {
      var W = p.vp.width, H = p.vp.height;
      for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
        var rect = { x0: c * W / cols, x1: (c + 1) * W / cols, y0: r * H / rows, y1: (r + 1) * H / rows };
        var inside = p.items.filter(function (it) { return it.x >= rect.x0 - 0.5 && it.x < rect.x1 && it.y >= rect.y0 && it.y < rect.y1; });
        var found = findId(linesText(inside), label, custom);
        var part = { pi: pi, cell: r * cols + c, rect: rect, full: cols * rows === 1 };
        if (!found && merge && cards.length && inside.length) {
          cards[cards.length - 1].parts.push(part);
        } else {
          var key = pi + ":" + part.cell, man = state.manual.has(key);
          cards.push({ key: key, id: man ? state.manual.get(key) : found, auto: !!found, edited: man, parts: [part], skip: false });
        }
      }
    });
    state.cards = cards;
    renderTiles();
  }

  function whereText(card) {
    var p = card.parts[0], t = "Page " + (p.pi + 1);
    if (state.cols * state.rows > 1) t += ", card " + (p.cell + 1);
    if (card.parts.length > 1) t += " + " + (card.parts.length - 1) + " more";
    return t;
  }
  function renderTiles() {
    var grid = $("#grid");
    if (state.observer) state.observer.disconnect();
    state.thumbChain = Promise.resolve();
    grid.innerHTML = "";
    state.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        state.observer.unobserve(en.target);
        var idx = +en.target.closest(".tile").dataset.i;
        var cv = en.target, card = state.cards[idx], gen = state.cards;
        state.thumbChain = state.thumbChain.then(function () {
          if (gen !== state.cards) return;
          return renderThumb(cv, card).catch(function () {});
        });
      });
    }, { rootMargin: "300px" });
    var frag = document.createDocumentFragment();
    state.cards.forEach(function (card, i) {
      var el = document.createElement("article");
      el.className = "tile"; el.dataset.i = i;
      el.innerHTML = '<div class="thumb"><canvas width="10" height="10"></canvas></div>' +
        '<div class="meta"><span class="where"></span><span class="pill"></span></div>' +
        '<label><span class="sr">Employee ID</span><input class="idin" type="text" spellcheck="false" autocomplete="off" placeholder="Type the ID"></label>' +
        '<div class="acts"><button class="lnk save" type="button">Save PDF</button><button class="lnk skip" type="button">Skip</button></div>';
      el.querySelector(".where").textContent = whereText(card);
      el.querySelector(".idin").value = card.id;
      frag.appendChild(el);
      state.observer.observe(el.querySelector("canvas"));
    });
    grid.appendChild(frag);
    refreshStatuses();
  }
  async function renderThumb(canvas, card) {
    var part = card.parts[0], p = state.pages[part.pi];
    var w = part.rect.x1 - part.rect.x0, h = part.rect.y1 - part.rect.y0;
    var s = Math.min(2.5, 360 / w);
    canvas.width = Math.max(1, Math.round(w * s)); canvas.height = Math.max(1, Math.round(h * s));
    var vp = p.page.getViewport({ scale: s });
    await p.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: [1, 0, 0, 1, -part.rect.x0 * s, -part.rect.y0 * s], background: "#ffffff" }).promise;
  }

  function safeName(s) {
    return String(s).trim().replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, "-").slice(0, 100);
  }
  function computeNames() {
    var used = new Map();
    return state.cards.map(function (c) {
      if (c.skip) return null;
      var base = safeName(c.id);
      if (!base) { var p = c.parts[0]; base = "no-id-page-" + (p.pi + 1) + (state.cols * state.rows > 1 ? "-card-" + (p.cell + 1) : ""); }
      var k = base.toLowerCase(), n = used.get(k) || 0;
      used.set(k, n + 1);
      return n ? base + "_" + (n + 1) : base;
    });
  }
  function refreshStatuses() {
    var counts = new Map();
    state.cards.forEach(function (c) { if (!c.skip && c.id.trim()) { var k = c.id.trim().toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); } });
    var missing = 0, dup = 0, ok = 0, active = 0;
    var tiles = $("#grid").children;
    state.cards.forEach(function (c, i) {
      var el = tiles[i]; if (!el) return;
      var pill = el.querySelector(".pill"), cls, txt, attn = false;
      var id = c.id.trim();
      if (c.skip) { cls = "skip"; txt = "Skipped"; }
      else {
        active++;
        if (!id) { cls = "bad"; txt = "No ID"; attn = true; missing++; }
        else if (counts.get(id.toLowerCase()) > 1) { cls = "bad"; txt = "Duplicate"; attn = true; dup++; }
        else if (c.edited) { cls = "edit"; txt = "Typed"; ok++; }
        else { cls = "ok"; txt = "Found"; ok++; }
      }
      pill.className = "pill " + cls; pill.textContent = txt;
      el.classList.toggle("attn", attn);
      el.classList.toggle("skipped", c.skip);
      el.querySelector(".skip").textContent = c.skip ? "Restore" : "Skip";
    });
    $("#stats").innerHTML = "<span><b>" + active + "</b> cards from <b>" + state.pages.length + "</b> pages</span>" +
      "<span><b>" + ok + "</b> with an ID</span>" +
      (missing ? '<span class="bad"><b>' + missing + "</b> with no ID</span>" : "") +
      (dup ? '<span class="bad"><b>' + dup + "</b> duplicate IDs</span>" : "");
    refreshBar(missing, dup);
  }
  function refreshBar(missing, dup) {
    var zip = $("#zipbtn");
    if (!state.dl) { zip.disabled = true; say("Saving files is not available in this browser."); return; }
    zip.disabled = state.busy || !state.cards.length;
    if (state.busy) return;
    var m = [];
    if (missing) m.push(missing + " card" + (missing > 1 ? "s have" : " has") + " no ID and will be named no-id-page-N");
    if (dup) m.push("duplicate IDs get _2, _3 added");
    say(m.length ? m.join(". ") + "." : "Ready. Every card has its own ID.");
  }

  /* ---------- Export ---------- */
  async function getLib() {
    if (!state.libDoc) state.libDoc = await PDFLib.PDFDocument.load(state.bytes, { ignoreEncryption: true });
    return state.libDoc;
  }
  async function buildCardPdf(card) {
    var src = await getLib();
    var out = await PDFLib.PDFDocument.create();
    for (var i = 0; i < card.parts.length; i++) {
      var part = card.parts[i], p = state.pages[part.pi];
      var cp = (await out.copyPages(src, [part.pi]))[0];
      if (!part.full) {
        var a = p.vp.convertToPdfPoint(part.rect.x0, part.rect.y0), b = p.vp.convertToPdfPoint(part.rect.x1, part.rect.y1);
        var x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
        cp.setMediaBox(x, y, w, h); cp.setCropBox(x, y, w, h);
      }
      out.addPage(cp);
    }
    return out.save();
  }
  function saveError(err) {
    var code = err && err.code;
    if (code === "declined") say("Save cancelled.");
    else if (code === "rate_limited") say("Another save prompt is open. Answer it, then try again.");
    else say("The file could not be saved (" + (code || "unknown error") + ").");
  }
  async function saveOne(i) {
    if (!state.dl || state.busy) return;
    var names = computeNames(), name = names[i]; if (!name) return;
    state.busy = true; say("Preparing " + name + ".pdf…");
    try {
      var bytes = await buildCardPdf(state.cards[i]);
      await state.dl.save({ filename: name + ".pdf", data: new Blob([bytes], { type: "application/pdf" }) });
      say("Saved " + name + ".pdf");
    } catch (err) { saveError(err); }
    finally { state.busy = false; $("#zipbtn").disabled = false; }
  }
  async function saveZip() {
    if (!state.dl || state.busy) return;
    state.busy = true; $("#zipbtn").disabled = true;
    try {
      var names = computeNames(), zip = new JSZip(), total = names.filter(Boolean).length, done = 0;
      for (var i = 0; i < state.cards.length; i++) {
        if (!names[i]) continue;
        say("Splitting " + (done + 1) + " of " + total + "…"); setProgress(done / total);
        zip.file(names[i] + ".pdf", await buildCardPdf(state.cards[i]));
        done++; if (done % 3 === 0) await tick();
      }
      say("Packing the ZIP…");
      var blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      setProgress(null);
      await state.dl.save({ filename: safeName(state.name || "insurance") + "-cards.zip", data: blob });
      say("Saved " + total + " PDFs in one ZIP.");
    } catch (err) { setProgress(null); saveError(err); }
    finally { state.busy = false; $("#zipbtn").disabled = false; }
  }

  /* ---------- Events ---------- */
  $("#file").addEventListener("change", function (e) { loadFile(e.target.files[0]); e.target.value = ""; });
  var drop = $("#drop");
  ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });

  var timer;
  ["#cols", "#rows", "#label", "#custom"].forEach(function (s) {
    $(s).addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(buildCards, 300); });
  });
  $("#merge").addEventListener("change", buildCards);
  $("#onlyattn").addEventListener("change", function (e) { $("#grid").classList.toggle("only-attn", e.target.checked); });

  $("#grid").addEventListener("input", function (e) {
    if (!e.target.classList.contains("idin")) return;
    var i = +e.target.closest(".tile").dataset.i, c = state.cards[i];
    c.id = e.target.value; c.edited = true; state.manual.set(c.key, c.id);
    refreshStatuses();
  });
  $("#grid").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    var i = +b.closest(".tile").dataset.i;
    if (b.classList.contains("skip")) { state.cards[i].skip = !state.cards[i].skip; refreshStatuses(); }
    else if (b.classList.contains("save")) saveOne(i);
  });
  $("#zipbtn").addEventListener("click", saveZip);
})();
