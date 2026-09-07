// 腕の事前分布（灯守 実装指示書 付録A）
// 出典: @crystal_insence Threads実測（2026-07-24棚卸し）＋国産バズ研究＋X公開アルゴリズムの重み
// prior_mean = global_mean × multiplier、prior_n = 2。実測が貯まれば自動的に上書きされる。
// 死に型（説明分析型・フォロー乞い単体・転身自己紹介）は腕として作らない（learn-core.DEAD_PATTERNS）。

export const PRIORS = {
  pattern: {
    数字絶滅型: 1.6,        // 8.7万・3,183。週1本まで
    懇願写真型: 1.4,        // 2.1万（固定投稿向き）
    問いかけ二択: 1.2,      // 5,032。返信+5
    そっといいね型: 1.2,    // 9,919。コモディティ化・月1本まで
    真実暴露型: 1.1,        // 3,291。共有+20
    利他応援型: 1.1,        // 他社3.0万・CI未使用
    廃材舞台裏型: 1.1,      // 他社9,419
    挙手集計型: 1.1,        // 他社1.2万
    誤解訂正型: 1.0,        // 1,101
    リフレーム型: 1.0,      // 他社観測・未使用
    意外な数字ゼロ開始型: 1.0,
    保存版の知恵: 1.0,      // Xの共有+20 を狙う
    舞台裏日常: 0.9,
    仲間募集: 0.9,
    お礼: 0.5,              // 月1本まで
    安否と事実: 1.0,        // 災害時のみ（mode=safety）
  },
  hook: {
    衝撃数字: 1.4,
    懇願: 1.3,
    秘密予告: 1.2,
    問いかけ: 1.2,
    現場の一文: 1.0,
    告白: 1.0,
    逆説: 1.0,
  },
  // 2026-09-08調査: 1日2投稿（朝の通勤帯＋夜の可処分時間帯）。昼は使わない
  slot: {
    morning: 1.0,   // 7:30-8:30
    evening: 1.1,   // 19:30-21:00（Threads研究でも共感・暮らし系は夜有利）
  },
  format: {
    single: 1.0,
    reply: 1.1,     // 追いリプ付き。会話誘発
    thread: 1.0,
    photo: 1.0,     // 現場写真がある時のみ
  },
  // fact は fact-inventory.json の strength をそのまま使う（priorsには持たない）
};

export const SLOT_WINDOWS = {
  morning: { start: '07:30', end: '08:30' },
  evening: { start: '19:30', end: '21:00' },
};

export function priorFor(dimension, arm, factStrengths = {}) {
  if (dimension === 'fact') return factStrengths[arm] ?? 1.0;
  return PRIORS[dimension]?.[arm] ?? 1.0;
}
