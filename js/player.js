/* UMA Live Studio · 播放器：从原混音器页面移植过来，内嵌在生成器页里
   裁剪编码延迟/尾填充、压缩器按需求常开（不再有开关）。 */
(function(){
"use strict";
"use strict";
const $=id=>document.getElementById(id);
const C=window.UmaCore;
const logEl=$("log");
let project=null, baseUrl="";
const TRIM=true, COMPRESS=true;   // 按需求常开：裁剪编码延迟/尾填充、压缩器
let sampleRate=48000, durationSec=0, buffers=new Map();
let audioCtx=null, graph=[], masterGain=null, compressor=null;
const BASE_GAIN=0.9;                     // 与工程渲染同基准（导出仍用这个值，音量条只影响试听）
// 注意 Number(null)===0：没存过音量时若照算会变成 0%（静音）
let volPct=(()=>{const raw=localStorage.getItem("uma.volume");const v=raw===null?NaN:Number(raw);return Number.isFinite(v)&&v>=0&&v<=100?v:100})();
/** 进度条已播放段：把当前比例写进 CSS 变量（轨道用渐变填充） */
function paintSeek(v){
  const sk=$("seek");if(!sk||!Number(sk.max))return;
  const x=Math.max(0,Math.min(1,(v==null?Number(sk.value):Number(v))/Number(sk.max)));
  sk.style.setProperty("--seekPct",(x*100).toFixed(3)+"%");
}
function applyVolume(){
  if(masterGain)masterGain.gain.value=BASE_GAIN*volPct/100;
  const t=$("volVal");if(t)t.textContent=volPct+"%";
  paintSeek();
  const sl=$("vol");
  if(sl){
    if(Number(sl.value)!==volPct)sl.value=String(volPct);
    sl.style.setProperty("--volPct",volPct+"%");   // 轨道已填充部分跟着滑动
  }
}
// 调试/测试钩子：真机探针读它验证音量条真的写进了 masterGain（let 不会挂到 window 上）
window.__umaMixer={getGain:()=>masterGain?masterGain.gain.value:null,getVol:()=>volPct};
/** 播放状态胶囊：状态存 data-s（着色用），文案用中文 */
function setState(key,label){const el=$("state");if(!el)return;el.dataset.s=key;el.textContent=label}
/** dB 显示：小数最多 2 位、四舍五入（工程 JSON 里仍保留原值） */
function fmtDb(v){const n=Number(v);const r=Math.round((Number.isFinite(n)?n:0)*100)/100;return (Object.is(r,-0)?0:r)+" dB"}
/** 从轨道名 "center 特别周 wave 0" 解析出站位/角色/音轨号；BGM 行没有这些 */
function parseTrack(t){
  const name=String(t.name||t.id||"");
  const m=/^(\S+)\s+(.+?)\s+wave\s+(\d+)$/.exec(name);
  if(m)return{slot:m[1],role:m[2],wave:m[3]};
  const mm=/chara_(\d+)\/chara_(\d+)\.mp3/.exec(String(t.media||""));
  if(mm)return{slot:"—",role:"chara "+mm[1],wave:mm[2]};
  if(t.id==="bgm"||/^bgm/i.test(name))return{slot:"—",role:"伴奏",wave:"—"};
  return{slot:"—",role:name||"—",wave:"—"};
}
/** 站位中文名（与生成器口径一致；解析仍按英文 id，只有显示走这里） */
const SLOT_ZH={center:"主唱角色",left:"左侧伴唱",right:"右侧伴唱",left2:"左副伴唱",right2:"右副伴唱",left3:"左副伴唱2",right3:"右副伴唱2"};
let startedAt=0, pausedAt=0, raf=0;

function log(s){const t=new Date().toLocaleTimeString();logEl.textContent+="["+t+"] "+s+"\n";logEl.scrollTop=logEl.scrollHeight}
function fmt(x){x=Math.max(0,Number(x)||0);const m=Math.floor(x/60),s=x-m*60;return String(m).padStart(2,"0")+":"+s.toFixed(3).padStart(6,"0")}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}

/* ---------- JSON 加载 ---------- */
/* 说明：工程只从生成器的「送入混音器」直送（localStorage）来，
   原先「填 URL 拉取 / 粘贴 JSON」那套网络加载已按需求移除。 */

/* ---------- 媒体解析 ---------- */
function isAbs(u){return /^(https?:|blob:|data:)/i.test(u)}
/** 展示用：不把外链地址原样摆出来（日志/悬停都走它）。真实请求仍用解码后的地址。 */
function maskUrl(u){
  if(!u)return "";
  try{
    const x=new URL(u,location.href);
    const rel=x.pathname.replace(/^\/+/,"");
    return x.origin===location.origin?rel:(rel+"  ←  默认媒体源");
  }catch{return "（不可解析的地址）"}
}
function resolveMedia(raw){
  if(!raw)return null;
  raw=String(raw).trim();
  if(isAbs(raw))return raw;                                     // ① 绝对 URL 直接用
  if(baseUrl)return new URL(raw,baseUrl).href;                  // ② 直送时带来的媒体基址优先
  try{return new URL(raw,C.mediaBaseDefault()).href}catch{}      // ③ 默认媒体基址（Cloudflare R2）
  return raw;
}
/** 备用候选：把工程里的媒体路径挂到默认/手填基址上取一次同样的文件。
 *  t.media 可能是绝对地址，必须先取 pathname，否则拼出 base+https://… 这种垃圾 URL。 */
function sinkIndex(t){
  var m=String(t.media||"");
  try{ if(/^[a-z][a-z0-9+.-]*:\/\//i.test(m)) m=new URL(m).pathname; }catch(e){}
  return m.replace(/^\/+/,"");
}

/* ---------- 校准裁剪 ---------- */
function trimPlan(buffer,stream){
  const delay=(stream&&stream.encoderDelaySamples)||C.ENCODER_DELAY;
  const pad=(stream&&stream.encoderPaddingSamples)||C.ENCODER_PADDING;
  if(!TRIM)return{head:0,tail:0};
  const durSamples=project.durationMs?project.durationMs/1000*buffer.sampleRate:null;
  if(durSamples){
    const untrimmed=Math.abs(buffer.length-durSamples)<=2;
    const already=Math.abs(buffer.length-1-(durSamples-delay-pad))<=2;
    if(already&&!untrimmed){log("  浏览器已自动去 gapless 填充，本次跳过裁剪");return{head:0,tail:0}}
  }
  // 官方 decodedSampleCount 按 MP3 整帧计（帧数×1152），浏览器解码会丢掉编码首尾填充：
  // 实测各曲差 2643~3042 采样（55~63 ms），属正常现象，且不影响裁剪口径，故不再打印提示。
  return{head:delay,tail:pad};
}
async function decodeAudio(ctx,url,stream,retry=3){
  let lastErr=null;
  for(let k=0;k<retry;k++){
    try{
      const r=await fetch(url,{cache:"force-cache"});
      if(!r.ok)throw new Error("HTTP "+r.status);
      let b=await ctx.decodeAudioData(await r.arrayBuffer());
      const p=trimPlan(b,stream);
      if((p.head||p.tail)&&b.length>p.head+p.tail){
        const x=ctx.createBuffer(b.numberOfChannels,b.length-p.head-p.tail,b.sampleRate);
        for(let c=0;c<b.numberOfChannels;c++)
          x.getChannelData(c).set(b.getChannelData(c).subarray(p.head,b.length-p.tail));
        b=x;
      }
      if(b.numberOfChannels!==2){
        const x=ctx.createBuffer(2,b.length,b.sampleRate);
        const L=b.getChannelData(0),R=b.numberOfChannels>1?b.getChannelData(1):L;
        x.getChannelData(0).set(L);x.getChannelData(1).set(R);b=x;
      }
      return b;
    }catch(e){lastErr=e;await new Promise(r=>setTimeout(r,400*(k+1)))}
  }
  throw lastErr||new Error("decode failed");
}
async function fetchFirstOk(urls,stream,ctx){
  let err=null;
  for(const u of urls){
    try{return await decodeAudio(ctx,u,stream)}catch(e){err=e;log("    "+maskUrl(u)+" 失败："+e.message)}
  }
  throw err||new Error("no candidate");
}

/* ---------- 预加载 ---------- */
async function preload(){
  const ctx=new AudioContext({sampleRate});
  const list=project.tracks;
  let ok=0, done=0;
  const concurrency=4;
  let idx=0;
  async function worker(){
    while(idx<list.length){
      const i=idx++, t=list[i];
      const rem=resolveMedia(t.media);
      const urls=[rem,(baseUrl||C.mediaBaseDefault())+sinkIndex(t)];
      const st=$("ts-"+i), rowEl=st?st.parentNode:null;
      if(rowEl)rowEl.title=maskUrl(urls[0])||t.media||"(无 URL)";
      try{
        if(!rem)throw new Error("没有可识别的音频 URL");
        st.textContent="载入中";
        const b=await fetchFirstOk(urls.filter(Boolean),t.stream,ctx);
        buffers.set(t.id,b);ok++;
        st.textContent=b.duration.toFixed(3)+" s"+(t.stream&&t.stream.sampleRate!==b.sampleRate?" (⚠ "+b.sampleRate+"Hz)":"");
        st.className="small ok dur";
      }catch(e){
        st.textContent="失败";st.className="small err dur";
        if(rowEl)rowEl.title=e.message+" · 尝试："+maskUrl(urls[0]);   // 链接不显示，错误靠悬停看
        log("轨道 "+t.id+"（"+t.name+"）："+e.message);
      }
      done++;$("loaded").textContent=ok+" / "+list.length+" 条";
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,list.length)},worker));
  // 依据实测长度校准工程时长（官方 durationMs = 各轨最长者）
  let maxLen=0;
  buffers.forEach(b=>{if(b.length>maxLen)maxLen=b.length});
  const measured=maxLen/sampleRate;
  if(measured>0&&Math.abs(measured-durationSec)>0.004){
    log("实测最长轨 "+maxLen+" 个采样 = "+measured.toFixed(3)+" 秒；工程声明 "+durationSec.toFixed(3)+" 秒");
    durationSec=measured;$("dur").textContent=fmt(durationSec);$("total").textContent=fmt(durationSec);$("seek").max=durationSec;
  }
  await ctx.close();
  log("音频预载完成："+ok+" / "+list.length+" 轨");
}

/* ---------- 加载工程 ---------- */
function validateProject(p){
  if(!p||typeof p!=="object")throw new Error("不是 JSON object");
  if(!Array.isArray(p.tracks))throw new Error("没有 tracks[]");
  const sr=Number(p.sampleRate);
  if(!Number.isFinite(sr)||sr<=0)throw new Error("sampleRate 无效");
  const dur=Number(p.durationMs);
  if(!Number.isFinite(dur)||dur<=0)log("⚠ 工程 durationMs 无效（"+p.durationMs+"），将完全依赖实测音频长度");
  return{sr,dur:Number.isFinite(dur)&&dur>0?dur:0};
}
function keepOrphans(p){
  // 没有 durationMs 时用 0，preload 后会用实测值覆盖
  return Object.assign({},p,{durationMs:p.durationMs||0});
}
async function loadProject(p){
  $("summary").style.display=$("player").style.display=$("tracksCard").style.display="none";
    $("lyricsCard").style.display="none";
  buffers.clear(); disconnectGraph();
  try{
    project = p;
    if(!baseUrl&&C.mediaBaseDefault()){const mb=C.mediaBaseDefault();baseUrl=mb.endsWith("/")?mb:mb+"/";}
    log("开始处理工程："+(project.id||"?")+"（"+(project.tracks||[]).length+" 轨）");
    project=keepOrphans(project);
    const meta=validateProject(project);
    setState("ready","准备就绪");
    sampleRate=meta.sr; durationSec=meta.dur/1000;

    $("sr").textContent=sampleRate+" Hz";
    $("dur").textContent=durationSec?fmt(durationSec):"实测";
    $("count").textContent=project.tracks.length+" 条";
    $("loaded").textContent="0 / "+project.tracks.length+" 条";
    /* 平衡补偿：工程里是 1/0，这里直接显示 开/关 */
    $("mixBalance").textContent=(()=>{
      let v;
      if(project._uma)v=project._uma.balance?"1":"0";
      else v=String(project.balance??"");
      return v==="1"?"开":v==="0"?"关":"—";
    })();
    $("total").textContent=durationSec?fmt(durationSec):"--:--";
    $("seek").max=durationSec||1;$("seek").value=0;
    $("summary").style.display=$("player").style.display=$("tracksCard").style.display="";

    const box=$("tracks");box.innerHTML="";
    const head=document.createElement("div");head.className="track-head";
    head.innerHTML="<div>序号</div><div>角色</div><div>音轨</div><div>站位</div><div>时长</div><div>增益</div>";
    box.appendChild(head);
    project.tracks.forEach((t,i)=>{
      const el=document.createElement("div");el.className="track";
      const pt=parseTrack(t);
      el.innerHTML="<div class='idx'>"+(i+1)+"</div>"+
        "<div class='role' title='"+esc(t.name||t.id||"")+"'>"+esc(pt.role)+"</div>"+
        "<div class='wave'>"+esc(pt.wave)+"</div>"+
        "<div class='slot'>"+esc(SLOT_ZH[pt.slot]||pt.slot)+"</div>"+
        "<div class='dur small' id='ts-"+i+"'>载入中</div>"+
        "<div class='db'>"+esc(fmtDb(t.volumeDb??0))+"</div>";
      el.title=t.media||"";   // 链接不显示在表格里，鼠标悬停可见
      box.appendChild(el);
    });

    log("工程："+project.tracks.length+" 轨 / "+sampleRate+" Hz / "+(durationSec?durationSec.toFixed(3)+" 秒":"时长待实测"));
    await preload();
    $("lyricsCard").style.display="";
    await loadLyrics();
  }catch(e){log("错误："+(e.stack||e));alert(e.message||String(e))}
  finally{}
}

/* ---------- 混音图 ---------- */
function schedule(param,pts,map,maxT,smooth){
  param.cancelScheduledValues(0);
  if(!pts.length)return;
  param.setValueAtTime(map(pts[0].v),0);
  for(let i=1;i<pts.length;i++){
    const t=Math.min(maxT,Math.max(0,pts[i].t));
    if(smooth&&t>0)param.setTargetAtTime(map(pts[i].v),t,0.008);
    else param.setValueAtTime(map(pts[i].v),t);
  }
}
function series(arr,key,fallback){
  const a=[{t:0,v:Number(fallback)||0}];
  (arr||[]).forEach(f=>a.push({t:Math.max(0,Number(f.timeMs)||0)/1000,v:Number(f[key]??fallback)}));
  a.sort((x,y)=>x.t-y.t);
  const out=[];
  for(const x of a){if(out.length&&Math.abs(out[out.length-1].t-x.t)<1e-12)out[out.length-1]=x;else out.push(x)}
  return out;
}
function dbGain(db){return db<=-60?0:Math.pow(10,db/20)}
function anySolo(){return project.tracks.some(t=>t.solo)}

function createTrackGraph(ctx,b,t,maxT,smooth){
  const startOffsetSec=((Number(t.startOffsetMs)||0)+(Number(t.timelineStartSample)||0)/sampleRate*1000)/1000;
  const src=ctx.createBufferSource();src.buffer=b;
  const tg=ctx.createGain();
  const pan=ctx.createStereoPanner?ctx.createStereoPanner():null;
  const user=ctx.createGain();
  user.gain.value=(t.muted||(anySolo()&&!t.solo))?0:1;

  const vp=series(t.volumeAutomation,"volumeDb",t.volumeDb??0);
  const pp=series(t.pannerAutomation,"panner",t.panner??0);
  schedule(tg.gain,vp,dbGain,maxT,smooth);

  if(pan){ schedule(pan.pan,pp,x=>Math.max(-1,Math.min(1,x)),maxT,smooth); src.connect(tg).connect(pan).connect(user); }
  else { src.connect(tg).connect(user); }
  return{src,last:user,nodes:[tg,pan,user].filter(Boolean),startOffsetSec};
}

function disconnectGraph(){
  for(const g of graph){try{g.src.stop()}catch{}for(const n of g.nodes)try{n.disconnect()}catch{}}
  graph=[];
}
async function ensureRealtime(){
  if(audioCtx)return;
  audioCtx=new AudioContext({sampleRate});
  masterGain=audioCtx.createGain();masterGain.gain.value=BASE_GAIN*volPct/100;
  if(COMPRESS){
    compressor=audioCtx.createDynamicsCompressor();
    compressor.threshold.value=-14;compressor.knee.value=18;compressor.ratio.value=3;
    compressor.attack.value=.01;compressor.release.value=.2;
    masterGain.connect(compressor);compressor.connect(audioCtx.destination);
  }else masterGain.connect(audioCtx.destination);
}
/* ---------- 歌词 / WAV 编码（从原混音器脚本搬过来） ---------- */
async function loadLyrics(){
  lyricLines=[];lyricIdx=-1;
  const box=$("lyrics");box.innerHTML="";
  const id=musicIdOf();
  if(!id){box.innerHTML='<div class="small">这份工程里没有曲目 id，无法匹配歌词</div>';return}
  let data=null;
  for(const url of ["data/live/songs/"+id+".json","https://uma.0xcjy.top/data/live/songs/"+id+".json"]){
    try{const r=await fetch(url,{cache:"force-cache"});if(r.ok){data=await r.json();break}}catch{}
  }
  const ly=data&&data.lyrics;
  if(!ly||!Object.keys(ly).length){
    box.innerHTML='<div class="small">曲目 '+esc(id)+' 没有歌词资料</div>';
    log("歌词：曲目 "+id+" 无资料");return;
  }
  lyricLines=Object.keys(ly).map(Number).filter(n=>Number.isFinite(n)).sort((a,b)=>a-b).map(ms=>{
    const parts=String(ly[ms]).split("\n");
    return {ms:ms,ja:parts[0]||"",zh:parts[1]||""};
  });
  box.innerHTML=lyricLines.map((l,i)=>'<p data-i="'+i+'"><span class="txt"><span class="ja">'+esc(l.ja)+'</span>'
    +(l.zh?'<span class="zh">'+esc(l.zh)+'</span>':"")+'</span><span class="t">'+fmt(l.ms/1000)+'</span></p>').join("");
  box.querySelectorAll("p").forEach(el=>{
    el.onclick=()=>{const l=lyricLines[Number(el.dataset.i)];if(l&&durationSec>0)seekTo(l.ms/1000)};
  });
  $("lyricsStat").textContent="—";
  log("歌词已载入："+lyricLines.length+" 行（点击任一行可跳到该句）");
}
function audioBufferToWav(ab,to16){
  const ch=2,sr=ab.sampleRate,n=ab.length;
  if(to16){
    const data=n*ch*2,out=new ArrayBuffer(44+data),d=new DataView(out);
    const w=(o,s)=>{for(let i=0;i<s.length;i++)d.setUint8(o+i,s.charCodeAt(i))};
    w(0,"RIFF");d.setUint32(4,36+data,true);w(8,"WAVE");w(12,"fmt ");
    d.setUint32(16,16,true);d.setUint16(20,1,true);d.setUint16(22,ch,true);
    d.setUint32(24,sr,true);d.setUint32(28,sr*ch*2,true);d.setUint16(32,ch*2,true);d.setUint16(34,16,true);
    w(36,"data");d.setUint32(40,data,true);
    const L=ab.getChannelData(0),R=ab.getChannelData(1);let p=44;
    const enc=v=>{const x=Math.max(-1,Math.min(1,v));return x<0?x*0x8000:x*0x7FFF};
    for(let i=0;i<n;i++){d.setInt16(p,enc(L[i]),true);p+=2;d.setInt16(p,enc(R[i]),true);p+=2}
    return out;
  }
  const data=n*ch*4,out=new ArrayBuffer(44+data),d=new DataView(out);
  const w=(o,s)=>{for(let i=0;i<s.length;i++)d.setUint8(o+i,s.charCodeAt(i))};
  w(0,"RIFF");d.setUint32(4,36+data,true);w(8,"WAVE");w(12,"fmt ");
  d.setUint32(16,16,true);d.setUint16(20,3,true);d.setUint16(22,ch,true);
  d.setUint32(24,sr,true);d.setUint32(28,sr*ch*4,true);d.setUint16(32,ch*4,true);d.setUint16(34,32,true);
  w(36,"data");d.setUint32(40,data,true);
  const L=ab.getChannelData(0),R=ab.getChannelData(1);let p=44;
  for(let i=0;i<n;i++){d.setFloat32(p,L[i],true);p+=4;d.setFloat32(p,R[i],true);p+=4}
  return out;
}

function position(){if(!audioCtx)return pausedAt;return Math.min(durationSec,pausedAt+(audioCtx.currentTime-startedAt))}
function tick(){
  const p=position();
  $("current").textContent=fmt(p);
  if(document.activeElement!==$("seek"))$("seek").value=p;
  paintSeek(p);
  syncLyrics(p);
  if(p>=durationSec-.002&&audioCtx?.state==="running"){pausePlayback();pausedAt=durationSec}
  raf=requestAnimationFrame(tick);
}
async function playPlayback(){
  if(!project)return alert("先加载工程");
  if(!buffers.size)return alert("没有成功加载音频");
  await ensureRealtime();disconnectGraph();
  const start=Math.min(durationSec,Math.max(0,pausedAt));
  const when=audioCtx.currentTime+.05;
  const smooth=true;   // 自动化 8ms 平滑固定开启（官方为阶跃，平滑只影响听感不改变增益数学）
  for(const t of project.tracks){
    const b=buffers.get(t.id);
    if(!b)continue;
    const g=createTrackGraph(audioCtx,b,t,durationSec,smooth);
    g.last.connect(masterGain);graph.push(g);
    const off=start-g.startOffsetSec;
    if(off<0){ try{g.src.start(when-off,0)}catch(e){log("轨道 "+t.id+" 启动失败："+e.message)} continue; }
    if(off>=b.duration)continue;
    try{g.src.start(when,off)}catch(e){log("轨道 "+t.id+" 启动失败："+e.message)}
  }
  startedAt=when;pausedAt=start;
  await audioCtx.resume();
  setState("playing","播放中");$("play").disabled=true;
  cancelAnimationFrame(raf);tick();
}
async function pausePlayback(){
  if(!audioCtx)return;
  pausedAt=position();await audioCtx.suspend();disconnectGraph();
  setState("paused","已暂停");$("play").disabled=false;
}
function stopPlayback(){
  try{audioCtx?.suspend()}catch{}
  disconnectGraph();pausedAt=0;$("seek").value=0;$("current").textContent=fmt(0);
  setState("stopped","已停止");$("play").disabled=false;
}
async function seekTo(v){
  pausedAt=Math.max(0,Math.min(durationSec,Number(v)));
  $("current").textContent=fmt(pausedAt);
  paintSeek(pausedAt);
  syncLyrics(pausedAt);         // 拖动/点歌词后立即换高亮，不用等播放
  if(audioCtx?.state==="running")await playPlayback();
}

/* ---------- 导出 ---------- */
/* 渲染工程到 AudioBuffer（WAV 与 MP3 导出共用） */
async function renderProjectBuffer(){
  if(!project||!buffers.size)throw new Error("没有可渲染的工程");
  if(!(durationSec>0))throw new Error("时长未知");
  const frames=Math.ceil(durationSec*sampleRate);
  const off=new OfflineAudioContext(2,frames,sampleRate);
  const master=off.createGain();master.gain.value=.9;
  if(COMPRESS){
    const c=off.createDynamicsCompressor();
    c.threshold.value=-14;c.knee.value=18;c.ratio.value=3;c.attack.value=.01;c.release.value=.2;
    master.connect(c);c.connect(off.destination);
  }else master.connect(off.destination);

  const smooth=true;   // 同上：导出与实时播放口径一致
  let n=0;
  for(const t of project.tracks){
    const b=buffers.get(t.id);
    if(!b)continue;
    const g=createTrackGraph(off,b,t,durationSec,smooth);
    g.last.connect(master);
    if(g.startOffsetSec>0)g.src.start(g.startOffsetSec,0);else g.src.start(0);
    n++;
  }
  $("exportStatus").textContent="渲染 "+n+" 条轨道…";
  return await off.startRendering();
}
/* WAV 导出 */
async function renderOffline(){
  $("exportStatus").textContent="渲染…";
  const rendered=await renderProjectBuffer();
  $("exportStatus").textContent="编码 WAV…";
  const sixteen=$("wav16").checked;
  const blob=new Blob([audioBufferToWav(rendered,sixteen)],{type:"audio/wav"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=exportBaseName()+".wav";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  $("exportStatus").textContent="完成 "+(blob.size/1048576).toFixed(2)+" MB";
  log("已导出 WAV："+a.download+"（"+(blob.size/1048576).toFixed(2)+" MB，"+(sixteen?"16-bit PCM":"32-bit 浮点")+"）");
}
/* ---------- MP3（320 kbps CBR）导出 ---------- */
function floatToInt16(f){
  const n=f.length,out=new Int16Array(n);
  for(let i=0;i<n;i++){const v=f[i]<-1?-1:(f[i]>1?1:f[i]);out[i]=v<0?v*32768:v*32767}
  return out;
}
async function exportMp3(){
  if(typeof lamejs==="undefined"||!lamejs.Mp3Encoder)throw new Error("MP3 编码器未载入（js/lame.min.js）");
  const rendered=await renderProjectBuffer();
  const sr=rendered.sampleRate;
  const ch0=floatToInt16(rendered.getChannelData(0)),ch1=floatToInt16(rendered.getChannelData(1));
  const enc=new lamejs.Mp3Encoder(2,sr,320);          // 320 kbps CBR
  const step=1152*32,parts=[];
  for(let i=0;i<ch0.length;i+=step){
    const b=enc.encodeBuffer(ch0.subarray(i,i+step),ch1.subarray(i,i+step));
    if(b.length)parts.push(new Uint8Array(b));
    if((i/step)%8===0){
      $("exportStatus").textContent="编码 MP3 … "+Math.min(100,Math.round(i/ch0.length*100))+"%";
      await new Promise(r=>setTimeout(r,0));           // 让出主线程，进度能刷新
    }
  }
  const tail=enc.flush();if(tail.length)parts.push(new Uint8Array(tail));
  const blob=new Blob(parts,{type:"audio/mpeg"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=exportBaseName()+".mp3";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  $("exportStatus").textContent="完成 "+(blob.size/1048576).toFixed(2)+" MB";
  log("已导出 MP3："+a.download+"（"+(blob.size/1048576).toFixed(2)+" MB，320 kbps / "+sr+" Hz）");
}

/* ---------- 歌词 ---------- */
let lyricLines=[],lyricIdx=-1;
function syncLyrics(p){
  if(!lyricLines.length)return;
  let idx=-1;
  for(let i=0;i<lyricLines.length;i++){if(lyricLines[i].ms/1000<=p+0.02)idx=i;else break}
  if(idx===lyricIdx)return;
  const ps=$("lyrics").querySelectorAll("p");
  if(lyricIdx>=0&&ps[lyricIdx])ps[lyricIdx].classList.remove("active");
  lyricIdx=idx;
  if(idx>=0&&ps[idx]){
    ps[idx].classList.add("active");
    const box=$("lyrics"),el=ps[idx];
    // offsetTop 是相对「定位祖先」而非这个滚动容器（曾经因此整块跳到最底），
    // 所以用两者 rect 之差换算成容器内坐标。
    const top=el.getBoundingClientRect().top-box.getBoundingClientRect().top+box.scrollTop;
    const h=el.offsetHeight;
    if(top<box.scrollTop||top+h>box.scrollTop+box.clientHeight){
      box.scrollTop=Math.max(0,Math.min(top-box.clientHeight/2+h/2,box.scrollHeight-box.clientHeight));
    }
  }
  $("lyricsStat").textContent=idx>=0?(idx+1)+" / "+lyricLines.length:"—";
}
function exportBaseName(){
  try{
    const h=JSON.parse(localStorage.getItem("uma.handoff")||"null");
    if(h&&h.name)return h.name;
  }catch{}
  if(project&&project._uma&&project._uma.musicId)return "uma-live-"+project._uma.musicId;
  return "uma-render-"+Date.now();
}

function musicIdOf(){
  if(project&&project._uma&&project._uma.musicId)return project._uma.musicId;   // 生成器直送的工程
  if(project&&project.musicId)return project.musicId;
  if(project&&project.id){                                                     // 官方 API 的工程：id = live-1001
    const m=String(project.id).match(/live-(\d+)/);if(m)return m[1];
  }
  try{const m=new URLSearchParams(location.search).get("musicId");if(m)return m}catch{}
  return null;
}
/* ---------- 事件 ---------- */
$("vol").oninput=e=>{volPct=Math.max(0,Math.min(100,Number(e.target.value)||0));localStorage.setItem("uma.volume",String(volPct));applyVolume()};
applyVolume();
$("seek").oninput=e=>{pausedAt=Number(e.target.value);$("current").textContent=fmt(pausedAt)};
$("seek").onchange=e=>seekTo(e.target.value);

/* ---------- 事件与启动 ---------- */
let loadedProject=null;
/** 播放键：继承原「送入混音器」的职能——按当前选角生成工程，载入后直接播放 */
async function playOrBuild(){
  let p=null;
  try{ p = window.__umaBuildProject ? window.__umaBuildProject() : null; }catch(e){ log("取当前工程失败："+e.message); }
  if(!p){ log("还没有可播放的工程：请先在上方选曲与选角"); return; }
  if(p!==loadedProject){
    loadedProject=p;
    await loadProject(p);
    if(!project||!project.tracks||!project.tracks.length) return;
  }
  await playPlayback();
}
function bind(id,fn,ev){const el=document.getElementById(id);if(el)el.addEventListener(ev||"click",fn);}
bind("play",()=>void playOrBuild());
bind("pause",pausePlayback);
bind("vol",e=>{volPct=Math.max(0,Math.min(100,Number(e.target.value)||0));localStorage.setItem("uma.volume",String(volPct));applyVolume()},"input");
applyVolume();
bind("seek",e=>{pausedAt=Number(e.target.value);const c=document.getElementById("current");if(c)c.textContent=fmt(pausedAt);paintSeek(pausedAt)},"input");
bind("seek",e=>seekTo(e.target.value),"change");
bind("exportMp3",async()=>{
  const b=document.getElementById("exportMp3");if(b)b.disabled=true;
  try{await exportMp3()}catch(e){const s=document.getElementById("exportStatus");if(s)s.textContent="失败";log("导出失败："+(e.stack||e));}
  finally{if(b)b.disabled=false}
});
bind("export",async()=>{
  const b=document.getElementById("export");if(b)b.disabled=true;
  try{await renderOffline()}catch(e){const s=document.getElementById("exportStatus");if(s)s.textContent="失败";log("导出失败："+(e.stack||e));}
  finally{if(b)b.disabled=false}
});
window.__umaPlayer={load:(p)=>{loadedProject=p;return loadProject(p)},play:playPlayback,pause:pausePlayback,playOrBuild};
log("播放器 已就绪");
})();
