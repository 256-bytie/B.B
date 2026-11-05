"""Notification list and read-state routes."""
from flask import Blueprint, jsonify, request, session

from app.db import get_db
from app import notification_service


bp = Blueprint('notifications', __name__)


def _json(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


@bp.route('/api/notifications', methods=['GET'])
def get_notifications():
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    try:
        limit = int(request.args.get('limit', notification_service.DEFAULT_LIMIT))
    except (TypeError, ValueError):
        limit = notification_service.DEFAULT_LIMIT

    cursor_arg = request.args.get('cursor')
    cursor_id = None
    if cursor_arg not in (None, ''):
        try:
            cursor_id = int(cursor_arg)
        except (TypeError, ValueError):
            return _json({'error': 'Invalid cursor'}, 400)

    conn = get_db()
    try:
        items, next_cursor, unread_count = notification_service.list_notifications(
            conn, session['user_id'], limit, cursor_id
        )
        return _json({
            'notifications': items,
            'next_cursor': next_cursor,
            'unread_count': unread_count,
        })
    finally:
        conn.close()


@bp.route('/api/notifications/read', methods=['POST'])
def read_notifications():
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _json({'error': 'Invalid request body'}, 400)

    all_ = data.get('all') is True
    ids = data.get('ids')
    valid_ids = (
        isinstance(ids, list)
        and 1 <= len(ids) <= 100
        and all(isinstance(value, int) and not isinstance(value, bool) for value in ids)
    )
    if (all_ and set(data) == {'all'}) or (valid_ids and set(data) == {'ids'}):
        conn = get_db()
        try:
            count = notification_service.mark_read(
                conn, session['user_id'], ids=ids if valid_ids else None, all_=all_
            )
            return _json({'unread_count': count})
        finally:
            conn.close()

    return _json({'error': 'Provide ids or all'}, 400)
