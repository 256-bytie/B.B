"""Post, comment, and like domain logic.

Deliberately independent of Flask (plain sqlite3 connection in, plain
values out), matching app/wallet.py, app/library_service.py,
app/search_service.py, and app/user_service.py's shape. As in
library_service.py and user_service.py, image uploads accept a
werkzeug-style file object (.filename, .content_type, .seek()/.tell(),
.save(path)) rather than importing Flask directly.

delete_post predates the rest of this file - it was extracted from
app/routes/users.py (where the DELETE /api/posts/<id> route still lives;
see that file's docstring for why). Everything else here is extracted
from app/routes/posts.py, which is now the thin HTTP layer.
"""
import os
import uuid
from werkzeug.utils import secure_filename

from app.serializers import serialize_post, serialize_comment

UPLOAD_FOLDER = 'static/uploads'
ALLOWED_IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB
MAX_IMAGES_PER_POST = 4
MAX_CONTENT_LEN = 2000
MAX_COMMENT_LEN = 1000
VALID_AUDIENCES = {'Academic', 'Announcements', 'Events', 'Community', 'General'}
DEFAULT_AUDIENCE = 'Academic'

DEFAULT_POSTS_LIMIT = 20
MAX_POSTS_LIMIT = 50


class PostNotFoundError(Exception):
    """A 404: no such post."""


class PostOwnershipError(Exception):
    """A 403: the post exists but isn't the requester's."""


class PostValidationError(Exception):
    """A 400: bad input. str(err) is the user-facing message."""


class CommentNotFoundError(Exception):
    """A 404: no such comment (the target comment, or a referenced
    parent_comment_id)."""


class CommentOwnershipError(Exception):
    """A 403: the comment exists but isn't the requester's."""


def _validate_images(files):
    """Raise PostValidationError if any file in files is missing a
    supported content-type/extension or exceeds MAX_IMAGE_SIZE, or if
    there are more than MAX_IMAGES_PER_POST. Doesn't save anything -
    pure validation, done up front so create_post never writes a
    partial post when an image is bad.
    """
    if len(files) > MAX_IMAGES_PER_POST:
        raise PostValidationError(f'A post can have at most {MAX_IMAGES_PER_POST} images.')

    for file_storage in files:
        if not file_storage or not file_storage.filename:
            continue

        if not file_storage.content_type or not file_storage.content_type.startswith('image/'):
            raise PostValidationError('Only image files are supported.')

        filename_lower = file_storage.filename.lower()
        if not any(filename_lower.endswith(f'.{ext}') for ext in ALLOWED_IMAGE_EXTENSIONS):
            raise PostValidationError('Only image files are supported.')

        file_storage.seek(0, os.SEEK_END)
        file_size = file_storage.tell()
        file_storage.seek(0)
        if file_size > MAX_IMAGE_SIZE:
            raise PostValidationError('Each image must be under 5MB.')


def create_post(conn, user_id, content, audience, files):
    """Validate, insert, and save images for a new post.

    audience falls back to DEFAULT_AUDIENCE for any value outside
    VALID_AUDIENCES (silent default, not an error - matches the
    original route's behavior for this field specifically; contrast
    with list_posts' audience filter, which rejects an invalid value
    instead). Returns the serialized post dict. Raises
    PostValidationError for empty/oversized content or invalid images.
    """
    content = (content or '').strip()
    if not content:
        raise PostValidationError('Content cannot be empty')
    if len(content) > MAX_CONTENT_LEN:
        raise PostValidationError(f'Post exceeds {MAX_CONTENT_LEN} character limit.')

    audience = (audience or DEFAULT_AUDIENCE).strip()
    if audience not in VALID_AUDIENCES:
        audience = DEFAULT_AUDIENCE

    files = [f for f in (files or [])]
    _validate_images(files)

    cursor = conn.cursor()
    cursor.execute(
        'INSERT INTO posts (user_id, content, audience) VALUES (?, ?, ?)',
        (user_id, content, audience)
    )
    post_id = cursor.lastrowid

    for position, file_storage in enumerate(files):
        if file_storage and file_storage.filename:
            file_ext = os.path.splitext(secure_filename(file_storage.filename))[1]
            unique_filename = f"{uuid.uuid4()}{file_ext}"
            file_path = os.path.join(UPLOAD_FOLDER, unique_filename)
            file_storage.save(file_path)

            image_url = f"/static/uploads/{unique_filename}"
            cursor.execute(
                'INSERT INTO post_images (post_id, image_path, position) VALUES (?, ?, ?)',
                (post_id, image_url, position)
            )

    conn.commit()

    cursor.execute('''
        SELECT posts.id, posts.user_id, posts.content, posts.audience,
               posts.created_at, posts.comment_count, posts.like_count,
               posts.view_count, users.full_name, users.email, users.profile_picture,
               users.username, users.bio
        FROM posts
        JOIN users ON posts.user_id = users.id
        WHERE posts.id = ?
    ''', (post_id,))
    row = cursor.fetchone()

    cursor.execute('''
        SELECT image_path FROM post_images
        WHERE post_id = ?
        ORDER BY position ASC
    ''', (post_id,))
    image_rows = cursor.fetchall()

    return serialize_post(row, image_rows, liked_by_user=False)


def list_posts(conn, current_user_id, audience_filter, user_id_filter, limit, cursor_id):
    """Keyset-paginated page of posts, newest first, with joined author
    info and per-viewer liked_by_user.

    audience_filter, if non-empty, must be a member of VALID_AUDIENCES -
    raises PostValidationError otherwise (unlike create_post's audience,
    which silently defaults - this is a filter the caller explicitly
    asked for, so an invalid one is their mistake to fix, not ours to
    paper over). limit is clamped to [1, MAX_POSTS_LIMIT] by the caller
    (see clamp_limit in app/routes/posts.py) before reaching here.

    Returns (posts, next_cursor).
    """
    if audience_filter and audience_filter not in VALID_AUDIENCES:
        raise PostValidationError('Invalid audience filter')

    cursor = conn.cursor()

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
    '''
    params = [current_user_id]

    # Community posts (posts.community_id set) belong to their community's
    # feed only (GET /api/communities/<slug>/posts), never the main feed.
    where_clauses = ['posts.community_id IS NULL']
    if audience_filter:
        where_clauses.append('posts.audience = ?')
        params.append(audience_filter)
    if user_id_filter is not None:
        where_clauses.append('posts.user_id = ?')
        params.append(user_id_filter)
    if cursor_id is not None:
        where_clauses.append('posts.id < ?')
        params.append(cursor_id)

    query += ' WHERE ' + ' AND '.join(where_clauses)

    query += ' ORDER BY posts.created_at DESC, posts.id DESC LIMIT ?'
    params.append(limit + 1)  # one extra row, to detect a next page

    cursor.execute(query, params)
    rows = cursor.fetchall()

    has_next = len(rows) > limit
    page_rows = rows[:limit]
    next_cursor = page_rows[-1][0] if has_next and page_rows else None

    if page_rows:
        post_ids = [row[0] for row in page_rows]
        placeholders = ','.join('?' * len(post_ids))
        cursor.execute(f'''
            SELECT post_id, image_path
            FROM post_images
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


def get_comments(conn, post_id, current_user_id):
    """All comments on post_id, oldest first, with per-viewer
    liked_by_user. Raises PostNotFoundError if post_id doesn't exist."""
    cursor = conn.cursor()

    cursor.execute('SELECT id FROM posts WHERE id = ?', (post_id,))
    if not cursor.fetchone():
        raise PostNotFoundError('Post not found')

    cursor.execute('''
        SELECT comments.id, comments.post_id, comments.user_id, comments.content,
               comments.created_at, comments.like_count, comments.parent_comment_id,
               users.full_name, users.email, users.profile_picture,
               users.username, users.bio,
               CASE WHEN likes.id IS NOT NULL THEN 1 ELSE 0 END as liked_by_user
        FROM comments
        JOIN users ON comments.user_id = users.id
        LEFT JOIN likes ON likes.target_type = 'comment'
                       AND likes.target_id = comments.id
                       AND likes.user_id = ?
        WHERE comments.post_id = ?
        ORDER BY comments.created_at ASC
    ''', (current_user_id, post_id))
    return [serialize_comment(row) for row in cursor.fetchall()]


def create_comment(conn, post_id, user_id, content, parent_comment_id):
    """Add a comment (optionally a reply, via parent_comment_id) to
    post_id and bump its comment_count.

    Returns the serialized comment. Raises PostValidationError for
    empty/oversized content or a parent_comment_id belonging to a
    different post, PostNotFoundError if post_id doesn't exist,
    CommentNotFoundError if parent_comment_id is given but doesn't
    exist.
    """
    content = (content or '').strip()
    if not content:
        raise PostValidationError('Content cannot be empty')
    if len(content) > MAX_COMMENT_LEN:
        raise PostValidationError(f'Content too long (max {MAX_COMMENT_LEN} characters)')

    cursor = conn.cursor()

    cursor.execute('SELECT id FROM posts WHERE id = ?', (post_id,))
    if not cursor.fetchone():
        raise PostNotFoundError('Post not found')

    if parent_comment_id is not None:
        cursor.execute('SELECT post_id FROM comments WHERE id = ?', (parent_comment_id,))
        parent_row = cursor.fetchone()
        if not parent_row:
            raise CommentNotFoundError('Parent comment not found')
        if parent_row[0] != post_id:
            raise PostValidationError('Parent comment belongs to a different post')

    cursor.execute(
        'INSERT INTO comments (post_id, user_id, content, parent_comment_id) VALUES (?, ?, ?, ?)',
        (post_id, user_id, content, parent_comment_id)
    )
    comment_id = cursor.lastrowid

    cursor.execute(
        'UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?',
        (post_id,)
    )
    conn.commit()

    cursor.execute('''
        SELECT comments.id, comments.post_id, comments.user_id, comments.content,
               comments.created_at, comments.like_count, comments.parent_comment_id,
               users.full_name, users.email, users.profile_picture,
               users.username, users.bio
        FROM comments
        JOIN users ON comments.user_id = users.id
        WHERE comments.id = ?
    ''', (comment_id,))
    return serialize_comment(cursor.fetchone())


def _toggle_like(conn, user_id, target_type, target_id, table, exists_query, not_found_error):
    """Shared like/unlike logic for posts and comments - same table
    (likes) and same race-handling shape for both, differing only in
    target_type and which table's like_count to adjust.
    """
    cursor = conn.cursor()

    cursor.execute(exists_query, (target_id,))
    if not cursor.fetchone():
        raise not_found_error()

    cursor.execute('''
        SELECT id FROM likes
        WHERE user_id = ? AND target_type = ? AND target_id = ?
    ''', (user_id, target_type, target_id))
    existing_like = cursor.fetchone()

    if existing_like:
        cursor.execute('''
            DELETE FROM likes
            WHERE user_id = ? AND target_type = ? AND target_id = ?
        ''', (user_id, target_type, target_id))
        if cursor.rowcount > 0:
            cursor.execute(f'UPDATE {table} SET like_count = like_count - 1 WHERE id = ?', (target_id,))
        liked = False
    else:
        try:
            cursor.execute('''
                INSERT INTO likes (user_id, target_type, target_id)
                VALUES (?, ?, ?)
            ''', (user_id, target_type, target_id))
            cursor.execute(f'UPDATE {table} SET like_count = like_count + 1 WHERE id = ?', (target_id,))
            liked = True
        except Exception:
            # Race: another request inserted this like between our SELECT
            # and INSERT. Roll back the failed insert, re-check current
            # state, treat as truth - do NOT double-increment, the
            # winning request already did.
            conn.rollback()
            cursor.execute('''
                SELECT id FROM likes
                WHERE user_id = ? AND target_type = ? AND target_id = ?
            ''', (user_id, target_type, target_id))
            liked = cursor.fetchone() is not None

    conn.commit()

    cursor.execute(f'SELECT like_count FROM {table} WHERE id = ?', (target_id,))
    like_count = cursor.fetchone()[0]

    return liked, like_count


def toggle_post_like(conn, user_id, post_id):
    """Like/unlike a post. Returns (liked, like_count). Raises
    PostNotFoundError if post_id doesn't exist."""
    return _toggle_like(
        conn, user_id, 'post', post_id, 'posts',
        'SELECT id FROM posts WHERE id = ?',
        lambda: PostNotFoundError('Post not found'),
    )


def toggle_comment_like(conn, user_id, comment_id):
    """Like/unlike a comment. Returns (liked, like_count). Raises
    CommentNotFoundError if comment_id doesn't exist."""
    return _toggle_like(
        conn, user_id, 'comment', comment_id, 'comments',
        'SELECT id FROM comments WHERE id = ?',
        lambda: CommentNotFoundError('Comment not found'),
    )


def delete_comment(conn, user_id, comment_id):
    """Delete a comment. Because comments.parent_comment_id cascades
    (see migrations/002_comment_delete_cascade.sql), deleting a comment
    also deletes every reply beneath it, recursively - so this first
    walks the full descendant subtree to (a) clean up their `likes`
    rows, which the cascade can't reach (likes has no FK to comments -
    target_id is a polymorphic reference, not an enforced relationship)
    and (b) decrement the post's comment_count by the true number of
    rows removed, not just 1.

    Raises CommentNotFoundError if comment_id doesn't exist,
    CommentOwnershipError if it isn't user_id's comment.
    """
    cursor = conn.cursor()

    cursor.execute('SELECT user_id, post_id FROM comments WHERE id = ?', (comment_id,))
    row = cursor.fetchone()
    if not row:
        raise CommentNotFoundError('Comment not found')

    comment_user_id, post_id = row
    if user_id != comment_user_id:
        raise CommentOwnershipError('Forbidden')

    cursor.execute('''
        WITH RECURSIVE subtree(id) AS (
            SELECT id FROM comments WHERE id = ?
            UNION ALL
            SELECT c.id FROM comments c JOIN subtree s ON c.parent_comment_id = s.id
        )
        SELECT id FROM subtree
    ''', (comment_id,))
    subtree_ids = [r[0] for r in cursor.fetchall()]

    placeholders = ','.join('?' * len(subtree_ids))
    cursor.execute(
        f"DELETE FROM likes WHERE target_type = 'comment' AND target_id IN ({placeholders})",
        subtree_ids
    )

    # Deleting just the root row - ON DELETE CASCADE removes every
    # reply beneath it automatically.
    cursor.execute('DELETE FROM comments WHERE id = ?', (comment_id,))

    cursor.execute(
        'UPDATE posts SET comment_count = MAX(0, comment_count - ?) WHERE id = ?',
        (len(subtree_ids), post_id)
    )
    conn.commit()


def delete_post(conn, user_id, post_id):
    """Delete a post and everything that depends on it: its images
    (row + on-disk files), its comments, and all likes on both the post
    and its comments. Raises PostNotFoundError if post_id doesn't
    exist, PostOwnershipError if it isn't user_id's post.
    """
    cursor = conn.cursor()

    cursor.execute('SELECT user_id FROM posts WHERE id = ?', (post_id,))
    row = cursor.fetchone()
    if not row:
        raise PostNotFoundError('Post not found')

    if row[0] != user_id:
        raise PostOwnershipError('You can only delete your own posts')

    cursor.execute('SELECT image_path FROM post_images WHERE post_id = ?', (post_id,))
    image_rows = cursor.fetchall()
    for (image_path,) in image_rows:
        if image_path.startswith('/static/uploads/'):
            filename = image_path.replace('/static/uploads/', '')
            file_path = os.path.join(UPLOAD_FOLDER, filename)
            if os.path.exists(file_path):
                os.remove(file_path)

    cursor.execute('DELETE FROM post_images WHERE post_id = ?', (post_id,))

    cursor.execute('''
        DELETE FROM likes
        WHERE target_type = 'comment'
        AND target_id IN (SELECT id FROM comments WHERE post_id = ?)
    ''', (post_id,))

    cursor.execute('DELETE FROM comments WHERE post_id = ?', (post_id,))

    cursor.execute('''
        DELETE FROM likes
        WHERE target_type = 'post' AND target_id = ?
    ''', (post_id,))

    cursor.execute('DELETE FROM posts WHERE id = ?', (post_id,))

    conn.commit()
