-- BASEレビューの返信づくり（ci_zukou D1 に相乗り。既存テーブルには触れない）
-- 流れ: Mac Studio が公開ページを読んで sync → 返信が無い本文ありレビューに下書き → アプリで承認 → BASEに返信が載ったら posted
CREATE TABLE IF NOT EXISTS base_reviews (
  key TEXT PRIMARY KEY,         -- 商品ID・日付・評価・本文から作る（BASEに公開IDが無いため）
  item_id TEXT,
  item_name TEXT,
  score TEXT,                   -- good | normal | bad
  review_date TEXT,             -- YYYY-MM-DD
  comment TEXT,                 -- お客様の本文（空=評価だけ）
  shop_reply TEXT,              -- BASEに載っている返信（公開ページから読んだもの）
  status TEXT,                  -- new | draft | redo | approved | posted | skipped | replied_direct | replied_before | no_comment
  draft TEXT,                   -- エンジンの下書き
  draft_note TEXT,              -- 配慮した点・確認してほしい点
  lint TEXT,                    -- 下書きの機械チェック結果（JSON配列）
  redo_memo TEXT,               -- 書き直し依頼のメモ
  final_text TEXT,              -- 承認した文（編集後）
  first_seen_at INTEGER,
  drafted_at INTEGER,
  approved_at INTEGER,
  posted_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_base_reviews_status ON base_reviews(status);
CREATE INDEX IF NOT EXISTS idx_base_reviews_date ON base_reviews(review_date);

-- 同期の記録（最終確認日時・件数をアプリに出す）
CREATE TABLE IF NOT EXISTS base_review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  items_counted INTEGER,
  reviews_total INTEGER,
  new_reviews INTEGER,
  newly_replied INTEGER,
  note TEXT
);

-- BASEへの自動投稿（Mac Studio の post_replies.js）の結果。最新1件をアプリに出す（ログイン切れの警告など）
CREATE TABLE IF NOT EXISTS base_review_poster (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  ok INTEGER,
  note TEXT
);
