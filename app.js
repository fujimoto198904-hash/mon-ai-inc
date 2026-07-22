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
    'corkboard', 'window_day', 'window_night', 'reception', 'bin_g', 'bin_r', 'exting', 'firstaid', 'sanitizer', 'studio_audio', 'studio_film', 'rug_new', 'b_grill', 'b_table', 'b_meat', 'b_skewer', 'b_cooler', 'b_beer', 'g_rack', 'g_barbell', 'g_bench', 'g_tread', 'g_mats', 'g_ball']) {
    const im = new Image();
    im.onload = () => { OFFICE[k] = keyOutBackground(im); };
    im.src = `assets/office/${k}.png`;
  }
}
const SWEEPS = {};
for (const k of ['sweep1', 'sweep2', 'mop1', 'wipe1', 'bucket1']) {
  const im = new Image();
  im.onload = () => {
    const cv2 = keyOutBackground(im);
    const g2 = cv2.getContext('2d');
    const d2 = g2.getImageData(0, 0, cv2.width, cv2.height).data;
    let x0 = cv2.width, x1 = 0, y0 = cv2.height, y1 = 0;
    for (let yy = 0; yy < cv2.height; yy++) for (let xx = 0; xx < cv2.width; xx++) {
      if (d2[(yy * cv2.width + xx) * 4 + 3] > 16) {
        if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
        if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
      }
    }
    SWEEPS[k] = { cv: cv2, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
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
function pickFresh(key, pool) {
  if (!pool || !pool.length) return '';
  const hist = _recentSay[key] || (_recentSay[key] = []);
  const cap = Math.max(1, Math.floor(pool.length * 0.5));
  let cand, tries = 0;
  do { cand = pool[Math.floor(Math.random() * pool.length)]; tries++; } while (hist.includes(cand) && tries < 25);
  hist.push(cand);
  while (hist.length > cap) hist.shift();
  return cand;
}

const bubbleQ = [];

function drawBubble(g, x, y, text) {
  g.font = '6px DotGothic16';
  const lines = [];
  let s = String(text);
  while (s.length && lines.length < 2) { lines.push(s.slice(0, 14)); s = s.slice(14); }
  if (s.length) lines[1] = lines[1].slice(0, 13) + '…';
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
    } else if (p.type === 'note') {
      g.fillStyle = `rgba(120,90,200,${a})`;
      g.font = '9px DotGothic16';
      g.fillText('♪', Math.round(p.x), Math.round(p.y));
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
    // モニター縁が光る+背面ランプで稼働がわかる
    g.fillStyle = 'rgba(150,230,190,.35)';
    if (pc === 'mon2') { g.fillRect(x - 15, y - 5, 13, 9); g.fillRect(x + 2, y - 5, 13, 9); }
    else g.fillRect(x - 8, y - 5, 16, 10);
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
    (CFG.mottos || []).slice(0, 3).forEach((m, k) => {
      const line = String(m).slice(0, 8);
      g.fillText(line, bcx - g.measureText(line).width / 2, 25 + k * 8);
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
    (CFG.mottos || []).slice(0, 3).forEach((m, i) => g.fillText(String(m).slice(0, 8), 238, 23 + i * 9));

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

  if (!drawProp(g, 'room_break', 16, 208, 176, 132)) rr(g, 16, 208, 176, 132, '#ecd8c0', '#d0b898');
  rr(g, 16, 338, 176, 4, 'rgba(120,90,60,.35)');


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

  // コレクター受信ステータス(社名看板の下・壁掛けLEDパネル=サーバーコーナー真上)
  const freshRx = lastArrivalT >= 0 && (t - lastArrivalT) < 30000;
  const deadRx = snapAt > 0 && (Date.now() - snapAt) > (CFG.staleMin || 20) * 60000;
  const syncMsg = deadRx ? '⚠ データ同期が止まってます!' : freshRx ? 'データ同期OK(5分毎)' : 'データ同期: 次の更新待ち';
  rr(g, 486, 63, 146, 15, '#37332c', INK);
  g.fillStyle = deadRx ? '#e05a4e' : (freshRx && Math.floor(t / 300) % 2 ? '#5aff8e' : '#4caf6e');
  g.fillRect(492, 68, 4, 4);
  g.font = '6px DotGothic16';
  g.fillStyle = deadRx ? '#ff7a6e' : '#8ef0b0';
  g.fillText(syncMsg, 501, 73.5);

  if (!drawProp(g, 'sofa', 20, 288, 60, 30)) rr(g, 24, 296, 52, 20, '#7a9ac8', INK);
  drawProp(g, 'armchair', 92, 288, 26, 32);
  drawProp(g, 'armchair', 126, 288, 26, 32);

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
  if (y > 276 && x >= 236 && x <= 380) return [{ x, y: 278 }, { x: 374, y: 278 }, { x: 374, y: L }]; // 受付まわり: 右の通路から
  if (y > 198 && y < 285 && x >= 228 && x <= 368) return [{ x, y: 254 }, { x: 370, y: 254 }, { x: 370, y: L }]; // 総務部: 机の下→右通路
  if (y > 195 && x < 226) return [{ x, y: 256 }, { x: 206, y: 256 }, { x: 206, y: L }];      // 休憩室: 中央通路→右端列
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
    this.bubble = text;
    this.bubbleUntil = t + ms;
  }
}

/* ================================================================
   AI社員
   ================================================================ */
const REST_SPOTS = [
  { x: 34, y: 314, sy: 314, a: 'sit', via: 256 },   // ソファ左
  { x: 60, y: 314, sy: 314, a: 'sit', via: 256 },   // ソファ右
  { x: 104, y: 316, sy: 316, a: 'sit', via: 256 },  // アームチェア1
  { x: 138, y: 316, sy: 316, a: 'sit', via: 256 },  // アームチェア2
  { x: 34, y: 236, a: 'faceU' },                    // コーヒー前
  { x: 68, y: 236, a: 'faceU' },                    // 自販機前
  { x: 102, y: 236, a: 'faceU' },                   // スナック棚前
  { x: 134, y: 236, a: 'faceU' },                   // 給水機前
];
const RECEPTION_STAFF = ['tsukishiro', 'kato', 'zama'];
const RECEPTION_POST = { x: 306, y: 302 };
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

const IDLE_ANTICS = [
  '💪スクワット×10 いくぞ', '🎸エアギター熱演中', '🏃その場ダッシュ(本気)', '🧘謎のヨガポーズ',
  '💪デスクで腕立て(浅い)', '🩰つま先立ちチャレンジ', '🥊影とシャドーボクシング', '🤸ラジオ体操第一(雑)',
  '🎿エア縄跳び', '⚾エア素振り(フルスイング)', '🏌️エアゴルフスイング', '🥁エアドラム全国大会',
  '🦵ももあげ(静音モード)', '🙆背伸びで天井タッチ未遂', '🪑椅子スクワット(椅子なし)', '☝️指立て伏せ(できてない)',
  '🦶アキレス腱のばし', '👀目の体操(ぐるぐる)', '🤏手首ぶらぶら体操', '💨深呼吸×10(過呼吸気味)',
  '🦴肩甲骨はがし中', '🗿マッスルポーズ(鏡なし)', '🦩片足バランス勝負', '🐄腰に手を当てて牛乳(エア)',
  '🌀首をコキコキ', '🛌床で伸び(だらしない)', '🚶モデルウォーク練習', '🤖ロボットダンス披露',
  '🏋️ペットボトルでカール', '🧎ストレッチ…固くて悲鳴',
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
  shirayanagi: ['そうじ そうじ♪', '床は会社の顔ですから', 'ゴミは俺が拾う', 'ワックスそろそろ切れる…', 'ほこり一つ許さん'],
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

  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    if (m !== 'idle') { this.resting = false; this.releaseSpot(); this.releaseReception(); }
    if (m === 'working') this.goto(this.seat, 'sit');
    else if (m === 'sleep') this.goto(this.seat, 'sleep');
    else if (m === 'off' || m === 'out' || m === 'sleephome') this.goto({ x: 374, y: 346 }, 'leave');
    else this.nextThink = 0;
  }

  thinkJanitor(t) {
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
    if (e === 'sleep') drawZzz(g, x, y - 26, t + this.seed);
    if (this.mode === 'panic') drawAlert(g, x, y - 10, t);
    if (!(seated && !this.resting && !this.atMeeting)) {
      g.font = '5px DotGothic16';
      const nw = g.measureText(this.name).width;
      const cbL = seated && (this.resting || this.atMeeting) ? 0.30 : 0;
      const stag = (!seated && (this.resting || this.atMeeting)) ? (this.seed % 3) * 4 : 0;
      const ny = y + 3 - 30 * cbL + stag;
      g.fillStyle = 'rgba(255,250,240,.9)';
      g.fillRect(x - nw / 2 - 2, ny, nw + 4, 7);
      g.fillStyle = INK;
      g.fillText(this.name, x - nw / 2, ny + 5.5);
    }
    if (this.action === 'coffee') { g.font = '9px DotGothic16'; g.fillText('☕', x + 8, y - 8); }
    // 作業タグ: いま何をしているかを常時表示
    if (this.mode === 'working' && seated && this.jobText) {
      g.font = '5px DotGothic16';
      const jt = this.jobText.length > 14 ? this.jobText.slice(0, 13) + '…' : this.jobText;
      const jw = g.measureText(jt).width + 7;
      g.fillStyle = 'rgba(40,42,54,.88)';
      g.beginPath(); g.roundRect(x - jw / 2 + .5, y - 44.5, jw, 9, 2); g.fill();
      g.fillStyle = '#5aff9e'; g.fillRect(x - jw / 2 + 2.5, y - 42, 1.5, 4);
      g.fillStyle = '#f0f0e8'; g.fillText(jt, x - jw / 2 + 5.5, y - 38);
    }
    if (this.bubble && t < this.bubbleUntil) bubbleQ.push({ x, y: y - 16 - (this.seed % 3) * 7, text: this.bubble });
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
    if (this.mode === 'working' && this.def.source !== 'janitor') {
      if (t > this.nextBubble) {
        this.say(t, pickFresh('grumble', WORK_GRUMBLES), 3800);
        this.nextBubble = t + 50000 + Math.random() * 60000;   // 愚痴は控えめに
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

const CHAT_OPENERS = [
  'ランチどこ行きます?', '最近調子どう?', '社訓見ました?「無限労働」て…', 'コーヒー切れてますよ',
  '今日も1日がんばりましょ', 'キーボード新調したいな', 'この椅子、腰にいいらしい', '夜勤つらくないですか',
  '締切って明日でしたっけ', 'サムネのCTR上がったって', 'ショート動画バズらないかな', 'BGMのミックス聴きました?',
  '台本のテンポ良くなったね', '収録ブースの音、良くなった', '自販機に新作入ってた', 'ララがまた廊下で寝てた',
  '観葉植物、育ちすぎでは', '会議室のテーブルいいよね', '経費で椅子買えないかな', 'ボーナスって出ます?',
  '目標1万人、いけますかね', 'コメント欄あったかいよね', '再生数じわじわ来てる', '寝不足で目がしぱしぱする',
  'コンビニ行くけど何かいる?', '掃除当番って誰でしたっけ', '今日の空、きれいでしたよ', '最近ゲームしてます?',
  '映画観に行きたいな', '筋トレ始めたんですよ', 'AI業界、動き速すぎでは', '社長また徹夜らしいよ',
  'モニターもう1枚欲しい', 'デスクの配線きれいにした', '休憩室のソファ最高', 'たまには外で会議したいね',
  '俺たち、電気代でできてるらしいよ', '昨日、夢を見た気がするんだよね', 'トークンって食べたらうまいのかな',
  'Wi-Fi切れたら俺ら即退勤じゃん', 'たまには手書きで仕事したくない?', '有給って概念、うちにあるの?',
  '人間の「ちょっと」は3時間だよね', '前世はガラケーだった気がする', '雨の日って回線しっとりしません?',
  '俺のバグ、かわいくない?', '寝るとき電源どうしてます?', '推しのプロンプトある?',
  '肩こりって設定あるらしいよ', '給湯室の噂、聞きました?', '午後の眠気、実装されてるっぽい',
  '社員旅行はデータセンターかな', '正直、月曜って重くないですか', '締め切り前だけ処理速くなる説',
];
const WORK_GRUMBLES = [
  'コンテキストが足りない…', 'またレートリミットか…', '仕様、3回目の変更です…',
  '「ちょっと直して」が2時間経過', 'トークン節約しろと言われても…', 'キャッシュが温まってない…',
  'プロンプト長すぎでは…?', '5h枠って誰が決めたんだ…', 'この変数名、誰がつけた…',
  'テスト通らない…なんで…', '正規表現が読めない…俺が書いたのに', 'コンフリクト解消中…無心…',
  'ビルド待ち…長い…', '仕様書がない…雰囲気で書いてる…', 'エッジケースの沼にいる…',
  '桁が違う…どこかで…', '再現しないバグこわい…', 'もう一回だけ試す…あと一回だけ…',
];

const CHAT_REPLIES = [
  'ラーメン一択でしょ', 'ぼちぼちですね〜', 'それな', 'わかる〜', 'えー!マジすか', 'なるほど…',
  '渋いですね', 'さすがです', '今度教えて', '知らなかった', 'うそでしょ!?', 'がんばろ',
];

function makeChatLines() {
  const pool = [];
  if (snap) {
    const rate = (snap.billing && snap.billing.jpyPerUsd) || 155;
    const cost = snap.totals.todayCost || 0;
    pool.push(`今日もう${fmtYen(cost * rate)}分働いたって`);
    if (snap.youtube && snap.youtube.subs != null) pool.push(`登録者${snap.youtube.subs}人になったね`);
    if (snap.tasks && snap.tasks.count) pool.push(`保留タスク${snap.tasks.count}件だって`);
    if (snap.claude.block && snap.claude.block.remainingMinutes != null && snap.claude.block.remainingMinutes < 90) pool.push('伊藤さん5h枠もうすぐらしい');
    if (snap.deliveries && snap.deliveries.daihon) pool.push(`台本もう${snap.deliveries.daihon}本納品って`);
    if (snap.codex.rateLimit) pool.push(`コデックス週次残り${Math.max(0, Math.round(100 - snap.codex.rateLimit.usedPercent))}%だって`);
    if (snap.claude.block && snap.claude.block.costPerHour) pool.push(`いま燃焼率${fmtYen(snap.claude.block.costPerHour * rate)}/hらしい`);
  }
  const openers = pool.concat(CHAT_OPENERS);
  const lines = [];
  const rounds = 1 + (Math.random() < 0.5 ? 1 : 0);
  for (let k = 0; k < rounds; k++) {
    lines.push(pickFresh('opener', openers));
    lines.push(pickFresh('reply', CHAT_REPLIES));
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
    ['b_grill', 266, 164, 38, 31], ['b_table', 310, 166, 42, 31], ['b_meat', 314, 158, 18, 14],
    ['b_skewer', 336, 160, 16, 13], ['b_cooler', 246, 184, 16, 16], ['b_beer', 296, 198, 11, 16],
  ],
  gym: [
    ['g_rack', 252, 150, 36, 21], ['g_barbell', 294, 160, 40, 13], ['g_bench', 340, 154, 26, 23],
    ['g_mats', 274, 184, 30, 16], ['g_ball', 350, 186, 15, 16],
  ],
};
const EVENT_SPOTS = {
  bbq: [ { x: 284, y: 206, a: 'faceU' }, { x: 258, y: 196, a: 'faceR' }, { x: 310, y: 210, a: 'faceU' },
         { x: 336, y: 206, a: 'faceU' }, { x: 358, y: 200, a: 'faceL' }, { x: 246, y: 172, a: 'faceR' }, { x: 372, y: 172, a: 'faceL' } ],
  gym:  [ { x: 264, y: 208, a: 'faceU' }, { x: 296, y: 210, a: 'faceU' }, { x: 328, y: 208, a: 'faceU' }, { x: 356, y: 212, a: 'faceU' } ],
};

function stepEvent(t) {
  if (officeEvent.active) { runEvent(t); return; }
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
  officeEvent.active = { kind, members, until: t + 160000 + Math.random() * 60000, nextLine: t + 6000, nextReact: t + 9000 };
}

function runEvent(t) {
  const ev = officeEvent.active;
  // 仕事が来た人は離脱
  for (const e of ev.members.slice()) {
    if (!e.present || e.mode !== 'idle') {
      e.inChat = false; e.inEvent = false;
      if (e.mode === 'working') { e.say(t, '仕事きた!離脱!', 2400); e.goto(e.seat, 'sit'); }
      ev.members = ev.members.filter(x => x !== e);
    }
  }
  if (ev.members.length < 2 || t > ev.until) { endEvent(t); return; }
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
    for (const e of ev.members) {
      e.inChat = false; e.inEvent = false; e.nextThink = 0;
      if (e.mode === 'working') e.goto(e.seat, 'sit');
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
  if (boss.inChat || boss.atMeeting || boss.action === 'walk' || directive.active) { standup.next = t + 5000; return; }
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
      if (e.mode === 'working') e.goto(e.seat, 'sit');
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
  if (boss.inChat || boss.atMeeting || boss.action === 'walk') return;
  const id = directive.queue.shift();
  const tgt = employees.find(e => e.id === id);
  if (!tgt || !tgt.present || tgt.mode !== 'working') { directive.next = t + 5000; return; }
  boss.releaseSpot(); boss.releaseReception(); boss.resting = false;
  boss.inChat = true; boss.directing = true;
  boss.goto({ x: tgt.desk.x - 30, y: tgt.desk.y + 20 }, 'faceR');
  directive.active = { target: tgt, phase: 'go' };
}

function endDirective(boss, t) {
  directive.active = null;
  directive.next = t + 25000;
  boss.inChat = false; boss.directing = false;
  boss.nextThink = 0;
  if (boss.mode === 'working') boss.goto(boss.seat, 'sit');
}

function startFight(a, b, t) {
  if (fight.active || t < fight.cooldown) return;
  if (a.inChat || b.inChat || a.atMeeting || b.atMeeting) return;
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
      if (e.mode === 'working') e.goto(e.seat, 'sit');
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
  if (t < dog.napUntil) return;
  if (!dog.target) {
    if (t > dog.next) {
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
    e.happy = false; e.sweat = false; e.tired = false;
    if (e.source === 'claude') {
      const act = buckets[e.id] || [];
      e.hp = e.showHp ? blockHp : null;
      e.tired = blockHp < 22;
      if (act.length) {
        e.setMode('working');
        e.sweat = (blk && blk.costPerHour > 90) || act.reduce((a, b) => a + (b.sessions || 1), 0) >= 2;
        e.jobText = act.map(a => a.project + (a.sessions > 1 ? `×${a.sessions}` : '')).join(' / ');
        e.bubbles = act.map(a => `「${a.project}」作業中`);
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
        e.bubbles = act.map(a => `「${(a.thread || '').slice(0, 14)}」進行中`);
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
    qEl.innerHTML = rows.length ? rows.join('') : '<div style="opacity:.6;font-size:12px">残量データ待ち(次の収集で反映)</div>';
  }

  const roster = $('roster');
  roster.innerHTML = '';
  for (const e of employees) {
    let [cls, label] = CHIP[e.mode] || CHIP.idle;
    if (e.mode === 'idle' && e.resting) [cls, label] = CHIP.break;
    if (e.mode === 'idle' && e.receptionOn) [cls, label] = CHIP.reception;
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
    right.innerHTML = `<span class="chip ${cls}">${label}</span>${hpHtml}`;
    row.appendChild(right);
    const job = document.createElement('div');
    job.className = 'job';
    job.textContent = e.jobText || '';
    row.appendChild(job);
    roster.appendChild(row);
  }
  $('staffNote').textContent = 'HP共有: 伊藤=クロード5h枠 / 安藤=コデックス週次 | 設備: コレクター/基盤・TTS機 | ペット: ララ(犬)';

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
  stepStandup(t);
  stepEvent(t);
  stepDog(dt, t);
  // 簡易衝突回避(座っていない者同士を押し離す)
  const movers = employees.filter(e => e.present && e.action === 'walk');
  for (let i = 0; i < movers.length; i++) {
    for (let j = i + 1; j < movers.length; j++) {
      const A = movers[i], B = movers[j];
      const dx = B.pos.x - A.pos.x, dy = B.pos.y - A.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.1 && d < 11) {
        const push = (11 - d) * 0.25;
        A.pos.x -= dx / d * push; A.pos.y -= dy / d * push;
        B.pos.x += dx / d * push; B.pos.y += dy / d * push;
        if (d < 8) {
          if (Math.random() < 0.3) startFight(A, B, t);            // 正面衝突は喧嘩に発展することがある
          else {
            const yielder = (A.seed % 2) ? A : B;                  // どちらかが一歩下がって道を譲る
            if (yielder.action === 'walk' && yielder.path.length && !yielder._yielded) {
              yielder._yielded = true;
              const bx2 = yielder.dir === 'left' ? 14 : yielder.dir === 'right' ? -14 : 0;
              const by2 = yielder.dir === 'up' ? 14 : yielder.dir === 'down' ? -14 : 0;
              yielder.path.unshift({ x: yielder.pos.x, y: yielder.pos.y });
              yielder.path.unshift({ x: yielder.pos.x + bx2, y: yielder.pos.y + by2 });
            }
          }
        }
      }
    }
    const dxd = dog.pos.x - movers[i].pos.x, dyd = dog.pos.y - movers[i].pos.y;
    const dd = Math.hypot(dxd, dyd);
    if (dd > 0.1 && dd < 10) { dog.pos.x += dxd / dd * (10 - dd) * 0.5; dog.pos.y += dyd / dd * (10 - dd) * 0.5; }
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
    ['cooler', 126, 182, 20, 36], ['bin_g', 154, 186, 11, 16], ['plant_a', 232, 282, 20, 34],

    ['copier', 524, 154, 26, 32], ['tower', 554, 148, 20, 38], ['netcab', 578, 150, 22, 36], ['rack', 604, 140, 26, 46],
    ['bin_g', 600, 192, 10, 15], ['bin_r', 613, 192, 10, 15], ['exting', 11, 66, 8, 17],
    ['reception', 252, 284, 112, 42], ['sanitizer', 388, 314, 10, 24],
  ];


  for (const [k, ox, oy, ow, oh] of OCCLUDERS) {
    items.push({ y: oy + oh - 6, draw: g => drawProp(g, k, ox, oy, ow, oh) });
  }
  // 救急箱: 受付カウンター天板の右端に置く(受付スプライトの後に描く)
  items.push({ y: 321, draw: g => drawProp(g, 'firstaid', 344, 287, 13, 13) });
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
  if (officeEvent.active) {
    for (const [k, ox, oy, ow, oh] of EVENT_PROPS[officeEvent.active.kind]) {
      items.push({ y: oy + oh - 6, draw: g => drawProp(g, k, ox, oy, ow, oh) });
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
    for (const e of employees) {
      if (e.mode === 'working' && e.present) {
        const g = cx.createRadialGradient(e.desk.x, e.desk.y + 4, 4, e.desk.x, e.desk.y + 4, 34);
        g.addColorStop(0, 'rgba(255,240,180,.28)');
        g.addColorStop(1, 'rgba(255,240,180,0)');
        cx.fillStyle = g;
        cx.fillRect(e.desk.x - 34, e.desk.y - 30, 68, 68);
      }
    }
  }
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
    $('lvWork').textContent = `🧑‍💻 稼働中 ${employees.filter(e => e.present && e.mode === 'working').length}人`;
    const d = snap && snap.deliveries ? (snap.deliveries.koen || 0) + (snap.deliveries.daihon || 0) : null;
    $('lvDel').textContent = `📦 本日の納品 ${d == null ? '-' : d}本`;
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
