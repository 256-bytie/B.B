# Claude Code prompt: one-to-one direct messaging (backend)

Paste everything below the line into Claude Code, run from the project root.

---

Read `CLAUDE.md` first. Implement **real one-to-one direct messaging** for Beebo, replacing the client-side mock chat data. Per the project's two-agent workflow you own the backend (`app/`, `migrations/`, `tests/`, `requirements.txt`, docs); do **not** edit `static/` or `templates/` (the chat frontend is wired separately against the contract below). Never touch `beebo.db`: run every server and test with `DB_PATH=beebo_test.db`.

## 0. Scope

Only direct (two-user) text messaging. Out of scope, do not build even if a library offers it: groups, calls, voice notes, attachments, reactions, edit/delete, typing indicators, read receipts / delivery status shown to the other party, forwarding, search, push notifications, message requests/approval flow, blocking.

## 1. Facts already verified in this repo (do not re-assume, but do re-check anything you rely on)

- Flask 3.0.2, Flask-Session 0.8.0, flask-cors, Werkzeug 3.0.1. `requirements.txt` has no websocket/async/queue libraries. Entry: `app.py` → `create_app()`; `app.run(debug=False, host='127.0.0.1', port=5050)` (Flask's threaded dev server).
- Raw `sqlite3`, no ORM. `app/db.py` `get_db()` (foreign keys ON), `DB_PATH` env var. Schema changes = new numbered file in `migrations/` run by `app/migrations.py` (existing: `001`..`007`; next is `008`). Re-verify the numbering.
- Auth: server-side session cookie, `session['user_id']`. All mutating requests need an `X-CSRF-Token` header (see `app/__init__.py`); do not weaken or bypass it. There is a rate limiter (see `tests/test_csrf_and_ratelimit.sh`); apply it to message sending.
- Code layout convention: thin blueprint in `app/routes/<domain>.py` → Flask-free logic in a service module (`app/wallet.py`, `app/community_service.py`); shared row→dict shaping in `app/serializers.py`; JSON errors as `{"error": "..."}`. Follow it.
- Users: `users(id, full_name, email, username, profile_picture, bio, ...)`; public shape via `serialize_user_public` (`id`, `full_name`, `handle`, `profile_picture`, ...). `GET /api/search?type=people&q=` exists (the frontend already uses it to find people).
- No chat tables, endpoints or real-time infrastructure exist today (grep before starting to confirm).
- Frontend today: all conversations/messages are hardcoded in `static/js/chat.js` (`chatMockMessages`, `chatMockThreads`). Details: `docs/CHATS_FLOW_DOCUMENTATION.md`.

## 2. Research first (do not skip, do not just write a custom backend)

Inspect the repo, then evaluate existing open-source options against: stack fit (Flask + raw sqlite3 + session auth, no build step frontend), reuse of the existing auth, persistent 1:1 conversations, real-time delivery, data ownership/privacy, self-hosting cost, license, maintenance, and how much existing code would need rewriting. Use official docs and repositories; do not pick by popularity. Verify versions, licenses and activity yourself, now.

Candidates to look at (my pre-research hypotheses from general knowledge, **not verified**, treat as leads only):
- Full self-hosted chat systems (Matrix/Synapse, Rocket.Chat, Mattermost, Zulip): likely a separate backend + database + user directory + auth, which conflicts with "don't add a separate backend/database unless necessary" and with Beebo's session auth and UI; probably rejected unless you can show otherwise.
- Hosted chat SDKs (Stream, Sendbird, Firebase): data leaves Beebo, vendor lock-in, cost; probably rejected on data ownership.
- Real-time transports that can sit on the existing stack: Flask-SocketIO (needs a worker/async mode and changes how the app is run), Server-Sent Events from Flask, plain long-polling, Centrifugo (separate service).
- Existing open-source 1:1 chat schemas/implementations to borrow patterns from.

Decide A (full integration), B (reuse libraries/patterns, build the rest) or C (custom on the existing stack) per the rule: do not force custom code when a suitable solution exists, and do not add a service/dependency without showing it is necessary. Write the decision and the rejected alternatives with reasons into `docs/DIRECT_MESSAGING.md` before implementing. If an important decision cannot be made safely, state the specific blocker instead of guessing. My expectation is B/C (own tables + a small API + the simplest real-time mechanism that works with the current server), but the research decides.

## 3. Data model (adjust if research says otherwise; keep the properties)

New migration `migrations/008_direct_messages.sql` (idempotent, `IF NOT EXISTS`, indexes included):

- `conversations`: `id`, `user_low_id`, `user_high_id` (both `REFERENCES users(id) ON DELETE CASCADE`, `CHECK(user_low_id < user_high_id)`, `UNIQUE(user_low_id, user_high_id)`), `created_at`. This makes a duplicate DM for the same pair impossible at the database level and the pair order canonical.
- `messages`: `id INTEGER PRIMARY KEY AUTOINCREMENT` (monotonic; **order and cursors use `id`, not timestamps**), `conversation_id` (FK, cascade), `sender_id` (FK), `body TEXT NOT NULL`, `client_id TEXT` (idempotency key), `created_at`. `UNIQUE(conversation_id, sender_id, client_id)` where `client_id` is not null. Index `(conversation_id, id)`.
- Per-user unread cursor, e.g. `conversation_reads(conversation_id, user_id, last_read_message_id, PRIMARY KEY(conversation_id, user_id))`. It is private: never expose one user's cursor to the other (this is not a read receipt).
- Conversation list ordering by latest message; keep it cheap (index or a `last_message_id` kept in sync in the same transaction).

## 4. API contract (the frontend is written against exactly this; if you must deviate, document it in the final report)

All endpoints require login (401 `{"error": "Authentication required"}` otherwise), return JSON, and mutating ones require the CSRF header. Timestamps `YYYY-MM-DD HH:MM:SS` UTC like the rest of the API. Viewer identity always comes from the session, never from the request body.

1. `GET /api/chat/conversations` → `{"conversations": [ { "id", "user": {id, full_name, handle, profile_picture}, "last_message": {id, sender_id, body, created_at} | null, "unread_count": int } ]}` ordered by most recent activity (conversations with no messages last or omitted: pick one and document; the frontend shows an empty thread for a just-created conversation either way).
2. `POST /api/chat/conversations` body `{"user_id": int}` → get-or-create the DM with that user. 201 when created, 200 when it already existed, same shape as one list item. 400 for yourself or invalid id, 404 for an unknown user. Concurrency-safe (two simultaneous calls yield one row).
3. `GET /api/chat/conversations/<id>/messages?before=<message_id>&limit=<n>` → `{"messages": [ {id, conversation_id, sender_id, body, created_at} ], "has_more": bool}`. Newest page by default, `limit` default 50 / max 100, returned in **ascending** order (oldest first), `before` pages further back. 404 when the conversation does not exist **or the viewer is not a member** (do not reveal existence).
4. `POST /api/chat/conversations/<id>/messages` body `{"body": str, "client_id": str}` → 201 `{"message": {...}}`. Trim; reject empty or whitespace-only and anything over a fixed max (suggest 2000 chars) with 400; plain text only (the frontend escapes on render, but do not store markup-interpreted content). Same `client_id` from the same sender in the same conversation returns the existing message with 200 instead of inserting again (safe retries). Membership enforced server-side; rate limited.
5. `POST /api/chat/conversations/<id>/read` body `{"up_to": message_id}` → 204. Moves only the viewer's own cursor, forward only, never beyond the conversation's last message.
6. Real-time: provide `GET /api/chat/updates?after=<message_id>` returning `{"messages": [ {id, conversation_id, sender_id, body, created_at, ...} ], "conversations": [ ...list items for conversations created for the viewer since... ] }` for all of the viewer's conversations, ascending, with optional long-poll behaviour (hold up to ~25 s when nothing new, return early on a new message; make sure a held request does not exhaust the server's threads or hold a DB connection/transaction open). If your research shows SSE or WebSockets are the right mechanism for this server, add it as an upgrade **in addition to** this endpoint, which stays the fallback the frontend uses on error or when the stream drops. The frontend resumes with the highest message id it has seen, so no message may be missed or duplicated across reconnects.

Authorization rules to test explicitly: a user cannot read, post to, mark read, or discover conversations they are not in; the sender of a message is always the session user; an unauthenticated or CSRF-less mutation is rejected.

## 5. Tests and verification

Add tests following `tests/` conventions (the `.sh`/`.py` style and `scripts/run_all_tests.sh`), against `DB_PATH=beebo_test.db` with at least two accounts. Cover at least: start a DM; duplicate start returns the same conversation (also from the other user, and under concurrency); send; recipient sees it in the list (last message, unread count) and in history; history order and `before` paging; persistence across server restart; updates endpoint delivers a new message to the recipient without a refresh and not to a third user; idempotent retry with the same `client_id`; validation errors; cross-user access denied (404) for read/post/read-marker/updates; self-DM rejected; CSRF/auth enforced; rate limit. Run the full existing suite and report results exactly as they came out; do not claim tests you did not run.

## 6. Deliverables

- Migration, service module, blueprint registered in the app factory, serializer additions, tests, dependencies only if the research justifies them (pin versions).
- `docs/DIRECT_MESSAGING.md`: stack audit summary, candidates evaluated and why chosen/rejected, the chosen approach and trade-offs, schema, endpoints actually implemented (flag any deviation from section 4), env vars/config/run instructions (note if the dev server command in `app.py` needs to change), known limitations.
- Update `CLAUDE.md` (architecture map + the chat row) and `docs/CHATS_FLOW_DOCUMENTATION.md` §9 (backend relationship) and §12/§13.
- Final report: what you found, what you chose and why, files and DB changes, setup steps, the tests you ran and their real results, limitations.

Do not stop at a plan; implement once the audit and research support a decision. Keep the scope to 1:1 text and leave the code clean and extensible.
