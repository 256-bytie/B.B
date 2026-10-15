# Beebo — Direct messaging (1:1 text)

Design + research record for the real direct-messaging backend that replaced
the client-side mock chat data (`chatMockMessages` / `chatMockThreads` in
`static/js/chat.js`). Scope is deliberately narrow: **direct (two-user) text
messaging only** — no groups, calls, voice notes, attachments, reactions,
edit/delete, typing indicators, read receipts, forwarding, search, push
notifications, message requests, or blocking (those are product decisions
for later; see "Known limitations").

## 1. Stack audit (verified against the repo, 2026-10-11)

- Flask 3.0.2, Werkzeug 3.0.1, Flask-Session 0.8.0 (filesystem server-side
  sessions), flask-cors. `requirements.txt` contains no websocket/async/queue
  libraries. Entry point `app.py` → `create_app()` →
  `app.run(debug=False, host='127.0.0.1', port=5050)`.
- Werkzeug's dev server runs **threaded by default** (`app.run` sets
  `threaded=True` when not overridden — verified in Flask 3.0.2 source),
  so concurrent requests and long-held polls are possible without changing
  how the app is started.
- Storage: raw `sqlite3`, no ORM, one connection per request
  (`app/db.get_db()`), schema changes as numbered `migrations/*.sql` run by
  `app/migrations.py` (001–007 existed; this work added 008).
- Auth: session cookie (`session['user_id']`); every mutating request must
  carry `X-CSRF-Token` (enforced globally in `app/__init__.py:csrf_protect`).
  In-process rate limiting precedent: login limiter in `app/routes/auth.py`.
- Code layout convention: thin blueprint (`app/routes/<domain>.py`) over a
  Flask-free service module (`app/wallet.py`, `app/community_service.py`,
  `app/post_service.py`); shared row shaping in `app/serializers.py`; JSON
  errors as `{"error": "..."}`. Followed here: `app/chat_service.py` +
  `app/routes/chat.py`.
- No chat tables, endpoints, or realtime infrastructure existed before this
  work (grepped; also confirmed by `docs/CHATS_FLOW_DOCUMENTATION.md` §9).

## 2. Candidates evaluated

### A. Full self-hosted chat systems — REJECTED

Matrix/Synapse, Rocket.Chat, Mattermost, Zulip (plus lightweight Matrix
homeservers like Conduit and its forks). All are **separate services with
their own database and their own user directory / auth**. That conflicts
with Beebo on every axis that matters here:

- data ownership lives in a second DB that the rest of Beebo never reads;
- auth would need SSO/bridging against Flask server-side sessions — real
  ongoing work, not a drop-in;
- the frontend contract below (plain JSON over the session cookie) would be
  replaced by the chat system's own protocol/SDK;
- operational cost (a second long-running process) for a feature that is 1:1
  text only at this stage.

No candidate in this class can be embedded in the existing Flask process, so
none was justified.

### B-1. Hosted chat SDKs (Stream, Sendbird, Firebase) — REJECTED

Message data would leave Beebo's database entirely (vendor lock-in, cost,
privacy), and auth would again be separate from the session cookie. Rejected
on data ownership alone.

### B-2. Flask-SocketIO — REJECTED for now (documented upgrade path)

- Current release 5.7.0 (MIT, actively maintained by Miguel Grinberg —
  verified on PyPI), runs in **threading mode** via `simple-websocket`
  without eventlet/gevent. Technically viable on this stack.
- Why rejected anyway: it adds a second realtime protocol (Socket.IO
  framing + reconnect semantics) that the no-build-step frontend must
  implement, changes the serving assumptions (async workers vs. the plain
  threaded dev server), needs its own care with per-thread sqlite3
  connections in background tasks — and the long-poll fallback endpoint
  (§4, `GET /api/chat/updates`) would still be required for error/reconnect
  paths. For 1:1 text at current scale that is complexity without a
  corresponding win. If Beebo later needs presence/typing/multi-device
  fan-out at higher scale, Socket.IO (threading mode, or ASGI) is the
  recommended upgrade: the service layer (`app/chat_service.py`) is
  Flask-free and the message schema would not change.

### B-3. SSE from Flask — REJECTED in favor of long-polling

SSE is implementable on the threaded dev server
(`Response(generator(), mimetype='text/event-stream')`), but it brings
proxy/keep-alive/heart-beat pitfalls and reconnect bookkeeping that
long-polling avoids: a long-poll response is an ordinary JSON request the
existing fetch wrapper, CSRF handling, and 401 handling already cover. The
cursor model (`after=<last message id>`) is identical either way.

### C. Custom on the existing stack — **CHOSEN**

Own tables + a small API + **long-polling** as the realtime mechanism, with
zero new dependencies (`requirements.txt` unchanged). This matches the
project rule: don't force custom code when a suitable solution exists, but
also don't add a service or dependency without showing it is necessary —
nothing evaluated earns its cost for 1:1 text at this scale, while the
custom path reuses auth, CSRF, the DB layer, and the code-layout convention
as-is.

## 3. Chosen approach and trade-offs

**Data model** (`migrations/008_direct_messages.sql`, idempotent):

- `conversations(id, user_low_id, user_high_id, created_at)` — both columns
  `REFERENCES users(id) ON DELETE CASCADE`, `CHECK(user_low_id <
  user_high_id)`, `UNIQUE(user_low_id, user_high_id)`. A duplicate DM for
  the same pair is impossible at the database level and the pair order is
  canonical (`min(id)`, `max(id)`).
- `messages(id AUTOINCREMENT, conversation_id FK CASCADE, sender_id FK
  CASCADE, body TEXT NOT NULL, client_id TEXT, created_at)` with
  `UNIQUE(conversation_id, sender_id, client_id)` (NULL `client_id` rows
  never conflict — SQLite treats NULLs as distinct) and index
  `(conversation_id, id)`. **Ordering and cursors use `id`, never
  timestamps**; ids are monotonic.
- `conversation_reads(conversation_id, user_id, last_read_message_id,
  PK(conversation_id, user_id))` — the per-user unread cursor. Private by
  design: it is never exposed to the other party (this is not a read
  receipt).
- `conversation_state(conversation_id PK, last_message_id)` — kept in sync
  inside the same transaction as each message insert; makes the
  conversation-list ordering (`ORDER BY last_message_id DESC`) a single
  indexed join instead of a per-conversation `MAX(id)` subquery.
  Conversations with no messages sort last (kept in the list, not omitted —
  a just-created conversation shows as an empty thread).

**Realtime mechanism.** A process-global `threading.Condition` + a version
counter in `app/chat_service.py`; every message insert and conversation
creation bumps it and `notify_all()`s. `GET /api/chat/updates` loops:
fetch-against-a-fresh-connection → return if anything new → else
`cond.wait(timeout=…, max 25 s)`. Properties:

- a held poll **never holds a DB connection or transaction open** — the
  connection is opened, read, and closed each iteration, and the wait
  itself uses no DB resource;
- delivery is immediate on a same-process insert (the waiter is notified)
  with a 1 s DB re-check as a belt-and-braces fallback;
- the frontend resumes with the highest message id it has seen, so no
  message is missed or duplicated across reconnects (`m.id > after`).

Trade-off accepted: each held poll occupies one server thread for up to
25 s. Werkzeug's threaded dev server spawns a thread per request, so this
is fine at current scale but is the first thing to revisit (SSE/Socket.IO
or a production WSGI server with enough workers) if concurrent viewers
grow.

**Idempotency / concurrency.** Message sends and conversation creation run
inside a PostgreSQL transaction with a per-conversation `FOR UPDATE` lock (same pattern as `wallet.claim_monthly_reward`), so
two simultaneous `POST /api/chat/conversations` for the same pair produce
exactly one row, and a retried send with the same `client_id` returns the
original message with 200 (UNIQUE constraint as the backstop, handled as a
re-read).

**Rate limiting.** In-process, mirroring the login limiter: 20 messages
per 10 s per user (`app/routes/chat.py`), excess → 429.

**Timestamps.** Stored via SQLite `CURRENT_TIMESTAMP` → `'YYYY-MM-DD
HH:MM:SS'` UTC strings, same as the rest of the core API (posts, comments).

## 4. Endpoints (as implemented)

All require login (401 `{"error": "Authentication required"}`); mutating
ones require the CSRF header; viewer identity always comes from the session.

1. `GET /api/chat/conversations` → `{"conversations": [{id, user: {id,
   full_name, handle, profile_picture}, last_message: {id, sender_id, body,
   created_at} | null, unread_count}]}`, ordered by most recent activity,
   conversations with no messages last (kept, not omitted).
2. `POST /api/chat/conversations` `{"user_id": int}` → get-or-create.
   201 created / 200 already existed, body = one list item. 400 for
   yourself or an invalid id, 404 for an unknown user. Concurrency-safe.
3. `GET /api/chat/conversations/<id>/messages?before=<message_id>&limit=<n>`
   → `{"messages": [{id, conversation_id, sender_id, body, created_at}],
   "has_more": bool}`. Newest page by default, `limit` default 50 / max 100
   (clamped), returned ascending; `before` pages further back. 404 when the
   conversation does not exist **or** the viewer is not a member.
4. `POST /api/chat/conversations/<id>/messages` `{"body": str,
   "client_id": str}` → 201 `{"message": {...}}`; duplicate `client_id`
   from the same sender in the same conversation → 200 with the existing
   message. Body trimmed, must be non-empty and ≤ 2000 chars, plain text
   only. Membership enforced server-side; rate limited (429).
5. `POST /api/chat/conversations/<id>/read` `{"up_to": message_id}` → 204.
   Moves only the viewer's own cursor, forward-only, clamped to the
   conversation's last message id.
6. `GET /api/chat/updates?after=<message_id>` → `{"messages": [...ascending,
   across all of the viewer's conversations...], "has_more": bool,
   "conversations": [...list items...]}`. Optional long-poll: `wait_seconds`
   (max 25, default 0 = immediate) holds the request until something new
   arrives or the deadline passes. **Documented deviation/extension:** the
   spec's "conversations created for the viewer since" is implemented as
   (a) the full current conversation list by default (lets the frontend
   refresh previews/unread counts in the same tick) and (b) an optional
   `conv_after=<conversation_id>` filter that narrows it to conversations
   created after that id. `limit` for the message page defaults to 100,
   clamped to [1, 200].

## 5. Setup / run

No new dependencies, no env vars, no change to the dev-server command:
`DB_PATH=... python app.py` as before. Migration 008 applies automatically
at startup via `init_db()` → `run_migrations()`.

## 6. Known limitations

- One process only: the realtime condition variable and the rate limiter
  are in-memory, so multi-worker deployments (gunicorn >1 worker) would
  need a shared broker before they are safe. The threaded dev server (the
  documented way to run Beebo) is one process.
- Held updates polls occupy one thread each (see trade-off above).
- Out of scope by decision (not by accident): groups, attachments, calls,
  reactions, edit/delete, typing indicators, read receipts/delivery ticks,
  forwarding, in-chat search, push notifications, message requests/approval,
  blocking, presence. `docs/CHATS_FLOW_DOCUMENTATION.md` §13 tracks them.
