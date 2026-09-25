"""Library file domain logic: validation, storage, and file-record queries.

Deliberately independent of Flask (plain sqlite3 connection in, plain
values out), matching app/wallet.py's shape, so it can be exercised
directly and isn't tangled up with request parsing. The one exception is
accepting a werkzeug-style file object (anything with .filename,
.seek()/.tell(), and .save(path)) for the upload path — that interface
is easy to fake in a test without importing Flask.

See app/routes/library.py for the HTTP layer.
"""
import os
import uuid
from werkzeug.utils import secure_filename

from app.serializers import serialize_library_file

UPLOAD_FOLDER = 'static/uploads'
ALLOWED_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx', 'zip'}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
VALID_CATEGORIES = {'Past Questions', 'Lecture Notes', 'Books', 'Projects', 'Other'}


class LibraryValidationError(Exception):
    """A 400: bad input. str(err) is the user-facing message."""


class LibraryNotFoundError(Exception):
    """A 404: no such file record, or its blob is missing on disk."""


class LibraryAccessDeniedError(Exception):
    """A 403: file isn't approved and the requester doesn't own it."""


def create_file(conn, user_id, title, category, department, course, level, file_storage):
    """Validate, save to disk, and insert a library_files row.

    Returns the serialized file dict (same shape as list_files' entries).
    Raises LibraryValidationError on invalid input.
    """
    title = (title or '').strip()
    category = (category or '').strip()
    department = (department or '').strip()
    course = (course or '').strip()
    level = (level or '').strip()

    if not file_storage or not getattr(file_storage, 'filename', None):
        raise LibraryValidationError('No file selected.')

    if not title:
        raise LibraryValidationError('Title is required.')

    if category not in VALID_CATEGORIES:
        raise LibraryValidationError('Invalid category.')

    filename_lower = file_storage.filename.lower()
    if not any(filename_lower.endswith(f'.{ext}') for ext in ALLOWED_EXTENSIONS):
        raise LibraryValidationError('Unsupported file type.')

    file_ext_with_dot = os.path.splitext(secure_filename(file_storage.filename))[1].lower()
    file_type = file_ext_with_dot[1:]

    file_storage.seek(0, os.SEEK_END)
    file_size = file_storage.tell()
    file_storage.seek(0)

    if file_size > MAX_FILE_SIZE:
        raise LibraryValidationError('File size exceeds 50MB limit.')

    unique_filename = f"{uuid.uuid4()}{file_ext_with_dot}"
    file_path_on_disk = os.path.join(UPLOAD_FOLDER, unique_filename)
    file_url = f"/static/uploads/{unique_filename}"

    file_storage.save(file_path_on_disk)

    try:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO library_files
            (user_id, title, category, department, course, level, file_path, file_type, file_size, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')
        ''', (
            user_id, title, category,
            department or None, course or None, level or None,
            file_url, file_type, file_size,
        ))
        file_id = cursor.lastrowid
        conn.commit()

        cursor.execute('''
            SELECT library_files.id, library_files.user_id, library_files.title,
                   library_files.category, library_files.department, library_files.course,
                   library_files.level, library_files.file_path, library_files.file_type,
                   library_files.file_size, library_files.status, library_files.download_count,
                   library_files.created_at, users.full_name
            FROM library_files
            JOIN users ON library_files.user_id = users.id
            WHERE library_files.id = ?
        ''', (file_id,))
        row = cursor.fetchone()
    except Exception:
        # DB insert failed after the file was already written to disk -
        # don't leave an orphaned upload behind.
        if os.path.exists(file_path_on_disk):
            try:
                os.remove(file_path_on_disk)
            except OSError:
                pass
        raise

    return serialize_library_file(row[:13], uploader_name=row[13])


def list_files(conn, current_user_id, search='', category='', department=''):
    """Approved files, plus the current user's own pending/rejected ones.
    Newest first, capped at 50."""
    query = '''
        SELECT library_files.id, library_files.user_id, library_files.title,
               library_files.category, library_files.department, library_files.course,
               library_files.level, library_files.file_path, library_files.file_type,
               library_files.file_size, library_files.status, library_files.download_count,
               library_files.created_at, users.full_name
        FROM library_files
        JOIN users ON library_files.user_id = users.id
        WHERE (library_files.status = 'approved' OR library_files.user_id = ?)
    '''
    params = [current_user_id]

    search = (search or '').strip()
    if search:
        query += ' AND (library_files.title LIKE ? OR library_files.course LIKE ?)'
        pattern = f'%{search}%'
        params.extend([pattern, pattern])

    category = (category or '').strip()
    if category:
        query += ' AND library_files.category = ?'
        params.append(category)

    department = (department or '').strip()
    if department:
        query += ' AND library_files.department = ?'
        params.append(department)

    query += ' ORDER BY library_files.created_at DESC LIMIT 50'

    cursor = conn.cursor()
    cursor.execute(query, params)
    rows = cursor.fetchall()

    return [serialize_library_file(row[:13], uploader_name=row[13]) for row in rows]


def list_departments(conn):
    """Approved-file department counts, most files first."""
    cursor = conn.cursor()
    cursor.execute('''
        SELECT department, COUNT(*) as count
        FROM library_files
        WHERE status = 'approved'
          AND department IS NOT NULL
          AND department != ''
        GROUP BY department
        ORDER BY count DESC
    ''')
    return [{'name': name, 'count': count} for name, count in cursor.fetchall()]


def prepare_download(conn, requesting_user_id, file_id):
    """Look up a file for download, enforcing access control and
    best-effort incrementing its download count.

    Returns (stored_filename, download_name). Raises LibraryNotFoundError
    if the record or its on-disk blob doesn't exist, or
    LibraryAccessDeniedError if it's unapproved and the requester doesn't
    own it.
    """
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, user_id, title, category, department, course, level,
               file_path, file_type, file_size, status, download_count, created_at
        FROM library_files
        WHERE id = ?
    ''', (file_id,))
    row = cursor.fetchone()

    if not row:
        raise LibraryNotFoundError('File not found.')

    file_record = serialize_library_file(row)

    if file_record['status'] != 'approved' and file_record['uploader_id'] != requesting_user_id:
        raise LibraryAccessDeniedError('You do not have access to this document.')

    stored_filename = row[7].split('/')[-1]
    full_path = os.path.join(UPLOAD_FOLDER, stored_filename)
    if not os.path.exists(full_path):
        raise LibraryNotFoundError('File not found.')

    try:
        cursor.execute('''
            UPDATE library_files
            SET download_count = download_count + 1
            WHERE id = ?
        ''', (file_id,))
        conn.commit()
    except Exception:
        pass  # don't fail the download if the count update fails

    safe_title = "".join(c for c in file_record['title'] if c.isalnum() or c in (' ', '-', '_')).strip()
    if not safe_title:
        safe_title = "document"
    safe_title = safe_title[:100]
    download_name = f"{safe_title}.{file_record['file_type']}"

    return stored_filename, download_name
