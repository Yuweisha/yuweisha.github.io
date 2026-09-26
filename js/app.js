/*
 * web/js/app.js — UMA Live Studio 混音数据浏览器 + 混音工程生成器（UI 层）
 * 依赖 js/core.js（UmaCore）
 *
 * 槽位角色选择器 = 可搜索下拉（与站点一致）：搜索框 + 中文名 + 日文名副标题 + 当前项高亮，
 * 支持 方向键 / 回车 / Esc、点击外部关闭。
 */
(function () {
  "use strict";
  var C = window.UmaCore;
  var $ = function (id) { return document.getElementById(id); };

  var SITE = "https://uma.0xcjy.top";      // 音频源站（/media 带 ACAO:*）
  var DATA = "data/live/";                 // 本站镜像数据目录

  var catalog = null, durations = {}, streams = {}, samples = {}, rates = {}, detail = null, curSong = null;
  var bgmId = null, balance = true, cast = [];   // cast = [[slot, charaId], ...]
  var durManual = false;                         // 时长输入框是否被用户手动改过（否则按 streams 精算）
  var openCombo = null;

  function fmt(ms) {
    if (!ms && ms !== 0) return "—";
    var s = ms / 1000, m = Math.floor(s / 60);
    return String(m).padStart(2, "0") + ":" + (s - m * 60).toFixed(3).padStart(6, "0");
  }
  function fmtShort(ms) {
    var s = Math.max(0, (Number(ms) || 0) / 1000), m = Math.floor(s / 60);
    return m + ":" + String(Math.round(s - m * 60)).padStart(2, "0");
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function titleOf(song) {
    var t = song.title || {};
    return t.zh || t.ja || ("Live " + song.musicId);
  }
  // 副标题：标题有两种语言时用日文名；只有一种语言时退回 "LIVE <id>"。
  // 调用方若没传 musicId（如详情头部的元信息行，那里已单独印了 LIVE <id>），则返回空串，
  // 由 filter(Boolean) 丢掉——否则会拼出 "LIVE undefined"。
  function subTitleOf(song) {
    var t = song.title || {};
    if (t.zh && t.ja) return t.ja;
    return song.musicId != null ? "LIVE " + song.musicId : "";
  }
  function charaOf(id) { return detail ? C.characterById(detail, id) : null; }

  async function getJSON(url) {
    var r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    return r.json();
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    try {
      catalog = await getJSON(DATA + "catalog.json");
      try { durations = await getJSON(DATA + "durations.json"); } catch (e) { durations = {}; }
      // 文件组真实样本数（每首歌的 bgm / wave 各是多少帧）→ 逐轨元数据与 durationMs 都据此精确复现官方
      try { streams = await getJSON(DATA + "streams.json"); } catch (e) { streams = {}; }
      // 逐角色的真实样本数（个别曲子同一 wave 的不同角色长度不同，如 1027/1154）→ 优先于组值
      try { samples = await getJSON(DATA + "media-samples.json"); } catch (e) { samples = {}; }
      // 个别文件不是 48000 Hz（实测 1006/chara_1043:w0 = 44100）→ 逐轨采样率与时长换算按它
      try { rates = await getJSON(DATA + "media-rates.json"); } catch (e) { rates = {}; }
    } catch (e) {
      $("boot").className = "warn";
      $("boot").innerHTML = "读取混音数据失败：" + esc(e.message) +
        "<br>本页需要通过 HTTP 打开（file:// 会被浏览器阻止 fetch）。本地预览：<code>python tools/serve.py</code>，" +
        "或直接部署到 GitHub Pages。";
      return;
    }
    $("boot").className = "note";
    $("boot").innerHTML = "混音数据就绪：" + catalog.songs.length + " 首";
    $("libStat").textContent = catalog.songs.length + " 首可浏览";
    renderList("");
    $("search").addEventListener("input", function (e) { renderList(e.target.value); });
  }

  /* ---------------- 曲目列表 ---------------- */

  function matches(song, q) {
    if (!q) return true;
    var s = String(q).trim().toLowerCase();
    var t = song.title || {};
    if (String(song.musicId).indexOf(s) >= 0) return true;
    if ((t.zh || "").toLowerCase().indexOf(s) >= 0) return true;
    if ((t.ja || "").toLowerCase().indexOf(s) >= 0) return true;
    return (song.characters || []).some(function (c) { return C.matchCharacter(c, s); });
  }

  function renderList(q) {
    var list = $("songlist");
    list.innerHTML = "";
    var hit = 0;
    catalog.songs.forEach(function (song) {
      if (!matches(song, q)) return;
      hit++;
      var el = document.createElement("div");
      el.className = "song" + (curSong && curSong.musicId === song.musicId ? " active" : "");
      var dur = (durations[song.musicId] || {}).bgm_01;
      el.innerHTML =
        '<img loading="lazy" src="' + esc(DATA + "jackets/" + song.musicId + ".png") + '" alt="">' +
        '<div><b>' + esc(titleOf(song)) + '</b><div class="meta">' + esc(subTitleOf(song)) +
        '</div></div>' +
        '<div class="badge">' + song.musicId + (dur ? " · " + fmtShort(dur) : "") + '</div>';
      el.addEventListener("click", function () { selectSong(song.musicId); });
      list.appendChild(el);
    });
    $("libStat").textContent = hit + " / " + catalog.songs.length + " 首";
  }

  /* ---------------- 选中曲目 ---------------- */

  async function selectSong(musicId) {
    curSong = catalog.songs.find(function (s) { return s.musicId === musicId; });
    detail = await getJSON(DATA + "songs/" + musicId + ".json");
    bgmId = (detail.bgm[0] || {}).id;
    balance = $("balance").checked;
    cast = C.defaultCast(detail);
    renderList($("search").value);
    renderSong();
  }

  function renderSong() {
    $("songCard").style.display = "";
    $("outCard").style.display = "";
    $("cover").src = DATA + "jackets/" + detail.musicId + ".png";
    $("songTitle").textContent = titleOf({ musicId: detail.musicId, title: detail.title });
    var live = detail.live || {};
    $("songMeta").innerHTML = [
      "LIVE " + detail.musicId,
      subTitleOf({ title: detail.title }),
      "角色 " + (detail.characters || []).length,
      "时段 " + (detail.parts || []).length,
      live.memberCount ? "编成 " + live.memberCount : "",
    ].filter(Boolean).map(esc).join(" · ");

    var sel = $("bgmSelect");
    sel.innerHTML = "";
    (detail.bgm || []).forEach(function (b) {
      var o = document.createElement("option");
      o.value = b.id; o.textContent = b.id;
      sel.appendChild(o);
    });
    sel.value = bgmId;
    sel.onchange = function () { bgmId = sel.value; syncDuration(); build(); };

    syncDuration();
    renderSlots();
    build();
  }

  function refDuration() { return (durations[detail.musicId] || {})[bgmId] || null; }
  /** 把「默认选角的官方时长」填进输入框作为参考；只有用户手动改过才会当成覆盖值。 */
  function syncDuration() {
    var d = refDuration();
    durManual = false;
    $("durInput").value = d ? String(d) : "";
    /* 参考值改成悬停提示（原来那行小字已按需求去掉） */
    $("durInput").title = d
      ? "参考：默认选角 " + d + " ms；改动它会覆盖按当前选角精算的时长"
      : "本地没有参考值：将按 streams.json 精算时长";
  }

  /* ---------------- 出场时间轴 ---------------- */

  function slotIntervals(slot) {
    var dur = refDuration() || (detail.parts[detail.parts.length - 1] || {}).timeMs || 1;
    var iv = [], open = null;
    var parts = detail.parts.slice().sort(function (a, b) { return a.timeMs - b.timeMs; });
    parts.forEach(function (p) {
      var e = C.slotEntry(p, slot);
      var active = !!(e && e.waveIndex !== null && e.waveIndex !== undefined);
      if (active && open === null) open = p.timeMs;
      if (!active && open !== null) { iv.push([open, p.timeMs]); open = null; }
    });
    if (open !== null) iv.push([open, dur]);
    return { list: iv, dur: dur };
  }

  function renderRuler() {
    var el = $("ruler");
    if (!el) return;
    var dur = refDuration() || (detail.parts[detail.parts.length - 1] || {}).timeMs || 0;
    var out = [];
    for (var i = 0; i <= 4; i++) out.push("<span>" + fmtShort(dur * i / 4) + "</span>");
    el.innerHTML = out.join("");
  }

  /* ---------------- 槽位 + 可搜索下拉 ---------------- */

  function currentCharaId(slot) {
    var hit = cast.find(function (kv) { return kv[0] === slot; });
    return hit ? Number(hit[1]) : null;
  }
  function setCast(slot, charaId) {
    cast = cast.map(function (kv) { return kv[0] === slot ? [slot, Number(charaId)] : kv; });
    renderSlots();
    build();
  }

  function closeCombo() {
    if (!openCombo) return;
    openCombo.pop.hidden = true;
    openCombo.btn.setAttribute("aria-expanded", "false");
    openCombo = null;
  }

  function renderSlots() {
    var box = $("slots");
    box.innerHTML = "";
    C.slotsOfSong(detail).forEach(function (slot) { box.appendChild(slotRow(slot)); });
    renderRuler();
  }

  function slotRow(slot) {
    var waves = C.wavesOfSlot(detail, slot);
    var iv = slotIntervals(slot);
    var cur = currentCharaId(slot);
    var curC = charaOf(cur) || (detail.characters || [])[0];

    var bars = iv.list.map(function (a) {
      var left = (a[0] / iv.dur) * 100, w = Math.max(0.3, ((a[1] - a[0]) / iv.dur) * 100);
      return '<i style="left:' + left.toFixed(3) + "%;width:" + w.toFixed(3) + '%"></i>';
    }).join("");
    var total = iv.list.reduce(function (s, a) { return s + (a[1] - a[0]); }, 0);

    var el = document.createElement("div");
    el.className = "slot";
    el.innerHTML =
      '<div class="top">' +
        '<div class="slotname">' + esc(slot) + '</div>' +
        '<div class="combo">' +
          '<button class="combo-btn" type="button" aria-haspopup="listbox" aria-expanded="false">' +
            '<span class="cname">' + esc(C.characterName(curC)) + '</span>' +
            '<span class="cja">' + esc(C.characterSubName(curC)) + '</span>' +
            '<span class="caret">▾</span>' +
          '</button>' +
          '<div class="combo-pop" hidden>' +
            '<input class="combo-search" type="search" placeholder="搜索角色" aria-label="搜索角色">' +
            '<div class="combo-list" role="listbox"></div>' +
            '<div class="combo-empty" hidden>没有匹配的角色</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="tl" title="出场 ' + fmt(total) + '">' + bars + '</div>' +
      '<div class="small" style="margin-top:6px">本槽使用 wave ' + waves.join(" / ") +
        " · 出场 " + iv.list.length + " 段 / 合计 " + fmt(total) +
        " · 首次 " + fmt(iv.list.length ? iv.list[0][0] : 0) + "</div>";

    var btn = el.querySelector(".combo-btn");
    var pop = el.querySelector(".combo-pop");
    var search = el.querySelector(".combo-search");
    var list = el.querySelector(".combo-list");
    var empty = el.querySelector(".combo-empty");
    var items = [];

    (detail.characters || []).forEach(function (c) {
      var usable = C.wavesForCharacter(detail, slot, c.charaId);
      var lack = waves.filter(function (w) { return usable.indexOf(w) < 0; });
      var it = document.createElement("div");
      it.className = "combo-item" + (c.charaId === cur ? " selected" : "");
      it.setAttribute("role", "option");
      it.dataset.id = c.charaId;
      // 列表里不显示 wave 标注（用户要求删掉）：名字块整体靠左，wave 信息在槽位卡片那行看。
      it.innerHTML =
        '<span class="cname">' + esc(C.characterName(c)) + '</span>' +
        '<span class="cja">' + esc(C.characterSubName(c)) + ' ' +
          '<span class="cid">#' + c.charaId + '</span></span>';
      it.addEventListener("mousedown", function (e) { e.preventDefault(); pick(c.charaId); });
      it.addEventListener("mousemove", function () { setActive(items.indexOf(it)); });
      list.appendChild(it);
      items.push(it);
    });

    var active = 0;

    function setActive(i) {
      if (!items.length) return;
      active = (i + items.length) % items.length;
      items.forEach(function (it, k) { it.classList.toggle("active", k === active); });
      var it = items[active];
      if (it && it.scrollIntoView) it.scrollIntoView({ block: "nearest" });
    }
    function pick(id) { closeCombo(); setCast(slot, id); }
    function filter(q) {
      var shown = 0, firstVisible = -1;
      items.forEach(function (it, k) {
        var ok = C.matchCharacter(charaOf(Number(it.dataset.id)), q);
        it.style.display = ok ? "" : "none";
        if (ok) { shown++; if (firstVisible < 0) firstVisible = k; }
      });
      empty.hidden = shown > 0;
      if (firstVisible >= 0) setActive(firstVisible);
    }
    function activeIndexFor(id) {
      var i = items.findIndex(function (it) { return Number(it.dataset.id) === id; });
      return i < 0 ? 0 : i;
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var wasOpen = openCombo && openCombo.pop === pop;
      closeCombo();
      if (wasOpen) return;
      pop.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      openCombo = { pop: pop, btn: btn };
      search.value = "";
      filter("");
      setActive(activeIndexFor(cur));
      search.focus();
    });
    search.addEventListener("input", function () { filter(search.value); });
    search.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        var it = items[active];
        if (it && it.style.display !== "none") pick(Number(it.dataset.id));
      } else if (e.key === "Escape") { closeCombo(); btn.focus(); }
    });

    return el;
  }

  document.addEventListener("mousedown", function (e) {
    if (!openCombo) return;
    if (!openCombo.pop.parentNode.contains(e.target)) closeCombo();
  });

  /* ---------------- 生成工程 ---------------- */

  var current = null;

  function build() {
    var durInput = parseInt($("durInput").value, 10);
    var manual = (durManual && isFinite(durInput) && durInput > 0) ? durInput : null;
    var songStreams = streams[String(detail.musicId)] || null;
    var songSamples = samples[String(detail.musicId)] || null;
    var songRates = rates[String(detail.musicId)] || null;
    // 时长规则（官方：返回轨道的最长者）：有 streams 就按当前选角精算，否则退回参考时长
    current = C.buildProject({
      detail: detail, bgmId: bgmId, cast: cast, balance: balance,
      durationMs: manual, streams: songStreams, samples: songSamples, rates: songRates
    });
    var durMs = current.durationMs;
    var voices = current.tracks.filter(function (t) { return t.id !== "bgm"; }).length;
    $("outStat").textContent = current.tracks.length + " 轨 · " + (durMs ? fmt(durMs) : "时长未知");
    $("outKv").innerHTML =
      "<b>曲目</b><span>" + esc(titleOf({ musicId: detail.musicId, title: detail.title })) + "</span>" +
      "<b>BGM</b><span>" + esc(bgmId || "-") + "</span>" +
      "<b>声部轨</b><span>" + voices + " 条（" + cast.map(function (kv) {
        var c = charaOf(kv[1]);
        return kv[0] + "=" + (c ? C.characterName(c) : kv[1]);
      }).join("、") + "）</span>" +
      "<b>平衡补偿</b><span>" + (balance ? "开（×N^(-1/3)）" : "关") + "</span>" +
      "<b>时长</b><span>" + (durMs ? (durMs / 1000).toFixed(3) + " 秒" : "未设置") + "</span>";
    var json = JSON.stringify(current, null, 1);
    $("jsonPreview").textContent = json.length > 12000 ? json.slice(0, 12000) + "\n… （预览截断，下载得到完整 JSON）" : json;
  }

  /* ---------------- 动作 ---------------- */

  function exportName() { return C.exportBaseName(detail, cast, bgmId); }

  function download() {
    var blob = new Blob([JSON.stringify(current, null, 1)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = exportName() + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    $("outMsg").textContent = "已下载 " + a.download;
  }

  async function copyJSON() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(current));
      $("outMsg").textContent = "已复制完整 JSON 到剪贴板（" + JSON.stringify(current).length + " 字符）";
    } catch (e) {
      $("outMsg").textContent = "复制失败（浏览器限制）：" + e.message;
    }
  }

  function sendToMixer() {
    try {
      localStorage.setItem("uma.project", JSON.stringify(current));
      localStorage.setItem("uma.handoff", JSON.stringify({
        mediaBase: SITE, name: exportName(), ts: Date.now()
      }));
      location.href = "mixer.html?auto=1";
    } catch (e) {
      $("outMsg").textContent = "写入 localStorage 失败：" + e.message;
    }
  }

  /* ---------------- 绑定 ---------------- */

  document.addEventListener("DOMContentLoaded", function () {
    $("btnReset").onclick = function () { cast = C.defaultCast(detail); renderSlots(); build(); };
    $("btnDownload").onclick = download;
    $("btnCopy").onclick = copyJSON;
    $("btnMixer").onclick = sendToMixer;
    $("balance").addEventListener("change", function (e) { balance = e.target.checked; build(); });
    $("durInput").addEventListener("input", function () { durManual = true; });
    $("durInput").addEventListener("change", build);
    boot();
  });
})();
