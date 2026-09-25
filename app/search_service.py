"""Global search domain logic: people/posts/topics search, typeahead
suggestions, trending topics, and per-user search history.

Deliberately independent of Flask (plain sqlite3 connection/cursor in,
plain values out), matching app/wallet.py and app/library_service.py's
shape. See app/routes/search.py for the HTTP layer and request-param
parsing.

Search patterns followed here (LIKE-based multi-entity search with a
combined "all" view, prefix-weighted ranking, debounced typeahead
suggestions, server-persisted recent-search history with de-dup + trim,
and hashtag extraction/aggregation for a lightweight "topics" facet)
mirror how Twitter/X, Instagram, and GitHub structure their search UIs -
adapted to Beebo's existing SQLite schema, which has no FTS5 virtual
table or dedicated hashtags table. LIKE '%term%' is fine at this app's
scale (a single campus community); if the posts table ever grows large
enough for this to matter, _search_posts is the one place to swap in
FTS5.
"""
import re
from app.serializers import serialize_post, serialize_user_public

VALID_TYPES = {'all', 'people', 'posts', 'topics'}
DEFAULT_LIMIT = 20
MAX_LIMIT = 50
# Per-section caps when type=all - a preview of each facet rather than
# a full page of any one, matching the reference's mixed results list.
ALL_PEOPLE_CAP = 3
ALL_TOPICS_CAP = 4
ALL_POSTS_CAP = 5

MAX_HISTORY_PER_USER = 15
MAX_QUERY_LEN = 100

HASHTAG_RE = re.compile(r'#(\w+)')


class SearchValidationError(Exception):
    """A 400: bad input. str(err) is the user-facing message."""


def clean_query(q):
    """Strip and cap query length. Never raises - callers decide whether
    an empty result is an error (main search) or just an empty list
    (suggestions)."""
    q = (q or '').strip()
    if len(q) > MAX_QUERY_LEN:
        q = q[:MAX_QUERY_LEN]
    return q


def require_query(q):
    """Same as clean_query, but raises if nothing's left - for the
    endpoints where an empty query is a 400, not a valid empty state."""
    q = clean_query(q)
    if not q:
        raise SearchValidationError('Search query is required')
    return q


def validate_type(search_type):
    search_type = (search_type or 'all').strip().lower()
    if search_type not in VALID_TYPES:
        raise SearchValidationError('Invalid search type')
    return search_type


def clamp_limit(limit_param, default=DEFAULT_LIMIT, max_limit=MAX_LIMIT):
    try:
        limit = int(limit_param) if limit_param is not None else default
    except (TypeError, ValueError):
        limit = default
    return max(1, min(limit, max_limit))


def parse_cursor(cursor_param):
    if cursor_param is None:
        return None
    try:
        return int(cursor_param)
    except (TypeError, ValueError):
        return None


def _search_people(cursor, q, current_user_id, limit):
    """LIKE-based search over username/full_name/bio, ranked so exact and
    prefix matches on the handle surface before looser bio/name
    substring hits - the same relevance ordering established search
    boxes (GitHub's user search, Slack's people picker) use for a
    single free-text field with no real scoring engine behind it.
    Excludes the searching user themselves; finding your own account
    via global search isn't a useful result (you already have direct
    nav to your own profile).
    """
    like = f'%{q}%'
    prefix = f'{q}%'
    cursor.execute('''
        SELECT id, full_name, email, profile_picture, cover_image, username, bio
        FROM users
        WHERE id != ?
          AND (username LIKE ? OR full_name LIKE ? OR bio LIKE ?)
        ORDER BY
            CASE
                WHEN LOWER(username) = LOWER(?) THEN 0
                WHEN LOWER(username) LIKE LOWER(?) THEN 1
                WHEN LOWER(full_name) LIKE LOWER(?) THEN 2
                ELSE 3
            END,
            full_name COLLATE NOCASE
        LIMIT ?
    ''', (current_user_id, like, like, like, q, prefix, prefix, limit))
    return [serialize_user_public(row) for row in cursor.fetchall()]


def _search_posts(cursor, q, current_user_id, limit, cursor_id):
    """Same shape/pagination convention as GET /api/posts (keyset on id,
    author join, per-user liked_by_user flag) so results can be rendered
    with the existing buildPostCardHtml()/serialize_post() and get real
    like/comment/menu behavior for free instead of a read-only preview.
    """
    like = f'%{q}%'
    query = '''
        SELECT posts.id, posts.user_id, posts.content, posts.audience,
               posts.created_at, posts.comment_count, posts.like_count,
               posts.view_count, users.full_name, users.email, users.profile_picture,
               users.username, users.bio,
               CASE WHEN likes.id IS NOT NULL THEN 1 ELSE 0 END as liked_by_user
        FROM posts
        JOIN users ON posts.user_id = users.id
        LEFT JOIN likes ON likes.target_type = 'post'
                       AND likes.target_id = posts.id
                       AND likes.user_id = ?
        WHERE posts.content LIKE ?
    '''
    params = [current_user_id, like]
    if cursor_id is not None:
        query += ' AND posts.id < ?'
        params.append(cursor_id)
    query += ' ORDER BY posts.created_at DESC, posts.id DESC LIMIT ?'
    params.append(limit + 1)

    cursor.execute(query, params)
    rows = cursor.fetchall()
    has_next = len(rows) > limit
    page_rows = rows[:limit]
    next_cursor = page_rows[-1][0] if has_next and page_rows else None

    if page_rows:
        post_ids = [row[0] for row in page_rows]
        placeholders = ','.join('?' * len(post_ids))
        cursor.execute(f'''
            SELECT post_id, image_path FROM post_images
            WHERE post_id IN ({placeholders})
            ORDER BY post_id, position ASC
        ''', post_ids)
        images_by_post = {}
        for post_id, image_path in cursor.fetchall():
            images_by_post.setdefault(post_id, []).append(image_path)
    else:
        images_by_post = {}

    posts = []
    for row in page_rows:
        image_list = [(img,) for img in images_by_post.get(row[0], [])]
        posts.append(serialize_post(row, image_list, row[13]))
    return posts, next_cursor


def _hashtag_counts(cursor):
    """Extract '#tag' occurrences from every post's content and return a
    {lowercase_tag: count} dict. No hashtags table exists, so this scans
    posts.content directly - filtered to rows that contain '#' first so
    the regex only runs over candidate rows, not the whole table.
    """
    cursor.execute("SELECT content FROM posts WHERE content LIKE '%#%'")
    counts = {}
    for (content,) in cursor.fetchall():
        for tag in HASHTAG_RE.findall(content):
            key = tag.lower()
            counts[key] = counts.get(key, 0) + 1
    return counts


def _search_topics(cursor, q, limit):
    counts = _hashtag_counts(cursor)
    q_lower = q.lower().lstrip('#')
    matches = [(tag, count) for tag, count in counts.items() if q_lower in tag]
    matches.sort(key=lambda item: (-item[1], item[0]))
    return [{'tag': tag, 'post_count': count} for tag, count in matches[:limit]]


def run_search(conn, q, search_type, current_user_id, limit, cursor_id):
    """Dispatch to the right facet(s) for search_type ('all' runs all
    three with fixed small caps). Returns the response dict minus the
    'query' key (the route adds that, since it already has q on hand)."""
    cursor = conn.cursor()
    result = {}

    if search_type == 'all':
        result['people'] = _search_people(cursor, q, current_user_id, ALL_PEOPLE_CAP)
        result['topics'] = _search_topics(cursor, q, ALL_TOPICS_CAP)
        posts, next_cursor = _search_posts(cursor, q, current_user_id, ALL_POSTS_CAP, None)
        result['posts'] = posts
        result['next_cursor'] = next_cursor
    elif search_type == 'people':
        result['people'] = _search_people(cursor, q, current_user_id, limit)
    elif search_type == 'topics':
        result['topics'] = _search_topics(cursor, q, limit)
    elif search_type == 'posts':
        posts, next_cursor = _search_posts(cursor, q, current_user_id, limit, cursor_id)
        result['posts'] = posts
        result['next_cursor'] = next_cursor

    return result


def get_trending(conn, limit):
    """Top hashtags by usage across all posts. Empty list (not an error)
    when nobody's used a hashtag yet - a normal state for a new app."""
    cursor = conn.cursor()
    counts = _hashtag_counts(cursor)
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]
    return [{'tag': tag, 'post_count': count} for tag, count in ranked]


def get_suggestions(conn, q, current_user_id):
    """Typeahead completions while the person is still typing (not yet
    submitted a search). Combines matching hashtags and matching people,
    de-duped case-insensitively, capped at 8 - the same 'a handful of
    specific completions, not full results' pattern as Google/YouTube's
    search box autocomplete."""
    cursor = conn.cursor()

    topic_matches = _search_topics(cursor, q, 5)
    items = [{'text': f"#{t['tag']}", 'type': 'topic'} for t in topic_matches]

    like = f'%{q}%'
    prefix = f'{q}%'
    cursor.execute('''
        SELECT full_name, username, email
        FROM users
        WHERE id != ? AND (username LIKE ? OR full_name LIKE ?)
        ORDER BY
            CASE WHEN LOWER(username) LIKE LOWER(?) THEN 0 ELSE 1 END,
            full_name COLLATE NOCASE
        LIMIT 5
    ''', (current_user_id, like, like, prefix))
    for full_name, username, email in cursor.fetchall():
        handle = username or email.split('@')[0]
        items.append({'text': handle, 'type': 'person', 'label': full_name})

    seen = set()
    deduped = []
    for item in items:
        key = item['text'].lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
        if len(deduped) >= 8:
            break

    return deduped


def get_history(conn, user_id):
    """Most recent searches for a user, newest first."""
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, query, created_at FROM search_history
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    ''', (user_id, MAX_HISTORY_PER_USER))
    return [{'id': r[0], 'query': r[1], 'created_at': r[2]} for r in cursor.fetchall()]


def add_history(conn, user_id, query):
    """Record a submitted search term. De-dupes case-insensitively (a
    repeat search moves to the top rather than appearing twice) and
    trims the account down to the most recent MAX_HISTORY_PER_USER
    entries - same 'recent, deduped, capped' convention Twitter/Google
    use for search history. Raises SearchValidationError if query is
    empty after stripping."""
    query = clean_query(query)
    if not query:
        raise SearchValidationError('Query is required')

    cursor = conn.cursor()
    cursor.execute(
        'DELETE FROM search_history WHERE user_id = ? AND LOWER(query) = LOWER(?)',
        (user_id, query)
    )
    cursor.execute(
        'INSERT INTO search_history (user_id, query) VALUES (?, ?)',
        (user_id, query)
    )
    cursor.execute('''
        DELETE FROM search_history
        WHERE user_id = ? AND id NOT IN (
            SELECT id FROM search_history
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        )
    ''', (user_id, user_id, MAX_HISTORY_PER_USER))
    conn.commit()


def clear_history(conn, user_id):
    """Delete every search-history row for a user."""
    conn.execute('DELETE FROM search_history WHERE user_id = ?', (user_id,))
    conn.commit()


def delete_history_item(conn, user_id, history_id):
    """Delete one search-history row, scoped to its owner. Returns True
    if a row was actually deleted (False means it didn't exist or
    belonged to someone else - the route maps that to 404)."""
    cursor = conn.cursor()
    cursor.execute(
        'DELETE FROM search_history WHERE id = ? AND user_id = ?',
        (history_id, user_id)
    )
    deleted = cursor.rowcount > 0
    conn.commit()
    return deleted
