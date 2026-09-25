"""Shared serialization functions for converting DB rows to JSON dicts."""


def serialize_post(row, image_rows=None, liked_by_user=None):
    """Convert a posts+users joined row into a JSON-serializable dict.
    The handle is the user's username (falling back to the email
    local-part only if username is somehow unset). author_avatar is
    resolved live from users.profile_picture on every read (not copied into
    the post row), so changing a profile picture instantly applies to that
    user's existing posts too — there's no stale per-post copy to update.

    Args:
        row: tuple from posts JOIN users query (includes audience field,
            users.profile_picture, users.username, users.bio)
        image_rows: list of tuples [(image_path,), ...] for this post's images
        liked_by_user: boolean or int (0/1) indicating if current user liked this post
    """
    if len(row) == 13:
        # Old format without liked_by_user in row (e.g., from create_post)
        (post_id, user_id, content, audience, created_at, comment_count,
         like_count, view_count, full_name, email, profile_picture, username, bio) = row
        liked = bool(liked_by_user) if liked_by_user is not None else False
    else:
        # New format with liked_by_user in row (from get_posts)
        (post_id, user_id, content, audience, created_at, comment_count,
         like_count, view_count, full_name, email, profile_picture, username, bio, liked) = row
        liked = bool(liked)

    # Bug fix: this used to derive the handle unconditionally from the
    # email local-part, ignoring the username column entirely (same class
    # of bug as the account switcher's /api/session accounts list) - so an
    # edited username never appeared on that user's posts. Falls back to
    # the email prefix only for the (in practice unreachable, since
    # signup/migration always set one) case where username is somehow
    # still null - same convention used everywhere else in the app.
    handle = username or email.split('@')[0]
    images = [img_row[0] for img_row in image_rows] if image_rows else []

    return {
        'id': post_id,
        'user_id': user_id,
        'content': content,
        'audience': audience,
        'created_at': created_at,
        'comment_count': comment_count,
        'like_count': like_count,
        'view_count': view_count,
        'author_name': full_name,
        'author_handle': handle,
        'author_avatar': profile_picture,
        'username': username,
        'bio': bio,
        'liked_by_user': liked,
        'images': images
    }


def serialize_comment(row, liked_by_user=None, disliked_by_user=None):
    """Convert a comments+users joined row into a JSON-serializable dict.

    Args:
        row: tuple from comments JOIN users query. When called from get_comments,
            row includes liked_by_user and disliked_by_user as the 13th and 14th
            elements. When called from create_comment, row has 12 elements (no
            liked_by_user/disliked_by_user).
        liked_by_user: Optional int (0/1) from the row's liked_by_user field.
            If None, the 'liked_by_user' key is omitted from the output (used
            by create_comment which doesn't return that field). If provided,
            it's included as a boolean.
        disliked_by_user: Optional int (0/1) from the row's disliked_by_user
            field. Same omit-if-None convention as liked_by_user.
    """
    if len(row) == 14:
        # Row from get_comments with liked_by_user and disliked_by_user
        comment_id, post_id, user_id, content, created_at, like_count, parent_comment_id, full_name, email, profile_picture, username, bio, liked_db, disliked_db = row
        liked_by_user = liked_db
        disliked_by_user = disliked_db
    elif len(row) == 13:
        # Row with liked_by_user only (no dislike join)
        comment_id, post_id, user_id, content, created_at, like_count, parent_comment_id, full_name, email, profile_picture, username, bio, liked_db = row
        liked_by_user = liked_db
    else:
        # Row from create_comment without liked_by_user/disliked_by_user (12 elements)
        comment_id, post_id, user_id, content, created_at, like_count, parent_comment_id, full_name, email, profile_picture, username, bio = row

    handle = username or email.split('@')[0]
    result = {
        'id': comment_id,
        'post_id': post_id,
        'user_id': user_id,
        'author_name': full_name,
        'author_handle': handle,
        'author_avatar': profile_picture,
        'username': username,
        'bio': bio,
        'content': content,
        'created_at': created_at,
        'like_count': like_count,
        'parent_comment_id': parent_comment_id
    }

    # Only include liked_by_user/disliked_by_user if provided (either in row or as param)
    if liked_by_user is not None:
        result['liked_by_user'] = bool(liked_by_user)
    if disliked_by_user is not None:
        result['disliked_by_user'] = bool(disliked_by_user)

    return result


def serialize_user_public(row):
    """Convert a user row into a public profile dict.

    Args:
        row: tuple (id, full_name, email, profile_picture, cover_image, username, bio)
    """
    user_id, full_name, email, profile_picture, cover_image, username, bio = row
    return {
        'id': user_id,
        'full_name': full_name,
        'handle': username or email.split('@')[0],
        'profile_picture': profile_picture,
        'cover_image': cover_image,
        'username': username,
        'bio': bio
    }


def serialize_library_file(row, uploader_name=None):
    """Convert a library_files row into a JSON-serializable dict.

    Args:
        row: tuple from library_files (may or may not include joined user data)
        uploader_name: string, the uploader's display name (full_name)
    """
    (file_id, user_id, title, category, department, course, level,
     file_path, file_type, file_size, status, download_count, created_at) = row[:13]

    return {
        'id': file_id,
        'title': title,
        'category': category,
        'department': department or '',
        'course': course or '',
        'level': level or '',
        'file_type': file_type,
        'file_size': file_size,
        'status': status,
        'uploader_id': user_id,
        'uploader_name': uploader_name or '',
        'created_at': created_at,
        'download_count': download_count
    }


def _iso_utc(value):
    """Turn a naive-UTC datetime (or a stored 'YYYY-MM-DD HH:MM:SS' string) into an
    unambiguous ISO-8601 UTC timestamp ('...T...Z') so clients don't have to guess
    the timezone of SQLite's bare timestamps."""
    if value is None:
        return None
    if hasattr(value, 'strftime'):
        return value.strftime('%Y-%m-%dT%H:%M:%SZ')
    return str(value).replace(' ', 'T') + 'Z'


def serialize_credit_transaction(row):
    """Convert a credit_transactions row to a JSON-serializable dict.

    Args:
        row: tuple (id, amount, kind, reason, description, created_at)
    """
    transaction_id, amount, kind, reason, description, created_at = row
    return {
        'id': transaction_id,
        'amount': amount,
        'kind': kind,
        'reason': reason,
        'description': description,
        'created_at': _iso_utc(created_at),
    }


def serialize_monthly_reward(status):
    """Shape wallet.get_monthly_reward_status() output for the API."""
    return {
        'amount': status['amount'],
        'claimable': status['claimable'],
        'next_claim_at': _iso_utc(status['next_claim_at']),
        'last_claimed_at': _iso_utc(status['last_claimed_at']),
    }


def serialize_community(row, icon_bg, viewer_role):
    """Convert a communities row (+ member count) to the shape
    static/js/community.js expects.

    Args:
        row: tuple (id, slug, name, description, topic, type, icon_emoji,
            created_at, member_count)
        icon_bg: Tailwind class picked from the topic palette
            (community_service.TOPIC_STYLES) - derived, not stored.
        viewer_role: 'creator' / 'moderator' / 'member', or None for a
            non-member or logged-out viewer.

    `id` is the slug on purpose: the frontend uses id and slug
    interchangeably as the URL param. The integer PK never leaves the server.
    """
    (_pk, slug, name, description, topic, community_type, icon_emoji,
     created_at, member_count) = row
    return {
        'id': slug,
        'slug': slug,
        'name': name,
        'description': description,
        'topic': topic,
        'type': community_type,
        'icon_emoji': icon_emoji,
        'icon_bg': icon_bg,
        'member_count': member_count,
        'created_at': _iso_utc(created_at),
        'membership': {
            'is_member': viewer_role is not None,
            'role': viewer_role,
        },
    }


def serialize_community_post(row):
    """Community feed row. `author`/`avatar_seed` are the handle (username,
    falling back to the email local-part like serialize_post); `avatar_url`
    is only present when the author has uploaded a real profile picture.

    Args:
        row: tuple (post_id, content, created_at, username, email, profile_picture)
    """
    post_id, content, created_at, username, email, profile_picture = row
    handle = username or email.split('@')[0]
    result = {
        'id': post_id,
        'author': handle,
        'avatar_seed': handle,
        'content': content,
        'created_at': _iso_utc(created_at),
    }
    if profile_picture:
        result['avatar_url'] = profile_picture
    return result
