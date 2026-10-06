def viewer_role(cursor, community_id, user_id):
    if user_id is None:
        return None
    cursor.execute('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', (community_id, user_id))
    row = cursor.fetchone()
    return row[0] if row else None


def can_view(ctype, role):
    return ctype != 'private' or role is not None


def can_join(ctype, role):
    return role is not None or ctype == 'public'


def can_interact(ctype, role, user_id):
    return user_id is not None and (ctype == 'public' or role is not None)


def post_community(cursor, post_id):
    cursor.execute('''SELECT p.community_id, c.type FROM posts p
                      LEFT JOIN communities c ON c.id = p.community_id WHERE p.id = ?''', (post_id,))
    row = cursor.fetchone()
    if row is None:
        return None
    return None if row[0] is None else (row[0], row[1])
