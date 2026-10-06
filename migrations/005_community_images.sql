-- 005_community_images.sql
--
-- Adds optional custom icon and cover image URLs to communities.
-- NULL = no custom image; the frontend uses its emoji/gradient fallback.

ALTER TABLE communities ADD COLUMN icon_image TEXT;
ALTER TABLE communities ADD COLUMN cover_image TEXT;
