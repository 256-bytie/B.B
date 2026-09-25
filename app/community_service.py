"""Community domain logic (b/<slug> communities, membership, posts).

Flask-free, same shape as app/wallet.py / app/post_service.py: a plain
sqlite3 connection in, plain values out. app/routes/communities.py is the
thin HTTP layer on top.

Access control note: `type` (public/restricted/private) is stored and
returned but NOT enforced yet - every community currently behaves like a
public one for reading and joining. Gating is a later pass.
"""
import re
import sqlite3

from app.post_service import MAX_CONTENT_LEN
from app.serializers import serialize_community, serialize_community_post

VALID_TYPES = ('public', 'restricted', 'private')
MAX_NAME_LEN = 21          # matches maxlength on community_create.html
MAX_DESCRIPTION_LEN = 500  # ditto
MAX_TOPIC_LEN = 30         # custom-topic input maxlength
DEFAULT_TOPIC = 'discussion'
MAX_SLUG_LEN = 21

# Slugs that would shadow a static route under /api/communities/<slug>.
RESERVED_SLUGS = {'mine'}

DEFAULT_POSTS_LIMIT = 20
MAX_POSTS_LIMIT = 50

# topic key -> (icon_emoji, icon_bg). Keys match COMMUNITY_TOPICS in
# static/js/community.js; custom (free-text) topics use the fallback.
TOPIC_STYLES = {
    'education': ('🎓', 'bg-blue-50'),
    'student-life': ('🏛️', 'bg-red-100'),
    'technology': ('💻', 'bg-indigo-50'),
    'gaming': ('🎮', 'bg-purple-50'),
    'art-creativity': ('🎨', 'bg-orange-50'),
    'fitness-health': ('💪', 'bg-green-50'),
    'career-jobs': ('💼', 'bg-amber-50'),
    'discussion': ('💬', 'bg-teal-50'),
}
FALLBACK_STYLE = ('👥', 'bg-gray-100')


class CommunityNotFoundError(Exception):
    """A 404: no community with that slug."""


class CommunityValidationError(Exception):
    """A 400: bad input. str(err) is the user-facing message."""


class CommunityPermissionError(Exception):
    """A 403: e.g. posting without being a member."""


def topic_style(topic):
    return TOPIC_STYLES.get(topic, FALLBACK_STYLE)


def _slug_base(name):
    base = re.sub(r'[^a-z0-9]+', '', name.lower())[:MAX_SLUG_LEN]
    return base or 'community'


def _unique_slug(cursor, name):
    """Lowercase alphanumeric slug derived from name; on collision (or a
    reserved word) append 2, 3, ... - same idea as the username de-dupe
    in init_db()."""
    base = _slug_base(name)
    candidate = base
    n = 1
    while True:
        if candidate not in RESERVED_SLUGS:
            cursor.execute('SELECT 1 FROM communities WHERE slug = ?', (candidate,))
            if cursor.fetchone() is None:
                return candidate
        n += 1
        candidate = f'{base}{n}'


def _fetch_community_row(cursor, slug):
    cursor.execute('''
        SELECT id, slug, name, description, topic, type, icon_emoji, created_at,
               (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id)
        FROM communities c
        WHERE slug = ?
    ''', (slug,))
    return cursor.fetchone()


def _role(cursor, community_id, user_id):
    if user_id is None:
        return None
    cursor.execute(
        'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?',
        (community_id, user_id)
    )
    row = cursor.fetchone()
    return row[0] if row else None


def _require_community(cursor, slug):
    row = _fetch_community_row(cursor, slug)
    if row is None:
        raise CommunityNotFoundError('Community not found')
    return row


def get_community(conn, slug, viewer_id):
    """Serialized community with membership relative to viewer_id (None =
    logged out). Raises CommunityNotFoundError."""
    cursor = conn.cursor()
    row = _require_community(cursor, slug)
    icon_bg = topic_style(row[4])[1]
    return serialize_community(row, icon_bg, _role(cursor, row[0], viewer_id))


def create_community(conn, creator_id, name, description, topic, community_type):
    name = (name or '').strip() if isinstance(name, str) else ''
    description = (description or '').strip() if isinstance(description, str) else ''
    topic = (topic or '').strip() if isinstance(topic, str) else ''
    community_type = community_type.strip().lower() if isinstance(community_type, str) else ''

    if not name:
        raise CommunityValidationError('Name cannot be empty')
    if len(name) > MAX_NAME_LEN:
        raise CommunityValidationError(f'Name exceeds {MAX_NAME_LEN} character limit.')
    if not description:
        raise CommunityValidationError('Description cannot be empty')
    if len(description) > MAX_DESCRIPTION_LEN:
        raise CommunityValidationError(f'Description exceeds {MAX_DESCRIPTION_LEN} character limit.')
    if community_type not in VALID_TYPES:
        raise CommunityValidationError('Type must be one of: public, restricted, private')
    # Lenient like post audience: a missing topic falls back rather than 400s.
    topic = (topic or DEFAULT_TOPIC)[:MAX_TOPIC_LEN]
    icon_emoji = topic_style(topic)[0]

    cursor = conn.cursor()
    # The slug check-then-insert can race with a concurrent create of the
    # same name; the UNIQUE constraint catches it and we pick again.
    for _ in range(5):
        slug = _unique_slug(cursor, name)
        try:
            cursor.execute('''
                INSERT INTO communities (slug, name, description, topic, type, icon_emoji, creator_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (slug, name, description, topic, community_type, icon_emoji, creator_id))
            break
        except sqlite3.IntegrityError:
            conn.rollback()
    else:
        raise CommunityValidationError('Could not allocate a name for this community. Try again.')

    cursor.execute(
        "INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'creator')",
        (cursor.lastrowid, creator_id)
    )
    conn.commit()
    return get_community(conn, slug, creator_id)


def join_community(conn, slug, user_id):
    """Idempotent: joining twice is a no-op."""
    cursor = conn.cursor()
    row = _require_community(cursor, slug)
    cursor.execute(
        "INSERT OR IGNORE INTO community_members (community_id, user_id, role) VALUES (?, ?, 'member')",
        (row[0], user_id)
    )
    conn.commit()
    return get_community(conn, slug, user_id)


def leave_community(conn, slug, user_id):
    """Creators can't leave (needs an ownership-transfer flow). Leaving a
    community you're not in is a no-op."""
    cursor = conn.cursor()
    row = _require_community(cursor, slug)
    if _role(cursor, row[0], user_id) == 'creator':
        raise CommunityValidationError("The creator can't leave their own community")
    cursor.execute(
        'DELETE FROM community_members WHERE community_id = ? AND user_id = ?',
        (row[0], user_id)
    )
    conn.commit()
    return get_community(conn, slug, user_id)


def list_my_communities(conn, user_id):
    """Every community user_id belongs to (any role), newest join first."""
    cursor = conn.cursor()
    cursor.execute('''
        SELECT c.id, c.slug, c.name, c.description, c.topic, c.type, c.icon_emoji, c.created_at,
               (SELECT COUNT(*) FROM community_members m2 WHERE m2.community_id = c.id),
               m.role
        FROM community_members m
        JOIN communities c ON c.id = m.community_id
        WHERE m.user_id = ?
        ORDER BY m.joined_at DESC, m.rowid DESC
    ''', (user_id,))
    return [
        serialize_community(row[:9], topic_style(row[4])[1], row[9])
        for row in cursor.fetchall()
    ]


_POST_SELECT = '''
    SELECT posts.id, posts.content, posts.created_at,
           users.username, users.email, users.profile_picture
    FROM posts
    JOIN users ON posts.user_id = users.id
'''


def list_community_posts(conn, slug, limit, cursor_id):
    """Keyset-paginated, newest first - same convention as GET /api/posts.
    Returns (posts, next_cursor)."""
    cursor = conn.cursor()
    row = _require_community(cursor, slug)

    query = _POST_SELECT + ' WHERE posts.community_id = ?'
    params = [row[0]]
    if cursor_id is not None:
        query += ' AND posts.id < ?'
        params.append(cursor_id)
    query += ' ORDER BY posts.id DESC LIMIT ?'
    params.append(limit + 1)

    cursor.execute(query, params)
    rows = cursor.fetchall()
    has_next = len(rows) > limit
    page = rows[:limit]
    next_cursor = page[-1][0] if has_next and page else None
    return [serialize_community_post(r) for r in page], next_cursor


def create_community_post(conn, slug, user_id, content):
    cursor = conn.cursor()
    row = _require_community(cursor, slug)
    if _role(cursor, row[0], user_id) is None:
        raise CommunityPermissionError('Join this community to post')

    # Same validation as the main compose endpoint (post_service.create_post).
    content = (content or '').strip() if isinstance(content, str) else ''
    if not content:
        raise CommunityValidationError('Content cannot be empty')
    if len(content) > MAX_CONTENT_LEN:
        raise CommunityValidationError(f'Post exceeds {MAX_CONTENT_LEN} character limit.')

    # audience is irrelevant for community posts; the column default fills it.
    cursor.execute(
        'INSERT INTO posts (user_id, content, community_id) VALUES (?, ?, ?)',
        (user_id, content, row[0])
    )
    post_id = cursor.lastrowid
    conn.commit()

    cursor.execute(_POST_SELECT + ' WHERE posts.id = ?', (post_id,))
    return serialize_community_post(cursor.fetchone())
