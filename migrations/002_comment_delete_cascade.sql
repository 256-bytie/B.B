-- 002_comment_delete_cascade.sql
--
-- Adds ON DELETE CASCADE to comments.parent_comment_id, so deleting a
-- comment also deletes its replies (and their replies, recursively -
-- SQLite's FK cascade handles self-referential tables natively).
--
-- SQLite can't ALTER a column's FK clause in place, so this rebuilds
-- the table: create comments_new with the corrected schema, copy every
-- row across, drop the old table, rename, recreate its indexes.
--
-- This migration only changes what the database enforces automatically.
-- It does NOT clean up `likes` rows for cascade-deleted replies (likes
-- has no FK to comments - target_id is a polymorphic reference) or
-- adjust posts.comment_count for a multi-row cascade delete. Both of
-- those are handled in application code (app/post_service.py
-- delete_comment), which walks the full reply subtree before deleting
-- so it can clean up likes and decrement comment_count by the true
-- number of rows removed, not just 1.

PRAGMA foreign_keys = OFF;

CREATE TABLE comments_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    like_count INTEGER DEFAULT 0,
    parent_comment_id INTEGER REFERENCES comments_new(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO comments_new (id, post_id, user_id, content, created_at, like_count, parent_comment_id)
SELECT id, post_id, user_id, content, created_at, like_count, parent_comment_id
FROM comments;

DROP TABLE comments;

ALTER TABLE comments_new RENAME TO comments;

CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);

PRAGMA foreign_keys = ON;
