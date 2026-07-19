-- 国産バズ・ライブラリ（ci_zukou D1 に相乗り。既存テーブルには一切触れない）
CREATE TABLE IF NOT EXISTS buzz_library (
  id TEXT PRIMARY KEY,
  url TEXT,
  author TEXT,
  tag TEXT,
  body TEXT,
  likes INTEGER,
  replies INTEGER,
  reposts INTEGER,
  hook_type TEXT,
  pattern TEXT,
  why_buzz TEXT,
  source TEXT,
  collected_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_buzz_library_tag ON buzz_library(tag);
