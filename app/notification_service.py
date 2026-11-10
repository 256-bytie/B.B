"""Notification creation, retrieval, and read-state logic."""
import logging
import re
from contextlib import contextmanager
from datetime import timezone

from app import post_service
from app.serializers import serialize_notification


DEFAULT_LIMIT = 20
MAX_LIMIT = 50
AGGREGATED_TYPES = ('post_like', 'comment_like')

_LOG = logging.getLogger(__name__)
POPULAR_LIKE_THRESHOLD = 5
_MENTION_RE = re.compile(r'(?<![A-Za-z0-9_.@])@([A-Za-z0-9_.]{1,30})(?![A-Za-z0-9_.])')
_VISIBILITY_PREDICATE = '''
    (n.post_id IS NULL OR EXISTS (
        SELECT 1
        FROM posts p
        LEFT JOIN communities c ON c.id = p.community_id
        WHERE p.id = n.post_id
          AND (p.community_id IS NULL OR c.type <> 'private' OR EXISTS (
              SELECT 1 FROM community_members m
              WHERE m.community_id = p.community_id AND m.user_id = %s
          ))
    ))
    AND (n.target_type IS DISTINCT FROM 'comment' OR EXISTS (
        SELECT 1 FROM comments target_comment WHERE target_comment.id = n.target_id
    ))
    AND (n.target_type IS DISTINCT FROM 'community' OR EXISTS (
        SELECT 1 FROM community_members m
        WHERE m.community_id = n.target_id AND m.user_id = %s
    ))
'''


def create(cursor, recipient_id, actor_id, type, target_type, target_id, post_id):
    """Insert one deduplicated notification without committing or raising."""
    if recipient_id == actor_id:
        return False

    dedupe_key = f'{type}:{actor_id}:{target_type}:{target_id}'
    savepoint = 'notification_create'
    try:
        cursor.execute(f'SAVEPOINT {savepoint}')
        cursor.execute('''
            INSERT INTO notifications
                (recipient_id, actor_id, type, target_type, target_id, post_id, dedupe_key)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (recipient_id, dedupe_key) DO NOTHING
            RETURNING id
        ''', (recipient_id, actor_id, type, target_type, target_id, post_id, dedupe_key))
        inserted = cursor.fetchone() is not None
        cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
        return inserted
    except Exception:
        try:
            cursor.execute(f'ROLLBACK TO SAVEPOINT {savepoint}')
            cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
        except Exception:
            pass
        _LOG.exception('Failed to create notification')
        return False


@contextmanager
def event_savepoint(cursor):
    """Contain lookup and fan-out failures within the triggering transaction."""
    savepoint = 'notification_event'
    try:
        cursor.execute(f'SAVEPOINT {savepoint}')
        yield
        cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
    except Exception:
        try:
            cursor.execute(f'ROLLBACK TO SAVEPOINT {savepoint}')
            cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
        except Exception:
            pass
        _LOG.exception('Failed to generate notifications')


def notify_community_post(cursor, post_id, author_id, community_id, level):
    """Notify eligible members once per post, preserving event precedence."""
    cursor.execute('''
        SELECT m.user_id FROM community_members m
        WHERE m.community_id = %s AND m.notification_level = %s
          AND m.user_id <> %s
          AND NOT EXISTS (
              SELECT 1 FROM notifications n
              WHERE n.recipient_id = m.user_id AND n.post_id = %s
                AND n.target_type = 'post' AND n.target_id = %s
                AND n.type IN ('mention', 'post_quote', 'community_post')
          )
    ''', (community_id, level, author_id, post_id, post_id))
    create_many(cursor, [row[0] for row in cursor.fetchall()], author_id,
                'community_post', 'post', post_id, post_id)


def extract_mentions(content):
    """Return up to ten distinct normalized handles in encounter order."""
    handles = []
    seen = set()
    for match in _MENTION_RE.finditer(content or ''):
        handle = match.group(1).rstrip('.').lower()
        if handle and handle not in seen:
            seen.add(handle)
            handles.append(handle)
            if len(handles) == 10:
                break
    return handles


def resolve_mentions(cursor, handles):
    """Resolve normalized handles to user ids without changing their order."""
    handles = list(dict.fromkeys(handles or []))
    if not handles:
        return {}
    cursor.execute('SELECT id, lower(username) FROM users WHERE lower(username) = ANY(%s)', (handles,))
    return {
        row[0]: row[1]
        for row in cursor.fetchall()
        if row[1] in handles
    }


def create_many(cursor, recipient_ids, actor_id, type, target_type, target_id, post_id):
    recipients = list(dict.fromkeys(r for r in recipient_ids if r != actor_id))
    if not recipients:
        return 0
    savepoint = 'notification_create_many'
    try:
        cursor.execute(f'SAVEPOINT {savepoint}')
        cursor.execute('''
            INSERT INTO notifications
                (recipient_id, actor_id, type, target_type, target_id, post_id, dedupe_key)
            SELECT recipient_id, %s, %s, %s, %s, %s,
                   %s || ':' || %s::text || ':' || %s || ':' || %s::text
            FROM unnest(%s::bigint[]) AS recipients(recipient_id)
            ON CONFLICT (recipient_id, dedupe_key) DO NOTHING
        ''', (actor_id, type, target_type, target_id, post_id, type, actor_id,
              target_type, target_id, recipients))
        inserted = cursor.rowcount
        cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
        return inserted
    except Exception:
        try:
            cursor.execute(f'ROLLBACK TO SAVEPOINT {savepoint}')
            cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
        except Exception:
            pass
        _LOG.exception('Failed to create notification batch')
        return 0


def create_system(cursor, recipient_id, type, dedupe_key):
    savepoint = 'notification_create_system'
    try:
        cursor.execute(f'SAVEPOINT {savepoint}')
        cursor.execute('''
            INSERT INTO notifications
                (recipient_id, actor_id, type, target_type, target_id, post_id, dedupe_key)
            VALUES (%s, NULL, %s, NULL, NULL, NULL, %s)
            ON CONFLICT (recipient_id, dedupe_key) DO NOTHING
            RETURNING id
        ''', (recipient_id, type, dedupe_key))
        inserted = cursor.fetchone() is not None
        cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
        return inserted
    except Exception:
        try:
            cursor.execute(f'ROLLBACK TO SAVEPOINT {savepoint}')
            cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
        except Exception:
            pass
        _LOG.exception('Failed to create system notification')
        return False


def clear_system(cursor, recipient_id, type):
    savepoint = 'notification_clear_system'
    try:
        cursor.execute(f'SAVEPOINT {savepoint}')
        cursor.execute('''
            DELETE FROM notifications
            WHERE recipient_id = %s AND type = %s
        ''', (recipient_id, type))
        cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
    except Exception:
        try:
            cursor.execute(f'ROLLBACK TO SAVEPOINT {savepoint}')
            cursor.execute(f'RELEASE SAVEPOINT {savepoint}')
        except Exception:
            pass
        _LOG.exception('Failed to clear system notification')


def ensure_monthly_credits(conn, user_id):
    """Best-effort lazy materialization of the current claimable reward."""
    try:
        from app import wallet
        cursor = conn.cursor()
        # Serialize this check with claims so a concurrent list cannot publish a
        # stale cycle after the claim has committed.
        cursor.execute('SELECT 1 FROM users WHERE id = %s FOR UPDATE', (user_id,))
        if cursor.fetchone() is None:
            conn.rollback()
            return
        status = wallet.get_monthly_reward_status(conn, user_id)
        if not status['claimable']:
            conn.commit()
            return
        claimed = status['last_claimed_at']
        stamp = claimed.astimezone(timezone.utc).isoformat() if claimed else 'never'
        create_system(cursor, user_id, 'monthly_credits', f'monthly_credits:{stamp}')
        # Commit even on a conflict to release the user lock and finish this
        # read-only transaction cleanly.
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        _LOG.exception('Failed to ensure monthly credits notification')


def _count_visible(conn, user_id):
    cursor = conn.cursor()
    cursor.execute(f'''
        SELECT
            COUNT(*) FILTER (WHERE n.type <> ALL(%s))
            + COUNT(DISTINCT (n.type, n.target_type, n.target_id))
                FILTER (WHERE n.type = ANY(%s))
        FROM notifications n
        WHERE n.recipient_id = %s
          AND n.read_at IS NULL
          AND {_VISIBILITY_PREDICATE}
    ''', (list(AGGREGATED_TYPES), list(AGGREGATED_TYPES), user_id, user_id, user_id))
    return cursor.fetchone()[0]


def unread_count(conn, user_id):
    return _count_visible(conn, user_id)


def list_notifications(conn, user_id, limit=DEFAULT_LIMIT, cursor_id=None):
    ensure_monthly_credits(conn, user_id)
    limit = max(1, min(int(limit), MAX_LIMIT))
    cursor = conn.cursor()
    before_clause = ''
    params = [user_id, user_id, user_id, list(AGGREGATED_TYPES)]
    if cursor_id is not None:
        before_clause = 'AND id < %s'
        params.append(cursor_id)
    params.append(limit + 1)
    cursor.execute(f'''
        WITH visible AS (
            SELECT n.*
            FROM notifications n
            WHERE n.recipient_id = %s
              AND {_VISIBILITY_PREDICATE}
        ), grouped AS (
            SELECT visible.*,
                   ROW_NUMBER() OVER (
                       PARTITION BY CASE
                           WHEN type = ANY(%s)
                           THEN type || ':' || target_type || ':' || target_id
                           ELSE 'row:' || id
                       END
                       ORDER BY id DESC
                   ) AS rn,
                   COUNT(*) OVER (
                       PARTITION BY CASE
                           WHEN type = ANY(%s)
                           THEN type || ':' || target_type || ':' || target_id
                           ELSE 'row:' || id
                       END
                   ) AS group_size,
                   BOOL_OR(read_at IS NULL) OVER (
                       PARTITION BY CASE
                           WHEN type = ANY(%s)
                           THEN type || ':' || target_type || ':' || target_id
                           ELSE 'row:' || id
                       END
                   ) AS group_unread
            FROM visible
        )
        SELECT id, type, created_at,
               CASE WHEN group_unread THEN NULL ELSE created_at END AS read_at,
               actor_id, target_type, target_id, post_id, group_size - 1
        FROM grouped
        WHERE rn = 1
          {before_clause}
        ORDER BY id DESC
        LIMIT %s
    ''', params[:3] + [list(AGGREGATED_TYPES), list(AGGREGATED_TYPES), list(AGGREGATED_TYPES)] + params[4:])
    rows = cursor.fetchall()

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    next_cursor = page_rows[-1][0] if has_more and page_rows else None

    actor_ids = list(dict.fromkeys(row[4] for row in page_rows if row[4] is not None))
    actors = {}
    if actor_ids:
        placeholders = ','.join(['%s'] * len(actor_ids))
        cursor.execute(f'''
            SELECT id, full_name, email, profile_picture, username
            FROM users WHERE id IN ({placeholders})
        ''', actor_ids)
        actors = {
            row[0]: {
                'id': row[0],
                'full_name': row[1],
                'handle': row[4] or row[2].split('@')[0],
                'profile_picture': row[3],
            }
            for row in cursor.fetchall()
        }

    comment_ids = list(dict.fromkeys(
        row[6] for row in page_rows if row[5] == 'comment'
    ))
    comment_content = {}
    if comment_ids:
        placeholders = ','.join(['%s'] * len(comment_ids))
        cursor.execute(
            f'SELECT id, content FROM comments WHERE id IN ({placeholders})',
            comment_ids,
        )
        comment_content = dict(cursor.fetchall())

    post_ids = list(dict.fromkeys(row[7] for row in page_rows if row[7] is not None))
    posts = post_service.fetch_posts_by_ids(conn, post_ids, user_id)

    community_ids = list(dict.fromkeys(
        row[6] for row in page_rows if row[5] == 'community'
    ))
    communities = {}
    if community_ids:
        placeholders = ','.join(['%s'] * len(community_ids))
        cursor.execute(
            f'SELECT id, slug, name FROM communities WHERE id IN ({placeholders})',
            community_ids,
        )
        communities = {
            row[0]: {'slug': row[1], 'name': row[2]}
            for row in cursor.fetchall()
        }

    # Community-post notifications target the post so their post snapshot can
    # be opened directly. Reuse the community payload already hydrated on the
    # snapshot. Keyed by post id in its own dict: community ids and post ids
    # are different key spaces and must never share a mapping.
    post_communities = {}
    for post in posts.values():
        community = post.get('community')
        if community:
            post_communities[post['id']] = {
                'slug': community['slug'],
                'name': community['name'],
            }

    items = []
    for row in page_rows:
        notification_type = row[1]
        post = posts.get(row[7])
        preview_content = None
        if row[5] == 'comment':
            preview_content = comment_content.get(row[6])
        elif notification_type in ('post_like', 'post_quote', 'mention', 'community_post'):
            preview_content = post.get('content') if post else None

        if row[5] == 'community':
            community = communities.get(row[6])
        elif notification_type == 'community_post':
            community = post_communities.get(row[7])
        else:
            community = None
        items.append(serialize_notification(
            row,
            actor=actors.get(row[4]),
            preview_content=preview_content,
            post=post,
            others_count=row[8],
            community=community,
        ))

    return items, next_cursor, _count_visible(conn, user_id)


def mark_read(conn, user_id, ids=None, all_=False):
    cursor = conn.cursor()
    if all_:
        cursor.execute('''
            UPDATE notifications
            SET read_at = now()
            WHERE recipient_id = %s AND read_at IS NULL
        ''', (user_id,))
    else:
        cursor.execute('''
            UPDATE notifications n
            SET read_at = now()
            WHERE n.recipient_id = %s
              AND n.read_at IS NULL
              AND (
                  n.id = ANY(%s)
                  OR (
                      n.type = ANY(%s)
                      AND EXISTS (
                          SELECT 1
                          FROM notifications selected
                          WHERE selected.recipient_id = %s
                            AND selected.id = ANY(%s)
                            AND selected.type = ANY(%s)
                            AND selected.type = n.type
                            AND selected.target_type IS NOT DISTINCT FROM n.target_type
                            AND selected.target_id IS NOT DISTINCT FROM n.target_id
                      )
                  )
              )
        ''', (user_id, ids, list(AGGREGATED_TYPES), user_id, ids, list(AGGREGATED_TYPES)))
    conn.commit()
    return _count_visible(conn, user_id)
