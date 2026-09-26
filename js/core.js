/*
 * uma-live-studio — core.js
 * 纯逻辑层（无 DOM、无网络），可在浏览器直接 <script> 引入，也可在 Node 中 require() 做测试。
 *
 * 职责：把「本站镜像的曲目详情 JSON」+「槽位→角色 选择」推导成与官方 API
 *       /api/live/mixer/projects/live-<id> 完全等价的混音工程 JSON。
 *
 * 规则来源：对官方 API 51 首曲目、多种槽位组合、balance 0/1 的实测拟合，
 *          并由 test/run.mjs 用真实响应对拍验证（见 docs/混音规则.md）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UmaCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SILENT_DB = -60;          // 服务端用 -60dB 表示静音
  var DEFAULT_GAIN = 0.95;      // BGM 恒定增益，= -0.44552789422304506 dB
  var SAMPLE_RATE = 48000;
  var ENCODER_DELAY = 576;      // 官方 stream.encoderDelaySamples（文件无 LAME/Xing 标签，服务端固定假定 576/576）
  var ENCODER_PADDING = 576;
  /* 默认媒体基址：留空 = 走官方源站（工程 JSON 里的 /media/live/... 由它提供）。
     想把整站默认切到 Cloudflare R2（或任何自建镜像），把下面这行改成公开域名即可，例如
     var MEDIA_BASE_DEFAULT = "https://pub-xxxxxxx.r2.dev";                     */
  var MEDIA_BASE_DEFAULT = "";
  var OFFICIAL_MEDIA_BASE = "https://uma.0xcjy.top/";
  function mediaBaseDefault() { return MEDIA_BASE_DEFAULT || OFFICIAL_MEDIA_BASE; }

  var MEDIA_DETAIL_PREFIX = "data/live/music/";   // 详情里的路径 → 媒体 URL 的映射前缀
  var MEDIA_URL_PREFIX = "/media/live/";
  var SLOT_ORDER = ["center", "left", "left2", "left3", "right", "right2", "right3"];

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function linToDb(x) { return x <= 0 ? SILENT_DB : 20 * Math.log10(x); }
  function dbToLin(db) { return db <= SILENT_DB ? 0 : Math.pow(10, db / 20); }

  /** 详情 JSON 里的媒体路径 → 站点媒体 URL。'data/live/music/1001/bgm_01_0.mp3' → '/media/live/1001/bgm_01_0.mp3' */
  function mediaUrlFromDetailPath(p) {
    if (!p) return null;
    var s = String(p).replace(/^\/+/, "");
    if (s.indexOf(MEDIA_DETAIL_PREFIX) === 0) return MEDIA_URL_PREFIX + s.slice(MEDIA_DETAIL_PREFIX.length);
    // 兜底：站点其它静态目录（封面等）原样返回相对路径
    return s;
  }

  /** 该曲实际使用的槽位（按 parts 中首次出现顺序，过滤掉全程 waveIndex=null 的槽） */
  function slotsOfSong(detail) {
    var seen = {}, out = [];
    (detail.parts || []).forEach(function (p) {
      (p.slots || []).forEach(function (s) {
        if (s.waveIndex !== null && s.waveIndex !== undefined && !seen[s.slot]) {
          seen[s.slot] = 1; out.push(s.slot);
        }
      });
    });
    return out;
  }

  /** 某槽在该曲中用到的声部（waveIndex，升序） */
  function wavesOfSlot(detail, slot) {
    var w = {};
    (detail.parts || []).forEach(function (p) {
      (p.slots || []).forEach(function (s) {
        if (s.slot === slot && s.waveIndex !== null && s.waveIndex !== undefined) w[s.waveIndex] = 1;
      });
    });
    return Object.keys(w).map(Number).sort(function (a, b) { return a - b; });
  }

  function characterById(detail, charaId) {
    return (detail.characters || []).find(function (c) { return c.charaId === Number(charaId); }) || null;
  }

  function characterName(c) {
    if (!c) return "未知角色";
    return c.nameZh || c.nameJa || c.nameEn || ("chara " + c.charaId);
  }

  /** 副标题（日文名优先，供下拉第二行显示） */
  function characterSubName(c) {
    if (!c) return "";
    var zh = c.nameZh;
    if (c.nameJa && c.nameJa !== zh) return c.nameJa;
    if (c.nameEn && c.nameEn !== zh) return c.nameEn;
    return "";
  }

  /** 角色搜索匹配：中文名 / 日文名 / 英文名 / charaId 子串 */
  function matchCharacter(c, q) {
    if (!q) return true;
    var s = String(q).trim().toLowerCase();
    if (!s) return true;
    if (String(c.charaId).indexOf(s) >= 0) return true;
    var ja = (c.nameJa || "").toLowerCase();
    var zh = (c.nameZh || "").toLowerCase();
    var en = (c.nameEn || "").toLowerCase();
    if (zh.indexOf(s) >= 0 || ja.indexOf(s) >= 0 || en.indexOf(s) >= 0) return true;
    // 打平假名/片假名差异，便于用片假名或平假名搜索
    var kana = function (t) {
      return t.replace(/[\u30a1-\u30f6]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0x60);
      });
    };
    return kana(ja).indexOf(kana(s)) >= 0;
  }

  /** 该角色在本曲可用的声部（waves 数组），仅保留歌曲实际用到的 */
  function wavesForCharacter(detail, slot, charaId) {
    var c = characterById(detail, charaId);
    if (!c) return [];
    var used = wavesOfSlot(detail, slot);
    var have = (c.waves || []).map(function (w) { return w.waveIndex; });
    return used.filter(function (w) { return have.indexOf(w) >= 0; });
  }

  /** 默认选角：站点规则 —— 第 i 个槽位用 characters[i % characters.length] */
  function defaultCast(detail) {
    var ch = detail.characters || [];
    if (!ch.length) return [];
    return slotsOfSong(detail).map(function (slot, i) {
      return [slot, ch[i % ch.length].charaId];
    });
  }

  function partAt(parts, tMs) {
    var cur = parts[0] || null;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].timeMs <= tMs) cur = parts[i]; else break;
    }
    return cur;
  }

  function slotEntry(part, slot) {
    if (!part) return null;
    return (part.slots || []).find(function (s) { return s.slot === slot; }) || null;
  }

  /** 该 part 中「已选槽位里处于激活状态」的数量 —— 平衡补偿因子 N^(-1/3) 的 N */
  function activeCount(part, castSlots) {
    var n = 0;
    castSlots.forEach(function (slot) {
      var e = slotEntry(part, slot);
      if (e && e.waveIndex !== null && e.waveIndex !== undefined) n++;
    });
    return n;
  }

  /** 平衡补偿因子：balance 打开时 1/N^(1/3)，否则 1 */
  function balanceFactor(n, balance) {
    if (!balance || !n) return 1;
    return Math.pow(n, -1 / 3);
  }

  /** part 里某槽的线性音量（999 = 默认 = 1；服务端不设上限，实测存在 1.02/1.03） */
  function slotVolumeLin(part, slot) {
    var e = slotEntry(part, slot);
    if (!e) return 0;
    var v = e.volume;
    if (v === 999 || v === null || v === undefined) v = 1;
    var x = Number(v);
    return (isFinite(x) && x > 0) ? x : 0;
  }

  /** part 里某槽的声像（999 = 默认 = 0） */
  function slotPan(part, slot) {
    var e = slotEntry(part, slot);
    if (!e) return 0;
    var p = e.pan;
    if (p === 999 || p === null || p === undefined) p = 0;
    return clamp(Number(p) || 0, -1, 1);
  }

  /**
   * 生成某条 (slot, wave) 轨道的自动化曲线。
   * 返回 [{timeMs, volumeDb}] / [{timeMs, panner}]，与官方 API 语义等价的分段常值函数。
   */
  function buildAutomation(detail, castSlots, balance, slot, wave, kind) {
    var parts = (detail.parts || []).slice().sort(function (a, b) { return a.timeMs - b.timeMs; });
    var out = [];
    var prev = null;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var e = slotEntry(p, slot);
      var active = !!(e && (e.waveIndex === wave));
      var v;
      if (kind === "volumeDb") {
        var lin = active ? slotVolumeLin(p, slot) * balanceFactor(activeCount(p, castSlots), balance) : 0;
        v = linToDb(lin);
      } else {
        v = active ? slotPan(p, slot) : 0;
      }
      if (prev === null || Math.abs(v - prev) > 1e-12) {
        out.push(kind === "volumeDb" ? { timeMs: p.timeMs, volumeDb: v } : { timeMs: p.timeMs, panner: v });
        prev = v;
      }
    }
    if (!out.length) out.push(kind === "volumeDb" ? { timeMs: 0, volumeDb: SILENT_DB } : { timeMs: 0, panner: 0 });
    return out;
  }

  /** 求分段常值函数在 tMs 处的值 */
  function evalAutomation(arr, tMs, key, fallback) {
    if (!arr || !arr.length) return fallback;
    var v = fallback;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].timeMs <= tMs) v = arr[i][key]; else break;
    }
    return v;
  }

  /**
   * 生成混音工程 JSON（字段与官方 API 一致）。
   * opts: {detail, bgmId, cast:[[slot,charaId]...], balance:bool, durationMs:number|null, streams:{...}}
   *
   * streams：该曲的文件组样本数（web/data/live/streams.json 里的一首，形如 {bgm_01: 7448832, w0: 7372800}）
   * samples：该曲逐角色的真实样本数（web/data/live/media-samples.json 里的一首，形如 {"chara_1014:w0": 5406336}）。
   *          实测有曲子（1027、1154）**不同角色的同一 wave 长度不同**，所以逐角色值优先。
   * 查表顺序：samples["chara_<id>:w<n>"] → samples["bgm_<id>"] / streams[组] → 按 durationMs 反推。
   * 有了真值就能算出与官方一致的 durationMs（官方规则 = 返回轨道的最长者）。
   *
   * rates：该曲非 48000 Hz 的文件（web/data/live/media-rates.json 里的一首，形如 {"chara_1043:w0": 44100}）。
   *        实测确实存在 44100 Hz 的轨道文件，逐轨 sampleRate 与时长换算都要按各自的采样率。
   */
  function buildProject(opts) {
    var detail = opts.detail;
    var musicId = detail.musicId;
    var songSlots = slotsOfSong(detail);
    var cast = (opts.cast && opts.cast.length ? opts.cast : defaultCast(detail))
      .filter(function (kv) { return songSlots.indexOf(kv[0]) >= 0 && characterById(detail, kv[1]); });
    var castSlots = cast.map(function (kv) { return kv[0]; });
    var balance = !!opts.balance;

    var bgm = (detail.bgm || []).find(function (b) { return b.id === opts.bgmId; }) || (detail.bgm || [])[0];
    var sr = SAMPLE_RATE;
    var explicitDur = (opts.durationMs === undefined || opts.durationMs === null) ? null : Number(opts.durationMs);
    var streams = opts.streams || null;
    var samples = opts.samples || null;
    var rates = opts.rates || null;

    function num(v) { return (typeof v === "number" && isFinite(v) && v > 0) ? v : null; }
    /** 样本数查表：先逐角色（chara_<id>:w<n>），再文件组（bgm_xx / w<n>） */
    function groupCount(group, charaId, wave) {
      if (samples) {
        var per = num(samples["chara_" + charaId + ":w" + wave]);
        if (per !== null) return per;
        var bgmPer = /^bgm/.test(group) ? num(samples[group]) : null;
        if (bgmPer !== null) return bgmPer;
      }
      if (streams) {
        var g = num(streams[group]);
        if (g !== null) return g;
      }
      return null;
    }
    function countOf(t) { return t.stream.decodedSampleCount; }
    function musicMs(t) {
      var s = t.stream;
      return (s.decodedSampleCount - s.encoderDelaySamples - s.encoderPaddingSamples) / s.sampleRate * 1000;
    }

    /** 该文件的采样率（默认 48000；实测有个别 44100 的文件） */
    function rateOf(group, charaId, wave) {
      if (rates) {
        if (charaId !== null && charaId !== undefined) {
          var r = Number(rates["chara_" + charaId + ":w" + wave]);
          if (isFinite(r) && r > 0) return r;
        }
        var r2 = Number(rates[group]);
        if (isFinite(r2) && r2 > 0) return r2;
      }
      return sr;
    }
    function streamOf(media, group, charaId, wave) {
      var trackSr = rateOf(group, charaId, wave);
      var n = groupCount(group, charaId, wave);
      if (n === null && explicitDur) n = Math.round(explicitDur / 1000 * trackSr) + ENCODER_DELAY + ENCODER_PADDING;
      var s = {
        codec: "mp3", container: "mp3", sampleRate: trackSr, channels: 2,
        decodedSampleCount: n,
        encoderDelaySamples: ENCODER_DELAY, encoderPaddingSamples: ENCODER_PADDING,
        seekIndex: null
      };
      if (media && media.indexOf(MEDIA_URL_PREFIX) === 0) {
        s.seekIndex = "/media/live-index/" + media.slice(MEDIA_URL_PREFIX.length) + ".sidx";
      }
      return s;
    }

    var tracks = [];
    if (bgm) {
      var bmedia = mediaUrlFromDetailPath(bgm.path);
      tracks.push({
        id: "bgm", name: "BGM", media: bmedia, stream: streamOf(bmedia, bgm.id, null, null),
        timelineStartSample: 0, volumeDb: linToDb(DEFAULT_GAIN), panner: 0,
        muted: false, solo: false, startOffsetMs: 0, dynamics: null,
        volumeAutomation: [], pannerAutomation: []
      });
    }

    var k = 0;
    cast.forEach(function (kv) {
      var slot = kv[0], charaId = Number(kv[1]);
      var c = characterById(detail, charaId);
      wavesForCharacter(detail, slot, charaId).forEach(function (w) {
        var wp = null;
        ((c && c.waves) || []).forEach(function (x) { if (x.waveIndex === w) wp = x.path; });
        var media = mediaUrlFromDetailPath(wp) || (MEDIA_URL_PREFIX + musicId + "/chara_" + charaId + "/chara_" + w + ".mp3");
        var volAuto = buildAutomation(detail, castSlots, balance, slot, w, "volumeDb");
        var panAuto = buildAutomation(detail, castSlots, balance, slot, w, "panner");
        tracks.push({
          id: "voice-" + (k++),
          name: slot + " " + characterName(c) + " wave " + w,
          media: media, stream: streamOf(media, "w" + w, charaId, w),
          timelineStartSample: 0,
          volumeDb: evalAutomation(volAuto, 0, "volumeDb", SILENT_DB),
          panner: evalAutomation(panAuto, 0, "panner", 0),
          muted: false, solo: false, startOffsetMs: 0, dynamics: null,
          volumeAutomation: volAuto, pannerAutomation: panAuto
        });
      });
    });

    // 时长：优先显式值；否则若各轨样本数已知，按官方规则取「返回轨道的最长者」
    var durMs = explicitDur;
    if (durMs === null && tracks.length && tracks.every(function (t) { return countOf(t) !== null; })) {
      durMs = Math.round(Math.max.apply(null, tracks.map(musicMs)));
    }

    return {
      id: "live-" + musicId,
      name: "Live " + musicId,
      durationMs: durMs,
      sampleRate: sr,
      tracks: tracks,
      // 非官方字段：便于工具链回溯本次选择（官方客户端会忽略未知字段）
      _uma: { source: "uma-live-studio", musicId: musicId, bgm: bgm ? bgm.id : null, slots: cast, balance: balance }
    };
  }

  /** 依据角色选择生成该工程涉及的全部媒体 URL */
  function mediaUrlsOfProject(project) {
    return (project.tracks || []).map(function (t) { return t.media; }).filter(Boolean);
  }

  /** 按官方语义把工程转成「请求 URL」（用于需要直接调官方 API 时） */
  function projectQueryUrl(base, musicId, cast, bgmId, balance) {
    var params = new URLSearchParams();
    params.set("musicId", String(musicId));
    params.set("bgm", bgmId || "none");
    params.set("slots", JSON.stringify(cast.map(function (kv) { return [kv[0], Number(kv[1])]; })));
    params.set("balance", balance ? "1" : "0");
    return base.replace(/\/+$/, "") + "/api/live/mixer/projects/live-" + musicId + "?" + params.toString();
  }

  /** 导出文件名：UMA_live-1001_うまぴょい伝説_[center特别周+left无声铃鹿]_bgm_01 */
  function exportBaseName(detail, cast, bgmId) {
    var t = detail.title || {};
    var title = (t.zh || t.ja || ("Live " + detail.musicId)).replace(/[\\/:*?"<>|]/g, "_");
    var castStr = cast.map(function (kv) {
      return kv[0] + characterName(characterById(detail, kv[1]));
    }).join("+") || "noVocal";
    return "UMA_live-" + detail.musicId + "_" + title + "_[" + castStr + "]_" + (bgmId || "none");
  }

  return {
    SILENT_DB: SILENT_DB, SAMPLE_RATE: SAMPLE_RATE,
    ENCODER_DELAY: ENCODER_DELAY, ENCODER_PADDING: ENCODER_PADDING,
    DEFAULT_GAIN: DEFAULT_GAIN, SLOT_ORDER: SLOT_ORDER,
    mediaUrlFromDetailPath: mediaUrlFromDetailPath,
    slotsOfSong: slotsOfSong, wavesOfSlot: wavesOfSlot, wavesForCharacter: wavesForCharacter,
    characterById: characterById, characterName: characterName, defaultCast: defaultCast,
    characterSubName: characterSubName, matchCharacter: matchCharacter,
    partAt: partAt, slotEntry: slotEntry, activeCount: activeCount, balanceFactor: balanceFactor,
    slotVolumeLin: slotVolumeLin, slotPan: slotPan,
    buildAutomation: buildAutomation, evalAutomation: evalAutomation,
    buildProject: buildProject, mediaUrlsOfProject: mediaUrlsOfProject,
    projectQueryUrl: projectQueryUrl, exportBaseName: exportBaseName,
    linToDb: linToDb, dbToLin: dbToLin,
    mediaBaseDefault: mediaBaseDefault, MEDIA_BASE_DEFAULT: MEDIA_BASE_DEFAULT
  };
});
