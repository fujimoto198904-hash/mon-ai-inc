/* MON-AI Inc. — ドット絵AIオフィス エンジン v2 */
'use strict';

const CFG = window.OFFICE_CONFIG;
const W = 640, H = 360;
const cv = document.getElementById('office');
const cx = cv.getContext('2d');
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

/* ---------- ポートレート(assets/ にGPT素材が置かれたら自動採用) ---------- */
const portraits = {};
for (const d of CFG.employees) {
  const img = new Image();
  img.onload = () => { portraits[d.id] = img; };
  img.src = `assets/${d.portrait || d.id}.png`;
}

/* ================================================================
   スプライト: チビキャラ 12x16
   ================================================================ */
const SKIN = '#f8d8b8', INK = '#4a3b2a';

function drawChar(g, px, py, emp, dir, frame, expr, t) {
  px = Math.round(px); py = Math.round(py);
  g.save();
  g.translate(px - 6, py - 16);
  const hair = emp.hair, shirt = emp.shirt;
  const walk = (dir !== 'sit' && frame % 2 === 1);
  const bob = walk ? 1 : 0;

  // 脚
  g.fillStyle = '#5a4a6a';
  if (dir === 'sit') {
    g.fillRect(3, 14, 6, 2);
  } else if (walk) {
    g.fillRect(3, 13, 2, 3); g.fillRect(7, 14, 2, 2);
  } else {
    g.fillRect(3, 13, 2, 3); g.fillRect(7, 13, 2, 3);
  }
  // 体
  g.fillStyle = shirt;
  g.fillRect(2, 9 + bob, 8, 5 - bob);
  // 腕
  const typing = expr === 'typing' && Math.floor(t / 160) % 2 === 0;
  g.fillStyle = shirt;
  if (dir === 'sit') {
    g.fillRect(1, 10 + (typing ? 1 : 0), 2, 3);
    g.fillRect(9, 10 + (typing ? 0 : 1), 2, 3);
  } else {
    g.fillRect(1, 9 + bob, 2, 4); g.fillRect(9, 9 + bob, 2, 4);
  }
  // 頭
  g.fillStyle = SKIN;
  g.fillRect(2, 2 + bob, 8, 7);
  // 髪
  g.fillStyle = hair;
  g.fillRect(1, 0 + bob, 10, 3);
  g.fillRect(1, 2 + bob, 2, 3); g.fillRect(9, 2 + bob, 2, 3);
  if (emp.id === 'mon') { g.fillRect(1, 0 + bob, 10, 2); g.fillRect(0, 1 + bob, 2, 2); }
  if (emp.id === 'watcher') { g.fillStyle = '#8a7ab0'; g.fillRect(0, 0 + bob, 3, 2); g.fillRect(9, 0 + bob, 3, 2); } // ヘッドホン
  if (dir === 'up') { g.fillStyle = hair; g.fillRect(2, 2 + bob, 8, 6); g.restore(); return; }

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
  g.font = '9px DotGothic16';
  const lines = [];
  let s = String(text);
  while (s.length && lines.length < 2) { lines.push(s.slice(0, 12)); s = s.slice(12); }
  if (s.length) lines[1] = lines[1].slice(0, 11) + '…';
  const w = Math.max(...lines.map(l => g.measureText(l).width)) + 8;
  const h = lines.length * 10 + 6;
  let bx = Math.min(Math.max(4, x - w / 2), W - w - 4);
  const by = Math.max(4, y - 24 - h);
  g.fillStyle = 'rgba(255,255,255,.95)';
  g.strokeStyle = INK; g.lineWidth = 1;
  g.beginPath(); g.roundRect(bx + .5, by + .5, w, h, 3); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(x - 2, by + h); g.lineTo(x + 2, by + h); g.lineTo(x, by + h + 4); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = INK;
  lines.forEach((l, i) => g.fillText(l, bx + 4, by + 10 + i * 10));
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

function drawDesk(g, seat, working, t) {
  const dx = seat.x - 16, dy = seat.y + 6;
  rr(g, dx, dy, 32, 16, '#b8905c', INK);
  rr(g, dx + 2, dy + 14, 3, 4, '#8a6a3c'); rr(g, dx + 27, dy + 14, 3, 4, '#8a6a3c');
  rr(g, dx + 10, dy - 8, 12, 9, '#3a3a44', INK);
  if (working) {
    g.fillStyle = '#c8f0d8'; g.fillRect(dx + 11, dy - 7, 10, 7);
    g.fillStyle = '#4a9a6a';
    for (let i = 0; i < 3; i++) {
      const lw = 3 + ((t / 300 + i * 2.7) % 6);
      g.fillRect(dx + 12, dy - 6 + i * 2, Math.min(8, lw), 1);
    }
  } else {
    g.fillStyle = '#586068'; g.fillRect(dx + 11, dy - 7, 10, 7);
  }
  rr(g, dx + 14, dy + 1, 4, 2, '#2a2a34');
  rr(g, dx + 25, dy + 3, 5, 4, '#fff', '#c0b090');
}

function drawOffice(g, t, tm) {
  const hour = tm.h + tm.m / 60;
  const night = hour >= 19 || hour < 6;

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

  // ラグ
  rr(g, 16, 60, 144, 92, '#e0c8e8', '#c0a0c8');    // 社長室
  rr(g, 184, 60, 140, 104, '#c8dce8', '#a0bcd0');  // 開発部(2列5席)
  rr(g, 368, 60, 208, 92, '#d0e8c8', '#a8cca0');   // 制作部
  rr(g, 16, 208, 176, 136, '#ecd8c0', '#d0b898');  // 休憩室
  rr(g, 240, 240, 128, 76, '#e0e0e8', '#b8b8c8');  // 機材室(システムはツールとして置く)
  g.font = '9px DotGothic16'; g.fillStyle = 'rgba(74,59,42,.55)';
  g.fillText('社長室', 26, 72); g.fillText('開発部', 194, 72); g.fillText('コンテンツ制作部', 378, 72);
  g.fillText('休憩室', 26, 222); g.fillText('機材室', 248, 252);

  // 収録スタジオ
  rr(g, 488, 224, 132, 112, '#e8e0f0', '#b0a8c0');
  g.strokeStyle = INK; g.lineWidth = 2;
  g.strokeRect(489, 225, 130, 110);
  g.fillStyle = '#e8e0f0'; g.fillRect(487, 258, 4, 44);
  g.lineWidth = 1;
  g.fillStyle = 'rgba(74,59,42,.55)'; g.fillText('収録スタジオ', 496, 240);
  const onAir = snap && snap.launchd && snap.launchd['com.mon.tsuki.watcher'] && snap.launchd['com.mon.tsuki.watcher'].running;
  rr(g, 560, 228, 34, 12, onAir ? '#e05a4e' : '#706860', INK);
  g.fillStyle = '#fff'; g.font = '8px DotGothic16'; g.fillText('ON AIR', 563, 237);
  // マイクスタンド
  rr(g, 533, 252, 2, 14, '#6a6a74');
  rr(g, 531, 248, 6, 6, '#3a3a44', INK);
  // 防音壁模様
  g.fillStyle = 'rgba(120,110,150,.25)';
  for (let i = 0; i < 5; i++) g.fillRect(494 + i * 25, 300, 12, 24);

  // 休憩室の什器
  rr(g, 24, 228, 16, 26, '#8a8a96', INK);
  rr(g, 27, 232, 10, 7, '#4a3b2a');
  g.fillStyle = '#e05a4e'; g.fillRect(28, 246, 3, 3);
  if (Math.floor(t / 500) % 3) { g.fillStyle = 'rgba(200,200,210,.7)'; g.fillRect(31, 222 - Math.floor(t / 250) % 4, 2, 3); }
  rr(g, 52, 222, 20, 32, '#d05a5a', INK);
  g.fillStyle = '#fff'; g.fillRect(55, 226, 14, 10);
  g.fillStyle = '#5ab0e8'; g.fillRect(55, 227, 4, 4);
  g.fillStyle = '#e8b93c'; g.fillRect(60, 227, 4, 4);
  g.fillStyle = '#4caf6e'; g.fillRect(65, 227, 4, 4);
  rr(g, 40, 306, 52, 20, '#7a9ac8', INK);
  rr(g, 40, 302, 52, 8, '#8aaad8', INK);
  rr(g, 120, 276, 28, 18, '#b8905c', INK);
  rr(g, 126, 272, 6, 6, '#fff', '#c0b090');
  rr(g, 168, 214, 12, 6, '#a06a3c');
  g.fillStyle = '#4caf6e';
  g.fillRect(170, 202, 8, 12); g.fillRect(166, 206, 6, 6); g.fillRect(176, 205, 6, 7);

  // ウォーターサーバー / プリンタ
  rr(g, 404, 240, 10, 22, '#d8e8f0', INK);
  rr(g, 406, 234, 6, 8, '#8ec8e8', INK);
  rr(g, 400, 296, 26, 14, '#b8905c', INK);
  rr(g, 404, 288, 18, 10, '#8a8a96', INK);
  if (Math.floor(t / 700) % 4 === 0) { g.fillStyle = '#fff'; g.fillRect(407, 296, 12, 2); }

  // コレクター受信ラック(実machine: launchd com.mon.ai-office が5分毎にpush)
  rr(g, 256, 248, 40, 56, '#3a3a44', INK);
  g.fillStyle = '#2a2a34'; g.fillRect(258, 250, 36, 52);
  for (let row = 0; row < 5; row++) {
    for (let led = 0; led < 4; led++) {
      const on = Math.floor(t / 400 + row * 1.7 + led * 2.3) % 5 !== 0;
      g.fillStyle = on ? (led % 2 ? '#4caf6e' : '#e8b93c') : '#3a3a44';
      g.fillRect(262 + led * 8, 254 + row * 9, 3, 2);
    }
  }
  const fresh = lastArrivalT >= 0 && (t - lastArrivalT) < 30000;
  const dead = snapAt > 0 && (Date.now() - snapAt) > (CFG.staleMin || 20) * 60000;
  g.fillStyle = dead ? '#e05a4e' : fresh ? (Math.floor(t / 300) % 2 ? '#5aff8e' : '#4caf6e') : '#4caf6e';
  g.fillRect(262, 296, 6, 4);
  g.font = '8px DotGothic16';
  g.fillStyle = dead ? '#e05a4e' : 'rgba(74,59,42,.75)';
  g.fillText(dead ? '受信断!' : fresh ? '受信中' : '待受', 272, 302);
  g.fillStyle = 'rgba(74,59,42,.55)';
  g.fillText('コレクター', 254, 316);
  // BGM/ラック横の予備サーバー
  rr(g, 306, 262, 30, 42, '#4a4a54', INK);
  g.fillStyle = '#3a3a44'; g.fillRect(308, 264, 26, 38);
  for (let row = 0; row < 3; row++) {
    g.fillStyle = Math.floor(t / 700 + row) % 4 ? '#5a8ac8' : '#3a3a44';
    g.fillRect(311 + row * 8, 268, 3, 2);
  }
  g.fillStyle = 'rgba(74,59,42,.55)'; g.fillText('ルーチン基盤', 300, 316);

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

function route(from, to) {
  const pts = [];
  const fy = from.y;
  const ty = to.y;
  if (fy < 160) { const a = aisleX(from); pts.push({ x: a, y: fy }); pts.push({ x: a, y: LANE_Y }); }
  else if (fy > 210 && from.x > 470) { pts.push({ x: 460, y: 280 }); pts.push({ x: 460, y: LANE_Y }); }
  else pts.push({ x: from.x, y: LANE_Y });
  if (ty < 160) {
    const a = aisleX(to);
    pts.push({ x: a, y: LANE_Y }); pts.push({ x: a, y: ty }); pts.push({ x: to.x, y: ty });
  } else if (to.x > 480 && ty > 224) {
    pts.push({ x: 460, y: LANE_Y }); pts.push({ x: 460, y: 280 }); pts.push({ x: to.x, y: 280 }); pts.push({ x: to.x, y: ty });
  } else {
    pts.push({ x: to.x, y: LANE_Y }); pts.push({ x: to.x, y: ty });
  }
  return pts.filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
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
    else if (a === 'sit' || a === 'sleep') { this.action = a; this.dir = 'down'; }
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
const WANDER = [
  { x: 240, y: 190 }, { x: 380, y: 190 }, { x: 120, y: 190 }, { x: 420, y: 262 },
  { x: 44, y: 250 }, { x: 76, y: 258 }, { x: 130, y: 300 }, { x: 460, y: 200 }, { x: 210, y: 330 },
];

class Employee extends Person {
  constructor(def, i) {
    super(def, i);
    this.mode = 'idle';
    this.action = 'sit';
    this.nextThink = 0;
    this.nextBubble = 4000 + i * 3700 + Math.random() * 9000;
    this.hp = null;
    this.jobText = '';
    this.bubbles = [];
    this.sweat = false;
  }

  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    if (m === 'working') this.goto(this.desk, 'sit');
    else if (m === 'sleep') this.goto(this.desk, 'sleep');
    else if (m === 'off' || m === 'out' || m === 'sleephome') this.goto({ x: 318, y: 348 }, 'leave');
    else this.nextThink = 0;
  }

  think(t, tm) {
    if (this.action === 'walk') return;
    if (this.mode === 'idle' && t > this.nextThink) {
      const r = Math.random();
      if (r < 0.35) { this.goto(this.desk, 'sit'); }
      else if (r < 0.55) { this.goto({ x: 44, y: 250 }, 'coffee'); }
      else { this.goto(WANDER[Math.floor(Math.random() * WANDER.length)], 'stand'); }
      this.nextThink = t + 9000 + Math.random() * 14000;
    }
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
    if (e === 'sleep') drawZzz(g, x, y, t + this.seed);
    if (this.mode === 'panic') drawAlert(g, x, y, t);
    if (this.hp != null) drawHp(g, x, y, this.hp);
    g.font = '8px DotGothic16';
    const nw = g.measureText(this.name).width;
    const ny = seated ? y + 24 : y + 2;
    g.fillStyle = 'rgba(255,250,240,.85)';
    g.fillRect(x - nw / 2 - 2, ny, nw + 4, 9);
    g.fillStyle = INK;
    g.fillText(this.name, x - nw / 2, ny + 8);
    if (this.action === 'coffee') { g.font = '9px DotGothic16'; g.fillText('☕', x + 8, y - 8); }
    if (this.bubble && t < this.bubbleUntil) drawBubble(g, x, y, this.bubble);
  }

  tickBubble(t) {
    if (!this.present || !this.bubbles.length) return;
    if (t > this.nextBubble) {
      this.say(t, this.bubbles[Math.floor(Math.random() * this.bubbles.length)]);
      this.nextBubble = t + 9000 + Math.random() * 16000;
    }
  }
}

const employees = CFG.employees.map((d, i) => new Employee(d, i));

/* ---------- 猫 ---------- */
const cat = { pos: { x: 130, y: 300 }, target: null, next: 0, napUntil: 0, dir: 1 };
function stepCat(dt, t) {
  if (t < cat.napUntil) return;
  if (!cat.target) {
    if (t > cat.next) {
      if (Math.random() < 0.4) { cat.napUntil = t + 15000 + Math.random() * 20000; cat.next = cat.napUntil; return; }
      const spots = [{ x: 90, y: 300 }, { x: 140, y: 260 }, { x: 250, y: 200 }, { x: 400, y: 210 }, { x: 60, y: 130 }, { x: 320, y: 300 }];
      cat.target = spots[Math.floor(Math.random() * spots.length)];
    }
    return;
  }
  const dx = cat.target.x - cat.pos.x, dy = cat.target.y - cat.pos.y;
  const dist = Math.hypot(dx, dy), sp = 22 * dt / 1000;
  if (dist < sp) { cat.pos = cat.target; cat.target = null; cat.next = t + 6000 + Math.random() * 10000; }
  else { cat.pos.x += dx / dist * sp; cat.pos.y += dy / dist * sp; cat.dir = dx > 0 ? 1 : -1; }
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
      const act = s.codex.active || [];
      const rl = s.codex.rateLimit;
      e.hp = rl ? Math.max(0, Math.round(100 - rl.usedPercent)) : 100;
      e.tired = e.hp < 22;
      if (act.length) {
        e.setMode('working');
        e.sweat = act.length >= 3;
        e.jobText = act.map(a => a.thread).join(' / ');
        e.bubbles = act.map(a => `「${(a.thread || '').slice(0, 14)}」進行中`);
      } else {
        e.setMode(tm.h >= 1 && tm.h < 7 ? 'sleep' : 'idle');
        e.jobText = '待機中';
        e.bubbles = ['次のタスクどうぞ'];
      }
      if (rl) e.bubbles.push(`週次残量 ${e.hp}%`);
    } else if (e.source === 'schedule') {
      const del = s.deliveries ? s.deliveries[e.deliveryKey] : null;
      e.hp = null;
      if (shiftActive(e.shift, tm)) {
        e.setMode('working');
        e.jobText = '製造ライン稼働中';
        e.bubbles = ['ただいま製造中…!'];
      } else if (tm.h >= 21 || tm.h < 3) {
        e.setMode('sleep');
        e.jobText = `次の出社 ${e.shift[0]}:${String(e.shift[1]).padStart(2, '0')}`;
      } else {
        e.setMode('idle');
        e.happy = del > 0;
        e.jobText = del != null ? `本日 ${del}本 納品` : '本日実績なし';
        e.bubbles = del > 0 ? [`今日は${del}本納品!`, 'また明日も作ります'] : ['今日はまだ実績なし'];
      }
    } else if (e.source === 'watcher') {
      const j = s.launchd && s.launchd[e.launchdKey];
      e.hp = null;
      if (j && j.running) {
        e.setMode('working');
        e.jobText = 'スタジオ待機・収録中';
        e.bubbles = ['収録スタンバイOK', '台本きたら即収録します', '(マイクチェック…)'];
      } else {
        e.setMode('panic');
        e.jobText = '❌ watcher停止中!';
        e.bubbles = ['watcherが止まってます!'];
        e.action = 'stand';
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
  $('todayCost').textContent = `${fmtYen(tv * rate)}`;
  $('monthCost').textContent = `${fmtYen((s.totals.monthCost || 0) * rate)} (${fmtUsd(s.totals.monthCost || 0)})`;
  $('burnRate').textContent = s.claude.block && s.claude.block.costPerHour ? `${fmtYen(s.claude.block.costPerHour * rate)}/h` : '—';
  const cc = s.claude.today ? s.claude.today.cost : 0, xc = s.codex.today ? s.codex.today.cost : 0;
  $('splitCost').textContent = `${fmtUsd(cc)} / ${fmtUsd(xc)}`;
  $('splitBar').style.width = (cc + xc > 0 ? cc / (cc + xc) * 100 : 50) + '%';

  const subs = $('subs');
  subs.innerHTML = '';
  for (const sub of (s.billing.subscriptions || [])) {
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
    const [cls, label] = CHIP[e.mode] || CHIP.idle;
    const row = document.createElement('div');
    row.className = 'emp';
    if (portraits[e.id]) {
      const img = document.createElement('img');
      img.src = portraits[e.id].src;
      img.style.cssText = 'width:26px;height:26px;image-rendering:pixelated;border:1px solid var(--ink);border-radius:3px';
      row.appendChild(img);
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
  $('staffNote').textContent = '設備: 受信ラック=コレクター(5分毎) / ON AIRランプ=watcher / ペット: モチ(猫)';

  const yt = $('youtube');
  if (s.youtube && s.youtube.subs != null) {
    const goal = CFG.youtubeGoal || 0;
    const pct = goal ? Math.min(100, Math.round(s.youtube.subs / goal * 100)) : 0;
    yt.innerHTML = `<span>📺 登録者 <b>${s.youtube.subs.toLocaleString('ja-JP')}</b>人</span><span>🎯 目標比 <b>${pct}%</b></span><span>🎬 動画 <b>${(s.youtube.videos ?? '-').toLocaleString ? s.youtube.videos.toLocaleString('ja-JP') : s.youtube.videos}</b>本</span>`;
  } else {
    yt.innerHTML = `<span style="opacity:.6">未接続 — collector/config.json の youtube に APIキー/チャンネルID を設定すると表示されます</span>`;
  }

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
  stepCat(dt, t);
  stepParticles(dt);

  // 環境パーティクル
  if (t - lastAmbient > 600) {
    lastAmbient = t;
    const tsuki = employees.find(e => e.id === 'watcher');
    if (tsuki && tsuki.mode === 'working' && Math.random() < 0.35) {
      spawnParticle('note', tsuki.desk.x - 14 + Math.random() * 10, tsuki.desk.y - 14);
    }
  }

  cx.clearRect(0, 0, W, H);
  const night = drawOffice(cx, t, tm);

  const items = [];
  for (const e of employees) items.push({ y: e.desk.y + 20, draw: g => drawDesk(g, e.desk, e.mode === 'working' && e.present, t + e.seed) });
  for (const e of employees) if (e.present) items.push({ y: e.pos.y, draw: g => e.drawSprite(g, t) });
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw(cx);
  drawCat(cx, t);
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
