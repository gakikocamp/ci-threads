-- マルチブランド化：既存行は自動で brand='ci' になる（非破壊）
ALTER TABLE threads_results     ADD COLUMN brand TEXT DEFAULT 'ci';
ALTER TABLE buzz_library        ADD COLUMN brand TEXT DEFAULT 'ci';
ALTER TABLE daily_recommendation ADD COLUMN brand TEXT DEFAULT 'ci';
CREATE INDEX IF NOT EXISTS idx_results_brand ON threads_results(brand);
CREATE INDEX IF NOT EXISTS idx_buzz_brand    ON buzz_library(brand);
CREATE INDEX IF NOT EXISTS idx_daily_brand   ON daily_recommendation(brand, date);
