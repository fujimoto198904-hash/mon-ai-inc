/* MON-AI Inc. — ドット絵AIオフィス エンジン v2 */
'use strict';

const CFG = window.OFFICE_CONFIG;
const W = 640, H = 360;
const cv = document.getElementById('office');
const cx = cv.getContext('2d');
cx.scale(2, 2);              // 内部解像度1280x720、論理座標は640x360のまま
cx.imageSmoothingEnabled = false;

/* ---------- 閲覧トークン ---------- */
const viewToken = (location.hash.match(/v=([0-9a-f]+)/) || [])[1];
if (!viewToken) document.getElementById('gate').style.display = 'flex';
document.getElementById('mission').textContent = `ミッション「${CFG.mission}」`;

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
  const st = document.getElementById('stage');
  const aw = st.clientWidth - 12, ah = st.clientHeight - 12;
  const s = Math.min(aw / W, ah / H);
  cv.style.width = Math.round(W * s) + 'px';
  cv.style.height = Math.round(H * s) + 'px';
}
window.addEventListener('resize', fitCanvas);

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
  // コマごとの成分解析
  const cw = w / 3, ch = h / 4;
  const label = new Int32Array(w * h);
  const boxes = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) {
    const x0 = Math.floor(col * cw), x1 = Math.floor((col + 1) * cw);
    const y0 = Math.floor(row * ch), y1 = Math.floor((row + 1) * ch);
    let bestPix = [], bestCount = 0;
    let cur = row * 3 + col + 1;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const pi = y * w + x;
      if (label[pi] || d[pi * 4 + 3] < 16) continue;
      const comp = [];
      const st = [pi];
      label[pi] = cur;
      while (st.length) {
        const q = st.pop();
        comp.push(q);
        const qx = q % w, qy = (q / w) | 0;
        const nb = [];
        if (qx > x0) nb.push(q - 1);
        if (qx < x1 - 1) nb.push(q + 1);
        if (qy > y0) nb.push(q - w);
        if (qy < y1 - 1) nb.push(q + w);
        for (const n of nb) {
          if (!label[n] && d[n * 4 + 3] >= 16) { label[n] = cur; st.push(n); }
        }
      }
      if (comp.length > bestCount) {
        for (const q of bestPix) d[q * 4 + 3] = 0;  // これまでの最大を消す
        bestCount = comp.length;
        bestPix = comp;
      } else {
        for (const q of comp) d[q * 4 + 3] = 0;     // 小さい成分=ノイズを消す
      }
    }
    if (bestCount < 30) { boxes.push(null); continue; }
    let bx0 = w, bx1 = 0, by0 = h, by1 = 0;
    for (const q of bestPix) {
      const qx = q % w, qy = (q / w) | 0;
      if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx;
      if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
    }
    boxes.push({ x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 });
  }
  g.putImageData(im, 0, 0);
  return { cv: c, boxes };
}
for (const id of ['fujimoto', 'amakawa', 'tsukishiro', 'ito', 'sasaki', 'ando', 'hirose', 'arimoto', 'kato', 'zama', 'lala']) {
  const img = new Image();
  img.onload = () => { SHEETS[id] = processSheet(img); };
  img.src = `assets/sheets/${id}.png`;
}

function drawSheet(g, sheet, dir, fi, x, y, h, cropBottom) {
  const cb = cropBottom || 0;
  const row = dir === 'left' || dir === 'right' ? 1 : dir === 'up' ? 3 : 0;
  const b = sheet.boxes[row * 3 + fi] || sheet.boxes[1] || sheet.boxes[0];
  if (!b) return;
  const w = h * b.w / b.h;
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
  for (const k of ['vending', 'sofa', 'plant', 'cooler', 'rug_ceo', 'rug_pt', 'rug_app', 'rug_yoru', 'rug_soumu', 'room_break', 'room_studio', 'room_film', 'desk1', 'desk_exec', 'chair', 'mon1', 'mon2', 'laptop', 'rack', 'netcab', 'plant_a', 'plant_snake', 'plant_mon', 'lamp', 'coat', 'coffee_st', 'fridge', 'armchair', 'ctable', 'snack', 'copier', 'umbrella', 'meeting', 'mon1b', 'laptopb', 'tvstand', 'projcart', 'tower']) {
    const im = new Image();
    im.onload = () => { OFFICE[k] = keyOutBackground(im); };
    im.src = `assets/office/${k}.png`;
  }
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
function drawBubble(g, x, y, text) {
  g.font = '10px DotGothic16';
  const lines = [];
  let s = String(text);
  while (s.length && lines.length < 2) { lines.push(s.slice(0, 11)); s = s.slice(11); }
  if (s.length) lines[1] = lines[1].slice(0, 10) + '…';
  const w = Math.max(...lines.map(l => g.measureText(l).width)) + 10;
  const h = lines.length * 12 + 7;
  let bx = Math.min(Math.max(4, x - w / 2), W - w - 4);
  const by = Math.max(4, y - 24 - h);
  g.fillStyle = 'rgba(255,255,255,.95)';
  g.strokeStyle = INK; g.lineWidth = 1;
  g.beginPath(); g.roundRect(bx + .5, by + .5, w, h, 3); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(x - 2, by + h); g.lineTo(x + 2, by + h); g.lineTo(x, by + h + 4); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = INK;
  lines.forEach((l, i) => g.fillText(l, bx + 5, by + 11 + i * 12));
}

function drawHp(g, x, y, pct) {
  const w = 14;
  g.fillStyle = INK; g.fillRect(x - w / 2 - 1, y - 22, w + 2, 4);
  g.fillStyle = '#e7dcc3'; g.fillRect(x - w / 2, y - 21, w, 2);
  g.fillStyle = pct > 50 ? '#4caf6e' : pct > 20 ? '#e8b93c' : '#e05a4e';
  g.fillRect(x - w / 2, y - 21, Math.max(1, Math.round(w * pct / 100)), 2);
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
  if (drawProp(g, 'chair', seat.x - 9, seat.y - 26, 18, 25)) return;
  rr(g, seat.x - 9, seat.y - 24, 18, 8, '#3c3c46', INK);
}

function drawDesk(g, seat, working, t, emp) {
  const x = seat.x, y = seat.y;
  const deskKey = emp && emp.deskType === 'exec' ? 'desk_exec' : 'desk1';
  if (OFFICE[deskKey]) {
    drawProp(g, deskKey, x - 25, y + 4, 50, 29);
  } else {
    rr(g, x - 24, y + 6, 48, 7, '#f4f2ee', INK);
    rr(g, x - 24, y + 13, 48, 11, '#dddbd4', INK);
  }
  const pc = (emp && emp.pc) || 'mon1';
  if (working) {
    g.fillStyle = 'rgba(150,220,255,.22)';
    g.fillRect(x - 12, y - 10, 24, 12);            // 画面の光がキャラ側へ漏れる
  }
  if (OFFICE.mon1b) {
    if (pc === 'mon2') { drawProp(g, 'mon1b', x - 15, y + 2, 15, 11); drawProp(g, 'mon1b', x, y + 2, 15, 11); }
    else if (pc === 'laptop') drawProp(g, 'laptopb', x - 9, y + 5, 18, 12);
    else drawProp(g, 'mon1b', x - 8, y + 2, 16, 12);
    g.fillStyle = working ? '#4cff8e' : '#555a60';
    g.fillRect(x + (pc === 'mon2' ? 12 : 6), y + 12, 2, 2);
  } else {
    rr(g, x - 9, y - 1, 18, 11, '#23252d', INK);
    g.fillStyle = working ? '#4cff8e' : '#555a60';
    g.fillRect(x + 6, y + 7, 2, 2);
  }
}

function drawOffice(g, t, tm) {
  const hour = tm.h + tm.m / 60;
  const night = hour >= 19 || hour < 6;

  if (OFFICE.bg) {
    // ユーザー製パーツのオフィス全景を背景に(壁・床・掲示板・時計・看板込み)
    g.save(); g.imageSmoothingEnabled = true;
    g.drawImage(OFFICE.bg, 0, 0, W, H);
    g.restore();
    rr(g, 288, 322, 74, 22, '#f2e4c2');  // bg側の入口表記を床色でならす(入口マットは下で描く)
    // ホワイトボードに社訓
    g.font = '8px DotGothic16';
    const bcx = 284;
    const btitle = '《社訓》';
    g.fillStyle = '#b04a3c';
    g.fillText(btitle, bcx - g.measureText(btitle).width / 2, 15);
    g.fillStyle = 'rgba(74,59,42,.92)';
    (CFG.mottos || []).slice(0, 3).forEach((m, k) => {
      const line = String(m).slice(0, 7);
      g.fillText(line, bcx - g.measureText(line).width / 2, 25 + k * 9);
    });
    // 時計: 下絵を完全に覆う文字盤+リアル時刻
    const ccx = 353, ccy = 30;
    g.fillStyle = '#8a6a4a';
    g.beginPath(); g.arc(ccx, ccy, 18, 0, 7); g.fill();
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
    // 看板に社名とYT登録者
    g.font = '13px DotGothic16'; g.fillStyle = '#f0d890';
    g.fillText('MON-AI Inc.', 489, 24);
    g.font = '8px DotGothic16'; g.fillStyle = '#e8d0a0';
    const subs = snap && snap.youtube && snap.youtube.subs != null ? snap.youtube.subs.toLocaleString('ja-JP') + '人' : '---';
    g.fillText(`YT登録者 ${subs} / 目標${(CFG.youtubeGoal || 0).toLocaleString('ja-JP')}`, 487, 40);
    // 保留タスク台帳の件数バッジ
    const n = snap && snap.tasks && snap.tasks.count != null ? snap.tasks.count : 0;
    g.font = '9px DotGothic16';
    const bt = `保留 ${n}件`;
    const bw = g.measureText(bt).width + 16;
    g.fillStyle = 'rgba(255,253,246,.94)';
    g.beginPath(); g.roundRect(100.5, 46.5, bw, 13, 3); g.fill();
    g.strokeStyle = 'rgba(74,59,42,.35)'; g.stroke();
    g.fillStyle = '#e05a4e'; g.beginPath(); g.arc(107, 53, 2.5, 0, 7); g.fill();
    g.fillStyle = '#4a3b2a'; g.fillText(bt, 113, 56);
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
    g.font = '9px DotGothic16'; g.fillStyle = '#e8d0a0';
    const subs = snap && snap.youtube && snap.youtube.subs != null ? snap.youtube.subs.toLocaleString('ja-JP') + '人' : '---';
    g.fillText(`YT登録者 ${subs} / 目標${(CFG.youtubeGoal || 0).toLocaleString('ja-JP')}`, 424, 33);

  }

  // ラグ(部署) — ユーザー製カーペットパーツ
  if (!drawProp(g, 'rug_ceo', 16, 72, 104, 100)) rr(g, 16, 72, 104, 100, '#e0c8e8', '#c0a0c8');
  if (!drawProp(g, 'rug_pt', 138, 72, 184, 100)) rr(g, 138, 72, 184, 100, '#c8dce8', '#a0bcd0');
  if (!drawProp(g, 'rug_app', 336, 72, 116, 100)) rr(g, 336, 72, 116, 100, '#d0e8c8', '#a8cca0');
  if (!drawProp(g, 'rug_yoru', 468, 72, 120, 100)) rr(g, 468, 72, 120, 100, '#f0e0c0', '#d0c098');
  if (!drawProp(g, 'room_break', 16, 208, 176, 136)) rr(g, 16, 208, 176, 136, '#ecd8c0', '#d0b898');
  if (!drawProp(g, 'rug_soumu', 216, 232, 152, 104)) rr(g, 216, 232, 152, 104, '#e8e4c8', '#c8c4a0');
  function deptSign(text, x, y, color) {
    g.font = '9px DotGothic16';
    const w = g.measureText(text).width + 14;
    g.fillStyle = 'rgba(0,0,0,.15)';
    g.beginPath(); g.roundRect(x + 1.5, y + 1.5, w, 14, 3); g.fill();
    g.fillStyle = 'rgba(40,42,54,.92)';
    g.beginPath(); g.roundRect(x + .5, y + .5, w, 14, 3); g.fill();
    g.fillStyle = color; g.fillRect(x + 4, y + 4, 3, 7);
    g.fillStyle = '#f2f0e8'; g.fillText(text, x + 10, y + 11);
  }
  deptSign('社長室', 20, 75, '#b06ac0');
  deptSign('プロジェクト-T', 142, 75, '#4a7ac8');
  deptSign('アプリ制作部', 340, 75, '#4aa86a');
  deptSign('yorutool制作部', 472, 75, '#c8a04a');
  deptSign('総務部', 220, 236, '#d08a5a');

  // 音声スタジオ(TTS=watcher。人は住まない=機械の部屋)
  if (!drawProp(g, 'room_studio', 488, 224, 132, 112)) {
    rr(g, 488, 224, 132, 112, '#e8e0f0', '#b0a8c0');
    g.strokeStyle = INK; g.lineWidth = 2;
    g.strokeRect(489, 225, 130, 110);
    g.fillStyle = '#e8e0f0'; g.fillRect(487, 258, 4, 44);
    g.lineWidth = 1;
  }
  deptSign('音声スタジオ', 494, 230, '#8a6ac8');
  const onAir = snap && snap.launchd && snap.launchd['com.mon.tsuki.watcher'] && snap.launchd['com.mon.tsuki.watcher'].running;
  rr(g, 560, 228, 34, 12, onAir ? '#e05a4e' : '#706860', INK);
  g.fillStyle = '#fff'; g.font = '8px DotGothic16'; g.fillText('ON AIR', 563, 237);
  // マイク+TTS機(稼働中は波形が動く)
  rr(g, 543, 252, 2, 14, '#6a6a74');
  rr(g, 541, 248, 6, 6, '#3a3a44', INK);
  if (!drawProp(g, 'tower', 500, 258, 22, 44)) rr(g, 500, 262, 22, 40, '#3a3a44', INK);
  rr(g, 526, 268, 22, 16, '#2a2a34', INK);
  g.fillStyle = onAir ? (Math.floor(t / 500) % 2 ? '#5aff8e' : '#4caf6e') : '#e05a4e';
  g.fillRect(528, 270, 3, 3);
  g.fillStyle = onAir ? '#4a9a6a' : '#5a5a64';
  for (let i = 0; i < 4; i++) {
    const hgt = onAir ? 2 + Math.floor(Math.abs(Math.sin(t / 180 + i)) * 8) : 2;
    g.fillRect(533 + i * 4, 282 - hgt, 2, hgt);
  }
  g.font = '8px DotGothic16'; g.fillStyle = 'rgba(74,59,42,.65)';
  g.fillText('TTS機', 502, 312);
  if (!onAir) { g.fillStyle = '#e05a4e'; g.fillText('停止中!', 540, 312); }

  // 撮影スタジオ(グリーンバック・カメラ・照明)
  if (!drawProp(g, 'room_film', 384, 232, 92, 104)) rr(g, 384, 232, 92, 104, '#e0e8e8', '#b0c0c0');
  deptSign('撮影スタジオ', 388, 236, '#5a8a9a');
  rr(g, 392, 250, 76, 28, '#4ac858', '#2a8a3a');
  rr(g, 394, 278, 4, 8, '#6a6a74'); rr(g, 462, 278, 4, 8, '#6a6a74');
  drawProp(g, 'tvstand', 396, 292, 26, 34);
  drawProp(g, 'projcart', 438, 294, 24, 32);

  // 休憩室(上=キッチン家電 / 下=ソファセット / 中央band y250-280は室内通路)
  drawProp(g, 'coffee_st', 20, 208, 30, 36);
  drawProp(g, 'fridge', 54, 208, 21, 36);
  if (!drawProp(g, 'vending', 80, 206, 24, 40)) rr(g, 80, 210, 24, 36, '#d05a5a', INK);
  drawProp(g, 'snack', 108, 210, 28, 36);
  drawProp(g, 'plant_a', 164, 210, 22, 34);
  if (!drawProp(g, 'sofa', 20, 286, 60, 30)) {
    rr(g, 24, 296, 52, 20, '#7a9ac8', INK);
  }
  drawProp(g, 'armchair', 96, 286, 26, 32);
  drawProp(g, 'ctable', 24, 322, 48, 18);
  deptSign('休憩室', 140, 254, '#8a9a5a');

  // ウォーターサーバーは休憩室内、コピー機は機材コーナーへ
  drawProp(g, 'cooler', 166, 248, 20, 36);

  // 機材コーナー(右壁): コレクター=サーバーラック / ルーチン基盤=ネットワークキャビネット
  const fresh = lastArrivalT >= 0 && (t - lastArrivalT) < 30000;
  const dead = snapAt > 0 && (Date.now() - snapAt) > (CFG.staleMin || 20) * 60000;
  if (OFFICE.rack) {
    drawProp(g, 'rack', 566, 148, 26, 46);
    drawProp(g, 'netcab', 594, 158, 22, 36);
  } else {
    rr(g, 584, 150, 26, 44, '#3a3a44', INK);
    rr(g, 612, 160, 22, 34, '#4a4a54', INK);
  }
  g.fillStyle = dead ? '#e05a4e' : fresh ? (Math.floor(t / 300) % 2 ? '#5aff8e' : '#4caf6e') : '#4caf6e';
  g.fillRect(568, 150, 5, 3);
  g.font = '8px DotGothic16';
  g.fillStyle = dead ? '#e05a4e' : 'rgba(74,59,42,.75)';
  g.fillText(dead ? '受信断!' : fresh ? '受信中' : '待受', 566, 206);
  g.fillStyle = 'rgba(74,59,42,.55)';
  g.fillText('コレクター/基盤', 560, 216);
  drawProp(g, 'copier', 532, 160, 26, 32);

  // 社長室の調度・入口まわり
  drawProp(g, 'lamp', 96, 102, 17, 37);
  drawProp(g, 'plant_mon', 20, 74, 20, 36);
  drawProp(g, 'plant_snake', 566, 76, 16, 30);
  drawProp(g, 'coat', 282, 310, 16, 36);
  drawProp(g, 'umbrella', 346, 320, 12, 26);

  // ミーティングスペース(丸テーブル)
  drawProp(g, 'meeting', 404, 190, 42, 42);

  // 入口マット
  rr(g, 296, 344, 48, 12, '#c0a878', '#a08858');
  g.fillStyle = 'rgba(74,59,42,.5)'; g.font = '8px DotGothic16'; g.fillText('入口', 312, 353);

  return night;
}

/* ================================================================
   人の移動(共通)
   ================================================================ */
const LANE_Y = 184;
function aisleX(seat) { return seat.x - 32; }

// 部屋の中の地点から廊下(LANE_Y)までの退出経路。机・什器を突っ切らない
function outPath(pt) {
  const { x, y } = pt;
  if (y < 160) return [{ x, y: LANE_Y }];                                                   // 上段: 座席は机の下なので直進
  if (y > 210 && x >= 216 && x <= 368) return [{ x, y: 328 }, { x: 376, y: 328 }, { x: 376, y: LANE_Y }]; // 総務部: 机の下→右から出る
  if (y > 210 && x < 210) return [{ x, y: 274 }, { x: 150, y: 274 }, { x: 150, y: LANE_Y }]; // 休憩室: 室内通路y274→入口列x150
  if (y > 224 && x > 470) return [{ x: 460, y: 280 }, { x: 460, y: LANE_Y }];               // スタジオ側
  return [{ x, y: LANE_Y }];
}

function route(from, to) {
  const a = outPath(from);
  const b = outPath(to);
  const pts = [...a, ...b.slice().reverse(), { x: to.x, y: to.y }];
  return pts.filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.y !== arr[i - 1].y);
}

class Person {
  constructor(def, i) {
    this.def = def;
    Object.assign(this, def);
    this.seed = (i + 1) * 977;
    this.pos = def.desk ? { x: def.desk.x, y: def.desk.y } : { x: 318, y: 340 };
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
    if (!this.present) { this.pos = { x: 318, y: 348 }; this.present = true; }
    if (Math.hypot(target.x - this.pos.x, target.y - this.pos.y) < 3) {
      this.pos = { x: target.x, y: target.y };
      this.path = [];
      this.applyArrival(0);
      return;
    }
    this.path = route(this.pos, target);
    this.action = 'walk';
  }

  applyArrival(t) {
    const a = this.arrival;
    if (a === 'leave') { this.present = false; this.action = 'gone'; }
    else if (a === 'sit' || a === 'sleep') {
      if (this.arrivalSitY != null) { this.pos = { x: this.pos.x, y: this.arrivalSitY }; this.arrivalSitY = null; }
      this.action = a; this.dir = 'down';
    }
    else if (a === 'coffee') { this.action = 'coffee'; this.dir = 'left'; this.coffeeUntil = t + 6000; }
    else if (a === 'faceL') { this.action = 'stand'; this.dir = 'left'; }
    else if (a === 'faceR') { this.action = 'stand'; this.dir = 'right'; }
    else if (a === 'faceU') { this.action = 'stand'; this.dir = 'up'; }
    else { this.action = 'stand'; this.dir = 'down'; }
  }

  stepMove(dt, t) {
    if (this.action === 'walk' && this.path.length) {
      const sp = this.speed * dt / 1000;
      const target = this.path[0];
      const dx = target.x - this.pos.x, dy = target.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= sp) {
        this.pos = { x: target.x, y: target.y };
        this.path.shift();
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
  { x: 34, y: 312, sy: 312, a: 'sit', via: 278 },   // ソファ左
  { x: 60, y: 312, sy: 312, a: 'sit', via: 278 },   // ソファ右
  { x: 108, y: 314, sy: 314, a: 'sit', via: 278 },  // アームチェア
  { x: 34, y: 272, a: 'faceU' },                    // コーヒー前
  { x: 92, y: 274, a: 'faceU' },                    // 自販機前
  { x: 121, y: 274, a: 'faceU' },                   // スナック棚前
  { x: 176, y: 292, a: 'faceU' },                   // 給水機前
];
function pickRestSpot() {
  const free = REST_SPOTS.filter(sp => !sp.busy);
  if (!free.length) return null;
  return free[Math.floor(Math.random() * free.length)];
}
const REST_TALK = ['ふぅ…ひと息', '指示待ちの休憩なう', 'コーヒーうまい', '次の仕事まだかな', '(サボってるわけでは…)'];

class Employee extends Person {
  constructor(def, i) {
    super(def, i);
    this.seat = { x: def.desk.x, y: def.desk.y };
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
    if (m !== 'idle') { this.resting = false; this.releaseSpot(); }
    if (m === 'working') this.goto(this.seat, 'sit');
    else if (m === 'sleep') this.goto(this.seat, 'sleep');
    else if (m === 'off' || m === 'out' || m === 'sleephome') this.goto({ x: 318, y: 348 }, 'leave');
    else this.nextThink = 0;
  }

  releaseSpot() {
    if (this.restSpot) { this.restSpot.busy = false; this.restSpot = null; }
  }

  takeSpot(sp) {
    this.releaseSpot();
    sp.busy = true;
    this.restSpot = sp;
    this.arrivalSitY = sp.sy || null;
    this.goto(sp.via ? { x: sp.x, y: sp.via } : sp, sp.a);
  }

  think(t, tm) {
    if (this.action === 'walk') return;
    if (this.mode !== 'idle' || t < this.nextThink) return;
    if (!this.resting) {
      const sp = pickRestSpot();                 // 指示待ちは休憩室へ
      if (sp) { this.resting = true; this.takeSpot(sp); }
      this.nextThink = t + 20000 + Math.random() * 20000;
      return;
    }
    if (Math.random() < 0.3) {
      const sp = pickRestSpot();
      if (sp) this.takeSpot(sp);                 // 休憩室内で場所替え
    }
    if (Math.random() < 0.5) this.say(t + 600, REST_TALK[Math.floor(Math.random() * REST_TALK.length)]);
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
    const img = SHEETS[this.spriteId || this.id];
    if (img) {
      const dir = seated ? 'down' : this.dir;
      const fi = 1;
      let bob = 0;
      if (this.action === 'walk') bob = Math.floor(this.walked / 7) % 2 ? -1 : 0;   // コマ固定+縦ボブ(左右ブレなし)
      else if (this.mode === 'working' && seated && Math.floor((t + this.seed) / 420) % 2) bob = -1;
      const cb = seated && this.resting ? 0.30 : 0;   // ソファ等では脚をクッションに沈める
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
    if (e === 'sleep') drawZzz(g, x, y - 12, t + this.seed);
    if (this.mode === 'panic') drawAlert(g, x, y - 10, t);
    if (this.hp != null) drawHp(g, x, y - 12, this.hp);
    g.font = '9px DotGothic16';
    const nw = g.measureText(this.name).width;
    const ny = seated ? y + 36 : y + 3;
    g.fillStyle = 'rgba(255,250,240,.9)';
    g.fillRect(x - nw / 2 - 3, ny, nw + 6, 11);
    g.fillStyle = INK;
    g.fillText(this.name, x - nw / 2, ny + 9);
    if (this.action === 'coffee') { g.font = '9px DotGothic16'; g.fillText('☕', x + 8, y - 8); }
    // 作業タグ: いま何をしているかを常時表示
    if (this.mode === 'working' && seated && this.jobText) {
      g.font = '8px DotGothic16';
      const jt = this.jobText.length > 10 ? this.jobText.slice(0, 9) + '…' : this.jobText;
      const jw = g.measureText(jt).width + 8;
      g.fillStyle = 'rgba(40,42,54,.88)';
      g.beginPath(); g.roundRect(x - jw / 2 + .5, y - 42.5, jw, 12, 3); g.fill();
      g.fillStyle = '#5aff9e'; g.fillRect(x - jw / 2 + 3, y - 39, 2, 5);
      g.fillStyle = '#f0f0e8'; g.fillText(jt, x - jw / 2 + 7, y - 33);
    }
    if (this.bubble && t < this.bubbleUntil) drawBubble(g, x, y - 16 - (this.seed % 3) * 7, this.bubble);
  }

  tickBubble(t) {
    if (!this.present || !this.bubbles.length || this.inChat || this.mode === 'working') return;
    if (t > this.nextBubble) {
      this.say(t, this.bubbles[Math.floor(Math.random() * this.bubbles.length)], 3800);
      this.nextBubble = t + 16000 + Math.random() * 22000;
    }
  }
}

const employees = CFG.employees.map((d, i) => new Employee(d, i));

/* ================================================================
   雑談(スタッフ同士のコミュニケーション。ネタは実データ)
   ================================================================ */
const chat = { next: 25000, active: null };

function makeChatLines() {
  const pool = [
    ['ランチどこ行きます?', 'ラーメン一択でしょ'],
    ['最近調子どうですか', 'ぼちぼちですね〜'],
    ['社訓見ました?', '「無限労働」て…'],
    ['コーヒー切れてますよ', 'えっ、それは事件'],
    ['今日も1日がんばりましょ', 'おー!'],
  ];
  if (snap) {
    const rate = (snap.billing && snap.billing.jpyPerUsd) || 155;
    const cost = snap.totals.todayCost || 0;
    pool.push([`今日もう${fmtYen(cost * rate)}分働いたって`, 'AIはタフだね〜']);
    if (snap.youtube && snap.youtube.subs != null) {
      pool.push([`登録者${snap.youtube.subs}人になったね`, `目標は${(CFG.youtubeGoal || 0).toLocaleString('ja-JP')}人!`]);
    }
    if (snap.tasks && snap.tasks.count) {
      pool.push([`保留タスク${snap.tasks.count}件だって`, '社長ファイトです…']);
    }
    if (snap.claude.block && snap.claude.block.remainingMinutes != null && snap.claude.block.remainingMinutes < 90) {
      pool.push(['伊藤さん5h枠もうすぐらしい', 'ちょっと休ませよう']);
    }
    if (snap.deliveries && snap.deliveries.daihon) {
      pool.push([`台本もう${snap.deliveries.daihon}本納品って`, '月城さんさすが']);
    }
    if (snap.codex.rateLimit) {
      pool.push([`コデックス週次残り${Math.max(0, Math.round(100 - snap.codex.rateLimit.usedPercent))}%`, 'ペース配分だいじ']);
    }
  }
  const l1 = pool[Math.floor(Math.random() * pool.length)];
  const l2 = pool[Math.floor(Math.random() * pool.length)];
  return l1 === l2 ? l1 : [...l1, ...l2];
}

function stepChat(t) {
  if (chat.active) {
    const c = chat.active;
    if (c.a.mode !== 'idle' || c.b.mode !== 'idle' || !c.a.present || !c.b.present) {
      c.a.inChat = c.b.inChat = false;
      chat.active = null;
      chat.next = t + 45000;
      return;
    }
    if (t > c.nextLine) {
      const line = c.lines[c.li];
      if (line == null) {
        c.a.inChat = c.b.inChat = false;
        chat.active = null;
        chat.next = t + 60000 + Math.random() * 90000;
        return;
      }
      (c.li % 2 === 0 ? c.a : c.b).say(t, line, 3600);
      c.li++;
      c.nextLine = t + 4000;
    }
    return;
  }
  if (t < chat.next) return;
  const idlers = employees.filter(e => e.present && e.mode === 'idle' && e.action !== 'walk');
  if (idlers.length < 2) { chat.next = t + 30000; return; }
  // 近い者同士で雑談(隣の席・同じ休憩室など)
  let best = null, bestD = 1e9;
  for (let i = 0; i < idlers.length; i++) for (let j = i + 1; j < idlers.length; j++) {
    const d = Math.hypot(idlers[i].pos.x - idlers[j].pos.x, idlers[i].pos.y - idlers[j].pos.y);
    if (d < bestD) { bestD = d; best = [idlers[i], idlers[j]]; }
  }
  if (!best || bestD > 220) { chat.next = t + 30000; return; }
  const [a, b] = best;
  a.inChat = b.inChat = true;
  chat.active = { a, b, lines: makeChatLines(), li: 0, nextLine: t + 500 };
}


const dog = { pos: { x: 90, y: 150 }, target: null, next: 4000, napUntil: 0, dir: 1 };
function stepDog(dt, t) {
  if (t < dog.napUntil) return;
  if (!dog.target) {
    if (t > dog.next) {
      if (Math.random() < 0.35) { dog.napUntil = t + 12000 + Math.random() * 18000; dog.next = dog.napUntil; return; }
      const spots = [{ x: 90, y: 192 }, { x: 200, y: 195 }, { x: 300, y: 198 }, { x: 380, y: 194 }, { x: 470, y: 200 }, { x: 150, y: 290 }];
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

function drawCat(g, t) {
  const { x, y } = cat.pos;
  const nap = t < cat.napUntil;
  g.save(); g.translate(Math.round(x), Math.round(y));
  if (cat.dir < 0) g.scale(-1, 1);
  g.fillStyle = '#fff';
  if (nap) {
    g.fillRect(-5, -4, 10, 4);
    g.fillRect(-6, -6, 4, 3);
  } else {
    const hop = cat.target && Math.floor(t / 200) % 2 ? -1 : 0;
    g.fillRect(-4, -6 + hop, 8, 5);
    g.fillRect(2, -9 + hop, 4, 4);
    g.fillStyle = '#f0a0b0'; g.fillRect(3, -10 + hop, 1, 1); g.fillRect(5, -10 + hop, 1, 1);
    g.fillStyle = INK; g.fillRect(4, -8 + hop, 1, 1);
    g.fillStyle = '#fff'; g.fillRect(-6, -8 + hop, 2, 4);
  }
  g.restore();
  if (nap) drawZzz(g, x, y - 2, t);
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
  const blockHp = blk && blk.remainingMinutes != null ? Math.max(0, Math.min(100, Math.round(blk.remainingMinutes / 3))) : 100;

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
        e.bubbles = ['指示待ちです', 'いつでもどうぞ'];
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
        e.bubbles = ['次のタスクどうぞ'];
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
    } else if (e.source === 'boss') {
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
        e.bubbles = [`保留タスク ${tc ?? '-'}件`, '現場は任せた!', `今日は ${fmtYen((s.totals.todayCost || 0) * rate)} 分働いてる`];
      } else {
        e.setMode('idle');
        e.jobText = `保留 ${tc ?? '-'}件を検討中`;
        e.bubbles = [`保留タスク ${tc ?? '-'}件…`, '次は何を仕込むか'];
      }
    }
  }

}

/* ================================================================
   HUD
   ================================================================ */
const $ = id => document.getElementById(id);
const CHIP = {
  working: ['work', '稼働中'], idle: ['idle', '待機'], break: ['rest', '休憩'],
  sleep: ['sleep', '睡眠'], off: ['off', '退勤'], panic: ['panic', '停止!'],
  out: ['off', '外出中'], sleephome: ['sleep', '就寝中'],
};

function updateHud() {
  const tm = jstNow();
  $('time').textContent = tm.hm;
  $('date').textContent = tm.dateStr;
  if (!snap) return;
  const s = snap, rate = (s.billing && s.billing.jpyPerUsd) || 155;

  const tv = s.totals.todayCost || 0;
  const subsCfg = CFG.subscriptions || (s.billing && s.billing.subscriptions) || [];
  const fixedMonthly = subsCfg.reduce((a, x) => a + (x.monthlyJPY || 0), 0);
  const dim = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
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
    div.innerHTML = `<span class="lbl">Codexプラン検出</span><span>${s.codex.rateLimit.plan}</span>`;
    subs.appendChild(div);
  }

  const roster = $('roster');
  roster.innerHTML = '';
  for (const e of employees) {
    let [cls, label] = CHIP[e.mode] || CHIP.idle;
    if (e.mode === 'idle' && e.resting) [cls, label] = CHIP.break;
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
    mid.innerHTML = `<div class="nm">${e.name} <span class="rl">${e.dept}・${e.role}</span></div>`;
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
    yt.innerHTML = `<span>📺 登録者 <b>${s.youtube.subs.toLocaleString('ja-JP')}</b>人</span><span>🎯 目標比 <b>${pct}%</b></span><span>🎬 動画 <b>${(s.youtube.videos ?? '-').toLocaleString ? s.youtube.videos.toLocaleString('ja-JP') : s.youtube.videos}</b>本</span>`;
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
    li.innerHTML = `<b>${it.id}</b>${it.text}`;
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
  const dt = Math.min(100, t - last);
  last = t;
  const tm = jstNow();

  for (const e of employees) { e.think(t, tm); e.step(dt, t); e.tickBubble(t); }
  stepChat(t);
  stepDog(dt, t);
  stepParticles(dt);

  // 環境パーティクル
  if (t - lastAmbient > 600) {
    lastAmbient = t;
    const onAirNow = snap && snap.launchd && snap.launchd['com.mon.tsuki.watcher'] && snap.launchd['com.mon.tsuki.watcher'].running;
    if (onAirNow && Math.random() < 0.35) {
      spawnParticle('note', 512 + Math.random() * 14, 258);
    }
  }

  cx.clearRect(0, 0, W, H);
  const night = drawOffice(cx, t, tm);

  const items = [];
  for (const e of employees) {
    items.push({ y: e.seat.y - 27, draw: g => drawChair(g, e.seat) });
    items.push({ y: e.desk.y + 20, draw: g => drawDesk(g, e.desk, e.mode === 'working' && e.present, t + e.seed, e.def) });
  }
  // ソファ前面(座ったキャラの脚を隠す)
  for (const e of employees) if (e.present) items.push({ y: e.pos.y, draw: g => e.drawSprite(g, t) });
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw(cx);
  drawDog(cx, t);
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
  requestAnimationFrame(loop);
}

/* ---------- 起動 ---------- */
(async () => {
  fitCanvas();
  try { await document.fonts.load('9px DotGothic16'); await document.fonts.load('13px DotGothic16'); } catch {}
  await poll();
  setInterval(poll, (CFG.pollSec || 60) * 1000);
  setInterval(updateHud, 10000);
  requestAnimationFrame(t => { last = t; loop(t); });
})();
