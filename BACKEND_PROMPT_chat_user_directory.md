# Backend prompt (for Claude Code): chat user directory

Context: Beebo (Flask + raw sqlite3, blueprints under `app/routes/`, shared row->JSON in
`app/serializers.py`, search logic in `app/search_service.py`). Read `CLAUDE.md` first.
Do not touch frontend files.

## Goal
The Chats "New message" screen (`static/js/chat-new-message.js`, `chatDirectoryLocal`)
needs a list of people the signed-in user can message when the search box is EMPTY.
Today only `GET /api/search?type=people&q=` exists, and it rejects an empty `q`.

## Endpoint
`GET /api/users` (new, in `app/routes/users.py`)

- Auth: session required, else 401 `{"error": "Authentication required"}` (same as `_require_login` in `search.py`).
- Query params:
  - `q` (optional): when present, same matching/ranking as `search_service._search_people`
    but restricted to `username` and `full_name` (NOT bio). Strip a leading `@`.
  - `limit` (default 30, clamp to [1, 50]) and `cursor` (user id keyset, optional).
- Without `q`: return suggested people for DMs, ordered by relevance: people the user
  follows or who follow them first, then everyone else alphabetically by `full_name`
  (COLLATE NOCASE). Exclude the signed-in user.
- Response: `{"users": [serialize_user_public(row), ...], "next_cursor": id-or-null}`
  using the existing serializer (fields: id, full_name, handle, profile_picture, username, ...).
- Reuse `search_service` helpers where possible; add the SQL there, keep the route thin.

## Tests
Follow the project's testing rules in CLAUDE.md (never run against `beebo.db`; use a temp DB).
Cover: 401 when logged out, self excluded, `q` matches name/username but not bio, `@` prefix,
limit clamp, cursor pagination, empty result.

## Frontend follow-up (not part of this task)
Swap `chatDirectoryLocal` for a call to this endpoint when `q` is empty.
