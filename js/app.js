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
  var libMode = "live", jbIndex = null, curJb = null;   // 曲目列表：Live / 唱片机 两个标签
  var defaultInterlude = false;                  // 「播放默认间奏」：勾上则特殊演出换播默认间奏（vo_0000）
  var scVoice = null;                            // 特殊演出的声部版本（带 voices 的曲子，如 1151 的男声/女声）
  /* 全曲同一角色：开启后所有槽位改用同一个角色；castBefore 记录开启前的逐槽选角以便还原 */
  var sameCharId = null, castBefore = null;
  var sfx = false;                               // 「演出音效」复选框：勾上用含演出音效的那版伴奏（bgm_01）
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

  /** 顶部状态条元素已按需求移除：这里做空值兜底，读取失败时退回 outMsg */
  function setBoot(cls, html) {
    var el = $("boot");
    if (el) { el.className = cls; el.innerHTML = html; return; }
    if (cls === "warn") $("outMsg").textContent = String(html).replace(/<[^>]+>/g, "");
  }

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
      setBoot("warn", "读取混音数据失败：" + esc(e.message) +
        "<br>本页需要通过 HTTP 打开（file:// 会被浏览器阻止 fetch）。本地预览：<code>python tools/serve.py</code>，" +
        "或直接部署到 GitHub Pages。");
      return;
    }
    setBoot("note", "混音数据就绪：" + catalog.songs.length + " 首");
    $("libStat").textContent = catalog.songs.length + " 首可浏览";
    renderList("");
    $("search").addEventListener("input", function (e) { renderList(e.target.value); });
    Array.prototype.forEach.call(document.querySelectorAll(".lib-tab"), function (b) {
      b.addEventListener("click", function () { switchLibMode(b.dataset.mode); });
    });
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
    if (libMode === "jukebox") return renderJukeboxList(q);
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

  /* ---------------- 唱片机（点唱机）标签 ---------------- */

  /** 封面与音频都在 R2：<媒体基址>/media/jukebox/… */
  function jbCoverUrl(id) { return C.mediaBaseDefault() + "/media/jukebox/covers/" + id + ".png"; }
  function jbAudioUrl(id) { return C.mediaBaseDefault() + "/media/jukebox/" + id + ".mp3"; }

  async function ensureJukeboxIndex() {
    if (jbIndex) return jbIndex;
    try {
      var d = await getJSON(DATA + "../jukebox/index.json");
      jbIndex = (d && d.items) || [];
    } catch (e) {
      jbIndex = [];
      $("outMsg").textContent = "点唱机索引读取失败：" + e.message;
    }
    return jbIndex;
  }

  function jbMatches(jb, q) {
    var s = String(q || "").trim().toLowerCase();
    if (!s) return true;
    return String(jb.musicId).indexOf(s) >= 0 || String(jb.title || "").toLowerCase().indexOf(s) >= 0;
  }

  function renderJukeboxList(q) {
    var list = $("songlist");
    list.innerHTML = "";
    var hit = 0;
    (jbIndex || []).forEach(function (jb) {
      if (!jbMatches(jb, q)) return;
      hit++;
      var el = document.createElement("div");
      el.className = "song" + (curJb && curJb.musicId === jb.musicId ? " active" : "");
      el.innerHTML =
        '<img loading="lazy" src="' + esc(jbCoverUrl(jb.musicId)) + '" alt="">' +
        '<div><b>' + esc(jb.title) + '</b><div class="meta">JUKEBOX ' + jb.musicId +
        (jb.chara ? " · " + esc(jb.chara) + "角色曲" : "") + (jb.hasLyrics ? " · 含歌词" : "") +
        '</div></div>' +
        '<div class="badge">' + jb.musicId + (jb.durationMs ? " · " + fmtShort(jb.durationMs) : "") + '</div>';
      el.addEventListener("click", function () { selectJukebox(jb.musicId); });
      list.appendChild(el);
    });
    $("libStat").textContent = hit + " / " + (jbIndex || []).length + " 首";
  }

  async function switchLibMode(mode) {
    if (mode === libMode) return;
    libMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll(".lib-tab"), function (b) {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    document.body.classList.toggle("jb-mode", mode === "jukebox");
    if (mode === "jukebox") await ensureJukeboxIndex();
    renderList($("search").value);
  }

  /** 点一首唱片机曲目：做成「单轨工程」直接交给内嵌播放器（音频与封面走 R2，歌词读镜像的 .lrc） */
  async function selectJukebox(id) {
    if (!jbIndex) await ensureJukeboxIndex();
    var jb = (jbIndex || []).find(function (x) { return x.musicId === Number(id); });
    if (!jb) return;
    if (window.__umaPlayer && typeof window.__umaPlayer.reset === "function") {
      try { window.__umaPlayer.reset(); } catch (e) {}
    }
    curSong = null; curJb = jb; detail = null;
    current = {
      id: "jb-" + id, name: "Jukebox " + id, durationMs: jb.durationMs || 0, sampleRate: 48000,
      tracks: [{
        id: "bgm", name: "JUKEBOX " + jb.title, media: jbAudioUrl(id),
        stream: {
          codec: "mp3", container: "mp3", sampleRate: 48000, channels: 2,
          decodedSampleCount: jb.sampleCount || null,
          encoderDelaySamples: 576, encoderPaddingSamples: 576, seekIndex: null
        },
        timelineStartSample: 0, volumeDb: 0, panner: 0, muted: false, solo: false,
        startOffsetMs: 0, dynamics: null, volumeAutomation: [], pannerAutomation: []
      }],
      _uma: {
        source: "uma-live-studio", jukebox: true, musicId: Number(id),
        lyrics: "data/jukebox_metadata/lyrics/" + id + ".lrc"
      }
    };
    $("songCard").style.display = "";
    $("cover").src = jbCoverUrl(id);
    $("songTitle").textContent = jb.title;
    $("songMeta").textContent = "JUKEBOX " + id + (jb.durationMs ? " · " + fmtShort(jb.durationMs) : "");
    $("liveCredits").hidden = true; $("liveIntro").hidden = true;
    renderList($("search").value);
    if (window.__umaPlayer) window.__umaPlayer.load(current);
    $("outMsg").textContent = "已载入点唱机曲目「" + jb.title + "」，点播放开始" + (jb.hasLyrics ? "（含歌词）" : "");
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
  /** 另一版伴奏（含演出音效，id 不是 bgm_02）；没有就返回 null（该曲不显示「演出音效」复选框） */
  function bgmSfxId(d) {
    var hit = ((d && d.bgm) || []).find(function (b) { return b.id && b.id !== "bgm_02"; });
    return (hit && hit.id) || null;
  }
  function applyBgm() { bgmId = (sfx && bgmSfxId(detail)) || pickBgmId(detail); }
  /** 「演出音效」复选框：只有两版伴奏的曲子才出现 */
  function syncBgmUI() {
    var box = $("sfxSwitch");
    var has = !!bgmSfxId(detail);
    if (box) box.hidden = !has;
    if (!has) { sfx = false; if ($("bgmSfx")) $("bgmSfx").checked = false; }
    applyBgm();
  }

  function renderSong() {
    // 换 Live：先把播放器停掉并重置（否则播放键与进度条会停在上一次的状态）
    if (window.__umaPlayer && typeof window.__umaPlayer.reset === "function") {
      try { window.__umaPlayer.reset(); } catch (e) { /* 播放器未就绪时忽略 */ }
    }
    $("songCard").style.display = "";
    /* 输出卡已并入播放器（摘要/音轨/日志由 player.js 控制显示） */
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

    syncBgmUI();
    syncSpecialCutUI();
    renderSameChar();
    renderSlots();
    build();
  }

  /** 「播放默认间奏」只在带特殊演出数据的曲子（目前 1157）出现 */
  function syncSpecialCutUI() {
    var sc = C.specialCutOf(detail);
    var box = $("interludeSwitch");
    var on = !!sc;
    if (box) box.hidden = !on;
    if (!on) { defaultInterlude = false; if ($("defaultInterlude")) $("defaultInterlude").checked = false; }
    // 男声/女声（只有带 voices 的曲子才有）
    var vbox = $("voiceSwitch");
    var voices = on ? C.specialCutVoices(sc) : null;
    if (vbox) {
      vbox.hidden = !voices;
      if (voices) {
        scVoice = C.specialCutVoiceId(sc, scVoice);
        var sig = voices.map(function (v) { return String(v.id) + "|" + (v.label || ""); }).join(",");
        if (vbox.dataset.sig !== sig) {
          vbox.dataset.sig = sig;
          vbox.innerHTML = voices.map(function (v) {
            return '<label><input type="radio" name="scvoice" value="' + esc(String(v.id)) + '"' +
              (String(v.id) === scVoice ? " checked" : "") + "><span>" + esc(v.label || v.id) + "</span></label>";
          }).join("");
          Array.prototype.forEach.call(vbox.querySelectorAll("input"), function (inp) {
            inp.addEventListener("change", function (e) { scVoice = e.target.value; build(); });
          });
        } else {
          Array.prototype.forEach.call(vbox.querySelectorAll("input"), function (inp) {
            inp.checked = String(inp.value) === scVoice;
          });
        }
      } else scVoice = null;
    }
  }

  function refDuration() { return songDuration(detail.musicId, bgmId); }

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

  /** 时间轴标尺：每个声部格子里各渲染一条，紧贴在音轨条上方（宽度与音轨条一致） */
  function rulerHtml() {
    var dur = refDuration() || (detail.parts[detail.parts.length - 1] || {}).timeMs || 0;
    var out = [];
    for (var i = 0; i <= 4; i++) out.push("<span>" + fmtShort(dur * i / 4) + "</span>");
    return out.join("");
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
    C.displaySlots(detail).forEach(function (slot) { box.appendChild(slotRow(slot)); });
    syncSameCharUI();
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
        '<div class="slotname" data-slot="' + esc(slot) + '">' + esc(C.slotLabel(slot)) + '</div>' +
        '<div class="combo"></div>' +
      '</div>' +
      '<div class="ruler" data-slot="' + esc(slot) + '">' + rulerHtml() + '</div>' +
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
    var songStreams = streams[String(detail.musicId)] || null;
    var songSamples = samples[String(detail.musicId)] || null;
    var songRates = rates[String(detail.musicId)] || null;
    // 时长规则（官方：返回轨道的最长者）：有 streams 就按当前选角精算，否则退回参考时长
    current = C.buildProject({
      detail: detail, bgmId: bgmId, cast: cast, balance: balance,
      specialCut: !!C.specialCutOf(detail), specialCutDefault: defaultInterlude, specialCutVoice: scVoice,
      durationMs: null, streams: songStreams, samples: songSamples, rates: songRates
    });
    /* 摘要与 JSON 预览已按需求移除：这里只保留 current（送入混音器要用） */
  }

  /* ---------------- 动作 ---------------- */

  /** 特殊演出摘要：间奏起点 + 播哪条轨 */
  function specialCutSummary() {
    var sc = C.specialCutOf(detail);
    if (!sc) return "";
    var hit = cast.find(function (kv) { return kv[0] === "center"; });
    var cid = hit ? Number(hit[1]) : null;
    var isDefault = defaultInterlude || !C.specialCutHas(sc, cid);
    var use = isDefault ? Number(sc.defaultId || 0) : cid;
    var c = isDefault ? null : charaOf(use);
    var vLabel = scVoice ? " " + C.specialCutVoiceLabel(sc, scVoice) : "";
    var file = String(C.specialCutPath(sc, use, scVoice)).split("/").pop();
    return (Number(sc.startMs || 0) / 1000).toFixed(3) + " 秒起 播 " +
      (c ? C.characterName(c) : "默认间奏") + vLabel + "（" + file + "）";
  }

  /** 摘要里的角色顺序：与界面一致，主唱排第一 */
  function displayCast() {
    var bySlot = {};
    cast.forEach(function (kv) { bySlot[kv[0]] = kv; });
    var out = C.displaySlots(detail).map(function (s) { return bySlot[s]; }).filter(Boolean);
    // 兜底：有任何没被 displaySlots 覆盖的槽位也带上
    cast.forEach(function (kv) { if (out.indexOf(kv) < 0) out.push(kv); });
    return out;
  }

  function exportName() { return C.exportBaseName(detail, cast, bgmId); }

  /** 给内嵌播放器用：播放键按下时取当前选角生成好的工程 */
  window.__umaBuildProject = function () { return current; };

  /* ---------------- 绑定 ---------------- */

  document.addEventListener("DOMContentLoaded", function () {
    $("btnRandomCast").onclick = randomCast;
    $("btnReset").onclick = function () {
      sameCharId = null; castBefore = null;
      syncSameCharUI();
      setSameCharMsg("");
      cast = C.defaultCast(detail); renderSlots(); build();
    };
    $("balance").addEventListener("change", function (e) { balance = e.target.checked; build(); });
    $("defaultInterlude").addEventListener("change", function (e) { defaultInterlude = e.target.checked; build(); });
    $("bgmSfx").addEventListener("change", function (e) { sfx = e.target.checked; applyBgm(); build(); });
    boot();
  });
})();
