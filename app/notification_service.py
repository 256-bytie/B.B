"""Notification creation, retrieval, and read-state logic."""
import logging

from app import post_service
from app.serializers import serialize_notification


DEFAULT_LIMIT = 20
MAX_LIMIT = 50
AGGREGATED_TYPES = ('post_like', 'comment_like')

_LOG = logging.getLogger(__name__)
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

    items = []
    for row in page_rows:
        notification_type = row[1]
        preview_content = None
        if notification_type in ('post_like', 'post_quote'):
            post = posts.get(row[7])
            preview_content = post.get('content') if post else None
        elif notification_type in ('post_comment', 'comment_reply', 'comment_like'):
            preview_content = comment_content.get(row[6])
        items.append(serialize_notification(
            row,
            actor=actors.get(row[4]),
            preview_content=preview_content,
            post=posts.get(row[7]),
            others_count=row[8],
            community=communities.get(row[6]) if row[5] == 'community' else None,
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
