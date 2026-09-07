-- 灯守（X運用機関）用テーブル — ci_zukou D1 に相乗り。既存テーブルには一切触れない
-- 適用: wrangler d1 execute ci_zukou --remote --file=schema-x.sql（本番適用はCEO承認後）

-- 候補〜配信の一方向ステート。Phase A では本人が「投稿済み」をタップして posted にする
CREATE TABLE IF NOT EXISTS x_queue (
  id TEXT PRIMARY KEY,              -- 'YYYY-MM-DD-n' など
  date TEXT NOT NULL,               -- 生成日
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | approved | posted | killed
  pattern TEXT,                     -- 型（proven-patterns.md の名前）
  theme TEXT,
  body TEXT NOT NULL,
  reply TEXT,                       -- 追いリプ
  thread_json TEXT,                 -- スレッド版（JSON配列）任意
  tag TEXT,
  confidence INTEGER,               -- 0-100
  rationale TEXT,                   -- なぜ今日これか
  radar_ref TEXT,                   -- 参考にした当たり型（handle/型名）
  mode TEXT DEFAULT 'buzz',         -- buzz | safety
  lint_ok INTEGER DEFAULT 0,        -- 1=BLOCKなし
  lint_json TEXT,                   -- リンター結果
  scheduled_at INTEGER,             -- Phase B の予約時刻（epoch ms）
  approved_by TEXT,
  approved_at INTEGER,
  posted_at INTEGER,
  tweet_id TEXT,                    -- 投稿後のX投稿ID（Phase Aは本人入力 or 計測で自動突合）
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x_queue_date ON x_queue(date);
CREATE INDEX IF NOT EXISTS idx_x_queue_status ON x_queue(status);

-- 自投稿 × 日付のメトリクススナップショット（成長曲線）
CREATE TABLE IF NOT EXISTS x_metrics (
  tweet_id TEXT NOT NULL,
  snap_date TEXT NOT NULL,          -- 'YYYY-MM-DD'（JST）
  text TEXT,
  created_ts INTEGER,               -- 投稿時刻（epoch ms）
  impressions INTEGER,
  likes INTEGER,
  replies INTEGER,
  reposts INTEGER,
  quotes INTEGER,
  bookmarks INTEGER,
  profile_clicks INTEGER,
  link_clicks INTEGER,
  fetched_at INTEGER,
  PRIMARY KEY (tweet_id, snap_date)
);
CREATE INDEX IF NOT EXISTS idx_x_metrics_snap ON x_metrics(snap_date);

-- 自アカウントの日次（フォロワー推移。投稿別フォロー獲得の校正に使う）
CREATE TABLE IF NOT EXISTS x_account_daily (
  date TEXT PRIMARY KEY,
  followers INTEGER,
  following INTEGER,
  tweet_count INTEGER,
  fetched_at INTEGER
);

-- 型別の集計成績（生成とチューニングが読む）
CREATE TABLE IF NOT EXISTS x_pattern_stats (
  pattern TEXT PRIMARY KEY,
  n INTEGER,
  avg_impressions REAL,
  avg_replies REAL,
  avg_quotes REAL,
  avg_profile_clicks REAL,
  est_follows REAL,                 -- 推定フォロワー獲得（プロフクリック×転換率、日次増分で校正）
  updated_at INTEGER
);

-- 成長レーダー: 監視リスト
CREATE TABLE IF NOT EXISTS x_watchlist (
  handle TEXT PRIMARY KEY,          -- '@'なし小文字
  user_id TEXT,                     -- X の数値ID（初回lookupで埋める）
  label TEXT,                       -- 表示名・業種
  cluster TEXT,                     -- 'kakugoten' | 'kokusan' | 'incense' 等
  active INTEGER DEFAULT 1,
  notes TEXT,
  added_at INTEGER
);

-- 成長レーダー: 日次フォロワー数スナップショットと成長率
CREATE TABLE IF NOT EXISTS x_radar (
  handle TEXT NOT NULL,
  snap_date TEXT NOT NULL,
  followers INTEGER,
  tweet_count INTEGER,
  delta7 INTEGER,                   -- 7日前との差
  growth7 REAL,                     -- 7日成長率
  rank INTEGER,                     -- その日の成長率順位
  fetched_at INTEGER,
  PRIMARY KEY (handle, snap_date)
);

-- 成長レーダー: 上位アカウントの投稿（型の抽出元。文面は学習用の内部データ・再利用禁止）
CREATE TABLE IF NOT EXISTS x_radar_posts (
  tweet_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  text TEXT,
  created_ts INTEGER,
  likes INTEGER,
  replies INTEGER,
  reposts INTEGER,
  quotes INTEGER,
  impressions INTEGER,
  has_media INTEGER,
  pattern_tags TEXT,                -- 抽出した型（JSON配列。生成側が付与）
  fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x_radar_posts_handle ON x_radar_posts(handle);

-- 監査ログ（全検査・承認・配信・停止）
CREATE TABLE IF NOT EXISTS guard_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT,                       -- 'worker' | 'claude' | 'human' | 'linter'
  action TEXT,                      -- 'lint' | 'draft' | 'approve' | 'post' | 'kill' | 'pause' | 'metrics' | 'radar' | 'error'
  target TEXT,                      -- queue id / tweet id / handle
  result TEXT,                      -- 'ok' | 'block' | 'warn' | 'error'
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_guard_log_ts ON guard_log(ts);

-- 運用設定（フェーズ・一時停止・予算カウンタ）
CREATE TABLE IF NOT EXISTS x_settings (
  key TEXT PRIMARY KEY,             -- 'phase'(A|B) | 'paused'(0|1) | 'paused_until' | 'daily_cap' | 'api_reads_today' | 'self_user_id'
  value TEXT,
  updated_at INTEGER
);
INSERT OR IGNORE INTO x_settings (key, value, updated_at) VALUES ('phase', 'A', 0);
INSERT OR IGNORE INTO x_settings (key, value, updated_at) VALUES ('paused', '0', 0);
INSERT OR IGNORE INTO x_settings (key, value, updated_at) VALUES ('daily_cap', '3', 0);
