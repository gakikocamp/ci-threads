-- 「今日の候補（複数・バズ確度順）」用に candidates(JSON文字列) 列を追加
-- daily_recommendation は既存テーブル（schema-daily-recommendation.sql）。既存行・既存列は一切壊さない
ALTER TABLE daily_recommendation ADD COLUMN candidates TEXT;
