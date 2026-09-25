"""User profile, follow, and highlight routes (plus /api/posts/<id>
DELETE - see app/post_service.py for why that lives in this file).

Validation and business logic live in app/user_service.py and
app/post_service.py; this file only translates between HTTP and those
services.
"""
from flask import Blueprint, request, jsonify, session
from app.db import get_db
from app import user_service as users
from app import post_service as posts

bp = Blueprint('users', __name__)


def _require_login():
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    return None


@bp.route('/api/users/<int:user_id>', methods=['GET'])
def get_user_public_profile(user_id):
    """Return the public profile fields for any user (avatar, cover, name,
    handle, post count) - used by the other-user profile screen. Unlike
    /api/session, this is not scoped to the logged-in user: it looks the
    requested user_id up directly so the viewer always gets that user's own
    data, not whatever happens to be in their own session."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    conn = get_db()
    try:
        profile = users.get_public_profile(conn, user_id, session['user_id'])
        return jsonify(profile), 200
    except users.UserNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    finally:
        conn.close()


@bp.route('/api/users/<int:user_id>/follow', methods=['POST'])
def toggle_follow(user_id):
    """Toggle the logged-in user following user_id. Persists to the
    `follows` table (mirrors the like_post toggle pattern) so the
    relationship and the follower count survive a page refresh."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        following, follower_count = users.toggle_follow(conn, session['user_id'], user_id)
        conn.close()
        return jsonify({'following': following, 'follower_count': follower_count}), 200
    except users.UserValidationError as e:
        return jsonify({'error': str(e)}), 400
    except users.UserNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except users.FollowRateLimitError as e:
        return jsonify({'error': str(e)}), 429
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/users/<int:user_id>/highlights', methods=['GET'])
def get_user_highlights(user_id):
    """Get all highlights for a specific user, ordered by creation time"""
    try:
        conn = get_db()
        highlights = users.get_highlights(conn, user_id)
        conn.close()
        return jsonify(highlights), 200
    except users.UserNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/profile/picture', methods=['POST'])
def update_profile_picture():
    """Upload/replace the logged-in user's profile picture.

    Multipart form field: 'image' (single file). Overwrites the previous
    profile_picture value; the old uploaded file (if any) is best-effort
    deleted from disk. Passing profile_picture as NULL/omitted elsewhere
    always falls back to the generated DiceBear avatar on the frontend.
    """
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        image_url = users.update_profile_picture(conn, session['user_id'], request.files.get('image'))
        conn.close()
        return jsonify({'success': True, 'profile_picture': image_url}), 200
    except users.UserValidationError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/profile/cover', methods=['POST'])
def update_profile_cover():
    """Upload/replace the logged-in user's cover image.

    Multipart form field: 'image' (single file). Same validation as
    profile picture. NULL/omitted cover_image means "no custom cover" —
    the frontend keeps showing its default gradient banner.
    """
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        image_url = users.update_profile_cover(conn, session['user_id'], request.files.get('image'))
        conn.close()
        return jsonify({'success': True, 'cover_image': image_url}), 200
    except users.UserValidationError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/profile', methods=['PATCH'])
def update_profile():
    """Update the logged-in user's profile (full_name, username, bio).

    Accepts JSON body with:
    - full_name: required, non-empty after trim, max 50 chars
    - username: required, non-empty after trim, max 30, alphanumeric/underscore/period only
    - bio: optional, max 150 chars
    """
    auth_error = _require_login()
    if auth_error:
        return auth_error

    data = request.get_json() or {}

    try:
        conn = get_db()
        result = users.update_profile(
            conn, session['user_id'],
            data.get('full_name'), data.get('username'), data.get('bio')
        )
        conn.close()
        return jsonify({'success': True, **result}), 200
    except users.UserValidationError as e:
        return jsonify({'error': str(e)}), 400
    except users.UsernameTakenError as e:
        return jsonify({'error': str(e)}), 409
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/highlights', methods=['POST'])
def create_highlight():
    """Create a new highlight with photo or video upload.

    Multipart form-data with fields:
    - media (file): photo or video file
    - title (string): max 20 characters
    """
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        highlight = users.create_highlight(
            conn, session['user_id'],
            request.files.get('media'), request.form.get('title', '')
        )
        conn.close()
        return jsonify(highlight), 201
    except users.UserValidationError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Server error: {str(e)}'}), 500


@bp.route('/api/highlights/<int:highlight_id>', methods=['DELETE'])
def delete_highlight(highlight_id):
    """Delete a highlight. Must belong to the requesting user."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        users.delete_highlight(conn, session['user_id'], highlight_id)
        conn.close()
        return jsonify({'success': True}), 200
    except users.UserNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except users.HighlightOwnershipError as e:
        return jsonify({'error': str(e)}), 403
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/posts/<int:post_id>', methods=['DELETE'])
def delete_post(post_id):
    """Delete a post and all associated data"""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        posts.delete_post(conn, session['user_id'], post_id)
        conn.close()
        return jsonify({'success': True}), 200
    except posts.PostNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except posts.PostOwnershipError as e:
        return jsonify({'error': str(e)}), 403
    except Exception as e:
        if 'conn' in locals():
            conn.rollback()
            conn.close()
        return jsonify({'error': f'Database error: {str(e)}'}), 500
