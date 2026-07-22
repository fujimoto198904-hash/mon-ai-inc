// MON-AI Inc. ダッシュボード設定
window.OFFICE_CONFIG = {
  supabaseUrl: 'https://whiukxhomdrpnrjdlyaz.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndoaXVreGhvbWRycG5yamRseWF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNDY4ODcsImV4cCI6MjA5NDkyMjg4N30.A79wz3R-u-gUB5k7Co4pXi9ep3t7EExluyHm23dDEt8',
  pollSec: 60,
  staleMin: 20,

  // 会社の掲げもの
  mission: '物語を、毎日届ける。',
  mottos: ['一、捏造禁止', '一、名義はMON', '一、毎日納品'],
  youtubeGoal: 10000,

  // 実際の固定費(月額)。人件費はここから日割り計算して表示する
  // ChatGPT Proはサイドバー表記から$200/月として仮置き。違えば直してください
  subscriptions: [
    { name: 'Claude (Anthropic)', plan: '要記入', monthlyJPY: 0 },
    { name: 'ChatGPT Pro (OpenAI)', plan: '$200', monthlyJPY: 31000 },
  ],
  // 売上(手入力)。月間売上をJPYで入れると売上ボードに出ます
  sales: { monthlyJPY: null, note: '' },

  // 社員名簿(全員実データ連動)
  // source: boss=在席検知 / claude=Claude Codeセッション(match=プロジェクト正規表現、無しはfallback雑務)
  //         codex=Codexセッション(match=proj正規表現、無しはfallbackその他) / schedule=日次ルーチン
  // 体型フラグ: fat / tall / slim / bald
  employees: [
    { id: 'fujimoto', name: '藤本', dept: '社長室', role: '社長',
      hair: '#2a2220', shirt: '#2a2a30', fat: true, desk: { x: 64, y: 96 }, source: 'boss' },

    { id: 'ito', name: '伊藤', dept: 'プロジェクト-T', role: 'クロード作業',
      hair: '#f8d8b8', bald: true, tall: true, shirt: '#5a8a6a', desk: { x: 168, y: 96 },
      source: 'claude', match: '^(Project-T|koen|youtubesozai)', showHp: true },
    { id: 'tsukishiro', name: '月城', dept: 'プロジェクト-T', role: 'ルーチン作業',
      hair: '#b8a8e8', shirt: '#6a5a9a', desk: { x: 230, y: 96 },
      source: 'schedule', shift: [3, 0, 7, 0], deliveryKeys: ['koen', 'daihon'],
      watcherKey: 'com.mon.tsuki.watcher' },
    { id: 'sasaki', name: '佐々木', dept: 'プロジェクト-T', role: 'コーデックス作業(BGMUP)',
      hair: '#4a3a2a', slim: true, shirt: '#2e8a72', desk: { x: 292, y: 96 },
      source: 'codex', match: '^BGMUP' },

    { id: 'amakawa', name: '天川', dept: 'アプリ制作部', role: 'クロード作業(アプリ開発)',
      hair: '#3a3228', fat: true, tall: true, shirt: '#4a7ac8', desk: { x: 364, y: 96 },
      source: 'claude', match: '^(AM38|bottlePV)' },
    { id: 'ando', name: '安藤', dept: 'アプリ制作部', role: 'コーデックス作業(AM38)',
      hair: '#2a2a2a', slim: true, shirt: '#3ca88c', desk: { x: 424, y: 96 },
      source: 'codex', match: '^AM38', showHp: true },

    { id: 'hirose', name: '廣瀬', dept: 'yorutool制作部', role: 'クロード作業(yorutool)',
      hair: '#d83a2e', shirt: '#c85a8a', desk: { x: 528, y: 96 },
      source: 'claude', match: '^yorutool' },

    { id: 'arimoto', name: '有本', dept: '総務部', role: 'クロード作業(基盤・ツール)',
      hair: '#2a2220', shirt: '#3a3a4a', desk: { x: 240, y: 262 },
      source: 'claude', match: '^(Irodori)' },
    { id: 'kato', name: '加藤', dept: '総務部', role: 'クロード作業(雑務)',
      hair: '#8a5a2e', shirt: '#c8a04a', desk: { x: 292, y: 262 },
      source: 'claude' },
    { id: 'zama', name: '座間', dept: '総務部', role: 'コーデックス作業(その他)',
      hair: '#8a5a2e', slim: true, shirt: '#48a08a', desk: { x: 344, y: 262 },
      source: 'codex' },
  ],
};
