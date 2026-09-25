"""Posts and comments HTTP layer.

Validation and business logic live in app/post_service.py; this file
only translates between HTTP (request/multipart parsing, status codes)
and that service. (DELETE /api/posts/<id> is the one post-domain route
that lives in app/routes/users.py instead - see that file's docstring.)
"""
from flask import Blueprint, request, jsonify, session
from app.db import get_db
from app import post_service as posts

bp = Blueprint('posts', __name__)


def _require_login():
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    return None


@bp.route('/api/posts', methods=['POST'])
def create_post():
    """Create a post for the logged-in session user"""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    is_multipart = request.content_type and 'multipart/form-data' in request.content_type
    if is_multipart:
        content = request.form.get('content')
        audience = request.form.get('audience', posts.DEFAULT_AUDIENCE)
        files = request.files.getlist('images')
    else:
        data = request.get_json() or {}
        content = data.get('content')
        audience = data.get('audience', posts.DEFAULT_AUDIENCE)
        files = []

    try:
        conn = get_db()
        post = posts.create_post(conn, session['user_id'], content, audience, files)
        conn.close()
        return jsonify(post), 201
    except posts.PostValidationError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


def _clamp_limit(limit_param, default, max_limit):
    try:
        limit = int(limit_param) if limit_param is not None else default
    except (TypeError, ValueError):
        limit = default
    return max(1, min(limit, max_limit))


def _parse_cursor(cursor_param):
    if cursor_param is None:
        return None
    try:
        return int(cursor_param)
    except (TypeError, ValueError):
        return None


@bp.route('/api/posts', methods=['GET'])
def get_posts():
    """Return a keyset-paginated page of posts, newest first, with joined
    author info.

    Query params (all optional):
      - limit: page size, default 20, clamped silently to [1, 50] (display
        parameter, not a security boundary — invalid/non-integer values fall
        back to the default rather than erroring).
      - cursor: post id; returns posts with id < cursor. Non-integer values
        are ignored (treated as "no cursor", i.e. first page).
      - audience: existing filter, unchanged — 400 on an invalid value.
      - user_id: filter to a single author's posts. Non-integer values
        return 400, same treatment as the audience filter.

    Response shape: {"posts": [...], "next_cursor": <id-or-null>}.
    """
    audience_filter = request.args.get('audience', '').strip()

    user_id_param = request.args.get('user_id', '').strip()
    user_id_filter = None
    if user_id_param:
        try:
            user_id_filter = int(user_id_param)
        except ValueError:
            return jsonify({'error': 'Invalid user_id filter'}), 400

    limit = _clamp_limit(request.args.get('limit'), posts.DEFAULT_POSTS_LIMIT, posts.MAX_POSTS_LIMIT)
    cursor_id = _parse_cursor(request.args.get('cursor'))

    try:
        conn = get_db()
        page, next_cursor = posts.list_posts(
            conn, session.get('user_id'), audience_filter, user_id_filter, limit, cursor_id
        )
        conn.close()
        return jsonify({'posts': page, 'next_cursor': next_cursor}), 200
    except posts.PostValidationError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/posts/<int:post_id>/comments', methods=['GET'])
def get_comments(post_id):
    """Get all comments for a specific post"""
    try:
        conn = get_db()
        comments = posts.get_comments(conn, post_id, session.get('user_id'))
        conn.close()
        return jsonify(comments), 200
    except posts.PostNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/posts/<int:post_id>/comments', methods=['POST'])
def create_comment(post_id):
    """Create a comment on a specific post"""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    data = request.get_json() or {}

    try:
        conn = get_db()
        comment = posts.create_comment(
            conn, post_id, session['user_id'],
            data.get('content'), data.get('parent_comment_id')
        )
        conn.close()
        return jsonify(comment), 201
    except posts.PostValidationError as e:
        return jsonify({'error': str(e)}), 400
    except (posts.PostNotFoundError, posts.CommentNotFoundError) as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/posts/<int:post_id>/like', methods=['POST'])
def like_post(post_id):
    """Toggle like on a post"""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        liked, like_count = posts.toggle_post_like(conn, session['user_id'], post_id)
        conn.close()
        return jsonify({'liked': liked, 'like_count': like_count}), 200
    except posts.PostNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/comments/<int:comment_id>/like', methods=['POST'])
def like_comment(comment_id):
    """Toggle like on a comment"""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        liked, like_count = posts.toggle_comment_like(conn, session['user_id'], comment_id)
        conn.close()
        return jsonify({'liked': liked, 'like_count': like_count}), 200
    except posts.CommentNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/comments/<int:comment_id>', methods=['DELETE'])
def delete_comment(comment_id):
    """Delete a comment (ownership check enforced)"""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        posts.delete_comment(conn, session['user_id'], comment_id)
        conn.close()
        return jsonify({}), 200
    except posts.CommentNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except posts.CommentOwnershipError as e:
        return jsonify({'error': str(e)}), 403
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500
