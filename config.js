// MON-AI Inc. ダッシュボード設定
window.OFFICE_CONFIG = {
  supabaseUrl: 'https://whiukxhomdrpnrjdlyaz.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndoaXVreGhvbWRycG5yamRseWF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNDY4ODcsImV4cCI6MjA5NDkyMjg4N30.A79wz3R-u-gUB5k7Co4pXi9ep3t7EExluyHm23dDEt8',
  pollSec: 60,
  staleMin: 20,

  // 会社の掲げもの
  mission: '物語を、毎日届ける。',
  mottos: ['一、無限労働', '一、社長一筋', '一、品質第一', '一、整理整頓'],
  youtubeGoal: 10000,

  // 実際の固定費(月額・2026-07-22 MON申告)
  subscriptions: [
    { name: 'Claude (Anthropic)', plan: '', monthlyJPY: 43200 },
    { name: 'ChatGPT/Codex (OpenAI)', plan: '', monthlyJPY: 16800 },
    { name: 'DomoAI', plan: '', monthlyJPY: 10000 },
    { name: 'Mureka', plan: '', monthlyJPY: 1500 },
    { name: 'Supabase', plan: '', monthlyJPY: 2000 },
    { name: 'Vercel', plan: '', monthlyJPY: 3000 },
  ],
  // 売上(手入力)。月間売上JPY
  sales: { monthlyJPY: 0, note: 'これから' },
  // Murekaの残ゴールド(アプリの数字を手で更新。自動取得は不可)
  mureka: { gold: 200 },

  // 社員名簿(全員実データ連動)
  // source: boss=在席検知 / claude=Claude Codeセッション(match=プロジェクト正規表現、無しはfallback雑務)
  //         codex=Codexセッション(match=proj正規表現、無しはfallbackその他) / schedule=日次ルーチン
  // 体型フラグ: fat / tall / slim / bald
  employees: [
    { id: 'fujimoto', wage: 0, name: '藤本', dept: '社長室', role: '社長',
      hair: '#2a2220', shirt: '#2a2a30', fat: true, desk: { x: 64, y: 112 }, tag: '社長', source: 'boss', pc: 'mon2' },

    { id: 'ito', wage: 5000, name: '伊藤', dept: 'プロジェクト-T', role: 'クロード作業',
      hair: '#f8d8b8', bald: true, tall: true, shirt: '#5a8a6a', desk: { x: 168, y: 112 }, tag: 'Project-T',
      source: 'claude', match: '^(Project-T|koen|youtubesozai)', showHp: true, pc: 'mon2' },
    { id: 'tsukishiro', wage: 3500, name: '月城', dept: 'プロジェクト-T', role: 'ルーチン作業',
      hair: '#b8a8e8', shirt: '#6a5a9a', desk: { x: 230, y: 112 }, tag: 'ルーチン',
      source: 'schedule', shift: [3, 0, 7, 0], deliveryKeys: ['koen', 'daihon'],
      watcherKey: 'com.mon.tsuki.watcher' },
    { id: 'sasaki', wage: 3000, name: '佐々木', dept: 'プロジェクト-T', role: 'コーデックス作業(BGMUP)',
      hair: '#4a3a2a', slim: true, shirt: '#2e8a72', desk: { x: 292, y: 112 }, tag: 'BGMUP',
      source: 'codex', match: '^BGMUP' },

    { id: 'amakawa', wage: 4500, name: '天川', dept: 'アプリ制作部', role: 'クロード作業(アプリ開発)',
      hair: '#3a3228', fat: true, tall: true, shirt: '#4a7ac8', desk: { x: 364, y: 112 }, tag: 'アプリ開発',
      source: 'claude', match: '^(AM38|bottlePV)' },
    { id: 'ando', wage: 3000, name: '安藤', dept: 'アプリ制作部', role: 'コーデックス作業(AM38)',
      hair: '#2a2a2a', slim: true, shirt: '#3ca88c', desk: { x: 424, y: 112 }, tag: 'AM38',
      source: 'codex', match: '^AM38', showHp: true, pc: 'mon2' },

    { id: 'hirose', wage: 4000, name: '廣瀬', dept: 'yorutool制作部', role: 'クロード作業(yorutool)',
      hair: '#d83a2e', shirt: '#c85a8a', desk: { x: 528, y: 112 }, tag: 'yorutool',
      source: 'claude', match: '^yorutool' },

    { id: 'arimoto', wage: 4500, name: '有本', dept: '総務部', role: 'クロード作業(基盤・ツール)',
      hair: '#2a2220', shirt: '#3a3a4a', desk: { x: 240, y: 216 }, tag: '基盤・ツール',
      source: 'claude', match: '^(Irodori)' },
    { id: 'kato', wage: 800, name: '加藤', dept: '総務部', role: 'クロード作業(雑務)',
      hair: '#8a5a2e', shirt: '#c8a04a', desk: { x: 290, y: 216 }, tag: '雑務全般',
      source: 'claude', pc: 'laptop' },
    { id: 'shirayanagi', wage: 500, name: '白柳', dept: '清掃', role: 'クリーンスタッフ',
      hair: '#2a2a2a', shirt: '#b8d8cc', desk: { x: 236, y: 320 }, source: 'janitor' },
    { id: 'zama', wage: 800, name: '座間', dept: '総務部', role: 'コーデックス作業(その他)',
      hair: '#8a5a2e', slim: true, shirt: '#48a08a', desk: { x: 340, y: 216 }, tag: 'その他案件',
      source: 'codex', pc: 'laptop' },
  ],
};
