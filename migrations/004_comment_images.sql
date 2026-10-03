-- 004_comment_images.sql
--
-- Adds image_path to comments, allowing a single image per comment
-- (similar to how posts can have multiple images via post_images, but
-- comments get just one, inline in the comments table rather than a
-- separate join).
--
-- NULL = no image. When set, it's a URL string like '/static/uploads/<uuid>.<ext>'.
--
-- This migration is a simple ALTER TABLE ADD COLUMN (no rebuild required,
-- unlike 002's FK cascade change). Existing comments stay NULL; new
-- comments with images set the column at insert time.

ALTER TABLE comments ADD COLUMN image_path TEXT;
