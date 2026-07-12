-- Threads投稿の結果記録テーブル（ci_zukou D1 に相乗り。既存テーブルには一切触れない）
CREATE TABLE IF NOT EXISTS threads_results (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  pattern TEXT,
  theme TEXT,
  tag TEXT,
  body TEXT,
  cta INTEGER DEFAULT 0,
  posted_at INTEGER,
  result TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_threads_results_result ON threads_results(result);
