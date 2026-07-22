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

  // AI社員名簿(実データ連動)
  // match: collectorが送るプロジェクト名(正規表現)。match無しのclaudeは遊撃(その他全部)
  employees: [
    { id: 'claudeT', name: 'クロードT', dept: '開発部', role: '主任・Project-T担当',
      hair: '#e8843c', shirt: '#d96c2e', desk: { x: 200, y: 96 }, source: 'claude',
      match: '^(Project-T|koen|youtubesozai)', portrait: 'claude', showHp: true },
    { id: 'claudeX', name: 'クロードX', dept: '開発部', role: '遊撃・新規案件担当',
      hair: '#e8a05c', shirt: '#b85a2e', desk: { x: 248, y: 96 }, source: 'claude',
      portrait: 'claude' },
    { id: 'codex', name: 'コデックス', dept: '開発部', role: 'エンジニア(Codex)',
      hair: '#3ca88c', shirt: '#2e8a72', desk: { x: 296, y: 96 }, source: 'codex', showHp: true },
    { id: 'claudeY', name: 'クロードY', dept: '開発部', role: 'アプリ・yorutool担当',
      hair: '#d87a3c', shirt: '#c8622e', desk: { x: 224, y: 134 }, source: 'claude',
      match: '^yorutool', portrait: 'claude' },
    { id: 'claudeI', name: 'クロードI', dept: '開発部', role: '音声基盤・TTS担当',
      hair: '#c86a2e', shirt: '#a8521e', desk: { x: 280, y: 134 }, source: 'claude',
      match: '^Irodori', portrait: 'claude' },
    { id: 'koen', name: 'コウ', dept: 'コンテンツ制作部', role: '講演ライター',
      hair: '#7a5cc8', shirt: '#8a70c8', desk: { x: 400, y: 96 }, source: 'schedule',
      shift: [3, 0, 4, 30], deliveryKey: 'koen' },
    { id: 'tsuki', name: 'ツキネ', dept: 'コンテンツ制作部', role: '台本職人',
      hair: '#4c78c8', shirt: '#5c88d8', desk: { x: 464, y: 96 }, source: 'schedule',
      shift: [4, 0, 5, 30], deliveryKey: 'daihon' },
    { id: 'short', name: 'ショウ', dept: 'コンテンツ制作部', role: 'ショート編集',
      hair: '#c85c8a', shirt: '#d86c9a', desk: { x: 528, y: 96 }, source: 'schedule',
      shift: [5, 30, 7, 0], deliveryKey: 'daihon' },
    { id: 'watcher', name: 'TSUKI', dept: '収録スタジオ', role: '専属声優',
      hair: '#b8a8e8', shirt: '#6a5a9a', desk: { x: 548, y: 268 }, source: 'watcher',
      launchdKey: 'com.mon.tsuki.watcher' },
    { id: 'mon', name: 'MON', dept: '社長室', role: '社長',
      hair: '#3a2e20', shirt: '#4a4a5a', desk: { x: 64, y: 96 }, source: 'boss' },
  ],
};
