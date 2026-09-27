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

  var SITE = C.mediaBaseDefault();         // 音频源站：默认官方站；core.js 里 MEDIA_BASE_DEFAULT 可整站切到 R2
  var DATA = "data/live/";                 // 本站镜像数据目录

  var catalog = null, durations = {}, streams = {}, samples = {}, rates = {}, detail = null, curSong = null;
  var bgmId = null, balance = true, cast = [];   // cast = [[slot, charaId], ...]
  /* 全曲同一角色：开启后所有槽位改用同一个角色；castBefore 记录开启前的逐槽选角以便还原 */
  var sameCharId = null, castBefore = null;
  var durManual = false;                         // 时长输入框是否被用户手动改过（否则按 streams 精算）
  var openCombo = null;

  /** 时长查表：优先指定 bgm，其次 bgm_01，最后退回该曲剩下的任一值。
      别再写死 bgm_01 —— 例如 1151 只有 bgm_02，写死就会查不到时长。 */
  function songDuration(musicId, bgmHint) {
    var e = durations[musicId] || {};
    if (bgmHint && e[bgmHint]) return e[bgmHint];
    if (e.bgm_01) return e.bgm_01;
    var best = null;
    Object.keys(e).forEach(function (k) { if (e[k] && (!best || e[k] > best)) best = e[k]; });
    return best;
  }

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
      var dur = songDuration(song.musicId, (song.bgm || [])[0]);
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
    await loadSongInfo(musicId);
    bgmId = pickBgmId(detail);
    balance = $("balance").checked;
    cast = C.defaultCast(detail);
    renderList($("search").value);
    renderSong();
  }

  /* ---------------- 乐曲信息：作词作曲 / 介绍（data/live/info/<id>.json） ---------------- */

  var infoCache = {};
  async function loadSongInfo(musicId) {
    var elC = $("liveCredits"), elI = $("liveIntro");
    if (elC) { elC.hidden = true; elC.textContent = ""; }
    if (elI) { elI.hidden = true; elI.textContent = ""; }
    if (Object.prototype.hasOwnProperty.call(infoCache, musicId) === false) {
      try { infoCache[musicId] = await getJSON(DATA + "info/" + musicId + ".json"); }
      catch (e) { infoCache[musicId] = null; }   // 缺文件不影响主流程
    }
    var info = infoCache[musicId];
    if (!info) return;
    if (elC && info.credits) { elC.hidden = false; elC.textContent = info.credits; }
    if (elI && info.intro) { elI.hidden = false; elI.textContent = info.intro; }
  }

  /** BGM 版本名（照官方界面的写法）：bgm_02 无演出音效、bgm_01 含演出音效 */
  function bgmLabel(id) {
    if (id === "bgm_02") return "伴奏（无演出音效）";
    if (id === "bgm_01") return "伴奏（含演出音效）";
    return id || "伴奏";
  }
  /** 默认 BGM：官方前端取 bgm_02（无演出音效），没有才退回第一个 */
  function pickBgmId(d) {
    var list = (d && d.bgm) || [];
    var hit = list.find(function (b) { return b.id === "bgm_02"; });
    return ((hit || list[0] || {}).id) || null;
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
      o.value = b.id; o.textContent = bgmLabel(b.id);
      sel.appendChild(o);
    });
    sel.value = bgmId;
    sel.onchange = function () { bgmId = sel.value; syncDuration(); build(); };

    renderEggHint();
    syncDuration();
    renderSameChar();
    renderSlots();
    build();
  }

  /** 彩蛋提示：本曲有迷人景致的音轨时，默认选角就是她 */
  function renderEggHint() {
    var el = $("eggHint");
    if (!el) return;
    // 特性探测：万一浏览器把旧 core.js 和新 app.js 混着用，也只是没有提示，不会中断渲染
    var egg = (typeof C.easterEggSlots === "function") ? C.easterEggSlots(detail) : [];
    if (!egg.length) { el.hidden = true; el.textContent = ""; return; }
    var c = C.characterById(detail, C.EASTER_CHARA);
    el.hidden = false;
    el.textContent = "\u266a 彩蛋：本曲有" + C.characterName(c) + "的音轨，默认就由她演唱（"
      + egg.length + " 个槽位：" + egg.join(" / ") + "）";
  }

  function refDuration() { return songDuration(detail.musicId, bgmId); }
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
    if (sameCharId) {
      sameCharId = null; castBefore = null;
      syncSameCharUI();
      setSameCharMsg("手动改了某个槽位，已退出「全曲同一角色」");
    }
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

  /* ---------------- 全曲同一角色 ---------------- */

  function setSameCharMsg(t) { var el = $("sameCharMsg"); if (el) el.textContent = t || ""; }

  function nameOfChara(id) {
    var hit = (detail.characters || []).find(function (c) { return Number(c.charaId) === Number(id); });
    return hit ? C.characterName(hit) : "chara " + id;
  }

  /** 重建「全曲同一角色」下拉：条目排版与站位选角一致；换曲后上次那位不在阵容里则自动退出 */
  var sameCharCombo = null;
  function syncSameCharUI() {
    var box = $("sameCharCombo");
    if (!box) return;
    sameCharCombo = buildCharaCombo(box, {
      rows: (detail && detail.characters) || [],
      currentId: sameCharId,
      offLabel: "关闭（每个槽位单独选角）",
      offSub: "选择后全部槽位都由同一个角色演唱",
      emptyLabel: "关闭（每个槽位单独选角）",
      title: "选一个角色，所有声部槽位都换成它：槽位数量、出场时间轴、增益与平衡规则都不变",
      onPick: function (id) { if (id == null) clearSameChar(); else applySameChar(id); }
    });
  }
  function renderSameChar() {
    if (!$("sameCharCombo")) return;
    var chs = (detail && detail.characters) || [];
    var ids = chs.map(function (c) { return Number(c.charaId); });
    if (sameCharId && ids.indexOf(Number(sameCharId)) < 0) {
      sameCharId = null; castBefore = null;
      setSameCharMsg("本曲阵容里没有上次那位角色，已退出「全曲同一角色」");
      syncSameCharUI();
      return;
    }
    syncSameCharUI();
    if (sameCharId) applySameChar(sameCharId);
  }

  function applySameChar(id) {
    if (!sameCharId) castBefore = cast.map(function (kv) { return [kv[0], kv[1]]; });
    sameCharId = Number(id);
    cast = C.slotsOfSong(detail).map(function (slot) { return [slot, Number(id)]; });
    syncSameCharUI();
    renderSlots(); build();
    var empty = cast.filter(function (kv) { return !C.wavesForCharacter(detail, kv[0], kv[1]).length; })
                    .map(function (kv) { return kv[0]; });
    setSameCharMsg("全部 " + cast.length + " 个槽位都由 " + nameOfChara(sameCharId) + " 演唱"
      + (empty.length ? "（" + empty.join(" / ") + " 槽该角色无音源，会静音）" : ""));
  }

  function clearSameChar() {
    sameCharId = null;
    cast = castBefore ? castBefore : C.defaultCast(detail);
    castBefore = null;
    syncSameCharUI();
    renderSlots(); build();
    setSameCharMsg("已恢复逐槽位单独选角");
  }

  /** 随机挑 3 个角色（不足 3 个就全用），随机分配到各站位再用它们循环填满 */
  function randomCast() {
    var pool = (detail.characters || []).map(function (c) { return Number(c.charaId); });
    if (!pool.length) return;
    var n = Math.min(3, pool.length);
    var picked = shuffle(pool.slice()).slice(0, n);
    var slots = C.slotsOfSong(detail);
    var order = [];
    for (var i = 0; i < slots.length; i++) order.push(picked[i % n]);
    shuffle(order);
    sameCharId = null; castBefore = null;
    cast = slots.map(function (slot, i) { return [slot, order[i]]; });
    syncSameCharUI();
    renderSlots(); build();
    var empty = cast.filter(function (kv) { return !C.wavesForCharacter(detail, kv[0], kv[1]).length; })
                    .map(function (kv) { return kv[0]; });
    setSameCharMsg("随机 " + n + " 位：" + picked.map(nameOfChara).join(" / ")
      + (empty.length ? "（" + empty.join(" / ") + " 槽该角色无音源，会静音）" : ""));
  }

  /** Fisher–Yates（原地洗牌，返回同一个数组） */
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function renderSlots() {
    var box = $("slots");
    box.innerHTML = "";
    C.slotsOfSong(detail).forEach(function (slot) { box.appendChild(slotRow(slot)); });
    syncSameCharUI();
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
        '<div class="combo"></div>' +
      '</div>' +
      '<div class="tl" title="出场 ' + fmt(total) + '">' + bars + '</div>' +
      '<div class="small" style="margin-top:6px">本槽使用 wave ' + waves.join(" / ") +
        " · 出场 " + iv.list.length + " 段 / 合计 " + fmt(total) +
        " · 首次 " + fmt(iv.list.length ? iv.list[0][0] : 0) + "</div>";

    buildCharaCombo(el.querySelector(".combo"), {
      rows: detail.characters || [],
      currentId: cur,
      onPick: function (id) { if (id != null) setCast(slot, id); }
    });

    return el;
  }

  /* ---------------- 通用角色下拉（站位选角 + 全曲同一角色共用） ----------------
     条目排版：第一行中文名；第二行「日文原名 |英文名」；右侧 #角色编号。 */
  function buildCharaCombo(container, opts) {
    if (!container) return null;
    opts = opts || {};
    var rows = (opts.rows || []).slice();
    if (opts.offLabel) rows.unshift({ __off: true });
    var curId = opts.currentId == null || opts.currentId === "" ? null : Number(opts.currentId);
    container.innerHTML =
      '<button class="combo-btn" type="button" aria-haspopup="listbox" aria-expanded="false"' +
        (opts.title ? ' title="' + esc(opts.title) + '"' : '') + '>' +
        '<span class="cbtn-main">' +
          '<span class="cname"></span>' +
          '<span class="cja"></span>' +
        '</span>' +
        '<span class="cbtn-right">' +
          '<span class="cid"></span>' +
          '<span class="caret">▾</span>' +
        '</span>' +
      '</button>' +
      '<div class="combo-pop" hidden>' +
        '<input class="combo-search" type="search" placeholder="搜索角色" aria-label="搜索角色">' +
        '<div class="combo-list" role="listbox"></div>' +
        '<div class="combo-empty" hidden>没有匹配的角色</div>' +
      '</div>';

    var btn = container.querySelector(".combo-btn");
    var pop = container.querySelector(".combo-pop");
    var search = container.querySelector(".combo-search");
    var list = container.querySelector(".combo-list");
    var empty = container.querySelector(".combo-empty");
    var items = [], active = 0;

    function labelOf(c) {
      if (!c) return { name: opts.emptyLabel || "未选择", sub: "", id: "" };
      if (c.__off) return { name: opts.offLabel, sub: opts.offSub || "", id: "" };
      return { name: C.characterName(c), sub: C.characterSubName(c), id: C.characterIdLabel(c) };
    }
    function paintBtn() {
      var hit = null;
      for (var i = 0; i < rows.length; i++) if (!rows[i].__off && Number(rows[i].charaId) === curId) hit = rows[i];
      if (!hit && opts.offLabel && !curId) hit = { __off: true };
      var L = labelOf(hit);
      btn.querySelector(".cname").textContent = L.name;
      btn.querySelector(".cja").textContent = L.sub;
      btn.querySelector(".cid").textContent = L.id;
      btn.classList.toggle("on", !!(curId && hit));
    }

    rows.forEach(function (c) {
      var L = labelOf(c);
      var it = document.createElement("div");
      it.className = "combo-item" + (!c.__off && Number(c.charaId) === curId ? " selected" : "");
      it.setAttribute("role", "option");
      it.dataset.id = c.__off ? "" : c.charaId;
      if (c.__off) it.dataset.off = "1";
      it.__chara = c;
      it.innerHTML =
        '<span class="cname">' + esc(L.name) + '</span>' +
        '<span class="cja">' + esc(L.sub) + '</span>' +
        '<span class="cid">' + esc(L.id) + '</span>';
      it.addEventListener("mousedown", function (e) { e.preventDefault(); pick(c); });
      it.addEventListener("mousemove", function () { setActive(items.indexOf(it)); });
      list.appendChild(it);
      items.push(it);
    });

    function setActive(i) {
      if (!items.length) return;
      active = (i + items.length) % items.length;
      items.forEach(function (it, k) { it.classList.toggle("active", k === active); });
      var it = items[active];
      if (it && it.scrollIntoView) it.scrollIntoView({ block: "nearest" });
    }
    function pick(c) {
      closeCombo();
      if (opts.onPick) opts.onPick(c && c.__off ? null : Number(c.charaId));
    }
    function filter(q) {
      var shown = 0, firstVisible = -1;
      items.forEach(function (it, k) {
        var c = it.__chara;
        var ok = c.__off ? true : C.matchCharacter(c, q);
        it.style.display = ok ? "" : "none";
        if (ok) { shown++; if (firstVisible < 0) firstVisible = k; }
      });
      empty.hidden = shown > 0;
      if (firstVisible >= 0) setActive(firstVisible);
    }
    function activeIndexFor(id) {
      if (id == null) return 0;
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
      setActive(activeIndexFor(curId));
      search.focus();
    });
    search.addEventListener("input", function () { filter(search.value); });
    search.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        var it = items[active];
        if (it && it.style.display !== "none") pick(it.__chara);
      } else if (e.key === "Escape") { closeCombo(); btn.focus(); }
    });

    paintBtn();
    return { container: container, btn: btn, pop: pop, search: search, items: items, refresh: function (id) { curId = id == null || id === "" ? null : Number(id); paintBtn(); return curId; } };
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
      "<b>BGM</b><span>" + esc(bgmId ? bgmId + " · " + bgmLabel(bgmId) : "-") + "</span>" +
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
    $("btnRandomCast").onclick = randomCast;
    $("btnReset").onclick = function () {
      sameCharId = null; castBefore = null;
      syncSameCharUI();
      setSameCharMsg("");
      cast = C.defaultCast(detail); renderSlots(); build();
    };
    $("btnDownload").onclick = download;
    $("btnCopy").onclick = copyJSON;
    $("btnMixer").onclick = sendToMixer;
    $("balance").addEventListener("change", function (e) { balance = e.target.checked; build(); });
    $("durInput").addEventListener("input", function () { durManual = true; });
    $("durInput").addEventListener("change", build);
    boot();
  });
})();
