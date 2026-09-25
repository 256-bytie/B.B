"""Communities HTTP layer. Logic lives in app/community_service.py.

GET /api/communities/<slug> and its /posts listing are readable while
logged out (like GET /api/posts); everything else requires a session.
Mutating routes go through the global csrf_protect() in app/__init__.py.
"""
from flask import Blueprint, request, jsonify, session
from app.db import get_db
from app import community_service as communities

bp = Blueprint('communities', __name__)


def _require_login():
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    return None


def _clamp_limit(limit_param):
    try:
        limit = int(limit_param) if limit_param is not None else communities.DEFAULT_POSTS_LIMIT
    except (TypeError, ValueError):
        limit = communities.DEFAULT_POSTS_LIMIT
    return max(1, min(limit, communities.MAX_POSTS_LIMIT))


def _parse_cursor(cursor_param):
    try:
        return int(cursor_param) if cursor_param not in (None, '') else None
    except (TypeError, ValueError):
        return None


def _call(fn, *args, success_status=200):
    """Run a service call on a fresh connection and map its exceptions
    onto the app's usual {"error": ...} responses."""
    conn = get_db()
    try:
        return jsonify(fn(conn, *args)), success_status
    except communities.CommunityValidationError as e:
        return jsonify({'error': str(e)}), 400
    except communities.CommunityPermissionError as e:
        return jsonify({'error': str(e)}), 403
    except communities.CommunityNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500
    finally:
        conn.close()


@bp.route('/api/communities', methods=['POST'])
def create_community():
    auth_error = _require_login()
    if auth_error:
        return auth_error
    data = request.get_json(silent=True) or {}
    return _call(
        communities.create_community, session['user_id'],
        data.get('name'), data.get('description'), data.get('topic'), data.get('type'),
        success_status=201
    )


# Registered before /<slug> for readability; Flask already prefers the
# static segment, and 'mine' is a reserved slug in community_service.
@bp.route('/api/communities/mine', methods=['GET'])
def my_communities():
    auth_error = _require_login()
    if auth_error:
        return auth_error
    return _call(lambda conn, uid: {'communities': communities.list_my_communities(conn, uid)},
                 session['user_id'])


@bp.route('/api/communities/<slug>', methods=['GET'])
def get_community(slug):
    return _call(communities.get_community, slug, session.get('user_id'))


@bp.route('/api/communities/<slug>/join', methods=['POST'])
def join_community(slug):
    auth_error = _require_login()
    if auth_error:
        return auth_error
    return _call(communities.join_community, slug, session['user_id'])


@bp.route('/api/communities/<slug>/leave', methods=['POST'])
def leave_community(slug):
    auth_error = _require_login()
    if auth_error:
        return auth_error
    return _call(communities.leave_community, slug, session['user_id'])


@bp.route('/api/communities/<slug>/posts', methods=['GET'])
def list_community_posts(slug):
    limit = _clamp_limit(request.args.get('limit'))
    cursor_id = _parse_cursor(request.args.get('cursor'))

    def page(conn, s):
        posts, next_cursor = communities.list_community_posts(conn, s, limit, cursor_id)
        return {'posts': posts, 'next_cursor': next_cursor}
    return _call(page, slug)


@bp.route('/api/communities/<slug>/posts', methods=['POST'])
def create_community_post(slug):
    auth_error = _require_login()
    if auth_error:
        return auth_error
    data = request.get_json(silent=True) or {}
    return _call(communities.create_community_post, slug, session['user_id'],
                 data.get('content'), success_status=201)
