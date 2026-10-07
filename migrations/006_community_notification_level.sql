-- 006_community_notification_level.sql
--
-- Per-member notification preference for a community, set from the bell on
-- the Community screen.
--   off     no notifications (default, matches existing members)
--   all     every new post
--   popular popular posts only
--   muted   hide everything from this community
-- Stored on the membership row so it disappears when the member leaves.

ALTER TABLE community_members
    ADD COLUMN notification_level TEXT NOT NULL DEFAULT 'off'
    CHECK(notification_level IN ('off','all','popular','muted'));
