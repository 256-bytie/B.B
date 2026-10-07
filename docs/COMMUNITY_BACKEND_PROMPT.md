# Backend prompt for Claude Code — Communities

Frontend is done (community_view.html, community_create.html, community.js).
It calls the endpoints below and falls back to an in-memory mock
(`COMMUNITY_MOCK_DB` in `static/js/community.js`) whenever a call 404s or
network-errors, so nothing breaks while you build this — but every call
below needs to end up real. Match the response shapes exactly; the
frontend does not tolerate extra required fields or renamed keys.

## Schema (add to `app/db.py`, same idempotent `PRAGMA table_info` + `ALTER
TABLE` style already used for every other table — no migration framework)

```sql
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
```

Add a nullable `community_id INTEGER REFERENCES communities(id)` column to
the existing `posts` table (same `ALTER TABLE ... ADD COLUMN` pattern used
for other backfilled columns). NULL means "posts to the main feed" —
existing rows and existing `GET /api/posts` behavior must not change.
`GET /api/posts` must keep excluding rows where `community_id IS NOT
NULL` (community posts should not leak into the main feed) unless a
`community_id` filter is explicitly passed.

`slug`: lowercase, `[a-z0-9]+`, unique, generated server-side from `name`
(strip non-alphanumerics, truncate, de-dupe with a numeric suffix on
collision — same idea as the existing `username` de-dupe in `init_db()`).

## New blueprint: `app/routes/communities.py`

Register it in `app/__init__.py` next to the other blueprints. Add
`serialize_community` to `app/serializers.py` (same file, same pattern as
`serialize_post` etc.):

```json
{
  "id": "campus", "slug": "campus", "name": "campus",
  "description": "...", "topic": "student-life", "type": "public",
  "icon_emoji": "🏛️", "icon_bg": "bg-red-100",
  "member_count": 12400, "created_at": "2025-11-02T00:00:00Z",
  "membership": { "is_member": true, "role": "creator" }
}
```

- `id` and `slug` are the same string (the slug) — the frontend uses them
  interchangeably as the URL param.
- `icon_bg` is a Tailwind class the frontend already knows how to render
  (`bg-red-100`, `bg-teal-50`, `bg-gray-100`, ...) — pick one server-side
  from a small fixed palette keyed by `topic`, don't invent a new field
  name.
- `membership` is relative to the requesting session: `role` is
  `"creator"`, `"moderator"`, `"member"`, or `null` if not a member.
  `is_member` is `false` + `role: null` for a logged-out/non-member
  request (this endpoint is one of the few that should NOT require
  login — a public community's page must be viewable while logged out,
  matching how `/api/posts` already works unauthenticated).

### Routes

- `POST /api/communities` — login required, CSRF (goes through the
  existing `csrf_protect()` in `app/__init__.py`, so no exemption
  needed). Body: `{name, description, topic, type}`. Creates the
  community, inserts the creator into `community_members` with
  `role='creator'`, `member_count` starts at 1. Returns the serialized
  community, 201. 400 with `{"error": "..."}` on missing/invalid
  `type`/empty `name`/`description` — mirror the existing error-shape
  convention in `app/routes/posts.py`.
- `GET /api/communities/<slug>` — no login required. 404
  `{"error": "Community not found"}` if slug doesn't exist.
- `GET /api/communities/<slug>/members` — no login required for a visible
  community. Returns `{"admin": User|null, "moderators": [User], "all": [User]}`;
  uses the public user shape, puts the creator in `admin`, orders moderators
  by `joined_at ASC`, and returns up to four distinct users in `all` (member
  viewer first, otherwise random, followed by the three newest joiners).
- `POST /api/communities/<slug>/join` — login required, CSRF. Idempotent
  (joining twice is a no-op, not an error). Inserts into
  `community_members` with `role='member'` if not already a member.
  Returns the updated serialized community.
- `POST /api/communities/<slug>/leave` — login required, CSRF. 400 if the
  requester is the creator (a creator can't leave their own community
  through this endpoint — that needs an ownership-transfer flow, out of
  scope here). Otherwise removes the membership row. Returns the updated
  serialized community.
- `GET /api/communities/mine` — login required. Returns
  `{"communities": [...]}` — every community the session user is a
  member of (any role), serialized as above, ordered by most-recently
  joined first.
- `GET /api/communities/<slug>/posts?cursor=&limit=` — same keyset
  pagination convention as `GET /api/posts`
  (`app/routes/posts.py:137`): `?cursor=<post_id>` returns posts with
  `id < cursor` scoped to this community, `limit` clamped to `[1,50]`
  default 20. Response: `{"posts": [...], "next_cursor": <id-or-null>}`.
  Each post: `{"id", "author", "avatar_seed", "content", "created_at"}` —
  `author` is the poster's username (fall back to email local-part per
  the existing `serialize_post` convention), `avatar_seed` is the same
  string (frontend builds a dicebear URL from it client-side, same as
  the mock data does — no avatar URL needed from the server unless the
  user has a real `profile_picture`, in which case return that instead
  under the same `avatar_seed` key... actually: add a separate optional
  `avatar_url` key only when a real uploaded picture exists, and have
  the frontend prefer it — flag this back to me if you want, it's a
  5-line frontend change in `communityBuildPostRowHtml`).
- `POST /api/communities/<slug>/posts` — login required, CSRF, must be a
  member (403 `{"error": "Join this community to post"}` if not).
  Body: `{content}` (reuse the same length/empty validation as the main
  compose endpoint in `app/routes/posts.py:18`). Inserts into `posts`
  with `community_id` set. Text-only for this pass — no image upload
  param; add it later by mirroring the multipart branch already in
  `app/routes/posts.py:18` if/when the frontend adds one.

## Not in this pass (frontend already treats these as empty-screen
placeholders, don't build them yet)

- Events (Events tab is a static placeholder, no schema for it)
- Banner image upload — communities render a generated gradient +
  topic icon, no `banner_image` column/field
- Community edit/settings ("Manage" button shows a "Coming soon" toast)
- Restricted/private access enforcement beyond storing `type` — every
  community currently behaves like `public` for read access; only wire
  up `restricted`/`private` gating if you're asked to.

## Testing

Add `test_communities.sh` following the existing `test_*.sh` convention
(`app/routes/*.py` blueprints all have one). Cover: create → get →
join → post → leave → creator-cannot-leave. Run only against
`DB_PATH=beebo_test.db`, never `beebo.db` — see the Testing section in
`CLAUDE.md`.
