-- 灯守 v3: 自分のデータだけで毎日改善する学習エンジン
-- 適用: npx wrangler d1 execute ci_zukou --local --file=schema-x-v3.sql
--       本番は --remote（CEO承認後）
-- 既存9テーブル（schema-x.sql）は壊さない。x_watchlist/x_radar/x_radar_posts は空のまま使わない。

-- ── x_queue に「レシピ（実験設計）」の列を追加 ──
-- SQLiteは ADD COLUMN IF NOT EXISTS 非対応。再実行時は "duplicate column name" が出るが無害
ALTER TABLE x_queue ADD COLUMN recipe_id TEXT;
ALTER TABLE x_queue ADD COLUMN hook TEXT;
ALTER TABLE x_queue ADD COLUMN fact_ids TEXT;
ALTER TABLE x_queue ADD COLUMN slot TEXT;
ALTER TABLE x_queue ADD COLUMN format TEXT;
ALTER TABLE x_queue ADD COLUMN is_exploration INTEGER DEFAULT 0;

-- ── 明日の実験レシピ（Workerが決定的に生成。Claudeはこれを読んで文章だけ書く）──
CREATE TABLE IF NOT EXISTS x_recipes (
  id TEXT PRIMARY KEY,               -- 'YYYY-MM-DD-1' .. '-3'
  date TEXT NOT NULL,
  rank INTEGER NOT NULL,             -- 1,2=活用 / 3=探索
  pattern TEXT NOT NULL,
  hook TEXT NOT NULL,
  fact_ids TEXT NOT NULL,            -- JSON配列（1〜2件）
  slot TEXT NOT NULL,                -- morning | noon | evening
  format TEXT NOT NULL,              -- single | reply | thread | photo
  is_exploration INTEGER DEFAULT 0,
  rationale TEXT,
  constraint_ok INTEGER DEFAULT 0,
  used_queue_id TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x_recipes_date ON x_recipes(date);

-- ── 5次元の腕の統計（Welford）。priorはThreads実測（付録A）──
CREATE TABLE IF NOT EXISTS x_arm_stats (
  dimension TEXT NOT NULL,           -- pattern | hook | fact | slot | format
  arm TEXT NOT NULL,
  n INTEGER DEFAULT 0,
  mean REAL DEFAULT 0,
  m2 REAL DEFAULT 0,
  prior_mean REAL,
  prior_n REAL DEFAULT 2,
  last_tried TEXT,
  updated_at INTEGER,
  PRIMARY KEY (dimension, arm)
);

-- ── 投稿ごとの観測値（帰属の結果）。provisional(48h) → final(7d) ──
CREATE TABLE IF NOT EXISTS x_observations (
  queue_id TEXT PRIMARY KEY,
  tweet_id TEXT,
  posted_at INTEGER,
  status TEXT NOT NULL,              -- provisional | final
  impressions INTEGER,
  profile_clicks INTEGER,
  replies INTEGER, quotes INTEGER, reposts INTEGER, likes INTEGER, bookmarks INTEGER,
  est_follows_clicks REAL,
  est_follows_direct REAL,
  est_follows REAL,
  engagement_score REAL,
  applied_provisional INTEGER DEFAULT 0,  -- 腕に仮反映済みか（finalで打ち消して再反映）
  applied_final INTEGER DEFAULT 0,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x_obs_status ON x_observations(status);

-- ── 学習台帳（人が読む。毎日1行以上）──
CREATE TABLE IF NOT EXISTS x_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,                -- learn | stagnate | alert | weekly | monthly | human
  text TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x_ledger_date ON x_ledger(date);

-- ── 一次情報（燃料）の使用履歴。定義は guardrails/fact-inventory.json ──
CREATE TABLE IF NOT EXISTS x_fact_usage (
  fact_id TEXT NOT NULL,
  queue_id TEXT NOT NULL,
  used_date TEXT NOT NULL,
  PRIMARY KEY (fact_id, queue_id)
);
CREATE INDEX IF NOT EXISTS idx_x_fact_usage_date ON x_fact_usage(used_date);

-- ── 香司の手動研究登録（他人の投稿は「型」だけ学ぶ。文面の再利用は禁止）──
CREATE TABLE IF NOT EXISTS x_research (
  id TEXT PRIMARY KEY,
  url TEXT,
  text TEXT,
  handle TEXT,
  pattern_tags TEXT,
  why TEXT,
  metrics_json TEXT,
  added_by TEXT DEFAULT 'human',
  added_at INTEGER
);

-- ── 日次ブリーフ（朝・週次・月次）──
CREATE TABLE IF NOT EXISTS x_brief (
  id TEXT PRIMARY KEY,               -- 'daily-YYYY-MM-DD' | 'weekly-YYYY-MM-DD' | 'monthly-YYYY-MM'
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x_brief_kind_date ON x_brief(kind, date);

-- ── 不変条件の検証結果（毎日1行。改善したかの証拠）──
CREATE TABLE IF NOT EXISTS x_health (
  date TEXT PRIMARY KEY,
  i1 INTEGER, i2 INTEGER, i3 INTEGER, i4 INTEGER, i5 INTEGER, i6 INTEGER, i7 INTEGER,
  all_ok INTEGER,
  improved INTEGER,                  -- 腕かレシピが前日から変化したか
  detail TEXT,
  created_at INTEGER
);

-- ── 設定の既定値 ──
INSERT OR IGNORE INTO x_settings (key, value, updated_at) VALUES ('conv', '0.3', 0);
INSERT OR IGNORE INTO x_settings (key, value, updated_at) VALUES ('cadence_per_day', '1', 0);
INSERT OR IGNORE INTO x_settings (key, value, updated_at) VALUES ('exploration_min_per_week', '2', 0);
INSERT OR IGNORE INTO x_settings (key, value, updated_at) VALUES ('global_mean', '1.0', 0);
INSERT OR IGNORE INTO x_settings (key, value, updated_at) VALUES ('radar_enabled', '0', 0);

-- 腕への反映値（provisional を final で打ち消すために保持）
ALTER TABLE x_observations ADD COLUMN applied_value REAL;

-- 返信の効果を分けて測るための列（2026-09-08 追加）
ALTER TABLE x_metrics ADD COLUMN kind TEXT DEFAULT 'original';   -- original | reply
ALTER TABLE x_metrics ADD COLUMN conversation_id TEXT;

-- オリジナル投稿と返信、それぞれの成績（1件あたりの効率を比べる）
CREATE TABLE IF NOT EXISTS x_kind_stats (
  kind TEXT PRIMARY KEY,             -- original | reply
  window_days INTEGER,
  n INTEGER,
  impressions REAL,
  profile_clicks REAL,
  est_follows REAL,
  per_item REAL,                     -- 1件あたりの推定フォロワー獲得
  updated_at INTEGER
);
