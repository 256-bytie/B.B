-- 007_post_quotes.sql
--
-- Quote posts keep the integer id of the original without a foreign key.
-- That preserves the quote relationship after the original is deleted;
-- reads serialize a missing target as an unavailable stub.

ALTER TABLE posts ADD COLUMN quoted_post_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_posts_quoted_post
    ON posts(quoted_post_id);
