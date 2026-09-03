-- 今日の推奨投稿（ci_zukou D1 に相乗り。既存テーブルには触れない）
CREATE TABLE IF NOT EXISTS daily_recommendation (
  id TEXT PRIMARY KEY,          -- 日付 'YYYY-MM-DD'
  date TEXT,
  mode TEXT,                    -- 'buzz' | 'safety' 等（トーン）
  pattern TEXT,
  theme TEXT,
  body TEXT,
  reply TEXT,
  tag TEXT,
  confidence INTEGER,
  rationale TEXT,               -- なぜ今日これか
  insight_summary TEXT,         -- 前日インサイトの要約
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_daily_rec_date ON daily_recommendation(date);
