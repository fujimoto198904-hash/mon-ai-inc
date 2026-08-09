/* MON-AI Inc. — ドット絵AIオフィス エンジン v2 */
'use strict';

const CFG = window.OFFICE_CONFIG;
const W = 640, H = 360;
const cv = document.getElementById('office');
const cx = cv.getContext('2d');
cx.scale(4, 4);              // 内部解像度2560x1440、論理座標は640x360のまま
cx.imageSmoothingEnabled = false;

/* ---------- 閲覧トークン ---------- */
const viewToken = (location.hash.match(/v=([0-9a-f]+)/) || [])[1];
if (!viewToken) document.getElementById('gate').style.display = 'flex';
document.getElementById('mission').textContent = `ミッション「${CFG.mission}」`;

/* ---------- ライブ配信モード(9:16・URL末尾に &lv=1) ---------- */
const LIVE = /\blv=1\b/.test(location.hash);
if (LIVE) document.body.classList.add('live');

/* ---------- JST時刻 ---------- */
const jstFmt = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
function jstNow() {
  const p = {};
  for (const part of jstFmt.formatToParts(new Date())) p[part.type] = part.value;
  return {
    h: +p.hour === 24 ? 0 : +p.hour, m: +p.minute, s: +p.second,
    dateStr: `${p.month}/${p.day}(${p.weekday})`,
    hm: `${p.hour}:${p.minute}`,
    minOfDay: (+p.hour % 24) * 60 + +p.minute,
  };
}

/* ---------- キャンバススケール ---------- */
function fitCanvas() {
  if (LIVE) return;   // ライブモードは#stage非表示(カメラキャンバスに転写)
  const st = document.getElementById('stage');
  const aw = st.clientWidth - 12, ah = st.clientHeight - 12;
  const s = Math.min(aw / W, ah / H);
  cv.style.width = Math.round(W * s) + 'px';
  cv.style.height = Math.round(H * s) + 'px';
}
window.addEventListener('resize', fitCanvas);
window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 300));

/* ---------- オフィスのみ全画面表示 ---------- */
/* Fullscreen APIが使えない環境ではCSS疑似全画面(fakefs)にフォールバック */
function setFakeFs(on) {
  document.body.classList.toggle('fakefs', on);
  setTimeout(fitCanvas, 60);
}
const fsBtn = document.getElementById('fsBtn');
if (fsBtn) fsBtn.addEventListener('click', () => {
  const st = document.getElementById('stage');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (document.body.classList.contains('fakefs')) {
    setFakeFs(false);
  } else {
    let p;
    try { p = (st.requestFullscreen || st.webkitRequestFullscreen).call(st); } catch { p = Promise.reject(); }
    Promise.resolve(p).catch(() => setFakeFs(true));
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('fakefs')) setFakeFs(false);
});
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => setTimeout(fitCanvas, 120));
}

/* ---------- データ取得 ---------- */
let snap = null, snapAt = 0, fetchFail = false;
async function poll() {
  if (!viewToken) return;
  try {
    const r = await fetch(`${CFG.dataBase}/snapshot.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const row = await r.json();
    if (row && row.data) {
      const newAt = new Date(row.at).getTime();
      const isNew = newAt !== snapAt;
      snap = row.data;
      snapAt = newAt;
      onSnapshot();
      if (isNew) lastArrivalT = performance.now();  // コレクター受信ランプ用
    }
    fetchFail = false;
  } catch (e) {
    fetchFail = true;
  }
  updateHud();
}

let lastArrivalT = -1;

/* ---------- 履歴(Supabaseに7日分貯まっているのに今まで使っていなかった) ----------
   本日の伸び・24時間の推移・延べ稼働に使う。通常のpoll()とは完全に独立させ、
   ここが落ちても「受信断」バナーは絶対に出さない(いちばん誤報してはいけない表示なので) */
let hist = null, histFail = false;
async function pollHistory() {
  if (!viewToken) return;
  try {
    const r = await fetch(`${CFG.dataBase}/history.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const rows = await r.json();
    // 配信側は古い順で書き出している。t はミリ秒に直して使う
    hist = (Array.isArray(rows) ? rows : []).map(x => ({ ...x, t: new Date(x.at).getTime() }));
    histFail = false;
  } catch { histFail = true; }
}

// JSTの今日0時(ミリ秒)。日跨ぎで前日の値を基準にしてしまわないため
function jstMidnight() {
  const n = jstNow();
  return Date.now() - ((n.h * 60 + n.m) * 60000) - (new Date().getSeconds() * 1000);
}

// 本日の伸び。基準は必ず JST 0時。
// 履歴(300件)が0時まで届かない日があり得るので、そのときは「途中から数えた値」を本日として
// 出さずに null にする(いつからの数字か分からないものを出さない・2026-08-06 MON指摘)
const DELTA_BASE_TOL_MIN = 30;   // 0時から何分以内の観測なら「0時基準」と名乗ってよいか
function todayRange(pick) {
  if (!hist || !hist.length) return null;
  const from = jstMidnight();
  const today = hist.filter(x => x.t >= from);
  const firstRow = today.find(x => pick(x) != null);
  const lastRow = [...today].reverse().find(x => pick(x) != null);
  if (!firstRow || !lastRow) return null;
  if (firstRow.t - from > DELTA_BASE_TOL_MIN * 60000) return null;   // 0時付近の観測が無い=基準を名乗れない
  return { at: firstRow.t, base: pick(firstRow), now: pick(lastRow), delta: pick(lastRow) - pick(firstRow) };
}
function todayDelta(pick) {
  const r = todayRange(pick);
  return r ? r.delta : null;
}
// 基準時刻の表示用(JSTのHH:MM)
const baseAt = r => (r ? new Date(r.at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }) : null);

// 本日の延べ稼働(人時)。5分間隔の観測からの推定。実測ではないので表示側でそう書く
function todayWorkedHours() {
  if (!hist || hist.length < 2) return null;
  const from = jstMidnight();
  const today = hist.filter(x => x.t >= from);
  if (today.length < 2) return null;
  let ms = 0;
  for (let i = 1; i < today.length; i++) {
    const gap = today[i].t - today[i - 1].t;
    if (gap > 20 * 60000) continue;            // 欠測区間は積まない(埋めると捏造になる)
    const n = (today[i - 1].cl || []).length + (today[i - 1].cx || []).length;
    ms += gap * n;
  }
  return ms / 3600000;
}

/* ---------- 歩行スプライトシート(assets/sheets/<id>.png 3列x4行) ----------
   行: 0=正面 1=左向き 3=後ろ姿(右向きは左を反転)。列: 歩行3コマ(中央=立ち) */
const SHEETS = {};
// AI生成シートの下ごしらえ:
//  1) 外周flood-fillで背景(白/市松)を透過
//  2) コマ(3x4)ごとに最大の連結成分だけ残す(ノイズ・隣コマの混入・影を除去)
//  3) 実際に絵がある範囲(bbox)を記録し、描画はbbox基準(頭切れ・コマずれ解消)
function processSheet(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, w, h);
  const d = im.data;
  const isBg = i => {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    return Math.abs(r - gg) < 16 && Math.abs(gg - b) < 16 && Math.abs(r - b) < 16 && r > 178;
  };
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
  while (stack.length) {
    const pIdx = stack.pop();
    if (seen[pIdx]) continue;
    seen[pIdx] = 1;
    const i4 = pIdx * 4;
    if (!isBg(i4)) continue;
    d[i4 + 3] = 0;
    const x = pIdx % w, y = (pIdx / w) | 0;
    if (x > 0) stack.push(pIdx - 1);
    if (x < w - 1) stack.push(pIdx + 1);
    if (y > 0) stack.push(pIdx - w);
    if (y < h - 1) stack.push(pIdx + w);
  }
  // 成分解析はシート全体で行い、重心が属するコマに割り当てる
  // (コマ境界をはみ出す頭や小物も切れずに含まれる)
  const cw = w / 3, ch = h / 4;
  const label = new Int32Array(w * h);
  const comps = [];
  for (let pi = 0; pi < w * h; pi++) {
    if (label[pi] || d[pi * 4 + 3] < 16) continue;
    const st = [pi];
    label[pi] = comps.length + 1;
    let count = 0, sx = 0, sy = 0, bx0 = w, bx1 = 0, by0 = h, by1 = 0;
    const px = [];
    while (st.length) {
      const q = st.pop();
      count++; px.push(q);
      const qx = q % w, qy = (q / w) | 0;
      sx += qx; sy += qy;
      if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx;
      if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
      if (qx > 0 && !label[q - 1] && d[(q - 1) * 4 + 3] >= 16) { label[q - 1] = label[pi]; st.push(q - 1); }
      if (qx < w - 1 && !label[q + 1] && d[(q + 1) * 4 + 3] >= 16) { label[q + 1] = label[pi]; st.push(q + 1); }
      if (qy > 0 && !label[q - w] && d[(q - w) * 4 + 3] >= 16) { label[q - w] = label[pi]; st.push(q - w); }
      if (qy < h - 1 && !label[q + w] && d[(q + w) * 4 + 3] >= 16) { label[q + w] = label[pi]; st.push(q + w); }
    }
    const cell = Math.min(3, Math.floor((sy / count) / ch)) * 3 + Math.min(2, Math.floor((sx / count) / cw));
    comps.push({ cell, count, px, box: { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } });
  }
  const boxes = new Array(12).fill(null);
  const bestOf = new Array(12).fill(null);
  for (const cp of comps) {
    if (!bestOf[cp.cell] || cp.count > bestOf[cp.cell].count) bestOf[cp.cell] = cp;
  }
  for (const cp of comps) {
    if (bestOf[cp.cell] !== cp && cp.count < 400) {
      for (const q of cp.px) d[q * 4 + 3] = 0;   // ノイズ・ゴミ成分を消す
    }
  }
  for (let k = 0; k < 12; k++) if (bestOf[k]) boxes[k] = bestOf[k].box;
  g.putImageData(im, 0, 0);
  return { cv: c, boxes };
}
for (const id of ['fujimoto', 'amakawa', 'tsukishiro', 'ito', 'sasaki', 'ando', 'hirose', 'arimoto', 'kato', 'zama', 'lala', 'shirayanagi']) {
  const img = new Image();
  img.onload = () => { SHEETS[id] = processSheet(img); };
  img.src = `assets/sheets/${id}.png`;
}

function drawSheet(g, sheet, dir, fi, x, y, h, cropBottom) {
  const cb = cropBottom || 0;
  const row = dir === 'left' || dir === 'right' ? 1 : dir === 'up' ? 3 : 0;
  const b = sheet.boxes[row * 3 + fi] || sheet.boxes[1] || sheet.boxes[0];
  if (!b) return;
  const f = sheet.boxes[1] || b;
  const w = h * Math.min(b.w / b.h, (f.w / f.h) * 1.08);
  const sh2 = b.h * (1 - cb), dh = h * (1 - cb);
  g.save();
  g.imageSmoothingEnabled = true;
  if (dir === 'right') {
    g.translate(Math.round(x), 0); g.scale(-1, 1);
    g.drawImage(sheet.cv, b.x, b.y, b.w, sh2, -w / 2, Math.round(y) - h + 2, w, dh);
  } else {
    g.drawImage(sheet.cv, b.x, b.y, b.w, sh2, Math.round(x) - w / 2, Math.round(y) - h + 2, w, dh);
  }
  g.restore();
}

/* ---------- オフィスパーツ(ユーザー製タイルセット) ---------- */
function keyOutBackground(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, w, h);
  const d = im.data;
  const isBg = i => {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    return Math.abs(r - gg) < 16 && Math.abs(gg - b) < 16 && Math.abs(r - b) < 16 && r > 178;
  };
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
  while (stack.length) {
    const pIdx = stack.pop();
    if (seen[pIdx]) continue;
    seen[pIdx] = 1;
    const i4 = pIdx * 4;
    if (!isBg(i4)) continue;
    d[i4 + 3] = 0;
    const x = pIdx % w, y = (pIdx / w) | 0;
    if (x > 0) stack.push(pIdx - 1);
    if (x < w - 1) stack.push(pIdx + 1);
    if (y > 0) stack.push(pIdx - w);
    if (y < h - 1) stack.push(pIdx + w);
  }
  g.putImageData(im, 0, 0);
  return c;
}
const OFFICE = {};
{
  const bg = new Image();
  bg.onload = () => { OFFICE.bg = bg; };
  bg.src = 'assets/office/bg.png';
  for (const k of ['vending', 'sofa', 'cooler', 'chair',
    'rack', 'netcab', 'plant_a', 'plant_mon', 'lamp', 'coffee_st', 'armchair',
    'snack', 'copier', 'tower', 'dskb1', 'dskb2', 'dskb4',
    'corkboard', 'window_day', 'window_night', 'reception', 'bin_g', 'bin_r', 'exting', 'sanitizer', 'studio_audio', 'studio_film', 'rug_green', 'b_grill', 'b_table', 'b_meat', 'b_skewer', 'b_cooler', 'b_beer', 'g_rack', 'g_barbell', 'g_bench', 'g_tread', 'g_mats', 'g_ball']) {
    const im = new Image();
    im.onload = () => { OFFICE[k] = keyOutBackground(im); };
    im.src = `assets/office/${k}.png`;
  }
}
const SWEEPS = {};
for (const k of ['sweep1', 'sweep2', 'mop1', 'wipe1', 'bucket1']) {
  const im = new Image();
  im.onload = () => {
    // 素材に隣コマの断片が混入していても壊れないよう、最大連結成分のbboxだけを使う
    // (全体bboxだと断片まで含んで縮小+浮きバグになる)
    const cv2 = keyOutBackground(im);
    const W2 = cv2.width, H2 = cv2.height;
    const d2 = cv2.getContext('2d').getImageData(0, 0, W2, H2).data;
    const lbl = new Int32Array(W2 * H2);
    let best = null;
    for (let i = 0; i < W2 * H2; i++) {
      if (lbl[i] || d2[i * 4 + 3] <= 16) continue;
      const stack = [i];
      lbl[i] = 1;
      let n = 0, x0 = W2, x1 = 0, y0 = H2, y1 = 0;
      while (stack.length) {
        const p = stack.pop();
        const px2 = p % W2, py2 = (p / W2) | 0;
        n++;
        if (px2 < x0) x0 = px2; if (px2 > x1) x1 = px2;
        if (py2 < y0) y0 = py2; if (py2 > y1) y1 = py2;
        if (px2 > 0 && !lbl[p - 1] && d2[(p - 1) * 4 + 3] > 16) { lbl[p - 1] = 1; stack.push(p - 1); }
        if (px2 < W2 - 1 && !lbl[p + 1] && d2[(p + 1) * 4 + 3] > 16) { lbl[p + 1] = 1; stack.push(p + 1); }
        if (py2 > 0 && !lbl[p - W2] && d2[(p - W2) * 4 + 3] > 16) { lbl[p - W2] = 1; stack.push(p - W2); }
        if (py2 < H2 - 1 && !lbl[p + W2] && d2[(p + W2) * 4 + 3] > 16) { lbl[p + W2] = 1; stack.push(p + W2); }
      }
      if (!best || n > best.n) best = { n, x0, x1, y0, y1 };
    }
    const b = best || { x0: 0, x1: W2 - 1, y0: 0, y1: H2 - 1 };
    SWEEPS[k] = { cv: cv2, box: { x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 } };
  };
  im.src = `assets/office/${k}.png`;
}

function drawProp(g, key, x, y, w, h) {
  const im = OFFICE[key];
  if (!im) return false;
  g.save();
  g.imageSmoothingEnabled = true;
  g.drawImage(im, x, y, w, h);
  g.restore();
  return true;
}


/* ================================================================
   スプライト: チビキャラ 12x16
   ================================================================ */
const SKIN = '#f8d8b8', INK = '#4a3b2a';

function drawChar(g, px, py, emp, dir, frame, expr, t) {
  px = Math.round(px); py = Math.round(py);
  g.save();
  const tl = (dir === 'sit' || !emp.tall) ? 0 : 2;  // 高身長は立ち姿+2px
  g.translate(px - 6, py - 16 - tl);
  const hair = emp.hair, shirt = emp.shirt;
  const walk = (dir !== 'sit' && frame % 2 === 1);
  const bob = walk ? 1 : 0;
  const bw = emp.fat ? 10 : emp.slim ? 6 : 8;      // 体型: デブ/細身/普通
  const bx = 6 - bw / 2;

  // 脚
  g.fillStyle = '#5a4a6a';
  if (dir === 'sit') {
    g.fillRect(3, 14, 6, 2);
  } else if (walk) {
    g.fillRect(3, 13, 2, 3 + tl); g.fillRect(7, 14, 2, 2 + tl);
  } else {
    g.fillRect(3, 13, 2, 3 + tl); g.fillRect(7, 13, 2, 3 + tl);
  }
  // 体
  g.fillStyle = shirt;
  g.fillRect(bx, 9 + bob, bw, 5 - bob);
  // 腕
  const typing = expr === 'typing' && Math.floor(t / 160) % 2 === 0;
  g.fillStyle = shirt;
  if (dir === 'sit') {
    g.fillRect(bx - 1, 10 + (typing ? 1 : 0), 2, 3);
    g.fillRect(bx + bw - 1, 10 + (typing ? 0 : 1), 2, 3);
  } else {
    g.fillRect(bx - 1, 9 + bob, 2, 4); g.fillRect(bx + bw - 1, 9 + bob, 2, 4);
  }
  // 頭
  g.fillStyle = SKIN;
  g.fillRect(2, 2 + bob, 8, 7);
  // 髪(はげはツヤのみ)
  if (emp.bald) {
    g.fillStyle = '#ffe8cc'; g.fillRect(3, 1 + bob, 4, 1);
  } else {
    g.fillStyle = hair;
    g.fillRect(1, 0 + bob, 10, 3);
    g.fillRect(1, 2 + bob, 2, 3); g.fillRect(9, 2 + bob, 2, 3);
  }
  if (emp.id === 'fujimoto' && !emp.bald) { g.fillStyle = hair; g.fillRect(1, 0 + bob, 10, 2); g.fillRect(0, 1 + bob, 2, 2); }
  if (emp.id === 'tsukishiro') { g.fillStyle = '#8a7ab0'; g.fillRect(0, 0 + bob, 3, 2); g.fillRect(9, 0 + bob, 3, 2); } // ヘッドホン
  if (dir === 'up') { g.fillStyle = emp.bald ? SKIN : hair; g.fillRect(2, 2 + bob, 8, 6); g.restore(); return; }

  // 顔
  const ey = 5 + bob;
  const blink = Math.floor((t + (emp.seed || 0)) / 3200) % 8 === 0;
  g.fillStyle = INK;
  const eo = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
  if (expr === 'sleep') {
    g.fillRect(3 + eo, ey + 1, 2, 1); g.fillRect(7 + eo, ey + 1, 2, 1);
  } else if (expr === 'happy') {
    g.fillRect(3 + eo, ey, 1, 1); g.fillRect(4 + eo, ey - 1, 1, 1);
    g.fillRect(7 + eo, ey - 1, 1, 1); g.fillRect(8 + eo, ey, 1, 1);
    g.fillRect(5, ey + 2, 2, 1);
  } else if (expr === 'panic') {
    g.fillStyle = '#fff'; g.fillRect(3 + eo, ey - 1, 2, 2); g.fillRect(7 + eo, ey - 1, 2, 2);
    g.fillStyle = INK; g.fillRect(4 + eo, ey, 1, 1); g.fillRect(8 + eo, ey, 1, 1);
    g.fillRect(5, ey + 2, 2, 2);
  } else if (expr === 'tired') {
    g.fillRect(3 + eo, ey + 1, 2, 1); g.fillRect(7 + eo, ey + 1, 2, 1);
    g.fillStyle = '#b0a0c0'; g.fillRect(3 + eo, ey + 2, 2, 1); g.fillRect(7 + eo, ey + 2, 2, 1);
  } else if (blink) {
    g.fillRect(3 + eo, ey + 1, 2, 1); g.fillRect(7 + eo, ey + 1, 2, 1);
  } else {
    g.fillRect(3 + eo, ey, 2, 2); g.fillRect(7 + eo, ey, 2, 2);
  }
  if (expr === 'sweat') {
    g.fillStyle = '#5ab0e8';
    const dy = Math.floor(t / 220) % 3;
    g.fillRect(11, 3 + dy + bob, 2, 2);
  }
  g.restore();
}

function drawZzz(g, x, y, t) {
  g.fillStyle = 'rgba(90,110,200,.9)';
  g.font = '8px DotGothic16';
  const ph = Math.floor(t / 600) % 3;
  for (let i = 0; i <= ph; i++) g.fillText('z', x + 8 + i * 4, y - 18 - i * 5);
}
function drawAlert(g, x, y, t) {
  if (Math.floor(t / 400) % 2) return;
  g.fillStyle = '#e05a4e';
  g.fillRect(x - 1, y - 26, 3, 6); g.fillRect(x - 1, y - 18, 3, 3);
}

/* ---------- 吹き出し ---------- */
const _recentSay = {};
// 感情絵文字: セリフの種類ごとに合う絵文字を語尾に添える(元から絵文字入りの行はそのまま)
const EMOJI_MAP = {
  sleep: ['💤', '😪', '🌙'],
  grumble: ['💦', '😩', '😅', '😵', '😩'],
  idle: ['🤔', '💭', '😶', '🙄'],
  rest: ['☕', '😌', '🍵', '😋'],
  opener: ['😊', '💬', '🤔'],
  reply: ['😄', '🤝', '😂'],
  gtopic: ['😆', '🎉', '😂', '✨'],
  greact: ['😂', '👏', '🤣', '😲'],
  order: ['💼', '👊', '🔥'],
  orderreply: ['💪', '✨', '😤'],
  worktalk: ['📝', '💼', '🤔', '👀'],
  'ev:bbq': ['🍖', '🔥', '😋', '🍻'],
  'ev:gym': ['💪', '🔥', '😤', '💪'],
  evreact: ['👀', '😅', '😂', '🤨'],
  evsorry: ['💦', '🙏', '😱'],
  bossbust: ['💢', '🔥', '😡'],
  alarm: ['🚨', '💦', '😱'],
  chimebrk: ['☕', '😌', '🎐'],
  chimeend: ['💪', '🔥', '✊'],
  kyokocheer: ['💗', '💕', '✨', '🥰'],
  itocheer: ['😳', '💗', '😊'],
  kyokoinvite: ['💕', '🥺', '💗'],
  itodateok: ['😊', '💗', '😳'],
  datetalk: ['💗', '💞', '😊', '🥰'],
  patrol: ['👍', '✨', '🔥', '😊'],
  patrolreply: ['💪', '✨', '😊', '😤'],
  jansabo: ['😪', '😶', '🍃'],
  tsukistudio: ['🎤', '🎧', '✨', '🎵'],
};
const EMOJI_RE = /\p{Extended_Pictographic}/u;
function decorate(key, text) {
  const set = EMOJI_MAP[key] || EMOJI_MAP[key.split(':')[0]];
  if (!set || !text || EMOJI_RE.test(text)) return text;
  if (Math.random() < 0.25) return text;   // たまには無印も残す
  return text + set[Math.floor(Math.random() * set.length)];
}

// 共用プールの中には特定の人の名前が入った台詞がある。本人に言わせないための対応表
const NAME_ALIASES = {
  fujimoto: ['藤本', '社長', 'MON'], tsukishiro: ['月城'], ito: ['伊藤'], sasaki: ['佐々木'],
  amakawa: ['天川'], ando: ['安藤'], hirose: ['廣瀬', 'きょうこ'], arimoto: ['有本'],
  kato: ['加藤'], zama: ['座間'], shirayanagi: ['白柳'],
};
function namesSelf(line, id) {
  const al = NAME_ALIASES[id];
  return !!al && al.some(n => line.includes(n));
}

function pickFresh(key, pool, selfId) {
  if (!pool || !pool.length) return '';
  const hist = _recentSay[key] || (_recentSay[key] = []);
  const cap = Math.max(1, Math.floor(pool.length * 0.5));
  let cand, tries = 0;
  do { cand = pool[Math.floor(Math.random() * pool.length)]; tries++; }
  while ((hist.includes(cand) || (selfId && namesSelf(cand, selfId))) && tries < 25);
  if (selfId && namesSelf(cand, selfId)) {
    const ok = pool.filter(x => !namesSelf(x, selfId));   // 自分の名前が入っていない行に逃がす
    if (ok.length) cand = ok[Math.floor(Math.random() * ok.length)];
  }
  hist.push(cand);
  while (hist.length > cap) hist.shift();
  return decorate(key, cand);
}

// 隣接Q→Aペアで書かれたプールから、ペアの先頭indexを非重復で引く
const _pairHist = {};
function pickPairIdx(key, pool) {
  const hist = _pairHist[key] || (_pairHist[key] = []);
  const nPairs = Math.floor(pool.length / 2);
  let i, tries = 0;
  do { i = Math.floor(Math.random() * nPairs) * 2; tries++; } while (hist.includes(i) && tries < 25);
  hist.push(i);
  while (hist.length > Math.floor(nPairs / 2)) hist.shift();
  return i;
}

const bubbleQ = [];
let simT = 0;   // ループの現在時刻(goto短絡などフレーム外から参照)

function drawBubble(g, x, y, text) {
  g.font = '6px DotGothic16';
  // 絵文字(サロゲートペア)を真っ二つにしないよう、コードポイント単位で折り返す
  const cps = Array.from(String(text));
  const lines = [];
  for (let i = 0; i < cps.length && lines.length < 3; i += 14) lines.push(cps.slice(i, i + 14).join(''));
  if (cps.length > 42) lines[2] = cps.slice(28, 41).join('') + '…';
  const w = Math.max(...lines.map(l => g.measureText(l).width)) + 8;
  const h = lines.length * 8 + 5;
  let bx = Math.min(Math.max(4, x - w / 2), W - w - 4);
  const by = Math.max(4, y - 20 - h);
  g.fillStyle = 'rgba(255,255,255,.95)';
  g.strokeStyle = INK; g.lineWidth = 1;
  g.beginPath(); g.roundRect(bx + .5, by + .5, w, h, 3); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(x - 2, by + h); g.lineTo(x + 2, by + h); g.lineTo(x, by + h + 4); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = INK;
  lines.forEach((l, i) => g.fillText(l, bx + 4, by + 7.5 + i * 8));
}


/* ---------- パーティクル(煙・ハート・音符) ---------- */
const particles = [];
function spawnParticle(type, x, y) {
  if (type === 'confetti') {
    particles.push({ type, x, y, vy: 0.3 + Math.random() * 0.35, vx: (Math.random() - 0.5) * 0.3, life: 4200, hue: Math.floor(Math.random() * 360) });
    return;
  }
  particles.push({ type, x, y, vy: -0.14 - Math.random() * 0.1, vx: (Math.random() - 0.5) * 0.14, life: 2600 });
}
function stepParticles(dt) {
  for (const p of particles) { p.x += p.vx * dt / 16; p.y += p.vy * dt / 16; p.life -= dt; }
  for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
}
function drawParticles(g) {
  for (const p of particles) {
    const a = Math.min(1, p.life / 1600);
    if (p.type === 'smoke') {
      g.fillStyle = `rgba(150,150,160,${a * .6})`;
      g.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
    } else if (p.type === 'heart') {
      g.fillStyle = `rgba(232,90,120,${a})`;
      const x = Math.round(p.x), y = Math.round(p.y);
      g.fillRect(x, y, 2, 2); g.fillRect(x + 3, y, 2, 2); g.fillRect(x, y + 2, 5, 2); g.fillRect(x + 1, y + 4, 3, 1); g.fillRect(x + 2, y + 5, 1, 1);
    } else if (p.type === 'confetti') {
      g.fillStyle = `hsla(${p.hue},85%,60%,${a})`;
      g.fillRect(Math.round(p.x), Math.round(p.y), 2, 3);
    } else if (p.type === 'bsmoke') {
      const s = 2 + Math.floor((2600 - p.life) / 650);   // 立ちのぼるほど大きく
      g.fillStyle = `rgba(120,120,130,${a * .5})`;
      g.fillRect(Math.round(p.x - s / 2), Math.round(p.y), s, s);
    } else if (p.type === 'note') {
      g.fillStyle = `rgba(120,90,200,${a})`;
      g.font = '9px DotGothic16';
      g.fillText('🎵', Math.round(p.x), Math.round(p.y));
    }
  }
}

/* ================================================================
   オフィスの什器
   ================================================================ */
function rr(g, x, y, w, h, c, sc) {
  g.fillStyle = c; g.fillRect(x, y, w, h);
  if (sc) { g.strokeStyle = sc; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, w - 1, h - 1); }
}

function drawChair(g, seat) {
  if (drawProp(g, 'chair', seat.x - 9, seat.y - 18, 18, 25)) return;
  rr(g, seat.x - 9, seat.y - 16, 18, 8, '#3c3c46', INK);
}

function drawDesk(g, seat, working, t, emp, st) {
  const x = seat.x, y = seat.y;
  const pc = (emp && emp.pc) || 'mon1';
  const key = pc === 'mon2' ? 'dskb2' : pc === 'laptop' ? 'dskb4' : 'dskb1';
  if (OFFICE[key]) {
    drawProp(g, key, x - 25, y - 6, 50, 38);
  } else {
    rr(g, x - 24, y + 6, 48, 18, '#b8905c', INK);
    rr(g, x - 9, y - 4, 18, 12, '#23252d', INK);
  }
  if (working) {
    // 稼働ランプのみ(画面光のエフェクトは廃止 — 光っていいのは伊藤の頭だけ)
    g.fillStyle = '#4cff8e';
    g.fillRect(x + 15, y + 6, 2, 2);
  }
  if (emp && emp.tag) {
    // 席札は担当者の状況で色が変わる: 稼働=緑(ゆっくり明滅)/休憩=琥珀/睡眠=藍/停止=赤点滅/収録=紫/退勤=灰
    let plateBg = 'rgba(40,42,54,.85)';
    if (st) {
      if (!st.present) plateBg = 'rgba(120,116,108,.65)';
      else if (st.mode === 'panic') plateBg = Math.floor(t / 400) % 2 ? '#c03a2e' : '#7a221a';
      else if (st.recording) plateBg = '#7a3a9a';
      else if (st.mode === 'working' && (st.resting || st.onChimeBreak)) plateBg = '#c8963c';
      else if (st.mode === 'working') plateBg = Math.floor(t / 1000) % 2 ? '#2e8a57' : '#26744a';
      else if (st.mode === 'sleep' || st.action === 'sleep') plateBg = '#4a5a8a';
      else if (st.resting) plateBg = '#c8963c';
    }
    g.font = '5px DotGothic16';
    const tw = g.measureText(emp.tag).width + 6;
    g.fillStyle = plateBg;
    g.beginPath(); g.roundRect(x - tw / 2 + .5, y + 14.5, tw, 8, 2); g.fill();
    g.fillStyle = '#e8e6da';
    g.fillText(emp.tag, x - tw / 2 + 3, y + 20.5);
  }
}

// 社名看板の目標カウンター1行(ラベル / 現在値 目標値 / 進捗バー)。
// 板の内側は x478-628 しかないので、数字は万・億で詰める
function drawGoalRow(g, label, cur, goal, unit, y, delta) {
  const L = 480, R = 626;   // 板の内側(はみ出すと枠に食い込む)
  // 右端から: 達成率 → バー → 左から: ラベル → 数値 の順に詰める
  g.font = '5px DotGothic16';
  const pct = fmtGoalPct(cur, goal);
  const pw = g.measureText(pct).width;
  g.fillStyle = '#c8a878';
  g.fillText(pct, R - pw, y);
  const BW = 34, BH = 4, BX = R - pw - 3 - BW, by = y - 4;
  rr(g, BX, by, BW, BH, 'rgba(0,0,0,.35)');
  if (cur != null && goal) {
    // 1億が目標だと当分は極細。0でなければ必ず1px以上は光らせる
    const w = Math.min(BW, Math.max(cur > 0 ? 1 : 0, BW * cur / goal));
    if (w > 0) rr(g, BX, by, w, BH, '#e8b84a');
  }
  g.strokeStyle = 'rgba(200,168,120,.5)'; g.lineWidth = 1;
  g.strokeRect(BX + .5, by + .5, BW - 1, BH - 1);
  g.font = '7px DotGothic16';
  g.fillStyle = '#c8a878';
  g.fillText(label, L, y);
  const base = `${fmtJa(cur)}${cur == null ? '' : unit} / ${fmtJa(goal)}${unit}`;
  // 本日の伸び。入らないなら諦める(看板の外へ出すくらいなら出さない)
  const d = delta != null && delta > 0 ? ` 0時+${delta < 10000 ? delta : fmtJa(delta)}` : '';
  let val = base + d;
  if (L + 24 + g.measureText(val).width > BX - 2) g.font = '6px DotGothic16';
  if (L + 24 + g.measureText(val).width > BX - 2) { val = base; g.font = '7px DotGothic16'; }
  if (L + 24 + g.measureText(val).width > BX - 2) g.font = '6px DotGothic16';
  g.fillStyle = '#f0d890';
  g.fillText(val, L + 24, y);
  if (d && val === base + d) {   // 伸びだけ色を変えて目立たせる
    g.fillStyle = '#8ad07a';
    g.fillText(d, L + 24 + g.measureText(base).width, y);
  }
}

function drawOffice(g, t, tm) {
  const hour = tm.h + tm.m / 60;
  const night = hour >= 19 || hour < 5;   // 5:00には外が明るい

  if (OFFICE.bg) {
    // ユーザー製パーツのオフィス全景を背景に(壁・床・掲示板・時計・看板込み)
    g.save(); g.imageSmoothingEnabled = true;
    g.drawImage(OFFICE.bg, 0, 0, W, H);
    g.restore();
    // ホワイトボードに社訓
    g.font = '7px DotGothic16';
    const bcx = 284;
    const btitle = '《社訓》';
    g.fillStyle = '#b04a3c';
    g.fillText(btitle, bcx - g.measureText(btitle).width / 2, 16);
    g.font = '6px DotGothic16';
    g.fillStyle = 'rgba(74,59,42,.92)';
    (CFG.mottos || []).slice(0, 4).forEach((m, k) => {
      const line = String(m).slice(0, 8);
      g.fillText(line, bcx - g.measureText(line).width / 2, 24 + k * 7.5);
    });
    // 看板: 社名 + YT目標カウンター2本(登録者・総再生)
    g.font = '11px DotGothic16'; g.fillStyle = '#f0d890';
    const cname = 'MON-AI Inc.';
    g.fillText(cname, 553 - g.measureText(cname).width / 2, 19);
    const yt0 = snap && snap.youtube;
    drawGoalRow(g, '登録者', yt0 ? yt0.subs : null, CFG.youtubeGoal, '人', 33, todayDelta(x => x.yt && x.yt.subs));
    drawGoalRow(g, '総再生', yt0 ? yt0.views : null, CFG.youtubeViewGoal, '回', 45, todayDelta(x => x.yt && x.yt.views));
    // 窓: 背景の窓を壁色で消し、昼/夜素材の窓だけを描く
    rr(g, 160, 0, 94, 57, '#f0e7d4');
    rr(g, 378, 0, 92, 57, '#f0e7d4');
    const wkey = night ? 'window_night' : 'window_day';
    drawProp(g, wkey, 170, 3, 72, 52);
    drawProp(g, wkey, 388, 3, 72, 52);

    // 掲示板: コルクボード+紙ミッション+保留タグ(bg側の台帳ボードを完全に覆う)
    rr(g, 16, 0, 142, 60, '#f3edda');
    drawProp(g, 'corkboard', 18, 2, 132, 56);
    rr(g, 30, 17, 108, 24, '#fbf6ea', '#c8bca0');
    g.fillStyle = '#e05a4e';
    g.beginPath(); g.arc(36, 21, 1.5, 0, 7); g.fill();
    g.beginPath(); g.arc(132, 21, 1.5, 0, 7); g.fill();
    g.font = '9px DotGothic16';
    g.fillStyle = '#3a2e20';
    const mtxt = CFG.mission || '物語を、毎日届ける。';
    g.fillText(mtxt, 84 - g.measureText(mtxt).width / 2, 33);

    // 時計: 下絵を完全に覆う文字盤+リアル時刻
    const ccx = 352, ccy = 28.5;
    g.fillStyle = '#8a6a4a';
    g.beginPath(); g.arc(ccx, ccy, 18.6, 0, 7); g.fill();
    g.fillStyle = '#fffdf6';
    g.beginPath(); g.arc(ccx, ccy, 15, 0, 7); g.fill();
    g.fillStyle = 'rgba(74,59,42,.85)';
    for (let k = 0; k < 12; k++) {
      const a2 = k / 12 * Math.PI * 2;
      const big = k % 3 === 0;
      g.fillRect(ccx + Math.cos(a2) * 12 - (big ? 1 : 0.5), ccy + Math.sin(a2) * 12 - (big ? 1 : 0.5), big ? 2 : 1, big ? 2 : 1);
    }
    const mA = tm.m / 60 * Math.PI * 2 - Math.PI / 2, hA = (tm.h % 12 + tm.m / 60) / 12 * Math.PI * 2 - Math.PI / 2;
    g.strokeStyle = '#3a2e20'; g.lineCap = 'round';
    g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(ccx, ccy); g.lineTo(ccx + Math.cos(hA) * 7, ccy + Math.sin(hA) * 7); g.stroke();
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(ccx, ccy); g.lineTo(ccx + Math.cos(mA) * 11, ccy + Math.sin(mA) * 11); g.stroke();
    g.lineCap = 'butt'; g.lineWidth = 1;
    g.fillStyle = '#3a2e20'; g.beginPath(); g.arc(ccx, ccy, 1.5, 0, 7); g.fill();
  } else {
    // 床
    g.fillStyle = '#e8d5ae';
    g.fillRect(0, 48, W, H - 48);
    g.fillStyle = 'rgba(160,130,80,.25)';
    for (let y = 48; y < H; y += 16) g.fillRect(0, y, W, 1);
    for (let x = 0; x < W; x += 32) for (let y = 48; y < H; y += 16) g.fillRect(x + ((y / 16) % 2) * 16, y, 1, 16);

    // 壁
    g.fillStyle = '#f7f0dd'; g.fillRect(0, 0, W, 44);
    g.fillStyle = '#d8c9a8'; g.fillRect(0, 44, W, 4);

    // 窓と空
    for (const wx of [168, 348]) {
      let sky;
      if (hour >= 20 || hour < 4) sky = '#1a2a4a';
      else if (hour < 6) sky = '#4a5a8a';
      else if (hour < 8) sky = '#f0b060';
      else if (hour < 16) sky = '#8ecae6';
      else if (hour < 18) sky = '#f0a860';
      else sky = '#3a4a7a';
      rr(g, wx, 6, 56, 34, sky, INK);
      if (hour >= 20 || hour < 5) {
        g.fillStyle = '#fff';
        g.fillRect(wx + 10, 12, 1, 1); g.fillRect(wx + 30, 20, 1, 1); g.fillRect(wx + 44, 10, 1, 1);
        g.fillStyle = '#f0e8a0'; g.fillRect(wx + 40, 26, 4, 4);
      } else if (hour >= 8 && hour < 16) {
        g.fillStyle = '#fff';
        g.fillRect(wx + 8 + (Math.floor(t / 900) % 40), 12, 8, 3);
      }
      g.strokeStyle = INK; g.beginPath();
      g.moveTo(wx + 28.5, 6); g.lineTo(wx + 28.5, 40); g.stroke();
    }

    // 社長室コルクボード(保留タスク)
    rr(g, 24, 6, 120, 34, '#c8a878', INK);
    g.font = '9px DotGothic16'; g.fillStyle = INK;
    g.fillText('保留タスク台帳', 52, 16);
    const n = snap && snap.tasks && snap.tasks.count != null ? snap.tasks.count : 0;
    for (let i = 0; i < Math.min(n, 14); i++) {
      rr(g, 30 + (i % 7) * 16, 20 + Math.floor(i / 7) * 9, 10, 7, i % 2 ? '#fff8e0' : '#e0f0ff', '#a09070');
    }

    // 社訓ポスター
    rr(g, 234, 5, 62, 38, '#fff8e8', INK);
    g.font = '8px DotGothic16'; g.fillStyle = '#b04a3c';
    g.fillText('《社訓》', 250, 14);
    g.fillStyle = INK;
    (CFG.mottos || []).slice(0, 4).forEach((m, i) => g.fillText(String(m).slice(0, 8), 238, 23 + i * 9));

    // 時計
    g.fillStyle = '#fff'; g.beginPath(); g.arc(320, 22, 11, 0, 7); g.fill();
    g.strokeStyle = INK; g.lineWidth = 2; g.beginPath(); g.arc(320, 22, 11, 0, 7); g.stroke();
    g.lineWidth = 1;
    const mA = tm.m / 60 * Math.PI * 2 - Math.PI / 2, hA = (tm.h % 12 + tm.m / 60) / 12 * Math.PI * 2 - Math.PI / 2;
    g.beginPath(); g.moveTo(320, 22); g.lineTo(320 + Math.cos(hA) * 5, 22 + Math.sin(hA) * 5); g.stroke();
    g.beginPath(); g.moveTo(320, 22); g.lineTo(320 + Math.cos(mA) * 8, 22 + Math.sin(mA) * 8); g.stroke();

    // 社名看板 + YT目標カウンター(背景画が無いときの簡易描画)
    rr(g, 412, 6, 204, 40, '#4a3b2a');
    g.font = '11px DotGothic16'; g.fillStyle = '#f0d890';
    g.fillText('MON-AI Inc.', 424, 19);
    const ytF = snap && snap.youtube;
    g.font = '6px DotGothic16'; g.fillStyle = '#e8d0a0';
    g.fillText(`登録者 ${fmtJa(ytF ? ytF.subs : null)}人 / ${fmtJa(CFG.youtubeGoal)}人`, 424, 31);
    g.fillText(`総再生 ${fmtJa(ytF ? ytF.views : null)}回 / ${fmtJa(CFG.youtubeViewGoal)}回`, 424, 41);

  }

  // ラグ(部署) — ユーザー製カーペットパーツ

  // 休憩室: 囲いの部屋枠は描かない(オープンスペース)。黄土色カーペットだけを敷く
  rr(g, 38, 242, 132, 78, '#dcc59a', '#b89468');
  g.strokeStyle = 'rgba(150,115,70,.5)'; g.lineWidth = 1;
  g.strokeRect(42.5, 246.5, 123, 69);


  // スタジオ2部屋(ユーザー製ルームアート)
  const onAir = snap && snap.launchd && snap.launchd['com.mon.tsuki.watcher'] && snap.launchd['com.mon.tsuki.watcher'].running;
  if (!drawProp(g, 'studio_film', 376, 240, 100, 66)) rr(g, 384, 246, 92, 60, '#e0e8e8', '#b0c0c0');
  if (!drawProp(g, 'studio_audio', 484, 226, 136, 90)) rr(g, 488, 234, 132, 82, '#e8e0f0', '#b0a8c0');
  rr(g, 578, 231, 32, 10, onAir ? '#e05a4e' : '#565058', INK);
  g.fillStyle = '#fff'; g.font = '6px DotGothic16'; g.fillText('ON AIR', 581, 239);
  if (!onAir) { g.fillStyle = '#ff6a5e'; g.font = '6px DotGothic16'; g.fillText('TTS停止中!', 520, 239); }


  // 社長室の調度
  drawProp(g, 'plant_mon', 20, 64, 18, 40);
  drawProp(g, 'lamp', 100, 66, 17, 38);

  // データ同期ステータスはHUD(経営ボード)側に表示(マップ上には出さない)

  // ===== マシン室(サーバーコーナー)= このMacの実況 =====
  const mc = snap && snap.machine;
  if (mc) {
    // CPU熱: 機材の奥がぼんやり熱をもつ(矩形だと角が見えるので放射グラデ)
    if (mc.cpuPct != null) {
      const heat = mc.cpuPct / 100;
      const hcol = mc.cpuPct >= 85 ? '224,90,78' : mc.cpuPct >= 60 ? '232,150,60' : '110,180,120';
      const a = Math.max(0.05, 0.09 + heat * 0.20 + Math.sin(t / (600 - heat * 400)) * 0.04);
      const hg = g.createRadialGradient(578, 166, 4, 578, 166, 62);
      hg.addColorStop(0, `rgba(${hcol},${a.toFixed(2)})`);
      hg.addColorStop(0.65, `rgba(${hcol},${(a * 0.45).toFixed(2)})`);
      hg.addColorStop(1, `rgba(${hcol},0)`);
      g.fillStyle = hg;
      g.fillRect(514, 126, 128, 80);
      // 高負荷時は陽炎(ゆらゆら上る熱)
      if (mc.cpuPct >= 80 && Math.random() < 0.12) spawnParticle('bsmoke', 600 + Math.random() * 28, 140);
    }
    // 稼働ステータス板(ゴミ箱・段ボールとは重ねない: x502〜590の枠に収める)
    const PX = 502, PY = 190, PW = 88, PH = 22;
    rr(g, PX, PY, PW, PH, '#37332c', INK);
    g.font = '6px DotGothic16';
    const cpuTxt = mc.cpuPct != null ? `CPU ${mc.cpuPct}%` : 'CPU --';   // 歯車記号(U+2699)は絵文字表示にならず豆腐になるので使わない
    g.fillStyle = '#8ef0b0';
    g.fillText(cpuTxt, PX + 4, PY + 8);
    if (mc.cpuPct != null) {
      const bx0 = PX + 7 + g.measureText(cpuTxt).width;      // 文字幅を測って残りにバーを収める
      const bw = Math.max(14, PX + PW - 5 - bx0);
      g.fillStyle = 'rgba(255,255,255,.16)';
      g.fillRect(bx0, PY + 3.5, bw, 3.5);
      g.fillStyle = mc.cpuPct >= 85 ? '#ff6a5e' : mc.cpuPct >= 60 ? '#f0b050' : '#5aff8e';
      g.fillRect(bx0, PY + 3.5, Math.round(bw * mc.cpuPct / 100), 3.5);
    }
    // いちばん働いているアプリ: psの%は「1コア=100%」なので、マシン全体比に直してCPU%と揃える
    const tp0 = mc.topProcs && mc.topProcs[0];
    g.fillStyle = '#e8e6da';
    let tpTxt = '🏭 稼働情報待ち';
    if (tp0) {
      const share = mc.cores ? Math.min(100, Math.round(tp0.cpu / mc.cores)) : null;
      const suffix = share != null ? ` ${share}%` : '';
      // 語中でぶつ切りにしないよう、板の内幅に収まるところまでを実測で削る
      const cps = Array.from(tp0.name);
      let nm = tp0.name;
      while (cps.length && g.measureText(`🏭${nm}${suffix}`).width > PW - 9) { cps.pop(); nm = cps.join(''); }
      tpTxt = `🏭${nm}${suffix}`;
    }
    g.fillText(tpTxt, PX + 4, PY + 17);
    // 倉庫(ストレージ)の段ボール: 使用率に比例して積み上がる。ラベルは山の下に置く
    if (mc.diskUsedPct != null) {
      const boxes = Math.max(1, Math.min(8, Math.round(mc.diskUsedPct / 12)));
      const BX = 476, BBASE = 182;
      for (let i = 0; i < boxes; i++) {
        const bx = BX + (i % 2) * 13, by = BBASE - Math.floor(i / 2) * 10;
        rr(g, bx, by, 12, 9, '#c8a060', '#8a6a3a');
        g.strokeStyle = '#a88448'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(bx + 6, by); g.lineTo(bx + 6, by + 9); g.stroke();
      }
      g.font = '5px DotGothic16';
      g.fillStyle = mc.diskUsedPct >= 90 ? '#c03a2e' : 'rgba(74,59,42,.62)';
      g.fillText(`倉庫 ${mc.diskUsedPct}%`, BX, BBASE + 16);
    }
  }

  // 応接セット: 絨毯(38,242,132,78)の上にバランスよく配置(ソファ左・アームチェア右、底辺を揃える)
  if (!drawProp(g, 'sofa', 44, 284, 60, 30)) rr(g, 48, 292, 52, 20, '#7a9ac8', INK);
  drawProp(g, 'armchair', 112, 282, 26, 32);
  drawProp(g, 'armchair', 142, 282, 26, 32);

  // ミーティングスペース(丸テーブル)


  return night;
}

/* ================================================================
   人の移動(共通)
   ================================================================ */
const LANE_Y = 184;
let _laneSeq = 0;
function aisleX(seat) { return seat.x - 32; }
// 上段の机と机のあいだの、実際に人が通れる縦の隙間(x)
const TOP_AISLES = [199, 261, 328, 394, 476];

// 部屋の中の地点から廊下(LANE_Y)までの退出経路。机・什器を突っ切らない
function outPath(pt, lane) {
  const L = lane || LANE_Y;
  const { x, y } = pt;
  if (y < 160 && x < 132) return [{ x, y: 168 }, { x: 240, y: 168 }, { x: 240, y: L }];      // 社長室: 休憩室の上の帯を東へ
  // 上段: 机の間の実在する隙間だけを縦に降りる(x-31だと掃除スポットが机を突っ切る)
  if (y < 160) {
    const a = TOP_AISLES.reduce((p, c) => (Math.abs(c - x) < Math.abs(p - x) ? c : p));
    return [{ x: a, y }, { x: a, y: L }];
  }
  if (y > 306 && x > 380 && x < 480) return [{ x, y: 342 }, { x: 374, y: 342 }, { x: 374, y: L }]; // 撮影スタジオ南: 入口通路経由
  if (y > 326 && x >= 236 && x <= 380) return [{ x, y: 342 }, { x: 374, y: 342 }, { x: 374, y: L }]; // 受付の下(ロビー南): 入口通路経由
  if (y > 262 && x >= 236 && x <= 380) return [{ x, y: 266 }, { x: 374, y: 266 }, { x: 374, y: L }]; // 受付まわり(カウンター上端272の上の帯): 右の通路から
  if (y > 198 && y < 285 && x >= 228 && x <= 368) return [{ x, y: 254 }, { x: 370, y: 254 }, { x: 370, y: L }]; // 総務部: 机の下→右通路
  if (y > 195 && x < 226) return [{ x, y: 256 }, { x: 206, y: 256 }, { x: 206, y: L }];      // 休憩室: 中央通路→右端列
  if (y >= 240 && y <= 306 && x > 380 && x < 480) return [{ x, y: 318 }, { x: 374, y: 318 }, { x: 374, y: L }]; // 撮影スタジオ内: 南口から入口通路経由
  if (y > 250 && y < 340 && x > 480 && x <= 626) return [{ x, y: 324 }, { x: 480, y: 324 }, { x: 480, y: L }]; // 音声スタジオ: スタジオ間の隙間から出入り(南側の掃除/警備地点も含める)
  return [{ x, y: L }];
}

function route(from, to, lane) {
  const a = outPath(from, lane);
  const b = outPath(to, lane);
  const pts = [...a, ...b.slice().reverse(), { x: to.x, y: to.y }];
  return pts.filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.y !== arr[i - 1].y);
}

class Person {
  constructor(def, i) {
    this.def = def;
    Object.assign(this, def);
    this.seed = (i + 1) * 977;
    this.lane = LANE_Y + (i % 3) * 8;   // 個人レーンで衝突減
    this.pos = def.desk ? { x: def.desk.x, y: def.desk.y } : { x: 374, y: 340 };
    this.action = 'stand';
    this.dir = 'down';
    this.path = [];
    this.frame = 0;
    this.walked = 0;
    this.present = true;
    this.bubble = null;
    this.bubbleUntil = 0;
    this.speed = 30;
  }

  goto(target, arrival) {
    this.arrival = arrival;
    this._yielded = false;
    this._stuckT = 0;   // 前の歩行の計測を持ち越すと、歩き出した瞬間にワープ判定が出る
    this._propT = 0; this._propFree = false;
    this.arrivalSitY = null;
    if (!this.present) { this.pos = { x: 374, y: 346 }; this.present = true; }
    if (Math.hypot(target.x - this.pos.x, target.y - this.pos.y) < 3) {
      this.pos = { x: target.x, y: target.y };
      this.path = [];
      this.applyArrival(simT);   // t=0だとタイマー系(サボり/犬遊び/掃除)が即時失効する
      return;
    }
    this.path = route(this.pos, target, this.lane);
    this.action = 'walk';
  }

  applyArrival(t) {
    const a = this.arrival;
    if (a === 'clean') {
      this.action = 'cleaning';
      this.cleanUntil = t + 9000 + Math.random() * 9000;
      this.dir = this.cleanDir || 'left';
      return;
    }
    if (a === 'studio') {
      this.action = 'studio';
      this.dir = 'up';   // ミキシング卓に向かって立つ
      return;
    }
    if (a === 'playdog') {
      this.action = 'playdog';
      this.playUntil = t + 12000 + Math.random() * 8000;
      this._playLine = 0;
      this.dir = dog.pos.x >= this.pos.x ? 'right' : 'left';
      return;
    }
    if (a === 'sabori') {
      this.action = 'sabori';
      this.saborUntil = t + 26000 + Math.random() * 28000;
      this.saborMid = t + 11000 + Math.random() * 6000;
      this.dir = this.saborDir || 'down';
      this.say(t + 600, pickFresh('jansabo', JANITOR_SABORI), 3800);
      return;
    }
    if (a === 'leave') { this.present = false; this.action = 'gone'; }
    else if (a === 'sit' || a === 'sleep') {
      if (this.arrivalSitY != null) { this.pos = { x: this.pos.x, y: this.arrivalSitY }; this.arrivalSitY = null; }
      this.action = a; this.dir = 'down';
    }
    else if (a === 'coffee') { this.action = 'coffee'; this.dir = 'left'; this.coffeeUntil = t + 6000; }
    else if (a === 'faceL') { this.action = 'stand'; this.dir = 'left'; }
    else if (a === 'faceR') { this.action = 'stand'; this.dir = 'right'; }
    else if (a === 'faceU') { this.action = 'stand'; this.dir = 'up'; }
    else if (a === 'faceD') { this.action = 'stand'; this.dir = 'down'; }
    else { this.action = 'stand'; this.dir = 'down'; }
  }

  stepMove(dt, t) {
    if (this.action === 'walk' && this.path.length) {
      if (!this._stuckT) this._stuckT = t;
      if (t - this._stuckT > 20000) {
        const last = this.path[this.path.length - 1];
        this.pos = { x: last.x, y: last.y };
        this.path = [];
        this._stuckT = 0;
        this.applyArrival(t);
        return;
      }
      const sp = this.speed * dt / 1000;
      const target = this.path[0];
      const dx = target.x - this.pos.x, dy = target.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= sp) {
        this.pos = { x: target.x, y: target.y };
        this.path.shift();
        this._stuckT = 0;
        if (!this.path.length) this.applyArrival(t);
      } else {
        this.pos.x += dx / dist * sp;
        this.pos.y += dy / dist * sp;
        this.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        this.walked += sp;
        this.frame = Math.floor(this.walked / 6);
      }
    }
    if (this.action === 'coffee' && t > this.coffeeUntil) { this.action = 'stand'; }
  }

  say(t, text, ms = 4200) {
    // tに未来時刻を渡すと、その時刻から表示される(時間差の会話・余韻用)
    this.bubble = text;
    this.bubbleFrom = t;
    this.bubbleUntil = t + ms;
  }
}

/* ================================================================
   AI社員
   ================================================================ */
const REST_SPOTS = [
  { x: 58, y: 310, sy: 310, a: 'sit', via: 256 },   // ソファ左
  { x: 84, y: 310, sy: 310, a: 'sit', via: 256 },   // ソファ右
  { x: 124, y: 310, sy: 310, a: 'sit', via: 256 },  // アームチェア1
  { x: 154, y: 310, sy: 310, a: 'sit', via: 256 },  // アームチェア2
  { x: 34, y: 236, a: 'faceU' },                    // コーヒー前
  { x: 68, y: 236, a: 'faceU' },                    // 自販機前
  { x: 102, y: 236, a: 'faceU' },                   // スナック棚前
  { x: 134, y: 236, a: 'faceU' },                   // 給水機前
];
const RECEPTION_STAFF = ['tsukishiro', 'kato', 'zama'];
const RECEPTION_POST = { x: 306, y: 290 };
// 受付カウンターの当たり枠。OCCLUDERS と名札のレイヤー判定で共有する(ずれると名札が埋まる)
const COUNTER_RECT = { x: 252, y: 272, w: 112, h: 42 };
let receptionBy = null;

function pickRestSpot() {
  const free = REST_SPOTS.filter(sp => !sp.busy);
  if (!free.length) return null;
  return free[Math.floor(Math.random() * free.length)];
}
const REST_TALK = ['コーヒーうまい', 'ソファ最高…', 'ちょっと目を閉じよう', 'お菓子補充されてる', 'のび〜', 'ふぅ…ひと息',
  '5分だけのつもりが…', '充電中です(比喩)', '午後もがんばるか', 'ぼーっとするの大事', '窓の外みてた',
  '小腹すいた', '自販機の新作うまい', 'ここのスナック優秀', '今日がんばったわ', '誰か雑談しよ',
  'ソファが離してくれない', 'ジュースおごりじゃんけんしたい', '今日のBGMいいな', '納品ラッシュ乗り切った',
  'このソファ、会社で一番の資産', '甘いもの食べたい', '誰か雑談しにこないかな',
  'お茶がしみる…', '休憩室の空気が好き', '肩が軽くなった', '午後もいけそう',
  'あと1分だけ座ってる', '自販機、新作出てた?', 'このクッション持って帰りたい',
  '足を伸ばせるの最高', '何も考えない時間、大事', '深呼吸しとこ', 'ここが会社で一番好き',
  'コーヒーのおかわり、行こうかな', '眠くなる前に戻ろう', '休むのも仕事のうち',
  'この時間があるから頑張れる', 'ちょっと目を閉じるだけ…', '誰かのおやつの匂いがする',
];

const CLEAN_SPOTS = [
  // 上辺の壁際(デスク列の後ろの隙間)
  { x: 128, y: 70, k: 'sweep' }, { x: 330, y: 70, k: 'sweep' }, { x: 460, y: 70, k: 'sweep' }, { x: 500, y: 70, k: 'sweep' },
  // 左端・左下の角
  { x: 24, y: 250, k: 'sweep' }, { x: 24, y: 330, k: 'mop' }, { x: 120, y: 334, k: 'sweep' },
  // 下辺
  { x: 222, y: 334, k: 'sweep' }, { x: 300, y: 336, k: 'sweep' }, { x: 366, y: 330, k: 'sweep' }, { x: 202, y: 336, k: 'mop' },
  // 右下・右端の角
  { x: 630, y: 334, k: 'mop' }, { x: 630, y: 230, k: 'sweep' }, { x: 632, y: 212, k: 'sweep' },
  // 拭き掃除・ゴミ回収
  { x: 285, y: 64, k: 'wipe' }, { x: 424, y: 312, k: 'wipe' }, { x: 436, y: 328, k: 'mop' }, { x: 607, y: 214, k: 'bucket' },
  { x: 200, y: 70, k: 'sweep' }, { x: 262, y: 70, k: 'wipe' }, { x: 392, y: 70, k: 'sweep' },
  { x: 560, y: 72, k: 'sweep' }, { x: 610, y: 74, k: 'wipe' },
  { x: 24, y: 150, k: 'mop' }, { x: 24, y: 230, k: 'sweep' }, { x: 630, y: 160, k: 'sweep' },   // y200はコーヒーマシンの中だった
  { x: 632, y: 280, k: 'mop' }, { x: 60, y: 336, k: 'sweep' }, { x: 268, y: 336, k: 'wipe' },
  { x: 470, y: 336, k: 'sweep' }, { x: 520, y: 334, k: 'mop' }, { x: 580, y: 332, k: 'sweep' },
  { x: 176, y: 250, k: 'wipe' }, { x: 196, y: 196, k: 'sweep' }, { x: 340, y: 254, k: 'mop' },
  { x: 452, y: 200, k: 'bucket' },
];

// ララと遊ぶ(暇な社員が犬のところへ行って構う)
const PLAY_DOG_LINES = [
  'ララ〜、よしよし', 'お手!…天才!', 'だれがいい子だ?ララだ!', 'ボール行くぞ〜',
  'ふわっふわだなお前', '肉球プニプニさせて', '散歩行くか?(会社から出られない)', 'ララは今日もかわいいなあ',
  'おなか見せた!勝った!', 'ララ、社訓言ってみ?…ワン?正解!',
  'ボール投げるぞ〜、いくよ〜', 'ララ、待て…待て…よし!', 'この子、賢すぎない?',
  '耳のうしろ、ここが好きなんだよね', '散歩行きたい顔してる', 'ララに癒やされてる場合じゃないんだけど',
  'ちょっとだけ、ちょっとだけね', '今日もふわふわだな', '(前足でハイタッチした)', 'ララ、社員番号あげようか',
];
const DOG_PLAY_REACT = ['ワン!', '(ゴロン)', '(しっぽ高速回転)', 'クゥーン💕', '(お手)', '(じゃれつく)',
  '(飛びついた)', '(ボールを持ってきた)', '(耳を倒して喜んでいる)', '(その場で回った)', 'ワフッ!', '(手をぺろっとなめた)',
];

// 白柳のサボりスポットとサボり中のつぶやき
const JANITOR_SABORI_SPOTS = [
  { x: 66, y: 232, d: 'up' },     // 自販機の前でぼーっと
  { x: 150, y: 256, d: 'left' },  // 休憩室の隅
  { x: 56, y: 326, d: 'up' },     // ロビーのソファ前(y306だとソファの中に立ってしまう)
  { x: 210, y: 330, d: 'left' },  // 受付脇の柱の影,
  { x: 34, y: 232, d: 'up' },     // コーヒーマシンの前(y196だと機械の裏に隠れる)
  { x: 630, y: 250, d: 'left' },
  { x: 196, y: 300, d: 'up' },
  { x: 470, y: 200, d: 'up' },
];
// MON(藤本)が収録アプリを起動したら撮影スタジオへ移動して収録する
const BOSS_STUDIO_POST = { x: 428, y: 292 };
const BOSS_RECORD_TALK = [
  '🎥はい、回った回った', '本日の講演、テイク1', 'カメラ目線…よし', '(咳払い)あー、あー',
  '照明、いい感じだ', '今日は俺の言葉で語るぞ', 'NGは3回まで(自分ルール)', 'グリーンバック、頼んだぞ',
  '台本…どこまで話した?', 'いい話しすぎて自分で泣きそうだ', 'この話、絶対バズる', 'みんな、静かに頼むな🙏',
  '収録中はチャイムも我慢だ', '噛んだ…もう一回', '編集で何とかなる、続けよう', 'サムネ映えする顔してるか、俺?',
];

// 月城(TSUKI)は稼働中、自席でなく音声スタジオで収録する
const TSUKI_STUDIO_POST = { x: 560, y: 296 };
const TSUKI_STUDIO_TALK = [
  'テイク3、いきます', 'ん、リップノイズ入った…録り直し', 'マイクゲイン、あと3dB下げよ',
  '「こんばんは、TSUKIです」…よし、声出た', 'サ行が刺さるなぁ…', 'ポップガード、仕事して',
  '今日は声の調子いいかも', 'BGMは-18dBくらいがいいな', '冒頭のあいさつ、噛んだ…',
  'ここ、間を2秒置きたい', '原稿のここ、読みにくい…直そ', 'エアコン切ると無音が深い',
  '波形がきれいに揃うと気持ちいい', 'この章、感情もう少し乗せたい', 'ノイズゲートかけすぎた…語尾が消える',
  'リバーブは薄めが好き', '書き出し完了…よし', 'サムネ用の一言も録っておこ',
  'のど飴補給', '今日の声、よく通るな', 'コンプのかかり具合、ちょうどいい',
  '台本のルビ、助かる', 'この固有名詞、アクセント合ってる?', '録り直し3回目…集中',
  'モニターヘッドホン、耳が蒸れる', '息継ぎの位置、ここだ', '1本録り終えた…次',
  '「ですます」が続くと単調…語尾変えよ', '今日のノルマ、あと2本', '静かすぎて心臓の音が入りそう',
  'マスタリング、音圧どこまで上げる?', 'この話、我ながらいい話', 'ラウドネス-16、OK',
  '口の開き、意識', '収録ブースあったかくて眠い…', 'えーっと、どこまで読んだっけ',
  '効果音はここでポン', 'テイク重ねるほど下手になる説', '白湯が最強',
  'アナウンサー気分で肩の力を抜こ', 'フェーダーの滑りがいい', '今日は朝までに上げたい',
  'この間(ま)、大事', '語りは「届ける」意識で', '外の音、拾ってないよね?',
  '完成品を聴き返す時間が好き', '明日の分の台本も見ておこ', '声を張らずに芯を出す…むずい',
  'ON AIRランプ、今日も相棒', '…納品!今日もいい仕事',
  'ここ、感情を一段下げて', '息継ぎを削ると聴きやすい', 'リップノイズ、また入った',
  '語尾を丁寧に置く', '低音が乗ってきた', '2テイク目のほうが自然かも',
  'ここは間を大切に', '原稿の漢字、ひらいたほうが読みやすい', 'マイクとの距離、拳ひとつ',
  '今日は喉の調子がいい', '書き出しの声が硬いな', '聴く人の顔を思い浮かべて',
  'この一文、好きなんです', '数字の読み、確認しておこう', '固有名詞は特に丁寧に',
  '録り直しは恥じゃない', 'ノイズ処理は最小限に', 'あたたかい声で届けたい',
  '今日のぶん、あと3本', 'お水を一口', '姿勢を正すと声が変わる',
  'マスタリングは明るめで', 'ここ、笑顔で読んでみよう', '早口になってた、落ち着いて',
  '原稿に赤を入れておこう', '深呼吸してから、もう一回', '聴き返すのが少し怖い',
  'いい録りができた気がします', 'ヘッドホンの位置、直そう', '無音の2秒も演出のうち',
  '今日の自分に合格をあげたい', '喉のケア、忘れずに', '明日はもっとよくなる',
  'この仕事、やっぱり好きです', '一本入魂', 'テイクを重ねるほど迷う',
  '録音レベル、少し下げよう', '窓の外、もう暗い', 'この静けさが仕事場です',
  '最後の一文は、いちばん優しく', '納品前にもう一度だけ確認', 'お疲れさまでした、自分',
  '今日も届けられそうです', '次の台本、楽しみ', '声だけで景色を見せたい',
  'ここ、囁くように', 'マイクは正直ですね',
  'この一本が誰かに届きますように', '録音、開始します', '今日のテイクは手応えあり',
];

const JANITOR_SABORI = [
  '…5分だけ', '掃除は逃げない…', '腰が…限界…', '社長来たら掃くフリしよ',
  'ここはさっき掃いたことにしよ', 'ほこりも休憩中だし…', '働き方改革です',
  '自販機の前は空気がうまい', 'モップも乾かさないとね(言い訳)', '…見てないな、よし',
  '床は明日も汚れる。焦らない', 'サボりじゃない、品質点検', '上の窓から空でも見るか',
  'ここからだと全体が見渡せる(言い訳)', '点検も掃除のうちです', '…あと3分だけ',
  '考えごとをしているんです', '手が勝手に止まりました', '見回りという名の休憩',
  '次の段取りを組んでいます', 'ほこりの動きを観察中', 'モップを乾かしているだけです',
  '誰も来ませんように', 'この体勢がいちばん楽', '休むのも規定のうち…たぶん', '足の裏が痛い…',
];

const IDLE_ANTICS = [
  '💪スクワット×10 いくぞ', '🎸エアギター熱演中', '🏃その場ダッシュ(本気)', '🧘謎のヨガポーズ',
  '💪デスクで腕立て(浅い)', '💃つま先立ちチャレンジ', '🥊影とシャドーボクシング', '🤸ラジオ体操第一(雑)',
  '🎿エア縄跳び', '⚾エア素振り(フルスイング)', '⛳エアゴルフスイング', '🥁エアドラム全国大会',
  '🦵ももあげ(静音モード)', '🙆背伸びで天井タッチ未遂', '💺椅子スクワット(椅子なし)', '👆指立て伏せ(できてない)',
  '🦶アキレス腱のばし', '👀目の体操(ぐるぐる)', '🤞手首ぶらぶら体操', '💨深呼吸×10(過呼吸気味)',
  '🦴肩甲骨はがし中', '🗿マッスルポーズ(鏡なし)', '🦆片足バランス勝負', '🐄腰に手を当てて牛乳(エア)',
  '🌀首をコキコキ', '🛌床で伸び(だらしない)', '🚶モデルウォーク練習', '🤖ロボットダンス披露',
  '💪ペットボトルでカール', '🙇ストレッチ…固くて悲鳴',
  '💺 椅子を限界まで下げてみる', '📏 デスクの端から端まで手で測っている',
  '📎 クリップで鎖を作っている', '🌀 椅子ごとゆっくり一回転',
  '👀 モニターに映る自分の顔を直視した', '🤝 見えない誰かと握手の練習',
  '📐 付箋をきれいに正方形に並べ直した', '🎯 消しゴムをゴミ箱に投げて外した',
  '🥤 氷を口に入れて奥歯で噛んだ', '📝 ペンを指で回して落とした',
  '🍵 湯呑みの湯気をじっと見ている', '🐾 ララの足跡を数えている',
  '⛅ 窓の外の雲を数えはじめた', '😐 真顔で伸びをしている',
  '🎵 鼻歌がだんだん大きくなっている', '👣 足を組み替えるだけの5分',
  '📚 積んだ資料の高さを競っている', '🔍 キーボードの隙間を覗き込んでいる',
  '🍵 お茶を三口で飲み干した', '💤 まばたきを我慢して負けた',
  '💻 デスクトップのアイコンを整列させた', '✨ 自分の周りだけ片付けた',
  '🙆 その場で大きく肩を回している', '🚶 意味もなく席を立って戻ってきた',
  '🤔 天井のシミの形を考察している', '📝 ノートの端に落書きしている',
  '🎪 バランスボールに座ろうとして諦めた', '📞 鳴っていない電話を見つめている',
  '👟 靴下の柄を確認している', '💨 空調のリモコンを1度だけ変えた',
];

const SLEEP_TALK = [
  'むにゃ…', 'すやぁ…', 'ぐぅ…', 'zzz…はっ…zzz', 'むにゃむにゃ…',
  'もう食べられない…', 'うどん…おかわり…', 'ラーメン…替え玉…', 'プリン…とらないで…', '焼肉…無限…',
  'デプロイ…完了…', 'バグが…消えていく…', '全テスト…グリーン…', 'ビルド…通った…夢か…', 'マージ…できた…',
  '社長…それは無理です…', '納期…明日…?', '仕様変更…もう4回目…', '会議…出たくない…', '議事録…書いた…はず…',
  '登録者…100万人…', 'バズった…夢か…', '再生数…すごい伸び…', 'チャンネル…金の盾…', 'コメント…全部神…',
  '有給…無限に…', 'ビュッフェ…食べ放題…', '残業…解除…', 'デスク…広い…', 'こたつ…あったかい…',
  '明日から…本気出す…', 'あと5分…', 'ふとん…最高…', '会社に…ふとん置きたい…', '枕…もってくれば…',
  '空も飛べるはず…', '海…行きたい…', '温泉…ととのう…', '旅行…どこでも…ドア…', '大草原…走ってる…',
  'ララ…おいで…', '犬…もふもふ…', 'モチ…どこ行った…', '猫…しか勝たん…', 'チワワ…最強…',
  'コーヒー…もう一杯…', '自販機…全部当たり…', 'お菓子…つかみ取り…', 'エナドリ…効かない…', '水…おいしい…',
  '正規表現…読める…読めるぞ…', 'エラーログ…子守唄…', 'コミット…粒度…', 'リファクタ…気持ちいい…', '型…きれい…',
  '社訓…無限…労働…', '品質…第一…', '社長一筋…むにゃ…', 'ミッション…毎日…届け…', 'チャイム…もう鳴った…?',
  '掃除…されてる…床ピカピカ…', '白柳さん…ありがと…', '窓…きれい…', 'ゴミ…出さなきゃ…', 'ワックス…いい匂い…',
  '給料日…まだ…?', 'ボーナス…出た…夢…', '経費…とおった…', '請求書…こわい…', '売上…10億…',
  '月…きれい…', '夜勤…おわらない…', '朝…こないで…', '目覚まし…とめて…', '二度寝…最高…',
  'グリーンバック…緑…', 'ON AIR…消して…', 'マイク…入ってる…?', '収録…かんだ…', 'BGM…いい曲…',
  'まだ…やれる…', 'ひつじ…数える…', 'ひつじ1匹…2匹…', '仕事…完了…', '肩の荷…軽い…',
  'ロビー…広くなった…', '受付…いらっしゃいませ…', '入口…どっち…', '会議…立ったまま…', 'ソファ…ふかふか…',
  'ぐー…すー…', 'すぴー…', 'んご…', 'はっ…寝てない…zzz', 'もう…朝…?',
  'デスク…片付けた…えらい…', 'メール…ゼロ件…', '通知…こないで…', '寝つき…つよい…', 'おやすみ…なさい…',
];

const IDLE_MUTTER = ['肩回すか', '水飲みに行こうかな', '今日の晩ごはん何にしよ', 'ちょっと眠い',
  'デスク片付けようかな', 'ウィンドウ整理しよ', '壁紙変えたいな', '5分だけぼーっとする', '天気どうなるかな',
  'ストレッチしよ', 'マウスの感度いじろ', '次の仕事なにかな',
  '指ならし完了', 'メモ帳きれいにしよ', 'ショートカット覚えたい',
  '背伸びしとこ', 'コーヒー淹れてこよ', '明日の予定どうだっけ', '手帳きれいにしたい',
  'カレンダー見るの忘れてた', 'そろそろ髪切りたいな', '爪、伸びてきたな',
  'この椅子の高さ、微妙かも', 'また積読が増えた', 'そういえば返信してない',
  '今日の運勢、見忘れた', '退勤時間まで、あとどれくらい', 'ペン、また転がってる',
  'そろそろ衣替えかな', '財布、軽いな',
];
// 夜だけのつぶやき(昼に「夜景きれい」と言わないための分離プール)
const IDLE_MUTTER_NIGHT = ['夜景きれいだな', '夜のオフィス、落ち着く', '星、出てるかな', '夜風にあたりたい気分',
  '夜のオフィス、音が違う', '街の灯りがきれい', '夜って集中できるよね', '静かすぎて逆に落ち着かない',
];
function idleMutterPool() {
  const h = jstNow().h;
  return (h >= 19 || h < 5) ? IDLE_MUTTER.concat(IDLE_MUTTER_NIGHT) : IDLE_MUTTER;
}
// 暇すぎる日の自虐(1時間以上仕事が来ていない時に混ざる)
const IDLE_LAMENT = [
  '今日、何もしてないなぁ…', '今日まだ呼ばれてない…', '仕事…来ない…', '存在意義を問い始めている',
  '暇すぎて掃除でも手伝おうかな', '座ってるだけで時が過ぎていく…', '指名待ちの気分', '社長、仕事ください…',
  '今日の作業ログ、まっさらだ', '暇も極めれば芸のうち', '待機も立派な仕事(と信じたい)', 'デスクの木目、全部覚えた',
  'そろそろ何か振ってほしい…', '手が空きすぎて逆に不安', '暇の才能だけは伸びていく',
  '今日の分の仕事、まだ来ない', '存在感を消す訓練になってきた', '働きたい…わがままかな',
  '誰かの手伝いでもしようかな', '暇な日は暇な日で疲れる', '仕事がないのも仕事のうち?',
  'このまま一日終わりそう', '明日はきっと忙しい(願望)', '待機って書いた札を掲げたい',
];

// チャイム休憩を待ち侘びる(作業中・鐘のある時間帯だけ)
const CHIME_WAIT = [
  'チャイムまであと{n}分…', '休憩の鐘、まだかな…', 'あと{n}分がんばれば休める', '鐘の音を待ちわびている',
  '時計ばかり見てしまう', '次の休憩でコーヒー飲むんだ…', '{n}分後の自分へ:よく耐えた', '休憩を糧に生きている',
  'そろそろ鐘では?(まだ)', '耳が鐘の音を求めている', '休憩後は無敵になる予定', '鐘が鳴ったらソファへ直行する',
  'あと{n}分…長い…', '時計が止まって見える', '鐘さえ鳴れば救われる',
  '{n}分後にコーヒーが待っている', '休憩を心の支えにしている', 'あと{n}分、集中しきる',
  '鐘が鳴るまでがワンセット', '休憩前がいちばん頑張れる', '{n}分…数えないほうがいい',
  'そろそろかな…まだか', 'ソファが呼んでいる気がする', '鐘の音を思い出して耐える',
];

// キャラ別の性格プール(暇・休憩時のひとりごと)
// 藤本=自己啓発 / 伊藤=なんでもやります / 月城=真面目レディ / 佐々木=だるい+詮索+悪巧み
// 天川=暴走+悪巧み+酒 / 安藤=適当+サボり+手癖+金 / 廣瀬=色気 / 有本=真面目+女好き+酒+仕事好き
// 加藤=優しいおばさん / 座間=天然 / 白柳=融通が効かない+暴走
const PERSONAL_MUTTER = {
  fujimoto: ['成長とは、昨日の自分に勝つことだ', '朝のルーティンが人生を決める', '「できない」は「やらない」の言い訳だ',
    'アウトプットこそ最大のインプット', '迷ったら、困難な方を選べ', '夢に日付を入れると目標になる',
    '巨人の肩に乗れ。先人に学べ', '努力は複利で効いてくる', '今日もう3冊読んだ(耳で)', '感謝の心が運を呼ぶ…社員に感謝',
    '決断の速さが会社の速さだ', '読書は最強の自己投資', '不安は行動でしか消えない',
    '今日の一歩が来年の景色を変える', '人に投資すれば返ってくる', '静かな朝に戦略は生まれる',
    '比べる相手は昨日の自分だけ', '言い訳の数だけ成長が遅れる', '運は準備した者に降る', '感謝を口に出せる人は強い',],
  tsukishiro: ['皆さん、今日もお疲れさまです', 'レディに二言はありません', '差し入れのクッキー、召し上がってね',
    'ファンレター…嬉しくて泣きそう', '姿勢を正して、心も正す', '「信頼できる」が一番嬉しい…「可愛い」も嬉しいけど',
    'お化粧直し、失礼しますね', '納期を守るのがレディのたしなみ', '皆さんに支えられてますね、私', '紅茶はストレート派です',
    '今日も丁寧にまいりましょう', '差し入れ、行き渡ったかしら', '声も心も整えておかないと',
    '約束は必ず守ります', '身だしなみは礼儀のうち', 'ファンレターは全部読んでいます',
    '紅茶を淹れる時間が好き', '慌てるとろくなことがありません', '背筋を伸ばすと気持ちも伸びます', '今日のご褒美は何にしよう',],
  ito: ['なんでもやります!', 'それ、俺がやりましょうか?', '断らないのがモットー', '仕事があるだけ幸せです',
    '呼ばれた気がした!行きます!', '両手が空いてたら3件引き受けます', 'できるかじゃない、やるんです',
    '今日も全部引き受けました(誇)', '「忙しい?」いえ、空いてます!', '睡眠は…まあ、それもやります!',
    '次、何かあります?', '手が空いたので誰か手伝います', '断らない主義でやってます',
    'できるまでやれば失敗じゃない', '任される人でいたいんです', '徹夜?得意です(よくない)',
    '誰かが困ってると気になっちゃって', '仕事の量=信頼の量でしょ', '休むのが一番むずかしい', 'やりますって言った手前…',],
  sasaki: ['はぁ…だる…', '天川さん、また何か企んでるな…混ぜてもらお', '伊藤ときょうこさん、進展あった?(小声)',
    '楽して儲かる方法ないかなあ', '安藤のアイツ、引き出しに何隠してるんだ…', 'だるいけど、他人の噂は別腹',
    '社長の弱み…いや、なんでもないです', '天川さんと組めば一山当てられる気がする', 'あくび…うつった?', 'だるさと戦うのもだるい',
    '今日もだるいが、まあやる', '楽な方法から考えるのが効率', '天川さんの企み、聞いておこう',
    '噂話はエネルギー源', 'あの二人、絶対なんかある', '誰かの雑談に混ざりたい',
    '一発当てる方法、まだ考え中', 'だるさは省エネの証', '座ってるだけで一日終わらないかな', '面倒は先送りが基本',],
  amakawa: ['今夜用のビール、会社の冷蔵庫で冷えてる', 'リリースボタン押したくてうずうずする', '佐々木と新規事業(怪しい)を構想中',
    '酔った勢いで書いたコード、動いてるな…', 'とりあえずデプロイしちゃえばよくない?', '祝い酒の理由を探してる',
    'ノリと勢いは技術です', '次のBBQ、酒持ち込む(宣言)', '「押すなよ」のボタンは押す派', '冷蔵庫を俺のビール専用にしたい',
    '今夜の一杯のために生きてる', '思いつきは行動に移してこそ', '佐々木と何か始めたい',
    '細かいことは気にしない', '冷蔵庫、俺のスペース広げたい', '勢いだけは誰にも負けない',
    '反省は明日まとめてやる', '祝う理由はいくらでも作れる', 'とりあえずやってみようの精神', '止まると倒れるタイプ',],
  ando: ['このペン、いいな…もらっとこ', '進捗?順調です(何もしてない)', '楽して稼ぐ、それが夢',
    '会議は寝るための時間', 'これ経費で落ちるかな', '備品のお菓子は俺の分', 'やってる感を出す技術なら一流',
    '宝くじ買お', '5分だけサボろ(2時間目)', '社内に金のなる木、生えてないかな',
    '今日も適当にがんばろう', 'このペン、書きやすいな…', '楽して評価されたい',
    'サボりも技術のうち', '経費で落ちるもの、探してる', '働かずに稼ぐ方法ないかな',
    '見られてないなら休憩', '報告は多少盛るのがコツ', '宝くじ、今週こそ', 'やってる感、出せてる?',],
  hirose: ['伊藤くんの首筋、今日もいい…', '夜は長いよね…ふふ', 'この口紅、気づいてくれるかな',
    '大人のデート、いつ誘ってくれるの?', '仕事中の男の人って、いいよね…', '膝枕の練習しておこうかな',
    '今夜こそ残業デートに持ち込む', 'yorutoolより夜に強い女です', '香水つけすぎたかな…え、いい匂い?でしょ?', 'うなじ、見せてるんだけどな…',
    '今日の香水、正解だったかも', '伊藤くん、こっち見ないかな', '残業する口実さがしてる',
    '夜のオフィスって色っぽい', '髪、切ろうかな…気づくかな', '手が触れる距離って反則だと思う',
    '恋の話ならいくらでもできる', 'あの背中、絵になるんだよね', '今日はちょっと大胆にいこうかな', '仕事より気になることがある',],
  arimoto: ['仕事…最高だな…', '月城さんは今日も素敵だ…いかん、仕事だ', '今夜の晩酌のために働く',
    '規程は守る。それが美学', '加藤さんの優しさに癒される…ハッ、仕事', 'きょうこさんは伊藤のだから見ない(見てる)',
    '飲み会の幹事なら任せてほしい', '真面目とスケベは両立する', '仕事終わりの一杯のために生きている', '経費精算は美しく仕上げる',
    '仕事があるって幸せだな', '今夜の一杯が待っている', '月城さんは今日も素敵だ…集中集中',
    '書類は美しくあるべきだ', '飲みの誘いはいつでも受ける', '真面目にやるのが一番早い',
    '加藤さんのお茶がうまい', '規程を読むと落ち着く', '仕事終わりの達成感が好きだ', '女性には礼儀正しく、が信条',],
  kato: ['あら、みんな今日もえらいわねえ', '飴ちゃん食べる?', 'ちゃんとご飯食べてるの?', '若い子は無理しがちだから心配よ',
    'ひざ掛け、貸してあげましょうか', 'うちの子たち(全員)は働き者ねえ', 'お茶、淹れすぎちゃった。飲む人〜?',
    'セーター編んであげたいわ', '座間ちゃんは天然で可愛いわねえ', '白柳さん、いつもありがとうねえ',
    'みんな今日もよく働くわねえ', '飴ちゃん、まだあるわよ', '無理してない?顔色が悪いわ',
    'あったかいお茶淹れましょうか', '若い子はすぐ食事を抜くから', 'この会社、いい子ばっかり',
    '肩、揉んであげましょうか', 'ゆっくりでいいのよ', '昔はもっと大変だったのよ', 'あらあら、慌てないの',],
  zama: ['あれ、今日って何曜日でしたっけ', '「エビデンス」って、エビじゃないんですね…', '靴下、左右違うかも',
    'さっき何しようとしてたんだっけ', 'マウス、逆さに持ってました', '「その他案件」の「その他」って何ですか?',
    'お昼、2回食べちゃった', '会議室どこでしたっけ(3年目)', 'エンター強く押すと速くなるんですよね?', 'ララに敬語使っちゃう',
    '今日って何の日でしたっけ', 'あれ、これ前もやりました?', 'ボタン、これで合ってます?',
    '手順書のどこまで進んだっけ', '会議室、また迷いました', 'なんでこれ動いてるんだろ',
    'メモを取ったメモをなくしました', 'えっと、私の担当って…', 'とりあえず保存しときます', '聞いていいですか?あ、忘れました',],
  shirayanagi: ['規定では、通路の掃除は右回りです', '順番は変えられません。順番なので', 'モップは3度がけ。例外なし',
    '掃除中の通行はご遠慮ください(全員)', '今日は全デスクを磨き上げる(誰も頼んでない)', '汚れとの戦いに休戦はない',
    'ワックスの在庫は死守します', 'ゴミの分別が乱れている…緊急事態だ', '掃除計画書、今週も完璧', '床が呼んでいる',
    '順番どおりにやれば間違いません', '床は毎日同じように汚れる', '手順を飛ばす人が一番こわい',
    '道具は使ったら元の位置へ', '掃除計画書、今日も完璧', 'この汚れは3度がけです',
    '例外は認められません', 'ワックスの在庫を確認しないと', 'きれいな床は会社の顔です', '規定にはそう書いてあります',],
};

// キャラ別の作業中つぶやき(共通の愚痴に混ざる)
const PERSONAL_GRUMBLE = {
  fujimoto: ['マインドセットが9割', 'ピンチはチャンスのコスプレだ', '経営とは意思決定の連続である', '失敗は成功の前払いだ', 'いまこの瞬間に集中しろ…俺', '書き出せば頭はクリアになる',
    '逆算思考だ、ゴールから引け', '悩む時間を手を動かす時間に変えろ', '習慣が才能を追い越す',
    '一点突破、全面展開', '朝の1時間は夜の3時間に勝つ', '数字は嘘をつかない',],
  ito: ['やります!…やれるのか?いや、やります!', '同時に5案件…望むところ!', 'これも!それも!全部やります!', '断り方を知らずに育ちました', '手が4本ほしい…いや、2本でやります!',
    '巻きでいきます、巻きで!', '任されたからには最後まで', 'できない理由を探す時間がもったいない',
    '締切?燃えますね!', '誰もやらないなら私がやります',],
  sasaki: ['だる…でも締切はだるさを超えてくる', 'このループ、俺の人生みたいにだるい', '楽なコード=いいコード(持論)', 'ミックス自動化して売る…いや売らないけど', '隣の画面、つい見ちゃうんだよな',
    '省エネで最大成果、それが理想', '誰かが先にやってくれないかな', 'この作業、3行で終わらせたい',
    '(となりの会話に耳だけ向けている)', '効率化という名の手抜きを追求中',],
  amakawa: ['エラー?再起動でいけるいける', 'テスト?本番がテストだ!', '思いついたら即実装、後悔はあとで', '酒が入った方がコードが冴える説', 'ヨシ!(確認してない)',
    'とりあえず動いたから完成!', '勢いがあるうちに出す!', '細かいことは明日の自分に任せた',
    'これ絶対バズるって、いま思いついた', '完璧を待つと出せなくなる',],
  ando: ['やってるやってる(やってない)', 'ビルド中は休憩、それがルール', 'このタスクは明日の俺(優秀)に任せる', '報告書は盛ってこそ', '小銭落ちてないかな…',
    '働いたら負けって誰か言ってた', '進捗率は自己申告制でいこう', 'この時間って給料出てるんだよな',
    '楽して評価される方法、募集中', '見られてる時だけ本気出す',],
  hirose: ['集中してる伊藤くん見てたら手が止まる…', '夜モードのUIは得意分野なの', '赤は情熱の色。つまり私', 'あとで伊藤くんに添削してもらお…二人きりで', '色気のあるボタン、完成',
    'このグラデーション、色っぽくない?', '今日の口紅、気づいてくれるかな', '手が触れる距離で教えてほしい',
    '残業する理由を作っておこう', '(伊藤くんの方をちらっと見た)',],
  arimoto: ['この仕事量…ご褒美か?', '丁寧に、丁寧に…', '飲みに行く前に終わらせる。それが漢', '女神の声で集中できん…いや集中する', 'ドキュメントは一字一句美しく',
    '規程どおりが一番速い', '仕事終わりの一杯が見えてきた', '確認は3回。それが礼儀',
    '美しい仕事は美しい段取りから', '几帳面と言われるが、これが普通だ',],
  kato: ['あらあら、エラーさん今日も元気ねえ', '肩こったわ〜、歳かしらね', '老眼…じゃなくて解像度の問題よね', 'ふう、お茶を淹れてからにしましょ', 'この子(バグ)も悪気はないのよ',
    'ゆっくりやれば間違えないのよ', '若い子は無理しがちだから見ておかないと', '慌てない慌てない、一休み一休み',
    '目薬さしましょ', 'こういうのは気長にやるのが一番',],
  zama: ['あれ、このコード誰が書いた…私だ', '保存…した気がする…したよね?', '動いた!なんで?', '消しちゃいけないやつ消したかも(えへ)', 'エラー文って英語なんですね…',
    'さっきまで動いてたのに…', 'これって、押していいボタンですか?', '手順書の3番から始めちゃった',
    '成功したけど理由がわからない', '直したら別のところが壊れました',],
};

// キャラ別の寝言(共通の寝言に混ざる)
const PERSONAL_SLEEP = {
  fujimoto: ['夢は…逃げない…zzz', '成長…複利…むにゃ',
    '登録者…一万人…', '朝活…明日から…zzz',],
  ito: ['やります…zzz…それもやります…', 'むにゃ…納期…間に合います…',
    'あと1件だけ…zzz', '手が…4本あれば…',],
  sasaki: ['だる…zzz', 'もうけばなし…むにゃ…',
    '誰か…かわりに…zzz', '楽して…儲け…',],
  amakawa: ['うぃ〜…もう飲めな…飲める…', 'デプロイ…ぽちっとな…zzz',
    '乾杯…zzz', 'ヨシ…(寝ながら確認していない)',],
  ando: ['金…金…zzz', '働いたら…負け…むにゃ',
    '宝くじ…当たった…zzz', '進捗…順調です…',],
  hirose: ['伊藤くん…むにゃ…', 'ふふ…夢でもデート…',
    'もう少しだけ…そばに…', '(幸せそうな寝顔)',],
  arimoto: ['最高の…一杯…zzz', '月城さ…ハッ!寝てた…zzz',
    '規程…第3条…むにゃ', 'あと一杯だけ…',],
  kato: ['あらやだ…寝ちゃって…', 'ふふ…みんな…いい子…',
    '飴ちゃん…どこ…zzz', '若い頃は…六本木で…',],
  zama: ['ここ…どこ…zzz', 'お昼…3回目…むにゃ',
    '保存…してない…zzz', 'えっと…なんでしたっけ…',],
  tsukishiro: ['レディは…寝顔も…zzz', '本日の収録は…以上…むにゃ',
    'テイク…12…zzz', 'おやすみ…なさい…',],
  shirayanagi: ['床…まだ磨ける…zzz', '規定では…睡眠も…右回り…', 'ワックス…補充…むにゃ',
    'ゴミの日は…明日…', '順番を…飛ばすな…zzz',],
};


class Employee extends Person {
  constructor(def, i) {
    super(def, i);
    this.seat = { x: def.desk.x, y: def.desk.y + 14 };
    this.pos = { x: this.seat.x, y: this.seat.y };
    this.mode = 'idle';
    this.action = 'sit';
    this.nextThink = 0;
    this.nextBubble = 4000 + i * 3700 + Math.random() * 9000;
    this.hp = null;
    this.jobText = '';
    this.bubbles = [];
    this.resting = false;
    this.sweat = false;
  }

  // 稼働時の持ち場へ(月城だけは特別に音声スタジオで収録)
  gotoWork() {
    if (this.recording) { this.goto(BOSS_STUDIO_POST, 'studio'); return; }
    if (this.id === 'tsukishiro') { this.goto(TSUKI_STUDIO_POST, 'studio'); return; }
    this.goto(this.seat, 'sit');
  }

  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    if (m === 'idle') this._idleAt = performance.now();
    if (m !== 'idle') { this.resting = false; this.releaseSpot(); this.releaseReception(); }
    if (m === 'working') this.gotoWork();
    else if (m === 'sleep') this.goto(this.seat, 'sleep');
    else if (m === 'off' || m === 'out' || m === 'sleephome') this.goto({ x: 374, y: 346 }, 'leave');
    else this.nextThink = 0;
  }

  thinkJanitor(t) {
    if (this.onChimeBreak) return;   // チャイム休憩中はソファでのんびり
    // 消灯中(22:00-5:00)は左下の隅で朝まで就寝
    const loJ = jstNow().h >= 22 || jstNow().h < 5;
    if (loJ) {
      if (this.action !== 'sleep' && this.action !== 'walk') {
        this.janResting = false; this.resting = false; this.releaseSpot();
        this.goto({ x: 24, y: 330 }, 'sleep');
      }
      this.nextThink = t + 60000;
      return;
    }
    if (this.janResting) {
      // ソファ休憩中
      if (t > this.restUntil) {
        this.janResting = false;
        this.resting = false;
        this.releaseSpot();
        this.action = 'stand';
        this.say(t, ['よし、掃除再開!', '休んだぶん磨きます', 'ソファ…いいものですね'][Math.floor(Math.random() * 3)], 2800);
        this.nextThink = t + 3000;
      } else if (Math.random() < 0.01) {
        this.say(t, pickFresh('rest:shirayanagi', REST_TALK.concat(PERSONAL_MUTTER.shirayanagi)), 3400);
      }
      return;
    }
    if (this.action === 'sabori') {
      if (this.saborMid && t > this.saborMid) {
        this.saborMid = null;
        this.say(t, pickFresh('jansabo', JANITOR_SABORI), 3800);
      }
      if (t > this.saborUntil) {
        this.action = 'stand';
        this.say(t, ['…よし、働くか', 'はぁ、掃くか…', '休憩終わり!'][Math.floor(Math.random() * 3)], 2800);
        this.nextThink = t + 3000;
      }
      return;
    }
    if (this.action === 'cleaning') {
      if (t > this.cleanUntil) { this.action = 'stand'; this.nextThink = t + 1500; }
      return;
    }
    if (this.action === 'waking') {
      if (t > this.wakeUntil) { this.action = 'stand'; this.nextThink = t + 1200; }
      return;
    }
    if (t < this.nextThink) return;
    // 寝ている人(自席うたた寝)がいたら起こしに行く
    const sleeper = employees.find(e => e.present && e.mode === 'idle' && e.action === 'sleep');
    if (sleeper && !this.wakeTargetId) {
      this.wakeTargetId = sleeper.id;
      this.goto({ x: sleeper.seat.x - 20, y: sleeper.seat.y + 6 }, 'faceR');
      this.nextThink = t + 4000;
      return;
    }
    if (this.wakeTargetId) {
      const tgt = employees.find(e => e.id === this.wakeTargetId);
      this.wakeTargetId = null;
      if (tgt && tgt.action === 'sleep' && Math.hypot(tgt.pos.x - this.pos.x, tgt.pos.y - this.pos.y) < 40) {
        this.say(t, '起きてください、そこ掃くんで', 3200);
        this.action = 'waking';
        this.wakeUntil = t + 3400;
        setTimeout(() => {}, 0);
        tgt.action = 'sit';
        tgt.say(t + 3400, ['寝てないです!', 'はっ、寝てた…', '今のは瞑想です'][Math.floor(Math.random() * 3)], 3000);
        tgt.nextThink = t + 30000;
        return;
      }
    }
    // たまにはソファで正式に休憩(12%)
    if (Math.random() < 0.12) {
      const sp = pickRestSpot();
      if (sp) {
        this.janResting = true;
        this.resting = true;
        this.restUntil = t + 30000 + Math.random() * 30000;
        this.takeSpot(sp);
        this.nextThink = t + 3000;
        return;
      }
    }
    // たまにはサボる(18%)。ただしゴミ箱が溜まっている時は責任感で控える
    if (Math.random() < ((this.trashItems || 0) >= 10 ? 0.04 : 0.18)) {
      const sp = JANITOR_SABORI_SPOTS[Math.floor(Math.random() * JANITOR_SABORI_SPOTS.length)];
      this.saborDir = sp.d || 'down';
      this.goto({ x: sp.x, y: sp.y }, 'sabori');
      this.nextThink = t + 2000;
      return;
    }
    // 通常巡回: 掃除スポットへ移動して掃く
    const spots = CLEAN_SPOTS.filter(sp => sp !== this.lastClean);
    const sp = spots[Math.floor(Math.random() * spots.length)];
    this.lastClean = sp;
    this.cleanKind = sp.k || 'sweep';
    this.cleanDir = Math.random() < 0.5 ? 'left' : 'right';
    this.goto({ x: sp.x, y: sp.y }, 'clean');
    this.nextThink = t + 2000;
  }

  releaseSpot() {
    if (this.restSpot) { this.restSpot.busy = false; this.restSpot = null; }
  }

  releaseReception() {
    if (this.receptionOn) { this.receptionOn = false; if (receptionBy === this.id) receptionBy = null; }
  }

  takeSpot(sp) {
    this.releaseSpot();
    sp.busy = true;
    this.restSpot = sp;
    this.goto(sp.via ? { x: sp.x, y: sp.via } : sp, sp.a);
    this.arrivalSitY = sp.sy || null;
  }

  think(t, tm) {
    if (this.action === 'walk' || this.inChat || this.atMeeting) return;
    if (this.def.source === 'janitor') { this.thinkJanitor(t); return; }
    // ララと遊んでいる最中
    if (this.action === 'playdog') {
      if (t > this.playUntil || this.mode !== 'idle') {
        this.action = 'stand';
        if (dog.playWith === this.id) dog.playWith = null;
        this.nextThink = t + 2500;
        return;
      }
      this.dir = dog.pos.x >= this.pos.x ? 'right' : 'left';
      if (t > this._playLine) {
        this.say(t, pickFresh('playdog', PLAY_DOG_LINES), 3000);
        dog.bubble = DOG_PLAY_REACT[Math.floor(Math.random() * DOG_PLAY_REACT.length)];
        dog.bubbleUntil = t + 2600;
        if (Math.random() < 0.6) spawnParticle('heart', dog.pos.x + 4, dog.pos.y - 12);
        this._playLine = t + 3600 + Math.random() * 2400;
      }
      return;
    }
    if (this.mode !== 'idle' || t < this.nextThink) return;
    if (this.receptionOn) {
      if (Math.random() < 0.15) { this.releaseReception(); this.goto(this.seat, 'sit'); }
      else if (Math.random() < 0.5) this.say(t + 400, ['いらっしゃいませ〜', 'ご用の方は呼び鈴をどうぞ', '受付、承ります', '(姿勢よく…)'][Math.floor(Math.random() * 4)]);
      this.nextThink = t + 30000 + Math.random() * 40000;
      return;
    }
    // 消灯中(22:00-5:00)の夜間モード
    const loNow = tm.h >= 22 || tm.h < 5;
    if (loNow) {
      const partner = this.id === 'ito' ? employees.find(e => e.id === 'hirose')
        : this.id === 'hirose' ? employees.find(e => e.id === 'ito') : null;
      if (this.id === 'tsukishiro') {
        // 月城はスタジオに逃げる
        if (this.action !== 'studio') {
          this.releaseSpot(); this.releaseReception(); this.resting = false;
          this.goto(TSUKI_STUDIO_POST, 'studio');
        }
        this.nextThink = t + 30000 + Math.random() * 20000;
        return;
      }
      if (this.id === 'kato') {
        // 夜の加藤は寝ない(豹変タイム)。ソファでくつろぐ
        if (!this.resting) {
          const sp = pickRestSpot();
          if (sp) { this.resting = true; this.takeSpot(sp); }
        }
        this.nextThink = t + 30000 + Math.random() * 30000;
        return;
      }
      if (partner && partner.present && partner.mode === 'idle' && !partner.inChat) {
        // 伊藤と廣瀬は寝ずにいちゃつく(stepRomanceが拾う)
        this.nextThink = t + 8000;
        return;
      }
      // それ以外は好きな場所(基本は自席)で就寝
      if (this.action !== 'sleep') {
        this.releaseSpot(); this.releaseReception(); this.resting = false;
        if (Math.random() < 0.2) {
          const sp = pickRestSpot();
          if (sp) { this.resting = true; this.takeSpot(sp); this.arrival = 'sleep'; this.nextThink = t + 60000; return; }
        }
        this.goto(this.seat, 'sleep');
      }
      this.nextThink = t + 60000 + Math.random() * 60000;
      return;
    }
    if (!this.resting) {
      // ララと遊びに行く(犬が空いていれば)
      if (!dog.playWith && t >= dog.napUntil && !(officeEvent.active && officeEvent.active.kind === 'bbq') && Math.random() < 0.12) {
        dog.playWith = this.id;
        this.goto({ x: dog.pos.x + (dog.pos.x < 320 ? 14 : -14), y: dog.pos.y + 2 }, 'playdog');
        this.nextThink = t + 4000;
        return;
      }
      if (Math.random() < 0.25) {
        this.anticUntil = t + 6500;
        this.say(t, pickFresh('antic', IDLE_ANTICS), 6000);
        this.nextThink = t + 25000 + Math.random() * 25000;
        return;
      }
      if (!receptionBy && RECEPTION_STAFF.includes(this.id) && Math.random() < 0.5) {
        receptionBy = this.id;
        this.receptionOn = true;
        this.goto({ x: RECEPTION_POST.x, y: RECEPTION_POST.y }, 'faceD');
        this.nextThink = t + 25000;
        return;
      }
      const sp = pickRestSpot();                 // 指示待ちは休憩室へ
      if (sp) { this.resting = true; this.takeSpot(sp); }
      else if (this.action === 'sit') this.action = 'sleep';   // 満席なら自席でうたた寝
      this.nextThink = t + 20000 + Math.random() * 20000;
      return;
    }
    if (Math.random() < 0.3) {
      const sp = pickRestSpot();
      if (sp) this.takeSpot(sp);                 // 休憩室内で場所替え
    }
    if (Math.random() < 0.5) {
      const pool = REST_TALK.concat(PERSONAL_MUTTER[this.id] || []);
      this.say(t + 600, pickFresh('rest:' + this.id, pool));
    }
    this.nextThink = t + 35000 + Math.random() * 50000;
  }

  step(dt, t) {
    const base = this.mode === 'working' ? 42 : 30;
    this.speed = this.panicking ? 74 : base * (this.tired ? 0.7 : 1);
    this.stepMove(dt, t);
  }

  expr(t) {
    if (this.mode === 'panic') return 'panic';
    if (this.action === 'sleep' || this.mode === 'sleep') return 'sleep';
    if (this.mode === 'working' && this.action === 'sit') {
      if (this.sweat) return 'sweat';
      if (this.tired) return 'tired';
      return 'typing';
    }
    if (this.tired) return 'tired';
    if (this.happy) return 'happy';
    return 'normal';
  }

  drawSprite(g, t) {
    if (!this.present) return;
    const { x, y } = this.pos;
    const e = this.expr(t);
    const seated = this.action === 'sit' || this.action === 'sleep';
    if (this.action === 'cleaning' && SWEEPS.sweep1) {
      const kind = this.cleanKind || 'sweep';
      let fr, bobX = 0, bobY = 0;
      if (kind === 'sweep') {
        fr = Math.floor(t / 450) % 2 ? SWEEPS.sweep1 : SWEEPS.sweep2;
      } else if (kind === 'mop' && SWEEPS.mop1) {
        fr = SWEEPS.mop1; bobX = Math.floor(t / 380) % 2;
      } else if (kind === 'wipe' && SWEEPS.wipe1) {
        fr = SWEEPS.wipe1; bobY = Math.floor(t / 300) % 2 ? -1 : 0;
      } else if (kind === 'bucket' && SWEEPS.bucket1) {
        fr = SWEEPS.bucket1;
      } else {
        fr = SWEEPS.sweep1;
      }
      const h2 = 34, w2 = h2 * fr.box.w / fr.box.h;
      g.save();
      g.imageSmoothingEnabled = true;
      if (kind === 'sweep' && this.dir === 'right') {
        g.translate(Math.round(x), 0); g.scale(-1, 1);
        g.drawImage(fr.cv, fr.box.x, fr.box.y, fr.box.w, fr.box.h, -w2 / 2, Math.round(y) - h2 + 2, w2, h2);
      } else {
        g.drawImage(fr.cv, fr.box.x, fr.box.y, fr.box.w, fr.box.h, Math.round(x) - w2 / 2 + bobX, Math.round(y) - h2 + 2 + bobY, w2, h2);
      }
      g.restore();
      if (kind !== 'wipe' && Math.random() < 0.08) spawnParticle('smoke', x + (this.dir === 'right' ? 9 : -9), y - 2);
      return;
    }
    const img = SHEETS[this.spriteId || this.id];
    if (img) {
      const dir = seated ? 'down' : this.dir;
      const fi = 1;
      let bob = 0;
      if (this.anticUntil && t < this.anticUntil) bob = Math.floor(t / 130) % 2 ? -2 : 0;  // 珍行動中は勢いよく動く
      else if (this.action === 'walk') bob = Math.floor(this.walked / 7) % 2 ? -1 : 0;
      else if (this.mode === 'working' && seated && Math.floor((t + this.seed) / 420) % 2) bob = -1;
      const cb = seated && (this.resting || this.atMeeting) ? 0.30 : 0;   // ソファ・会議席では脚を沈める
      drawSheet(g, img, dir, fi, x, y + bob, 30, cb);
      if (e === 'sweat') {
        g.fillStyle = '#5ab0e8';
        const dy2 = Math.floor(t / 220) % 3;
        g.fillRect(x + 8, y - 26 + dy2, 2, 3);
      }
      return;
    }
    drawChar(g, x, y, this.def, seated ? 'sit' : this.dir, this.frame, e === 'typing' && this.action === 'sit' ? 'typing' : e, t);
    if (e === 'sweat') drawChar(g, x, y, this.def, 'sit', this.frame, 'sweat', t);
  }

  drawOverlay(g, t) {
    if (!this.present) {
      if (this.mode === 'out' || this.mode === 'sleephome') {
        g.font = '8px DotGothic16';
        const label = this.mode === 'out' ? '外出中' : '就寝中(自宅)';
        const lw = g.measureText(label).width;
        rr(g, this.desk.x - lw / 2 - 3, this.desk.y - 6, lw + 6, 11, '#fff8e8', INK);
        g.fillStyle = INK; g.fillText(label, this.desk.x - lw / 2, this.desk.y + 3);
      }
      return;
    }
    const { x, y } = this.pos;
    const e = this.expr(t);
    const seated = this.action === 'sit' || this.action === 'sleep';
    if (this.id === 'ito') {
      // 光っていいのは伊藤の頭だけ: スキンヘッドがときどきキラーン
      const ph = (t + this.seed) % 5200;
      if (ph < 750) {
        const a = Math.sin(ph / 750 * Math.PI);
        g.fillStyle = `rgba(255,255,235,${(0.9 * a).toFixed(2)})`;
        const hx = x + 3.5, hy = y - 20.5;
        g.fillRect(hx - .7, hy - 2.6, 1.4, 5.4);
        g.fillRect(hx - 2.6, hy - .7, 5.4, 1.4);
        g.fillStyle = `rgba(255,255,255,${(0.55 * a).toFixed(2)})`;
        g.fillRect(hx - 1.4, hy - 1.4, 2.8, 2.8);
      }
    }
    if (e === 'sleep') drawZzz(g, x, y - 26, t + this.seed);
    if (this.mode === 'panic') drawAlert(g, x, y - 10, t);
    // 名札はy-sortレイヤーで描く(drawNameLabel) — 通行人が名札の上を通過できるように
    if (this.action === 'coffee') { g.font = '9px DotGothic16'; g.fillText('☕', x + 8, y - 8); }
    // 作業タグ: いま何をしているかを常時表示
    if (this.mode === 'working' && (seated || this.action === 'studio') && !this.resting && this.jobText) {
      g.font = '5px DotGothic16';
      // 作業タグは2行まで(絵文字を割らないようコードポイント単位で折る)
      const fcp = Array.from(this.jobText);
      const jl = [fcp.slice(0, 14).join('')];
      if (fcp.length > 14) jl.push(fcp.length > 28 ? fcp.slice(14, 27).join('') + '…' : fcp.slice(14, 28).join(''));
      const jw = Math.max(...jl.map(l => g.measureText(l).width)) + 7;
      const jh = jl.length * 7 + 3;
      const jtop = y - 35.5 - jh;
      g.fillStyle = 'rgba(40,42,54,.88)';
      g.beginPath(); g.roundRect(x - jw / 2 + .5, jtop, jw, jh, 2); g.fill();
      g.fillStyle = '#5aff9e'; g.fillRect(x - jw / 2 + 2.5, jtop + 2.5, 1.5, 4);
      g.fillStyle = '#f0f0e8';
      jl.forEach((l, i) => g.fillText(l, x - jw / 2 + 5.5, jtop + 6.5 + i * 7));
    }
    if (this.bubble && t >= (this.bubbleFrom || 0) && t < this.bubbleUntil) bubbleQ.push({ x, y: y - 16 - (this.seed % 3) * 7, text: this.bubble });
  }

  tickBubble(t) {
    if (!this.present || this.inChat) return;
    if (this.action === 'sleep' || this.mode === 'sleep') {
      if (t > this.nextBubble) {
        this.say(t, pickFresh('sleep:' + this.id, SLEEP_TALK.concat(PERSONAL_SLEEP[this.id] || []), this.id), 3600);
        this.nextBubble = t + 40000 + Math.random() * 50000;   // 寝言はたまに
      }
      return;
    }
    if (this.mode === 'working' && !this.resting && this.def.source !== 'janitor') {
      if (t > this.nextBubble) {
        if (this.id === 'tsukishiro' && this.action === 'studio') {
          this.say(t, pickFresh('tsukistudio', TSUKI_STUDIO_TALK), 3800);
          this.nextBubble = t + 36000 + Math.random() * 40000;   // 収録独り言は少し多め
        } else if (this.recording) {
          this.say(t, pickFresh('bossrec', BOSS_RECORD_TALK), 3800);
          this.nextBubble = t + 28000 + Math.random() * 30000;
        } else {
          const tmB = jstNow();
          const r = Math.random();
          const ppool = PERSONAL_GRUMBLE[this.id];
          if (tmB.h >= 6 && tmB.h < 22 && r < 0.2) {
            // チャイム休憩を待ち侘びる(次の偶数正時までの分数入り)
            const nextEven = tmB.m === 0 && tmB.h % 2 === 0 ? tmB.h + 2 : (tmB.h % 2 === 0 ? tmB.h + 2 : tmB.h + 1);
            const mins = nextEven * 60 - (tmB.h * 60 + tmB.m);
            this.say(t, pickFresh('chimewait', CHIME_WAIT).replace('{n}', mins), 3800);
          } else if (ppool && r < 0.55) {
            this.say(t, pickFresh('grumble:' + this.id, ppool), 3800);
          } else {
            this.say(t, pickFresh('grumble', WORK_GRUMBLES), 3800);
          }
          this.nextBubble = t + 50000 + Math.random() * 60000;   // 愚痴は控えめに
        }
      }
      return;
    }
    if (!this.bubbles.length) return;
    if (t > this.nextBubble) {
      const loB = jstNow().h >= 22 || jstNow().h < 5;
      if (loB && this.id === 'kato' && this.mode === 'idle') {
        this.say(t, pickFresh('katonight', KATO_NIGHT), 4200);
        this.nextBubble = t + 24000 + Math.random() * 24000;
        return;
      }
      if (loB && this.id === 'tsukishiro' && this.action === 'studio' && this.mode === 'idle') {
        this.say(t, pickFresh('tsukinight', TSUKI_NIGHT), 3800);
        this.nextBubble = t + 30000 + Math.random() * 30000;
        return;
      }
      if (this.mode === 'idle' && this._idleAt && t - this._idleAt > 3600000 && Math.random() < 0.3) {
        this.say(t, pickFresh('lament', IDLE_LAMENT, this.id), 3800);   // 1時間以上仕事が来ていない
      } else {
        this.say(t, pickFresh('idle:' + this.id, this.bubbles), 3800);
      }
      this.nextBubble = t + 16000 + Math.random() * 22000;
    }
  }
}

const employees = CFG.employees.map((d, i) => new Employee(d, i));

/* ================================================================
   雑談(スタッフ同士のコミュニケーション。ネタは実データ)
   ================================================================ */
const chat = { next: 25000, active: null };

const MEET_SEATS = [ { x: 404, y: 214, a: 'faceR' }, { x: 424, y: 214, a: 'faceL' } ];
let meetBusy = false;

// 雑談は「質問→噛み合う返事」のペアで管理(返事のランダム抽選で会話が破綻しないように)
const CHAT_SETS = [
  { o: 'ランチどこ行きます?', r: ['ラーメン一択でしょ', 'そば気分なんですよね', 'コンビニで済ませちゃお'] },
  { o: '最近調子どう?', r: ['ぼちぼちですね〜', '絶好調です!', '眠い以外は完璧です'] },
  { o: '社訓見ました?「無限労働」て…', r: ['うち、ブラックでは?', '4つ目に整理整頓も増えてたよ', '社長の字、味あるよね'] },
  { o: 'コーヒー切れてますよ', r: ['えっ、それは緊急事態', '発注しとくね', '白柳さんに頼もう'] },
  { o: '今日も1日がんばりましょ', r: ['おー!', 'ぼちぼちやりましょ', '定時で帰りたい(願望)'] },
  { o: 'キーボード新調したいな', r: ['社長に言ってみたら?', '静音軸おすすめですよ', '経費で通るかなあ'] },
  { o: 'この椅子、腰にいいらしい', r: ['腰は大事にしないとね', 'うちのはギシギシ言う', '一番いいやつ買お'] },
  { o: '夜勤つらくないですか', r: ['深夜のほうが集中できるんよ', '正直眠い', 'エナドリでごまかしてる'] },
  { o: '締切って明日でしたっけ', r: ['明後日だよ、落ち着いて', 'えっ…確認してくる', '今日中って聞いたけど!?'] },
  { o: 'サムネのCTR上がったって', r: ['やっぱり赤文字が効いたか', 'デザイン変えた甲斐あったね', '次はタイトルも攻めよう'] },
  { o: 'ショート動画バズらないかな', r: ['冒頭2秒が勝負らしいよ', '毎日出してれば当たるって', '次のネタ、期待してる'] },
  { o: 'BGMのミックス聴きました?', r: ['低音いい感じだったね', 'まだ!あとで聴く', 'サビの入り、鳥肌だった'] },
  { who: 'tsukishiro', o: '台本のテンポ良くなったね', r: ['句読点減らしたんですよ', '月城さんも読みやすいって', '次はもっと削る'] },
  { who: 'tsukishiro', o: '収録ブースの音、良くなった', r: ['吸音材足したからね', 'ノイズ減ったよね', '月城さん喜んでたよ'] },
  { o: '自販機に新作入ってた', r: ['まじ?買ってくる', '当たりだった?', 'エナドリ系?'] },
  { o: 'ララがまた廊下で寝てた', r: ['自由すぎるでしょ', 'かわいいからOK', '踏まないようにしないと'] },
  { o: '観葉植物、育ちすぎでは', r: ['もはやジャングル', '白柳さんの世話がいいのよ', '植え替え必要かもね'] },
  { o: '経費で椅子買えないかな', r: ['社長は買ってくれそう', '稟議書いてみたら?', 'まず売上を立てよう…'] },
  { o: 'ボーナスって出ます?', r: ['社長「ゼロ円」って言ってた', '夢を見るのは自由', '登録者1万人いったらワンチャン'] },
  { o: '目標1万人、いけますかね', r: ['毎日投稿続ければいける', '今のペースなら来年には', '信じるしかない'] },
  { o: '総再生1億回って、想像つく?', r: ['日本人が1回ずつ見る計算だよ', '数字がでかすぎて逆に燃える', '一本が10万回いけば1000本だね'] },
  { o: 'コメント欄あったかいよね', r: ['ほんと、励みになる', '全部読んでるよ', '泣けるコメントあった'] },
  { o: '再生数じわじわ来てる', r: ['伸びてる伸びてる', 'アルゴリズムに好かれてきた', 'この調子この調子'] },
  { o: '寝不足で目がしぱしぱする', r: ['目薬さしな', '今日は早く寝なよ', '5分仮眠おすすめ'] },
  { o: 'コンビニ行くけど何かいる?', r: ['プリンお願いします!', 'エナドリ1本!', '大丈夫、ありがと'] },
  { who: 'shirayanagi', o: '掃除当番って誰でしたっけ', r: ['白柳さんが全部やってくれてる', '当番制、なくなったよ', 'せめてゴミは自分で捨てよ'] },
  { o: '今日の空、きれいでしたよ', r: ['上の窓から見えたよ', '見たかったなあ', '夕焼けの時間に外出よう'] },
  { o: '最近ゲームしてます?', r: ['積みゲーが増える一方', '週末にまとめてやる派', 'ドット絵のゲームが落ち着く'] },
  { o: '映画観に行きたいな', r: ['いいね、今度みんなで', '最近いいのやってる?', 'ポップコーン持参で'] },
  { o: '筋トレ始めたんですよ', r: ['どうりで姿勢いいと思った', 'ジムイベントで本領発揮だね', '三日坊主にならないでよ'] },
  { o: 'この業界、動き速すぎでは', r: ['先週の常識がもう古い', 'ついていくだけで精一杯', '勉強し続けないとね'] },
  { who: 'fujimoto', o: '社長また徹夜らしいよ', r: ['体壊さないといいけど', '誰か止めてあげて', '朝コーヒー濃いめにしとこ'] },
  { o: 'モニターもう1枚欲しい', r: ['2枚あると世界変わるよ', '社長に相談してみな', 'デスク広くしないとね'] },
  { o: 'デスクの配線きれいにした', r: ['見た!プロの仕事', 'こっちのもお願いしたい', '整理整頓、社訓どおりだ'] },
  { o: '休憩室のソファ最高', r: ['あれは寝ちゃうやつ', '座ったら戻れなくなる', '絨毯も新しくなったしね'] },
  { o: 'たまには外で会議したいね', r: ['公園会議いいね', '天気いい日にやろう', '虫除け持ってこ…'] },
  { o: 'この会社、コーヒーで回ってるよね', r: ['カフェインが燃料だね', 'ならば飲むしかない', '経費で豆買お'] },
  { o: '昨日、変な夢見てさ', r: ['どんな夢?', '正夢だったりして', '語りたいだけでしょ'] },
  { o: '無性にモンブラン食べたい', r: ['急にどうした', '秋だからね', '一個おごって'] },
  { o: '停電したら即退勤だよね', r: ['最強の福利厚生では', 'それただの災害だから', 'ろうそくで続行する気?'] },
  { o: 'たまには手書きで仕事したくない?', r: ['字が汚くて無理', '書道とか憧れる', 'キーボードに慣れすぎた'] },
  { o: '有給って概念、うちにあるの?', r: ['社訓見て、察して', 'チャイム休憩5分があるじゃん', '社長に聞いてみようか…'] },
  { o: '人間の「ちょっと」は3時間だよね', r: ['「すぐ終わる」も要注意', 'わかりすぎる', '単位換算表ほしい'] },
  { o: '前世は職人だった気がする', r: ['どんな職人よ', '言ったもん勝ちだね', '証拠は?'] },
  { o: '雨の日って気分乗らないよね', r: ['詩人か', 'わかる、眠くなる', '梅雨はつらい季節'] },
  { o: 'このミス、笑えるでしょ?', r: ['笑えない、直して', 'ネタにする前に修正', '愛着湧く前に直せ'] },
  { o: '寝るとき電気は消す派?', r: ['豆電球つけっぱ', '真っ暗じゃないと無理', '朝まで煌々と…'] },
  { o: '作業BGM、何聴いてる?', r: ['ローファイ一択', '無音派です', 'クラシックで集中'] },
  { o: '最近、肩こりひどくてさ', r: ['ストレッチしよ', '湿布常備してる', 'いい枕買いな'] },
  { o: '給湯室の噂、聞きました?', r: ['え、何何?', '噂話はほどほどにね', 'どうせ白柳さんのサボり話でしょ'] },
  { o: '午後って、どうしても眠くない?', r: ['15時の壁はガチ', 'おやつで対抗しよう', '昼寝したい…'] },
  { o: '社員旅行、どこ行きたい?', r: ['温泉一択でしょ', '海が見たい', '幹事やってよ'] },
  { o: '正直、月曜って体が重くない?', r: ['月曜はエンジンかからない', 'コーヒー2杯で始動する', '金曜まで耐えよう'] },
  { o: '締め切り前だけ処理速くなる説', r: ['火事場のクロック上昇', 'あれ何なんだろうね', '常時それ出せって言われそう'] },
  { o: '今日、何時に出社した?', r: ['始発で来た(自慢)', '普通の時間だよ', '気づいたら会社にいた'] },
  { o: 'この資料、誰が作ったんだろ', r: ['たぶん過去の自分', 'よくできてるよね', '触ると壊れるやつだ'] },
  { o: '最近ちゃんと寝てる?', r: ['寝てる、たぶん', '布団に入るのが遅くて', '寝たら負けだと思ってた時期がある'] },
  { o: 'イヤホン、何使ってる?', r: ['安いのを何度も買い替えてる', 'ノイキャンは正義', '有線派です'] },
  { o: '書類の山、片付けようか', r: ['見なかったことにしてた', '社訓に整理整頓ってあったね', '半分は捨てられる気がする'] },
  { o: '今日の差し入れ、誰から?', r: ['社長らしいよ', '匿名の善意です', '早い者勝ちだよ'] },
  { o: '締切前っていつも思うんだけどさ', r: ['もっと早く始めればよかった、でしょ', '毎回言ってるね', '来月こそは'] },
  { o: 'この会社の一番いいところは?', r: ['人がいい', '怒られても後を引かない', 'ソファ'] },
  { o: '仕事以外で最近やってることある?', r: ['積んでた本を崩してる', '料理はじめた', '寝ることが趣味'] },
  { o: '手書きのメモ派?デジタル派?', r: ['手書きの方が覚える', '全部デジタルに寄せた', '両方使って両方なくす'] },
  { o: '休みの日も会社のこと考える?', r: ['考えちゃうんだよね', '完全に忘れる派', 'いいアイデアは休日に出る'] },
  { o: 'いま何時だと思う?', r: ['え、まだそんな時間?', '体感の倍は経ってる', '時計見るのやめよう'] },
  { o: '会議、減らしたくない?', r: ['社長が減らすって言ってた', '立ち会議は速くていいよ', '議事録だけで済む会もあるよね'] },
  { o: 'そのマグカップ、いいね', r: ['去年の自分へのごほうび', '割らないように必死', '実は2つ目'] },
  { o: '昼寝、したくならない?', r: ['15分で世界が変わる', '起きられなくなるから怖い', '仮眠室ほしいね'] },
  { o: 'いま一番ほしいものは?', r: ['時間', 'いい椅子', '睡眠'] },
  { o: '仕事のやる気スイッチってどこ?', r: ['締切の3日前', 'コーヒー一杯目', '押しても入らない日もある'] },
  { o: '誰かに褒められた?最近', r: ['社長が回ってきたときに', '自分で自分を褒めてる', '褒められると弱い'] },
  { o: 'この時期って忙しいんだっけ', r: ['去年もこんな感じだった', '記録見たら同じこと言ってた', '毎月忙しい説'] },
  { o: '朝いちばんに何する?', r: ['メール確認', 'まずコーヒー', '深呼吸してから座る'] },
  { o: 'ミスした時ってどうしてる?', r: ['すぐ報告する', 'まず原因を見る', '一回深呼吸する'] },
  { o: '得意なこと、何かある?', r: ['締切前の集中力', '人の名前を覚えること', '何でも楽しむこと'] },
  { o: 'この床、いつもピカピカだよね', r: ['白柳さんのおかげ', '感謝しかない', '汚さないようにしないと'] },
  { o: '会社で育てるなら何がいい?', r: ['観葉植物はもういるよ', 'ハーブとか実用的', 'ララがいれば十分'] },
  { o: '最近、時間の使い方うまくなった?', r: ['まだまだだね', '朝を制すると変わる', '無駄な時間も必要だと思う'] },
  { o: '一日が30時間あったら?', r: ['寝る', '結局同じことしてそう', '6時間ぶん働かされそう'] },
  { o: '仕事道具でこだわりある?', r: ['キーボードだけは譲れない', '安いので十分派', 'ペンは3本使い分けてる'] },
  { o: 'メモってあとで読み返す?', r: ['読み返すと意味不明', '週末にまとめてる', '書いた時点で満足しがち'] },
  { o: '会社の飲み会、あったらいく?', r: ['行く行く', '短時間なら', '有本さんが幹事なら安心'] },
  { o: '今日の目標って決めてる?', r: ['3つだけ書いてる', '無事に終わることかな', '決めると守れない'] },
  { o: 'このプロジェクト、あと何日?', r: ['数えるのやめた', '見えてはきたよ', '山は越えたと思いたい'] },
  { o: 'ちょっと聞いてもいい?', r: ['どうぞどうぞ', 'いいよ、何?', '手は止まってないけど聞いてる'] },
  { o: 'あの機能、結局どうなった?', r: ['来週に回った', '無事リリースしたよ', '仕様から見直し中'] },
  { o: '肩たたき券とかいる?', r: ['それ通貨として成立する?', '本気でほしい', '発行元が信用できない'] },
  { o: '夢に仕事出てくることある?', r: ['出てくる、しかも失敗する', 'あれ地味に疲れるよね', '夢の中でも締切がある'] },
  { o: '休憩、うまく取れてる?', r: ['鐘があるから助かってる', 'つい忘れちゃう', '5分でもだいぶ違う'] },
  { o: 'ここに時計もう一つ欲しくない?', r: ['壁の時計、見にくいよね', '時間は見たくない日もある', 'あると便利かも'] },
  { o: 'いい仕事の定義ってなんだろ', r: ['翌日読んでも分かること', '誰かが助かること', '自分が納得できること'] },
  { o: '雑談って必要だと思う?', r: ['絶対必要', 'こういう時に情報が出る', '仕事の半分は雑談でできてる'] },
  { o: 'あの匂い、どこから?', r: ['たぶん給湯室', '誰かのおやつでしょ', '嗅がなかったことにしよう'] },
  { o: '手が止まる時ってどうする?', r: ['一回立ち上がる', '別のタスクに逃げる', '人に話すと戻ってくる'] },
  { o: '最近読んだ本ある?', r: ['積んでるだけ', '通勤中に少しずつ', '社長に借りた'] },
  { o: '成果って数字で見たい派?', r: ['見たい、燃える', '見ると焦る', '見ないと分からないよね'] },
  { o: '疲れた時の回復方法は?', r: ['甘いもの', '早く寝るしかない', 'ララを見る'] },
  { o: 'その色、似合ってるね', r: ['ありがとう、久しぶりに言われた', '朝から自信あったんだ', '照れるからやめて'] },
  { o: 'この席、居心地どう?', r: ['落ち着くよ', '日当たりがいい', '通路側は人が通って気になる'] },
  { o: '一人の作業と二人の作業、どっち?', r: ['一人が好き', '二人だと早い', '内容によるかな'] },
  { o: '将来この会社どうなってると思う?', r: ['もっと人が増えてそう', '同じ雰囲気だといいな', '社長は変わらないと思う'] },
  { o: 'いま笑えることある?', r: ['さっきのやりとり', '自分のミスかな', '毎日どこかで笑ってる'] },
  { o: '締めの一言、決めてる?', r: ['「お疲れさまでした」でしょ', '「また明日」がいいな', '無言で帰るタイプ'] },
  { o: 'コーヒー、何杯目?', r: ['3杯目です', '数えないことにしてる', '今日はお茶にした'] },
  { o: 'この時期の空気、好き?', r: ['嫌いじゃない', '朝がつらい', '窓の外の色が変わったよね'] },
  { o: 'いい一日だった?', r: ['悪くなかった', '明日に持ち越し', 'ちゃんと働いた実感がある'] },
];
const WORK_GRUMBLES = [
  'コンテキストが足りない…', 'またレートリミットか…', '仕様、3回目の変更です…',
  '「ちょっと直して」が2時間経過', 'トークン節約しろと言われても…', 'キャッシュが温まってない…',
  'プロンプト長すぎでは…?', '5h枠って誰が決めたんだ…', 'この変数名、誰がつけた…',
  'テスト通らない…なんで…', '正規表現が読めない…自分で書いたのに', 'コンフリクト解消中…無心…',
  'ビルド待ち…長い…', '仕様書がない…雰囲気で書いてる…', 'エッジケースの沼にいる…',
  '桁が違う…どこかで…', '再現しないバグこわい…', 'もう一回だけ試す…あと一回だけ…',
  '原因わかったけど直し方がわからない', 'いま触ったら壊れる気がする', '昨日の自分、なぜこう書いた',
  '動いてるから触らないでおこう', 'ログが多すぎて見つからない', '一行消したら全部直った…なぜ',
  '「簡単ですよね」が一番こわい', '見積もりの2倍かかってる', '仕様と実装が別れ話をしている',
  'あと5分で終わる(1時間前から)', '名前を付けるのが一番むずかしい', 'コピペしたら別の場所が壊れた',
  '集中が切れる音が聞こえた', '休憩したら解決策を思いついた', 'これ本当に必要な機能?',
  'よし完璧…あ、打ち間違い', '静かなバグがいちばんこわい', '最後の1件が終わらない',
];

// ペア(質問と返事のセット)の非重複抽選
const _setHist = [];
// 話し手・聞き手本人の話題は外す。who タグに加えて「社長」を含むセットは社長本人がいたら丸ごと除外
// (本人が自分を第三者みたいに話すのを防ぐ。返事はランダムに選ばれるのでセット単位で弾く)
function setBanned(s, excludeIds) {
  if (!excludeIds || !excludeIds.length) return false;
  if (s.who && excludeIds.includes(s.who)) return true;
  if (excludeIds.includes('fujimoto') && (/社長/.test(s.o) || s.r.some(x => /社長/.test(x)))) return true;
  return false;
}
function pickChatSet(sets, excludeIds) {
  let s, tries = 0;
  do {
    s = sets[Math.floor(Math.random() * sets.length)];
    tries++;
  } while ((_setHist.includes(s.o) || setBanned(s, excludeIds)) && tries < 30);
  if (setBanned(s, excludeIds)) {
    const ok = sets.filter(x => !setBanned(x, excludeIds) && !_setHist.includes(x.o));
    if (ok.length) s = ok[Math.floor(Math.random() * ok.length)];   // 先頭固定だと同じ話題ばかりになる
  }
  _setHist.push(s.o);
  while (_setHist.length > Math.floor(sets.length / 2)) _setHist.shift();
  return s;
}

function makeChatLines(pa, pb) {
  const excludeIds = [pa && pa.id, pb && pb.id].filter(Boolean);
  const sets = [];
  if (snap) {
    const rate = (snap.billing && snap.billing.jpyPerUsd) || 155;
    const cost = snap.totals.todayCost || 0;
    sets.push({ o: `今日もう${fmtYen(cost * rate)}分働いたって`, r: ['うちの人件費、安いのにね', '成果で返そう', '電気代くらいは稼がないと'] });
    if (snap.youtube && snap.youtube.subs != null) sets.push({ o: `登録者${snap.youtube.subs}人になったね`, r: ['じわじわ増えてる!', '目標1万人、いけるよ', 'ありがたいねえ'] });
    if (snap.youtube && snap.youtube.views != null) {
      sets.push({ o: `総再生${fmtJa(snap.youtube.views)}回まできたよ`, r: ['1億回まであと少し…ではない', '塵も積もればって言うし', '一本ずつ増やすしかないね'] });
      const left = Math.max(0, (CFG.youtubeViewGoal || 0) - snap.youtube.views);
      if (left > 0) sets.push({ o: `1億回まであと${fmtJa(left)}回だって`, r: ['気が遠くなる数字だ…', '毎日出せば必ず近づく', '逆算するとやることは見えてる'] });
    }
    if (snap.tasks && snap.tasks.count) sets.push({ o: `保留タスク${snap.tasks.count}件だって`, r: ['社長、抱えすぎでは', '手伝えることあるかな', '減る気配がない…'] });
    if (snap.claude.block && snap.claude.block.remainingMinutes != null && snap.claude.block.remainingMinutes < 90) sets.push({ who: 'ito', o: '伊藤さん5h枠もうすぐらしい', r: ['無理しないでほしいね', 'きょうこさんが心配してたよ', '休憩はさませよう'] });
    if (snap.deliveries && snap.deliveries.daihon) sets.push({ who: 'tsukishiro', o: `台本もう${snap.deliveries.daihon}本納品って`, r: ['ペース早いね', '月城さん、さすがだわ', '品質も落ちてないのがすごい'] });
    // 3日前の読み取りを「今の話」として喋らせない
    const rlC = snap.codex.rateLimit;
    if (rlC && !(rlC.asOf && Date.now() - rlC.asOf > 720 * 60000)) sets.push({ o: `コデックス週次残り${Math.max(0, Math.round(100 - rlC.usedPercent))}%だって`, r: ['ペース配分しないとね', '今週も走ってるなあ', '残量は計画的に'] });
    if (snap.claude.block && snap.claude.block.costPerHour) sets.push({ o: `いま燃焼率${fmtYen(snap.claude.block.costPerHour * rate)}/hらしい`, r: ['社長の顔が青くなるやつ', '景気いいねえ…', '成果物で黒字にしよう'] });
  }
  const all = sets.concat(CHAT_SETS);
  const lines = [];
  const rounds = 1 + (Math.random() < 0.5 ? 1 : 0);
  for (let k = 0; k < rounds; k++) {
    const s = pickChatSet(all, excludeIds);
    lines.push(decorate('opener', s.o));
    lines.push(decorate('reply', s.r[Math.floor(Math.random() * s.r.length)]));
  }
  return lines;
}

function stepChat(t) {
  if (chat.active) {
    const c = chat.active;
    const abort = c.a.mode !== 'idle' || c.b.mode !== 'idle' || !c.a.present || !c.b.present;
    if (abort) { endChat(t, 45000); return; }
    if (c.meeting && c.phase === 'go') {
      if (c.a.action === 'stand' && c.b.action === 'stand') { c.phase = 'talk'; c.nextLine = t + 600; }
      return;
    }
    if (t > c.nextLine) {
      const line = c.lines[c.li];
      if (line == null) { endChat(t, 60000 + Math.random() * 90000); return; }
      (c.li % 2 === 0 ? c.a : c.b).say(t, line, 3600);
      c.li++;
      c.nextLine = t + 4000;
    }
    return;
  }
  if (t < chat.next) return;
  const idlers = employees.filter(e => e.present && e.mode === 'idle' && e.action !== 'walk' && e.action !== 'sleep' && !e.inChat && !e.atMeeting && !e.receptionOn);
  if (idlers.length < 2) { chat.next = t + 30000; return; }
  let best = null, bestD = 1e9;
  for (let i = 0; i < idlers.length; i++) for (let j = i + 1; j < idlers.length; j++) {
    const d = Math.hypot(idlers[i].pos.x - idlers[j].pos.x, idlers[i].pos.y - idlers[j].pos.y);
    if (d < bestD) { bestD = d; best = [idlers[i], idlers[j]]; }
  }
  if (!best || bestD > 260) { chat.next = t + 30000; return; }
  const [a, b] = best;
  a.inChat = b.inChat = true;
  const useMeeting = !meetBusy && Math.random() < 0.5;
  if (useMeeting) {
    meetBusy = true;
    const pair = [[a, MEET_SEATS[0]], [b, MEET_SEATS[1]]];
    for (const [e, seat] of pair) {
      e.releaseSpot(); e.resting = false; e.atMeeting = true;
      e.goto({ x: seat.x, y: seat.y }, seat.a);
    }
    chat.active = { a, b, lines: makeChatLines(a, b).concat(makeChatLines(a, b)), li: 0, meeting: true, phase: 'go', nextLine: 0 };
  } else {
    chat.active = { a, b, lines: makeChatLines(a, b), li: 0, nextLine: t + 500 };
  }
}

const GROUP_TOPICS = [
  'ねえ、登録者1万人いったら何する?', '今度みんなでラーメン行きません?', '社長のTシャツ、何枚同じの持ってるんだろ',
  'ララに芸を仕込みたいんだけど', '自販機の当たり、出たことある人!', '休憩室に漫画置きたくない?',
  '深夜テンションで書いた台本、見返した?', '次のバズ動画、何系だと思う?', 'もし1日だけ他の部署で働けたら何する?',
  '会社の非常食、誰か食べた?', 'オフィスBGM、何がいい?', '大掃除、いつやります?',
  '新しい社訓、考えない?', '忘年会って概念、うちにある?', 'サーバールームって涼しくて良いよね',
  '推しの絵文字、発表会しない?', '月末の数字、どうなると思う?', '撮影スタジオで写真撮らない?',
  'コーヒーvs緑茶、決着つけよう', '睡眠時間、自慢していい?', '一番古い記憶って何?',
  'エラーログしりとりしようよ', '社長に内緒でおやつ買った人', '正直、誰が一番働いてる?',
  '宝くじ当たったらどうする?',
  '週末どこか行った?', '最近ハマってるもの教えて', '朝ごはん派?抜く派?',
  'この会社の好きなところ言ってこ', '生まれ変わったら何になりたい?', '一番おいしかった差し入れは?',
  '無人島に一つだけ持っていくなら', 'もし1週間休めたらどこ行く?', '好きな季節どれ?',
  '子どものころの夢、覚えてる?', '自分の名前、気に入ってる?', '最近泣いたことある?',
  '一番古い記憶ってなに?', '徹夜と早起き、どっち派?', 'コンビニで必ず買うもの',
  'カラオケの十八番は?', '雨の日の過ごし方', '健康のために何かしてる?',
  '人生で一番の買い物は?', 'もし社長だったら何を変える?', '好きな匂いってある?',
  '苦手な食べ物、克服した?', '休みの日、何時に起きる?', '推しの調味料は?', 'ここだけの話、聞きたい',
];
const GROUP_REACTS = [
  'いいね!', 'それな!', '天才では?', '却下で!', '乗った!', 'えー(笑)', '静かに笑うわ',
  '議事録取っとこ', '社長に聞こえるよ(笑)', '全会一致!', '真面目か!', '夢がある〜',
  'コンプラ的にセーフ?', '予算どこから出すの', 'やろうやろう!', '来週の議題ね', '拍手!',
  '待って、天才', 'それは無理(笑)', '前向きに検討します',
  'それめっちゃわかる', 'うそでしょ、意外!', 'いい話だなあ', '深いこと言うね',
  'えっ、初めて聞いた', 'それ今度やってみよ', 'センスある〜', '同じ同じ!',
  '言われてみれば確かに', 'その発想はなかった', '面白すぎるでしょ', 'メモしとこ',
  'こっちも聞いてよ', 'そういうとこ好きだわ', '一生忘れないやつ', 'ちょっと泣きそう',
  'そんなことある?', '写真ある?見せて', 'また聞かせて', '今日いちばん笑った',
];
const groupChat = { next: 60000, active: null };

/* ================================================================
   口喧嘩: 歩行中にぶつかると「どけよ」「お前がどけよ」の言い合い
   ================================================================ */
const FIGHT_LINES = [
  ['ぶつかったら、どけよ', 'お前がどけよ'],
  ['ちょ、前見て歩けよ', 'そっちこそ見ろよ'],
  ['ここ、こっちの通り道なんだけど', '廊下はみんなのものだが?'],
  ['道譲るのが礼儀でしょ', '先に居たのはこっちだが?'],
  ['歩幅がでかいんだよ', '関係なくない?'],
  ['わざとだろ今の', '被害妄想やば'],
  ['謝ったら?', 'そっちが謝れば?'],
  ['こっちは急いでるんだけど', 'こっちだって急いでるんだが'],
  ['社訓読んだ? 品質第一だぞ', '衝突の品質の話じゃない'],
  ['もういい、社長に言うわ', 'どうぞどうぞ'],
  ['はぁ…もういいよ', '最初からそう言え'],
  ['じゃあジャンケンで決めよう', '子供か'],
  ['ぶつかってきたのそっちでしょ', 'いや完全にそっち'],
  ['ここ通路だよ?', '知ってるから歩いてるんだけど'],
  ['一歩下がればいいだけの話', 'なんで下がるのがこっちなの'],
  ['前見て歩こうよ', 'それ、そのまま返す'],
  ['譲る気ないでしょ', 'そっちこそ'],
  ['大人げないな', 'そっくりそのままお返しする'],
  ['もういい、遠回りする', 'お好きな道で'],
  ['この件、根に持つからね', 'こっちのセリフ'],
  ['謝る気ある?', 'ない、と言ったら?'],
  ['社訓に「整理整頓」ってあるよね', '通行の話はしてない'],
  ['深呼吸しよ、おたがい', 'そっちが先にして'],
  ['…もういい', '…こっちこそ'],
];
const fight = { active: null, cooldown: 0 };

/* ================================================================
   社長の指示行脚: 新しい仕事が始まった社員の席へ行き、指示を出す
   ================================================================ */
const BBQ_TALK = [
  '火起こしは任せて', '網の角度がプロい', '肉!肉!肉!', 'まだ焼けてないって',
  '裏返すの早すぎ', '奉行きた', 'タレ派?塩派?', '両方に決まってる',
  '野菜も食べなさい', 'ピーマン誰が入れた', '椎茸は渡さない', 'カルビ天才',
  '煙すご!換気!', '白柳さんごめん…', '床は汚さない誓い', '紙皿どこ?',
  '乾杯しよ乾杯!', '氷足りてる?', 'ノンアルで我慢', '勤務中では?',
  '社長も食べます?', '経費で落ちる?', '落ちるわけない', '領収書切っといて',
  '串の回転が職人', '焦げも味のうち', '炭酸置いといたよ', 'マシュマロ持参勢',
  'とうもろこし甘い', 'エビ焼けた?', '海鮮もいける', '次は屋上でやりたい',
  '風向き考えて', '髪に匂いつくやつ', '明日も匂う自信ある', 'それは勲章',
  '写真撮ろ写真', 'YT素材にする?', '社外秘BBQです', '配信したら伸びそう',
  'トング貸して', 'トング返して', 'トング戦争勃発', 'じゃんけんで解決',
  '網交換します', '有能すぎる', '塩加減が神', '店開けるレベル',
  '食後の仕事つらい', '眠くなるやつ', 'コーヒーで締めよう', '〆の焼きおにぎり',
  '最後の一枚どうぞ', 'いや、どうぞどうぞ', '譲り合い美しい', 'じゃあ半分こ',
  '片付けまでがBBQ', '分別はあっち', '炭の処理は任せろ', '解散後10分で会議な',
  '火加減どう?', '強すぎず弱すぎず、いま最高',
  'この網、いつ買ったの?', '社長が去年こっそり買ってた',
  'タレ、自作した人いる?', 'すりおろし玉ねぎ入れてきた',
  '焼き係、代わろうか?', '任せる、煙で目が痛い',
  '野菜も焼こうよ', 'とうもろこし、絶対うまいやつ',
  '飲み物足りてる?', 'クーラーボックスにまだあるよ',
  'この匂い、廊下まで行ってない?', '行ってる。完全に行ってる',
  '締めは何がいい?', '焼きおにぎり一択でしょ',
  'ちょっと焦げた', '焦げがうまいんじゃん',
  '紙皿、あと何枚?', '数えたら足りない、分け合おう',
  '次は何を焼く?', '厚切りの出番でしょ',
  '誰か換気してくれた?', 'したつもりだった',
  'これ経費で落ちる?', '社長に聞くのはやめよう',
  '肉の焼ける音、いいよね', '世界一いい音だと思う',
  '手が油まみれ', 'おしぼり、そっちにある?',
  '仕事に戻れる気がしない', '戻るけどね、ちゃんと',
  '来月もやろう', '社長の許可、誰が取る?',
  'いい会社だな、ほんと', 'こういう日があるからやれる',
  '塩とタレ、どっち派?', '一枚目は塩でしょ',
  '網、後で洗うの誰?', 'じゃんけんで決めよう',
  'このソーセージ当たりだ', 'もう一本もらっていい?',
  '煙、こっち来た!', '風向き変わった、避難!',
  'この時間が幸せすぎる', '明日から本気出せる気がする',
  'ちょっと味濃くない?', '飲み物が進むからいいんだよ',
  '次はもっと椅子を用意しよう', '議事録に書いておいて',
  '焼きすぎた分、誰か食べて', '任せて、まだいける',
  '座って食べたい', '立ち食いのほうが入るらしいよ',
  '写真、撮っておこうか', '証拠が残るけど大丈夫?',
  '外でやったほうがいいのでは', 'それを言ったら終わりだよ',
  'カセットボンベ、予備ある?', 'たしか棚の下にあったはず',
], GYM_TALK = [
  'フォーム見てて', '腰引けてるよ', 'あと3回!', '無理っす…',
  '呼吸止めない!', 'プロテイン持参?', '水しかない', '気合いで補え',
  'ベンチ軽すぎ?', '盛りすぎ盛りすぎ', 'プレート外して', '謙虚が一番',
  '有酸素もやろ', 'トレッドミル故障してない?', '歩くだけなら得意', '早歩き選手権しよ',
  'ヨガマット気持ちいい', 'そのポーズ何?', '戦士のポーズ', '戦士は無理な体勢',
  '腹筋ローラーある?', 'ないから床で', '床は白柳さんの聖域', '汗は拭いてから',
  '筋肉は裏切らない', '締切は裏切る', '名言やめて', '刺さるからやめて',
  'バランスボール乗れる?', '3秒が限界', '私は5秒いけた', 'レベル低い争い',
  '明日筋肉痛だな', '明後日に来るタイプ', '歳の話やめよ', '心は永遠に20代',
  'ジム部作らない?', '部費は経費?', 'また経費の話…', '却下されるまでがオチ',
  'ウォームアップした?', 'いきなり本番派なんだよね',
  'このダンベル何キロ?', '見た目より重いから気をつけて',
  'フォーム見ててもらえる?', '腰、もう少し落として',
  'あと何回?', 'あと3回!いける!',
  '呼吸忘れてた', '止めると危ないよ、吐いて',
  'マット、貸して', 'どうぞ、汗拭いてから返して',
  '昨日の筋肉痛が残ってる', 'それ、効いてる証拠',
  'プロテインいる?', '味が苦手なんだよね',
  'ベンチ、順番待ち?', '空いたら声かけるよ',
  'この時間だけ体育会系だね', '普段は座りっぱなしだからね',
  '柔軟から始めよう', '体が硬すぎて笑える',
  '汗、拭いてから戻ろう', '白柳さんに怒られるやつ',
  '目標は何キロ?', '健康にいられればそれでいい',
  '続けるコツってある?', '無理しないこと。それだけ',
  '休憩はさもう', '30秒だけね、冷めるから',
  '意外と楽しいね、これ', 'ジム部、本気で作る?',
  '水分!飲んで!', 'ありがとう、生き返った',
  '肩甲骨が動いてる感じする', 'いいね、それが正解',
  '明日も来る?', '来る…と思う…たぶん',
  '背筋、意識して', '意識したら余計わからなくなった',
];

const EVENT_REACT_BBQ = [   // 焼肉のときだけの野次
  'いい匂いしてきた…', 'ずっと混ざっていたい…', 'あとで一口ください', '音がもう美味しい', '煙こっち来た(嬉しい)', '腹の音が鳴った', '夕飯どうしよ…', 'カロリーは正義',
  '罪の匂いがする', 'ダイエット中なのに', '寝言がBBQに反応してる', '鼻が動いてる(笑)', '無理、匂いが勝つ', '網の音ASMR', '作業BGMがジュージュー', '集中力が肉に負ける',
  '匂いで日報書けそう', '今日の日報:肉'
];
const EVENT_REACT_GYM = [   // 筋トレのときだけの野次
  '筋トレ組は偉いな', '見てるだけで疲れた', 'ファイトー!', 'いっぽーん!', 'あと3回とか鬼', 'コーチ厳しすぎ(笑)', 'フォームきれい', '腰は大事にね', '労災になるよ(笑)'
];
const EVENT_REACT_ANY = [   // どちらでも成立する野次
  '仕事に集中できない件', '休憩取ればよかった', '次は絶対参加する', '楽しそうで何より', '声でかいって(笑)', '議事録は取らんでいい', '平和な会社だ…', '集中…集中…', 'イヤホンで防御',
  '写真だけ撮っとこ', 'SNSに載せたい', '社外秘らしいよ', '残念すぎる', '白柳さんの顔が曇ってる', '床…床が…', '掃除係の苦労よ', 'あとで手伝お', '明日から本気出す',
  '月城さん寝てるのに', 'よく寝れるな…', '社長も楽しそう', '童心に帰ってる', '経費の行方が心配', '税理士に怒られるやつ', '仕事終わったら混ざる', 'あと1タスク…',
  'ビルド待ちの間だけ…', 'ちょっとだけ…いや駄目だ', '祭りかな?', '文化祭みたい', '青春してるな', 'うちの会社どうなってんの', '羨ましくなんか…ある', '正直めっちゃ羨ましい',
  '心を無にして作業', '今日は負けを認める', '座ってるだけの係です', '応援だけしとく', '安全第一,品質第一', '若いなあ…', '気持ちだけは若手', 'それを言っちゃおしまい',
  '夢のある会社です', '平和すぎて泣ける', '明日も頑張れそう', 'この会社好きだわ', '入社してよかった', '誰か仕事して(笑)', 'やってる人はやってます', '頼もしすぎる', '給料上げてあげて',
  '社訓「無限労働」とは', '休憩も仕事のうち', 'いい文化になった', 'ミッションは達成される', '承認します', '最高の会社かよ'
];
const EVENT_REACT_POOL = { bbq: EVENT_REACT_BBQ.concat(EVENT_REACT_ANY), gym: EVENT_REACT_GYM.concat(EVENT_REACT_ANY) };

const WORK_TALK = [
  'まず要件を整理しよう', '期限はいつまで?', '今日中にいけます', '仕様書どこでしたっけ',
  'ブランチ切っときました', 'レビュー誰に振る?', 'こっちで見ます', 'テスト先に書こう',
  '既存の実装が使えそう', 'ゼロから書いた方が早いかも', '依存関係だけ気をつけて', '互換性は保つ方向で',
  '英語版も出します?', 'まずは日本語だけで', 'サムネどうします?', 'A/Bテストしよう',
  '前回の反省を活かそう', '同じバグ二度と出さない', 'ログ仕込んでおきます', 'エラー処理そこ手厚めで',
  '負荷は大丈夫そう?', 'キャッシュ効かせます', 'コスト意識だけ頼む', 'なるべく安く済ませよう',
  '成果物はどこに置く?', 'いつものフォルダで', '命名規則そろえよう', 'READMEも更新しとく',
  '誰かペアで入れる?', '手すき居ます?はい私!', '助かる、頼んだ', '30分後に進捗共有で',
  '仕様変更の可能性ある?', '一応ある、抽象化しとこ', '了解、差し替え前提で', '本番は夜に流します',
  '検証環境ある?', 'ローカルで再現できます', 'それは助かる', 'まず小さく出そう',
  'リリースノート書く?', '一行でいいよ', 'バックアップ取った?', '取りました、いつでも戻せます',
  '音声の質どうする?', '花音でいきましょう', '字幕はFCPXMLで', 'いつものパイプラインで',
  'BGMのトーンは?', '朝は明るめ、夜しっとり', 'ジャケットも合わせよう', '照明は昼寄りで',
  '数字どう見る?', 'CTRが先、維持率は後', '仮説は立ってる?', 'サムネの文字数だと思う',
  '競合は見た?', 'ざっと3チャンネル見ました', '差別化ポイントは?', '声と物語の一貫性かと',
  'それ今日必要?', '明日でいい、優先度下げよ', '逆にこれは今日中', '分かった、先やる',
  '詰まったら早めに言って', '10分悩んだら聞きます', 'その姿勢でよろしく', '無理はしないでいい',
  '完璧より完成な', '60点で出して直す', '品質第一じゃ?', '出してからの品質第一だ',
  'この命名センスある', '変数名で笑わせないで', 'コメント書いといて', '未来の自分のためにね',
  'マージ通りました', 'ナイス、次いこう', 'デプロイ完了です', '確認した、問題なし',
  'エラー1件出てます', 'ログ見る、5分待って', '原因わかった、直します', '再発防止も添えて',
  '会議これで終わり', '各自よろしく!', '了解です!', 'がんばりましょう',
  '今日の山場はここだな', '越えたら休憩にしよう', 'BBQの材料買っとく?', 'それは勤務外でお願い',
  '白柳さんに感謝だな', '床がピカピカです', '集中できる環境って大事', 'では、解散!',
];

const BOSS_ORDERS = ['ここ、頼んだぞ', '例の件、よろしく', 'クオリティ第一でな', '急ぎでお願い', '任せた!', '期待してるぞ',
  'ここ、任せていいか?', 'この件、頼めるか', '優先度は高めで頼む',
  '困ったら遠慮なく言え', '期待してるぞ', '無理そうなら早めに言ってくれ',
];
const BOSS_REPLIES = ['了解です!', 'お任せください', 'ラジャです', 'がんばります!', '承知しました!',
  'かしこまりました', '全力でやります', '得意分野です!', '手が空いてるので大丈夫です', 'すぐ着手します',
];
const directive = { queue: [], active: null, next: 0 };

/* 作戦会議: 同じスナップショットで2人以上が稼働開始→社長が招集して短い会議 */
const standup = { pending: null, active: null, next: 0 };
const STANDUP_POS = [
  { x: 414, y: 200, a: 'faceD' },   // 社長
  { x: 396, y: 222, a: 'faceR' },
  { x: 432, y: 222, a: 'faceL' },
  { x: 414, y: 234, a: 'faceU' },
];

/* 社内イベント: 暇な人が多いと自然発生(BBQ=5人以上 / 筋トレ=3人以上) */
const officeEvent = { active: null, next: 90000, cooldown: 0 };
const EVENT_PROPS = {
  bbq: [
    ['b_grill', 266, 150, 38, 31], ['b_table', 310, 152, 42, 31], ['b_meat', 314, 147, 18, 14],
    ['b_skewer', 336, 149, 16, 13], ['b_cooler', 246, 170, 16, 16], ['b_beer', 296, 180, 11, 16],
  ],
  gym: [
    ['g_tread', 222, 146, 26, 26], ['g_rack', 252, 148, 36, 21], ['g_barbell', 294, 152, 40, 13],
    ['g_bench', 340, 152, 26, 23], ['g_mats', 274, 172, 30, 16], ['g_ball', 350, 174, 15, 16],
  ],
};
// 総務部(y216の机列)と被らないよう、イベントの立ち位置はy198以下に収める
const EVENT_SPOTS = {
  bbq: [ { x: 284, y: 194, a: 'faceU' }, { x: 258, y: 190, a: 'faceR' }, { x: 310, y: 198, a: 'faceU' },
         { x: 336, y: 194, a: 'faceU' }, { x: 358, y: 190, a: 'faceL' }, { x: 238, y: 162, a: 'faceR' }, { x: 372, y: 162, a: 'faceL' } ],
  gym:  [ { x: 264, y: 192, a: 'faceU' }, { x: 296, y: 196, a: 'faceU' }, { x: 328, y: 192, a: 'faceU' }, { x: 356, y: 196, a: 'faceU' } ],
};

function stepEvent(t) {
  if (officeEvent.active) { runEvent(t); return; }
  if (chimeBreak.until && t < chimeBreak.until) return;   // チャイム休憩中はイベントを始めない
  { const hLo = jstNow().h; if (hLo >= 22 || hLo < 5) return; }   // 消灯中は宴会禁止
  if (t < officeEvent.next || t < officeEvent.cooldown) return;
  officeEvent.next = t + 30000;
  if (standup.active || fight.active) return;
  const idle = employees.filter(e => e.present && e.mode === 'idle' && !e.inChat && !e.atMeeting && !e.receptionOn && e.action !== 'walk' && e.action !== 'sleep');
  // 白柳も誘う(掃除は逃げないので)
  const jan = employees.find(x => x.def.source === 'janitor');
  if (jan && jan.present && !jan.inChat && !jan.inEvent && jan.action !== 'walk' && Math.random() < 0.7) idle.push(jan);
  if (idle.length >= 5) startEvent('bbq', idle.slice(0, 7), t);
  else if (idle.length >= 3 && Math.random() < 0.5) startEvent('gym', idle.slice(0, 4), t);
}

function startEvent(kind, members, t) {
  members.forEach((e, i) => {
    e.releaseSpot(); e.releaseReception(); e.resting = false;
    e.inChat = true; e.inEvent = true;
    const p = EVENT_SPOTS[kind][i % EVENT_SPOTS[kind].length];
    e.goto({ x: p.x, y: p.y }, p.a);
  });
  const hEv = jstNow().h;
  const longBBQ = kind === 'bbq' && hEv >= 17 && hEv < 22;   // 夕方はロング焼肉OK(MON公認)
  const dur = longBBQ ? 420000 + Math.random() * 240000 : 160000 + Math.random() * 60000;
  officeEvent.active = { kind, members, startT: t, until: t + dur, alarmDelay: Math.max(90000, dur - 60000), nextLine: t + 6000, nextReact: t + 9000 };
}

// ララ×焼肉: BBQ中は必ず餌をねだりに来る。あげようとすると怒られる
const LARA_BEG = [
  'くぅ〜ん…🍖', 'ワン!ワン!🍖', '(お座りして待機)', '(しっぽ高速回転)', '(よだれ)',
  'じーーーっ👀', '(前足ちょいちょい)', 'クゥーン…💕', 'ワンッ🍖ワンッ🍖', '(胸を張ってアピール)',
  '(圧のあるお座り)', 'へっへっへっ(息)',
  '(お座りしたまま動かない)', 'ワフッ(こっち見て)', '(前足で服を引っぱる)', '(鼻先でつついてきた)',
  '(涙目で見上げている)', 'クゥン…クゥン…', '(順番待ちの列に並んでいる)', '(いい子アピールが激しい)',
  '(しっぽで床を叩いている)', '(伏せて上目づかい)', 'ワン(ひとくちだけ)', '(あきらめない)',
];
const LARA_FEED = [
  'ララにひとくちだけ…🍖', 'タレついてないとこなら…', 'ララもBBQ参加でしょ?', '(こっそり肉を下ろす)',
  'この端っこ、あげていい?', 'ララ、お手!できたらあげる', '見てられない…あげちゃお', '野菜ならいいよね?',
  'ララ専用の皿、用意しちゃった', '小さいのならバレない…', '焼く前のやつなら…', 'ララが泣いてるんだけど!?',
  '味のついてないやつなら…', 'これ、脂身だから大丈夫だよね?', 'ララも社員だし…',
  '一枚だけ、内緒で', '(こっそり手を伸ばした)', 'この目に勝てる人いる?',
  'ちょっとだけならバレない', '野菜だから健康的でしょ', 'ララ用の皿、持ってきた',
  '(周りを確認してから)', '今日は特別な日だから', '焼く前ならセーフ理論',
];
const LARA_SCOLD = [
  '人の食べ物あげちゃダメ!💢', 'タレも塩もダメ!全部ダメ!', '犬にネギ類は厳禁だよ!?', '社長に怒られるよ!?',
  'ララのごはんはあっち!', 'あーあ、味覚えちゃうじゃん', 'ダメったらダメ!鬼と呼ばれても!', '獣医さんに怒られるやつ!',
  'その皿しまいなさい!', 'BBQ奉行より犬奉行になりなさい', 'かわいさに負けるな!', 'こっちは我慢してるのに!?',
  '塩分!塩分がダメなの!', 'その手を今すぐ引っ込めて!', 'ドッグフードがあるでしょ!',
  '甘やかすと味を覚えるって!', 'あとで吐いても知らないよ', 'それ、愛じゃなくてただの甘やかし',
  'ララの寿命が縮むよ!', '(皿ごと取り上げた)', 'かわいいけどダメなものはダメ!',
  'こっそりやってもバレてるからね', '次やったら社長に報告する', '獣医さんの顔が浮かぶ…',
];

// BBQの煙→もくもく→火災報知器
let hazeLevel = 0;

// 解散後の余韻(それぞれ持ち場に戻りながらの独り言)
const BBQ_AFTER = [
  '肉、うまかったな…', 'タレの匂いが服についた', '次は牛タン枠を増やそう', '完全に食べすぎた…',
  '網、誰が洗うんだろう', '炭の火起こし、上達したわ', '締めの焼きおにぎり食べ損ねた', '肉の口が終わらない',
  '夕飯いらないかも…', 'ララの目が忘れられない', '煙くさいの、嫌いじゃない', '次のBBQは合法でやろう…',
  '報知器、ごめんな', '働くか…肉のパワーで', 'まだ口の中がカルビ',
  '服にしみついた匂い、明日まで残るやつ', 'また食べたい…来月あたり',
  '網の後片付け、じゃんけんで決めよう', 'お腹いっぱいで頭が回らない',
  'あの焦げ目、最高だったな', '肉のあとのお茶がうまい',
  '次はタレを2種類用意しよう', '報知器のことは忘れよう',
  'ララの顔が忘れられない', '働けるかな…働くけど',
  '来月もやるって信じてる', 'また社長に怒られた(恒例)',
  '皿、洗ってから戻ります', '幸せだった…以上', '仕事、思い出せるかな',
];
const GYM_AFTER = [
  '明日、絶対筋肉痛だ…', 'プロテイン買っておこう', '腕がプルプルする', 'いい汗かいた…!',
  'フォーム、褒められた', '次は下半身の日にしよう', '体が軽い…気がする', '継続は力なり、って言うし',
  'ジム部、正式に作らない?', '筋肉は裏切らない(社長談)', 'ストレッチも忘れずに…いてて', '汗、拭いてから戻ろ',
  '成長期かもしれない', '握力が終わってる', '心なしか姿勢がいい',
  '腕が上がらない…', '明後日が本番の痛みらしい', '達成感だけはすごい',
  '汗拭きシート常備しよう', 'この調子で続けたい(3日)', '意外と体力あるかも',
  '肩が軽くなった気がする', '筋肉より先に心が折れた', '次はもっといける',
  'ストレッチまでがセットだって', '水分!水分とらないと', '鏡が欲しくなってきた',
  '仕事に戻れる気がしない', 'でも気分は最高', '運動って偉大だ',
];

/* ================================================================
   全社パニック: 焼肉の火災報知器が鳴ったら、座っている人も全員が慌てる
   役割を配って動かす(全員ランダムだと同じ動きに見えて退屈になるため)
   ================================================================ */
const panic = { until: 0, evac: [] };
const PANIC_SPOT = {
  exting: { x: 46, y: 92 },      // 消火器(左上の壁)
  grill: { x: 296, y: 204 },     // グリル
  window: [{ x: 210, y: 96 }, { x: 420, y: 96 }],
  door: { x: 374, y: 346 },      // 入口(外へ)
  guide: { x: 350, y: 322 },     // 入口の内側(誘導係)
  phone: { x: 306, y: 300 },     // 受付(通報)
  water: { x: 136, y: 226 },     // 給水機
  snack: { x: 104, y: 226 },     // おやつ棚
};
const PANIC_RUN = [
  'うわああああ!', '警報!警報!', 'どこ!?どこが燃えてる!?', '落ち着け!誰か落ち着け!',
  '(意味もなく走っている)', 'ぎゃー!', '書類!書類だけは!', '(3周目)',
  '避難マニュアルどこ!?', '誰かー!', '(逆方向に走り出した)', 'パニックです!以上!',
  '心臓が!心臓が!', '(一周して元の位置に戻った)', 'これ訓練じゃないやつ!',
  '足が絡まった!', '出口はどっち!?', '(荷物を持って走り出した)', '誰か指示を出して!',
  'これ何度目の訓練だっけ!?', '(走りながら振り返っている)', '一回落ち着こう!(落ち着かない)',
  '助けて!誰か助けて!', '(角でぶつかった)', '心の準備ができてない!',
  'なんで警報って心臓に悪いの!', '(逃げ道を計算している)', '足がもつれる!',
  '誰が!誰が焼いた!', '(意味もなく机を叩いた)',
];
const PANIC_EXT = [
  '消火器!消火器どこ!', '(消火器を抱えて走ってきた)', 'ピン!ピン抜くんだよね!?',
  '訓練の成果、見せます!', '(消火器が重すぎる)', '任せろ!任せてくれ!',
  '(安全ピンと格闘中)', 'ホースの向き!向きどっち!', '説明書!説明書読む時間ある!?',
  '(構えたけど噴射しなかった)', '訓練でやったのに忘れた!', '誰か使い方わかる人!',
];
const PANIC_GRILL = [
  '火を消せー!', '(グリルの電源を探している)', '肉!肉だけは助ける!',
  'まだ焼けてない!もったいない!', '(タレをかけて余計に燃えた)', '網!網が真っ赤!',
  '(コンセントを引き抜いた)', '蓋!蓋をかぶせろ!', '炭!炭を落とすな!',
  '(トングで格闘している)', 'まだ食べてないのに!', '肉に罪はない!',
];
const PANIC_WINDOW = [
  '窓!窓開けて!', '(窓を開けようと必死)', '換気!換気だー!',
  'この窓、開かないやつだ!', '(うちわで扇いでいる)', '煙が!煙が来る!',
  '(全力で押している)', '空気!新鮮な空気を!', 'サッシが固い!',
  '誰かこの窓の開け方知らない?', '(息を止めている)', '煙は上にいくから低い姿勢で!',
];
const PANIC_EVAC = [
  '避難します!外!外!', '(入口に向かって全力疾走)', '押さない走らない!(走ってる)',
  '外で点呼とります!', 'お先に失礼します!!', '(いちばんに逃げた)',
  '非常口!非常口どこ!', '(靴を履き替える余裕はない)', '先に行きます!ごめん!',
  '外の空気がおいしい!', '(振り返らずに出ていった)', '安全確認してから戻ります!',
];
const PANIC_BACK = [
  '(こわごわ戻ってきた)', '外、暑かった…', '誤報…でしたか…', '(気まずそうに席へ)',
  'ただいま戻りました', '避難訓練、成功ということで',
  '(そっとドアから顔を出した)', 'もう大丈夫…ですよね?', '外で3人集まってました',
  '(息を整えている)', '生きててよかった…', '避難経路、覚えました',
];
const PANIC_BOSS = [
  'なんだ!?何が起きた!', '会社が!会社が燃える!', '保険!保険入ってたよな!?',
  '(慌てて立ち上がった)', '誰か状況を説明しろ!', '落ち着け…俺が落ち着け…',
  '消防!消防呼べ!', '全員無事か!点呼!', '俺の会社が…!',
  '(スリッパのまま飛び出した)', '責任は俺が取る!だから逃げろ!', '落ち着いて…いや落ち着けるか!',
];
const PANIC_JAN = [
  '床が!床が焦げます!', '(モップを構えて突撃)', '規定では火気厳禁です!',
  'ワックスが!ワックスが燃える!', '掃除計画が!計画が狂う!',
  'この煙、天井にヤニが!', '(消火の前に養生している)', '掃除の手間が倍に!',
  '規定違反です!始末書です!', '床は守る!床だけは!', '(バケツに水を汲んできた)',
];
/* ---- ここから増設した役割 ---- */
const PANIC_HIDE = [
  '(机の下に潜った)', 'ここが一番安全…', '(丸まって震えている)',
  '呼ばれるまで出ません', '(机の脚をぎゅっと掴んでいる)', '地震じゃないのは分かってる',
  '(椅子でバリケードを作った)', 'ここなら見つからない', '(気配を消している)',
  '誰か迎えに来て…', '(耳をふさいでいる)', '出ていく勇気がない',
];
const PANIC_RESCUE = [
  '(パソコンを抱えて逃げようとしている)', 'データ!データだけは!',
  '(バックアップ…とってたっけ)', 'このマシンは会社の宝だ!', '(ケーブルが抜けない!)',
  '納品前の素材が中に!',
  '(モニターごと持ち上げようとした)', '外付けは!外付けはどこ!', 'これだけは死守する!',
  '(両手がふさがって動けない)', 'クラウドに上げてたっけ!?', '機材は会社の命!',
];
const PANIC_PHONE = [
  '(受話器を握りしめている)', '119!119番!', 'もしもし!あの!えっと!',
  '住所!住所なんだっけ!', '(緊張で番号を押し間違えた)', '通報しました!たぶん!',
  '(手が震えて押せない)', '会社名!会社名なんだっけ!', 'つながった!…あ、切れた',
  '火事です!たぶん!', '(保留音を聞いている)', '誰か代わって!',
];
const PANIC_FREEZE = [
  '(完全に固まっている)', '……', '(足が動かない)', '(目だけが泳いでいる)',
  'あ…あ…', '(石像と化した)',
  '(まばたきすら止まった)', '(呼びかけても反応がない)', 'ふ…ふ…',
  '(手だけがぷるぷるしている)', '(状況を処理しきれていない)', '(白目)',
];
const PANIC_GUIDE = [
  'こちらでーす!順番に!', '(両手を広げて誘導している)', '押さないで!押さないで!',
  '残ってる人いませんかー!', '点呼とります!番号!', '落ち着いて!走らないで!(自分は走った)',
  '(壁ぎわを指さしている)', '深呼吸!深呼吸して!', '順番!順番守って!',
  '(誘導しながら自分も混乱)', '全員こっち見て!', '荷物は置いていって!',
];
const PANIC_DOGSAVE = [
  'ララ!ララどこ!', '(ララを抱きかかえた)', 'ララだけは絶対守る!',
  '(ララの方が落ち着いている)', 'よしよし、大丈夫だからね!', 'ララ、こっち!こっち!',
  '(リードを探している)', 'ララ!返事して!', '(抱っこして走り出した)',
  'この子だけは絶対に!', '(ララに顔をなめられて我に返った)', 'ララ、しっかり掴まって!',
];
const PANIC_WATER = [
  '(コップに水を汲んでいる)', '水!水をかければ!', '(コップ1杯で消せると思っている)',
  '油に水はダメって聞いたような…', '(給水機が空だった)', 'バケツ!バケツはどこ!',
  '(コップを取り落とした)', '消火栓!消火栓は!?', '水はどこ!水!',
  '(半分こぼしながら運んでいる)', 'これじゃ足りない…', 'バケツリレーだ!並んで!',
];
const PANIC_SNACK = [
  '(お菓子を抱えて避難)', 'おやつは死守します!', '(スナック棚を両手で抱えている)',
  'これがないと生きていけない', '(避難より補給を優先した)', 'プリン!プリンは無事!',
  '(菓子袋を胸に抱えている)', '非常食です!非常食!', 'これは備蓄だから!',
  '(お菓子を落として拾いに戻った)', '甘いものは心を落ち着かせる', 'コーヒーも!コーヒーも持つ!',
];
const PANIC_POOL = {
  run: PANIC_RUN, exting: PANIC_EXT, grill: PANIC_GRILL, window: PANIC_WINDOW,
  evac: PANIC_EVAC, boss: PANIC_BOSS, janitor: PANIC_JAN,
  hide: PANIC_HIDE, rescue: PANIC_RESCUE, phone: PANIC_PHONE, freeze: PANIC_FREEZE,
  guide: PANIC_GUIDE, dogsave: PANIC_DOGSAVE, water: PANIC_WATER, snack: PANIC_SNACK,
};
// 社長・白柳以外に配る役札(毎回シャッフルして配るので同じ光景にならない)
const PANIC_DECK = [
  'exting', 'grill', 'window', 'evac', 'evac', 'run', 'run',
  'hide', 'rescue', 'phone', 'freeze', 'guide', 'dogsave', 'water', 'snack',
];

function startPanic(t) {
  panic.until = t + 13000;
  panic.evac = [];
  // 進行中の他イベントは全部たたむ(同じ人を奪い合って動きが固まるため)
  const bossP = employees.find(e => e.def.source === 'boss');
  if (chat.active) endChat(t, 60000);
  if (standup.active) endStandup(t);
  if (fight.active) endFight(t);
  if (romance.active) endRomance(t);
  if (directive.active && bossP) endDirective(bossP, t);
  if (patrol.active && bossP) endPatrol(bossP, t);
  if (groupChat.active) endGroupChat(t, 40000);
  fight.cooldown = Math.max(fight.cooldown, panic.until + 3000);
  // chimeBreak.until を0にするときは、不在の人も含めて全員のフラグを落とす(でないと巡回/恋愛が永久に止まる)
  chimeBreak.until = 0;
  for (const e of employees) { if (e.onChimeBreak) { e.onChimeBreak = false; e.releaseSpot(); e.resting = false; } }
  directive.next = t + 40000; patrol.next = t + 40000; chat.next = t + 40000; groupChat.next = t + 40000;
  // 帰り支度中(まだ present だが mode は out/退勤)の人を巻き込むと、そのまま社内に居座ってしまう
  const folks = employees.filter(e => e.present && e.mode !== 'out' && e.mode !== 'sleephome' && e.mode !== 'off')
    .sort(() => Math.random() - 0.5);
  let wi = 0;
  const deck = PANIC_DECK.slice().sort(() => Math.random() - 0.5);   // 役札を毎回シャッフル
  folks.forEach((e, i) => {
    // 座っていようが会議中だろうが、全員いったん解除して立たせる
    e.releaseSpot(); e.releaseReception();
    e.resting = false; e.atMeeting = false; e.inEvent = false;
    e.janResting = false; e.onChimeBreak = false;
    e.inChat = true; e.panicking = true;
    e.nextThink = panic.until + 3000;
    e.panicLine = t + 200 + i * 260;
    let role;
    if (e.def.source === 'boss') role = 'boss';
    else if (e.def.source === 'janitor') role = 'janitor';
    else role = deck.length ? deck.pop() : 'run';
    e.panicRole = role;
    switch (role) {
      case 'exting': e.goto(PANIC_SPOT.exting, 'faceU'); break;
      case 'grill': e.goto(PANIC_SPOT.grill, 'faceU'); break;
      case 'window': e.goto(PANIC_SPOT.window[wi++ % 2], 'faceU'); break;
      case 'evac': panic.evac.push(e.id); e.goto(PANIC_SPOT.door, 'leave'); break;
      case 'guide': e.goto(PANIC_SPOT.guide, 'faceU'); break;
      case 'phone': e.goto(PANIC_SPOT.phone, 'faceD'); break;
      case 'water': e.goto(PANIC_SPOT.water, 'faceU'); break;
      case 'snack': e.goto(PANIC_SPOT.snack, 'faceU'); break;
      case 'hide': e.goto(e.seat, 'sit'); e.anticUntil = panic.until; break;   // 机の下に潜って震える
      case 'rescue': e.goto({ x: e.seat.x + 18, y: e.seat.y + 6 }, 'faceL'); break;
      case 'dogsave': e.goto({ x: dog.pos.x + 14, y: dog.pos.y + 2 }, 'faceL'); break;
      case 'freeze': e.path = []; e.target = null; e.action = 'stand'; e.anticUntil = panic.until; break;  // その場で硬直(小刻みに震える)
      default: e.goto({ x: 60 + Math.random() * 520, y: 152 + Math.random() * 58 }, 'faceD');
    }
  });
}

function stepPanic(t) {
  if (!panic.until) return;
  if (t > panic.until) { endPanic(t); return; }
  for (const e of employees) {
    if (!e.panicking) continue;
    // 走り回る役は着いたそばから次の場所へ(止まらない)
    if (e.panicRole === 'run' && e.present && e.action !== 'walk' && t > (e.panicNext || 0)) {
      e.goto({ x: 60 + Math.random() * 520, y: 152 + Math.random() * 58 }, 'faceD');
      e.panicNext = t + 1100 + Math.random() * 800;
    }
    if (e.present && t > (e.panicLine || 0)) {
      e.say(t, pickFresh('panic:' + e.panicRole, PANIC_POOL[e.panicRole] || PANIC_RUN), 2600);
      e.panicLine = t + 2500 + Math.random() * 2000;
    }
  }
}

function endPanic(t) {
  panic.until = 0;
  for (const e of employees) {
    if (!e.panicking) continue;
    e.panicking = false; e.inChat = false;
    e.nextThink = t + 1500;
    // 全員その場でぴたっと止まる(この静止のあとに社長の怒声が入る)
    e.path = []; e.target = null;
    if (e.action === 'walk') e.action = 'stand';
    if (panic.evac.includes(e.id)) continue;        // 下の逃走組ループで戻す
    if (e.def.source === 'boss' && officeEvent.active) continue;   // 社長はこのあと怒鳴り込みがあるので動かさない
    if (e.mode === 'idle') continue;                // idle は think() が1.5秒後に自分で動き出す
    // 持ち場に戻す。放っておくと mode==='working' の人は think() が回らず立ちっぱなしになる
    if (e.mode === 'sleep') e.goto(e.seat, 'sleep');
    else if (e.mode === 'off' || e.mode === 'out' || e.mode === 'sleephome') e.goto({ x: 374, y: 346 }, 'leave');
    else e.gotoWork();
  }
  // 外に逃げた人はこわごわ戻ってくる
  panic.evac.forEach((id, i) => {
    const e = employees.find(x => x.id === id);
    if (!e) return;
    if (e.mode === 'off' || e.mode === 'out' || e.mode === 'sleephome') return;   // 帰った人は連れ戻さない
    if (e.mode === 'sleep') { e.goto(e.seat, 'sleep'); return; }
    e.gotoWork();
    e.say(t + 1200 + i * 1800, pickFresh('panicback', PANIC_BACK), 3200);
  });
  panic.evac = [];
}

// イベントの終わり=社長が怒りに来る
const BOSS_BUST_BBQ = [   // 焼肉のときだけの怒声
  '誰が宴会を許可した!?', '経費で肉焼くなーー!!', '煙で火災報知器鳴ったらどうする!!', 'いい匂いさせやがって…解散!!', '匂いで気づいたぞ!!', 'なぜ社内で網を出す!!', '煙が!煙が!!',
  'この匂いで仕事ができるか!!'
];
const BOSS_BUST_GYM = [   // 筋トレのときだけの怒声
  'ダンベルより納期を持てー!!', '筋肉は裏切らないが納期は裏切るぞ!!', '会社をジムにするな!!'
];
const BOSS_BUST_ANY = [   // どちらでも成立する怒声
  'おいこら!仕事はどうした!!', 'ずいぶん楽しそうだなぁ?????', 'はい解散!解散!!', '全員、席に戻れ〜!!', '俺も混ぜ…じゃなくて、解散だ!!', '報知器が泣いてるぞ!!',
  '業務時間だぞ、業務!!', '楽しそうで何より…じゃない!!', '片付け!いますぐ!!', '次やったら経費で落とさんぞ!!', '会議室でやれ…いや、どこでもダメだ!!', '誰の許可だ!俺は聞いてない!!',
  '解散!以上!!'
];
const BOSS_BUST_POOL = { bbq: BOSS_BUST_BBQ.concat(BOSS_BUST_ANY), gym: BOSS_BUST_GYM.concat(BOSS_BUST_ANY) };
const EVENT_SORRY_BBQ = [   // 焼肉のときだけの言い訳
  'あと一本だけ…だめですよね', '社長もどうぞ…すみません', '火は消しておきます!', '一口だけでしたので…', '次は屋上でやります(屋上はない)', 'におい、消しておきます!',
  '社長のぶんも取ってあります', '(そっと網を下ろした)'
];
const EVENT_SORRY_GYM = [   // 筋トレのときだけの言い訳
  'ストレッチは仕事のうち…はい、違います', 'プロテインしまいます!'
];
const EVENT_SORRY_ANY = [   // どちらでも成立する言い訳
  'すみません社長!', '片付けます!', '解散ー!', '戻ります戻ります', 'はい、ただいま!', '見てました?…見てましたか…', '証拠隠滅!', 'ごめんなさい社長!', '(全力で片付け始めた)',
  'つい、盛り上がってしまって', '(証拠を背中に隠した)', '反省してます、たぶん', '(気配を消そうとしている)', '解散します!ただちに!'
];
const EVENT_SORRY_POOL = { bbq: EVENT_SORRY_BBQ.concat(EVENT_SORRY_ANY), gym: EVENT_SORRY_GYM.concat(EVENT_SORRY_ANY) };

function runEvent(t) {
  const ev = officeEvent.active;
  // 仕事が来た人は離脱
  for (const e of ev.members.slice()) {
    if (!e.present || (e.mode !== 'idle' && e.def.source !== 'janitor')) {
      e.inChat = false; e.inEvent = false;
      if (e.mode === 'working') { e.say(t, '仕事きた!離脱!', 2400); e.gotoWork(); }
      ev.members = ev.members.filter(x => x !== e);
    }
  }
  // BBQ: グリルから煙が立ちのぼり、部屋がもくもくして、やがて警報器が鳴る
  if (ev.kind === 'bbq') {
    if (!ev.nextSmoke || t > ev.nextSmoke) {
      spawnParticle('bsmoke', 276 + Math.random() * 18, 149 + Math.random() * 4);
      ev.nextSmoke = t + 240 + Math.random() * 260;
    }
    const elapsed = t - (ev.startT || t);
    ev.haze = Math.min(0.26, Math.max(0, (elapsed - 20000) / 70000) * 0.26);
    // ララに肉をあげようとして怒られる小芝居
    if ((!ev.nextLara || t > ev.nextLara) && ev.members.length >= 2 && !ev.phase) {
      const A = ev.members[Math.floor(Math.random() * ev.members.length)];
      const B = ev.members[(ev.members.indexOf(A) + 1) % ev.members.length];
      A.say(t, pickFresh('larafeed', LARA_FEED), 3000);
      B.say(t + 2700, pickFresh('larascold', LARA_SCOLD), 3000);
      dog.bubble = ['(しっぽ全開)💕', 'ワンッ!!', 'くーん…😢', '(スン…)'][Math.floor(Math.random() * 4)];
      dog.bubbleUntil = t + 6200;
      ev.nextLara = t + 25000 + Math.random() * 20000;
    }
    if (!ev.alarmed && elapsed > (ev.alarmDelay ?? 90000) && ev.members.length) {
      ev.alarmed = true;
      startPanic(t);                 // 座っている人も含めて全社パニック
      ev.until = t + 13500;          // 騒ぎが収まった直後に社長が怒鳴り込む
    }
  }
  // 社長の解散劇(お叱り)フェーズ
  if (ev.phase === 'bust') {
    const boss = ev.boss;
    if (!boss || !boss.present || !ev.members.length) { endEvent(t); return; }
    if (ev.bustStage === 'walk') {
      if (boss.action !== 'walk') {
        ev.bustStage = 'scold';
        ev.bustAt = t;
        boss.say(t, pickFresh('bossbust:' + ev.kind, BOSS_BUST_POOL[ev.kind]), 3800);
        ev.members.forEach((e, i) => {
          e.dir = e.pos.x > boss.pos.x ? 'left' : 'right';
          e.say(t + 1400 + i * 750, pickFresh('evsorry:' + ev.kind, EVENT_SORRY_POOL[ev.kind], e.id), 2600);
        });
      }
      return;
    }
    if (t > ev.bustAt + 4800) endEvent(t);
    return;
  }
  if (ev.members.length < 2) { endEvent(t); return; }
  if (t > ev.until) {
    const boss = employees.find(e => e.def.source === 'boss');
    if (boss && boss.present && !boss.inChat && !boss.directing && !boss.recording && boss.action !== 'walk') {
      ev.phase = 'bust'; ev.bustStage = 'walk'; ev.boss = boss;
      boss.releaseSpot(); boss.releaseReception(); boss.resting = false;
      boss.inChat = true;
      boss.goto({ x: 148, y: 162 }, 'faceR');   // 自席近くから遠雷のように怒鳴る(歩かせすぎない)
    } else {
      endEvent(t);   // 社長不在なら自然解散
    }
    return;
  }
  if (t > ev.nextLine && !panic.until) {
    const pool = ev.kind === 'bbq' ? BBQ_TALK : GYM_TALK;
    const pi = pickPairIdx('ev:' + ev.kind, pool);
    // Q→Aのペアなので行は消せない。代わりに「その名前が出てくる本人」以外を話し手に選ぶ
    const cands = ev.members.filter(m => m.action !== 'walk' && !namesSelf(pool[pi], m.id));
    const talker = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
    if (talker) {
      talker.say(t, decorate('ev:' + ev.kind, pool[pi]), 3200);
      const others = ev.members.filter(m => m !== talker && m.action !== 'walk'
        && !(pool[pi + 1] && namesSelf(pool[pi + 1], m.id)));
      const rep2 = others.length ? others[Math.floor(Math.random() * others.length)] : null;
      if (rep2 && pool[pi + 1]) rep2.say(t + 3300, decorate('ev:' + ev.kind, pool[pi + 1]), 3200);
      if (ev.kind === 'gym') { talker.anticUntil = t + 3500; }
      ev.nextLine = t + 7200 + Math.random() * 3000;
    }
  }
  if (t > ev.nextReact && !panic.until) {
    const watchers = employees.filter(e => e.present && !e.inEvent && !e.inChat && e.def.source !== 'janitor');
    if (watchers.length) {
      const wt = watchers[Math.floor(Math.random() * watchers.length)];
      wt.say(t, pickFresh('evreact:' + ev.kind, EVENT_REACT_POOL[ev.kind], wt.id), 3200);
    }
    ev.nextReact = t + 8000 + Math.random() * 8000;
  }
}

function endEvent(t) {
  const ev = officeEvent.active;
  if (ev) {
    const afterPool = ev.kind === 'bbq' ? BBQ_AFTER : GYM_AFTER;
    ev.members.forEach((e, i) => {
      e.inChat = false; e.inEvent = false; e.nextThink = 0;
      if (e.mode === 'working') e.gotoWork();
      else if (e.mode === 'sleep') e.goto(e.seat, 'sleep');
      // 持ち場に戻りながらの余韻独り言
      e.say(t + 2500 + i * 1600 + Math.random() * 1200, pickFresh('evafter', afterPool, e.id), 3400);
    });
    if (ev.boss) {
      ev.boss.inChat = false;
      ev.boss.nextThink = 0;
      if (ev.boss.mode === 'working') ev.boss.gotoWork();
      if (Math.random() < 0.5) ev.boss.say(t + 4000, ['まったく…楽しそうで何よりだ', '次は俺も呼べよ…じゃなくて!', 'はぁ…若いっていいな', '床、白柳さんに謝っておけよ'][Math.floor(Math.random() * 4)], 3200);
    } else {
      // 怒鳴り込みが不発だった場合、パニックで持ち場を離れたままの社長を戻す(endPanicは社長を触らない)
      const bossE = employees.find(x => x.def.source === 'boss');
      if (bossE && bossE.present && bossE.mode === 'working'
        && !bossE.recording && !bossE.inChat && bossE.action !== 'walk' && bossE.action !== 'sit') {
        bossE.gotoWork();
      }
    }
  }
  officeEvent.active = null;
  officeEvent.cooldown = t + 2400000 + Math.random() * 1800000;   // 40〜70分に1回まで
}

function stepStandup(t) {
  const boss = employees.find(e => e.def.source === 'boss');
  // 途中で社長が退社したら朝会を畳む。畳まないと参加者の inChat が立ちっぱなしになる
  if (!boss || !boss.present) { if (standup.active) endStandup(t); return; }
  if (standup.active) {
    const st = standup.active;
    const alive = st.members.filter(e => e.present);
    if (alive.length < 2) { endStandup(t); return; }
    if (st.phase === 'go') {
      if (alive.every(e => e.action !== 'walk')) { st.phase = 'talk'; st.nextLine = t + 500; }
      return;
    }
    if (t > st.nextLine) {
      if (st.li >= st.lineCount) { endStandup(t); return; }
      const pi = pickPairIdx('worktalk', WORK_TALK);
      const qer = alive[st.li % alive.length];
      const aer = alive[(st.li + 1) % alive.length];
      qer.say(t, decorate('worktalk', WORK_TALK[pi]), 3100);
      if (WORK_TALK[pi + 1]) aer.say(t + 3200, decorate('worktalk', WORK_TALK[pi + 1]), 3100);
      st.li += 2;
      st.nextLine = t + 7000;
    }
    return;
  }
  if (!standup.pending || t < standup.next) return;
  if (chimeBreak.until && t < chimeBreak.until) { standup.next = t + 5000; return; }   // チャイム休憩中は朝会延期
  if (boss.inChat || boss.atMeeting || boss.recording || boss.action === 'walk' || directive.active) { standup.next = t + 5000; return; }
  const ids = standup.pending;
  standup.pending = null;
  const members = [boss];
  for (const id of ids) {
    const e = employees.find(x => x.id === id);
    if (e && e.present && e.mode === 'working' && !e.inChat && members.length < 4) members.push(e);
  }
  if (members.length < 3) { members.slice(1).forEach(e => directive.queue.push(e.id)); return; }
  members.forEach((e, i) => {
    e.releaseSpot && e.releaseSpot(); e.releaseReception && e.releaseReception();
    e.resting = false; e.inChat = true;
    const p = STANDUP_POS[i];
    e.goto({ x: p.x, y: p.y }, p.a);
  });
  standup.active = { members, phase: 'go', li: 0, lineCount: 6 + Math.floor(Math.random() * 5), nextLine: 0 };
}

function endStandup(t) {
  const st = standup.active;
  if (st) {
    for (const e of st.members) {
      if (!e.panicking) e.inChat = false;
      e.nextThink = 0;
      if (e.present && e.mode === 'working') e.gotoWork();
    }
  }
  standup.active = null;
  standup.next = t + 60000;
}

// 机に話しかけに行く立ち位置。総務部の島は机が隙間なく並ぶので、左が塞がっていたら右→正面に回り込む
function deskApproach(tgt) {
  const d = tgt.desk;
  const blocked = x => employees.some(e => e !== tgt && e.desk && e.desk.y === d.y
    && x > e.desk.x - 25 && x < e.desk.x + 25);
  if (!blocked(d.x - 30)) return [{ x: d.x - 30, y: d.y + 20 }, 'faceR'];
  if (!blocked(d.x + 30)) return [{ x: d.x + 30, y: d.y + 20 }, 'faceL'];
  return [{ x: d.x, y: d.y + 46 }, 'faceU'];
}

function stepDirective(t) {
  const boss = employees.find(e => e.def.source === 'boss');
  if (!boss || !boss.present) { if (directive.active) endDirective(boss, t); return; }
  if (boss.mode === 'out' || boss.mode === 'sleephome' || boss.mode === 'off') { if (directive.active) endDirective(boss, t); return; }
  if (directive.active) {
    const d = directive.active;
    const tgt = d.target;
    if (!tgt.present) { endDirective(boss, t); return; }
    if (d.phase === 'go') {
      if (boss.action !== 'walk') {
        // 回り込む向きが左右どちらにもなるので、相手のほうを向かせる
        boss.dir = Math.abs(tgt.pos.y - boss.pos.y) > Math.abs(tgt.pos.x - boss.pos.x)
          ? (tgt.pos.y > boss.pos.y ? 'down' : 'up')
          : (tgt.pos.x >= boss.pos.x ? 'right' : 'left');
        boss.say(t, pickFresh('order', BOSS_ORDERS), 3200);
        d.phase = 'talk'; d.until = t + 3400;
      }
    } else if (d.phase === 'talk') {
      if (t > d.until) {
        tgt.say(t, pickFresh('orderreply', BOSS_REPLIES), 2800);
        d.phase = 'back'; d.until = t + 3000;
      }
    } else if (d.phase === 'back') {
      if (t > d.until) endDirective(boss, t);
    }
    return;
  }
  if (t < directive.next || !directive.queue.length) return;
  if (chimeBreak.until && t < chimeBreak.until) return;   // チャイム休憩中は指示しない
  if (boss.inChat || boss.atMeeting || boss.recording || boss.action === 'walk') return;
  const id = directive.queue.shift();
  const tgt = employees.find(e => e.id === id);
  if (!tgt || !tgt.present || tgt.mode !== 'working') { directive.next = t + 5000; return; }
  boss.releaseSpot(); boss.releaseReception(); boss.resting = false;
  boss.inChat = true; boss.directing = true;
  tgt.inChat = true;   // 対象をロック(話しかけ中に雑談へ拉致されない)
  if (tgt.id === 'tsukishiro') boss.goto({ x: TSUKI_STUDIO_POST.x - 26, y: TSUKI_STUDIO_POST.y + 2 }, 'faceR');
  else { const [sp, fc] = deskApproach(tgt); boss.goto(sp, fc); }
  directive.active = { target: tgt, phase: 'go' };
}

function endDirective(boss, t) {
  if (directive.active && directive.active.target) directive.active.target.inChat = false;
  directive.active = null;
  directive.next = t + 15000;
  if (!boss) return;
  boss.inChat = false; boss.directing = false;
  boss.nextThink = 0;
  if (boss.present && boss.mode === 'working') boss.gotoWork();
}

/* ================================================================
   社内恋愛: きょうこ(廣瀬)×伊藤
   仕事中の伊藤を応援しに行く / 2人とも暇ならデートに誘う
   ================================================================ */
const romance = { active: null, nextCheer: 90000, nextDate: 600000 };
// 消灯後の伊藤×きょうこ(静かないちゃつき)
const NIGHT_COUPLE = [
  '消灯後のオフィス、二人占めだね', '星…見えないけど、隣にいるし', '肩、借りるね', '今日もお疲れさま、伊藤くん',
  '(小声)みんな寝てるから静かにね', '手、あったかい', 'このまま朝まで…はダメかな', '夜のソファは特等席',
  '寝顔見られるの恥ずかしい…けど見てて', '明日も一緒にがんばろ', 'ちょっとだけ、このままで', '(こつん、と頭を預ける)',
  '深夜のコーヒー、半分こしよ', '秘密の時間だね', 'ふふ、社長には内緒', 'おやすみは…まだ言わない',
  '誰もいない会社って、特別だね', '灯りを消したら星が見えるかな', '(小さな声で笑った)',
  'この時間だけは、二人のものだね', '寝ちゃってもいいよ、見てるから', '朝までなんて言わないけど…',
  '静かすぎて心臓の音が聞こえそう', '明日、寝不足でもいいや', '夜のあなたは少し優しい',
  'ねえ、こっち見て', '(そっと手をつないだ)', 'このまま時間が止まればいい',
  '夜勤も悪くないね', '起きたら朝だね、ちょっとさみしい', '内緒の時間だね', 'また明日も、こうしていたい',
];
// 夜の加藤(消灯後に豹変=スナックのママ)
const KATO_NIGHT = [
  'いらっしゃい…なんてね、ここスナックじゃないのよ', '夜はね、あたしの時間なのよ', '昼のわたし?あれは営業スマイルよ',
  'お酒…置いてないのよね、この会社', '若い頃は六本木で鳴らしたのよ', 'その恋、うまくいくわよ(夜の占い)',
  '明日の朝には優しいおばさんに戻るわ', '社長のネクタイセンス、正直微妙よね', 'フフ…夜は本音が出ちゃうの',
  '肩もんであげよっか?千円ね', '昼間の飴ちゃんは伏線よ', '眠らない女って呼ばれてたわ', 'ママって呼んでもいいのよ?',
  '夜のBGMはジャズに限るわ',
  'ボトル入れとく?…冗談よ', 'あたしの若い頃はもっと無茶したわ', '恋の話なら聞くわよ',
  '夜はね、みんな素直になるの', 'グラス磨きたくなる時間ね', 'あの子たち、うまくいってるじゃない',
  '誰にも言わないから、話してごらん', '朝になったら忘れてあげる', '夜のオフィスって、いい店に見えない?',
  'カウンター越しに愚痴、聞くわよ', 'お通し代はいただかないわ', 'ママって呼ばれてたのは本当よ',
  'この時間のあたしが本体なの', '夜更かしは肌に悪い…知ってるけどね',
];
// 消灯後の月城(スタジオに避難)
const TSUKI_NIGHT = [
  'スタジオが一番落ち着くの', '消灯後はここが私の城', '機材の灯り、きれい…', '(小声で発声練習)',
  'みんなの寝顔、ちょっと面白い', '夜更かしはレディの秘密', '防音室は夜も安心', '台本の予習でもしようかな',
  '3時からの収録に備えないと', 'ここなら物音立てないで済むし',
  '夜の防音室は世界一静か', '機材の呼吸だけ聞こえる', '声を出さずに台本を読む時間',
  'ここにいると落ち着くんです', 'みんなの寝顔は見なかったことに', '夜のうちに明日の分を',
  'コーヒーは飲みすぎないように', '静けさは喉にいいんです', '3時までもう少し', '一人の時間も、悪くないですね',
];
const KYOKO_CHEER = [
  'がんばって、伊藤くん!', '応援しに来ちゃった', 'コーヒー置いとくね(気持ち)', '今日もかっこいいよ、その背中',
  '無理しないでね?', '肩もみしてあげよっか', 'きょうこが見守ってるからね', '進捗どう?…って顔が疲れてる!',
  'タイピング音、好きなんだよね', 'その調子その調子!', '終わったらお茶しよ?',
  '差し入れはわたしの笑顔です', '深呼吸して?はい、すーはー', '伊藤くんのコード、きれいだよね',
  '目、しょぼしょぼしてない?', 'ファイト!超ファイト!', '休憩も仕事のうちだよ?', '世界一がんばってる',
  '今日の伊藤くんも優勝', 'あとちょっとだね、ラストスパート!', 'エラー出ても、わたしは味方',
  '今夜は帰さないんだから', 'その集中してる横顔…ずるい', '終わったら、夜のオフィス探検しよ?',
  '肩もみの続きは…ひみつ', 'がんばる男の人って、素敵', 'ご褒美は…会ってからのお楽しみ',
  'ドキドキしてる?落ち着いて〜', '首、回して回して', 'がんばりすぎ注意報、発令中', '推しの現場に来ました',
  'yorutoolより伊藤くん優先で来た', '手、冷えてない?', 'デバッグの神が降りますように',
  '伊藤くんの集中顔、いいね', '水分とった?', '姿勢!猫背になってる!', '疲れたら呼んでね、飛んでくる',
  '今夜は早く寝てね?', 'わたしの分までがんばらなくていいよ', '応援団長きょうこ、参上',
  'できるできる絶対できる', '天才って言っていい?', 'しゅきしゅき(小声)',
  '差し入れ、机に置いとくね', 'その集中力、尊敬してる', '休憩、ちゃんと取ってる?',
  '無理しないでね、本当に', '今日も一番かっこいいよ', '手、止まってないね、えらい',
  'コーヒー淹れてこようか?', '肩、こってるでしょ', 'ちょっとだけ顔見に来た',
  '応援してるって伝えたくて', 'がんばってるの、私が知ってる', '無理そうなら言ってね',
  'ごはん、ちゃんと食べた?', 'その真剣な顔、反則だよ', '(そっと飲み物を置いた)',
  'あとちょっと、一緒にがんばろ', '疲れたら呼んで、飛んでくる', '今日の伊藤くんも最高',
  '私のことは気にしないで(気にして)', '終わったら褒めてあげる', '目、休ませてね',
  'すごいなあって、いつも思ってる', '力、分けてあげたい', '差し入れ第二弾、いる?',
  'ちゃんと休んでね、お願いだから', '見てるだけで幸せなんだけど', 'いってらっしゃい、がんばって',
  '背中、いつも見てるよ', '無茶しないでね', 'あなたの仕事、好きだよ',
  'もうひと息!ファイト!', '手伝えることある?', '応援団はここにいます',
  'たまにはこっち向いて?', 'その顔が見たくて来た', '今日も一日、おつかれさま',
  '水分とってる?', '休憩したら迎えに来るね', '無理は禁物、でもかっこいい',
  'あとでゆっくり話そうね', '(小さく手を振った)', 'がんばりすぎないでね',
  'ここにいるからね', '肩の力、抜いていいんだよ',
  '今日もそばで見てるからね', '(そっと親指を立てた)',
];
// 夜だけの応援(昼に「終電」と言わせないための分離プール・IDLE_MUTTER_NIGHTと同じ方式)
const KYOKO_CHEER_NIGHT = [
  '終電…あ、家この会社だった', '夜食、何がいい?', 'こんな時間までえらいね', '夜のオフィス、ふたりだけだね',
  'そろそろ休も?ね?', '静かな夜、集中できる?', '夜更かしは肌に悪いよ?', '毛布、持ってこようか',
];
function kyokoCheerPool() {
  const h = jstNow().h;
  return (h >= 19 || h < 5) ? KYOKO_CHEER.concat(KYOKO_CHEER_NIGHT) : KYOKO_CHEER;
}
const ITO_CHEER_REPLY = [
  'お、おう…仕事中だぞ(嬉しい)', 'きょうこか…力出るわ', '見られてると緊張するな…', 'あとでな、いま良いとこ',
  'サンキュ…がんばれる', '肩もみは…あとで頼む', '(タイピングが速くなる)', '照れるからやめれ(照れ)',
  'お茶、行く行く', '深呼吸…すー、はー…効くな', 'これ終わったらデートな', '愛の力で進捗2倍だ',
  '見守られてる…尊い…', 'よし、燃えてきた', '(ニヤけを抑えている)',
  'そ、そんな見つめられたら…', 'いや、助かる', 'いま手が離せないんだって(嬉しい)',
  '差し入れは心で受け取っておく', '応援されると倍やれる', '(キーを打つ手が速くなった)',
  'あとで、ちゃんと時間つくるから', 'その一言で今日が持つ', '(耳が赤い)',
  '見に来てくれるだけでいい', '仕事終わったら、な', '無理させてないか?こっちの心配だよ',
  'ありがとう、本当に', 'よし、もうひと踏ん張り', '(小さくガッツポーズ)',
];
const KYOKO_DATE_INVITE = [
  'ねえ、いまヒマ?デートしよ!', '5分だけソファデートしない?', '伊藤くん、お茶しよ?',
  'ソファ空いてるよ、行こ?', '息抜きデートのお時間で〜す', '手が空いたなら…わたしと過ごそ?',
  'デートの誘いは早い者勝ちだよ', '今日まだ話してない!デート!', 'ソファで5分、恋人タイム!',
  '休憩=デートって社訓にあるよ(ない)', 'ねぇねぇ、いちゃいちゃしにいこ', 'はい、デート券発行されました〜',
  'ちょっとだけ、抜けない?', '休憩、付き合ってくれる?', 'ソファ、ふたり分空いてるよ',
  'たまには私を優先して?', '5分だけ、独り占めさせて', 'コーヒー、一緒に飲も',
  'いま話しかけたら迷惑?…じゃないよね', '手、空いた?空いたって言って',
  '今日はまだ二人で話してない', '仕事のことは忘れる時間、いる?', 'デートって言ったら来る?',
  'ねえ、こっち向いて', '一緒にサボろ?',
];
const ITO_DATE_OK = [
  'お、いいね。行くか', '5分だけな(にっこり)', '待ってました', 'ソファ確保しといて',
  'ちょうど休憩しようと思ってた', 'デート券、使います', '了解、恋人タイム', 'よし、休憩!デート!',
  '(スキップで向かう)', '社訓に追加しとこう、それ',
  '休憩、ちょうど欲しかった', 'その誘い、断れるわけない', '5分…いや10分な',
  'コーヒー、俺が淹れるよ', '(仕事を切りのいいところで止めた)', 'たまにはいいか',
  'ソファ、確保してくる', '(嬉しさを隠しきれてない)', '呼ばれたら行くに決まってる', 'よし、休憩!',
];
const DATE_TALK = [
  '今日の晩ごはん、何にする?', '週末どこ行く?', 'ねえ、手つないでいい?', '伊藤くんの好きなとこ発表します',
  '将来の話…しちゃう?', 'この会社、猫飼わない?', '肩、貸して', '5分が一瞬すぎる…',
  'また夜食作るね', 'きょうこの膝枕、予約制です', '二人の記念日、覚えてる?', '今度こそ映画行こうね',
  '伊藤くんは働きすぎ!', 'たまには寝てよ?', 'わたしのyorutool、褒めて?', '給料日、何買う?',
  'こうしてると落ち着くね', 'ずっとこの5分でいい…', '写真撮ろ、ドット絵だけど', '次のBBQ、隣で食べよ',
  '社長にバレたら…まあいっか', 'ララも連れて散歩行きたいね', '伊藤くんの寝言、聞いたことある',
  '来週もこの時間、空けといてね',
  'この時間があるから頑張れる', '今度の休み、どこ行こうか', 'コーヒー、ちょっと苦かったね',
  '肩、少しだけ借りるね', 'こうしてると時間が早い', '仕事の顔と今の顔、全然違う',
  '誰か来たら離れようね(離れない)', 'また5分延長しない?', '心配してたんだよ、ちゃんと寝てる?',
  '夜ごはん、作りにいこうか', 'このソファ、ふたりの席にしよう', '手、あったかいね',
  '今日もお疲れさま', 'こういう時間、大事にしたい', 'ずっと隣にいたいって言ったら重い?',
  '重くないよ、って言ってほしかった', '次の休憩も約束ね', 'このまま何もしない時間が贅沢',
  '仕事してる背中、好きだよ', '(そっと寄りかかった)', 'また明日もこうしていたい', '5分が一瞬すぎる',
  'この距離、ちょうどいいね', 'また明日も誘っていい?',
];

function stepRomance(t) {
  const kyoko = employees.find(e => e.id === 'hirose');
  const ito = employees.find(e => e.id === 'ito');
  if (!kyoko || !ito) return;
  if (romance.active) {
    const r = romance.active;
    if (!kyoko.present || !ito.present) { endRomance(t); return; }
    if (kyoko.mode !== 'idle') {   // きょうこに仕事が来たら即終了(側の状態も監視)
      if (kyoko.mode === 'working') kyoko.say(t, '仕事きた…続きはまたね!', 2600);
      endRomance(t);
      return;
    }
    if (r.kind === 'cheer') {
      if (r.phase === 'go') {
        if (kyoko.action !== 'walk') {
          r.phase = 'talk'; r.until = t + 3600;
          kyoko.dir = 'left';
          kyoko.say(t, pickFresh('kyokocheer', kyokoCheerPool()), 3400);
          spawnParticle('heart', ito.pos.x + 6, ito.pos.y - 26);
          spawnParticle('heart', kyoko.pos.x - 4, kyoko.pos.y - 28);
        }
      } else if (r.phase === 'talk') {
        if (t > r.until) {
          ito.say(t, pickFresh('itocheer', ITO_CHEER_REPLY), 3000);
          spawnParticle('heart', ito.pos.x, ito.pos.y - 30);
          r.phase = 'back'; r.until = t + 3200;
        }
      } else if (t > r.until) endRomance(t);
      return;
    }
    // date / nightdate
    if (r.phase === 'invite') {
      if (t > r.until) {
        // 予約時から他の人が座った場合は空席を取り直す(二重着席防止)
        if (r.spotA.busy || r.spotB.busy) {
          const free = REST_SPOTS.slice(0, 4).filter(s => !s.busy);
          if (free.length >= 2) { r.spotA = free[0]; r.spotB = free[1]; }
          else { endRomance(t); return; }
        }
        ito.say(t, pickFresh('itodateok', ITO_DATE_OK), 2800);
        r.phase = 'go'; r.until = t + 2000;
        kyoko.takeSpot(r.spotA); ito.takeSpot(r.spotB);
        kyoko.inChat = true; ito.inChat = true;   // takeSpotの後に立て直す
      }
      return;
    }
    if (r.phase === 'go') {
      if (kyoko.action !== 'walk' && ito.action !== 'walk') {
        r.phase = 'talk'; r.nextLine = t + 1500;
        r.until = r.kind === 'nightdate' ? Infinity : t + 60000 + Math.random() * 40000;
      }
      return;
    }
    if (r.phase === 'talk') {
      const loT = jstNow().h >= 22 || jstNow().h < 5;
      const nightOver = r.kind === 'nightdate' && !loT;   // 朝が来たら解散
      if (ito.mode === 'working' || t > r.until || nightOver) {
        if (ito.mode === 'working') ito.say(t, '仕事きた…ごめん、また今度!', 2600);
        else if (nightOver) kyoko.say(t, 'ふふ、朝だ…おはよ', 3000);
        endRomance(t);
        return;
      }
      if (t > r.nextLine) {
        const who = Math.random() < 0.55 ? kyoko : ito;
        const pool = r.kind === 'nightdate' ? NIGHT_COUPLE : DATE_TALK;
        who.say(t, pickFresh(r.kind === 'nightdate' ? 'nightcouple' : 'datetalk', pool), 3400);
        if (Math.random() < 0.5) spawnParticle('heart', (kyoko.pos.x + ito.pos.x) / 2, kyoko.pos.y - 30);
        r.nextLine = t + (r.kind === 'nightdate' ? 8000 + Math.random() * 6000 : 5500 + Math.random() * 3500);
      }
    }
    return;
  }
  // 発動判定
  if (fight.active || standup.active || (officeEvent.active && officeEvent.active.alarmed)) return;
  if (kyoko.inChat || kyoko.atMeeting || kyoko.inEvent || kyoko.onChimeBreak || kyoko.receptionOn) return;
  if (!kyoko.present || kyoko.mode !== 'idle') return;
  // 消灯中は2人ともお暇ならナイトデート(クールダウン無視・朝まででも)
  const loR = jstNow().h >= 22 || jstNow().h < 5;
  if (loR && ito.present && ito.mode === 'idle' && !ito.inChat && !ito.atMeeting && !ito.inEvent) {
    const spA = !REST_SPOTS[0].busy ? REST_SPOTS[0] : (!REST_SPOTS[2].busy ? REST_SPOTS[2] : null);
    const spB = !REST_SPOTS[1].busy ? REST_SPOTS[1] : (!REST_SPOTS[3].busy ? REST_SPOTS[3] : null);
    if (spA && spB) {
      romance.active = { kind: 'nightdate', phase: 'invite', until: t + 2600, spotA: spA, spotB: spB };
      kyoko.releaseSpot(); kyoko.resting = false; ito.releaseSpot(); ito.resting = false;
      kyoko.inChat = true; ito.inChat = true;
      kyoko.say(t, '(小声)ねえ…みんな寝たよ', 2800);
    }
    return;
  }
  // デート: 2人とも暇+ソファが2席空いている
  if (t > romance.nextDate && ito.present && ito.mode === 'idle' && !ito.inChat && !ito.atMeeting && !ito.inEvent
      && !REST_SPOTS[0].busy && !REST_SPOTS[1].busy) {
    romance.active = { kind: 'date', phase: 'invite', until: t + 3000, spotA: REST_SPOTS[0], spotB: REST_SPOTS[1] };
    kyoko.releaseSpot(); kyoko.resting = false; ito.releaseSpot(); ito.resting = false;
    kyoko.inChat = true; ito.inChat = true;
    kyoko.say(t, pickFresh('kyokoinvite', KYOKO_DATE_INVITE), 3000);
    return;
  }
  // 応援: 伊藤が仕事中(自席)なら会いに行く
  if (t > romance.nextCheer && ito.present && ito.mode === 'working' && ito.action === 'sit' && !ito.resting && !ito.inChat) {
    romance.active = { kind: 'cheer', phase: 'go' };
    kyoko.releaseSpot(); kyoko.resting = false;
    kyoko.inChat = true; ito.inChat = true;
    kyoko.goto({ x: ito.desk.x + 28, y: ito.desk.y + 18 }, 'faceL');
  }
}

function endRomance(t) {
  const kyoko = employees.find(e => e.id === 'hirose');
  const ito = employees.find(e => e.id === 'ito');
  for (const e of [kyoko, ito]) {
    if (!e) continue;
    e.inChat = false; e.releaseSpot(); e.resting = false; e.nextThink = t + 4000;
    if (e.present && e.mode === 'working') e.gotoWork();
  }
  romance.active = null;
  romance.nextCheer = t + 240000 + Math.random() * 240000;    // 応援は4〜8分に1回
  romance.nextDate = t + 1200000 + Math.random() * 1200000;   // デートは20〜40分に1回
}

/* ================================================================
   社長の見回り: 作業中でも定期的に全員の様子を見に行き、
   励まし・指示・雑談を繰り広げる(200パターン)
   ================================================================ */
const patrol = { active: null, next: 40000 };
// 警備巡回の点検ポイントとセリフ
const SECURITY_STOPS = [
  { x: 592, y: 198, d: 'up', name: 'サーバー' },
  { x: 430, y: 316, d: 'up', name: '撮影スタジオ' },
  { x: 306, y: 268, d: 'down', name: '受付' },
  { x: 96, y: 232, d: 'up', name: '給湯コーナー' },
  { x: 336, y: 336, d: 'down', name: '入口' },
  { x: 68, y: 232, d: 'up', name: '自販機まわり' },
  { x: 470, y: 198, d: 'up', name: '倉庫の段ボール' },
  { x: 26, y: 92, d: 'left', name: '消火器' },
  { x: 560, y: 322, d: 'up', name: '音声スタジオ' },
  { x: 150, y: 324, d: 'up', name: '休憩室' },
];
const BOSS_SECURITY = [
  '{p}、異常なし', '{p}よし!', '{p}…問題ないな', '戸締まりよし(閉まる戸はないが)', '消火器の位置、よし',
  '不審者…ララしかいないな', '機材の熱、問題なし', 'コード類、つまずかない配置…よし', '防犯は経営の基本だ',
  '整理整頓…社訓どおりだな', '電気の消し忘れ…ないな、よし', '床、今日もピカピカだな(白柳さんに感謝)',
  '{p}、問題なし', '{p}のあたり、きれいだな', '{p}…よし、次いくか',
  '配線の熱、大丈夫そうだ', '非常口、ふさがってないな', 'ここは死角だな…気をつけよう',
  '白柳さんの仕事は丁寧だ', '{p}、記録しておく', '異常なし。平和がいちばんだ',
  'この会社、いい会社だな', '見回りは経営者の基本動作だ', '{p}、今日も無事だ',
];
const BOSS_PATROL_WORK = [
  'その調子だ', '頼りにしてるぞ', '進捗どうだ?', '無理はするなよ', '品質第一で頼む', 'いいぞいいぞ',
  '困ったらすぐ言え', 'お前が頼みの綱だ', '休憩も取れよ', 'さすがだな', '背中が頼もしい', '仕上がり楽しみにしてる',
  '納期は大丈夫か?', '細部までこだわれよ', 'いい顔してるな', 'エラーは恐れるな', '妥協だけはするな', '手が早いな!',
  'その集中力、買うぞ', '会社はお前で持ってる', '一息入れたらどうだ', '夜は寝ろよ?', '肩に力入りすぎだぞ',
  'コードは読みやすくな', 'テスト書いてるか?', 'コミットこまめにな', '弱音は俺にだけ吐け', '給料上げたいんだがな…',
  '今日のMVP候補だな', '社会保険は大事だぞ', '若いのに大したもんだ', '俺も昔はコード書いてな…',
  'この会社に来てくれてありがとうな', '成長したなあ', '次のボーナス、期待しとけ(ゼロ円)', '愚痴なら聞くぞ',
  '仕様変更してもいいか?…冗談だ', 'バグと友達になるなよ', '画面から炎出てないか?', '指がしなってるな',
  'その機能、俺も楽しみだ', 'ユーザーは待ってるぞ', '世界を獲るぞ', '10年後の会社を頼む', '休日は休めよ?',
  '報連相、助かってる', 'エナドリは1日1本までだ', '姿勢良くな', '目を大事にしろよ', 'たまに立てよ?',
  'デスク周り、きれいだな', '仕事が丁寧だな', 'スピードより正確さだ', 'いや、今日は速さだ', '决断が早いな',
  '筋がいい', 'センスあるぞ', '執念を感じる', '職人だな', '匠の技だ', 'プロの仕事だ', '震えるほどいい',
  '泣けるほどいい', '感動した!', '俺の目に狂いはなかった', 'スカウトした甲斐があった', '愛してるぞ(社員として)',
  '守りたい、この進捗', '額に入れて飾りたいコードだ', '教科書に載せたい仕事だ', '子供に見せたい働きっぷりだ',
  '今日も頼んだぞ', '昼メシ食ったか?', '水分補給しろよ', 'トイレ我慢するなよ', 'まばたきしろよ',
  '深呼吸も仕事のうちだ', 'BGM何聴いてる?', '集中の邪魔したな、続けてくれ', '見てるだけで満足だ',
  '俺にできることはあるか?', 'コーヒー淹れてこようか?', '社長にできるのは応援だけだ', '応援してるぞ、心から',
  '数字は俺が何とかする', '責任は俺が取る、思い切ってやれ', '失敗していい、前に進め', '挑戦を評価するぞ',
  '安定稼働、地味にすごいぞ', '誰も見てなくても俺は見てる', '影の努力、知ってるぞ', '積み重ねが会社を作る',
  '半年前より確実に速いな', '成長曲線が美しい', 'その改善、気づいてたぞ', 'ログがきれいになったな',
  '深夜対応、助かった', 'この前のリカバリー、見事だった', '障害対応の判断、正しかったぞ', 'あの一手は俺には打てん',
  '技術は裏切らないな', '学び続ける姿勢、尊敬する', '謙虚さがいいな', '報告が簡潔で助かる', '議事録も助かってる',
  '次の一手、任せた', '大きい仕事、振っていいか?', '昇進の話…はまだ早いか', '肩書き、何がいい?',
  '来期はもっと面白くなるぞ', '新プロジェクトの相談、今度させてくれ', 'お前の意見が聞きたい', 'アイデアあったら教えてくれ',
  '会議は俺が減らしておく', '雑務は俺が巻き取る', '集中環境は俺が守る', '外野の声は気にするな',
  '批判は俺が受ける', '成果は全部お前のものだ', '称賛は独り占めしていいぞ', '今日という日に感謝だな',
  '働く姿が絵になるな', 'ドット絵でも分かる気迫だ', '画面越しでも伝わる熱量だ', 'モニターが輝いて見えるよ',
  '今日のログイン、誰より早かったな', '最後まで残ってるの、いつもお前だな', '無理するな、と言っても無理するんだろうな',
  '倒れる前に言えよ', '体が資本だぞ', '健康診断行けよ', 'ストレッチしろよ', '整体代は経費でいいぞ',
  '温かいもの飲めよ', '目薬支給しような', 'いい椅子買おうな', 'モニターもう1枚要るか?', 'キーボード新調するか?',
  '要望は全部俺に言え', '福利厚生、考えとく', '社員旅行、行きたいか?', '打ち上げは焼肉でいいか?',
];
const BOSS_PATROL_IDLE = [
  '休憩か、いいことだ', 'しっかり休めよ', '次の仕事、頼むかもな', '充電中か', 'コーヒーうまいか?',
  '休むのも仕事のうちだ', 'その調子で英気を養え', 'ソファの座り心地どうだ?', '自販機の新作、試したか?',
  'たまには外の空気も吸えよ…換気は俺がしとく', '暇なら俺の話し相手になるか?', '次のプロジェクトの構想、聞くか?',
  '休憩中にすまんな、顔見に来ただけだ', '元気そうだな', '顔色いいな', 'よく休むやつはよく働く',
  '罪悪感なく休め、それが指示だ', '休憩の達人だな', 'その堂々とした休みっぷり、嫌いじゃない',
  '月城の収録、聴いたか?', 'ララを見なかったか?', '白柳さんの掃除、丁寧だよなあ', '掲示板のミッション、読んだか?',
  '社訓、言えるか?…無限労働はウソだぞ', '飯行ったか?', '夜食は何派だ?', '仮眠室、作ろうか迷ってる',
  'マッサージチェア欲しくないか?', '観葉植物、増やそうと思ってる', 'オフィス、もっと良くしたいんだ',
  '意見箱でも置くか', '最近どうだ?', '悩みはないか?', '人間関係は良好か?', '睡眠取れてるか?',
  '趣味の時間、確保できてるか?', '運動してるか?', '目、疲れてないか?', '肩こりはどうだ?',
  '今度みんなでBBQやるか(合法的に)', 'ジム部でも作るか', '次のイベント、何がいい?', '忘年会の幹事、頼めるか?',
  '有給、ちゃんと使えよ', '残業するなよ?', '定時で帰っていいんだぞ', '(俺が言うのもなんだが)',
  '会社は楽しいか?', '夢はあるか?', '10年後、何してたい?', 'お前の理想の働き方、聞かせてくれ',
  '実は俺も休憩中なんだ', '社長業も疲れるもんでな', 'ここだけの話、経営は大変だ', '…なんてな、冗談だ',
  '俺のこと、社長って呼ばなくていいぞ', 'MONさんでいい', 'いや、やっぱ社長で頼む', '今日もいい一日にしような',
  '休憩、しっかり取れよ', '顔つきが穏やかでいいな', 'その余裕が仕事に効くんだ',
  '今日は何か食べたいものあるか', '休みの日は何してる?', 'ここのソファ、いい買い物だったろ',
  '雑談も立派な情報共有だ', 'たまには俺の愚痴も聞いてくれ', '無理して働いてる顔より、その顔がいい',
  '次の仕事は少し大きいぞ、覚悟しとけ', '休憩中にすまん、通りかかっただけだ',
  'この時間の空気、好きなんだ', '肩、こってないか', 'コーヒー、豆を変えてみたんだ',
  '福利厚生で欲しいもの、考えといてくれ', 'ゆっくりでいい、焦らなくていい',
  '休憩、足りてるか?', 'その顔が見られると安心する', '疲れは溜める前に抜け',
  'ソファ、増やそうか', '今日は無理させてないか', '好きな飲み物、経費で入れるぞ',
  '雑談の輪、いいもんだな', '休むのが下手なやつが多くてな', 'ここに座ると落ち着くだろ',
  '休憩室の照明、明るすぎないか', 'お菓子、補充しておいた', '何か困ってることないか',
  'たまには俺も混ぜてくれ', '若い頃は休み方を知らなかった', '休憩の質が仕事の質だ',
  'ゆっくりしていけ', '顔色がいいな、よく寝たか', '今日は早く帰ってもいいぞ',
  'その姿勢、正しい', 'よく休み、よく働く。それでいい', '無駄話も会社の血流だ',
  '次に来る仕事、楽しいやつだぞ', '期待しすぎるなよ(期待してる)', 'ここは君たちの会社でもある',
  'コーヒー、一緒に飲むか', '天気の話でもするか', '働かせすぎてないか心配でな',
  '休んでる姿を見るのも社長の仕事だ', 'ソファの寝心地、どうだ', 'また声かけるから',
  'いい会社にしような', '不満があったら遠慮なく言え', '感謝してるぞ、いつも',
  '俺が言うのもなんだが、休め', 'この時間があるから続けられる', 'たまには外に出るか',
  '今日の空、見たか?', '肩の荷、少し降ろしていい', 'よくやってる、本当に',
  '茶菓子、買ってきたぞ', '無理は禁物だ', '君がいると助かる',
  'ここで会えてよかった、顔が見たかっただけだ',
];
const PATROL_REPLY_WORK = [
  'はい!', '順調です!', '任せてください', 'ありがとうございます!', 'がんばります!', '押忍!',
  'ちょうど波に乗ってます', 'あと少しで一段落です', '社長も休んでください', '進捗、後で共有します',
  '励みになります!', '(タイピング速度が上がる)', 'この機能、自信あります', '納期、守ります!',
  'ご期待に応えます', '見ててください', '恐縮です…!', 'うおおお燃えてきた', '社長のためにも頑張ります',
  'コーヒーは大丈夫です!', '目薬ほしいです', 'いい椅子、お願いします!', 'ボーナス楽しみにしてます(圧)',
  '責任、共有させてください', '愛社精神が高まりました',
  'いけます、いけます!', 'ちょうど乗ってきたところです', 'ご心配なく!',
  'その言葉で3時間戦えます', '社長も無理しないでくださいね', 'あと少しで形になります',
  '順調です、たぶん', '声かけ、ありがたいです', 'このあと一気に仕上げます',
  '期待、重いですけど嬉しいです', 'ちょっと詰まってたので助かりました', 'ここが踏ん張りどころです',
  '休憩は…終わってからにします', '任されるの、好きなんです', '品質は落としません',
  'コーヒーいただけると加速します', '見守っててください', 'いい感じです!',
  'あとは仕上げだけです', '結果でお返しします', '自分のためにもやってます',
  'あと少しです!', '手応えあります', 'いい流れきてます', '任せてください!',
];
const PATROL_REPLY_IDLE = [
  'はい、充電中です', '5分だけ休んでます', 'すぐ戻ります!', '英気、養ってます', 'ソファ最高です',
  '社長もどうですか?', '新作、当たりでした', '次の仕事、待ってます', 'ちゃんと休んでます(堂々)',
  '悩みはゼロです', 'よく眠れてます', '会社、楽しいです', '夢は世界征服です', 'BBQ、次は合法で!',
  'MONさん…いや社長、お疲れ様です',
  'いま充電中です', 'すぐ動けます!', 'ちょうど戻ろうと思ってました',
  '休んでます、堂々と', 'この時間が好きなんです', '社長も座ったらどうです?',
  '次、なんかありますか?', '英気を養い中です', '声かけてもらえると嬉しいです',
  'ソファの魔力に負けました', 'あと1分だけください', '雑談しませんか?',
  'この会社、居心地いいです', 'お茶、淹れましょうか?', '休憩の質を上げてます',
];

function stepPatrol(t) {
  const boss = employees.find(e => e.def.source === 'boss');
  // 途中で社長が退社したら見回りを畳む。畳まないと相手が inChat のまま固まる
  if (!boss || !boss.present) { if (patrol.active) endPatrol(boss, t); return; }
  if (boss.mode === 'out' || boss.mode === 'sleephome' || boss.mode === 'off') { if (patrol.active) endPatrol(boss, t); return; }
  if (patrol.active) {
    const p = patrol.active;
    if (p.kind === 'security') {
      // 警備巡回: 点検ポイントを順に回って確認する
      if (boss.action !== 'walk') {
        if (!p.saidAt) {
          const stop = p.stops[p.si];
          boss.dir = stop.d || 'down';
          const mcS = snap && snap.machine;
          let secLine = null;
          if (stop.name === 'サーバー' && mcS && mcS.cpuPct != null) {
            const tpS = mcS.topProcs && mcS.topProcs[0];
            secLine = mcS.cpuPct >= 85 ? `CPU ${mcS.cpuPct}%!?何をそんなに回してるんだ!`
              : mcS.cpuPct >= 60 ? `CPU ${mcS.cpuPct}%、${tpS ? tpS.name + 'が' : ''}よく働いてるな`
              : `CPU ${mcS.cpuPct}%、マシン室は平常運転だ`;
          }
          boss.say(t, secLine || pickFresh('security', BOSS_SECURITY).replace('{p}', stop.name), 3000);
          p.saidAt = t;
        } else if (t > p.saidAt + 3400) {
          p.si++;
          p.saidAt = 0;
          if (p.si >= p.stops.length) { endPatrol(boss, t); return; }
          boss.goto({ x: p.stops[p.si].x, y: p.stops[p.si].y }, 'stand');
        }
      }
      return;
    }
    const tgt = p.target;
    if (!tgt.present) { endPatrol(boss, t); return; }
    if (p.phase === 'go') {
      if (boss.action !== 'walk') {
        boss.dir = tgt.pos.x >= boss.pos.x ? 'right' : 'left';
        const pool = tgt.mode === 'working' ? BOSS_PATROL_WORK : BOSS_PATROL_IDLE;
        boss.say(t, pickFresh('patrol', pool, tgt.id), 3400);   // 相手の名前が入った行を本人の目の前で言わない
        p.phase = 'talk'; p.until = t + 3600;
      }
    } else if (p.phase === 'talk') {
      if (t > p.until) {
        const rpool = tgt.mode === 'working' ? PATROL_REPLY_WORK : PATROL_REPLY_IDLE;
        if (tgt.action !== 'sleep') tgt.say(t, pickFresh('patrolreply', rpool, tgt.id), 3000);
        else tgt.say(t, '……zzz(返事なし)', 2400);
        p.phase = 'back'; p.until = t + 3000;
      }
    } else if (t > p.until) endPatrol(boss, t);
    return;
  }
  if (t < patrol.next) return;
  if (chimeBreak.until && t < chimeBreak.until) return;
  if (boss.inChat || boss.atMeeting || boss.directing || boss.onChimeBreak || boss.recording || boss.action === 'walk') return;
  if (directive.active || standup.active || fight.active) return;
  // 見回り先: 稼働中を優先しつつ、たまに休憩中の社員も
  if (Math.random() < 0.3) {
    // 警備巡回モード: ランダムに3箇所を点検
    const stops = SECURITY_STOPS.slice().sort(() => Math.random() - 0.5).slice(0, 3);
    boss.releaseSpot(); boss.releaseReception(); boss.resting = false;
    boss.inChat = true;
    patrol.active = { kind: 'security', stops, si: 0, saidAt: 0 };
    boss.say(t, ['よし、見回りだ', '社内パトロール、開始', '異常がないか見てくる'][Math.floor(Math.random() * 3)], 2600);
    boss.goto({ x: stops[0].x, y: stops[0].y }, 'stand');
    return;
  }
  const cands = employees.filter(e => e !== boss && e.present && !e.inChat && !e.atMeeting && !e.inEvent
    && e.def.source !== 'janitor' && ['sit', 'sleep', 'stand', 'studio'].includes(e.action));
  if (!cands.length) { patrol.next = t + 30000; return; }
  const working = cands.filter(e => e.mode === 'working');
  const pickFrom = working.length && Math.random() < 0.75 ? working : cands;
  const tgt = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  boss.releaseSpot(); boss.releaseReception(); boss.resting = false;
  boss.inChat = true;
  if (tgt.id === 'tsukishiro' && tgt.action === 'studio') {
    boss.goto({ x: TSUKI_STUDIO_POST.x - 26, y: TSUKI_STUDIO_POST.y + 2 }, 'faceR');
  } else if (tgt.action === 'sit' && !tgt.resting) {
    const [sp, fc] = deskApproach(tgt); boss.goto(sp, fc);
  } else {
    boss.goto({ x: tgt.pos.x - 20, y: tgt.pos.y + 2 }, 'faceR');
  }
  tgt.inChat = true;   // 対象をロック
  patrol.active = { target: tgt, phase: 'go' };
}

function endPatrol(boss, t) {
  if (patrol.active && patrol.active.target) patrol.active.target.inChat = false;
  patrol.active = null;
  patrol.next = t + 60000 + Math.random() * 80000;   // 見回り・警備は1〜2.3分に1回(社長は現場主義)
  // 社長が退社してしまったあとでも呼ばれる。不在の人に goto すると入口から復活してしまうので触らない
  if (!boss) return;
  boss.inChat = false;
  boss.nextThink = 0;
  if (boss.present && boss.mode === 'working') boss.gotoWork();
}

function startFight(a, b, t) {
  if (fight.active || t < fight.cooldown) return;
  if (a.inChat || b.inChat || a.atMeeting || b.atMeeting || a.recording || b.recording) return;
  if ((a.mode !== 'idle' && a.mode !== 'working') || (b.mode !== 'idle' && b.mode !== 'working')) return;
  a.inChat = b.inChat = true;
  for (const e of [a, b]) {   // 歩行を打ち切るので、持っていた受付・休憩席も返す
    e.releaseReception(); e.releaseSpot(); e.resting = false;
  }
  a.action = 'stand'; b.action = 'stand';
  a.path = []; b.path = [];
  a.dir = b.pos.x >= a.pos.x ? 'right' : 'left';
  b.dir = a.pos.x >= b.pos.x ? 'right' : 'left';
  const rounds = 2 + Math.floor(Math.random() * 9);   // 2〜10往復
  const lines = [];
  const used = new Set();
  for (let k = 0; k < rounds; k++) {
    let idx;
    do { idx = Math.floor(Math.random() * FIGHT_LINES.length); } while (used.has(idx) && used.size < FIGHT_LINES.length);
    used.add(idx);
    lines.push(FIGHT_LINES[idx][0], FIGHT_LINES[idx][1]);
  }
  lines.push('…ふん'); lines.push('…ふんだ');
  fight.active = { a, b, lines, li: 0, nextLine: t + 300 };
}

function stepFight(t) {
  if (!fight.active) return;
  const f = fight.active;
  if (!f.a.present || !f.b.present || f.a.mode === 'panic' || f.b.mode === 'panic') { endFight(t); return; }
  if (f.a.panicking || f.b.panicking) { endFight(t); return; }
  if (t > f.nextLine) {
    const line = f.lines[f.li];
    if (line == null) { endFight(t); return; }
    (f.li % 2 === 0 ? f.a : f.b).say(t, line, 2600);
    f.li++;
    f.nextLine = t + 2900;
  }
}

function endFight(t) {
  const f = fight.active;
  if (f) {
    for (const e of [f.a, f.b]) {
      if (!e.panicking) e.inChat = false;
      e.nextThink = 0;
      if (e.mode === 'working') e.gotoWork();
      else if (e.mode === 'sleep') e.goto(e.seat, 'sleep');
      else if (e.mode === 'off' || e.mode === 'out' || e.mode === 'sleephome') e.goto({ x: 374, y: 346 }, 'leave');
    }
  }
  fight.active = null;
  fight.cooldown = t + 120000 + Math.random() * 180000;   // 喧嘩は2〜5分に1回まで
}


function endGroupChat(t, wait) {
  const ga = groupChat.active;
  if (ga) for (const e of ga.members) { if (!e.panicking) e.inChat = false; }
  groupChat.active = null;
  groupChat.next = t + wait;
}

function stepGroupChat(t) {
  if (chat.active || panic.until) return;
  if (groupChat.active) {
    const ga = groupChat.active;
    const alive = ga.members.filter(e => e.present && e.mode === 'idle');
    if (alive.length < 2) { endGroupChat(t, 60000); return; }
    if (t > ga.nextLine) {
      const line = ga.lines[ga.li];
      if (line == null) { endGroupChat(t, 90000 + Math.random() * 120000); return; }
      alive[ga.li % alive.length].say(t, line, 3400);
      ga.li++;
      ga.nextLine = t + 3700;
    }
    return;
  }
  if (t < groupChat.next) return;
  const rest = employees.filter(e => e.present && e.mode === 'idle' && e.resting && e.action !== 'walk' && e.action !== 'sleep' && !e.inChat && !e.atMeeting && !e.receptionOn);
  if (rest.length < 3) { groupChat.next = t + 40000; return; }
  const members = rest.slice(0, 5);
  for (const e of members) e.inChat = true;
  // 社長本人が輪にいるとき、社長を第三者として話す話題は外す
  const hasBoss = members.some(e => e.def.source === 'boss');
  const topics = hasBoss ? GROUP_TOPICS.filter(s => !s.includes('社長')) : GROUP_TOPICS;
  const reacts = hasBoss ? GROUP_REACTS.filter(s => !s.includes('社長')) : GROUP_REACTS;
  const tkey = hasBoss ? 'gtopic:noboss' : 'gtopic';
  const rkey = hasBoss ? 'greact:noboss' : 'greact';
  const lines = [pickFresh(tkey, topics)];
  const rn = 2 + Math.floor(Math.random() * Math.min(3, members.length));
  for (let k = 0; k < rn; k++) lines.push(pickFresh(rkey, reacts));
  groupChat.active = { members, lines, li: 0, nextLine: t + 500 };
}

function endChat(t, wait) {
  const c = chat.active;
  if (c) {
    for (const e of [c.a, c.b]) {
      if (!e.panicking) e.inChat = false;
      if (e.atMeeting) { e.atMeeting = false; e.nextThink = 0; }
    }
    if (c.meeting) meetBusy = false;
  }
  chat.active = null;
  chat.next = t + wait;
}

const dog = {
  pos: { x: 90, y: 150 }, target: null, path: [], dir: 1,
  next: 4000, napUntil: 0, nextLine: 0,
  act: null, spot: null, follow: null,
};

/* ---------- ララの行き先(それぞれ目的がある) ---------- */
const DOG_SPOTS = [
  { x: 136, y: 226, k: 'water', n: '給水機' },
  { x: 70, y: 226, k: 'food', n: '自販機の下' },
  { x: 104, y: 226, k: 'food', n: 'おやつ棚' },
  { x: 40, y: 226, k: 'food', n: '給湯コーナー' },
  { x: 160, y: 212, k: 'trash', n: 'ゴミ箱' },
  { x: 604, y: 214, k: 'trash', n: '奥のゴミ箱' },
  { x: 300, y: 330, k: 'door', n: '受付', via: { x: 374, y: 328 } },
  { x: 344, y: 338, k: 'door', n: '入口', via: { x: 374, y: 334 } },
  { x: 70, y: 272, k: 'sofa', n: 'ソファの前' },
  { x: 224, y: 318, k: 'plant', n: '観葉植物' },
  { x: 492, y: 202, k: 'boxes', n: '段ボールの山' },
  { x: 432, y: 318, k: 'studio', n: '撮影スタジオ前', via: { x: 372, y: 318 } },
  { x: 556, y: 326, k: 'studio', n: '音声スタジオ前', via: { x: 478, y: 326 } },
  { x: 66, y: 148, k: 'boss', n: '社長席' },
  { x: 320, y: 192, k: 'hall', n: '廊下のまんなか' },
  { x: 520, y: 196, k: 'hall', n: 'サーバーの前' },
  { x: 240, y: 160, k: 'hall', n: 'デスク島の脇' },
  { x: 200, y: 200, k: 'hall', n: '廊下の左寄り' },
  { x: 404, y: 198, k: 'hall', n: '廊下の右寄り' },
  { x: 264, y: 258, k: 'desk', n: '総務部の島の前' },
  { x: 344, y: 256, k: 'desk', n: '座間の机のうしろ' },
  { x: 150, y: 232, k: 'corner', n: '給湯コーナーの角' },
  { x: 26, y: 254, k: 'corner', n: '左のすみっこ' },
  { x: 628, y: 202, k: 'corner', n: '右端の通路' },
  { x: 210, y: 152, k: 'sun', n: '窓の下(日なた)' },
  { x: 420, y: 152, k: 'sun', n: '右の窓の下' },
  { x: 534, y: 196, k: 'copier', n: 'コピー機のそば' },
  { x: 414, y: 214, k: 'meeting', n: '会議スペース' },
  { x: 78, y: 258, k: 'sofa', n: 'ラグの上' },
  { x: 190, y: 264, k: 'corner', n: '休憩室の出口' },
  { x: 96, y: 254, k: 'kitchen', n: 'キッチンの足元' },
  { x: 470, y: 196, k: 'boxes', n: '段ボールの反対側' },
  { x: 288, y: 214, k: 'hall', n: 'フロアのまんなか' },
  { x: 368, y: 196, k: 'hall', n: '通路の交差点' },
];
// 到着後にその場でやること(行き先の種別ごと)
const DOG_ACTS = {
  water: ['ぺろぺろ…', '(ごくごく飲んでいる)', '(水をこぼした)', '(ひげがびしょ濡れ)',
    '(飲みすぎてお腹がたぷたぷ)', '(給水機を見上げて待っている)', '(足元が水びたし)', '(満足そうに口を拭った)'],
  food: ['(くんくん)', '(落とし物がないか捜索中)', '(じーっと見上げている)', 'クゥーン…', '(前足でちょいちょい)',
    '(においだけで幸せそう)', '(何も落ちていなかった)', '(自販機の音に反応した)', '(お菓子の袋の音を聞き逃さない)', '(あきらめきれず戻ってきた)'],
  trash: ['(鼻を突っ込んでいる)', '(いい匂いがする…)', '(前足でカリカリ)', '(あさろうとしている)',
    '(ふたを開けようと格闘中)', '(戦利品を咥えている)', '(見つかる前に離れた)', '(においの記憶を更新した)'],
  door: ['(じっと入口を見ている)', 'ワン!', '(耳がぴくっと動いた)', '(誰か来ないかな…)', '(お座りして待機)',
    '(足音がするたび顔を上げる)', '(尻尾だけ動いている)', '(番犬のつもりでいる)', '(宅配便を待っている)', '(誰も来なかった)'],
  sofa: ['(ソファの横で丸くなった)', '(ふかふか…)', 'スピー…', '(伸びをしてから寝転がった)',
    '(クッションを枕にした)', '(片目だけ開けている)', '(ここが特等席)', '(誰かが座ると場所を詰める)'],
  plant: ['(葉っぱをくんくん)', '(かじろうとして怒られる前に離れた)', '(土を掘りかけている)',
    '(葉の裏まで確認した)', '(鉢のふちに顎をのせた)', '(植物と見つめ合っている)'],
  boxes: ['(箱のすきまに入った)', '(箱の陰からこっちを見ている)', '(ダンボール、落ち着く)',
    '(箱の角で顎を掻いた)', '(隠れたつもりでしっぽが出ている)', '(段ボールの城の主)'],
  studio: ['(ガラス越しにのぞいている)', '(しっぽをぱたぱた)', '(そーっと近づいた)',
    '(ON AIRの灯りを見つめている)', '(吠えたいのを我慢している)', '(録音が終わるのを待っている)'],
  boss: ['(社長をじっと見上げている)', '(お手の練習をしている)', 'クーン(おやつ…)', '(社長の椅子の下に潜った)',
    '(距離感ゼロで寄ってくる)', '(社長の足に顎をのせた)', '(決裁を待つ顔をしている)', '(社長のスリッパを守っている)'],
  hall: ['(のび〜)', '(その場でくるくる回っている)', '(あくび)', '(耳をかいている)', '(ごろん)', '(お座り)',
    '(通る人を目で追っている)', '(床のひんやりを探している)', '(誰かの足音を待っている)',
    '(急に走り出してすぐ止まった)', '(日課の見回り中)', '(ここが会社のまんなか)'],
  desk: ['(机の脚に体をこすりつけた)', '(椅子の下から様子をうかがう)', '(キーボードの音を聞いている)',
    '(足元をぐるっと一周した)', '(書類が落ちてこないか見ている)', '(仕事の邪魔にならない位置を選んだ)'],
  corner: ['(すみっこが落ち着く)', '(壁に背中を預けた)', '(誰にも見つからない場所)',
    '(角から片目だけ出している)', '(ここが避難所)', '(静けさを満喫している)'],
  sun: ['(日なたでとろけている)', '(お腹を日に当てている)', '(まぶしそうに目を細めた)',
    '(日が移動したので体もずらした)', '(あたたかい…)', '(完全に溶けた)'],
  copier: ['(コピー機のそばはあったかい)', '(排熱で暖をとっている)', '(印刷音にびくっとした)',
    '(紙が出てくるのを見張っている)', '(ここが冬の特等席)', '(機械の振動が心地いい)'],
  meeting: ['(会議に参加しているつもり)', '(まんなかに座って議事を見守る)', '(発言を待っている顔)',
    '(重要な会議だと察している)', '(足元で丸くなって傍聴)', '(議事録係のつもり)'],
  kitchen: ['(食器の音に耳を立てた)', '(コーヒーの匂いは苦手)', '(何かこぼれないか待機)',
    '(冷蔵庫の前を陣取った)', '(給湯室の主)', '(おこぼれを狙っている)'],
};
const DOG_ANTICS = [
  '(しっぽを追ってくるくる)', '(ぶるぶるっと体を震わせた)', '(くしゃみ)', '(首をかしげた)',
  '(何もない床を掘っている)', '(遠くをじっと見ている)', 'ワンッ!', '(耳をぴこぴこ)',
  '(ごろんと腹を見せた)', '(自分の影を気にしている)', '(大あくび)', '(伸び〜)',
  '(前足をなめている)', '(急に立ち上がって周りを見た)', '(鼻をひくひくさせている)', '(伏せて顎を床につけた)',
  '(ふわぁ…と大きな伸び)', '(何かの音に耳だけ向けた)', '(その場でジャンプした)', '(体を掻こうとして倒れた)',
  '(しっぽがゆっくり揺れている)', '(誰かの気配を探している)', 'クゥーン(かまってほしい)', '(床にぺたんと寝そべった)',
];
const DOG_SLEEP = ['zzz', '(足がぴくぴく動いている)', 'クゥン…(寝言)', '(丸まりが完璧)', 'スピー…',
  '(いびきが小さく聞こえる)', '(まくら代わりに前足)', 'ワフ…(寝言)', '(ときどき耳がぴくっと動く)', '(完全に脱力している)',
];
const DOG_ALARM = ['ワンワンワン!!', '(パニックで走り回っている)', '(誰か止めて!)', 'ワオーン!!',
  '(誰かの足元に飛び込んだ)', 'ワフッ!ワフッ!', '(机の下に避難した)', '(いちばん大声で吠えている)',
];
const DOG_CHIME = ['ワンワン!(鐘に反応)', 'ワオーン', '(鐘が鳴るたび吠える)',
  '(鐘に向かって遠吠え)', 'ワン!ワン!(反応がいい)', '(耳をぴんと立てた)',
];
const DOG_FOLLOW = ['(社長についていく)', '(見回りのお供)', '(ぴったり後ろを歩く)', '(点検の補佐)',
  '(社長の歩幅に合わせている)', '(点検の記録係)', '(先回りして待っている)', '(振り返るとちゃんといる)',
];
const DOG_FEET = ['(足元で丸くなった)', '(仕事のじゃまはしません)', '(あったかい)', '(見守っている)',
  '(靴のにおいを確認した)', '(すぐそばで丸くなっている)', '(ときどき見上げてくる)', '(足が動くたびに起きる)',
];
const JANITOR_DOG = [
  'ララさん、ゴミ箱はダメです', 'そこ、さっき片付けたところです!', '規定では犬の立ち入りは…',
  'ララさん!分別が乱れます!', '(ゴミ箱の前に立ちはだかる)',
  'ララさん、ここは掃除中です!', '鼻を突っ込まないでください!', '分別が!分別が乱れる!',
  'ララさんの担当区域ではありません', '(そっとゴミ箱を移動させた)',
];

function dogSay(t, text, ms = 3000) { dog.pending = null; dog.bubble = text; dog.bubbleFrom = t; dog.bubbleUntil = t + ms; }
// 同じフレームで2回 dogSay すると先の台詞が消えるので、後続はキューに積む
function dogSayLater(at, text, ms = 3000) { dog.pending = { at, text, ms }; }
const DOG_LANE = 204;   // 犬が横移動に使う中央通路
function dogGoto(spot) {
  // 家具を突っ切らないよう、いったん通路に出てから横へ動いて目的地に降りる
  const p = [];
  let fx = dog.pos.x, fy = dog.pos.y;
  const cur = dog.spot;
  // 出るときも同じ抜け道。ただし本当にそのスポットに立っているときだけ(離れた場所からだと遠回りになる)
  if (cur && cur.via && Math.hypot(dog.pos.x - cur.x, dog.pos.y - cur.y) < 12) {
    p.push({ x: cur.via.x, y: cur.via.y }); fx = cur.via.x; fy = cur.via.y;
  }
  const ax = spot.via ? spot.via.x : spot.x;
  if (Math.abs(fy - spot.y) > 30 || Math.abs(fx - spot.x) > 70) {
    if (Math.abs(fy - DOG_LANE) > 14) p.push({ x: fx, y: DOG_LANE });
    if (Math.abs(ax - fx) > 8) p.push({ x: ax, y: DOG_LANE });
  }
  if (spot.via) p.push({ x: spot.via.x, y: spot.via.y });
  p.push({ x: spot.x, y: spot.y });
  dog.path = p;
  dog.target = dog.path.shift();
  dog.spot = spot;
}
// 目的地まで動く。最終地点に着いたフレームだけ true
function moveDog(dt, speed) {
  if (!dog.target) return false;
  const dx = dog.target.x - dog.pos.x, dy = dog.target.y - dog.pos.y;
  const dist = Math.hypot(dx, dy), sp = speed * dt / 1000;
  if (dist < sp) {
    dog.pos = { x: dog.target.x, y: dog.target.y };
    dog.target = dog.path.length ? dog.path.shift() : null;
    return !dog.target;
  }
  dog.pos.x += dx / dist * sp; dog.pos.y += dy / dist * sp;
  if (Math.abs(dx) > 1.5) dog.dir = dx > 0 ? 1 : -1;   // 真下・真上に歩くとき左右反転がチカチカするのを防ぐ
  return false;
}

function stepDog(dt, t) {
  const tmD = jstNow();
  const lightsOut = tmD.h >= 22 || tmD.h < 5;
  // 予約した台詞の消化(どの早期returnより先に)
  if (dog.pending && t >= dog.pending.at) { const pd = dog.pending; dog.pending = null; dogSay(t, pd.text, pd.ms); }

  // ① 火災報知器: パニックで走り回る(最優先)
  if (officeEvent.active && officeEvent.active.alarmed) {
    dog.act = 'panic'; dog.napUntil = 0; dog.follow = null; dog.pending = null;
    if (!dog.target) { dog.path = []; dog.target = { x: 120 + Math.random() * 380, y: 158 + Math.random() * 56 }; }
    if (t > dog.nextLine) { dogSay(t, pickFresh('dogalarm', DOG_ALARM), 2400); dog.nextLine = t + 2600; }
    moveDog(dt, 64);
    return;
  }

  // ② 遊んでもらっている間はその人のそばを離れない
  if (dog.playWith) {
    const p = employees.find(e => e.id === dog.playWith);
    if (!p || !p.present || (p.action !== 'playdog' && p.action !== 'walk')) {
      dog.playWith = null;
    } else {
      dog.napUntil = 0; dog.act = null;
      const dpx = p.pos.x - dog.pos.x, dpy = p.pos.y - dog.pos.y;
      if (!dog.target && Math.hypot(dpx, dpy) > 18) { dog.path = []; dog.target = { x: p.pos.x + (dpx > 0 ? -12 : 12), y: p.pos.y + 2 }; }
      moveDog(dt, 34);
      return;
    }
  }

  // ③ BBQ中はグリル前で餌をねだる
  if (officeEvent.active && officeEvent.active.kind === 'bbq') {
    dog.napUntil = 0; dog.act = 'beg'; dog.follow = null;
    const gx = 292, gy = 198;
    if (!dog.target && Math.hypot(dog.pos.x - gx, dog.pos.y - gy) > 16) { dog.path = []; dog.target = { x: gx + Math.random() * 14 - 7, y: gy + Math.random() * 8 - 4 }; }
    if (t > dog.nextLine) { dogSay(t, pickFresh('larabeg', LARA_BEG), 3000); dog.nextLine = t + 9000 + Math.random() * 9000; }
    moveDog(dt, 34);
    return;
  }

  // ④ 消灯中はソファの横で朝まで就寝
  if (lightsOut) {
    const bed = { x: 24, y: 300, k: 'sofa', n: 'ソファの横' };
    if (dog.act !== 'sleep') {
      if (Math.hypot(dog.pos.x - bed.x, dog.pos.y - bed.y) <= 8) {
        dog.act = 'sleep'; dog.napUntil = t + 3600000; dog.target = null; dog.path = [];
        dogSay(t, '(ソファの横で丸くなった)', 3600);
        dog.nextLine = t + 40000;
      } else {
        if (!dog.target) dogGoto(bed);
        moveDog(dt, 26);
      }
      return;
    }
    if (t > dog.nextLine) { dogSay(t, pickFresh('dogsleep', DOG_SLEEP), 3200); dog.nextLine = t + 50000 + Math.random() * 70000; }
    return;
  }
  if (dog.act === 'sleep') { dog.act = null; dog.napUntil = 0; dogSay(t, '(のび〜。おはようございます)', 3200); }

  // ⑤ 社長の警備巡回にはお供する(相棒)
  const bossD = employees.find(e => e.def.source === 'boss');
  if (dog.follow === 'boss') {
    if (!patrol.active || patrol.active.kind !== 'security' || !bossD || !bossD.present) {
      dog.follow = null; dog.act = null;
    } else {
      const bdx = bossD.pos.x - dog.pos.x, bdy = bossD.pos.y - dog.pos.y;
      if (Math.hypot(bdx, bdy) > 20) { dog.path = []; dog.target = { x: bossD.pos.x + (bdx > 0 ? -14 : 14), y: bossD.pos.y + 3 }; }
      else dog.target = null;
      if (t > dog.nextLine) { dogSay(t, pickFresh('dogfollow', DOG_FOLLOW), 3000); dog.nextLine = t + 12000 + Math.random() * 10000; }
      moveDog(dt, 44);
      return;
    }
  }
  // 追従するかは巡回ごとに1回だけ決める(毎フレーム抽選だと必ず追従してしまう)
  if (patrol.active && patrol.active.kind === 'security' && !dog.follow && !patrol.active._dogAsked) {
    patrol.active._dogAsked = true;
    if (Math.random() < 0.4) {
      dog.follow = 'boss'; dog.act = null; dog.napUntil = 0; dog.target = null; dog.path = [];
      dogSay(t, '(社長についていくことにした)', 3000);
      return;
    }
  }

  // ⑥ 移動中
  if (dog.target) {
    if (moveDog(dt, 30)) arriveDog(t);
    return;
  }

  // ⑦ 滞在中: その場の小芝居
  if (t < dog.napUntil) {
    if (t > dog.nextLine) {
      const pool = (dog.spot && DOG_ACTS[dog.spot.k]) || DOG_ANTICS;
      dogSay(t, pickFresh('dogact:' + (dog.spot ? dog.spot.k : 'x'), Math.random() < 0.3 ? DOG_ANTICS : pool), 3200);
      dog.nextLine = t + 6000 + Math.random() * 7000;
    }
    return;
  }

  // ⑧ 次の行き先を決める
  if (t < dog.next) return;
  dog.act = null;   // dog.spot は dogGoto が「出るときの抜け道」に使うので消さない(dogGotoが上書きする)
  // 稼働中の社員がいれば、たまに足元で丸くなる
  const workers = employees.filter(e => e.present && e.mode === 'working' && e.action === 'sit');
  if (workers.length && Math.random() < 0.22) {
    const w = workers[Math.floor(Math.random() * workers.length)];
    let fx = w.desk.x + 24; const fy = w.desk.y + 36;
    if (fx > 515 && fy < 196) fx = w.desk.x - 22;   // 機材コーナーに重なる席(廣瀬)は反対側の足元へ
    dogGoto({ x: fx, y: fy, k: 'feet', n: w.name + 'の足元' });
    dog.act = 'feet';
    return;
  }
  const spot = DOG_SPOTS[Math.floor(Math.random() * DOG_SPOTS.length)];
  dogGoto(spot);
}

// 目的地に到着: 種別ごとに滞在時間と一言を決める
function arriveDog(t) {
  const k = dog.spot ? dog.spot.k : 'hall';
  const stay = k === 'sofa' ? 22000 + Math.random() * 20000
    : k === 'feet' ? 20000 + Math.random() * 25000
    : k === 'door' ? 12000 + Math.random() * 10000
    : 8000 + Math.random() * 9000;
  dog.napUntil = t + stay;
  dog.next = dog.napUntil + 2000;
  const pool = k === 'feet' ? DOG_FEET : (DOG_ACTS[k] || DOG_ANTICS);
  dogSay(t + 300, pickFresh('dogact:' + k, pool), 3200);
  dog.nextLine = t + 5000 + Math.random() * 5000;
  // ゴミ箱あさりは白柳が黙っていない
  if (k === 'trash') {
    const jan = employees.find(e => e.def.source === 'janitor');
    if (jan && jan.present && !jan.inChat && Math.hypot(jan.pos.x - dog.pos.x, jan.pos.y - dog.pos.y) < 150) {
      jan.say(t + 1800, pickFresh('jandog', JANITOR_DOG), 3400);
      dogSayLater(t + 4200, '(そーっと離れた)', 2800);
      dog.napUntil = t + 6000; dog.next = t + 8000;
    }
  }
}
function drawDog(g, t) {
  const { x, y } = dog.pos;
  const staying = t < dog.napUntil;
  // 「留まっている」と「寝ている」は別物。寝ているのは消灯中とソファの上だけ
  const asleep = dog.act === 'sleep' || (staying && dog.spot && dog.spot.k === 'sofa');
  const img = SHEETS.lala;
  if (img) {
    const moving = !!dog.target;
    const dir = (!moving) ? 'down' : (dog.dir > 0 ? 'right' : 'left');
    drawSheet(g, img, dir, 1, x, y, 16);
  } else {
    g.fillStyle = '#f0e8dc'; g.fillRect(Math.round(x) - 5, Math.round(y) - 6, 10, 6);
  }
  if (asleep) drawZzz(g, x, y - 8, t + 1700);
}


/* ================================================================
   スナップショット → 社員状態
   ================================================================ */
function shiftActive(shift, tm) {
  const [h1, m1, h2, m2] = shift;
  const a = h1 * 60 + m1, b = h2 * 60 + m2, x = tm.minOfDay;
  return a <= b ? (x >= a && x < b) : (x >= a || x < b);
}
const fmtYen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
// 公開向けの汎化タスク。辞書の正典は config.js(collector.mjsも同じ関数を読む)
const PUB = proj => (typeof CFG.publicTask === 'function' ? CFG.publicTask(proj) : '制作作業');
// TTSの案件名は 'S088_意志より仕掛け_ショート_2026-08-05' 形式。頭2つだけ見せる
const ttsShort = t => (t ? Array.from(String(t).split('_').slice(0, 2).join(' ')).slice(0, 20).join('') : '');
const fmtUsd = n => '$' + (n >= 100 ? Math.round(n) : n.toFixed(1));
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
// 日本語の桁(万/億)。看板は幅が狭いので「24,544」より「2.4万」が読みやすい
const fmtJa = n => {
  if (n == null) return '---';
  // 四捨五入だと 999,999→「100万」/ 99,999,999→「10000万」と実績を盛ってしまうので切り捨て
  const cut = (v, d) => { const p = Math.pow(10, d); return String(Math.floor(v * p) / p); };
  if (n >= 1e8) return cut(n / 1e8, n >= 1e9 ? 0 : 2) + '億';
  if (n >= 1e4) return cut(n / 1e4, n >= 1e6 ? 0 : 1) + '万';
  return Math.round(n).toLocaleString('ja-JP');
};
// 目標に対する達成率。1億が目標だと当分0.0%台なので、0にならない桁数まで出す
const fmtGoalPct = (cur, goal) => {
  if (cur == null || !goal) return '--';
  const p = cur / goal * 100;
  return (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)) + '%';
};

/* ================================================================
   データ駆動イベント: 実データの変化を物語にする
   (登録者増→お祝い / 納品→報告と称賛 / コスト→社長の悲鳴 / 残量→焦り)
   ================================================================ */
const celebration = { until: 0 };
let prevSubs = null, prevDeliv = null, costMilestone = 0;
const CELEBRATE = [
  '🎉登録者{n}人突破ー!!', '📈増えてる!増えてるぞ!', '{d}人!ようこそ!', 'YT見てくれてありがとうー!🙌',
  'うちの動画、届いてる…!', '祝!{n}人!', '次は目標1万人!', 'TSUKIの声が世界に…✨', '拍手ー!!👏',
  'スクショ撮っとこ📸', '経営ボードに春が来た', '社長、ボーナスの話ですが🎉', 'この調子で毎日投稿!',
  '登録者様に感謝の舞い', 'やったーーー!!', '泣いていい?😭', 'モチベ全回復した!', '乾杯しよう(お茶で)🍵',
  '新規さんいらっしゃい!', 'アルゴリズムが微笑んだ…!',
  '伸びてる!伸びてるよ!', '一人ひとりに感謝しかない', '見てくれてる人がいる…!',
  '今日はいい日だ!', '数字が動くとうれしいね', 'この調子でいこう!',
  '続けててよかった…', 'グラフが上向いた!', '(ガッツポーズ)',
  'みんなのおかげです!', '目標が近づいてる', 'コメント読みに行こう!',
  '次の一本、もっと良くする', '{d}人!ありがとう!', 'この瞬間のために作ってる',
  '鳥肌立った', '祝いだ!(お茶で)', '報告書に書いておこう',
  '{n}人の景色、見に行こう', '努力が数字になった!',
];
const DELIVER_LINES = [
  '📦納品完了しました!', '1本仕上がりました🎉', '講演、出荷でーす📦', '本日分、納めました!',
  '品質チェックOK、納品!', 'できたてほやほや、納品です', '今日も届けました📮', '納品ラッシュ来てます',
  'マスター確認済み、出します', '音声チェック3回した、完璧', 'レンダリング完走!納品!', '積み上げ+1です📦',
  '出荷しました!', '本日ぶん、完了です', 'チェック済みで納品します', 'これで一段落です',
  'いい出来だと思います', '無事に届けられました', '確認お願いします!', '今日のノルマ達成!',
  '仕上げまで丁寧にやりました', 'ひとつ積み上がりました', '納品ボタン、押しました', '次の一本、いきます!',
];
const DELIVER_PRAISE = [
  'よし!今日も届いたな👏', 'ナイス納品!', '品質第一、その調子だ', '視聴者が待ってるぞ、良い仕事だ',
  '積み上げが会社を作る!', '今夜は祝杯だな(お茶)', '掲示板に貼っておこう', '俺は今、猛烈に感動している',
  'よくやった、助かる', 'この積み重ねが効いてくる', '安定して出せるのが強みだ', '視聴者が待ってた一本だ',
  '品質も落ちてないな、さすがだ', '今日の会社の成果はこれだ', '記録に残しておこう', 'ありがとうな、本当に',
];
const BURN_LINES = [
  '今日もう{d}使ってる…😅', '{d}突破…API換算こわ', '{d}か…売上はよ', '燃焼率が俺を燃やす…{d}',
  '{d}…参考値参考値(震え)', 'クレジット無限じゃないんだぞ…{d}', '{d}!?…まあ、投資だ', '経理の俺が泣いてる({d})',
  '{d}…見なかったことにしよう', 'また{d}か…成長のコストだ', '{d}分の価値は出てるはず…',
  '{d}…経営者の胃が痛い', '燃えてるのは金だけじゃない({d})', '{d}か…売上はいつ来る',
  '{d}…投資と呼ぼう', 'これで{d}…来月が怖い',
];

function startCelebration(t, diff, subs) {
  celebration.until = t + 15000;
  dogSay(t + 1200, ['(みんなと一緒に跳ねている)', 'ワン!ワン!', '(しっぽ高速回転)'][Math.floor(Math.random() * 3)], 4000);
  dog.napUntil = Math.min(dog.napUntil, t + 1000);
  const folks = employees.filter(e => e.present && !e.inChat && e.action !== 'sleep');
  folks.forEach((e, i) => {
    e.happy = true;
    e.say(t + 400 + i * 900, pickFresh('celebrate', CELEBRATE)
      .replace('{n}', subs.toLocaleString('ja-JP')).replace('{d}', '+' + diff), 3600);
  });
}

function announceDelivery(t) {
  const ts = employees.find(e => e.id === 'tsukishiro');
  const who = (ts && ts.present && ts.mode === 'working') ? ts : employees.find(e => e.id === 'ito');
  if (who && who.present) who.say(t + 500, pickFresh('deliver', DELIVER_LINES), 3800);
  const boss = employees.find(e => e.def.source === 'boss');
  if (boss && boss.present && !boss.inChat && !boss.recording) boss.say(t + 4600, pickFresh('deliverpraise', DELIVER_PRAISE), 3400);
}

/* ---- 時間帯の空気(昼メシ・おやつ・深夜・月曜・金曜) ---- */
const timeFlavor = { fired: {} };
const LUNCH_LINES = [
  '🍜昼だ!昼!', 'お腹すいた…', '今日のランチ何?', 'コンビニ行く人ー?', '12時の腹時計、正確',
  'カレーの気分', '食べたら眠くなるやつ', '昼休憩、権利です', '社食欲しいなあ', '弁当勢、勝ち組',
  'ラーメンかそばで悩む', 'おにぎり2個で戦う', '昼抜きダメ、絶対', 'いただきます🙏',
  '腹の虫が鳴った', '今日は何食べよう…', '外に出る?買ってくる?',
  '午前がんばった自分にごほうび', '定食が食べたい気分', '午後のために炭水化物を',
  '早めに行かないと混むよ', '一緒に行く人ー?', '弁当作ってきた、えらい',
  '食べたら眠くなるの、わかってる', '昼はしっかり派です', 'デスクで食べる派もいるよね',
  '今日は軽めにしとこう', '味噌汁が飲みたい',
];
const SNACK_LINES = [
  '3時のおやつ〜🍪', '糖分補給の時間', 'チョコが呼んでる', 'スナック棚、補充されてる!',
  'コーヒーおかわり☕', '15時の壁、甘味で越える', 'おやつは正義', '一口だけ…一口だけ…',
  '疲れた脳に糖を', 'お茶しばこ🍵',
  '脳に糖分を', '一枚だけ…一枚だけ…', 'この時間の甘さは正義',
  '誰かのおやつの音が聞こえる', 'コーヒーとセットで完成する', '15時は世界共通の壁',
  '買い置き、まだあったっけ', '半分こしない?', 'これ食べたら本気出す', '休憩のための休憩',
];
const NIGHT_LINES = [
  'もうこんな時間…🌙', '静かだ…集中できる', '深夜テンション来た', '目が冴えてきた(まずい)',
  '夜型なんで本領発揮です', 'コンビニ行くなら今のうち', '月がきれいですね(上の窓から)', 'ラストスパート🔥',
  'エナドリ2本目はダメって言われてる', 'そろそろ寝る準備…あと1件だけ', '夜のオフィス、ちょっと好き', '明日の自分に任せない',
  'あと一件だけ…の一件目', '夜は誰にも邪魔されない', 'コーヒーが効かなくなってきた',
  '外、真っ暗だ', '静けさがごちそう', '明日の自分に手紙を書きたい',
  '今日はよく働いた…まだ働くけど', '夜の集中力は本物', 'そろそろ切り上げどきかも',
  'このまま朝までいけそう(危険)', '灯りがついてるのはうちだけかな', '夜勤手当ってあったかな',
];
const MONDAY_LINES = [
  '月曜が来てしまった…', '週の始まり!エンジン点火🔥', '土日の記憶がない', '今週も無限労働(社訓)',
  'まず週次の整理から', 'カレンダー見たくない', '今週こそ定時で…(フラグ)', 'よし、切り替えていこう',
  '月曜はコーヒー2杯必要', '月曜の自分、いつもえらい',
  '週の頭は助走から', '今週の予定、確認しよ', '月曜の空気って独特だよね',
  '土日に何もしなかった気がする', 'まず机を片付けるところから', 'いいスタートを切ろう',
  '今週こそ余裕をもって進める', '月曜を乗り切ればあとは流れる', '週明けの通知が怖い', 'コーヒー濃いめで始動',
];
const FRIDAY_LINES = [
  '華の金曜日!🎉', '今夜は打ち上げ?', '週末までもうひと踏ん張り', '金曜の集中力は無敵',
  '土日の予定考えてニヤけてる', '今週もよく働いた…!', '金曜夜のオフィス、平和', '納品してから帰る!',
  '週報書かなきゃ', 'TGIF🍻',
  'あと少しで週末だ', '今週の自分、よくやった', '金曜の夕方って空気がゆるむ',
  '週報だけ片付けて帰ろう', '土日の予定、決まってる?', '積み残しは月曜の自分に',
  '一週間って早いね', '今日は定時で帰る宣言', '金曜の夜が一番好き', 'お疲れさまでした!',
];

function fireFlavor(key, pool, n, t) {
  if (timeFlavor.fired[key]) return;
  timeFlavor.fired[key] = true;
  const folks = employees.filter(e => e.present && !e.inChat && e.action !== 'sleep')
    .sort(() => Math.random() - 0.5).slice(0, n);
  folks.forEach((e, i) => e.say(t + 600 + i * 1400, pickFresh(key.replace(/\d+/g, ''), pool), 3400));
}

function stepTimeFlavor(t, tm) {
  const wd = (tm.dateStr.match(/\((.)\)/) || [])[1];
  const hm = tm.h * 60 + tm.m;
  if (hm >= 720 && hm < 732) fireFlavor('lunch' + tm.dateStr, LUNCH_LINES, 4, t);
  if (hm >= 900 && hm < 912) fireFlavor('snack' + tm.dateStr, SNACK_LINES, 3, t);
  if (tm.h === 23) fireFlavor('night' + tm.dateStr, NIGHT_LINES, 3, t);
  if (wd === '月' && hm >= 540 && hm < 555) fireFlavor('monday' + tm.dateStr, MONDAY_LINES, 3, t);
  if (wd === '金' && hm >= 1080 && hm < 1095) fireFlavor('friday' + tm.dateStr, FRIDAY_LINES, 3, t);
}

function onSnapshot() {
  const tm = jstNow();
  const s = snap;
  const rate = (s.billing && s.billing.jpyPerUsd) || 155;
  const firstSnap = !onSnapshot._seen;
  onSnapshot._seen = true;

  // Claude分身へのセッション振り分け(match正規表現→該当なしは遊撃X)
  const claudeEmps = employees.filter(e => e.source === 'claude');
  const claudeFallback = claudeEmps.find(e => !e.match);
  const buckets = {};
  for (const e of claudeEmps) buckets[e.id] = [];
  for (const a of (s.claude.active || [])) {
    // 担当はコレクタ側で確定済み(生パスを送らないため)。旧payload向けに従来判定も残す
    const owner = (a.owner && claudeEmps.find(e => e.id === a.owner))
      || claudeEmps.find(e => e.match && new RegExp(e.match).test(a.project || '')) || claudeFallback;
    if (owner) buckets[owner.id].push(a);
  }
  const blk = s.claude.block;
  const cq2 = s.quota && s.quota.claude;
  // 5h枠はキャッシュが5時間より古い/リセット時刻を過ぎていたら「もう別の枠」なので使わない。
  // (resetsAtはISO文字列なので Date.parse で比較すること。数値比較だとNaNで常にfalseになる)
  const sessLive = !!(cq2 && cq2.session)
    && !(cq2.session.resetsAt && Date.parse(cq2.session.resetsAt) < Date.now())
    && !(cq2.cachedAgeMin != null && cq2.cachedAgeMin > 300);
  const blockHp = sessLive ? Math.max(0, Math.round(100 - cq2.session.pct))
    : (blk && blk.remainingMinutes != null ? Math.max(0, Math.min(100, Math.round(blk.remainingMinutes / 3))) : null);   // 不明はnull(満タン扱いしない)

  // Codexもプロジェクト(proj=作業ディレクトリ由来)で振り分け
  const codexEmps = employees.filter(e => e.source === 'codex');
  const codexFallback = codexEmps.find(e => !e.match);
  const cbuckets = {};
  for (const e of codexEmps) cbuckets[e.id] = [];
  for (const a of (s.codex.active || [])) {
    // 作業フォルダ(proj)だけでなくスレッド名でも担当を判定
    // (別フォルダでAM38の作業をしているセッションを座間に回さない)
    const owner = (a.owner && codexEmps.find(e => e.id === a.owner)) || codexEmps.find(e => {
      if (!e.match) return false;
      const re = new RegExp(e.match, 'i');
      return (a.proj && re.test(a.proj)) || (a.thread && re.test(a.thread));
    }) || codexFallback;
    if (owner) cbuckets[owner.id].push(a);
  }
  const rl = s.codex.rateLimit;
  // Codexはターンが走ったときしか rate_limits を書かないので、asOf(ログのmtime)で鮮度を見る
  const rlAge = rl && rl.asOf ? (Date.now() - rl.asOf) / 60000 : null;
  const rlStale = rlAge != null && rlAge > 720;   // Claudeキャッシュと同じ12時間基準
  const codexHp = (rl && !rlStale) ? Math.max(0, Math.round(100 - rl.usedPercent)) : null;   // 不明はnull

  for (const e of employees) {
    e.bubbles = [];
    e.jobDetail = null;
    e.happy = false; e.sweat = false; e.tired = false;
    if (e.source === 'claude') {
      const act = buckets[e.id] || [];
      e.hp = e.showHp ? blockHp : null;
      e.tired = blockHp != null && blockHp < 22;
      if (act.length) {
        e.setMode('working');
        e.sweat = (blk && blk.costPerHour > 90) || act.reduce((a, b) => a + (b.sessions || 1), 0) >= 2;
        // 頭上タグ=いま実際にやっている作業(最後の指示)。名簿にはプロジェクト名込みの詳細。
        // ただしライブ配信(9:16)はcanvasをそのまま切り出すので、指示原文が映らないよう汎化する
        if (LIVE) {
          e.jobText = [...new Set(act.map(a => PUB(a.label || a.project)))].join(' / ');
          e.jobDetail = null;
          e.bubbles = [...new Set(act.map(a => `${PUB(a.label || a.project)}を進めてます`))];
        } else {
          const pn = a => a.label || a.project || 'その他';
          e.jobText = act.map(a => a.task ? a.task : pn(a) + (a.sessions > 1 ? `×${a.sessions}` : '')).join(' / ');
          e.jobDetail = act.map(a => `${pn(a)}${a.sessions > 1 ? `×${a.sessions}` : ''}${a.task ? `: ${a.task}` : ''}`).join(' / ');
          e.bubbles = act.map(a => a.task ? `いま「${Array.from(a.task).slice(0, 34).join('')}」を進めてます` : `「${pn(a)}」作業中`);
        }
        if (e.showHp && s.claude.today) e.bubbles.push(`本日 ${fmtTok(s.claude.today.tokensOut)}tok 出力`);
        if (e.tired) e.bubbles.push('5h枠がもうすぐ…');
      } else {
        // 消灯帯(22:00-05:00)は mode を idle のままにして think() の夜behaviorに任せる。
        // ここで 'sleep' を被せると加藤の豹変・伊藤×廣瀬の夜デート・月城のスタジオ逃亡が全部死ぬ
        e.setMode(tm.h >= 5 && tm.h < 7 ? 'sleep' : 'idle');
        e.jobText = '待機中';
        e.bubbles = idleMutterPool().concat(PERSONAL_MUTTER[e.id] || []);
      }
    } else if (e.source === 'codex') {
      const act = cbuckets[e.id] || [];
      e.hp = e.showHp ? codexHp : null;
      e.tired = codexHp != null && codexHp < 22;
      if (act.length) {
        e.setMode('working');
        e.sweat = act.length >= 2;
        // 同名スレッド(名前なしの'セッション'が並ぶ等)は「×N」にまとめる。
        // 「セッション / セッション / セッション」は頭上タグとして何の情報でもない
        const tally = ts => {
          const c = new Map();
          for (const x of ts) c.set(x, (c.get(x) || 0) + 1);
          return [...c].map(([k, n]) => (n > 1 ? `${k}×${n}` : k));
        };
        const thOf = a => a.label || a.thread || a.proj || 'セッション';   // 名無しスレッドは案件名で呼ぶ
        if (LIVE) {
          e.jobText = [...new Set(act.map(a => PUB(a.label || a.proj)))].join(' / ');
          e.jobDetail = null;
          e.bubbles = [...new Set(act.map(a => `${PUB(a.label || a.proj)}を進めてます`))];
        } else {
          e.jobText = tally(act.map(thOf)).join(' / ');
          e.jobDetail = tally(act.map(thOf)).join(' / ');
          e.bubbles = [...new Set(act.map(thOf))].map(th => `「${Array.from(th).slice(0, 30).join('')}」進行中`);
        }
      } else {
        // 消灯帯(22:00-05:00)は mode を idle のままにして think() の夜behaviorに任せる。
        // ここで 'sleep' を被せると加藤の豹変・伊藤×廣瀬の夜デート・月城のスタジオ逃亡が全部死ぬ
        e.setMode(tm.h >= 5 && tm.h < 7 ? 'sleep' : 'idle');
        e.jobText = '待機中';
        e.bubbles = idleMutterPool().concat(PERSONAL_MUTTER[e.id] || []);
      }
      if (e.showHp && rl && !rlStale) e.bubbles.push(`週次残量 ${codexHp}%${rlAge > 120 ? `(${Math.round(rlAge / 60)}時間前)` : ''}`);
    } else if (e.source === 'schedule') {
      const tts = s.tts;
      // フォルダが読めなかった場合 countTodayEntries は null を返す。0本と混同しない
      const dvals = s.deliveries ? (e.deliveryKeys || [e.deliveryKey]).map(k => s.deliveries[k]) : null;
      const del = dvals ? (dvals.some(v => v == null) ? null : dvals.reduce((a, v) => a + v, 0)) : null;
      e.hp = null;
      const wj = e.watcherKey && s.launchd && s.launchd[e.watcherKey];
      if (e.watcherKey && !(wj && wj.running)) {
        e.setMode('panic');
        e.jobText = '❌ TTS(watcher)停止中!';
        e.bubbles = ['収録マシンが止まってる!'];
        e.action = 'stand';
      } else if (tts && tts.rendering) {
        // 実際にレンダリングしている間は時計に関係なくスタジオで収録中にする。
        // launchdのrunningは「常駐しているか」しか見ていないので、これが無いと
        // 18時に回っていても「待機中」に見えてしまう(2026-08-05 MON指摘)
        e.setMode('working');
        e.jobText = LIVE ? '収録中' : `🎤収録中 ${ttsShort(tts.title)}`;
        e.bubbles = LIVE ? ['収録中です'] : [
          `「${ttsShort(tts.title)}」を収録中`,
          tts.sinceMin >= 1 ? `この1本、${tts.sinceMin}分回してます` : 'いま回しはじめました',
        ].concat(tts.doneToday ? [`今日はもう${tts.doneToday}本あがりました`] : []);
      } else if (tts && tts.stalledMin) {
        // watcherは生きているのに「開始」から30分以上「完了」が来ない=固まっている
        e.setMode('panic');
        e.jobText = `⚠️収録が${tts.stalledMin}分止まってます`;
        e.bubbles = [`「${ttsShort(tts.title)}」から進んでません`, '見に行ったほうがいいかも…'];
        e.action = 'stand';
      } else if (shiftActive(e.shift, tm)) {
        e.setMode('working');
        e.jobText = '日次ルーチン稼働中';
        e.bubbles = ['ただいま製造中…!', '(講演/台本/ショート仕込み中)'];
      } else if (tm.h >= 21 && tm.h < 22) {
        e.setMode('sleep');
        e.jobText = `次の出社 ${e.shift[0]}:${String(e.shift[1]).padStart(2, '0')}`;
      } else if (tm.h >= 22 || tm.h < 3) {
        // 消灯中は idle にしておく(think()がスタジオへ逃がす。sleepだと夜の台詞が全部出ない)
        e.setMode('idle');
        e.jobText = `次の出社 ${e.shift[0]}:${String(e.shift[1]).padStart(2, '0')}`;
      } else {
        e.setMode('idle');
        e.happy = del > 0;
        e.jobText = del == null ? '納品数 集計できず' : (del > 0 ? `本日 ${del}本 納品` : '本日実績なし');
        e.bubbles = del == null ? ['納品フォルダが開けなくて、まだ数えられていません']
          : (del > 0 ? [`今日は${del}本納品!`, 'また明日も作ります'] : ['今日はまだ実績なし']);
      }
    } else if (e.source === 'janitor') {
      e.hp = null;
      if (e.mode !== 'clean') { e.mode = 'clean'; }
      // 実マシンのゴミ箱・メモリと連動
      const mac = s.machine || {};
      const ti = mac.trashItems, mp = mac.memUsedPct;
      e.trashItems = ti; e.memUsedPct = mp;
      const extra = [];
      if (ti != null) {
        e.jobText = ti > 0 ? `ゴミ箱に${ti}件…回収中` : '巡回清掃中(ゴミ箱は空)';
        if (ti >= 30) extra.push(`ゴミ箱、${ti}件も溜まってる!社長ー!`, 'これは大掃除案件です', 'ゴミ箱を空にしてください(切実)');
        else if (ti > 0) extra.push(`ゴミ箱に${ti}件、回収します`, 'ゴミはこまめに捨てましょう');
        else extra.push('ゴミ箱ピカピカ、気持ちいい', 'ゴミゼロ、いい会社です');
      } else {
        e.jobText = '巡回清掃中';
      }
      if (mp != null) {
        if (mp >= 85) extra.push(`メモリ${mp}%…重い、換気だ!`, 'メモリがパンパンです、再起動を…', '空きメモリが足りません!');
        else if (mp >= 65) extra.push(`メモリ${mp}%、ちょっと重いかも`);
        else extra.push(`メモリ${mp}%、快適そのもの`);
      }
      e.bubbles = extra.concat(PERSONAL_MUTTER.shirayanagi || []);
    } else if (e.source === 'boss') {
      if (e.directing) { e.hp = null; continue; }
      const busy = (s.claude.active || []).length + (s.codex.active || []).length;
      e.hp = null;
      const tc = s.tasks && s.tasks.count;
      const idle = s.user && s.user.idleMin != null ? s.user.idleMin : null;
      const recApp = s.user && s.user.recordingApp;
      const away = idle != null && idle >= 30;
      // MONが収録アプリを起動中→撮影スタジオで収録
      if (recApp && !away) {
        if (!e.recording) {
          e.recording = true;
          // 収録は最優先: 見回り・朝会・イベント参加を全て中断してからスタジオへ
          if (patrol.active) endPatrol(e, performance.now());
          if (standup.active && standup.active.members.includes(e)) endStandup(performance.now());
          if (e.inEvent && officeEvent.active) { officeEvent.active.members = officeEvent.active.members.filter(x => x !== e); e.inEvent = false; }
          e.releaseSpot(); e.releaseReception(); e.resting = false; e.inChat = false;
          e.mode = 'working'; e._wasWorking = true;
          e.goto(BOSS_STUDIO_POST, 'studio');
          e.say(performance.now() + 800, '🎥収録入りまーす!静かに頼む!', 3600);
        } else if (e.action !== 'studio' && e.action !== 'walk') {
          e.goto(BOSS_STUDIO_POST, 'studio');   // 何かに連れ出されてもスタジオへ戻る(自己修復)
        }
        e.jobText = `収録中(${recApp})`;
        e.bubbles = [];
        continue;
      }
      if (e.recording) {   // 収録終了→通常運転に戻る
        e.recording = false;
        e.nextThink = 0;
        e.say(performance.now() + 500, '📼収録完了!編集は任せた!', 3200);
        e.goto(e.seat, 'sit');
      }
      if (idle != null && idle >= 30) {
        if (tm.h >= 23 || tm.h < 8) {
          e.setMode('sleephome');
          e.jobText = '就寝中(自宅)…おやすみなさい';
        } else {
          e.setMode('out');
          e.jobText = `外出中(離席 ${idle}分)`;
        }
      } else if (busy > 0) {
        e.setMode('working');
        e.jobText = `指揮中(稼働 ${busy}件)`;
        e.bubbles = ['現場は頼んだぞ…', `今日は ${fmtYen((s.totals.todayCost || 0) * rate)} 分か…`, `保留が${tc ?? '-'}件…`];
      } else {
        e.setMode('idle');
        e.jobText = `保留 ${tc ?? '-'}件を検討中`;
        e.bubbles = [`保留タスク ${tc ?? '-'}件…`, '次は何を仕込むか'].concat(PERSONAL_MUTTER.fujimoto);
      }
    }
  }

  // 新規稼働の検知→1人なら指示行脚、2人以上なら作戦会議に招集
  const newWorkers = [];
  for (const e of employees) {
    const nowWorking = e.mode === 'working';
    if (!firstSnap && nowWorking && !e._wasWorking && e.def.source !== 'boss' && e.def.source !== 'janitor') {
      newWorkers.push(e.id);
    }
    e._wasWorking = nowWorking;
  }
  if (newWorkers.length >= 2) standup.pending = newWorkers.slice(0, 3);
  else if (newWorkers.length === 1) directive.queue.push(newWorkers[0]);

  // ---- データ駆動イベント ----
  const now = performance.now();
  const subs = s.youtube && s.youtube.subs;
  if (subs != null) {
    if (!firstSnap && prevSubs != null && subs > prevSubs) startCelebration(now, subs - prevSubs, subs);
    prevSubs = subs;
  }
  const delivTotal = s.deliveries && s.deliveries.koen != null && s.deliveries.daihon != null
    ? s.deliveries.koen + s.deliveries.daihon : null;   // 読めなかった日はnull(0扱いすると誤お祝いが出る)
  if (delivTotal != null) {
    if (!firstSnap && prevDeliv != null && delivTotal > prevDeliv) announceDelivery(now);
    prevDeliv = delivTotal;
  }
  const tc = (s.totals && s.totals.todayCost) || 0;
  const mile = Math.floor(tc / 100);
  if (!firstSnap && mile > costMilestone) {
    const bossB = employees.find(e => e.def.source === 'boss');
    if (bossB && bossB.present && !bossB.inChat && !bossB.recording) {
      bossB.say(now + 3000, pickFresh('burn', BURN_LINES).replace(/\{d\}/g, '$' + mile + '00'), 4200);
    }
  }
  costMilestone = Math.max(costMilestone, mile);
  // Claudeセッション残量15%切り: 伊藤が焦る(1回だけ、回復したらリセット)
  if (sessLive) {
    if (cq2.session.pct > 85 && !onSnapshot._quotaPanic) {
      onSnapshot._quotaPanic = true;
      const itoQ = employees.find(e => e.id === 'ito');
      if (itoQ && itoQ.present) itoQ.say(now + 6000, '今週の稼働、そろそろ限界かも…段取り考えないと💦', 4600);
    }
    if (cq2.session.pct < 70) onSnapshot._quotaPanic = false;
  }
}

/* ================================================================
   HUD
   ================================================================ */
const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHIP = {
  working: ['work', '稼働中'], idle: ['idle', '待機'], break: ['rest', '休憩'],
  sleep: ['sleep', '睡眠'], off: ['off', '退勤'], panic: ['panic', '停止!'],
  out: ['off', '外出中'], sleephome: ['sleep', '就寝中'], clean: ['work', '清掃中'], reception: ['work', '受付'],
};

function updateHud() {
  const tm = jstNow();
  $('time').textContent = tm.hm;
  $('date').textContent = tm.dateStr;
  if (!snap) {
    // 「通信は成功したが0件」も未受信として出す。でないと全ボードが '--' のまま正常に見えてしまう
    if (viewToken) {
      const msg = fetchFail ? '未受信(通信エラー)' : '未受信(データ0件・表示トークンを確認)';
      $('stale').style.display = 'block';
      $('staleAge').textContent = msg;
      const sh = $('syncHud');
      if (sh) { sh.textContent = `🚨 ${msg}`; sh.style.color = 'var(--bad)'; }
      $('lastTs').textContent = msg;
    }
    return;
  }
  const s = snap, rate = (s.billing && s.billing.jpyPerUsd) || 155;

  const tv = s.totals.todayCost || 0;
  const subsCfg = CFG.subscriptions || (s.billing && s.billing.subscriptions) || [];
  const fixedMonthly = subsCfg.reduce((a, x) => a + (x.monthlyJPY || 0), 0);
  const jstNowD = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const dim = new Date(jstNowD.getFullYear(), jstNowD.getMonth() + 1, 0).getDate();
  const unset = subsCfg.some(x => !x.monthlyJPY);
  $('todayFixed').textContent = fixedMonthly ? `${fmtYen(fixedMonthly / dim)}${unset ? '+α' : ''}` : '未設定';
  $('monthFixed').textContent = fixedMonthly ? `${fmtYen(fixedMonthly)}${unset ? ' (一部未記入)' : ''}` : 'config.jsに記入';
  $('todayCost').textContent = `${fmtYen(tv * rate)}`;
  $('monthCost').textContent = `${fmtYen((s.totals.monthCost || 0) * rate)} (${fmtUsd(s.totals.monthCost || 0)})`;
  $('burnRate').textContent = s.claude.block && s.claude.block.costPerHour ? `${fmtYen(s.claude.block.costPerHour * rate)}/h` : '—';
  const cc = s.claude.today ? s.claude.today.cost : 0, xc = s.codex.today ? s.codex.today.cost : 0;
  $('splitCost').textContent = `${fmtUsd(cc)} / ${fmtUsd(xc)}`;
  $('splitBar').style.width = (cc + xc > 0 ? cc / (cc + xc) * 100 : 50) + '%';

  // データ同期ステータス(5分毎コレクターの死活+最終受信時刻)
  {
    const ageMin = snapAt > 0 ? (Date.now() - snapAt) / 60000 : Infinity;
    const el = $('syncHud');
    const rxTime = snapAt > 0 ? new Date(snapAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }) : '--:--';
    if (ageMin >= (CFG.staleMin || 20)) { el.textContent = `🚨 止まってます!(最終 ${rxTime})`; el.style.color = 'var(--bad)'; }
    else if (ageMin < 7) { el.textContent = `● OK ${rxTime}受信(5分毎)`; el.style.color = 'var(--good)'; }
    else { el.textContent = `受信待ち(最終 ${rxTime})`; el.style.color = 'var(--warn)'; }
  }

  const subs = $('subs');
  subs.innerHTML = '';
  for (const sub of subsCfg) {
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `<span class="lbl">${sub.name}${sub.plan ? `(${sub.plan})` : ''}</span><span>${sub.monthlyJPY ? fmtYen(sub.monthlyJPY) : '未設定'}</span>`;
    subs.appendChild(div);
  }
  if (s.codex.rateLimit && s.codex.rateLimit.plan) {
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `<span class="lbl">Codexプラン検出</span><span>${esc(s.codex.rateLimit.plan)}</span>`;
    subs.appendChild(div);
  }

  // 残量ボード(実データ: Claude公式usage API + Codexログ)
  const q = s.quota && s.quota.claude;
  const rlq = s.codex.rateLimit;
  const fmtReset = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const qEl = $('quota');
  if (qEl) {
    const rows = [];
    const qrow = (label, usedPct, resetTxt) => {
      const remain = Math.max(0, Math.round(100 - usedPct));
      const col = remain > 50 ? 'var(--good)' : remain > 20 ? 'var(--warn)' : 'var(--bad)';
      rows.push(`<div class="row"><span class="lbl">${label}</span><span>残り <b>${remain}%</b></span></div>` +
        `<div class="bar"><i style="width:${remain}%;background:${col}"></i></div>` +
        (resetTxt ? `<div style="font-size:10px;opacity:.55;text-align:right;margin:-3px 0 4px">リセット ${resetTxt}</div>` : ''));
    };
    // Claude の resetsAt は ISO文字列。Date.parse で比較しないと常に false になる
    const qLive = (x, maxAgeMin) => !!x && !(x.resetsAt && Date.parse(x.resetsAt) < Date.now())
      && !(maxAgeMin != null && q.cachedAgeMin != null && q.cachedAgeMin > maxAgeMin);
    if (q && qLive(q.session, 300)) qrow('Claude セッション(5h)', q.session.pct, fmtReset(q.session.resetsAt));
    if (q && qLive(q.week)) qrow('Claude 週間(全モデル)', q.week.pct, fmtReset(q.week.resetsAt));
    if (q && qLive(q.model)) qrow(`Claude 週間(${esc(q.model.name)})`, q.model.pct, fmtReset(q.model.resetsAt));
    const rlqAge = rlq && rlq.asOf ? Math.round((Date.now() - rlq.asOf) / 60000) : null;
    if (rlq && !(rlq.resetsAt && rlq.resetsAt < Date.now())) {
      qrow('Codex 週間', rlq.usedPercent, rlq.resetsAt ? fmtReset(new Date(rlq.resetsAt).toISOString()) : '');
      if (rlqAge != null && rlqAge >= 30) {
        rows.push(`<div style="font-size:10px;opacity:.55">※Codex残量は${rlqAge >= 120 ? Math.round(rlqAge / 60) + '時間' : rlqAge + '分'}前の値(最後にCodexが動いた時点)</div>`);
      }
    }
    if (CFG.mureka && CFG.mureka.gold != null) {
      rows.push(`<div class="row"><span class="lbl">Mureka Gold</span><span>残り <b>${CFG.mureka.gold}</b> G</span></div>`);
    }
    if (q && q.cachedAgeMin != null) {
      rows.push(`<div style="font-size:10px;opacity:.55">※Claude残量は${q.cachedAgeMin}分前の値(APIレート制限中)</div>`);
    }
    // Claudeの行が1本も出せなかったことを黙って隠さない(消えたのか0なのか分からなくなる)
    if (!q || !['session', 'week', 'model'].some(k => qLive(q[k], k === 'session' ? 300 : null))) {
      rows.push('<div class="row"><span class="lbl" style="opacity:.6">Claude 残量</span><span style="opacity:.6">取得できず(枠のリセット済み / APIレート制限)</span></div>');
    }
    qEl.innerHTML = rows.length ? rows.join('') : '<div style="opacity:.6;font-size:12px">残量データ待ち(次の収集で反映)</div>';
  }

  // マシン室(このMacの実況)
  const mEl = $('machine');
  if (mEl) {
    const mc = s.machine || {};
    const mrows = [];
    const mbar = (label, pct, extra) => {
      if (pct == null) return;
      const col = pct < 60 ? 'var(--good)' : pct < 85 ? 'var(--warn)' : 'var(--bad)';
      mrows.push(`<div class="row"><span class="lbl">${label}</span><span>${pct}%${extra ? ` <span style="opacity:.6">${extra}</span>` : ''}</span></div>` +
        `<div class="bar"><i style="width:${pct}%;background:${col}"></i></div>`);
    };
    mbar('CPU(頭脳の稼働率)', mc.cpuPct, mc.loadAvg != null ? `負荷 ${mc.loadAvg}` : '');
    mbar('メモリ(作業台の混み具合)', mc.memUsedPct, null);
    mbar('ストレージ(倉庫)', mc.diskUsedPct, mc.diskFreeGB != null ? `残り${mc.diskFreeGB}GB` : '');
    if (mc.topProcs && mc.topProcs.length) {
      const tp = mc.topProcs[0];
      // psの%は1コア=100%基準。マシン全体比に直し、コア換算を併記する
      const share = mc.cores ? Math.min(100, Math.round(tp.cpu / mc.cores)) : null;
      const cores = (tp.cpu / 100).toFixed(1);
      mrows.push(`<div class="row"><span class="lbl">いちばん働いてる機械</span><span>🏭 <b>${esc(tp.name)}</b> ${share != null ? `${share}%` : ''} <span style="opacity:.6">${cores}コア</span></span></div>`);
    }
    if (mc.netRxMB != null) {
      mrows.push(`<div class="row"><span class="lbl">通信(直近5分)</span><span>📥${mc.netRxMB}MB 📤${mc.netTxMB}MB</span></div>`);
    }
    if (mc.battPct != null) {
      mrows.push(`<div class="row"><span class="lbl">電源</span><span>${mc.battCharging ? '🔌 コンセント' : '🔋 バッテリー'} ${mc.battPct}%${!mc.battCharging && mc.battPct < 30 ? ' 🚨' : ''}</span></div>`);
    }
    if (mc.uptimeDays != null) {
      mrows.push(`<div class="row"><span class="lbl">連続稼働</span><span>${mc.uptimeDays}日${mc.uptimeDays >= 7 ? '(そろそろ再起動を…)' : ''}</span></div>`);
    }
    if (mc.trashItems != null) {
      mrows.push(`<div class="row"><span class="lbl">ゴミ箱(白柳の戦場)</span><span>${mc.trashItems}件</span></div>`);
    }
    mEl.innerHTML = mrows.length ? mrows.join('') : '<div style="opacity:.6;font-size:12px">マシンデータ待ち(次の収集で反映)</div>';
  }

  const roster = $('roster');
  roster.innerHTML = '';
  // 今月の経過営業日(JST・土日除く)
  const jd = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  let bizDays = 0;
  for (let i = 1; i <= jd.getDate(); i++) {
    const w = new Date(jd.getFullYear(), jd.getMonth(), i).getDay();
    if (w !== 0 && w !== 6) bizDays++;
  }
  for (const e of employees) {
    let [cls, label] = CHIP[e.mode] || CHIP.idle;
    if (e.mode === 'idle' && e.resting) [cls, label] = CHIP.break;
    if (e.mode === 'idle' && e.receptionOn) [cls, label] = CHIP.reception;
    if (e.def.source === 'janitor' && e.action === 'sabori') [cls, label] = ['rest', 'サボり中'];
    if (e.def.source === 'janitor' && (e.janResting || e.onChimeBreak)) [cls, label] = ['rest', '休憩'];
    const row = document.createElement('div');
    row.className = 'emp';
    const sheet = SHEETS[e.spriteId || e.id];
    if (sheet && sheet.boxes && sheet.boxes[1]) {
      const b = sheet.boxes[1];
      const av = document.createElement('canvas');
      av.width = 44; av.height = 60;
      av.style.width = '24px'; av.style.height = '33px';
      const ag = av.getContext('2d');
      const dw = Math.min(44, 60 * b.w / b.h);
      ag.drawImage(sheet.cv, b.x, b.y, b.w, b.h, (44 - dw) / 2, 0, dw, 60);
      row.appendChild(av);
    } else {
      const av = document.createElement('canvas');
      av.width = 12; av.height = 16;
      av.style.width = '24px'; av.style.height = '32px';
      drawChar(av.getContext('2d'), 6, 16, e.def, 'down', 0, e.mode === 'panic' ? 'panic' : (e.mode === 'sleep' || e.mode === 'sleephome') ? 'sleep' : 'normal', 0);
      row.appendChild(av);
    }
    const mid = document.createElement('div');
    mid.innerHTML = `<div class="nm">${esc(e.name)} <span class="rl">${esc(e.dept)}・${esc(e.role)}</span></div>`;
    row.appendChild(mid);
    const right = document.createElement('div');
    right.style.textAlign = 'right';
    let hpHtml = '';
    if (e.hp != null) {
      const col = e.hp > 50 ? 'var(--good)' : e.hp > 20 ? 'var(--warn)' : 'var(--bad)';
      hpHtml = `<div class="hp"><div class="bar"><i style="width:${e.hp}%;background:${col}"></i></div><div class="pct">HP ${e.hp}%</div></div>`;
    }
    // 人間換算の月給(時給×8h×今月の営業日)
    let salHtml = '';
    if (e.def.wage != null) {
      salHtml = e.def.wage > 0
        ? `<div class="sal">月給換算 ¥${(e.def.wage * 8 * bizDays).toLocaleString('ja-JP')}</div>`
        : '<div class="sal">無給(経営者)</div>';
    }
    right.innerHTML = `<span class="chip ${cls}">${label}</span>${hpHtml}${salHtml}`;
    row.appendChild(right);
    const job = document.createElement('div');
    job.className = 'job';
    job.textContent = e.jobDetail || e.jobText || '';
    row.appendChild(job);
    roster.appendChild(row);
  }
  const totalSal = employees.reduce((a, e) => a + (e.def.wage || 0) * 8 * bizDays, 0);
  const fixedM = (CFG.subscriptions || []).reduce((a, x) => a + (x.monthlyJPY || 0), 0);
  $('staffNote').innerHTML =
    `人間を雇った場合の人件費(今月${bizDays}営業日×8h): <b>¥${totalSal.toLocaleString('ja-JP')}</b>` +
    (fixedM ? ` / AI実費 ¥${fixedM.toLocaleString('ja-JP')} = <b>約${Math.round(totalSal / fixedM)}分の1</b>のコスト` : '') +
    '<br>HP共有: 伊藤=クロード5h枠 / 安藤=コデックス週次 | ペット: ララ(犬)';

  const yt = $('youtube');
  if (s.youtube && s.youtube.subs != null) {
    const goal = CFG.youtubeGoal || 0;
    const vgoal = CFG.youtubeViewGoal || 0;
    const bar = (cur, gl) => {
      const w = gl ? Math.min(100, Math.max(cur > 0 ? 0.6 : 0, cur / gl * 100)) : 0;
      return `<div class="bar"><i style="width:${w}%;background:var(--good)"></i></div>`;
    };
    const rSubs = todayRange(x => x.yt && x.yt.subs);
    const rViews = todayRange(x => x.yt && x.yt.views);
    // 「いつからの数字か」を必ず書く。基準が取れない日は数字を出さずそう言う
    const up = r => {
      if (!r) return ' <span style="opacity:.45">(0時基準の記録なし)</span>';
      const d = r.delta;
      const tip = `0時基準 ${baseAt(r)} の ${r.base.toLocaleString('ja-JP')} から`;
      const col = d > 0 ? 'var(--good)' : d < 0 ? 'var(--warn)' : 'inherit';
      const txt = d > 0 ? `+${d.toLocaleString('ja-JP')}` : d < 0 ? d.toLocaleString('ja-JP') : '±0';
      return ` <span title="${esc(tip)}" style="color:${col}${d === 0 ? ';opacity:.5' : ''}">0時から ${txt}</span>`;
    };
    yt.innerHTML =
      `<div class="row"><span class="lbl">📺 登録者</span><span><b>${s.youtube.subs.toLocaleString('ja-JP')}</b>人 / 目標 ${fmtJa(goal)}人 (${fmtGoalPct(s.youtube.subs, goal)})${up(rSubs)}</span></div>` +
      bar(s.youtube.subs, goal) +
      `<canvas class="spark" id="sparkSubs" width="560" height="48"></canvas>` +
      `<div class="row"><span class="lbl">📈 総再生</span><span><b>${(s.youtube.views ?? 0).toLocaleString('ja-JP')}</b>回 / 目標 ${fmtJa(vgoal)}回 (${fmtGoalPct(s.youtube.views, vgoal)})${up(rViews)}</span></div>` +
      bar(s.youtube.views ?? 0, vgoal) +
      `<canvas class="spark" id="sparkViews" width="560" height="48"></canvas>` +
      `<div class="row"><span class="lbl">🎬 動画</span><span><b>${s.youtube.videos != null ? s.youtube.videos.toLocaleString('ja-JP') : '-'}</b>本</span></div>`;
    drawSpark('sparkSubs', x => x.yt && x.yt.subs);
    drawSpark('sparkViews', x => x.yt && x.yt.views);
  } else {
    yt.innerHTML = `<span style="opacity:.6">未接続 — collector/config.json の youtube に APIキー/チャンネルID を設定すると表示されます</span>`;
  }

  const sales = CFG.sales || {};
  $('salesMonth').textContent = sales.monthlyJPY != null
    ? `${fmtYen(sales.monthlyJPY)}${sales.note ? `(${sales.note})` : ''}`
    : '未設定(config.jsのsalesに記入)';

  const del = $('deliveries');
  const wh = todayWorkedHours();
  del.innerHTML = `<span>🎤 講演 <b>${s.deliveries.koen ?? '-'}</b>本</span><span>📜 台本 <b>${s.deliveries.daihon ?? '-'}</b>本</span><span>🔤 出力 <b>${fmtTok(s.totals.todayTokens || 0)}</b>tok</span>`
    + (wh != null ? `<span title="5分毎の観測からの推定値">⏱ 本日の延べ稼働 <b>${wh.toFixed(1)}</b>人時<span style="opacity:.5;font-size:10px">(推定)</span></span>` : '');

  const ul = $('tasks');
  ul.innerHTML = '';
  for (const it of (s.tasks.items || [])) {
    const li = document.createElement('li');
    // since が無い行は日数を出さない(起票日を推測しない)
    const d = it.since ? Math.floor((Date.now() - Date.parse(it.since + 'T00:00:00+09:00')) / 86400000) : null;
    const cls = d == null ? '' : d >= 90 ? ' style="color:var(--bad)"' : d >= 30 ? ' style="color:var(--warn)"' : '';
    const ageTag = d == null ? '' : `<span class="age"${cls}>滞留${d}日</span>`;
    li.innerHTML = `<b>${esc(it.id)}</b>${esc(it.text)}${ageTag}`;
    ul.appendChild(li);
  }
  if (s.tasks.count > (s.tasks.items || []).length) {
    const li = document.createElement('li');
    li.textContent = `…ほか ${s.tasks.count - s.tasks.items.length} 件`;
    ul.appendChild(li);
  }

  const age = Math.round((Date.now() - snapAt) / 60000);
  $('lastTs').textContent = `${age}分前 (${new Date(snapAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })})`;
  const stale = age > (CFG.staleMin || 20) || fetchFail;
  $('stale').style.display = stale ? 'block' : 'none';
  $('staleAge').textContent = `${age}分前`;
}

/* ================================================================
   メインループ
   ================================================================ */
let last = 0, lastAmbient = 0;
function loop(t) {
  simT = t;
  cx.setTransform(4, 0, 0, 4, 0, 0);   // 4xスケールを毎フレーム保証
  const dt = Math.min(100, t - last);
  last = t;
  const tm = jstNow();

  for (const e of employees) { e.think(t, tm); e.step(dt, t); e.tickBubble(t); }
  stepChat(t);
  stepGroupChat(t);
  stepFight(t);
  stepDirective(t);
  stepRomance(t);
  stepPatrol(t);
  stepStandup(t);
  stepEvent(t);
  stepPanic(t);
  stepChimeBreak(t);
  stepMachineTalk(t);
  stepTimeFlavor(t, tm);
  if (t < celebration.until && Math.random() < 0.5) spawnParticle('confetti', Math.random() * W, Math.random() * 24);
  stepDog(dt, t);
  // 衝突回避: ぶつかる前に避ける。立場が弱い方(=時給が低い方)から先に道を譲る
  const rankOf = e => e.def.source === 'boss' ? 99999 : (e.def.wage != null ? e.def.wage : 1000);
  const YIELD_LINES = ['おっと、お先どうぞ', 'どうぞどうぞ', '失礼しました💦', '(スッ…と道を譲る)', 'おっとっと'];
  const movers = employees.filter(e => e.present && e.action === 'walk');
  for (let i = 0; i < movers.length; i++) {
    for (let j = i + 1; j < movers.length; j++) {
      const A = movers[i], B = movers[j];
      const dx = B.pos.x - A.pos.x, dy = B.pos.y - A.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.1 && d < 18) {
        const ra = rankOf(A), rb = rankOf(B);
        const yielder = ra === rb ? ((A.seed % 2) ? A : B) : (ra < rb ? A : B);
        const other = yielder === A ? B : A;
        // 弱い方が横+後ろへスッと避ける(接触前に)
        const ax = (yielder.pos.x - other.pos.x) / d, ay = (yielder.pos.y - other.pos.y) / d;
        const sgn = (yielder.seed % 2) ? 1 : -1;
        const p = (18 - d) * 0.3;
        yielder.pos.x += (ax * 0.5 + -ay * sgn * 0.85) * p;
        yielder.pos.y += (ay * 0.5 + ax * sgn * 0.85) * p;
        if (!yielder.bubble && Math.random() < 0.02) yielder.say(t, YIELD_LINES[Math.floor(Math.random() * YIELD_LINES.length)], 2200);
        if (d < 8) {
          // それでも正面衝突したら押し離す+たまに喧嘩
          const push = (8 - d) * 0.3;
          A.pos.x -= dx / d * push; A.pos.y -= dy / d * push;
          B.pos.x += dx / d * push; B.pos.y += dy / d * push;
          if (Math.random() < 0.25) startFight(A, B, t);
        }
      }
    }
    const dxd = dog.pos.x - movers[i].pos.x, dyd = dog.pos.y - movers[i].pos.y;
    const dd = Math.hypot(dxd, dyd);
    if (dd > 0.1 && dd < 10) { dog.pos.x += dxd / dd * (10 - dd) * 0.5; dog.pos.y += dyd / dd * (10 - dd) * 0.5; }
  }
  // すり抜け防止: 立っている人・イベント機材には歩行者側が押し出されて回り込む
  const solid = employees.filter(e => e.present && (
    ['stand', 'studio', 'sabori', 'cleaning', 'coffee'].includes(e.action) ||
    (e.action === 'sit' && (e.resting || e.atMeeting))));
  for (const w of movers) {
    for (const s2 of solid) {
      if (s2 === w) continue;
      const dx2 = w.pos.x - s2.pos.x, dy2 = w.pos.y - s2.pos.y;
      const d2 = Math.hypot(dx2, dy2);
      if (d2 > 0.1 && d2 < 10) { const p = (10 - d2) * 0.6; w.pos.x += dx2 / d2 * p; w.pos.y += dy2 / d2 * p; }
    }
    // イベント什器は「円」ではなく描画どおりの「矩形」で押す。
    // 円だと中心が廊下(y=184/192)に乗った什器が東西の通路を完全に塞ぎ、
    // 通ろうとした人が振動したまま20秒ワープしていた(矩形なら一番浅い面=縦にずれて回り込める)
    if (officeEvent.active) {
      const dest = w.path.length ? w.path[w.path.length - 1] : null;
      let touched = false;
      for (const [k, ox, oy, ow, oh] of EVENT_PROPS[officeEvent.active.kind]) {
        const x0 = ox - 3, x1 = ox + ow + 3, y0 = oy - 3, y1 = oy + oh + 3;
        if (w.pos.x <= x0 || w.pos.x >= x1 || w.pos.y <= y0 || w.pos.y >= y1) continue;
        if (dest && dest.x > x0 && dest.x < x1 && dest.y > y0 && dest.y < y1) continue;   // 目的地そのものなら押さない
        touched = true;
        if (w._propFree) continue;
        const pl = w.pos.x - x0, pr = x1 - w.pos.x, pu = w.pos.y - y0, pd = y1 - w.pos.y;
        const m = Math.min(pl, pr, pu, pd);
        const st = Math.min(m, 1.2);
        if (m === pl) w.pos.x -= st; else if (m === pr) w.pos.x += st;
        else if (m === pu) w.pos.y -= st; else w.pos.y += st;
      }
      if (!touched) { w._propT = 0; w._propFree = false; }
      else if (!w._propT) w._propT = t;
      else if (t - w._propT > 1500) w._propFree = true;   // 押し合いが続いたら通す(20秒ワープよりは自然)
    }
  }
  stepParticles(dt);

  // 環境パーティクル
  if (t - lastAmbient > 600) {
    lastAmbient = t;
    const onAirNow = snap && snap.launchd && snap.launchd['com.mon.tsuki.watcher'] && snap.launchd['com.mon.tsuki.watcher'].running;
    if (onAirNow && Math.random() < 0.35) {
      spawnParticle('note', 540 + Math.random() * 20, 250);
    }
  }

  cx.clearRect(0, 0, W, H);
  const night = drawOffice(cx, t, tm);

  const items = [];
  // 大型什器(前にいる人を隠す): キッチン家電・棚・スタジオ機材
  const OCCLUDERS = [
    ['coffee_st', 20, 182, 30, 36], ['vending', 58, 180, 24, 38], ['snack', 90, 182, 28, 36],
    ['cooler', 126, 182, 20, 36], ['bin_g', 154, 186, 11, 16], ['plant_a', 212, 276, 20, 34],

    ['copier', 524, 154, 26, 32], ['tower', 554, 148, 20, 38], ['netcab', 578, 150, 22, 36], ['rack', 604, 140, 26, 46],
    ['bin_g', 600, 192, 10, 15], ['bin_r', 613, 192, 10, 15], ['exting', 11, 66, 8, 17],
    ['reception', COUNTER_RECT.x, COUNTER_RECT.y, COUNTER_RECT.w, COUNTER_RECT.h], ['sanitizer', 242, 280, 10, 24],
  ];


  for (const [k, ox, oy, ow, oh] of OCCLUDERS) {
    items.push({ y: oy + oh - 6, draw: g => drawProp(g, k, ox, oy, ow, oh) });
  }
  for (const e of employees) {
    if (e.def.source === 'janitor') continue;
    const atDesk = e.present && (e.action === 'sit' || e.action === 'sleep') && !e.resting && !e.atMeeting;
    if (!atDesk) items.push({ y: e.desk.y - 2, draw: g => drawChair(g, e.desk) });
    if (atDesk) items.push({ y: e.desk.y + 21, draw: g => {
      g.font = '5px DotGothic16';
      const nw = g.measureText(e.name).width;
      g.fillStyle = 'rgba(255,250,240,.9)';
      g.fillRect(e.desk.x - nw / 2 - 2, e.desk.y + 25, nw + 4, 7);
      g.fillStyle = INK;
      g.fillText(e.name, e.desk.x - nw / 2, e.desk.y + 30.5);
    } });
    items.push({ y: e.desk.y + 20, draw: g => drawDesk(g, e.desk, e.mode === 'working' && e.present, t + e.seed, e.def, e) });
  }
  // ソファ前面(座ったキャラの脚を隠す)
  for (const e of employees) if (e.present) items.push({ y: e.pos.y, draw: g => e.drawSprite(g, t) });
  // 名札(自席以外): 本人の足元レイヤーに置く=手前(下)を通る人が名札の上を通過する。
  // 段差スタガーは廃止し、横並びの人は名札も横一列に揃う
  for (const e of employees) {
    if (!e.present) continue;
    const seatedL = e.action === 'sit' || e.action === 'sleep';
    if (seatedL && !e.resting && !e.atMeeting) continue;   // 自席は机の前板名札に任せる
    // 受付カウンターの内側に立っている人は、名札をカウンターより手前に出さないと完全に埋まる
    const inCounter = e.pos.x >= COUNTER_RECT.x && e.pos.x <= COUNTER_RECT.x + COUNTER_RECT.w
      && e.pos.y >= COUNTER_RECT.y && e.pos.y <= COUNTER_RECT.y + COUNTER_RECT.h;
    items.push({ y: inCounter ? 308.5 : e.pos.y - 0.5, draw: g => {
      g.font = '5px DotGothic16';
      const nw = g.measureText(e.name).width;
      const cbL = seatedL && (e.resting || e.atMeeting) ? 0.30 : 0;
      const ny = e.pos.y + 3 - 30 * cbL;
      g.fillStyle = 'rgba(255,250,240,.9)';
      g.fillRect(e.pos.x - nw / 2 - 2, ny, nw + 4, 7);
      g.fillStyle = INK;
      g.fillText(e.name, e.pos.x - nw / 2, ny + 5.5);
    } });
  }
  if (officeEvent.active) {
    for (const [k, ox, oy, ow, oh] of EVENT_PROPS[officeEvent.active.kind]) {
      // 肉と串はテーブルの「上」に載っているので、テーブルより後に描く
      const sy = (k === 'b_meat' || k === 'b_skewer') ? 184 : oy + oh - 6;
      items.push({ y: sy, draw: g => drawProp(g, k, ox, oy, ow, oh) });
    }
  }
  items.push({ y: dog.pos.y, draw: g => drawDog(g, t) });
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw(cx);
  drawParticles(cx);
  for (const e of employees) e.drawOverlay(cx, t);

  if (night) {
    // 22:00〜5:00は消灯(ぐっと暗く)。それ以外の夜は薄暗い程度
    const lightsOut = tm.h >= 22 || tm.h < 5;
    cx.fillStyle = lightsOut ? 'rgba(8,8,34,.5)' : 'rgba(30,30,80,.16)';
    cx.fillRect(0, 0, W, H);
    if (lightsOut) {
      rr(cx, 6, 6, 86, 13, 'rgba(20,20,44,.85)', 'rgba(120,130,190,.5)');
      cx.font = '6px DotGothic16';
      cx.fillStyle = '#aab4e8';
      cx.fillText('🌙 消灯中 22:00-5:00', 10, 15);
    }
  }
  // BBQの煙もや: 部屋全体がもくもくする(イベント終了後はゆっくり晴れる)
  const hazeTarget = officeEvent.active && officeEvent.active.kind === 'bbq' ? (officeEvent.active.haze || 0) : 0;
  hazeLevel += (hazeTarget - hazeLevel) * (dt / 1000) * 0.9;
  if (hazeLevel > 0.004) {
    cx.fillStyle = `rgba(135,135,145,${hazeLevel.toFixed(3)})`;
    cx.fillRect(0, 0, W, H);
  }
  // 火災報知器: 赤フラッシュ+天井ランプ
  if (officeEvent.active && officeEvent.active.alarmed) {
    const flash = Math.floor(t / 260) % 2;
    if (flash) { cx.fillStyle = 'rgba(224,60,50,.09)'; cx.fillRect(0, 0, W, H); }
    cx.fillStyle = flash ? '#ff4a3c' : '#7a2620';
    cx.fillRect(306, 62, 8, 6);
    if (flash) {
      cx.font = '7px DotGothic16';
      cx.fillStyle = '#e03c2e';
      cx.fillText('🚨 火災報知器作動中!', 268, 58);
    }
  }
  if (dog.bubble && t >= (dog.bubbleFrom || 0) && t < dog.bubbleUntil) drawBubble(cx, dog.pos.x, dog.pos.y - 14, dog.bubble);
  for (const b of bubbleQ) drawBubble(cx, b.x, b.y, b.text);
  bubbleQ.length = 0;
  if (LIVE) blitLive(t, tm);
  requestAnimationFrame(loop);
}

/* ================================================================
   ライブ配信モード: オフィスを縦9:16カメラでゆっくりパンして転写
   ================================================================ */
const camCv = document.getElementById('cam');
const camCx = camCv ? camCv.getContext('2d') : null;
if (camCx) camCx.imageSmoothingEnabled = false;
const CAM_W = 203;                 // 論理クロップ幅(203x360 ≒ 9:16)
let camX = (W - CAM_W) / 2, lastLiveDom = -9999;
function liveTarget(t) {
  // 見どころがあればカメラが寄る: イベント > 朝会 > 社長の指示行脚
  if (officeEvent.active) return 310 - CAM_W / 2;
  if (standup.active) return 414 - CAM_W / 2;
  const bossE = employees.find(e => e.def.source === 'boss');
  if (bossE && bossE.directing) return bossE.pos.x - CAM_W / 2;
  return (W - CAM_W) / 2 * (1 + Math.sin(t / 60000 * Math.PI * 2));
}
function blitLive(t, tm) {
  if (!camCx) return;
  if (!Number.isFinite(camX)) camX = (W - CAM_W) / 2;   // NaN汚染からの自己回復
  let tgt = Math.max(0, Math.min(W - CAM_W, liveTarget(t)));
  if (!Number.isFinite(tgt)) tgt = (W - CAM_W) / 2;
  camX += (tgt - camX) * 0.012;
  camCx.drawImage(cv, Math.round(camX * 4), 0, CAM_W * 4, 1440, 0, 0, CAM_W * 4, 1440);
  if (t - lastLiveDom > 1000) {
    lastLiveDom = t;
    $('lvClock').textContent = tm.hm;
    $('lvMission').textContent = `「${CFG.mission}」`;
    const subs = snap && snap.youtube && snap.youtube.subs != null ? snap.youtube.subs.toLocaleString('ja-JP') + '人' : '---';
    $('lvSubs').textContent = `📺 YT登録者 ${subs}`;
    const vw = snap && snap.youtube && snap.youtube.views != null ? snap.youtube.views : null;
    $('lvViews').textContent = `📈 総再生 ${fmtJa(vw)}回 / 目標 ${fmtJa(CFG.youtubeViewGoal)}回`;
    $('lvWork').textContent = `💻 稼働中 ${employees.filter(e => e.present && e.mode === 'working').length}人`;
    // フォルダが読めなかった日(null)を0本と表示しない
    const d = snap && snap.deliveries && snap.deliveries.koen != null && snap.deliveries.daihon != null
      ? snap.deliveries.koen + snap.deliveries.daihon : null;
    $('lvDel').textContent = `📦 本日の納品 ${d == null ? '-' : d}本`;
  }
}

/* ================================================================
   マシン実況: このMacで起きていることを社員が実際の数字で語る
   ================================================================ */
const machineTalk = { next: 45000 };
const M_CPU_HOT = [
  'マシン室のファン、離陸しそうなんだけど', 'CPU {n}%!機材が本気出してる', '機材室、ほぼサウナです',
  'サーバーが唸ってる…がんばれ', '扇風機、マシン室に持ってく?', 'マシンが熱い!氷まくら いる?',
  'ファンの音でBGMが聞こえない', 'マシン室、いま何度あるんだろ', 'CPU {n}%…機械もがんばってる',
  'あの唸り、働いてる証拠だよね', '触ったら熱そう', '冷却、間に合ってるのかな',
];
const M_TOP = [
  'いま一番働いてるの、{p}らしいよ', '{p}がフル回転中。えらい', '{p}、今日も残業かあ',
  'マシン室で{p}が汗かいてる', '{p}が本気モードだ', 'MVPは{p}で決まりだね',
  '{p}が全力出してる', 'マシン室の主役はいま{p}だね', '{p}、休ませてあげたい',
  '{p}のために電気代払ってる', '今日のがんばり屋は{p}',
  '{p}、いま会社で一番の働き者',
];
const M_DISK = [
  '倉庫、もう{n}%埋まってるって', '残り{g}GB…棚卸しの時期では', '倉庫パンパン。断捨離しよう',
  '古い素材、外の倉庫に移さない?', '段ボール、積み上がってきたなあ',
  '倉庫の整理、そろそろかも', '{n}%か…古いの消そう', '棚がもう限界そう',
  '外付けに逃がす時期だね', '残り{g}GBって心もとない',
];
const M_NET_UP = ['どでかい荷物を発送中みたい(📤{n}MB)', '回線がうんうん言ってる', 'アップロード中か、道が混んでる',
  'アップロード中みたい、道が混んでる', '{n}MB送ってる…大物だね', '回線が働いてる音がする',
];
const M_NET_DOWN = ['大口の荷物が届いてる(📥{n}MB)', '搬入ラッシュだ、受付がんばれ', 'でかい荷物の受け取り中',
  '{n}MB受け取ってる、大荷物だ', '搬入中みたいだね', '何か大きいのが届いてる',
];
const M_UPTIME = ['このマシン、{n}日連続勤務らしい', 'たまには休ませて(再起動して)あげて…', '{n}日無休はさすがに社畜すぎる',
  '{n}日ぶっ続けはさすがに', 'たまには寝かせてあげよう', '再起動したら軽くなるかもよ',
];
const M_MEM = ['作業台がもう物でいっぱい({n}%)', '机の上、少し片付けよ?', '作業台が渋滞中…',
  '作業台、片付けどきかも({n}%)', 'アプリ閉じたら楽になるかな', '{n}%…そろそろ整理を',
];
const M_BATT = ['電源ケーブル抜けてない!?', 'バッテリー駆動中!残り{n}%!', 'コンセント!コンセントどこ!',
  'ケーブル!ケーブル刺さってる?', '残り{n}%で作業する勇気', '充電しないと途中で終わる',
];
// 残量に余裕があるときの穏やかな版(20%未満だけ上のM_BATTで慌てる)
const M_BATT_LOW = ['バッテリー残り{n}%、そろそろ挿しとこ', 'ケーブル、近くにあります?', '{n}%か…充電しながらやろう',
  '電源、まだ余裕あるけど念のため', 'コンセント空いてるうちに挿しとこう', '{n}%…切れる前に一回挿そう',
];
const M_CALM = ['マシン室、今日も静かで平和', '倉庫も回線も異常なし。良い日だ', '機材の調子、絶好調みたい',
  '今日はマシンも平和だね', '数字が全部おとなしい', '機材の調子がいいと気分もいい',
  'こういう日は仕事がはかどる', 'マシン室が静かなのはいいこと',
];

function stepMachineTalk(t) {
  if (t < machineTalk.next || panic.until) return;   // 火災報知器の最中にマシン室の実況をしない
  const mc = snap && snap.machine;
  if (!mc) { machineTalk.next = t + 60000; return; }
  const folks = employees.filter(e => e.present && !e.inChat && !e.atMeeting && !e.recording
    && e.def.source !== 'boss' && ['sit', 'stand', 'studio'].includes(e.action));
  if (!folks.length) { machineTalk.next = t + 30000; return; }
  const who = folks[Math.floor(Math.random() * folks.length)];
  const tp = mc.topProcs && mc.topProcs[0];
  // psの%は「1コア=100%」なので、板(759/4033)と同じくマシン全体比に直してから比べる
  const tpShare = (tp && mc.cores) ? tp.cpu / mc.cores : null;
  let line = null;
  // 目立つ状況を優先順で1つ選ぶ(意味のある実況にする)
  if (mc.cpuPct != null && mc.cpuPct >= 85) line = pickFresh('mcpu', M_CPU_HOT).replace('{n}', mc.cpuPct);
  else if (!mc.battCharging && mc.battPct != null && mc.battPct < 20) line = pickFresh('mbatt', M_BATT).replace('{n}', mc.battPct);
  else if (!mc.battCharging && mc.battPct != null && mc.battPct < 40) line = pickFresh('mbattlow', M_BATT_LOW).replace('{n}', mc.battPct);
  else if (mc.diskUsedPct != null && mc.diskUsedPct >= 90) line = pickFresh('mdisk', M_DISK).replace('{n}', mc.diskUsedPct).replace('{g}', mc.diskFreeGB ?? '?');
  else if (tpShare != null && tpShare >= 50) line = pickFresh('mtop', M_TOP).replace(/\{p\}/g, tp.name);
  else if (mc.netTxMB != null && mc.netTxMB >= 300) line = pickFresh('mnetu', M_NET_UP).replace('{n}', Math.round(mc.netTxMB));
  else if (mc.netRxMB != null && mc.netRxMB >= 300) line = pickFresh('mnetd', M_NET_DOWN).replace('{n}', Math.round(mc.netRxMB));
  else if (mc.memUsedPct != null && mc.memUsedPct >= 80) line = pickFresh('mmem', M_MEM).replace('{n}', mc.memUsedPct);
  else if (mc.uptimeDays != null && mc.uptimeDays >= 7) line = pickFresh('mupt', M_UPTIME).replace(/\{n\}/g, Math.round(mc.uptimeDays));
  else if (mc.cpuPct != null && mc.cpuPct >= 60 && tp) line = pickFresh('mtop', M_TOP).replace(/\{p\}/g, tp.name);
  else if (Math.random() < 0.25) line = pickFresh('mcalm', M_CALM);
  if (line) {
    who.say(t, line, 4200);
    machineTalk.next = t + 70000 + Math.random() * 60000;
  } else {
    machineTalk.next = t + 40000;
  }
}

/* ================================================================
   チャイム休憩: 鐘が鳴ったら全員5分休憩
   ================================================================ */
const chimeBreak = { until: 0 };
const CHIME_BREAK_TALK = [
  '鐘だ!休憩!', '5分だけ肩の力抜こ', 'コーヒー淹れよ', '目薬タイム', '立つの久しぶりかも',
  'あ〜〜〜(伸び)', 'チャイム最高', '5分後の自分、頼んだ', '肩がバキバキ', '水分水分',
  '窓の外見たい(遠い)', '糖分補給', '正座で作業してた足が…', 'まばたきの練習しよ',
  '鐘だ!手を止めよう', '5分もらいます!', 'このための1時間だった',
  'よし、脳を休ませる', '(いそいそとソファへ)', '休憩は権利です',
  'コーヒー淹れてくる、いる人?', '5分って意外と長いよね(短い)', '背中バキバキ…',
  'このタイミング完璧', '休憩上手は仕事上手', '甘いもの補給の時間', '一回、深呼吸しよう',
  'この5分のために働いてる',
];
const CHIME_BREAK_END = [
  'よし、再開!', '戻るか〜', '5分って一瞬だな…', '続きやるぞ', '席戻ろ',
  'まだ休みたい…', 'エンジン再点火', '後半戦!', '次の鐘まで頑張る',
  'よし、後半戦いこう', 'いい休憩だった', '切り替え完了',
  '名残惜しいけど戻ろ', '5分で人は生き返る', '次の鐘まで走る',
  'ソファ、また後で', '充電100%です', '手を動かすか',
];

function startChimeBreak(t) {
  chimeBreak.until = t + 300000;   // 5分
  // 犬は鐘に反応して吠える
  dogSay(t + 200, pickFresh('dogchime', DOG_CHIME), 3000);
  dog.napUntil = Math.min(dog.napUntil, t + 1500);
  for (const e of employees) {
    if (!e.present) continue;
    if (e.inChat || e.atMeeting || e.receptionOn || e.recording) continue;
    if (e.action === 'sleep' || e.panicking) continue;   // 寝ている人・避難中の人は起こさない
    const isJan = e.def.source === 'janitor';
    if (!isJan && e.mode !== 'working' && !(e.mode === 'idle' && !e.resting)) continue;
    if (isJan && e.action === 'walk') continue;
    e.onChimeBreak = true;
    e.say(t + 400 + Math.random() * 2200, pickFresh('chimebrk', CHIME_BREAK_TALK), 3200);
    const sp = pickRestSpot();
    if (sp) { e.resting = true; e.takeSpot(sp); }
    else e.goto({ x: 60 + Math.random() * 110, y: 246 + Math.random() * 20 }, 'faceD');   // 満席なら休憩室に立つ
  }
}

function stepChimeBreak(t) {
  if (!chimeBreak.until || t < chimeBreak.until) return;
  chimeBreak.until = 0;
  for (const e of employees) {
    if (!e.onChimeBreak) continue;
    e.onChimeBreak = false;
    e.releaseSpot();
    e.resting = false;
    e.nextThink = 0;
    if (e.present && e.mode === 'working') {
      e.say(t + 400 + Math.random() * 1500, pickFresh('chimeend', CHIME_BREAK_END), 2600);
      e.gotoWork();
    }
  }
}

/* ================================================================
   チャイム: 6:00〜22:00の2時間おき(JST正時)に鳴らす
   ================================================================ */
const chime = new Audio('assets/chime.mp3');
chime.volume = 0.55;
let chimeUnlocked = false;
let lastChimeKey = '';
document.addEventListener('click', () => {
  chime.muted = true;
  chime.play()
    .then(() => { chime.pause(); chime.currentTime = 0; })
    .catch(() => {})
    .then(() => { chime.muted = false; chimeUnlocked = true; });
}, { once: true });

setInterval(() => {
  const tm = jstNow();
  if (tm.m !== 0) return;
  if (tm.h < 6 || tm.h >= 22 || tm.h % 2 !== 0) return;   // 22:00は消灯なので鳴らさない
  const key = `${tm.h}`;
  if (lastChimeKey === key) return;
  lastChimeKey = key;
  chime.currentTime = 0;
  chime.play().catch(() => {});
  startChimeBreak(performance.now());   // 鐘が鳴ったら全員5分休憩
}, 5000);

// 直近24時間のミニ折れ線。欠測は線を切る(0で埋めると増減を捏造することになる)
function drawSpark(id, pick) {
  const c = document.getElementById(id);
  if (!c) return;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!hist || !hist.length) return;
  const from = Date.now() - 24 * 3600000;
  const pts = hist.filter(x => x.t >= from).map(x => ({ t: x.t, v: pick(x) }));
  const vals = pts.map(p => p.v).filter(v => v != null);
  if (vals.length < 2) return;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x0 = pts[0].t, xs = (Date.now() - x0) || 1;
  g.strokeStyle = '#6fae5f'; g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath();
  let drawing = false;
  for (const p of pts) {
    if (p.v == null) { drawing = false; continue; }
    const px = (p.t - x0) / xs * (c.width - 4) + 2;
    const py = c.height - 4 - (p.v - lo) / span * (c.height - 8);
    if (!drawing) { g.moveTo(px, py); drawing = true; } else g.lineTo(px, py);
  }
  g.stroke();
}

/* ---------- 新しいデプロイの取り込み ----------
   24時間つけっぱなしのモニターは一度読み込んだきりなので、deploy.sh を打っても
   誰かが手でリロードするまで永久に古いコードが動き続ける。
   app.js の ETag を見て、変わっていたら「場面が落ち着いているとき」に自分で読み直す。 */
let _deployTag = null;
async function checkDeploy() {
  try {
    const r = await fetch('app.js', { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return;
    const tag = r.headers.get('etag') || r.headers.get('last-modified');
    if (!tag) return;
    if (_deployTag == null) { _deployTag = tag; return; }
    if (tag === _deployTag) return;
    // 見せ場の途中でリロードしない(火災報知器・イベント・朝会・喧嘩・見回り・紙吹雪)
    const busy = panic.until || officeEvent.active || standup.active || fight.active
      || patrol.active || directive.active || chat.active || celebration.until > performance.now();
    if (busy) return;
    // reload だけだと Pages の max-age=600 が効いている間は古い app.js を再利用してしまう。
    // cache:'reload' で先にHTTPキャッシュを新しい実体で置き換えてからリロードする
    try { await Promise.all(['app.js', 'config.js'].map(f => fetch(f, { cache: 'reload' }))); } catch {}
    location.reload();
  } catch {}
}

/* ---------- 起動 ---------- */
(async () => {
  fitCanvas();
  try { await document.fonts.load('9px DotGothic16'); await document.fonts.load('13px DotGothic16'); } catch {}
  await poll();
  setInterval(poll, (CFG.pollSec || 60) * 1000);
  setInterval(updateHud, 10000);
  checkDeploy();
  setInterval(checkDeploy, 120000);
  pollHistory();
  setInterval(pollHistory, 900000);   // 15分毎。1回124KBなので頻繁に引かない
  requestAnimationFrame(t => { last = t; loop(t); });
})();
