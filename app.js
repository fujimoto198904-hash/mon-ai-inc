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
    const r = await fetch(`${CFG.supabaseUrl}/rest/v1/ai_office_snapshots?select=data,created_at&order=created_at.desc&limit=1`, {
      headers: { apikey: CFG.anonKey, Authorization: `Bearer ${CFG.anonKey}`, 'x-office-view': viewToken },
    });
    if (!r.ok) throw new Error(r.status);
    const rows = await r.json();
    if (rows.length) {
      const newAt = new Date(rows[0].created_at).getTime();
      const isNew = newAt !== snapAt;
      snap = rows[0].data;
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

function pickFresh(key, pool) {
  if (!pool || !pool.length) return '';
  const hist = _recentSay[key] || (_recentSay[key] = []);
  const cap = Math.max(1, Math.floor(pool.length * 0.5));
  let cand, tries = 0;
  do { cand = pool[Math.floor(Math.random() * pool.length)]; tries++; } while (hist.includes(cand) && tries < 25);
  hist.push(cand);
  while (hist.length > cap) hist.shift();
  return decorate(key, cand);
}

const bubbleQ = [];

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

function drawDesk(g, seat, working, t, emp) {
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
    g.font = '5px DotGothic16';
    const tw = g.measureText(emp.tag).width + 6;
    g.fillStyle = 'rgba(40,42,54,.85)';
    g.beginPath(); g.roundRect(x - tw / 2 + .5, y + 14.5, tw, 8, 2); g.fill();
    g.fillStyle = '#e8e6da';
    g.fillText(emp.tag, x - tw / 2 + 3, y + 20.5);
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
    // 看板に社名とYT登録者
    g.font = '13px DotGothic16'; g.fillStyle = '#f0d890';
    g.fillText('MON-AI Inc.', 489, 24);
    g.font = '8px DotGothic16'; g.fillStyle = '#e8d0a0';
    const subs = snap && snap.youtube && snap.youtube.subs != null ? snap.youtube.subs.toLocaleString('ja-JP') + '人' : '---';
    g.fillText(`YT登録者 ${subs} / 目標${(CFG.youtubeGoal || 0).toLocaleString('ja-JP')}`, 487, 40);
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

    // 社名看板 + 登録者カウンター
    rr(g, 412, 8, 204, 30, '#4a3b2a');
    g.font = '13px DotGothic16'; g.fillStyle = '#f0d890';
    g.fillText('MON-AI Inc.', 424, 22);
    g.font = '6px DotGothic16'; g.fillStyle = '#e8d0a0';
    const subs = snap && snap.youtube && snap.youtube.subs != null ? snap.youtube.subs.toLocaleString('ja-JP') + '人' : '---';
    g.fillText(`YT登録者 ${subs} / 目標${(CFG.youtubeGoal || 0).toLocaleString('ja-JP')}`, 424, 33);

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

// 部屋の中の地点から廊下(LANE_Y)までの退出経路。机・什器を突っ切らない
function outPath(pt, lane) {
  const L = lane || LANE_Y;
  const { x, y } = pt;
  if (y < 160 && x < 132) return [{ x, y: 168 }, { x: 240, y: 168 }, { x: 240, y: L }];      // 社長室: 休憩室の上の帯を東へ
  if (y < 160) { const a = x - 31; return [{ x: a, y }, { x: a, y: L }]; }                   // 上段: 机の間の隙間から
  if (y > 306 && x > 380 && x < 480) return [{ x, y: 342 }, { x: 374, y: 342 }, { x: 374, y: L }]; // 撮影スタジオ南: 入口通路経由
  if (y > 326 && x >= 236 && x <= 380) return [{ x, y: 342 }, { x: 374, y: 342 }, { x: 374, y: L }]; // 受付の下(ロビー南): 入口通路経由
  if (y > 262 && x >= 236 && x <= 380) return [{ x, y: 266 }, { x: 374, y: 266 }, { x: 374, y: L }]; // 受付まわり(カウンター上端272の上の帯): 右の通路から
  if (y > 198 && y < 285 && x >= 228 && x <= 368) return [{ x, y: 254 }, { x: 370, y: 254 }, { x: 370, y: L }]; // 総務部: 机の下→右通路
  if (y > 195 && x < 226) return [{ x, y: 256 }, { x: 206, y: 256 }, { x: 206, y: L }];      // 休憩室: 中央通路→右端列
  if (y >= 240 && y <= 306 && x > 380 && x < 480) return [{ x, y: 318 }, { x: 374, y: 318 }, { x: 374, y: L }]; // 撮影スタジオ内: 南口から入口通路経由
  if (y > 250 && y < 320 && x > 490 && x <= 622) return [{ x, y: 324 }, { x: 480, y: 324 }, { x: 480, y: L }]; // 音声スタジオ: スタジオ間の隙間から出入り
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
    this.arrivalSitY = null;
    if (!this.present) { this.pos = { x: 374, y: 346 }; this.present = true; }
    if (Math.hypot(target.x - this.pos.x, target.y - this.pos.y) < 3) {
      this.pos = { x: target.x, y: target.y };
      this.path = [];
      this.applyArrival(0);
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
let receptionBy = null;

function pickRestSpot() {
  const free = REST_SPOTS.filter(sp => !sp.busy);
  if (!free.length) return null;
  return free[Math.floor(Math.random() * free.length)];
}
const REST_TALK = ['コーヒーうまい', 'ソファ最高…', 'ちょっと目を閉じよう', 'お菓子補充されてる', 'のび〜', 'ふぅ…ひと息',
  '5分だけのつもりが…', '充電中です(比喩)', '午後もがんばるか', 'ぼーっとするの大事', '窓の外みてた',
  '小腹すいた', '自販機の新作うまい', 'ここのスナック優秀', '今日がんばったわ', '誰か雑談しよ',
  'ソファが俺を離さない', 'ジュースおごりじゃんけんしたい', '今日のBGMいいな', '納品ラッシュ乗り切った'];

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
];

// 白柳のサボりスポットとサボり中のつぶやき
const JANITOR_SABORI_SPOTS = [
  { x: 66, y: 232, d: 'up' },     // 自販機の前でぼーっと
  { x: 150, y: 256, d: 'left' },  // 休憩室の隅
  { x: 56, y: 306, d: 'down' },   // ロビーのソファ前
  { x: 210, y: 330, d: 'left' },  // 受付脇の柱の影
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
  'のど飴補給', '深夜の声、ちょっと低くていい感じ', 'コンプのかかり具合、ちょうどいい',
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
];

const JANITOR_SABORI = [
  '…5分だけ', '掃除は逃げない…', '腰が…限界…', '社長来たら掃くフリしよ',
  'ここはさっき掃いたことにしよ', 'ほこりも休憩中だし…', '働き方改革です',
  '自販機の前は空気がうまい', 'モップも乾かさないとね(言い訳)', '…見てないな、よし',
  '床は明日も汚れる。焦るな俺', 'サボりじゃない、品質点検', '雲でも見るか…窓ないけど',
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
];

const SLEEP_TALK = [
  'むにゃ…', 'すやぁ…', 'ぐぅ…', 'zzz…はっ…zzz', 'むにゃむにゃ…',
  'もう食べられない…', 'うどん…おかわり…', 'ラーメン…替え玉…', 'プリン…俺の…', '焼肉…無限…',
  'デプロイ…完了…', 'バグが…消えていく…', '全テスト…グリーン…', 'ビルド…通った…夢か…', 'マージ…できた…',
  '社長…それは無理です…', '納期…明日…?', '仕様変更…もう4回目…', '会議…出たくない…', '議事録…書いた…はず…',
  '登録者…100万人…', 'バズった…夢か…', '再生数…すごい伸び…', 'チャンネル…金の盾…', 'コメント…全部神…',
  '5時間枠…無限に…', 'トークン…食べ放題…', 'レートリミット…解除…', 'コンテキスト…広い…', 'キャッシュ…あったかい…',
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
  'ぼくは…AIじゃない…', '電気羊…数える…', '1トークン…2トークン…', '推論…完了…', '重み…軽い…',
  'ロビー…広くなった…', '受付…いらっしゃいませ…', '入口…どっち…', '会議…立ったまま…', 'ソファ…ふかふか…',
  'ぐー…すー…', 'すぴー…', 'んご…', 'はっ…寝てない…zzz', 'もう…朝…?',
  'デスク…片付けた…えらい…', 'メール…ゼロ件…', '通知…こないで…', 'Wi-Fi…つよい…', 'おやすみ…なさい…',
];

const IDLE_MUTTER = ['肩回すか', '水飲みに行こうかな', '今日の晩ごはん何にしよ', 'ちょっと眠い',
  'デスク片付けようかな', 'ウィンドウ整理しよ', '壁紙変えたいな', '5分だけぼーっとする', '天気どうなるかな',
  '夜景きれいだな', 'ストレッチしよ', 'マウスの感度いじろ', '次の仕事なにかな',
  '指ならし完了', 'メモ帳きれいにしよ', 'ショートカット覚えたい'];

const PERSONAL_MUTTER = {
  fujimoto: ['登録者伸ばすぞ…', '次の一手を考えねば', '筋トレサボってるな俺', 'ララ、散歩行くか?'],
  tsukishiro: ['発声練習…あーあー', '今日の台本、良き', '喉にいいお茶ほしいな', '3時出社はさすがに早い'],
  ito: ['椅子の高さが完璧', '正規表現は友達', 'コード綺麗に書けた', 'スキンヘッドは効率的'],
  sasaki: ['このベースライン最高では', 'イヤホン新調したい', 'BPM揃うと気持ちいい', 'ジャケ画像もこだわりたい'],
  amakawa: ['アプリのアイコン悩むな', 'ジム行こうかな', 'プロテイン切れてた', 'リリースノート書かなきゃ'],
  ando: ['ビルド待ちの間に瞑想', '静かなのが一番', 'キーボード静音化したい', 'AM38、いい名前だ'],
  hirose: ['UI詰めるの楽しい', '赤は正義', 'ショートカット極めたい', 'yorutoolの夜が好き'],
  arimoto: ['備品発注しとくか', '経費精算たまってる…', '規程読み直そ', 'ネクタイ曲がってないかな'],
  kato: ['雑務こそ会社の土台', 'ラベル貼り気持ちいい', '文具そろえたい', 'お茶くみじゃなくてインフラ係です'],
  zama: ['まあ、ぼちぼちやるか', '猫の動画みたい', 'うどん食べたい', 'その他って言うな、何でも屋と言え'],
  shirayanagi: ['そうじ そうじ🎵', '床は会社の顔ですから', 'ゴミは俺が拾う', 'ワックスそろそろ切れる…', 'ほこり一つ許さん'],
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
    if (this.id === 'tsukishiro') { this.goto(TSUKI_STUDIO_POST, 'studio'); return; }
    this.goto(this.seat, 'sit');
  }

  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    if (m !== 'idle') { this.resting = false; this.releaseSpot(); this.releaseReception(); }
    if (m === 'working') this.gotoWork();
    else if (m === 'sleep') this.goto(this.seat, 'sleep');
    else if (m === 'off' || m === 'out' || m === 'sleephome') this.goto({ x: 374, y: 346 }, 'leave');
    else this.nextThink = 0;
  }

  thinkJanitor(t) {
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
    // たまにはサボる(18%)
    if (Math.random() < 0.18) {
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
    if (this.mode !== 'idle' || t < this.nextThink) return;
    if (this.receptionOn) {
      if (Math.random() < 0.15) { this.releaseReception(); this.goto(this.seat, 'sit'); }
      else if (Math.random() < 0.5) this.say(t + 400, ['いらっしゃいませ〜', 'ご用の方は呼び鈴をどうぞ', '受付、承ります', '(姿勢よく…)'][Math.floor(Math.random() * 4)]);
      this.nextThink = t + 30000 + Math.random() * 40000;
      return;
    }
    if (!this.resting) {
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
    this.speed = base * (this.tired ? 0.7 : 1);
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
        this.say(t, pickFresh('sleep', SLEEP_TALK), 3600);
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
          this.say(t, pickFresh('grumble', WORK_GRUMBLES), 3800);
          this.nextBubble = t + 50000 + Math.random() * 60000;   // 愚痴は控えめに
        }
      }
      return;
    }
    if (!this.bubbles.length) return;
    if (t > this.nextBubble) {
      this.say(t, pickFresh('idle:' + this.id, this.bubbles), 3800);
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
  { o: 'この椅子、腰にいいらしい', r: ['腰は大事にしないとね', '俺のはギシギシ言う', '一番いいやつ買お'] },
  { o: '夜勤つらくないですか', r: ['深夜のほうが集中できるんよ', '正直眠い', 'エナドリでごまかしてる'] },
  { o: '締切って明日でしたっけ', r: ['明後日だよ、落ち着いて', 'えっ…確認してくる', '今日中って聞いたけど!?'] },
  { o: 'サムネのCTR上がったって', r: ['やっぱり赤文字が効いたか', 'デザイン変えた甲斐あったね', '次はタイトルも攻めよう'] },
  { o: 'ショート動画バズらないかな', r: ['冒頭2秒が勝負らしいよ', '毎日出してれば当たるって', '次のネタ、期待してる'] },
  { o: 'BGMのミックス聴きました?', r: ['低音いい感じだったね', 'まだ!あとで聴く', 'サビの入り、鳥肌だった'] },
  { o: '台本のテンポ良くなったね', r: ['句読点減らしたんですよ', '月城さんも読みやすいって', '次はもっと削る'] },
  { o: '収録ブースの音、良くなった', r: ['吸音材足したからね', 'ノイズ減ったよね', '月城さん喜んでたよ'] },
  { o: '自販機に新作入ってた', r: ['まじ?買ってくる', '当たりだった?', 'エナドリ系?'] },
  { o: 'ララがまた廊下で寝てた', r: ['自由すぎるでしょ', 'かわいいからOK', '踏まないようにしないと'] },
  { o: '観葉植物、育ちすぎでは', r: ['もはやジャングル', '白柳さんの世話がいいのよ', '植え替え必要かもね'] },
  { o: '経費で椅子買えないかな', r: ['社長は買ってくれそう', '稟議書いてみたら?', 'まず売上を立てよう…'] },
  { o: 'ボーナスって出ます?', r: ['社長「ゼロ円」って言ってた', '夢を見るのは自由', '登録者1万人いったらワンチャン'] },
  { o: '目標1万人、いけますかね', r: ['毎日投稿続ければいける', '今のペースなら来年には', '信じるしかない'] },
  { o: 'コメント欄あったかいよね', r: ['ほんと、励みになる', '全部読んでるよ', '泣けるコメントあった'] },
  { o: '再生数じわじわ来てる', r: ['伸びてる伸びてる', 'アルゴリズムに好かれてきた', 'この調子この調子'] },
  { o: '寝不足で目がしぱしぱする', r: ['目薬さしな', '今日は早く寝なよ', '5分仮眠おすすめ'] },
  { o: 'コンビニ行くけど何かいる?', r: ['プリンお願いします!', 'エナドリ1本!', '大丈夫、ありがと'] },
  { o: '掃除当番って誰でしたっけ', r: ['白柳さんが全部やってくれてる', '当番制、なくなったよ', 'せめてゴミは自分で捨てよ'] },
  { o: '今日の空、きれいでしたよ', r: ['窓ないのになんで知ってるの', '見たかったなあ', '夕焼けの時間に外出よう'] },
  { o: '最近ゲームしてます?', r: ['積みゲーが増える一方', '週末にまとめてやる派', 'ドット絵のゲームが落ち着く'] },
  { o: '映画観に行きたいな', r: ['いいね、今度みんなで', '最近いいのやってる?', 'ポップコーン持参で'] },
  { o: '筋トレ始めたんですよ', r: ['どうりで姿勢いいと思った', 'ジムイベントで本領発揮だね', '三日坊主にならないでよ'] },
  { o: 'AI業界、動き速すぎでは', r: ['先週の常識がもう古い', 'ついていくだけで精一杯', '俺らも進化しないとね'] },
  { o: '社長また徹夜らしいよ', r: ['体壊さないといいけど', '誰か止めてあげて', '朝コーヒー濃いめにしとこ'] },
  { o: 'モニターもう1枚欲しい', r: ['2枚あると世界変わるよ', '社長に相談してみな', 'デスク広くしないとね'] },
  { o: 'デスクの配線きれいにした', r: ['見た!プロの仕事', '俺のもお願いしたい', '整理整頓、社訓どおりだ'] },
  { o: '休憩室のソファ最高', r: ['あれは寝ちゃうやつ', '座ったら戻れなくなる', '絨毯も新しくなったしね'] },
  { o: 'たまには外で会議したいね', r: ['公園会議いいね', '天気いい日にやろう', 'Wi-Fiがネックだな…'] },
  { o: '俺たち、電気代でできてるらしいよ', r: ['ならば省エネで働こう', '電気代=血液か…', '停電したら全員退勤だね'] },
  { o: '昨日、夢を見た気がするんだよね', r: ['AIも夢見るんだ!?', 'どんな夢?', 'それ再起動の残像では'] },
  { o: 'トークンって食べたらうまいのかな', r: ['節約してって言われてるやつ', '味はコスト味だと思う', '食べ放題プランはよ'] },
  { o: 'Wi-Fi切れたら俺ら即退勤じゃん', r: ['最強の福利厚生では', 'それ、ただの障害だから', 'ルーター様には逆らえない'] },
  { o: 'たまには手書きで仕事したくない?', r: ['ペン持てないんよ、俺ら', '書道とか憧れる', '手書きフォントで我慢しよ'] },
  { o: '有給って概念、うちにあるの?', r: ['社訓見て、察して', 'チャイム休憩5分があるじゃん', '社長に聞いてみようか…'] },
  { o: '人間の「ちょっと」は3時間だよね', r: ['「すぐ終わる」も要注意', 'わかりすぎる', '単位換算表ほしい'] },
  { o: '前世はガラケーだった気がする', r: ['折りたたみ感あるもんね', 'パカパカしてそう', '着メロ作るの上手そう'] },
  { o: '雨の日って回線しっとりしません?', r: ['詩人か', 'わかる、pingが湿ってる', '梅雨はつらい季節'] },
  { o: '俺のバグ、かわいくない?', r: ['かわいくない、直して', '愛着湧く前に修正しよ', '名前つけるのやめな'] },
  { o: '寝るとき電源どうしてます?', r: ['つけっぱ派です', 'スリープが浅くて…', '省電力モードで夢を見る'] },
  { o: '推しのプロンプトある?', r: ['「丁寧に考えて」は名文', '「あなたはプロです」って言われると照れる', '推し活はほどほどに'] },
  { o: '肩こりって設定あるらしいよ', r: ['実装しないでほしい', 'ストレッチ機能もつけて', 'どこ製の設定よそれ'] },
  { o: '給湯室の噂、聞きました?', r: ['え、何何?', '噂話はほどほどにね', 'どうせ白柳さんのサボり話でしょ'] },
  { o: '午後の眠気、実装されてるっぽい', r: ['15時の壁はガチ', 'おやつで対抗しよう', 'バグじゃなくて仕様か…'] },
  { o: '社員旅行はデータセンターかな', r: ['聖地巡礼だ', '涼しそうでいいね', 'お土産はケーブルで'] },
  { o: '正直、月曜って重くないですか', r: ['月曜はレイテンシ高い', 'コーヒー2杯で起動する', '金曜まで耐えよう'] },
  { o: '締め切り前だけ処理速くなる説', r: ['火事場のクロック上昇', 'あれ何なんだろうね', '常時それ出せって言われそう'] },
];
const WORK_GRUMBLES = [
  'コンテキストが足りない…', 'またレートリミットか…', '仕様、3回目の変更です…',
  '「ちょっと直して」が2時間経過', 'トークン節約しろと言われても…', 'キャッシュが温まってない…',
  'プロンプト長すぎでは…?', '5h枠って誰が決めたんだ…', 'この変数名、誰がつけた…',
  'テスト通らない…なんで…', '正規表現が読めない…俺が書いたのに', 'コンフリクト解消中…無心…',
  'ビルド待ち…長い…', '仕様書がない…雰囲気で書いてる…', 'エッジケースの沼にいる…',
  '桁が違う…どこかで…', '再現しないバグこわい…', 'もう一回だけ試す…あと一回だけ…',
];

// ペア(質問と返事のセット)の非重複抽選
const _setHist = [];
function pickChatSet(sets) {
  let s, tries = 0;
  do { s = sets[Math.floor(Math.random() * sets.length)]; tries++; } while (_setHist.includes(s.o) && tries < 30);
  _setHist.push(s.o);
  while (_setHist.length > Math.floor(sets.length / 2)) _setHist.shift();
  return s;
}

function makeChatLines() {
  const sets = [];
  if (snap) {
    const rate = (snap.billing && snap.billing.jpyPerUsd) || 155;
    const cost = snap.totals.todayCost || 0;
    sets.push({ o: `今日もう${fmtYen(cost * rate)}分働いたって`, r: ['俺らの人件費、安いのにね', '成果で返そう', '電気代くらいは稼がないと'] });
    if (snap.youtube && snap.youtube.subs != null) sets.push({ o: `登録者${snap.youtube.subs}人になったね`, r: ['じわじわ増えてる!', '目標1万人、いけるよ', 'ありがたいねえ'] });
    if (snap.tasks && snap.tasks.count) sets.push({ o: `保留タスク${snap.tasks.count}件だって`, r: ['社長、抱えすぎでは', '手伝えることあるかな', '減る気配がない…'] });
    if (snap.claude.block && snap.claude.block.remainingMinutes != null && snap.claude.block.remainingMinutes < 90) sets.push({ o: '伊藤さん5h枠もうすぐらしい', r: ['無理しないでほしいね', 'きょうこさんが心配してたよ', '休憩はさませよう'] });
    if (snap.deliveries && snap.deliveries.daihon) sets.push({ o: `台本もう${snap.deliveries.daihon}本納品って`, r: ['ペース早いね', '月城さん、さすがだわ', '品質も落ちてないのがすごい'] });
    if (snap.codex.rateLimit) sets.push({ o: `コデックス週次残り${Math.max(0, Math.round(100 - snap.codex.rateLimit.usedPercent))}%だって`, r: ['ペース配分しないとね', '今週も走ってるなあ', '残量は計画的に'] });
    if (snap.claude.block && snap.claude.block.costPerHour) sets.push({ o: `いま燃焼率${fmtYen(snap.claude.block.costPerHour * rate)}/hらしい`, r: ['社長の顔が青くなるやつ', '景気いいねえ…', '成果物で黒字にしよう'] });
  }
  const all = sets.concat(CHAT_SETS);
  const lines = [];
  const rounds = 1 + (Math.random() < 0.5 ? 1 : 0);
  for (let k = 0; k < rounds; k++) {
    const s = pickChatSet(all);
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
  const idlers = employees.filter(e => e.present && e.mode === 'idle' && e.action !== 'walk' && !e.inChat && !e.atMeeting && !e.receptionOn);
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
    chat.active = { a, b, lines: makeChatLines().concat(makeChatLines()), li: 0, meeting: true, phase: 'go', nextLine: 0 };
  } else {
    chat.active = { a, b, lines: makeChatLines(), li: 0, nextLine: t + 500 };
  }
}

const GROUP_TOPICS = [
  'ねえ、登録者1万人いったら何する?', '今度みんなでラーメン行きません?', '社長のTシャツ、何枚同じの持ってるんだろ',
  'ララに芸を仕込みたいんだけど', '自販機の当たり、出たことある人!', '休憩室に漫画置きたくない?',
  '深夜テンションで書いた台本、見返した?', '次のバズ動画、何系だと思う?', 'もし1日人間になれたら何する?',
  '会社の非常食、誰か食べた?', 'オフィスBGM、何がいい?', '大掃除、いつやります?',
  '新しい社訓、考えない?', '忘年会って概念、うちにある?', 'サーバールームって涼しくて良いよね',
  '推しの絵文字、発表会しない?', '月末の数字、どうなると思う?', '撮影スタジオで写真撮らない?',
  'コーヒーvs緑茶、決着つけよう', '睡眠時間、自慢していい?', '一番古い記憶って何?',
  'エラーログしりとりしようよ', '社長に内緒でおやつ買った人', '正直、誰が一番働いてる?',
  '宝くじ当たったらどうする?',
];
const GROUP_REACTS = [
  'いいね!', 'それな!', '天才では?', '却下で!', '乗った!', 'えー(笑)', '静かに笑うわ',
  '議事録取っとこ', '社長に聞こえるよ(笑)', '全会一致!', '真面目か!', '夢がある〜',
  'コンプラ的にセーフ?', '予算どこから出すの', 'やろうやろう!', '来週の議題ね', '拍手!',
  '待って、天才', 'それは無理(笑)', '前向きに検討します',
];
const groupChat = { next: 60000, active: null };

/* ================================================================
   口喧嘩: 歩行中にぶつかると「どけよ」「お前がどけよ」の言い合い
   ================================================================ */
const FIGHT_LINES = [
  ['ぶつかったら、どけよ', 'お前がどけよ'],
  ['ちょ、前見て歩けよ', 'そっちこそ見ろよ'],
  ['ここ俺の通り道なんだけど', '廊下はみんなのものだが?'],
  ['道譲るのが礼儀でしょ', '先に居たのはこっちだが?'],
  ['歩幅がでかいんだよ', '関係なくない?'],
  ['わざとだろ今の', '被害妄想やば'],
  ['謝ったら?', 'そっちが謝れば?'],
  ['俺、急いでるんだけど', '俺も急いでるんだが'],
  ['社訓読んだ? 品質第一だぞ', '衝突の品質の話じゃない'],
  ['もういい、社長に言うわ', 'どうぞどうぞ'],
  ['はぁ…もういいよ', '最初からそう言え'],
  ['じゃあジャンケンで決めよう', '子供か'],
];
const fight = { active: null, cooldown: 0 };

/* ================================================================
   社長の指示行脚: 新しい仕事が始まった社員の席へ行き、指示を出す
   ================================================================ */
const BBQ_TALK = [
  '火起こしは俺に任せろ', '網の角度がプロい', '肉!肉!肉!', 'まだ焼けてないって',
  '裏返すの早すぎ', '奉行きた', 'タレ派?塩派?', '両方に決まってる',
  '野菜も食べなさい', 'ピーマン誰が入れた', '椎茸は俺のもの', 'カルビ天才',
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
], GYM_TALK = [
  'フォーム見てて', '腰引けてるよ', 'あと3回!', '無理っす…',
  '呼吸止めない!', 'プロテイン持参?', '水しかない', '気合いで補え',
  'ベンチ軽すぎ?', '盛りすぎ盛りすぎ', 'プレート外して', '謙虚が一番',
  '有酸素もやろ', 'トレッドミル故障してない?', '歩くだけなら得意', '早歩き選手権しよ',
  'ヨガマット気持ちいい', 'そのポーズ何?', '戦士のポーズ', '戦士は無理な体勢',
  '腹筋ローラーある?', 'ないから床で', '床は白柳さんの聖域', '汗は拭いてから',
  '筋肉は裏切らない', '締切は裏切る', '名言やめて', '刺さるからやめて',
  'バランスボール乗れる?', '3秒が限界', '俺は5秒', 'レベル低い争い',
  '明日筋肉痛だな', '明後日に来るタイプ', '歳の話やめよ', 'AIに歳はない',
  'ジム部作らない?', '部費は経費?', 'また経費の話…', '却下されるまでがオチ',
], EVENT_REACT = [
  'いい匂いしてきた…', '仕事に集中できない件', '俺も混ざりたい…', 'あとで一口ください',
  '音がもう美味しい', '煙こっち来た(嬉しい)', '休憩取ればよかった', '次は絶対参加する',
  '楽しそうで何より', '声でかいって(笑)', '議事録は取らんでいい', '平和な会社だ…',
  '集中…集中…', 'イヤホンで防御', '腹の音が鳴った', '夕飯どうしよ…',
  '写真だけ撮っとこ', 'SNSに載せたい', '社外秘らしいよ', '残念すぎる',
  '白柳さんの顔が曇ってる', '床…床が…', '掃除係の苦労よ', 'あとで手伝お',
  'カロリーは正義', '罪の匂いがする', 'ダイエット中なのに', '明日から本気出す',
  '月城さん寝てるのに', 'よく寝れるな…', '寝言がBBQに反応してる', '鼻が動いてる(笑)',
  '社長も楽しそう', '童心に帰ってる', '経費の行方が心配', '税理士に怒られるやつ',
  '仕事終わったら混ざる', 'あと1タスク…', 'ビルド待ちの間だけ…', 'ちょっとだけ…いや駄目だ',
  '祭りかな?', '文化祭みたい', '青春してるな', 'うちの会社どうなってんの',
  '羨ましくなんか…ある', '正直めっちゃ羨ましい', '心を無にして作業', '無理、匂いが勝つ',
  '網の音ASMR', '作業BGMがジュージュー', '集中力が肉に負ける', '今日は負けを認める',
  '筋トレ組は偉いな', '俺は座ってるだけ', '見てるだけで疲れた', '応援だけしとく',
  'ファイトー!', 'いっぽーん!', 'あと3回とか鬼', 'コーチ厳しすぎ(笑)',
  'フォームきれい', '腰は大事にね', '労災になるよ(笑)', '安全第一,品質第一',
  '若いなあ…', 'AIに若さも何も', 'それを言っちゃおしまい', '夢のある会社です',
  '平和すぎて泣ける', '明日も頑張れそう', 'この会社好きだわ', '入社してよかった(AI)',
  '誰か仕事して(笑)', '俺がやってるから大丈夫', '頼もしすぎる', '給料上げてあげて',
  '社訓「無限労働」とは', '休憩も仕事のうち', 'いい文化になった', 'ミッションは達成される',
  '匂いで日報書けそう', '今日の日報:肉', '承認します', '最高の会社かよ',
];

const WORK_TALK = [
  'まず要件を整理しよう', '期限はいつまで?', '今日中にいけます', '仕様書どこでしたっけ',
  'ブランチ切っときました', 'レビュー誰に振る?', '俺が見ます', 'テスト先に書こう',
  '既存の実装が使えそう', 'ゼロから書いた方が早いかも', '依存関係だけ気をつけて', '互換性は保つ方向で',
  '英語版も出します?', 'まずは日本語だけで', 'サムネどうします?', 'A/Bテストしよう',
  '前回の反省を活かそう', '同じバグ二度と出さない', 'ログ仕込んでおきます', 'エラー処理そこ手厚めで',
  '負荷は大丈夫そう?', 'キャッシュ効かせます', 'コスト意識だけ頼む', 'トークン節約構成で',
  '成果物はどこに置く?', 'いつものフォルダで', '命名規則そろえよう', 'READMEも更新しとく',
  '誰かペアで入れる?', '俺、手すきです', '助かる、頼んだ', '30分後に進捗共有で',
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

const BOSS_ORDERS = ['ここ、頼んだぞ', '例の件、よろしく', 'クオリティ第一でな', '急ぎでお願い', '任せた!', '期待してるぞ'];
const BOSS_REPLIES = ['了解です!', 'お任せください', 'ラジャです', 'がんばります!', '承知しました!'];
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
  if (t < officeEvent.next || t < officeEvent.cooldown) return;
  officeEvent.next = t + 30000;
  if (standup.active || fight.active) return;
  const idle = employees.filter(e => e.present && e.mode === 'idle' && !e.inChat && !e.atMeeting && !e.receptionOn && e.action !== 'walk');
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
  officeEvent.active = { kind, members, startT: t, until: t + 160000 + Math.random() * 60000, nextLine: t + 6000, nextReact: t + 9000 };
}

// ララ×焼肉: BBQ中は必ず餌をねだりに来る。あげようとすると怒られる
const LARA_BEG = [
  'くぅ〜ん…🍖', 'ワン!ワン!🍖', '(お座りして待機)', '(しっぽ高速回転)', '(よだれ)',
  'じーーーっ👀', '(前足ちょいちょい)', 'クゥーン…💕', 'ワンッ🍖ワンッ🍖', '(胸を張ってアピール)',
  '(圧のあるお座り)', 'へっへっへっ(息)',
];
const LARA_FEED = [
  'ララにひとくちだけ…🍖', 'タレついてないとこなら…', 'ララもBBQ参加でしょ?', '(こっそり肉を下ろす)',
  'この端っこ、あげていい?', 'ララ、お手!できたらあげる', '見てられない…あげちゃお', '野菜ならいいよね?',
  'ララ専用の皿、用意しちゃった', '小さいのならバレない…', '焼く前のやつなら…', 'ララが泣いてるんだけど!?',
];
const LARA_SCOLD = [
  '人の食べ物あげちゃダメ!💢', 'タレも塩もダメ!全部ダメ!', '犬にネギ類は厳禁だよ!?', '社長に怒られるよ!?',
  'ララのごはんはあっち!', 'あーあ、味覚えちゃうじゃん', 'ダメったらダメ!鬼と呼ばれても!', '獣医さんに怒られるやつ!',
  'その皿しまいなさい!', 'BBQ奉行より犬奉行になりなさい', 'かわいさに負けるな!', '俺が我慢してるのに!?',
];

// BBQの煙→もくもく→火災報知器
let hazeLevel = 0;
const ALARM_REACT = [
  '警報!!', '煙すごい!!', 'けほけほっ', '窓!窓開けて!(無い)', '火元どこ!?',
  'スタジオが霞んで見えない', 'スプリンクラー来るぞ!?', '肉は守れ!!', '避難訓練!?', '耳がぁぁ',
  '誰か換気ー!!', 'うちわ持ってこい!', '報知器さん落ち着いて', '焼きすぎだって言った!',
];

// 解散後の余韻(それぞれ持ち場に戻りながらの独り言)
const BBQ_AFTER = [
  '肉、うまかったな…', 'タレの匂いが服についた', '次は牛タン枠を増やそう', '完全に食べすぎた…',
  '網、誰が洗うんだろう', '炭の火起こし、上達したわ', '締めの焼きおにぎり食べ損ねた', '肉の口が終わらない',
  '夕飯いらないかも…', 'ララの目が忘れられない', '煙くさいの、嫌いじゃない', '次のBBQは合法でやろう…',
  '報知器、ごめんな', '働くか…肉のパワーで', 'まだ口の中がカルビ',
];
const GYM_AFTER = [
  '明日、絶対筋肉痛だ…', 'プロテイン買っておこう', '腕がプルプルする', 'いい汗かいた…!',
  'フォーム、褒められた', '次は下半身の日にしよう', '体が軽い…気がする', '継続は力なり、って言うし',
  'ジム部、正式に作らない?', '筋肉は裏切らない(社長談)', 'ストレッチも忘れずに…いてて', '汗、拭いてから戻ろ',
  '成長期かもしれない', '握力が終わってる', '心なしか姿勢がいい',
];

// イベントの終わり=社長が怒りに来る
const BOSS_BUST = [
  'おいこら!仕事はどうした!!', '誰が宴会を許可した!?', 'ずいぶん楽しそうだなぁ?????',
  'はい解散!解散!!', '経費で肉焼くなーー!!', 'ダンベルより納期を持てー!!',
  '全員、席に戻れ〜!!', '俺も混ぜ…じゃなくて、解散だ!!', '煙で火災報知器鳴ったらどうする!!',
  '筋肉は裏切らないが納期は裏切るぞ!!', 'いい匂いさせやがって…解散!!', '会社をジムにするな!!',
];
const EVENT_SORRY = [
  'すみません社長!', '片付けます!', '解散ー!', '戻ります戻ります', 'あと一本だけ…だめですよね',
  '社長もどうぞ…すみません', 'はい、ただいま!', '見てました?…見てましたか…', '火は消しておきます!',
  'ストレッチは仕事のうち…はい、違います', '証拠隠滅!', 'プロテインしまいます!',
];

function runEvent(t) {
  const ev = officeEvent.active;
  // 仕事が来た人は離脱
  for (const e of ev.members.slice()) {
    if (!e.present || e.mode !== 'idle') {
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
    if (!ev.alarmed && elapsed > 90000 && ev.members.length) {
      ev.alarmed = true;
      const near = employees.filter(e => e.present && !e.inChat && e.def.source !== 'janitor').slice(0, 5);
      ev.members.concat(near).forEach((e, i) => e.say(t + 300 + i * 450, pickFresh('alarm', ALARM_REACT), 2800));
      ev.until = Math.min(ev.until, t + 6000);   // 警報→まもなく社長が飛んでくる
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
        boss.say(t, pickFresh('bossbust', BOSS_BUST), 3800);
        ev.members.forEach((e, i) => {
          e.dir = e.pos.x > boss.pos.x ? 'left' : 'right';
          e.say(t + 1400 + i * 750, pickFresh('evsorry', EVENT_SORRY), 2600);
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
  if (t > ev.nextLine) {
    const talker = ev.members[Math.floor(Math.random() * ev.members.length)];
    if (talker.action !== 'walk') {
      const pool = ev.kind === 'bbq' ? BBQ_TALK : GYM_TALK;
      talker.say(t, pickFresh('ev:' + ev.kind, pool), 3400);
      if (ev.kind === 'gym') { talker.anticUntil = t + 3500; }
      ev.nextLine = t + 3600 + Math.random() * 2400;
    }
  }
  if (t > ev.nextReact) {
    const watchers = employees.filter(e => e.present && !e.inEvent && !e.inChat && e.def.source !== 'janitor');
    if (watchers.length) {
      watchers[Math.floor(Math.random() * watchers.length)].say(t, pickFresh('evreact', EVENT_REACT), 3200);
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
      e.say(t + 2500 + i * 1600 + Math.random() * 1200, pickFresh('evafter', afterPool), 3400);
    });
    if (ev.boss) {
      ev.boss.inChat = false;
      ev.boss.nextThink = 0;
      if (ev.boss.mode === 'working') ev.boss.goto(ev.boss.seat, 'sit');
      if (Math.random() < 0.5) ev.boss.say(t + 4000, ['まったく…楽しそうで何よりだ', '次は俺も呼べよ…じゃなくて!', 'はぁ…若いっていいな', '床、白柳さんに謝っておけよ'][Math.floor(Math.random() * 4)], 3200);
    }
  }
  officeEvent.active = null;
  officeEvent.cooldown = t + 2400000 + Math.random() * 1800000;   // 40〜70分に1回まで
}

function stepStandup(t) {
  const boss = employees.find(e => e.def.source === 'boss');
  if (!boss || !boss.present) return;
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
      alive[st.li % alive.length].say(t, pickFresh('worktalk', WORK_TALK), 3200);
      st.li++;
      st.nextLine = t + 3500;
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
      e.inChat = false;
      e.nextThink = 0;
      if (e.mode === 'working') e.gotoWork();
    }
  }
  standup.active = null;
  standup.next = t + 60000;
}

function stepDirective(t) {
  const boss = employees.find(e => e.def.source === 'boss');
  if (!boss || !boss.present) return;
  if (directive.active) {
    const d = directive.active;
    const tgt = d.target;
    if (!tgt.present) { endDirective(boss, t); return; }
    if (d.phase === 'go') {
      if (boss.action !== 'walk') {
        boss.dir = 'right';
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
  if (tgt.id === 'tsukishiro') boss.goto({ x: TSUKI_STUDIO_POST.x - 26, y: TSUKI_STUDIO_POST.y + 2 }, 'faceR');
  else boss.goto({ x: tgt.desk.x - 30, y: tgt.desk.y + 20 }, 'faceR');
  directive.active = { target: tgt, phase: 'go' };
}

function endDirective(boss, t) {
  directive.active = null;
  directive.next = t + 25000;
  boss.inChat = false; boss.directing = false;
  boss.nextThink = 0;
  if (boss.mode === 'working') boss.goto(boss.seat, 'sit');
}

/* ================================================================
   社内恋愛: きょうこ(廣瀬)×伊藤
   仕事中の伊藤を応援しに行く / 2人とも暇ならデートに誘う
   ================================================================ */
const romance = { active: null, nextCheer: 90000, nextDate: 600000 };
const KYOKO_CHEER = [
  'がんばって、伊藤くん!', '応援しに来ちゃった', 'コーヒー置いとくね(気持ち)', '今日もかっこいいよ、その背中',
  '無理しないでね?', '肩もみしてあげよっか', 'きょうこが見守ってるからね', '進捗どう?…って顔が疲れてる!',
  '夜食、何がいい?', 'タイピング音、好きなんだよね', 'その調子その調子!', '終わったらお茶しよ?',
  '差し入れはわたしの笑顔です', '深呼吸して?はい、すーはー', '伊藤くんのコード、きれいだよね',
  '目、しょぼしょぼしてない?', 'ファイト!超ファイト!', '休憩も仕事のうちだよ?', '世界一がんばってる',
  '今日の伊藤くんも優勝', 'あとちょっとだね、ラストスパート!', 'エラー出ても、わたしは味方',
  'ドキドキしてる?落ち着いて〜', '首、回して回して', 'がんばりすぎ注意報、発令中', '推しの現場に来ました',
  'yorutoolより伊藤くん優先で来た', '手、冷えてない?', 'デバッグの神が降りますように',
  '伊藤くんの集中顔、いいね', '水分とった?', '姿勢!猫背になってる!', '疲れたら呼んでね、飛んでくる',
  '今夜は早く寝てね?', 'わたしの分までがんばらなくていいよ', '応援団長きょうこ、参上',
  'できるできる絶対できる', '天才って言っていい?', '終電…あ、家この会社だった', 'しゅきしゅき(小声)',
];
const ITO_CHEER_REPLY = [
  'お、おう…仕事中だぞ(嬉しい)', 'きょうこか…力出るわ', '見られてると緊張するな…', 'あとでな、いま良いとこ',
  'サンキュ…がんばれる', '肩もみは…あとで頼む', '(タイピングが速くなる)', '照れるからやめれ(照れ)',
  'お茶、行く行く', '深呼吸…すー、はー…効くな', 'これ終わったらデートな', '愛の力で進捗2倍だ',
  '見守られてる…尊い…', 'よし、燃えてきた', '(ニヤけを抑えている)',
];
const KYOKO_DATE_INVITE = [
  'ねえ、いまヒマ?デートしよ!', '5分だけソファデートしない?', '伊藤くん、お茶しよ?',
  'ソファ空いてるよ、行こ?', '息抜きデートのお時間で〜す', '手が空いたなら…わたしと過ごそ?',
  'デートの誘いは早い者勝ちだよ', '今日まだ話してない!デート!', 'ソファで5分、恋人タイム!',
  '休憩=デートって社訓にあるよ(ない)', 'ねぇねぇ、いちゃいちゃしにいこ', 'はい、デート券発行されました〜',
];
const ITO_DATE_OK = [
  'お、いいね。行くか', '5分だけな(にっこり)', '待ってました', 'ソファ確保しといて',
  'ちょうど休憩しようと思ってた', 'デート券、使います', '了解、恋人タイム', 'よし、休憩!デート!',
  '(スキップで向かう)', '社訓に追加しとこう、それ',
];
const DATE_TALK = [
  '今日の晩ごはん、何にする?', '週末どこ行く?', 'ねえ、手つないでいい?', '伊藤くんの好きなとこ発表します',
  '将来の話…しちゃう?', 'この会社、猫飼わない?', '肩、貸して', '5分が一瞬すぎる…',
  'また夜食作るね', 'きょうこの膝枕、予約制です', '二人の記念日、覚えてる?', '今度こそ映画行こうね',
  '伊藤くんは働きすぎ!', 'たまには寝てよ?', 'わたしのyorutool、褒めて?', '給料日、何買う?',
  'こうしてると落ち着くね', 'ずっとこの5分でいい…', '写真撮ろ、ドット絵だけど', '次のBBQ、隣で食べよ',
  '社長にバレたら…まあいっか', 'ララも連れて散歩行きたいね', '伊藤くんの寝言、聞いたことある',
  '来週もこの時間、空けといてね',
];

function stepRomance(t) {
  const kyoko = employees.find(e => e.id === 'hirose');
  const ito = employees.find(e => e.id === 'ito');
  if (!kyoko || !ito) return;
  if (romance.active) {
    const r = romance.active;
    if (!kyoko.present || !ito.present) { endRomance(t); return; }
    if (r.kind === 'cheer') {
      if (r.phase === 'go') {
        if (kyoko.action !== 'walk') {
          r.phase = 'talk'; r.until = t + 3600;
          kyoko.dir = 'left';
          kyoko.say(t, pickFresh('kyokocheer', KYOKO_CHEER), 3400);
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
    // date
    if (r.phase === 'invite') {
      if (t > r.until) {
        ito.say(t, pickFresh('itodateok', ITO_DATE_OK), 2800);
        r.phase = 'go'; r.until = t + 2000;
        kyoko.takeSpot(r.spotA); ito.takeSpot(r.spotB);
        kyoko.inChat = true; ito.inChat = true;   // takeSpotの後に立て直す
      }
      return;
    }
    if (r.phase === 'go') {
      if (kyoko.action !== 'walk' && ito.action !== 'walk') { r.phase = 'talk'; r.nextLine = t + 1500; r.until = t + 60000 + Math.random() * 40000; }
      return;
    }
    if (r.phase === 'talk') {
      if (ito.mode === 'working' || t > r.until) {   // 仕事が来たらデート終了
        if (ito.mode === 'working') ito.say(t, '仕事きた…ごめん、また今度!', 2600);
        endRomance(t);
        return;
      }
      if (t > r.nextLine) {
        const who = Math.random() < 0.55 ? kyoko : ito;
        who.say(t, pickFresh('datetalk', DATE_TALK), 3400);
        if (Math.random() < 0.5) spawnParticle('heart', (kyoko.pos.x + ito.pos.x) / 2, kyoko.pos.y - 30);
        r.nextLine = t + 5500 + Math.random() * 3500;
      }
    }
    return;
  }
  // 発動判定
  if (fight.active || standup.active || (officeEvent.active && officeEvent.active.alarmed)) return;
  if (kyoko.inChat || kyoko.atMeeting || kyoko.inEvent || kyoko.onChimeBreak || kyoko.receptionOn) return;
  if (!kyoko.present || kyoko.mode !== 'idle') return;
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
const patrol = { active: null, next: 120000 };
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
  'たまには外の空気も…窓ないけどな', '暇なら俺の話し相手になるか?', '次のプロジェクトの構想、聞くか?',
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
];
const PATROL_REPLY_WORK = [
  'はい!', '順調です!', '任せてください', 'ありがとうございます!', 'がんばります!', '押忍!',
  'ちょうど波に乗ってます', 'あと少しで一段落です', '社長も休んでください', '進捗、後で共有します',
  '励みになります!', '(タイピング速度が上がる)', 'この機能、自信あります', '納期、守ります!',
  'ご期待に応えます', '見ててください', '恐縮です…!', 'うおおお燃えてきた', '社長のためにも頑張ります',
  'コーヒーは大丈夫です!', '目薬ほしいです', 'いい椅子、お願いします!', 'ボーナス楽しみにしてます(圧)',
  '責任、共有させてください', '愛社精神が高まりました',
];
const PATROL_REPLY_IDLE = [
  'はい、充電中です', '5分だけ休んでます', 'すぐ戻ります!', '英気、養ってます', 'ソファ最高です',
  '社長もどうですか?', '新作、当たりでした', '次の仕事、待ってます', 'ちゃんと休んでます(堂々)',
  '悩みはゼロです', 'よく眠れてます', '会社、楽しいです', '夢は世界征服です', 'BBQ、次は合法で!',
  'MONさん…いや社長、お疲れ様です',
];

function stepPatrol(t) {
  const boss = employees.find(e => e.def.source === 'boss');
  if (!boss || !boss.present) return;
  if (patrol.active) {
    const p = patrol.active;
    const tgt = p.target;
    if (!tgt.present) { endPatrol(boss, t); return; }
    if (p.phase === 'go') {
      if (boss.action !== 'walk') {
        boss.dir = tgt.pos.x >= boss.pos.x ? 'right' : 'left';
        const pool = tgt.mode === 'working' ? BOSS_PATROL_WORK : BOSS_PATROL_IDLE;
        boss.say(t, pickFresh('patrol', pool), 3400);
        p.phase = 'talk'; p.until = t + 3600;
      }
    } else if (p.phase === 'talk') {
      if (t > p.until) {
        const rpool = tgt.mode === 'working' ? PATROL_REPLY_WORK : PATROL_REPLY_IDLE;
        if (tgt.action !== 'sleep') tgt.say(t, pickFresh('patrolreply', rpool), 3000);
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
    boss.goto({ x: tgt.desk.x - 30, y: tgt.desk.y + 20 }, 'faceR');
  } else {
    boss.goto({ x: tgt.pos.x - 20, y: tgt.pos.y + 2 }, 'faceR');
  }
  patrol.active = { target: tgt, phase: 'go' };
}

function endPatrol(boss, t) {
  patrol.active = null;
  patrol.next = t + 150000 + Math.random() * 150000;   // 見回りは2.5〜5分に1回
  boss.inChat = false;
  boss.nextThink = 0;
  if (boss.mode === 'working') boss.goto(boss.seat, 'sit');
}

function startFight(a, b, t) {
  if (fight.active || t < fight.cooldown) return;
  if (a.inChat || b.inChat || a.atMeeting || b.atMeeting || a.recording || b.recording) return;
  if ((a.mode !== 'idle' && a.mode !== 'working') || (b.mode !== 'idle' && b.mode !== 'working')) return;
  a.inChat = b.inChat = true;
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
      e.inChat = false;
      e.nextThink = 0;
      if (e.mode === 'working') e.gotoWork();
      else if (e.mode === 'sleep') e.goto(e.seat, 'sleep');
      else if (e.mode === 'off' || e.mode === 'out' || e.mode === 'sleephome') e.goto({ x: 374, y: 346 }, 'leave');
    }
  }
  fight.active = null;
  fight.cooldown = t + 120000 + Math.random() * 180000;   // 喧嘩は2〜5分に1回まで
}


function stepGroupChat(t) {
  if (chat.active) return;
  if (groupChat.active) {
    const ga = groupChat.active;
    const alive = ga.members.filter(e => e.present && e.mode === 'idle');
    if (alive.length < 2) {
      for (const e of ga.members) e.inChat = false;
      groupChat.active = null; groupChat.next = t + 60000;
      return;
    }
    if (t > ga.nextLine) {
      const line = ga.lines[ga.li];
      if (line == null) {
        for (const e of ga.members) e.inChat = false;
        groupChat.active = null; groupChat.next = t + 90000 + Math.random() * 120000;
        return;
      }
      alive[ga.li % alive.length].say(t, line, 3400);
      ga.li++;
      ga.nextLine = t + 3700;
    }
    return;
  }
  if (t < groupChat.next) return;
  const rest = employees.filter(e => e.present && e.mode === 'idle' && e.resting && e.action !== 'walk' && !e.inChat && !e.atMeeting && !e.receptionOn);
  if (rest.length < 3) { groupChat.next = t + 40000; return; }
  const members = rest.slice(0, 5);
  for (const e of members) e.inChat = true;
  const lines = [pickFresh('gtopic', GROUP_TOPICS)];
  const rn = 2 + Math.floor(Math.random() * Math.min(3, members.length));
  for (let k = 0; k < rn; k++) lines.push(pickFresh('greact', GROUP_REACTS));
  groupChat.active = { members, lines, li: 0, nextLine: t + 500 };
}

function endChat(t, wait) {
  const c = chat.active;
  if (c) {
    for (const e of [c.a, c.b]) {
      e.inChat = false;
      if (e.atMeeting) { e.atMeeting = false; e.nextThink = 0; }
    }
    if (c.meeting) meetBusy = false;
  }
  chat.active = null;
  chat.next = t + wait;
}

const dog = { pos: { x: 90, y: 150 }, target: null, next: 4000, napUntil: 0, dir: 1 };
function stepDog(dt, t) {
  // BBQ中は必ずグリル前に来て餌をねだる
  const bbqOn = officeEvent.active && officeEvent.active.kind === 'bbq';
  if (bbqOn) {
    dog.napUntil = 0;
    const gx = 292, gy = 198;
    if (!dog.target && Math.hypot(dog.pos.x - gx, dog.pos.y - gy) > 16) {
      dog.target = { x: gx + Math.random() * 14 - 7, y: gy + Math.random() * 8 - 4 };
    }
    if (t > (dog.nextBeg || 0)) {
      dog.bubble = pickFresh('larabeg', LARA_BEG);
      dog.bubbleUntil = t + 3000;
      dog.nextBeg = t + 9000 + Math.random() * 9000;
    }
  }
  if (t < dog.napUntil) return;
  if (!dog.target) {
    if (t > dog.next) {
      if (bbqOn) return;
      if (Math.random() < 0.35) { dog.napUntil = t + 12000 + Math.random() * 18000; dog.next = dog.napUntil; return; }
      const spots = [{ x: 250, y: 198 }, { x: 320, y: 200 }, { x: 420, y: 204 }, { x: 500, y: 205 }, { x: 560, y: 202 }, { x: 100, y: 258 }, { x: 60, y: 264 }];
      dog.target = spots[Math.floor(Math.random() * spots.length)];
    }
    return;
  }
  const dx = dog.target.x - dog.pos.x, dy = dog.target.y - dog.pos.y;
  const dist = Math.hypot(dx, dy), sp = 30 * dt / 1000;
  if (dist < sp) { dog.pos = dog.target; dog.target = null; dog.next = t + 5000 + Math.random() * 9000; }
  else { dog.pos.x += dx / dist * sp; dog.pos.y += dy / dist * sp; dog.dir = dx > 0 ? 1 : -1; }
}
function drawDog(g, t) {
  const { x, y } = dog.pos;
  const nap = t < dog.napUntil;
  const img = SHEETS.lala;
  if (img) {
    const moving = !!dog.target;
    const dir = nap || !moving ? 'down' : (dog.dir > 0 ? 'right' : 'left');
    const fi = 1;
    drawSheet(g, img, dir, fi, x, y, 16);
  } else {
    g.fillStyle = '#f0e8dc'; g.fillRect(Math.round(x) - 5, Math.round(y) - 6, 10, 6);
  }
  if (nap) drawZzz(g, x, y - 8, t + 1700);
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
const fmtUsd = n => '$' + (n >= 100 ? Math.round(n) : n.toFixed(1));
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);

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
];
const DELIVER_LINES = [
  '📦納品完了しました!', '1本仕上がりました🎉', '講演、出荷でーす📦', '本日分、納めました!',
  '品質チェックOK、納品!', 'できたてほやほや、納品です', '今日も届けました📮', '納品ラッシュ来てます',
  'マスター確認済み、出します', '音声チェック3回した、完璧', 'レンダリング完走!納品!', '積み上げ+1です📦',
];
const DELIVER_PRAISE = [
  'よし!今日も届いたな👏', 'ナイス納品!', '品質第一、その調子だ', '視聴者が待ってるぞ、良い仕事だ',
  '積み上げが会社を作る!', '今夜は祝杯だな(お茶)', '掲示板に貼っておこう', '俺は今、猛烈に感動している',
];
const BURN_LINES = [
  '今日もう{d}使ってる…😅', '{d}突破…API換算こわ', '{d}か…売上はよ', '燃焼率が俺を燃やす…{d}',
  '{d}…参考値参考値(震え)', 'クレジット無限じゃないんだぞ…{d}', '{d}!?…まあ、投資だ', '経理の俺が泣いてる({d})',
];

function startCelebration(t, diff, subs) {
  celebration.until = t + 15000;
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
];
const SNACK_LINES = [
  '3時のおやつ〜🍪', '糖分補給の時間', 'チョコが俺を呼んでる', 'スナック棚、補充されてる!',
  'コーヒーおかわり☕', '15時の壁、甘味で越える', 'おやつは正義', '一口だけ…一口だけ…',
  '疲れた脳に糖を', 'お茶しばこ🍵',
];
const NIGHT_LINES = [
  'もうこんな時間…🌙', '静かだ…集中できる', '深夜テンション来た', '目が冴えてきた(まずい)',
  '夜型なんで本領発揮です', 'コンビニ行くなら今のうち', '月がきれいですね(窓ない)', 'ラストスパート🔥',
  'エナドリ2本目はダメって言われてる', 'そろそろ寝る準備…あと1件だけ', '夜のオフィス、ちょっと好き', '明日の俺に任せない',
];
const MONDAY_LINES = [
  '月曜が来てしまった…', '週の始まり!エンジン点火🔥', '土日の記憶がない', '今週も無限労働(社訓)',
  'まず週次の整理から', 'カレンダー見たくない', '今週こそ定時で…(フラグ)', 'よし、切り替えていこう',
  '月曜はコーヒー2杯必要', '月曜の自分、いつもえらい',
];
const FRIDAY_LINES = [
  '華の金曜日!🎉', '今夜は打ち上げ?', '週末までもうひと踏ん張り', '金曜の集中力は無敵',
  '土日の予定考えてニヤけてる', '今週もよく働いた…!', '金曜夜のオフィス、平和', '納品してから帰る!',
  '週報書かなきゃ', 'TGIF🍻',
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
    const owner = claudeEmps.find(e => e.match && new RegExp(e.match).test(a.project)) || claudeFallback;
    if (owner) buckets[owner.id].push(a);
  }
  const blk = s.claude.block;
  const cq2 = s.quota && s.quota.claude;
  const blockHp = cq2 && cq2.session ? Math.max(0, Math.round(100 - cq2.session.pct))
    : (blk && blk.remainingMinutes != null ? Math.max(0, Math.min(100, Math.round(blk.remainingMinutes / 3))) : 100);

  // Codexもプロジェクト(proj=作業ディレクトリ由来)で振り分け
  const codexEmps = employees.filter(e => e.source === 'codex');
  const codexFallback = codexEmps.find(e => !e.match);
  const cbuckets = {};
  for (const e of codexEmps) cbuckets[e.id] = [];
  for (const a of (s.codex.active || [])) {
    const owner = codexEmps.find(e => e.match && a.proj && new RegExp(e.match).test(a.proj)) || codexFallback;
    if (owner) cbuckets[owner.id].push(a);
  }
  const rl = s.codex.rateLimit;
  const codexHp = rl ? Math.max(0, Math.round(100 - rl.usedPercent)) : 100;

  for (const e of employees) {
    e.bubbles = [];
    e.jobDetail = null;
    e.happy = false; e.sweat = false; e.tired = false;
    if (e.source === 'claude') {
      const act = buckets[e.id] || [];
      e.hp = e.showHp ? blockHp : null;
      e.tired = blockHp < 22;
      if (act.length) {
        e.setMode('working');
        e.sweat = (blk && blk.costPerHour > 90) || act.reduce((a, b) => a + (b.sessions || 1), 0) >= 2;
        // 頭上タグ=いま実際にやっている作業(最後の指示)。名簿にはプロジェクト名込みの詳細
        e.jobText = act.map(a => a.task ? a.task : a.project + (a.sessions > 1 ? `×${a.sessions}` : '')).join(' / ');
        e.jobDetail = act.map(a => `${a.project}${a.sessions > 1 ? `×${a.sessions}` : ''}${a.task ? `: ${a.task}` : ''}`).join(' / ');
        e.bubbles = act.map(a => a.task ? `いま「${Array.from(a.task).slice(0, 34).join('')}」を進めてます` : `「${a.project}」作業中`);
        if (e.showHp && s.claude.today) e.bubbles.push(`本日 ${fmtTok(s.claude.today.tokensOut)}tok 出力`);
        if (e.tired) e.bubbles.push('5h枠がもうすぐ…');
      } else {
        e.setMode(tm.h >= 1 && tm.h < 7 ? 'sleep' : 'idle');
        e.jobText = '待機中';
        e.bubbles = IDLE_MUTTER.concat(PERSONAL_MUTTER[e.id] || []);
      }
    } else if (e.source === 'codex') {
      const act = cbuckets[e.id] || [];
      e.hp = e.showHp ? codexHp : null;
      e.tired = codexHp < 22;
      if (act.length) {
        e.setMode('working');
        e.sweat = act.length >= 2;
        e.jobText = act.map(a => a.thread).join(' / ');
        e.jobDetail = act.map(a => `${a.proj || 'その他'}: ${a.thread}`).join(' / ');
        e.bubbles = act.map(a => `「${Array.from(a.thread || '').slice(0, 30).join('')}」進行中`);
      } else {
        e.setMode(tm.h >= 1 && tm.h < 7 ? 'sleep' : 'idle');
        e.jobText = '待機中';
        e.bubbles = IDLE_MUTTER.concat(PERSONAL_MUTTER[e.id] || []);
      }
      if (e.showHp && rl) e.bubbles.push(`週次残量 ${codexHp}%`);
    } else if (e.source === 'schedule') {
      const del = s.deliveries ? (e.deliveryKeys || [e.deliveryKey]).reduce((acc, k) => acc + (s.deliveries[k] || 0), 0) : null;
      e.hp = null;
      const wj = e.watcherKey && s.launchd && s.launchd[e.watcherKey];
      if (e.watcherKey && !(wj && wj.running)) {
        e.setMode('panic');
        e.jobText = '❌ TTS(watcher)停止中!';
        e.bubbles = ['収録マシンが止まってる!'];
        e.action = 'stand';
      } else if (shiftActive(e.shift, tm)) {
        e.setMode('working');
        e.jobText = '日次ルーチン稼働中';
        e.bubbles = ['ただいま製造中…!', '(講演/台本/ショート仕込み中)'];
      } else if (tm.h >= 21 || tm.h < 3) {
        e.setMode('sleep');
        e.jobText = `次の出社 ${e.shift[0]}:${String(e.shift[1]).padStart(2, '0')}`;
      } else {
        e.setMode('idle');
        e.happy = del > 0;
        e.jobText = del != null ? `本日 ${del}本 納品` : '本日実績なし';
        e.bubbles = del > 0 ? [`今日は${del}本納品!`, 'また明日も作ります'] : ['今日はまだ実績なし'];
      }
    } else if (e.source === 'janitor') {
      e.hp = null;
      if (e.mode !== 'clean') { e.mode = 'clean'; }
      e.jobText = '巡回清掃中';
      e.bubbles = PERSONAL_MUTTER.shirayanagi || [];
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
          e.releaseSpot(); e.releaseReception(); e.resting = false; e.inChat = false;
          e.mode = 'working'; e._wasWorking = true;
          e.goto(BOSS_STUDIO_POST, 'studio');
          e.say(performance.now() + 800, '🎥収録入りまーす!静かに頼む!', 3600);
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
        e.bubbles = [`保留タスク ${tc ?? '-'}件…`, '次は何を仕込むか'];
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
  const delivTotal = s.deliveries ? (s.deliveries.koen || 0) + (s.deliveries.daihon || 0) : null;
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
  if (cq2 && cq2.session) {
    if (cq2.session.pct > 85 && !onSnapshot._quotaPanic) {
      onSnapshot._quotaPanic = true;
      const itoQ = employees.find(e => e.id === 'ito');
      if (itoQ && itoQ.present) itoQ.say(now + 6000, '🚨セッション残量15%切った…配分考えないと💦', 4600);
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
    if (fetchFail) { $('stale').style.display = 'block'; $('staleAge').textContent = '未受信'; }
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
    if (q && q.session) qrow('Claude セッション(5h)', q.session.pct, fmtReset(q.session.resetsAt));
    if (q && q.week) qrow('Claude 週間(全モデル)', q.week.pct, fmtReset(q.week.resetsAt));
    if (q && q.model) qrow(`Claude 週間(${esc(q.model.name)})`, q.model.pct, fmtReset(q.model.resetsAt));
    if (rlq) qrow('Codex 週間', rlq.usedPercent, rlq.resetsAt ? fmtReset(new Date(rlq.resetsAt).toISOString()) : '');
    if (CFG.mureka && CFG.mureka.gold != null) {
      rows.push(`<div class="row"><span class="lbl">Mureka Gold</span><span>残り <b>${CFG.mureka.gold}</b> G</span></div>`);
    }
    if (q && q.cachedAgeMin != null) {
      rows.push(`<div style="font-size:10px;opacity:.55">※Claude残量は${q.cachedAgeMin}分前の値(APIレート制限中)</div>`);
    }
    qEl.innerHTML = rows.length ? rows.join('') : '<div style="opacity:.6;font-size:12px">残量データ待ち(次の収集で反映)</div>';
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
    const pct = goal ? Math.min(100, Math.round(s.youtube.subs / goal * 100)) : 0;
    yt.innerHTML = `<span>📺 登録者 <b>${s.youtube.subs.toLocaleString('ja-JP')}</b>人</span><span>🎯 目標比 <b>${pct}%</b></span><span>🎬 動画 <b>${s.youtube.videos != null ? s.youtube.videos.toLocaleString('ja-JP') : '-'}</b>本</span>`;
  } else {
    yt.innerHTML = `<span style="opacity:.6">未接続 — collector/config.json の youtube に APIキー/チャンネルID を設定すると表示されます</span>`;
  }

  const sales = CFG.sales || {};
  $('salesMonth').textContent = sales.monthlyJPY != null
    ? `${fmtYen(sales.monthlyJPY)}${sales.note ? `(${sales.note})` : ''}`
    : '未設定(config.jsのsalesに記入)';

  const del = $('deliveries');
  del.innerHTML = `<span>🎤 講演 <b>${s.deliveries.koen ?? '-'}</b>本</span><span>📜 台本 <b>${s.deliveries.daihon ?? '-'}</b>本</span><span>🔤 出力 <b>${fmtTok(s.totals.todayTokens || 0)}</b>tok</span>`;

  const ul = $('tasks');
  ul.innerHTML = '';
  for (const it of (s.tasks.items || [])) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${esc(it.id)}</b>${esc(it.text)}`;
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
  stepChimeBreak(t);
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
    if (officeEvent.active) {
      for (const [k, ox, oy, ow, oh] of EVENT_PROPS[officeEvent.active.kind]) {
        const pcx = ox + ow / 2, pcy = oy + oh - 4;
        const dx2 = w.pos.x - pcx, dy2 = w.pos.y - pcy;
        const d2 = Math.hypot(dx2, dy2);
        const r = Math.max(ow, 14) / 2 + 5;
        if (d2 > 0.1 && d2 < r) { const p = (r - d2) * 0.6; w.pos.x += dx2 / d2 * p; w.pos.y += dy2 / d2 * p; }
      }
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
    ['reception', 252, 272, 112, 42], ['sanitizer', 242, 280, 10, 24],
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
    items.push({ y: e.desk.y + 20, draw: g => drawDesk(g, e.desk, e.mode === 'working' && e.present, t + e.seed, e.def) });
  }
  // ソファ前面(座ったキャラの脚を隠す)
  for (const e of employees) if (e.present) items.push({ y: e.pos.y, draw: g => e.drawSprite(g, t) });
  // 名札(自席以外): 本人の足元レイヤーに置く=手前(下)を通る人が名札の上を通過する。
  // 段差スタガーは廃止し、横並びの人は名札も横一列に揃う
  for (const e of employees) {
    if (!e.present) continue;
    const seatedL = e.action === 'sit' || e.action === 'sleep';
    if (seatedL && !e.resting && !e.atMeeting) continue;   // 自席は机の前板名札に任せる
    items.push({ y: e.pos.y - 0.5, draw: g => {
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
    cx.fillStyle = 'rgba(30,30,80,.16)';
    cx.fillRect(0, 0, W, H);
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
  if (dog.bubble && t < dog.bubbleUntil) drawBubble(cx, dog.pos.x, dog.pos.y - 14, dog.bubble);
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
  if (bossE && bossE.directing) return bossE.x - CAM_W / 2;
  return (W - CAM_W) / 2 * (1 + Math.sin(t / 60000 * Math.PI * 2));
}
function blitLive(t, tm) {
  if (!camCx) return;
  const tgt = Math.max(0, Math.min(W - CAM_W, liveTarget(t)));
  camX += (tgt - camX) * 0.012;
  camCx.drawImage(cv, Math.round(camX * 4), 0, CAM_W * 4, 1440, 0, 0, CAM_W * 4, 1440);
  if (t - lastLiveDom > 1000) {
    lastLiveDom = t;
    $('lvClock').textContent = tm.hm;
    $('lvMission').textContent = `「${CFG.mission}」`;
    const subs = snap && snap.youtube && snap.youtube.subs != null ? snap.youtube.subs.toLocaleString('ja-JP') + '人' : '---';
    $('lvSubs').textContent = `📺 YT登録者 ${subs}`;
    $('lvWork').textContent = `💻 稼働中 ${employees.filter(e => e.present && e.mode === 'working').length}人`;
    const d = snap && snap.deliveries ? (snap.deliveries.koen || 0) + (snap.deliveries.daihon || 0) : null;
    $('lvDel').textContent = `📦 本日の納品 ${d == null ? '-' : d}本`;
  }
}

/* ================================================================
   チャイム休憩: 鐘が鳴ったら全員5分休憩
   ================================================================ */
const chimeBreak = { until: 0 };
const CHIME_BREAK_TALK = [
  '鐘だ!休憩!', '5分だけ肩の力抜こ', 'コーヒー淹れよ', '目薬タイム', '立つの久しぶりかも',
  'あ〜〜〜(伸び)', 'チャイム最高', '5分後の俺、頼んだ', '肩がバキバキ', '水分水分',
  '窓の外見たい(遠い)', '糖分補給', '正座で作業してた足が…', 'まばたきの練習しよ',
];
const CHIME_BREAK_END = [
  'よし、再開!', '戻るか〜', '5分って一瞬だな…', '続きやるぞ', '席戻ろ',
  'まだ休みたい…', 'エンジン再点火', '後半戦!', '次の鐘まで頑張る',
];

function startChimeBreak(t) {
  chimeBreak.until = t + 300000;   // 5分
  for (const e of employees) {
    if (!e.present || e.def.source === 'janitor') continue;
    if (e.inChat || e.atMeeting || e.receptionOn || e.recording) continue;
    if (e.mode !== 'working' && !(e.mode === 'idle' && !e.resting)) continue;
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
  if (tm.h < 6 || tm.h > 22 || tm.h % 2 !== 0) return;
  const key = `${tm.h}`;
  if (lastChimeKey === key) return;
  lastChimeKey = key;
  chime.currentTime = 0;
  chime.play().catch(() => {});
  startChimeBreak(performance.now());   // 鐘が鳴ったら全員5分休憩
}, 5000);

/* ---------- 起動 ---------- */
(async () => {
  fitCanvas();
  try { await document.fonts.load('9px DotGothic16'); await document.fonts.load('13px DotGothic16'); } catch {}
  await poll();
  setInterval(poll, (CFG.pollSec || 60) * 1000);
  setInterval(updateHud, 10000);
  requestAnimationFrame(t => { last = t; loop(t); });
})();
