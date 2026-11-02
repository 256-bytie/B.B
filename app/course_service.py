"""Private personal Courses storage and folder domain logic."""
import os
import re
import threading
import unicodedata
import uuid
import zipfile
import codecs
from psycopg.errors import UniqueViolation

from app.serializers import serialize_course_file, serialize_course_folder

COURSE_FILES_ROOT = os.environ.get('COURSE_FILES_ROOT', './private_uploads')
MAX_FILE_SIZE = 50 * 1024 * 1024
QUOTA_BYTES = 500 * 1024 * 1024
MAX_FOLDER_DEPTH = 5
MAX_ITEMS = 500
ZIP_MAX_ENTRIES = 4096
ZIP_MAX_DECLARED_BYTES = 100 * 1024 * 1024

ALLOWED_TYPES = {
    'pdf': 'application/pdf', 'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'txt': 'text/plain', 'md': 'text/markdown', 'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp',
}
INLINE_TYPES = {'pdf', 'jpg', 'jpeg', 'png', 'webp'}
_user_locks = {}
_user_locks_guard = threading.Lock()


class CourseValidationError(Exception):
    pass


class CourseNotFoundError(Exception):
    pass


class CourseConflictError(Exception):
    pass


class CourseTooLargeError(Exception):
    pass


def configure(root):
    global COURSE_FILES_ROOT
    COURSE_FILES_ROOT = root


def _user_lock(user_id):
    with _user_locks_guard:
        return _user_locks.setdefault(user_id, threading.Lock())


def _clean_name(value, maximum, label):
    if not isinstance(value, str):
        raise CourseValidationError(f'{label} is invalid.')
    value = ''.join(ch for ch in value if unicodedata.category(ch) != 'Cc')
    value = value.replace('/', '').replace('\\', '')
    value = re.sub(r'\s+', ' ', value).strip()
    if not value or re.fullmatch(r'\.+', value) or len(value) > maximum:
        raise CourseValidationError(f'{label} must be {"1-30" if maximum == 30 else "1-100"} characters.')
    return value


def _root_path():
    root = os.path.abspath(COURSE_FILES_ROOT)
    os.makedirs(root, mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)
    return root


def _safe_path(storage_key):
    root = _root_path()
    path = os.path.abspath(os.path.join(root, storage_key))
    if os.path.commonpath([root, path]) != root:
        raise CourseValidationError('Invalid storage path.')
    return path


def _user_dir(user_id):
    courses_path = _safe_path('courses')
    os.makedirs(courses_path, mode=0o700, exist_ok=True)
    os.chmod(courses_path, 0o700)
    path = _safe_path(os.path.join('courses', str(user_id)))
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _folder(conn, user_id, folder_id):
    if folder_id is None:
        return None
    row = conn.execute('SELECT id, user_id, parent_id, name, created_at FROM course_folders WHERE id=%s AND user_id=%s', (folder_id, user_id)).fetchone()
    if not row:
        raise CourseNotFoundError('Folder not found.')
    return row


def _folder_depth(conn, user_id, folder_id):
    depth = 0
    seen = set()
    current = folder_id
    while current is not None:
        if current in seen:
            raise CourseValidationError('Folder cycle detected.')
        seen.add(current)
        row = conn.execute('SELECT parent_id FROM course_folders WHERE id=%s AND user_id=%s', (current, user_id)).fetchone()
        if not row:
            raise CourseNotFoundError('Folder not found.')
        current = row[0]
        depth += 1
    return depth


def _is_descendant(conn, user_id, folder_id, possible_parent_id):
    current = possible_parent_id
    while current is not None:
        if current == folder_id:
            return True
        row = conn.execute('SELECT parent_id FROM course_folders WHERE id=%s AND user_id=%s', (current, user_id)).fetchone()
        if not row:
            return False
        current = row[0]
    return False


def _folder_object(conn, row):
    folder_id, user_id, parent_id, name, created_at = row
    count = conn.execute('''SELECT (SELECT count(*) FROM course_folders WHERE parent_id=%s AND user_id=%s)
                            + (SELECT count(*) FROM course_files WHERE folder_id=%s AND user_id=%s)''',
                         (folder_id, user_id, folder_id, user_id)).fetchone()[0]
    return serialize_course_folder(row, count)


def create_folder(conn, user_id, name, parent_id=None):
    name = _clean_name(name, 30, 'Folder name')
    _folder(conn, user_id, parent_id)
    if parent_id is not None and _folder_depth(conn, user_id, parent_id) >= MAX_FOLDER_DEPTH:
        raise CourseValidationError('Maximum folder depth is 5.')
    if conn.execute('SELECT 1 FROM course_folders WHERE user_id=%s AND parent_id IS NOT DISTINCT FROM %s AND lower(name)=lower(%s)', (user_id, parent_id, name)).fetchone():
        raise CourseConflictError('A folder with that name already exists.')
    try:
        row = conn.execute('INSERT INTO course_folders (user_id,parent_id,name) VALUES (%s,%s,%s) RETURNING id,user_id,parent_id,name,created_at', (user_id, parent_id, name)).fetchone()
        conn.commit()
        return _folder_object(conn, row)
    except UniqueViolation:
        conn.rollback()
        raise CourseConflictError('A folder with that name already exists.')
    except Exception:
        conn.rollback()
        raise


def update_folder(conn, user_id, folder_id, name=None, parent_id=None, parent_provided=False):
    row = _folder(conn, user_id, folder_id)
    new_name = _clean_name(name, 30, 'Folder name') if name is not None else row[3]
    new_parent = parent_id if parent_provided else row[2]
    _folder(conn, user_id, new_parent)
    if new_parent == folder_id or (new_parent is not None and _is_descendant(conn, user_id, folder_id, new_parent)):
        raise CourseValidationError('A folder cannot be moved into itself or a descendant.')
    if new_parent is not None:
        descendant_depth = conn.execute('''WITH RECURSIVE tree(id, depth) AS (
            SELECT id, 1 FROM course_folders WHERE id=%s AND user_id=%s
            UNION ALL SELECT f.id, tree.depth + 1 FROM course_folders f
            JOIN tree ON f.parent_id=tree.id WHERE f.user_id=%s)
            SELECT max(depth) FROM tree''', (folder_id, user_id, user_id)).fetchone()[0]
        if _folder_depth(conn, user_id, new_parent) + descendant_depth > MAX_FOLDER_DEPTH:
            raise CourseValidationError('Maximum folder depth is 5.')
    if conn.execute('SELECT 1 FROM course_folders WHERE user_id=%s AND id<>%s AND parent_id IS NOT DISTINCT FROM %s AND lower(name)=lower(%s)', (user_id, folder_id, new_parent, new_name)).fetchone():
        raise CourseConflictError('A folder with that name already exists.')
    try:
        updated = conn.execute('UPDATE course_folders SET name=%s,parent_id=%s WHERE id=%s AND user_id=%s RETURNING id,user_id,parent_id,name,created_at', (new_name, new_parent, folder_id, user_id)).fetchone()
        conn.commit()
    except UniqueViolation:
        conn.rollback()
        raise CourseConflictError('A folder with that name already exists.')
    return _folder_object(conn, updated)


def list_items(conn, user_id, folder_id=None):
    folder = _folder(conn, user_id, folder_id)
    folder_rows = conn.execute('SELECT id,user_id,parent_id,name,created_at FROM course_folders WHERE user_id=%s AND parent_id IS NOT DISTINCT FROM %s ORDER BY created_at DESC,id DESC LIMIT %s', (user_id, folder_id, MAX_ITEMS)).fetchall()
    folders = [_folder_object(conn, row) for row in folder_rows]
    file_rows = conn.execute('SELECT id,user_id,folder_id,name,file_type,mime_type,file_size,storage_key,original_filename,created_at FROM course_files WHERE user_id=%s AND folder_id IS NOT DISTINCT FROM %s ORDER BY created_at DESC,id DESC LIMIT %s', (user_id, folder_id, MAX_ITEMS)).fetchall()
    files = [serialize_course_file(row) for row in file_rows]
    return {'folder': _folder_object(conn, folder) if folder else None, 'folders': folders, 'files': files}


def _subtree_file_keys(conn, user_id, folder_id):
    rows = conn.execute('''WITH RECURSIVE tree(id) AS (SELECT id FROM course_folders WHERE id=%s AND user_id=%s UNION ALL SELECT f.id FROM course_folders f JOIN tree t ON f.parent_id=t.id WHERE f.user_id=%s)
                           SELECT storage_key FROM course_files WHERE user_id=%s AND folder_id IN (SELECT id FROM tree)''', (folder_id, user_id, user_id, user_id)).fetchall()
    keys = [row[0] for row in rows]
    folders = conn.execute('WITH RECURSIVE tree(id) AS (SELECT id FROM course_folders WHERE id=%s AND user_id=%s UNION ALL SELECT f.id FROM course_folders f JOIN tree t ON f.parent_id=t.id WHERE f.user_id=%s) SELECT count(*) FROM tree', (folder_id, user_id, user_id)).fetchone()[0]
    return keys, folders


def delete_folder(conn, user_id, folder_id):
    _folder(conn, user_id, folder_id)
    keys, folder_count = _subtree_file_keys(conn, user_id, folder_id)
    file_count = len(keys)
    conn.execute('DELETE FROM course_folders WHERE id=%s AND user_id=%s', (folder_id, user_id))
    conn.commit()
    for key in keys:
        try:
            os.remove(_safe_path(key))
        except (OSError, CourseValidationError):
            pass
    return {'folders': folder_count, 'files': file_count}


def _validate_content(path, file_type):
    with open(path, 'rb') as stream:
        head = stream.read(512)
    if file_type == 'pdf': valid = head.startswith(b'%PDF-')
    elif file_type in {'doc', 'ppt', 'xls'}: valid = head.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')
    elif file_type in {'docx', 'pptx', 'xlsx'}:
        valid = head.startswith(b'PK\x03\x04')
        if valid:
            expected = {'docx': 'word/', 'pptx': 'ppt/', 'xlsx': 'xl/'}[file_type]
            try:
                with zipfile.ZipFile(path) as archive:
                    entries = archive.infolist()
                    valid = len(entries) <= ZIP_MAX_ENTRIES and sum(max(0, i.file_size) for i in entries) <= ZIP_MAX_DECLARED_BYTES
                    valid = valid and '[Content_Types].xml' in archive.namelist() and any(i.filename.startswith(expected) for i in entries)
            except (OSError, zipfile.BadZipFile, RuntimeError): valid = False
    elif file_type == 'png': valid = head.startswith(b'\x89PNG\r\n\x1a\n')
    elif file_type in {'jpg', 'jpeg'}: valid = head.startswith(b'\xff\xd8\xff')
    elif file_type == 'webp': valid = len(head) >= 12 and head[:4] == b'RIFF' and head[8:12] == b'WEBP'
    else:
        valid = True
        decoder = codecs.getincrementaldecoder('utf-8')()
        try:
            with open(path, 'rb') as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    if b'\x00' in chunk:
                        valid = False
                        break
                    decoder.decode(chunk)
                if valid:
                    decoder.decode(b'', final=True)
        except (OSError, UnicodeDecodeError):
            valid = False
    if not valid:
        raise CourseValidationError("File content doesn't match its type.")


def _write_upload(file_storage, destination):
    file_storage.seek(0)
    size = 0
    with open(destination, 'xb') as output:
        while True:
            chunk = file_storage.stream.read(1024 * 1024)
            if not chunk: break
            size += len(chunk)
            if size > MAX_FILE_SIZE: raise CourseTooLargeError('File size exceeds 50MB limit.')
            output.write(chunk)
    return size


def _unique_name(conn, user_id, folder_id, name, file_type):
    candidate, suffix = name, 1
    while True:
        if not conn.execute('SELECT 1 FROM course_files WHERE user_id=%s AND folder_id IS NOT DISTINCT FROM %s AND lower(name)=lower(%s) AND file_type=%s', (user_id, folder_id, candidate, file_type)).fetchone():
            return candidate
        marker = f' ({suffix})'
        candidate, suffix = f'{name[:100 - len(marker)]}{marker}', suffix + 1


def create_file(conn, user_id, file_storage, name=None, folder_id=None):
    if not file_storage or not getattr(file_storage, 'filename', None): raise CourseValidationError('No file selected.')
    original = file_storage.filename
    file_type = os.path.splitext(original)[1].lower().lstrip('.')
    if file_type not in ALLOWED_TYPES: raise CourseValidationError('Unsupported file type.')
    clean_name = _clean_name(name if name is not None else os.path.splitext(os.path.basename(original))[0], 100, 'File name')
    _folder(conn, user_id, folder_id)
    directory = _user_dir(user_id)
    storage_key = os.path.join('courses', str(user_id), f'{uuid.uuid4()}.{file_type}')
    final_path = _safe_path(storage_key)
    temporary_path = final_path + '.tmp'
    try:
        size = _write_upload(file_storage, temporary_path)
        _validate_content(temporary_path, file_type)
        os.replace(temporary_path, final_path)
        with _user_lock(user_id):
            if not conn.execute('SELECT id FROM users WHERE id=%s FOR UPDATE', (user_id,)).fetchone():
                raise CourseNotFoundError('User not found.')
            used = conn.execute('SELECT COALESCE(sum(file_size),0) FROM course_files WHERE user_id=%s', (user_id,)).fetchone()[0]
            if used + size > QUOTA_BYTES: raise CourseTooLargeError('Storage limit reached.')
            stored_name = _unique_name(conn, user_id, folder_id, clean_name, file_type)
            row = conn.execute('''INSERT INTO course_files (user_id,folder_id,name,file_type,mime_type,file_size,storage_key,original_filename)
                                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id,user_id,folder_id,name,file_type,mime_type,file_size,storage_key,original_filename,created_at''', (user_id, folder_id, stored_name, file_type, ALLOWED_TYPES[file_type], size, storage_key, original)).fetchone()
            conn.commit()
        return serialize_course_file(row)
    except Exception:
        conn.rollback()
        for path in (temporary_path, final_path):
            try: os.remove(path)
            except OSError: pass
        raise


def update_file(conn, user_id, file_id, name=None, folder_id=None, folder_provided=False):
    row = conn.execute('SELECT id,user_id,folder_id,name,file_type,mime_type,file_size,storage_key,original_filename,created_at FROM course_files WHERE id=%s AND user_id=%s', (file_id, user_id)).fetchone()
    if not row: raise CourseNotFoundError('File not found.')
    new_folder = folder_id if folder_provided else row[2]
    _folder(conn, user_id, new_folder)
    new_name = _clean_name(name, 100, 'File name') if name is not None else row[3]
    if new_name.lower() != row[3].lower() or new_folder != row[2]: new_name = _unique_name(conn, user_id, new_folder, new_name, row[4])
    updated = conn.execute('UPDATE course_files SET name=%s,folder_id=%s WHERE id=%s AND user_id=%s RETURNING id,user_id,folder_id,name,file_type,mime_type,file_size,storage_key,original_filename,created_at', (new_name, new_folder, file_id, user_id)).fetchone()
    conn.commit()
    return serialize_course_file(updated)


def delete_file(conn, user_id, file_id):
    row = conn.execute('DELETE FROM course_files WHERE id=%s AND user_id=%s RETURNING storage_key', (file_id, user_id)).fetchone()
    if not row: raise CourseNotFoundError('File not found.')
    conn.commit()
    try: os.remove(_safe_path(row[0]))
    except (OSError, CourseValidationError): pass
    return None


def get_file(conn, user_id, file_id):
    row = conn.execute('SELECT id,user_id,folder_id,name,file_type,mime_type,file_size,storage_key,original_filename,created_at FROM course_files WHERE id=%s AND user_id=%s', (file_id, user_id)).fetchone()
    if not row: raise CourseNotFoundError('File not found.')
    path = _safe_path(row[7])
    if not os.path.isfile(path): raise CourseNotFoundError('File not found.')
    return row, path


def storage_usage(conn, user_id):
    used = conn.execute('SELECT COALESCE(sum(file_size),0) FROM course_files WHERE user_id=%s', (user_id,)).fetchone()[0]
    return {'used_bytes': used, 'quota_bytes': QUOTA_BYTES, 'max_file_bytes': MAX_FILE_SIZE}
