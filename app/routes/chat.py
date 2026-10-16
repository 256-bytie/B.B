"""Chat routes: direct (1:1) conversations and messages.

Thin HTTP layer over app/chat_service.py (same split as wallet /
communities). All endpoints require login; mutating ones additionally go
through the global CSRF middleware in app/__init__.py.

Rate limiting: message sending is limited per user in-process (mirrors the
login limiter in app/routes/auth.py) — 20 messages per 10 seconds, excess
gets 429. In-memory, therefore single-process only.
"""
import time

from flask import Blueprint, request, jsonify, session

from app.db import get_db
from app import chat_service as chat
from psycopg_pool import PoolTimeout


bp = Blueprint('chat', __name__)

# Message send rate limit: max N sends per user per window seconds.
SEND_RATE_LIMIT_MAX = 20
SEND_RATE_LIMIT_WINDOW = 10  # seconds
send_rate_limiter = {}  # {user_id: [timestamp, ...]}


def _require_login():
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    return None


def _rate_limited(user_id):
    """True when this user has hit SEND_RATE_LIMIT_MAX sends within
    SEND_RATE_LIMIT_WINDOW seconds. Expired timestamps are pruned here."""
    now = time.time()
    stamps = send_rate_limiter.get(user_id, [])
    stamps = [ts for ts in stamps if now - ts < SEND_RATE_LIMIT_WINDOW]
    if len(stamps) >= SEND_RATE_LIMIT_MAX:
        send_rate_limiter[user_id] = stamps
        return True
    stamps.append(now)
    send_rate_limiter[user_id] = stamps
    return False


@bp.route('/api/chat/conversations', methods=['GET'])
def get_conversations():
    auth_error = _require_login()
    if auth_error:
        return auth_error

    conn = get_db()
    try:
        cursor = conn.cursor()
        conversations = chat.list_conversations(cursor, session['user_id'])
        return jsonify({'conversations': conversations})
    finally:
        conn.close()


@bp.route('/api/chat/conversations', methods=['POST'])
def create_conversation():
    """Get-or-create the DM between the session user and JSON body {"user_id": ...}. 201 when
    created, 200 when it already existed."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    data = request.get_json() or {}
    other_user_id = data.get('user_id')

    conn = get_db()
    try:
        try:
            cursor = conn.cursor()
            conversation_id, created = chat.get_or_create_conversation(
                cursor, session['user_id'], other_user_id
            )
            conv_row = chat._fetch_conversation_row(cursor, conversation_id)
            item = chat._serialize_conversation_pair(
                cursor, conv_row, session['user_id']
            )
            conn.commit()
        except chat.ChatValidationError as e:
            conn.rollback()
            return jsonify({'error': str(e)}), 400
        except chat.UserNotFoundError as e:
            conn.rollback()
            return jsonify({'error': str(e)}), 404
        except PoolTimeout:
            raise
        except Exception:
            conn.rollback()
            raise
        return jsonify(item), (201 if created else 200)
    finally:
        conn.close()


@bp.route('/api/chat/conversations/<int:conversation_id>/messages', methods=['GET'])
def get_messages(conversation_id):
    """Ascending page of one conversation's messages; newest page by
    default; the optional `before` query parameter pages further back and
    `limit` (default 50, max 100) controls page size."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    before_id = None
    before_arg = request.args.get('before')
    if before_arg not in (None, ''):
        try:
            before_id = int(before_arg)
        except (TypeError, ValueError):
            return jsonify({'error': 'Invalid before value'}), 400

    try:
        limit = int(request.args.get('limit', chat.DEFAULT_MESSAGES_LIMIT))
    except (TypeError, ValueError):
        limit = chat.DEFAULT_MESSAGES_LIMIT

    conn = get_db()
    try:
        cursor = conn.cursor()
        messages, has_more = chat.get_messages(
            cursor, conversation_id, session['user_id'],
            before_id=before_id, limit=limit
        )
        return jsonify({'messages': messages, 'has_more': has_more})
    except chat.ConversationNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    finally:
        conn.close()


@bp.route('/api/chat/conversations/<int:conversation_id>/messages', methods=['POST'])
def send_message(conversation_id):
    """Send a message: {"body": str, "client_id": str or omitted}. Same
    client_id from the same sender in the same conversation returns the
    existing message with 200 instead of inserting again."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    user_id = session['user_id']
    if _rate_limited(user_id):
        return jsonify({'error': 'Too many messages, slow down'}), 429

    data = request.get_json() or {}
    body = data.get('body')
    client_id = data.get('client_id')

    conn = get_db()
    try:
        message, created = chat.send_message(
            conn, conversation_id, user_id, body, client_id=client_id
        )
        return jsonify({'message': message}), (201 if created else 200)
    except chat.ChatValidationError as e:
        return jsonify({'error': str(e)}), 400
    except chat.ConversationNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except PoolTimeout:
        raise
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500
    finally:
        conn.close()


@bp.route('/api/chat/conversations/<int:conversation_id>/read', methods=['POST'])
def mark_read(conversation_id):
    """Move the viewer's own unread cursor: {"up_to": message_id} -> 204.
    Forward-only, clamped to the conversation's last message."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    data = request.get_json() or {}
    up_to = data.get('up_to')

    conn = get_db()
    try:
        cursor = conn.cursor()
        chat.mark_read(cursor, conversation_id, session['user_id'], up_to)
        conn.commit()
        return '', 204
    except chat.ChatValidationError as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 400
    except chat.ConversationNotFoundError as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 404
    finally:
        conn.close()


@bp.route('/api/chat/updates', methods=['GET'])
def get_updates():
    """Poll for new messages across all of the viewer's conversations.

    Query parameters:
      after: resume cursor (default 0 = everything)
      limit: message page size (default 100, max 200)
      wait_seconds: long-poll up to this many seconds for something new
                    (default 0, max 25); returns early when signalled
      conv_after: narrow to conversations created after this id (full
                  list by default so previews/unread counts refresh)

    A held request never holds a DB connection or transaction open: the
    wait happens on a condition variable, and each re-check opens its own
    short-lived connection.
    """
    auth_error = _require_login()
    if auth_error:
        return auth_error

    user_id = session['user_id']

    after_arg = request.args.get('after', '0')
    try:
        after_id = int(after_arg)
        if after_id < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid after value'}), 400

    conv_after = None
    conv_after_arg = request.args.get('conv_after')
    if conv_after_arg not in (None, ''):
        try:
            conv_after = int(conv_after_arg)
        except (TypeError, ValueError):
            return jsonify({'error': 'Invalid conv_after value'}), 400

    try:
        limit = int(request.args.get('limit', chat.DEFAULT_UPDATES_LIMIT))
    except (TypeError, ValueError):
        limit = chat.DEFAULT_UPDATES_LIMIT

    try:
        wait_seconds = float(request.args.get('wait_seconds', 0))
        wait_seconds = max(0.0, min(wait_seconds, chat.UPDATES_MAX_WAIT_SECONDS))
    except (TypeError, ValueError):
        wait_seconds = 0.0

    deadline = time.monotonic() + wait_seconds
    while True:
        conn = get_db()
        try:
            cursor = conn.cursor()
            messages, has_more, conversations = chat.list_updates(
                cursor, user_id, after_id, limit=limit
            )
        finally:
            conn.close()

        if messages or has_more or wait_seconds <= 0:
            break

        # Nothing new yet — wait on the condition (no DB held open), then
        # re-check. Also re-check at 1 s intervals as a fallback in case a
        # notify was missed (e.g. cross-thread timing).
        version_now = chat._update_version
        signalled, version_now = chat.wait_for_updates(
            min(deadline, time.monotonic() + chat._UPDATES_DB_RECHECK_SECONDS),
            version_now
        )
        if time.monotonic() >= deadline and not signalled:
            break

    if conv_after is not None:
        conversations = [c for c in conversations if c['id'] > conv_after]

    return jsonify({
        'messages': messages,
        'has_more': has_more,
        'conversations': conversations,
    })
