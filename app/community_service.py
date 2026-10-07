"""Community domain logic (communities, membership, posts).

Flask-free, same shape as app/wallet.py / app/post_service.py: a plain
sqlite3 connection in, plain values out. app/routes/communities.py is the
thin HTTP layer on top.

"""
import re
import sqlite3

from app.serializers import serialize_community, serialize_user_public
from app.community_access import viewer_role, can_view, can_join
from app.upload_utils import delete_if_local

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
               (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id),
               c.icon_image, c.cover_image
        FROM communities c
        WHERE slug = ?
    ''', (slug,))
    return cursor.fetchone()


_role = viewer_role


def _require_community(cursor, slug):
    row = _fetch_community_row(cursor, slug)
    if row is None:
        raise CommunityNotFoundError('Community not found')
    return row

def _require_visible_community(cursor, slug, viewer_id):
    row = _require_community(cursor, slug)
    if not can_view(row[5], viewer_role(cursor, row[0], viewer_id)):
        raise CommunityNotFoundError('Community not found')
    return row


def get_community(conn, slug, viewer_id):
    """Serialized community with membership relative to viewer_id (None =
    logged out). Raises CommunityNotFoundError."""
    cursor = conn.cursor()
    row = _require_visible_community(cursor, slug, viewer_id)
    icon_bg = topic_style(row[4])[1]
    role = _role(cursor, row[0], viewer_id)
    level = None
    if role is not None:
        cursor.execute('SELECT notification_level FROM community_members WHERE community_id = ? AND user_id = ?',
                       (row[0], viewer_id))
        level = cursor.fetchone()[0]
    return serialize_community(row[:9], icon_bg, role, row[9], row[10], level)


def list_community_members(conn, slug, viewer_id):
    """Return the creator, moderators, and a viewer-aware sample of members."""
    cursor = conn.cursor()
    community = _require_visible_community(cursor, slug, viewer_id)
    community_id = community[0]
    user_columns = '''
        SELECT u.id, u.full_name, u.email, u.profile_picture, u.cover_image,
               u.username, u.bio
        FROM community_members m
        JOIN users u ON u.id = m.user_id
    '''

    cursor.execute(user_columns + '''
        WHERE m.community_id = ? AND m.role = 'creator'
        LIMIT 1
    ''', (community_id,))
    admin_row = cursor.fetchone()

    cursor.execute(user_columns + '''
        WHERE m.community_id = ? AND m.role = 'moderator'
        ORDER BY m.joined_at ASC, m.rowid ASC
    ''', (community_id,))
    moderators = [serialize_user_public(row) for row in cursor.fetchall()]

    first_row = None
    if viewer_id is not None:
        cursor.execute(user_columns + '''
            WHERE m.community_id = ? AND m.user_id = ?
            LIMIT 1
        ''', (community_id, viewer_id))
        first_row = cursor.fetchone()

    if first_row is None:
        cursor.execute(user_columns + '''
            WHERE m.community_id = ?
            ORDER BY RANDOM()
            LIMIT 1
        ''', (community_id,))
        first_row = cursor.fetchone()

    all_members = []
    if first_row is not None:
        all_members.append(serialize_user_public(first_row))
        cursor.execute(user_columns + '''
            WHERE m.community_id = ? AND m.user_id != ?
            ORDER BY m.joined_at DESC, m.rowid DESC
            LIMIT 3
        ''', (community_id, first_row[0]))
        all_members.extend(serialize_user_public(row) for row in cursor.fetchall())

    return {
        'admin': serialize_user_public(admin_row) if admin_row else None,
        'moderators': moderators,
        'all': all_members,
    }


def list_all_community_members(conn, slug, viewer_id, q=None, limit=30, offset=0):
    """Full, paginated member list for the Members screen.

    `all` holds every member (admin and moderators included, viewer first, then
    newest joins). `admin` / `moderators` are only returned on the first page
    (offset 0). `q` filters all three by name or username.
    """
    cursor = conn.cursor()
    community = _require_visible_community(cursor, slug, viewer_id)
    community_id = community[0]
    user_columns = '''
        SELECT u.id, u.full_name, u.email, u.profile_picture, u.cover_image,
               u.username, u.bio
        FROM community_members m
        JOIN users u ON u.id = m.user_id
    '''

    search_sql = ''
    search_params = []
    term = (q or '').strip().lower()
    if term:
        escaped = term.replace('!', '!!').replace('%', '!%').replace('_', '!_')
        like = '%' + escaped + '%'
        search_sql = " AND (lower(u.full_name) LIKE ? ESCAPE '!' OR lower(u.username) LIKE ? ESCAPE '!')"
        search_params = [like, like]

    admin = None
    moderators = []
    if offset == 0:
        cursor.execute(user_columns + "WHERE m.community_id = ? AND m.role = 'creator'" + search_sql + ' LIMIT 1',
                       [community_id] + search_params)
        row = cursor.fetchone()
        admin = serialize_user_public(row) if row else None
        cursor.execute(user_columns + "WHERE m.community_id = ? AND m.role = 'moderator'" + search_sql +
                       ' ORDER BY m.joined_at ASC, m.rowid ASC', [community_id] + search_params)
        moderators = [serialize_user_public(r) for r in cursor.fetchall()]

    cursor.execute(
        user_columns + 'WHERE m.community_id = ?' + search_sql +
        ' ORDER BY (m.user_id = ?) DESC, m.joined_at DESC, m.rowid DESC LIMIT ? OFFSET ?',
        [community_id] + search_params + [viewer_id if viewer_id is not None else -1, limit + 1, offset]
    )
    rows = cursor.fetchall()
    has_more = len(rows) > limit
    return {
        'admin': admin,
        'moderators': moderators,
        'all': [serialize_user_public(r) for r in rows[:limit]],
        'has_more': has_more,
    }


def update_community_image(conn, slug, user_id, kind, file_storage):
    """Validate, save, and replace a community icon or cover image."""
    from app import user_service

    column = {'icon': 'icon_image', 'cover': 'cover_image'}[kind]
    cursor = conn.cursor()
    row = _require_visible_community(cursor, slug, user_id)
    if viewer_role(cursor, row[0], user_id) not in ('creator', 'moderator'):
        raise CommunityPermissionError('Only the creator or a moderator can change community images')
    try:
        user_service._validate_image_file(file_storage)
    except user_service.UserValidationError as e:
        raise CommunityValidationError(str(e))
    old_url = row[9 if kind == 'icon' else 10]
    new_url = user_service._save_upload(file_storage)
    try:
        cursor.execute(f'UPDATE communities SET {column} = ? WHERE id = ?', (new_url, row[0]))
        conn.commit()
    except Exception:
        delete_if_local(new_url, user_service.UPLOAD_FOLDER)
        raise
    delete_if_local(old_url, user_service.UPLOAD_FOLDER)
    return get_community(conn, slug, user_id)


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
    row = _require_visible_community(cursor, slug, user_id)
    role = viewer_role(cursor, row[0], user_id)
    if not can_join(row[5], role):
        raise CommunityPermissionError('This community is invite-only')
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
    row = _require_visible_community(cursor, slug, user_id)
    if viewer_role(cursor, row[0], user_id) == 'creator':
        raise CommunityValidationError("The creator can't leave their own community")
    cursor.execute(
        'DELETE FROM community_members WHERE community_id = ? AND user_id = ?',
        (row[0], user_id)
    )
    conn.commit()
    return get_community(conn, slug, user_id)

NOTIFICATION_LEVELS = ('off', 'all', 'popular', 'muted')


def set_notification_level(conn, slug, user_id, level):
    """Set the viewer's notification preference for a community they belong to."""
    if level not in NOTIFICATION_LEVELS:
        raise CommunityValidationError('Invalid notification setting')
    cursor = conn.cursor()
    row = _require_visible_community(cursor, slug, user_id)
    if viewer_role(cursor, row[0], user_id) is None:
        raise CommunityPermissionError('Join this community to manage notifications')
    cursor.execute(
        'UPDATE community_members SET notification_level = ? WHERE community_id = ? AND user_id = ?',
        (level, row[0], user_id)
    )
    conn.commit()
    return {'notification_level': level}


def add_member(conn, slug, actor_id, username):
    cursor = conn.cursor(); row = _require_visible_community(cursor, slug, actor_id)
    if viewer_role(cursor, row[0], actor_id) != 'creator':
        raise CommunityPermissionError('Only the creator can add members')
    cursor.execute('SELECT id, username FROM users WHERE lower(username) = lower(?)', (username or '',))
    target = cursor.fetchone()
    if not target: raise CommunityValidationError('No user with that username')
    cursor.execute("INSERT OR IGNORE INTO community_members (community_id,user_id,role) VALUES (?,?,'member')", (row[0], target[0]))
    cursor.execute('SELECT COUNT(*) FROM community_members WHERE community_id = ?', (row[0],))
    conn.commit()
    return {'username': target[1], 'role': 'member', 'member_count': cursor.fetchone()[0]}

def remove_member(conn, slug, actor_id, username):
    cursor = conn.cursor(); row = _require_visible_community(cursor, slug, actor_id)
    if viewer_role(cursor, row[0], actor_id) != 'creator':
        raise CommunityPermissionError('Only the creator can remove members')
    cursor.execute('SELECT id FROM users WHERE lower(username) = lower(?)', (username or '',)); target = cursor.fetchone()
    cursor.execute('SELECT creator_id FROM communities WHERE id = ?', (row[0],))
    creator_id = cursor.fetchone()[0]
    if target and target[0] == creator_id: raise CommunityValidationError("The creator can't be removed")
    if not target: raise CommunityValidationError('That user is not a member')
    cursor.execute("DELETE FROM community_members WHERE community_id = ? AND user_id = ? AND role != 'creator'", (row[0], target[0]))
    if cursor.rowcount == 0: raise CommunityValidationError('That user is not a member')
    cursor.execute('SELECT COUNT(*) FROM community_members WHERE community_id = ?', (row[0],)); count = cursor.fetchone()[0]; conn.commit()
    return {'member_count': count}


def list_my_communities(conn, user_id):
    """Every community user_id belongs to (any role), newest join first."""
    cursor = conn.cursor()
    cursor.execute('''
        SELECT c.id, c.slug, c.name, c.description, c.topic, c.type, c.icon_emoji, c.created_at,
               (SELECT COUNT(*) FROM community_members m2 WHERE m2.community_id = c.id),
               m.role, c.icon_image, c.cover_image
        FROM community_members m
        JOIN communities c ON c.id = m.community_id
        WHERE m.user_id = ?
        ORDER BY m.joined_at DESC, m.rowid DESC
    ''', (user_id,))
    return [
        serialize_community(row[:9], topic_style(row[4])[1], row[9], row[10], row[11])
        for row in cursor.fetchall()
    ]


def list_community_posts(conn, slug, viewer_id, limit, cursor_id):
    """Keyset-paginated, newest first - same convention as GET /api/posts.
    Returns (posts, next_cursor). Each post includes a 'community' key."""
    # Avoid circular import: post_service imports serializers, which is fine,
    # but if post_service imported community_service at module level we'd loop.
    from app import post_service

    cursor = conn.cursor()
    row = _require_visible_community(cursor, slug, viewer_id)
    community_id, community_slug, community_name = row[0], row[1], row[2]

    posts, next_cursor = post_service.list_posts(
        conn, viewer_id, '', None, limit, cursor_id, only_community_id=community_id
    )

    # Add community key to each post
    for post in posts:
        post['community'] = {'slug': community_slug, 'name': community_name, 'type': row[5]}

    return posts, next_cursor


def create_community_post(conn, slug, user_id, content, audience, files):
    """Create a community post using the real post pipeline. Membership is
    checked here; post_service.create_post handles validation and file save.
    Returns serialize_post shape plus 'community' key. Raises
    CommunityPermissionError (403) if not a member, CommunityValidationError
    (400) for bad input, CommunityNotFoundError (404) if slug doesn't exist.
    """
    # Avoid circular import
    from app import post_service

    cursor = conn.cursor()
    row = _require_visible_community(cursor, slug, user_id)
    community_id, community_slug, community_name = row[0], row[1], row[2]

    if viewer_role(cursor, community_id, user_id) is None:
        raise CommunityPermissionError('Join this community to post')

    # Translate PostValidationError to CommunityValidationError so route
    # error mapping stays unchanged (400 for both, just different exception).
    try:
        post = post_service.create_post(conn, user_id, content, audience, files, community_id=community_id)
    except post_service.PostValidationError as e:
        raise CommunityValidationError(str(e))

    post['community'] = {'slug': community_slug, 'name': community_name, 'type': row[5]}
    return post


def list_communities(conn, viewer_id, q, limit, cursor_id):
    """Browse/search public and restricted communities, keyset-paginated by id DESC.
    Returns (communities, next_cursor)."""
    cursor = conn.cursor()

    # Build query
    query = '''
        SELECT c.id, c.slug, c.name, c.description, c.topic, c.type, c.icon_emoji, c.created_at,
               (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id),
               vm.role, c.icon_image, c.cover_image
        FROM communities c
        LEFT JOIN community_members vm ON vm.community_id = c.id AND vm.user_id = ?
        WHERE c.type != 'private'
    '''
    params = [viewer_id]

    # Apply search filter
    if q:
        q_trimmed = q.strip()[:50]
        if q_trimmed:
            # Escape LIKE special chars: %, _, and the escape char itself
            escaped = q_trimmed.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
            pattern = f'%{escaped}%'
            query += ' AND (c.name LIKE ? ESCAPE ? OR c.slug LIKE ? ESCAPE ? OR c.description LIKE ? ESCAPE ?)'
            params.extend([pattern, '\\', pattern, '\\', pattern, '\\'])

    # Apply keyset cursor
    if cursor_id is not None:
        query += ' AND c.id < ?'
        params.append(cursor_id)

    query += ' ORDER BY c.id DESC LIMIT ?'
    params.append(limit + 1)

    cursor.execute(query, params)
    rows = cursor.fetchall()
    has_next = len(rows) > limit
    page = rows[:limit]
    next_cursor = page[-1][0] if has_next and page else None

    return [
        serialize_community(row[:9], topic_style(row[4])[1], row[9], row[10], row[11])
        for row in page
    ], next_cursor
