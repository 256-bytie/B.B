-- 003_communities.sql
--
-- Communities (b/<slug>) and their membership, plus posts.community_id.
--
-- posts.community_id is nullable: NULL means "posted to the main feed",
-- which is every row that exists before this migration, so existing data
-- and GET /api/posts behavior are unchanged. GET /api/posts filters on
-- community_id IS NULL so community posts never leak into the main feed
-- (see list_posts in app/post_service.py).
--
-- member_count is deliberately NOT a column: it's COUNT(*) over
-- community_members at read time, so it can't drift from the rows it
-- counts (same reasoning as the credit ledger in app/wallet.py).

CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    topic TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('public','restricted','private')),
    icon_emoji TEXT,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS community_members (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('creator','moderator','member')),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (community_id, user_id)
);

-- "My communities", newest join first.
CREATE INDEX IF NOT EXISTS idx_community_members_user
    ON community_members(user_id, joined_at DESC);

ALTER TABLE posts ADD COLUMN community_id INTEGER REFERENCES communities(id);

-- Keyset pagination of a single community's posts (id < cursor).
CREATE INDEX IF NOT EXISTS idx_posts_community
    ON posts(community_id, id DESC);
