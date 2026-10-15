"""Direct (1:1) messaging logic: conversations, messages, read cursors.

Deliberately Flask-free (a plain psycopg connection in, plain values out),
matching app/wallet.py / app/post_service.py / app/community_service.py.
app/routes/chat.py is the thin HTTP layer on top.

Model
-----
- `conversations` canonicalizes a pair as (user_low_id, user_high_id) with
  a UNIQUE constraint, so a duplicate DM for the same two users is
  impossible at the database level and get-or-create races collapse into
  one row (send/get-or-create run under an implicit psycopg transaction, same pattern as
  wallet.claim_monthly_reward).
- `messages.id` is monotonic and is the ONLY ordering/cursor key
  (timestamps are not). Pages are ascending (oldest first).
- `conversation_reads` is the per-user unread cursor. Private by design:
  never exposed to the other party — this is not a read receipt.
- `conversation_state.last_message_id` is kept in sync inside the same
  transaction as each insert so the conversation list orders by recent
  activity with an indexed join instead of a per-row MAX(id) subquery.

Realtime
--------
`_update_condition` + `_update_version` form a process-global publish/
subscribe point: every message insert and conversation creation bumps the
version and notifies waiters. The long-poll updates endpoint
(GET /api/chat/updates, see app/routes/chat.py) waits on the condition —
never holding a DB connection or transaction open while waiting — with a
periodic DB re-check as a fallback. In-memory, therefore single-process:
multi-worker deployments need a shared broker before they are safe.
"""
import threading
import time

import psycopg.errors

DEFAULT_MESSAGES_LIMIT = 50
MAX_MESSAGES_LIMIT = 100

DEFAULT_UPDATES_LIMIT = 100
MAX_UPDATES_LIMIT = 200

MAX_MESSAGE_LEN = 2000

# Long-poll behaviour for GET /api/chat/updates.
UPDATES_MAX_WAIT_SECONDS = 25
_UPDATES_DB_RECHECK_SECONDS = 1.0  # fallback poll while holding a request

from app.serializers import serialize_chat_message, serialize_conversation

# ---- realtime signalling (process-global) ----

_update_condition = threading.Condition()
_update_version = 0


def notify_updates():
    """Signal that something new exists (message inserted / conversation
    created). Cheap; safe to call from any thread."""
    global _update_version
    with _update_condition:
        _update_version += 1
        _update_condition.notify_all()


def wait_for_updates(deadline, last_version):
    """Block until something new is signalled or `deadline` (monotonic
    time from time.monotonic()) passes.

    Returns (signalled, current_version): signalled is True when a new
    update was notified (the caller should re-query the DB); on timeout
    it is False. Never touches the DB, so a held long-poll holds no
    connection or transaction open while waiting.
    """
    with _update_condition:
        if _update_version != last_version:
            return True, _update_version
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False, _update_version
        # wait_for returns early on notify; on timeout the version may
        # still have moved (notify between timeout and lock reacquire),
        # so compare versions rather than trusting the return value.
        _update_condition.wait(remaining)
        return _update_version != last_version, _update_version


# ---- errors (HTTP layer maps these to status codes) ----

class ChatValidationError(Exception):
    """A 400: bad input. str(err) is the user-facing message."""


class ConversationNotFoundError(Exception):
    """A 404: no such conversation, or the viewer is not a member —
    intentionally indistinguishable so membership can't be probed."""


class UserNotFoundError(Exception):
    """A 404: no such user to start a conversation with."""


# ---- helpers ----

def _pair_ids(user_a, user_b):
    low, high = min(user_a, user_b), max(user_a, user_b)
    return low, high


def _fetch_conversation_row(cursor, conversation_id):
    cursor.execute(
        'SELECT id, user_low_id, user_high_id, created_at '
        'FROM conversations WHERE id = %s',
        (conversation_id,)
    )
    return cursor.fetchone()


def _require_member(cursor, conversation_id, user_id):
    """The conversation row if it exists AND user_id is a member, else None."""
    row = _fetch_conversation_row(cursor, conversation_id)
    if row is None:
        return None
    if user_id not in (row[1], row[2]):
        return None
    return row


def _user_public_row(cursor, user_id):
    cursor.execute(
        'SELECT id, full_name, email, profile_picture, cover_image, '
        'username, bio FROM users WHERE id = %s',
        (user_id,)
    )
    return cursor.fetchone()


def _last_read(cursor, conversation_id, user_id):
    cursor.execute(
        'SELECT last_read_message_id FROM conversation_reads '
        'WHERE conversation_id = %s AND user_id = %s',
        (conversation_id, user_id)
    )
    row = cursor.fetchone()
    return row[0] if row else 0


def _message_rows(cursor, conversation_id, after_id=None, before_id=None,
                  limit=None, ascending=True):
    """Page of messages for one conversation. Returns (rows, has_more).

    Rows are ascending (oldest first) when ascending=True; the newest page
    is fetched by taking the tail of a descending query and reversing, so
    `before` pages further back from the newest.
    """
    where = 'm.conversation_id = %s'
    params = [conversation_id]
    if after_id is not None:
        where += ' AND m.id > %s'
        params.append(after_id)
    if before_id is not None:
        where += ' AND m.id < %s'
        params.append(before_id)
    order = 'ASC' if ascending else 'DESC'
    sql = (
        'SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at '
        f'FROM messages m WHERE {where} ORDER BY m.id {order}'
    )
    if limit is not None:
        sql += ' LIMIT %s'
        params.append(limit)
    return cursor.execute(sql, params).fetchall()


def _serialize_conversation_pair(cursor, conv_row, viewer_id):
    """(row, last_message_row_or_None) -> list-item dict via the serializer."""
    conversation_id, user_low_id, user_high_id = conv_row[0], conv_row[1], conv_row[2]
    other_id = user_high_id if viewer_id == user_low_id else user_low_id
    other_row = _user_public_row(cursor, other_id)

    cursor.execute(
        'SELECT m.id, m.sender_id, m.body, m.created_at '
        'FROM conversation_state s JOIN messages m ON m.id = s.last_message_id '
        'WHERE s.conversation_id = %s',
        (conversation_id,)
    )
    last_message = cursor.fetchone()

    last_read = _last_read(cursor, conversation_id, viewer_id)
    unread = 0
    if last_message is not None and last_message[0] > last_read \
            and last_message[1] != viewer_id:
        unread = cursor.execute(
            'SELECT COUNT(*) FROM messages '
            'WHERE conversation_id = %s AND id > %s AND sender_id != %s',
            (conversation_id, last_read, viewer_id)
        ).fetchone()[0]

    return serialize_conversation(
        conv_row, other_row, last_message, unread, viewer_id
    )


# ---- conversations ----

def list_conversations(cursor, viewer_id):
    """All of the viewer's conversations, most recent activity first,
    conversations with no messages last (kept, not omitted)."""
    cursor.execute(
        'SELECT c.id, c.user_low_id, c.user_high_id, c.created_at '
        'FROM conversations c '
        'LEFT JOIN conversation_state s ON s.conversation_id = c.id '
        'WHERE c.user_low_id = %s OR c.user_high_id = %s '
        'ORDER BY COALESCE(s.last_message_id, 0) DESC, c.id DESC',
        (viewer_id, viewer_id)
    )
    rows = cursor.fetchall()
    return [_serialize_conversation_pair(cursor, row, viewer_id) for row in rows]


def get_or_create_conversation(cursor, viewer_id, other_user_id):
    """Get or create the DM between viewer_id and other_user_id.

    Returns (conversation_id, created). Runs inside the caller's implicit
    transaction. The unique pair constraint prevents duplicate rows;
    INSERT ON CONFLICT resolves concurrent creation without aborting the transaction.

    Raises ChatValidationError for a self-DM or invalid id,
    UserNotFoundError for an unknown user.
    """
    if not isinstance(other_user_id, int) or isinstance(other_user_id, bool):
        raise ChatValidationError('Invalid user_id')
    if other_user_id == viewer_id:
        raise ChatValidationError('Cannot start a conversation with yourself')
    if other_user_id < 1:
        raise ChatValidationError('Invalid user_id')

    if _user_public_row(cursor, other_user_id) is None:
        raise UserNotFoundError('User not found')

    low, high = _pair_ids(viewer_id, other_user_id)

    cursor.execute(
        'SELECT id FROM conversations WHERE user_low_id = %s AND user_high_id = %s',
        (low, high)
    )
    existing = cursor.fetchone()
    if existing:
        return existing[0], False
    # INSERT ... ON CONFLICT DO NOTHING prevents race conditions;
    # if nothing inserted, the row already exists and we fetch it.
    cursor.execute(
        'INSERT INTO conversations (user_low_id, user_high_id) '
        'VALUES (%s, %s) '
        'ON CONFLICT (user_low_id, user_high_id) DO NOTHING '
        'RETURNING id',
        (low, high)
    )
    row = cursor.fetchone()
    if row:
        conversation_id = row[0]
        cursor.execute(
            'INSERT INTO conversation_state (conversation_id, last_message_id) '
            'VALUES (%s, 0)',
            (conversation_id,)
        )
        return conversation_id, True
    # Lost the race; fetch the existing conversation
    cursor.execute(
        'SELECT id FROM conversations WHERE user_low_id = %s AND user_high_id = %s',
        (low, high)
    )
    row = cursor.fetchone()
    if row is None:
        raise RuntimeError('Conversation not found after conflict')
    return row[0], False


def conversation_exists_for_pair(cursor, user_a, user_b):
    low, high = _pair_ids(user_a, user_b)
    cursor.execute(
        'SELECT id FROM conversations WHERE user_low_id = %s AND user_high_id = %s',
        (low, high)
    )
    return cursor.fetchone() is not None


# ---- messages ----

def send_message(conn, conversation_id, sender_id, body, client_id=None):
    """Validate, insert, advance the unread pointers, and signal waiters.

    Returns (message_row_dict, created). A retried send with the same
    client_id from the same sender in the same conversation returns the
    original message with created=False (safe retries).

    Raises ChatValidationError for an empty/oversized body,
    ConversationNotFoundError when sender is not a member.
    """
    if body is None:
        raise ChatValidationError('Message body is required')
    body = str(body).strip()
    if not body:
        raise ChatValidationError('Message cannot be empty')
    if len(body) > MAX_MESSAGE_LEN:
        raise ChatValidationError(
            f'Message cannot exceed {MAX_MESSAGE_LEN} characters'
        )

    # Clamp client_id so an absurdly long key can't be stored (it still
    # dedupes correctly as long as the same value is retried).
    if client_id is not None:
        client_id = str(client_id)
        if not client_id:
            client_id = None
        elif len(client_id) > 255:
            client_id = client_id[:255]

    try:
        cursor = conn.cursor()
        # Take a per-conversation lock to ensure message IDs become visible
        # in order. Without this, message N+1 can commit before message N,
        # and a long-poll reader at cursor N will miss message N forever.
        cursor.execute(
            'SELECT 1 FROM conversations WHERE id = %s FOR UPDATE',
            (conversation_id,)
        )
        if cursor.fetchone() is None:
            raise ConversationNotFoundError('Conversation not found')

        row = _require_member(cursor, conversation_id, sender_id)
        if row is None:
            raise ConversationNotFoundError('Conversation not found')

        # Idempotency: INSERT ... ON CONFLICT by client_id.
        # If nothing inserted, fetch the existing message.
        cursor.execute(
            'INSERT INTO messages (conversation_id, sender_id, body, client_id) '
            'VALUES (%s, %s, %s, %s) '
            'ON CONFLICT (conversation_id, sender_id, client_id) DO NOTHING '
            'RETURNING id, conversation_id, sender_id, body, created_at',
            (conversation_id, sender_id, body, client_id)
        )
        row = cursor.fetchone()
        if row:
            # New message inserted
            message_id = row[0]
            message_data = row
            created = True
            # Update conversation_state with GREATEST to ensure monotonic increment
            cursor.execute(
                'INSERT INTO conversation_state (conversation_id, last_message_id) '
                'VALUES (%s, %s) '
                'ON CONFLICT(conversation_id) DO UPDATE '
                'SET last_message_id = GREATEST(conversation_state.last_message_id, excluded.last_message_id)',
                (conversation_id, message_id)
            )
        else:
            # Idempotent retry: fetch the existing message
            cursor.execute(
                'SELECT id, conversation_id, sender_id, body, created_at '
                'FROM messages WHERE conversation_id = %s AND sender_id = %s '
                'AND client_id = %s',
                (conversation_id, sender_id, client_id)
            )
            message_data = cursor.fetchone()
            created = False

        conn.commit()
    except ConversationNotFoundError:
        conn.rollback()
        raise
    except Exception:
        conn.rollback()
        raise

    if created:
        notify_updates()
    return serialize_chat_message(message_data), created


def get_messages(cursor, conversation_id, viewer_id, before_id=None,
                 limit=DEFAULT_MESSAGES_LIMIT):
    """Ascending page of a conversation's messages, newest page by default.

    Returns (message_dicts, has_more) where has_more refers to older
    messages (fetch the next page with before=<first id of this page>).
    Raises ConversationNotFoundError when the conversation doesn't exist
    or the viewer isn't a member.
    """
    limit = max(1, min(int(limit), MAX_MESSAGES_LIMIT))
    row = _require_member(cursor, conversation_id, viewer_id)
    if row is None:
        raise ConversationNotFoundError('Conversation not found')

    rows = _message_rows(
        cursor, conversation_id, before_id=before_id, limit=limit,
        ascending=False
    )
    rows.reverse()  # return ascending (oldest first)
    has_more = len(rows) == limit and _message_rows(
        cursor, conversation_id, before_id=rows[0][0], limit=1,
        ascending=False
    )
    return [serialize_chat_message(r) for r in rows], bool(has_more)


def get_message(conn, conversation_id, message_id, viewer_id):
    """One message, membership-checked. Raises ConversationNotFoundError."""
    cursor = conn.cursor()
    row = _require_member(cursor, conversation_id, viewer_id)
    if row is None:
        raise ConversationNotFoundError('Conversation not found')
    cursor.execute(
        'SELECT id, conversation_id, sender_id, body, created_at '
        'FROM messages WHERE id = %s AND conversation_id = %s',
        (message_id, conversation_id)
    )
    message = cursor.fetchone()
    if message is None:
        raise ConversationNotFoundError('Conversation not found')
    return serialize_chat_message(message)


def mark_read(cursor, conversation_id, viewer_id, up_to_message_id):
    """Advance the viewer's own unread cursor (forward-only, clamped to the
    conversation's last message). Returns the new cursor value.

    Raises ConversationNotFoundError when the conversation doesn't exist or
    the viewer isn't a member; ChatValidationError for a bad up_to value.
    """
    if not isinstance(up_to_message_id, int) or isinstance(up_to_message_id, bool) \
            or up_to_message_id < 1:
        raise ChatValidationError('Invalid up_to value')

    row = _require_member(cursor, conversation_id, viewer_id)
    if row is None:
        raise ConversationNotFoundError('Conversation not found')

    cursor.execute(
        'SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = %s',
        (conversation_id,)
    )
    last_message_id = cursor.fetchone()[0]
    new_cursor = min(up_to_message_id, last_message_id)

    current = _last_read(cursor, conversation_id, viewer_id)
    if new_cursor <= current:
        return current  # never move backwards

    cursor.execute(
        'INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id) '
        'VALUES (%s, %s, %s) '
        'ON CONFLICT(conversation_id, user_id) '
        'DO UPDATE SET last_read_message_id = excluded.last_read_message_id',
        (conversation_id, viewer_id, new_cursor)
    )
    return new_cursor


# ---- cross-conversation updates (long-poll) ----

def list_updates(cursor, viewer_id, after_id, limit=DEFAULT_UPDATES_LIMIT):
    """New messages across ALL of the viewer's conversations (ascending),
    plus the current conversation list for the viewer.

    Returns (message_dicts, has_more, conversation_dicts). has_more refers
    to the message page (resume with after=<last id seen>).
    """
    limit = max(1, min(int(limit), MAX_UPDATES_LIMIT))

    cursor.execute(
        'SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at '
        'FROM messages m JOIN conversations c ON c.id = m.conversation_id '
        'WHERE (c.user_low_id = %s OR c.user_high_id = %s) AND m.id > %s '
        'ORDER BY m.id ASC LIMIT %s',
        (viewer_id, viewer_id, after_id, limit)
    )
    rows = cursor.fetchall()

    has_more = False
    if len(rows) == limit:
        # Any further message beyond the page means the client should
        # immediately come back for more.
        cursor.execute(
            'SELECT 1 FROM messages m JOIN conversations c '
            'ON c.id = m.conversation_id '
            'WHERE (c.user_low_id = %s OR c.user_high_id = %s) AND m.id > %s '
            'LIMIT 1',
            (viewer_id, viewer_id, rows[-1][0])
        )
        has_more = cursor.fetchone() is not None

    conversations = list_conversations(cursor, viewer_id)
    return [serialize_chat_message(r) for r in rows], has_more, conversations


def latest_message_id(cursor, viewer_id):
    """Highest message id in any of the viewer's conversations (0 if none).
    The resume point a client should use on first connect."""
    cursor.execute(
        'SELECT COALESCE(MAX(m.id), 0) FROM messages m '
        'JOIN conversations c ON c.id = m.conversation_id '
        'WHERE c.user_low_id = %s OR c.user_high_id = %s',
        (viewer_id, viewer_id)
    )
    return cursor.fetchone()[0]
