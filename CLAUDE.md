# Beebo — Project Memory

Compact technical map. Read this before touching code. Don't re-explore
the codebase for anything already answered here — go straight to the
cited file/line/function.

**This file replaces a stale pre-refactor version** that documented a
single `app.py` (~700 lines) + single `beebo.html` (~2930 lines). That
structure no longer exists on disk; every path/line reference below was
re-verified against the current tree.

## Stack & Run

- Backend: Flask + raw `sqlite3` (no ORM), split into an application
  factory + blueprints under `app/` (not a single file):
  - `app/__init__.py` — `create_app()`: CORS, server-side sessions
    (`flask_session`, filesystem-backed, `./flask_session/`), CSRF
    middleware, blueprint registration, static/page routes.
  - `app/db.py` — `init_db()` / `get_db()` / `get_db_path()`. Schema +
    migrations (see below).
  - `app/serializers.py` — row→dict shaping shared across routes
    (`serialize_post`, `serialize_comment`, `serialize_user_public`,
    `serialize_library_file`).
  - `app/routes/{auth,posts,users,library,search}.py` — one blueprint
    per domain (route list below).
  - `app.py` (project root, 6 lines) — thin entry point only:
    `create_app()` + `init_db()` + `app.run(...)`. All real logic lives
    under `app/`.
- DB: `beebo.db` (SQLite, committed in repo during dev; **never** the
  target of a test run — see Testing). Tables: `users`, `posts`,
  `post_images`, `comments`, `likes`, `follows`, `highlights`,
  `search_history`, `library_files`, `credit_transactions`. Schema created idempotently in
  `init_db()` (`app/db.py`); older columns/tables are migrated in place
  with `PRAGMA table_info` checks + `ALTER TABLE`, not a migration
  framework.
- Frontend: still no build step, no framework — but no longer one file.
  `templates/index.html` assembles the SPA from `templates/partials/*.html`
  via Jinja `{% include %}` (one file per view/overlay/sheet), rendered
  through `render_template('index.html')`. `app.jinja_env.trim_blocks` /
  `lstrip_blocks` are set specifically so this split reproduces the old
  single-file output byte-for-byte — don't remove those flags without
  re-diffing render output. Client JS is split by concern into
  `static/js/*.js` (16 files, ~6000 lines total — see table below), all
  loaded as plain `<script>` tags, no bundler.
- Views are still `<div id="...-view">` blocks toggled by `showView(name)`
  — now in `static/js/core.js:41`, not `beebo.html`.
- Images stored on disk at `static/uploads/`, served via
  `/static/uploads/<filename>` route (`app/__init__.py`, `uploaded_file`),
  referenced in DB as `post_images.image_path` (a URL string, not a blob).
- Auth: Flask session cookie, but now **server-side** (`flask_session`,
  filesystem store), not a bare client cookie. Secret key persisted to
  `.flask_secret_key` on disk (or `SECRET_KEY` env var override) so
  sessions survive server restarts.
- **CSRF protection** (new since the old doc): `app/__init__.py`
  `csrf_protect()` runs on every `POST/PATCH/PUT/DELETE`, requires an
  `X-CSRF-Token` header matching `session['csrf_token']` (constant-time
  compare), except `/api/login` and `/api/signup`. Frontend auto-injects
  the header from `core.js` (search `X-CSRF-Token` there) — any new
  mutating fetch call must go through that same wrapper, not a raw
  `fetch()`, or it will 403.
- Two-agent AI dev workflow still applies: frontend edited by Claude
  (chat), backend by Claude Code in terminal. Write a self-contained
  prompt for Claude Code rather than editing `app/routes/*.py` directly.

## Architecture map — where things live

| Concern | Location |
|---|---|
| App factory, CORS, sessions, CSRF, static/page routes | `app/__init__.py` |
| DB schema / migrations | `app/db.py` (`init_db`) |
| Row → JSON shaping (posts/comments/users/library files) | `app/serializers.py` |
| Auth: signup/login/logout/session/account-switch | `app/routes/auth.py` |
| Post create (JSON + multipart w/ images) | `app/routes/posts.py:18` |
| Post feed fetch — **keyset-paginated**, `?cursor=`/`?limit=` | `app/routes/posts.py:137` |
| Comments fetch / create | `app/routes/posts.py:270`, `:314` |
| Post/comment like, comment delete | `app/routes/posts.py:391,466,541` |
| User public profile, follow, highlights, profile picture/cover, post delete | `app/routes/users.py` |
| Library file upload/list/download, departments | `app/routes/library.py` |
| Search, trending, suggestions, search history | `app/routes/search.py` |
| View-switching (`showView`) | `static/js/core.js:41` |
| Bottom nav (Home/Search/Notifications/Chat; shown on feed + chat only; active state + FAB/chat offsets via `--bottom-nav-h`) | `templates/partials/bottom_nav.html`, `updateBottomNav` in `static/js/core.js`, `.bottom-nav*` in `static/css/style.css`. Notifications has no screen yet → "Coming soon" toast |
| Feed rendering (post cards) | `static/js/feed.js:206` (`renderFeedPosts`) → `buildPostCardHtml` (`static/js/feed.js:114`) |
| HTML-escaping utility (all dataset/attr values) | `static/js/feed.js:8` (`escapeHtml`) |
| Comment/Post-detail overlay open | `static/js/comments.js:290` (`openCommentOverlay`) |
| Dataset → post-object reconstruction for the overlay | `static/js/comments.js:64` (`getPostDataFromCard`) |
| Compose/publish flow + localStorage draft autosave | `static/js/compose.js` (`COMPOSE_DRAFT_KEY = 'beebo_draft_v1'`) |
| Light/dark theme (CSS-only swap, `html.dark` class) | `static/js/theme.js`, `static/css/style.css:585` |
| CSRF header auto-injection for mutating fetches | `static/js/core.js` (search `X-CSRF-Token`) |
| Account switcher (multi-login) | `static/js/account-switcher.js`, `app/routes/auth.py` (`/api/session/switch`) |
| Library (file uploads/browse) | `static/js/library.js`, `app/routes/library.py` |
| Search UI | `static/js/search.js`, `app/routes/search.py` |
| Share sheet (feed card Share button → Repost/Quote sheet; slide-up, swipe-down, tap-outside, Esc) | `templates/partials/share_sheet.html`, `static/js/share-sheet.js`, `.share-sheet*` in `static/css/style.css`. Uses `.is-open` (not `hidden`) so it can animate; Repost/Quote show the standard "Coming soon" toast |
| Wallet: balance / monthly free credits / history API | `app/routes/wallet.py` (HTTP) → `app/wallet.py` (logic, Flask-free) |
| Wallet screen (side-nav → `openWalletView()`) | `templates/partials/wallet.html`, `static/js/wallet.js`, `showView('wallet')` hook in `static/js/core.js` |

## Key data flow — post images (still true, same shape, new file locations)

Post images are **not** re-fetched when the comment overlay opens. The
overlay is populated entirely from the clicked post card's DOM `dataset`
attributes (`static/js/comments.js:64`, `getPostDataFromCard`), serialized
as JSON into `data-post-images="..."` when the card was built
(`buildPostCardHtml`, `static/js/feed.js:127`). There is still no
`GET /api/posts/<id>` single-post endpoint — the overlay has no fallback
fetch if the dataset is empty/corrupt. **Any future overlay field must
survive round-tripping through an HTML attribute** — escape it into a
`data-*` attribute (same pattern as existing fields), or add a real
per-post GET endpoint. Don't assume the overlay can "just re-fetch."

Image list per post lives in `post_images` (separate table, not a JSON
column) — order preserved via `position`, `ON DELETE CASCADE` cleans up
orphans when a post is deleted.

## Key data flow — post feed pagination (new since the old doc)

`GET /api/posts` is now **keyset-paginated**, not a flat unbounded fetch:
`?cursor=<post_id>` returns posts with `id < cursor`; `?limit=` clamps
silently to `[1, 50]` (default 20 via `DEFAULT_POSTS_LIMIT`). Response is
`{"posts": [...], "next_cursor": <id-or-null>}`. `id DESC` and
`created_at DESC` are assumed to agree (ids are autoincrement, posts are
never backdated) — if that assumption ever breaks (e.g. imported/backfilled
posts), the keyset condition needs to change to a compound cursor.
Supports `audience` and `user_id` filters composed with the cursor
condition (`app/routes/posts.py:137`). Images for a page are fetched in
one batched `IN (...)` query against `post_images`, not N+1.

## Wallet (credits)

- **Ledger, not a counter.** `credit_transactions` (`app/db.py`) is
  append-only; balance = `SUM(amount)` per user (`wallet.get_balance`). There
  is deliberately no `users.credits` column that could drift from history.
  `kind` (`top_up`/`usage`/`free`) drives the row badge; `reason`
  (`top_up`/`monthly_reward`/`post`/`comment`/`reply`) drives title + icon.
- **Monthly free credits:** 50 credits, once per month measured from the
  user's last claim (claim Aug 15 → next Sep 15; month-end clamps). First
  claim is available immediately. `claim_monthly_reward` checks and inserts
  inside one `BEGIN IMMEDIATE` transaction, so double-taps / two tabs can't
  double-grant (covered by `test_wallet_logic.py`).
- **API** (`app/routes/wallet.py`, all login-required, `Cache-Control:
  no-store`): `GET /api/wallet` (balance + monthly status),
  `GET /api/wallet/transactions?limit=&cursor=` (newest first, keyset on id,
  limit clamped to [1,50]), `POST /api/wallet/claim` (CSRF; 201 / 409 with
  fresh state). Timestamps are ISO-8601 UTC (`...Z`).
- **Not implemented on purpose:** *Top Up* (needs a payment provider — the
  button shows the standard `showToast('Coming soon')`; when it exists it's a
  new endpoint calling `wallet.record_transaction(kind='top_up')`, no schema
  change) and *usage charges* (posting/commenting/replying do NOT cost
  credits yet; that is a product decision, not a bug. `record_transaction`
  already refuses overdrafts for when it is turned on).
- **Frontend:** `initWalletView()` runs on every `showView('wallet')` and
  refetches from scratch (no client cache), so refreshes and account
  switches always show server truth. Not URL-synced (like Courses/Library).
  Back returns to the screen the drawer was opened from (`walletReturnView`).

## Non-obvious decisions worth preserving

- Multipart `POST /api/posts` still handles both text-only (JSON body)
  and image posts (`multipart/form-data`) on the **same** endpoint
  (`app/routes/posts.py:18`) — kept atomic on purpose.
- `escapeHtml()` (`static/js/feed.js:8`) must escape `"` and `'` in
  addition to `& < >` — text-node escaping alone is not attribute-safe.
  Source of a real bug (see log below). Any new code writing
  `data-foo="${...}"` must run the value through this, and must not
  assume `div.textContent → innerHTML` is sufficient for attributes.
- Audience validation is intentionally lenient: unrecognized values fall
  back to `'Academic'` (`VALID_AUDIENCES`, `app/routes/posts.py`) so
  older/partial clients don't break.
- No server-side drafts — compose drafts are localStorage-only
  (`COMPOSE_DRAFT_KEY = 'beebo_draft_v1'`, `static/js/compose.js`).
- Images stored on disk (`static/uploads/`), not DB blobs/base64.
- CSRF token is per-session, not per-request/double-submit-cookie; it's
  fetched once (login/signup response) and reused for the session's
  lifetime — a token mismatch after a session/account switch is the
  first thing to check if mutating requests start 403ing.
- `username` is nullable-but-backfilled: `init_db()` migrates any NULL
  username from the email local-part, de-duping collisions by appending
  the user id. `serialize_post`/`serialize_comment`/`serialize_user_public`
  all fall back to `email.split('@')[0]` if `username` is somehow still
  null — treat that fallback as unreachable-in-practice, not a code path
  to design around.
- Light/dark theme is CSS-only: `theme.js` only decides which theme is
  active and toggles the `dark` class on `<html>`; every visual change
  is a `html.dark ...` rule in `style.css`. Logo assets follow the same
  convention via paired `.logo-light`/`.logo-dark` `<img>` elements
  (`style.css:~585`) rather than a JS-driven `src` swap — keep any future
  theme-dependent asset on this pattern, not a JS branch.

## Bug / fix log

**Problem:** Post images displayed correctly in the Home feed but were
missing from the Post & Comments overlay — consistently, not just after
refresh.

**Root cause:** `escapeHtml()` only escaped `&`, `<`, `>`, not `"`. It was
used to embed `JSON.stringify(post.images)` into the double-quoted
`data-post-images` attribute. Any non-empty image array contains `"`
characters (JSON string quoting), which prematurely closed the HTML
attribute, corrupting the tag. Reading the dataset back then yielded
truncated/invalid JSON, `JSON.parse` threw, was caught, and silently fell
back to `images = []`. Text-only posts were unaffected
(`JSON.stringify([])` → `"[]"` has no embedded quotes).

**Relevant location (current):** `escapeHtml()` (`static/js/feed.js:8`);
consumed by `buildPostCardHtml` (`static/js/feed.js:127`) and read by
`getPostDataFromCard` (`static/js/comments.js:64`) →
`openCommentOverlay` (`static/js/comments.js:290`).

**Fix:** `escapeHtml()` now also replaces `"` → `&quot;` and `'` →
`&#39;`. Fixes every `data-post-*` attribute, not just images.

**Verification:** Published an image post → confirmed feed shows it →
refreshed → opened Post & Comments → image present. Confirmed backend was
already correct via direct `post_images` inspection + `test_client` — this
was 100% a frontend serialization bug.

**Lesson for next session:** Don't assume a "persistence" bug is
backend/DB just because it manifests after a refresh. Check the backend
response first; if the data's there, the bug is almost certainly in how
the frontend serializes/reads it client-side (dataset attributes,
localStorage, in-memory cache). The comment overlay has no network fetch
for post metadata at all — check `getPostDataFromCard`
(`static/js/comments.js:64`) and `escapeHtml` first before looking at
`app/routes/posts.py` for anything overlay-related.

## Common mistake to avoid

Don't add a new `GET /api/posts/<id>` endpoint to "fix" overlay data
issues before checking whether the real bug is in the existing
dataset-attribute pipeline (`buildPostCardHtml` → `data-post-*` →
`getPostDataFromCard` → `openCommentOverlay`). That pipeline is
intentional (avoids an extra round-trip) and most overlay bugs so far
have been serialization bugs in it, not missing data.

## Miscellaneous docs already in repo (not duplicated here)

`IMPLEMENTATION_COMPLETE.md`, `API_CHANGES.md`, `BACKEND_SUMMARY.md`,
`FRONTEND_INTEGRATION.md`, `REGRESSION_FIX.md`, `ANIMATION_CHANGES.md`,
`CLEANUP_COMPLETE.md`, `COMMENT_DELETE_CHANGES.md`,
`HARDENING_PHASE1_PHASE2_COMPLETE.md`, `HIGHLIGHTS_IMPLEMENTATION.md`,
`HIGHLIGHTS_QUICK_REFERENCE.md`, `HIGHLIGHTS_SUMMARY.txt`,
`PHASE3_COMPLETE.md`, `PHASE5_FINAL_CHECKLIST.md`,
`PHASE5_IMPLEMENTATION_SUMMARY.md`, `claude-code-db-isolation-prompt.md`
— scattered session-specific writeups from earlier backend/hardening/
highlights/pagination work. Treat this file as the entry point; only open
those if this file doesn't answer the question and the topic matches one
of their titles. Not individually re-verified in this update — if one
contradicts this file, this file wins (it was checked against the live
tree; they may not have been).

## Testing

**IMPORTANT:** `beebo.db` contains production data and must NEVER be the
target of a test run. `beebo_test.db` exists in the repo for this reason.
Always use an isolated test database via `DB_PATH`.

### Safe test workflow

```bash
# 1. Start the server against an isolated test database (not beebo.db)
DB_PATH=beebo_test.db python app.py &

# 2. In another terminal, run whichever test suite(s) apply
./test_comments.sh
./test_comments2.sh
./test_comment_changes.sh
./test_comment_delete.sh
./test_follows.sh
./test_highlights.sh
./test_highlights_video.sh
./test_csrf_and_ratelimit.sh
./test_pagination.sh
./test_likes_race.sh
./test_session_migration.sh
./test_spa_routes.sh
./test_file_cleanup.sh
./test_wallet.sh
python3 test_wallet_logic.py   # no server needed; uses its own temp DB
# or: ./run_all_tests.sh

# 3. Clean up the test db when done (safe to delete - it's not beebo.db)
rm -f beebo_test.db
```

More `test_*.sh` scripts exist now than the old doc listed (CSRF,
pagination, race conditions, session migration, SPA routes, file cleanup)
— reflecting the CSRF/pagination/session hardening work since. `ls
test_*.sh` for the current full list rather than trusting any hardcoded
list, including this one.

### What NOT to do

Never run any `test_*.sh` script against a server started without
`DB_PATH` set. The default database is `beebo.db`, which contains real
user data. Running tests against it will reset the schema and wipe all
accounts.

### Verification

```bash
sqlite3 beebo.db "SELECT 'users:', COUNT(*) FROM users; SELECT 'posts:', COUNT(*) FROM posts;"
```
Row counts should be identical before/after a test run — tests should not
touch `beebo.db` at all.

## Repo hygiene (as of this update — not architecture, just noise)

Present in the tree but not part of the app: `app.py.backup`,
`_archive/beebo.html.bak` (pre-refactor snapshot), `cookies*.txt` /
`cookie_*.txt` (session-cookie dumps from manual curl testing),
`server.log`, `test_server.log`, `.flask_secret_key`, `flask_session/`
(session store), `beebo_test.db`. None of these should be treated as
source of truth for current behavior — `_archive/beebo.html.bak` in
particular documents the pre-split architecture this file replaces.
