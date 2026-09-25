"""Global search, typeahead suggestions, trending topics, and per-user
search history - HTTP layer.

Query validation and the actual search/history logic live in
app/search_service.py; this file only parses request args, calls the
service, and maps results/exceptions to JSON responses.
"""
from flask import Blueprint, request, jsonify, session
from app.db import get_db
from app import search_service as srch

bp = Blueprint('search', __name__)


def _require_login():
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    return None


@bp.route('/api/search', methods=['GET'])
def search():
    """Unified search endpoint.

    Query params:
      - q: search text, required, non-empty after stripping.
      - type: 'all' (default), 'people', 'posts', or 'topics'.
      - limit: page size for a single-type search, default 20, clamped
        to [1, 50]. Ignored for type=all, which uses fixed small
        per-section caps so the combined view stays scannable.
      - cursor: post id keyset cursor, only meaningful for type=posts.

    Response: {"query": q, "people": [...]?, "posts": [...]?,
    "topics": [...]?, "next_cursor": id-or-null?} - each section key is
    present only when that type was requested (all three for type=all).
    """
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        q = srch.require_query(request.args.get('q', ''))
        search_type = srch.validate_type(request.args.get('type', 'all'))
    except srch.SearchValidationError as e:
        return jsonify({'error': str(e)}), 400

    limit = srch.clamp_limit(request.args.get('limit'))
    cursor_id = srch.parse_cursor(request.args.get('cursor'))

    try:
        conn = get_db()
        result = srch.run_search(conn, q, search_type, session['user_id'], limit, cursor_id)
        conn.close()
        return jsonify({'query': q, **result}), 200
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/search/trending', methods=['GET'])
def trending_topics():
    """Top hashtags by usage across all posts, for the pre-search
    'Trending topics' chips. Returns an empty list (not an error) when
    the community hasn't used any hashtags yet - that's a normal, valid
    state for a new app, not a failure.
    """
    auth_error = _require_login()
    if auth_error:
        return auth_error

    limit = srch.clamp_limit(request.args.get('limit'), default=6, max_limit=20)

    try:
        conn = get_db()
        topics = srch.get_trending(conn, limit)
        conn.close()
        return jsonify({'topics': topics}), 200
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/search/suggestions', methods=['GET'])
def suggestions():
    """Typeahead completions while the person is still typing (not yet
    submitted a search). Combines matching hashtags and matching
    people, capped to a short list - the same 'a handful of specific
    completions, not full results' pattern as Google/YouTube's search
    box autocomplete.
    """
    auth_error = _require_login()
    if auth_error:
        return auth_error

    q = srch.clean_query(request.args.get('q', ''))
    if not q:
        return jsonify({'suggestions': []}), 200

    try:
        conn = get_db()
        items = srch.get_suggestions(conn, q, session['user_id'])
        conn.close()
        return jsonify({'suggestions': items}), 200
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/search/history', methods=['GET'])
def get_search_history():
    """Most recent searches for the logged-in user, newest first."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        history = srch.get_history(conn, session['user_id'])
        conn.close()
        return jsonify({'history': history}), 200
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/search/history', methods=['POST'])
def add_search_history():
    """Record a submitted search term. De-dupes case-insensitively (a
    repeat search moves to the top rather than appearing twice) and
    trims the account down to the most recent entries - same 'recent,
    deduped, capped' convention Twitter/Google use for search history."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    data = request.get_json() or {}

    try:
        conn = get_db()
        srch.add_history(conn, session['user_id'], data.get('query'))
        conn.close()
        return jsonify({'ok': True}), 201
    except srch.SearchValidationError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/search/history', methods=['DELETE'])
def clear_search_history():
    """Clear all recent searches for the logged-in user."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        srch.clear_history(conn, session['user_id'])
        conn.close()
        return jsonify({'ok': True}), 200
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/search/history/<int:history_id>', methods=['DELETE'])
def delete_search_history_item(history_id):
    """Remove a single recent-search entry (the per-row 'x')."""
    auth_error = _require_login()
    if auth_error:
        return auth_error

    try:
        conn = get_db()
        deleted = srch.delete_history_item(conn, session['user_id'], history_id)
        conn.close()

        if not deleted:
            return jsonify({'error': 'Search history entry not found'}), 404
        return jsonify({'ok': True}), 200
    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500
