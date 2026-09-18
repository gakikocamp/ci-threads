-- フォロワー数の日次記録（2026-09-18 追加）。成功判定の主指標
CREATE TABLE IF NOT EXISTS follower_counts (
  id         TEXT PRIMARY KEY,   -- <handle>:<date>
  brand      TEXT NOT NULL,
  handle     TEXT NOT NULL,
  date       TEXT NOT NULL,      -- YYYY-MM-DD
  followers  INTEGER NOT NULL,
  delta      INTEGER,            -- 前回記録との差
  note       TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followers_handle_date ON follower_counts(handle, date);
CREATE INDEX IF NOT EXISTS idx_followers_brand_date  ON follower_counts(brand, date);
