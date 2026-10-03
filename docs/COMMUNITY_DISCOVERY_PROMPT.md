# Backend prompt for Claude Code — Community discovery (Phase 2)

Context: `app/routes/communities.py` (HTTP) and `app/community_service.py`
(logic, Flask-free) already implement create/get/join/leave/mine and
per-community posts. Add ONE read endpoint: a browse/search directory.
No schema change, no migration. Do not touch `app/posts.py` (dead code).
Do not touch `beebo.db`; run tests only with `DB_PATH=beebo_test.db`.

## Route

`GET /api/communities` in `app/routes/communities.py`, next to the other
GET routes. Readable while logged out (same as `GET /api/communities/<slug>`);
no CSRF concern (GET). Query params:

- `q` (optional): case-insensitive substring match on `name`, `slug`, or
  `description`. Trim; cap at 50 chars; empty/whitespace = no filter.
  Escape `%`, `_` and the escape char itself in the LIKE pattern
  (`... LIKE ? ESCAPE '\'`) so user input is never a wildcard.
- `limit` (optional): reuse `_clamp_limit` (default 20, clamp 1-50).
- `cursor` (optional): reuse `_parse_cursor`. Integer community id; invalid
  value = ignored (first page), same as the posts endpoint.

## Behavior (service layer, new function `list_communities`)

Signature: `list_communities(conn, viewer_id, q, limit, cursor_id) -> (list, next_cursor)`

- Exclude `type = 'private'` always (decision D2). `public` and `restricted`
  are listed.
- Order: `communities.id DESC` (newest first). Keyset: `id < cursor_id`.
  Fetch `limit + 1` rows; if more than `limit`, drop the extra and set
  `next_cursor` to the id of the last returned row, else `null`. Same
  pattern as `list_community_posts`.
- Each item is exactly the existing `serialize_community(row, icon_bg, role)`
  shape, including `member_count` (COUNT subquery, as in `/mine`) and
  `membership: {is_member, role}` relative to `viewer_id` (None = logged out,
  so `is_member: false, role: null`). Get the viewer role with a single
  `LEFT JOIN community_members vm ON vm.community_id = c.id AND vm.user_id = ?`
  rather than one query per row. The integer PK must not appear in output
  (it is only used for the cursor).
- Response: `{"communities": [...], "next_cursor": <int|null>}`.

## Reserved slugs

`GET /api/communities` has no slug segment, so it cannot be shadowed by a
slug and `RESERVED_SLUGS` needs NO change. Do not add entries.

## Errors

Same conventions: route through `_call`, `{error}` JSON. Bad `limit` or
`cursor` never errors (clamped / ignored).

## Tests (`tests/test_communities.sh`, keep the existing style)

Add a section (assertions at least):
1. Logged-out `GET /api/communities` -> 200, has `communities` array and
   `next_cursor`.
2. A newly created public community appears, with `membership.is_member`
   true and `role` `creator` for its creator, false/null for another user and
   for logged-out.
3. `q` matches by name (case-insensitive), by description word, and by slug;
   non-matching `q` returns an empty array.
4. `q=%` and `q=_` do NOT match everything (LIKE escaping).
5. A `type=private` community never appears (create one via API, assert
   absent from the list and from a `q` search for its name). Note: the create
   route still accepts `private`; that is intentional until Phase 4.
6. Pagination: create 3+ communities, `limit=2` -> 2 items and a non-null
   `next_cursor`; following the cursor yields the rest with no duplicates and
   ends with `next_cursor: null`.
7. `limit=0`, `limit=9999`, `limit=abc`, `cursor=abc` all return 200.
8. Response items contain no `pk`/integer-id leak beyond the existing `id`
   (= slug) field.

Register nothing new in `scripts/run_all_tests.sh` (file already registered).

## Docs

Update `CLAUDE.md`: add `GET /api/communities` (browse/search, public,
excludes private, keyset by id DESC) to the Communities API row and the
Communities section.

## Do not

- Add columns, indexes or migrations (scale does not need them yet).
- Change `/mine`, `/<slug>`, join/leave, or post routes.
- Filter or reorder anything outside the new function.
