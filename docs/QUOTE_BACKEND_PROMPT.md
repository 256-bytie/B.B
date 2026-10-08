# Claude Code prompt — Quote posts (backend)

Paste everything below the line into Claude Code, run from the project root.

---

Read `CLAUDE.md` first. Implement the backend for **quote posts**. The frontend is already done and must not be edited (`static/`, `templates/`). Do not touch `beebo.db`; run every server/test against `DB_PATH=beebo_test.db`.

## What the frontend already does (contract you must satisfy)

1. **Create.** Share sheet → Quote → composer. On Post it sends `quoted_post_id` (integer) with the normal create request:
   - `POST /api/posts` — JSON `{content, audience, quoted_post_id}` or multipart (`content`, `audience`, `images`, `quoted_post_id` as a string field).
   - `POST /api/communities/<slug>/posts` — same extra field (JSON number or multipart string).
   - `content` stays required (existing rule). Images stay optional.
2. **Share counter.** Every serialized post must carry integer `share_count` = number of quotes of that post (+ reposts later; repost doesn't exist yet, so today it equals the quote count). The frontend shows it beside the Share icon like the like/comment counts (hidden at 0). Compute it batched (one `GROUP BY quoted_post_id` over the page's ids, no N+1), count only quote posts that still exist, and include `share_count` inside the `quoted_post` payload too. Counts are global (not viewer-filtered). Include it on every path listed below.
3. **Read.** Every serialized post must carry a `quoted_post` key, `null` for non-quotes. The frontend renders it inside the post card on every surface (home feed, profile tabs, search posts, community list, post overlay) and opens the quoted post's overlay from it, so it needs the counts and viewer-like state.

```jsonc
// quoted_post, when the viewer can see the original
{
  "id": 50, "user_id": 9,
  "author_name": "Felix", "author_handle": "felixherbt", "author_avatar": "/static/uploads/..." | null,
  "content": "...", "created_at": "YYYY-MM-DD HH:MM:SS",
  "images": ["/static/uploads/..."],          // same shape as post.images
  "like_count": 3, "comment_count": 2, "share_count": 1, "liked_by_user": false
}
// quoted_post, when the original is deleted OR the viewer may not see it
{ "id": 50, "unavailable": true }
```

Frontend behaviour you can rely on: `unavailable` stubs render as a non-tappable "This post is unavailable" card; a `404` on create while quoting shows "The post you're quoting is no longer available."

## Required backend changes

1. **Migration** `migrations/007_post_quotes.sql`: `ALTER TABLE posts ADD COLUMN quoted_post_id INTEGER;` plus an index on it. **No FK / no ON DELETE action** (`PRAGMA foreign_keys = ON` is set in `app/db.py`): deleting the original must not fail and must not erase the fact that a post was a quote. A dangling id is simply serialized as `unavailable`. Follow how migrations 003–006 are applied.
2. **`post_service.create_post(..., quoted_post_id=None)`** (used by both create endpoints; thread the param through `app/routes/posts.py` and `app/routes/communities.py` / `community_service.py`):
   - Parse JSON number or multipart string; non-integer / <1 → `400`.
   - Target must exist **and** be readable by the viewer using the existing access rules (private-community membership via `app/community_access.py` / `_check_post_access`, and whatever audience rules `list_posts` applies). Missing or not-readable → the **same** `404 {"error": "Post not found"}` (don't leak existence).
   - Quoting a quote is allowed.
   - Validate before writing anything (same atomicity convention as image validation); on DB failure after file writes, existing cleanup applies.
   - Quoting does not change audience/community routing of the *new* post.
3. **Serialization.** Add optional `quoted_post=None` to `serialize_post` (keep the 13/14-tuple handling and existing callers working); always emit the `quoted_post` key. Build the quoted payload in `post_service`, **batched**: collect `quoted_post_id`s for the page, one `IN (...)` query for the originals + authors, one for their images, and like/comment/share counts + the viewer's `liked_by_user` (same source as the feed's). No N+1. Apply visibility **per viewer**, including logged-out viewers on the endpoints that work logged out.
   - Never nest: the quoted payload has no `quoted_post` of its own.
   - Must be included on every path that returns posts: `GET /api/posts` (both feeds, cursor pagination unchanged), `GET /api/communities/<slug>/posts`, profile lists (`?user_id=`), global search posts (`app/search_service.py`), and the `201` create responses.
4. **Unchanged on purpose:** community leakage filters, `post_count` (a quote is a normal post), hashtag/trending logic, wallet, CSRF (new field rides the existing mutating routes), the `id < cursor` keyset.
5. **Deleting a post** that others quote must keep working; quotes of it become `unavailable`. Deleting a quote post deletes only itself.

## Tests

Add `tests/test_quotes.sh` in the style of `tests/test_communities.sh` (isolated DB, cookie jar + CSRF header). Cover at least: JSON create with `quoted_post_id`; multipart create with images + `quoted_post_id`; response and `GET /api/posts` carry the full `quoted_post` shape; plain posts get `quoted_post: null`; quote-of-quote embeds one level only; bad id → 400; nonexistent id → 404; private-community original quoted by a non-member → 404, and a quote created by a member then viewed by a non-member → `{id, unavailable: true}`; deleting the original → `unavailable` and delete succeeds; community post create with `quoted_post_id`; search + profile + community list include the key; `liked_by_user` on the quoted payload reflects the viewer; `share_count` increments per quote and drops when a quote is deleted; logged-out `GET /api/communities/<slug>/posts` works. Add it to `scripts/run_all_tests.sh`. Run the existing suites against `DB_PATH=beebo_test.db` and confirm no regressions; confirm `beebo.db` row counts are unchanged.

## Docs

Update `CLAUDE.md`: note `posts.quoted_post_id` (migration 007), the `quoted_post` response shape and unavailable stub, the visibility rule, and the batched fetch. Do not edit frontend files; if the contract above cannot be met, stop and report why instead of changing the shape.
