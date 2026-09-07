-- x_watchlist 初期データ。適用は本番D1適用と同様にユーザー承認後:
-- wrangler d1 execute ci_zukou --remote --file=seed-watchlist.sql
--
-- ハンドルが確認できているのは以下2件のみ。菊水産業・saito_ham・nikko_yakuhin 等は
-- Xアカウントの実在・正確なハンドルが未確認のため、推測で入れていない。
-- 追加はアプリの「研究タブ」から行うこと（ハンドルをその場で確認してから登録するフロー）。

INSERT OR IGNORE INTO x_watchlist (handle, user_id, label, cluster, active, notes, added_at)
VALUES
  ('shakunone', NULL, '笏本縫製（岡山）', 'kakugoten', 1, NULL, 0),
  ('houseiya_moto', NULL, '縫製工場ズーム', 'kakugoten', 1, NULL, 0);
