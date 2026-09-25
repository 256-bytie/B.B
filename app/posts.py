"""Posts and comments routes."""
import os
import uuid
from flask import Blueprint, request, jsonify, session
from werkzeug.utils import secure_filename
from app.db import get_db
from app.serializers import serialize_post, serialize_comment

bp = Blueprint('posts', __name__)

UPLOAD_FOLDER = 'static/uploads'
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB in bytes
MAX_IMAGES_PER_POST = 4
VALID_AUDIENCES = {'Public', 'Friends', 'Only me'}


@bp.route('/api/posts', methods=['POST'])
def create_post():
    """Create a post for the logged-in session user"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    # Determine if this is multipart/form-data (with files) or JSON
    is_multipart = request.content_type and 'multipart/form-data' in request.content_type

    if is_multipart:
        content = (request.form.get('content') or '').strip()
        audience = request.form.get('audience', 'Public').strip()
        files = request.files.getlist('images')
    else:
        data = request.get_json() or {}
        content = (data.get('content') or '').strip()
        audience = data.get('audience', 'Public').strip()
        files = []

    # Validate content
    if not content:
        return jsonify({'error': 'Content cannot be empty'}), 400

    if len(content) > 2000:
        return jsonify({'error': 'Post exceeds 2000 character limit.'}), 400

    # Validate audience
    if audience not in VALID_AUDIENCES:
        audience = 'Public'  # Default to Public for invalid values

    # Validate images
    if len(files) > MAX_IMAGES_PER_POST:
        return jsonify({'error': 'A post can have at most 4 images.'}), 400

    # Validate each file
    image_paths = []
    for file in files:
        if file and file.filename:
            # Check mime type
            if not file.content_type or not file.content_type.startswith('image/'):
                return jsonify({'error': 'Only image files are supported.'}), 400

            # Check file extension
            filename_lower = file.filename.lower()
            if not any(filename_lower.endswith(f'.{ext}') for ext in ALLOWED_EXTENSIONS):
                return jsonify({'error': 'Only image files are supported.'}), 400

            # Read file to check size (and keep in memory for saving)
            file.seek(0, os.SEEK_END)
            file_size = file.tell()
            file.seek(0)

            if file_size > MAX_IMAGE_SIZE:
                return jsonify({'error': 'Each image must be under 5MB.'}), 400

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Insert post
        cursor.execute(
            'INSERT INTO posts (user_id, content, audience) VALUES (?, ?, ?)',
            (session['user_id'], content, audience)
        )
        post_id = cursor.lastrowid

        # Save and record images
        for position, file in enumerate(files):
            if file and file.filename:
                # Generate unique filename
                file_ext = os.path.splitext(secure_filename(file.filename))[1]
                unique_filename = f"{uuid.uuid4()}{file_ext}"
                file_path = os.path.join(UPLOAD_FOLDER, unique_filename)

                # Save file
                file.save(file_path)

                # Record in database (store relative path for serving)
                image_url = f"/static/uploads/{unique_filename}"
                cursor.execute(
                    'INSERT INTO post_images (post_id, image_path, position) VALUES (?, ?, ?)',
                    (post_id, image_url, position)
                )

        conn.commit()

        # Fetch the created post with full details
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

        # Fetch images for this post
        cursor.execute('''
            SELECT image_path FROM post_images
            WHERE post_id = ?
            ORDER BY position ASC
        ''', (post_id,))
        image_rows = cursor.fetchall()

        conn.close()

        post = serialize_post(row, image_rows, liked_by_user=False)
        return jsonify(post), 201

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


DEFAULT_POSTS_LIMIT = 20
MAX_POSTS_LIMIT = 50


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
    try:
        # Get audience filter from query params
        audience_filter = request.args.get('audience', '').strip()
        if audience_filter and audience_filter not in VALID_AUDIENCES:
            return jsonify({'error': 'Invalid audience filter'}), 400

        # Get user_id filter from query params
        user_id_param = request.args.get('user_id', '').strip()
        user_id_filter = None
        if user_id_param:
            try:
                user_id_filter = int(user_id_param)
            except ValueError:
                return jsonify({'error': 'Invalid user_id filter'}), 400

        # Parse limit: non-integer falls back to default, then clamp to [1, 50]
        limit_param = request.args.get('limit')
        try:
            limit = int(limit_param) if limit_param is not None else DEFAULT_POSTS_LIMIT
        except ValueError:
            limit = DEFAULT_POSTS_LIMIT
        limit = max(1, min(limit, MAX_POSTS_LIMIT))

        # Parse cursor: non-integer is ignored (treated as no cursor / first page)
        cursor_param = request.args.get('cursor')
        cursor_id = None
        if cursor_param is not None:
            try:
                cursor_id = int(cursor_param)
            except ValueError:
                cursor_id = None

        conn = get_db()
        db_cursor = conn.cursor()

        # Get current user_id from session (None if not logged in)
        current_user_id = session.get('user_id')

        # Build query with optional audience/user_id/cursor filters.
        # id DESC and created_at DESC agree here (id is autoincrement,
        # posts are never backdated), so a simple `id < cursor` keyset
        # condition keeps pages stable under concurrent inserts.
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

        where_clauses = []
        if audience_filter:
            where_clauses.append('posts.audience = ?')
            params.append(audience_filter)
        if user_id_filter is not None:
            where_clauses.append('posts.user_id = ?')
            params.append(user_id_filter)
        if cursor_id is not None:
            where_clauses.append('posts.id < ?')
            params.append(cursor_id)

        if where_clauses:
            query += ' WHERE ' + ' AND '.join(where_clauses)

        query += ' ORDER BY posts.created_at DESC, posts.id DESC LIMIT ?'
        # Fetch one extra row to detect whether there's a next page.
        params.append(limit + 1)

        db_cursor.execute(query, params)
        rows = db_cursor.fetchall()

        has_next = len(rows) > limit
        page_rows = rows[:limit]
        next_cursor = page_rows[-1][0] if has_next and page_rows else None

        # Fetch images for just this page of posts, not all matching rows
        if page_rows:
            post_ids = [row[0] for row in page_rows]
            placeholders = ','.join('?' * len(post_ids))
            db_cursor.execute(f'''
                SELECT post_id, image_path
                FROM post_images
                WHERE post_id IN ({placeholders})
                ORDER BY post_id, position ASC
            ''', post_ids)
            image_rows = db_cursor.fetchall()

            # Group images by post_id
            images_by_post = {}
            for post_id, image_path in image_rows:
                if post_id not in images_by_post:
                    images_by_post[post_id] = []
                images_by_post[post_id].append(image_path)
        else:
            images_by_post = {}

        conn.close()

        posts = []
        for row in page_rows:
            post_id = row[0]
            image_list = [(img,) for img in images_by_post.get(post_id, [])]
            posts.append(serialize_post(row, image_list, row[13]))

        return jsonify({'posts': posts, 'next_cursor': next_cursor}), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/posts/<int:post_id>/comments', methods=['GET'])
def get_comments(post_id):
    """Get all comments for a specific post"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        # Verify post exists
        cursor.execute('SELECT id FROM posts WHERE id = ?', (post_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'Post not found'}), 404

        # Get current user_id from session (None if not logged in)
        current_user_id = session.get('user_id')

        # Fetch comments with user info and like status
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
        rows = cursor.fetchall()
        conn.close()

        comments = []
        for row in rows:
            comments.append(serialize_comment(row))

        return jsonify(comments), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/posts/<int:post_id>/comments', methods=['POST'])
def create_comment(post_id):
    """Create a comment on a specific post"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    data = request.get_json() or {}
    content = (data.get('content') or '').strip()
    parent_comment_id = data.get('parent_comment_id')

    if not content:
        return jsonify({'error': 'Content cannot be empty'}), 400

    if len(content) > 1000:
        return jsonify({'error': 'Content too long (max 1000 characters)'}), 400

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Verify post exists
        cursor.execute('SELECT id FROM posts WHERE id = ?', (post_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'Post not found'}), 404

        # If parent_comment_id is provided, validate it
        if parent_comment_id is not None:
            cursor.execute(
                'SELECT post_id FROM comments WHERE id = ?',
                (parent_comment_id,)
            )
            parent_row = cursor.fetchone()

            if not parent_row:
                conn.close()
                return jsonify({'error': 'Parent comment not found'}), 404

            parent_post_id = parent_row[0]
            if parent_post_id != post_id:
                conn.close()
                return jsonify({'error': 'Parent comment belongs to a different post'}), 400

        # Insert comment and increment post comment_count in transaction
        cursor.execute(
            'INSERT INTO comments (post_id, user_id, content, parent_comment_id) VALUES (?, ?, ?, ?)',
            (post_id, session['user_id'], content, parent_comment_id)
        )
        comment_id = cursor.lastrowid

        cursor.execute(
            'UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?',
            (post_id,)
        )

        conn.commit()

        # Fetch the created comment with user info
        cursor.execute('''
            SELECT comments.id, comments.post_id, comments.user_id, comments.content,
                   comments.created_at, comments.like_count, comments.parent_comment_id,
                   users.full_name, users.email, users.profile_picture,
                   users.username, users.bio
            FROM comments
            JOIN users ON comments.user_id = users.id
            WHERE comments.id = ?
        ''', (comment_id,))
        row = cursor.fetchone()
        conn.close()

        comment = serialize_comment(row)
        return jsonify(comment), 201

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/posts/<int:post_id>/like', methods=['POST'])
def like_post(post_id):
    """Toggle like on a post"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Verify post exists
        cursor.execute('SELECT id FROM posts WHERE id = ?', (post_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'Post not found'}), 404

        user_id = session['user_id']

        # Check if like exists
        cursor.execute('''
            SELECT id FROM likes
            WHERE user_id = ? AND target_type = 'post' AND target_id = ?
        ''', (user_id, post_id))
        existing_like = cursor.fetchone()

        if existing_like:
            # Unlike: delete like and decrement count
            # Only decrement if we actually deleted a row (handles race where another thread already deleted)
            cursor.execute('''
                DELETE FROM likes
                WHERE user_id = ? AND target_type = 'post' AND target_id = ?
            ''', (user_id, post_id))
            rows_deleted = cursor.rowcount
            if rows_deleted > 0:
                cursor.execute('''
                    UPDATE posts SET like_count = like_count - 1 WHERE id = ?
                ''', (post_id,))
            liked = False
        else:
            # Like: insert like and increment count
            try:
                cursor.execute('''
                    INSERT INTO likes (user_id, target_type, target_id)
                    VALUES (?, 'post', ?)
                ''', (user_id, post_id))
                # Only increment if OUR insert succeeded
                cursor.execute('''
                    UPDATE posts SET like_count = like_count + 1 WHERE id = ?
                ''', (post_id,))
                liked = True
            except Exception:
                # Race condition: another request inserted this like between our SELECT and INSERT
                # Roll back the failed insert, re-query current state, treat as truth
                # Do NOT increment counter - the winning request already did
                conn.rollback()
                cursor.execute('''
                    SELECT id FROM likes
                    WHERE user_id = ? AND target_type = 'post' AND target_id = ?
                ''', (user_id, post_id))
                existing_like = cursor.fetchone()
                liked = existing_like is not None

        conn.commit()

        # Fetch updated like_count
        cursor.execute('SELECT like_count FROM posts WHERE id = ?', (post_id,))
        like_count = cursor.fetchone()[0]
        conn.close()

        return jsonify({'liked': liked, 'like_count': like_count}), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/comments/<int:comment_id>/like', methods=['POST'])
def like_comment(comment_id):
    """Toggle like on a comment"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Verify comment exists
        cursor.execute('SELECT id FROM comments WHERE id = ?', (comment_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'Comment not found'}), 404

        user_id = session['user_id']

        # Check if like exists
        cursor.execute('''
            SELECT id FROM likes
            WHERE user_id = ? AND target_type = 'comment' AND target_id = ?
        ''', (user_id, comment_id))
        existing_like = cursor.fetchone()

        if existing_like:
            # Unlike: delete like and decrement count
            # Only decrement if we actually deleted a row (handles race where another thread already deleted)
            cursor.execute('''
                DELETE FROM likes
                WHERE user_id = ? AND target_type = 'comment' AND target_id = ?
            ''', (user_id, comment_id))
            rows_deleted = cursor.rowcount
            if rows_deleted > 0:
                cursor.execute('''
                    UPDATE comments SET like_count = like_count - 1 WHERE id = ?
                ''', (comment_id,))
            liked = False
        else:
            # Like: insert like and increment count
            try:
                cursor.execute('''
                    INSERT INTO likes (user_id, target_type, target_id)
                    VALUES (?, 'comment', ?)
                ''', (user_id, comment_id))
                # Only increment if OUR insert succeeded
                cursor.execute('''
                    UPDATE comments SET like_count = like_count + 1 WHERE id = ?
                ''', (comment_id,))
                liked = True
            except Exception:
                # Race condition: another request inserted this like between our SELECT and INSERT
                # Roll back the failed insert, re-query current state, treat as truth
                # Do NOT increment counter - the winning request already did
                conn.rollback()
                cursor.execute('''
                    SELECT id FROM likes
                    WHERE user_id = ? AND target_type = 'comment' AND target_id = ?
                ''', (user_id, comment_id))
                existing_like = cursor.fetchone()
                liked = existing_like is not None

        conn.commit()

        # Fetch updated like_count
        cursor.execute('SELECT like_count FROM comments WHERE id = ?', (comment_id,))
        like_count = cursor.fetchone()[0]
        conn.close()

        return jsonify({'liked': liked, 'like_count': like_count}), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/comments/<int:comment_id>', methods=['DELETE'])
def delete_comment(comment_id):
    """Delete a comment (ownership check enforced)"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Fetch comment with user_id and post_id
        cursor.execute(
            'SELECT user_id, post_id FROM comments WHERE id = ?',
            (comment_id,)
        )
        comment_row = cursor.fetchone()

        if not comment_row:
            conn.close()
            return jsonify({'error': 'Comment not found'}), 404

        comment_user_id, post_id = comment_row

        # Verify ownership
        if session['user_id'] != comment_user_id:
            conn.close()
            return jsonify({'error': 'Forbidden'}), 403

        # Delete comment, associated likes, and decrement post comment_count
        cursor.execute('DELETE FROM comments WHERE id = ?', (comment_id,))

        cursor.execute(
            'DELETE FROM likes WHERE target_type = ? AND target_id = ?',
            ('comment', comment_id)
        )

        cursor.execute(
            'UPDATE posts SET comment_count = MAX(0, comment_count - 1) WHERE id = ?',
            (post_id,)
        )

        conn.commit()
        conn.close()

        return jsonify({}), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500
