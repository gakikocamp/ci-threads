-- 確率向上のための追加計測項目（既存行は壊さない）
ALTER TABLE threads_results ADD COLUMN replies INTEGER;
ALTER TABLE threads_results ADD COLUMN reposts INTEGER;
ALTER TABLE threads_results ADD COLUMN posted_hour INTEGER;
ALTER TABLE threads_results ADD COLUMN has_image INTEGER;
