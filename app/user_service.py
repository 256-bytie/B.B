"""User profile, follow, and highlight domain logic.

Deliberately independent of Flask (plain sqlite3 connection in, plain
values out), matching app/wallet.py, app/library_service.py, and
app/search_service.py's shape. The one exception, as in
library_service.py, is accepting a werkzeug-style file object
(.filename, .content_type, .seek()/.tell(), .save(path)) for the image
upload paths - easy enough to fake in a test without importing Flask.

See app/routes/users.py for the HTTP layer.
"""
import os
import re
import time
import uuid
from werkzeug.utils import secure_filename

from app.serializers import serialize_user_public
from app.upload_utils import delete_if_local

UPLOAD_FOLDER = 'static/uploads'
ALLOWED_IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
ALLOWED_VIDEO_EXTENSIONS = {'mp4', 'mov', 'avi', 'webm', 'mkv'}
MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB
MAX_HIGHLIGHT_SIZE = 25 * 1024 * 1024  # 25MB
MAX_HIGHLIGHT_TITLE_LEN = 20

USERNAME_RE = re.compile(r'^[a-zA-Z0-9_.]+$')
MAX_FULL_NAME_LEN = 50
MAX_USERNAME_LEN = 30
MAX_BIO_LEN = 150

# Rate limiting for the follow endpoint: max N toggles per window per
# user. In-memory and per-process - fine at this app's current scale
# (single dev server), same caveat as any other module-global counter;
# would need a shared store (Redis, DB row) behind multiple workers.
FOLLOW_RATE_LIMIT_MAX = 10
FOLLOW_RATE_LIMIT_WINDOW = 60  # seconds
_follow_rate_limiter = {}  # {user_id: [timestamp1, timestamp2, ...]}


class UserValidationError(Exception):
    """A 400: bad input. str(err) is the user-facing message."""


class UserNotFoundError(Exception):
    """A 404: no such user (or, for highlights, no such highlight)."""


class UsernameTakenError(Exception):
    """A 409: the requested username belongs to a different user."""


class HighlightOwnershipError(Exception):
    """A 403: the highlight exists but isn't the requester's."""


class FollowRateLimitError(Exception):
    """A 429: too many follow/unfollow toggles in the current window."""


def get_public_profile(conn, target_user_id, viewer_user_id):
    """Public profile fields for target_user_id (avatar, cover, name,
    handle, bio, post/follower/following counts, and whether
    viewer_user_id currently follows them). Raises UserNotFoundError if
    target_user_id doesn't exist.
    """
    cursor = conn.cursor()
    cursor.execute(
        'SELECT id, full_name, email, profile_picture, cover_image, username, bio FROM users WHERE id = ?',
        (target_user_id,)
    )
    row = cursor.fetchone()
    if row is None:
        raise UserNotFoundError('User not found')

    cursor.execute('SELECT COUNT(*) FROM posts WHERE user_id = ?', (target_user_id,))
    post_count = cursor.fetchone()[0]

    cursor.execute('SELECT COUNT(*) FROM follows WHERE followee_id = ?', (target_user_id,))
    follower_count = cursor.fetchone()[0]
    cursor.execute('SELECT COUNT(*) FROM follows WHERE follower_id = ?', (target_user_id,))
    following_count = cursor.fetchone()[0]

    is_following = False
    if viewer_user_id is not None:
        cursor.execute(
            'SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?',
            (viewer_user_id, target_user_id)
        )
        is_following = cursor.fetchone() is not None

    profile = serialize_user_public(row)
    profile.update({
        'post_count': post_count,
        'follower_count': follower_count,
        'following_count': following_count,
        'is_following': is_following,
    })
    return profile


def _check_follow_rate_limit(user_id):
    """Raises FollowRateLimitError if user_id has already made
    FOLLOW_RATE_LIMIT_MAX+ toggle requests within the current sliding
    window; otherwise records this request."""
    now = time.time()
    timestamps = _follow_rate_limiter.get(user_id, [])
    timestamps = [ts for ts in timestamps if now - ts < FOLLOW_RATE_LIMIT_WINDOW]

    if len(timestamps) >= FOLLOW_RATE_LIMIT_MAX:
        _follow_rate_limiter[user_id] = timestamps
        raise FollowRateLimitError('Too many requests, slow down')

    timestamps.append(now)
    _follow_rate_limiter[user_id] = timestamps


def toggle_follow(conn, follower_id, followee_id):
    """Follow followee_id if not already following, otherwise unfollow.

    Returns (following: bool, follower_count: int). Raises
    UserValidationError for a self-follow attempt, UserNotFoundError if
    followee_id doesn't exist, FollowRateLimitError if follower_id has
    toggled too many times recently.
    """
    if follower_id == followee_id:
        raise UserValidationError('Cannot follow yourself')

    _check_follow_rate_limit(follower_id)

    cursor = conn.cursor()

    cursor.execute('SELECT id FROM users WHERE id = ?', (followee_id,))
    if not cursor.fetchone():
        raise UserNotFoundError('User not found')

    cursor.execute(
        'SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?',
        (follower_id, followee_id)
    )
    existing = cursor.fetchone()

    if existing:
        cursor.execute('DELETE FROM follows WHERE id = ?', (existing[0],))
        following = False
    else:
        try:
            cursor.execute(
                'INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)',
                (follower_id, followee_id)
            )
            following = True
        except Exception:
            # Race: another request inserted this pair between our SELECT
            # and INSERT. Roll back the failed insert, re-check current
            # state, treat as "already following" rather than erroring.
            conn.rollback()
            cursor.execute(
                'SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?',
                (follower_id, followee_id)
            )
            existing = cursor.fetchone()
            following = existing is not None

    conn.commit()

    cursor.execute('SELECT COUNT(*) FROM follows WHERE followee_id = ?', (followee_id,))
    follower_count = cursor.fetchone()[0]

    return following, follower_count


def get_highlights(conn, user_id):
    """All highlights for user_id, oldest first. Raises
    UserNotFoundError if user_id doesn't exist."""
    cursor = conn.cursor()
    cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
    if not cursor.fetchone():
        raise UserNotFoundError('User not found')

    cursor.execute('''
        SELECT id, title, kind, media_url, created_at
        FROM highlights
        WHERE user_id = ?
        ORDER BY created_at ASC
    ''', (user_id,))
    return [
        {'id': r[0], 'title': r[1], 'kind': r[2], 'cover': r[3], 'created_at': r[4]}
        for r in cursor.fetchall()
    ]


def _validate_image_file(file_storage):
    """Shared validation for profile-picture/cover uploads: must be
    present, image/* content type, an allowed image extension, and
    under MAX_IMAGE_SIZE. Raises UserValidationError; returns nothing."""
    if not file_storage or not file_storage.filename:
        raise UserValidationError('No image file provided.')

    if not file_storage.content_type or not file_storage.content_type.startswith('image/'):
        raise UserValidationError('Only image files are supported.')

    filename_lower = file_storage.filename.lower()
    if not any(filename_lower.endswith(f'.{ext}') for ext in ALLOWED_IMAGE_EXTENSIONS):
        raise UserValidationError('Only image files are supported.')

    file_storage.seek(0, os.SEEK_END)
    file_size = file_storage.tell()
    file_storage.seek(0)
    if file_size > MAX_IMAGE_SIZE:
        raise UserValidationError('Image must be under 5MB.')


def _save_upload(file_storage):
    """Save file_storage under a fresh UUID filename; returns its
    public /static/uploads/... URL."""
    file_ext = os.path.splitext(secure_filename(file_storage.filename))[1]
    unique_filename = f"{uuid.uuid4()}{file_ext}"
    file_path = os.path.join(UPLOAD_FOLDER, unique_filename)
    file_storage.save(file_path)
    return f"/static/uploads/{unique_filename}"


def update_profile_picture(conn, user_id, file_storage):
    """Validate, save, and set the user's profile_picture. Best-effort
    deletes the previous picture from disk. Returns the new image URL.
    Raises UserValidationError on invalid input."""
    _validate_image_file(file_storage)

    cursor = conn.cursor()
    cursor.execute('SELECT profile_picture FROM users WHERE id = ?', (user_id,))
    row = cursor.fetchone()
    old_url = row[0] if row else None

    image_url = _save_upload(file_storage)

    cursor.execute('UPDATE users SET profile_picture = ? WHERE id = ?', (image_url, user_id))
    conn.commit()

    delete_if_local(old_url, UPLOAD_FOLDER)

    return image_url


def update_profile_cover(conn, user_id, file_storage):
    """Validate, save, and set the user's cover_image. Best-effort
    deletes the previous cover from disk. Returns the new image URL.
    Raises UserValidationError on invalid input."""
    _validate_image_file(file_storage)

    cursor = conn.cursor()
    cursor.execute('SELECT cover_image FROM users WHERE id = ?', (user_id,))
    row = cursor.fetchone()
    old_url = row[0] if row else None

    image_url = _save_upload(file_storage)

    cursor.execute('UPDATE users SET cover_image = ? WHERE id = ?', (image_url, user_id))
    conn.commit()

    delete_if_local(old_url, UPLOAD_FOLDER)

    return image_url


def update_profile(conn, user_id, full_name, username, bio):
    """Validate and persist full_name/username/bio.

    Returns {'full_name', 'username', 'bio'}. Raises UserValidationError
    for missing/oversized/malformed fields, UsernameTakenError if
    username belongs to a different user (case-insensitive).
    """
    full_name = (full_name or '').strip()
    if not full_name:
        raise UserValidationError('Full name is required')
    if len(full_name) > MAX_FULL_NAME_LEN:
        raise UserValidationError(f'Full name must be {MAX_FULL_NAME_LEN} characters or less')

    username = (username or '').strip()
    if not username:
        raise UserValidationError('Username is required')
    if len(username) > MAX_USERNAME_LEN:
        raise UserValidationError(f'Username must be {MAX_USERNAME_LEN} characters or less')
    if not USERNAME_RE.match(username):
        raise UserValidationError('Username can only contain letters, numbers, underscores, and periods')

    bio = (bio or '').strip()
    if bio and len(bio) > MAX_BIO_LEN:
        raise UserValidationError(f'Bio must be {MAX_BIO_LEN} characters or less')
    bio = bio if bio else None

    cursor = conn.cursor()
    cursor.execute(
        'SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?',
        (username, user_id)
    )
    if cursor.fetchone():
        raise UsernameTakenError('That username is already taken.')

    cursor.execute(
        'UPDATE users SET full_name = ?, username = ?, bio = ? WHERE id = ?',
        (full_name, username, bio, user_id)
    )
    conn.commit()

    return {'full_name': full_name, 'username': username, 'bio': bio}


def create_highlight(conn, user_id, file_storage, title):
    """Validate, save, and insert a highlight (photo or video).

    Returns {'id', 'title', 'kind', 'cover', 'created_at'}. Raises
    UserValidationError on invalid title, missing file, unsupported
    type, or oversized file.
    """
    title = (title or '').strip()
    if not title:
        raise UserValidationError('Title is required.')
    if len(title) > MAX_HIGHLIGHT_TITLE_LEN:
        raise UserValidationError(f'Title must be {MAX_HIGHLIGHT_TITLE_LEN} characters or less.')

    if not file_storage or not file_storage.filename:
        raise UserValidationError('No media file provided.')

    if not file_storage.content_type:
        raise UserValidationError('Unable to determine file type.')

    if file_storage.content_type.startswith('image/'):
        kind = 'photo'
        allowed_exts = ALLOWED_IMAGE_EXTENSIONS
    elif file_storage.content_type.startswith('video/'):
        kind = 'video'
        allowed_exts = ALLOWED_VIDEO_EXTENSIONS
    else:
        raise UserValidationError('Only image and video files are supported.')

    filename_lower = file_storage.filename.lower()
    if not any(filename_lower.endswith(f'.{ext}') for ext in allowed_exts):
        raise UserValidationError('Only image and video files are supported.')

    file_storage.seek(0, os.SEEK_END)
    file_size = file_storage.tell()
    file_storage.seek(0)
    if file_size > MAX_HIGHLIGHT_SIZE:
        raise UserValidationError('File must be under 25MB.')

    media_url = _save_upload(file_storage)

    cursor = conn.cursor()
    cursor.execute(
        'INSERT INTO highlights (user_id, title, kind, media_url) VALUES (?, ?, ?, ?)',
        (user_id, title, kind, media_url)
    )
    highlight_id = cursor.lastrowid
    conn.commit()

    cursor.execute('''
        SELECT id, title, kind, media_url, created_at
        FROM highlights
        WHERE id = ?
    ''', (highlight_id,))
    row = cursor.fetchone()

    return {'id': row[0], 'title': row[1], 'kind': row[2], 'cover': row[3], 'created_at': row[4]}


def delete_highlight(conn, user_id, highlight_id):
    """Delete a highlight (row + its uploaded file). Raises
    UserNotFoundError if it doesn't exist, HighlightOwnershipError if it
    belongs to someone else."""
    cursor = conn.cursor()
    cursor.execute('SELECT user_id, media_url FROM highlights WHERE id = ?', (highlight_id,))
    row = cursor.fetchone()

    if not row:
        raise UserNotFoundError('Highlight not found')

    owner_id, media_url = row
    if owner_id != user_id:
        raise HighlightOwnershipError('You can only delete your own highlights')

    cursor.execute('DELETE FROM highlights WHERE id = ?', (highlight_id,))
    conn.commit()

    delete_if_local(media_url, UPLOAD_FOLDER)
