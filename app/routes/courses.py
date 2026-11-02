"""HTTP routes for private personal Courses folders and files."""
from flask import Blueprint, jsonify, request, send_file, session
from psycopg_pool import PoolTimeout

from app import course_service as courses
from app.db import get_db


bp = Blueprint('courses', __name__)


def _auth_error():
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    return None


def _json_body():
    body = request.get_json(silent=True)
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise courses.CourseValidationError('JSON object required.')
    return body


def _optional_id(value, label):
    if value in (None, ''):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise courses.CourseValidationError(f'{label} is invalid.')
    if parsed <= 0:
        raise courses.CourseValidationError(f'{label} is invalid.')
    return parsed


def _service_error(error):
    if isinstance(error, courses.CourseNotFoundError):
        return jsonify({'error': str(error)}), 404
    if isinstance(error, courses.CourseConflictError):
        return jsonify({'error': str(error)}), 409
    if isinstance(error, courses.CourseTooLargeError):
        return jsonify({'error': str(error)}), 413
    return jsonify({'error': str(error)}), 400


@bp.route('/api/courses/items', methods=['GET'])
def get_items():
    auth = _auth_error()
    if auth:
        return auth
    conn = get_db()
    try:
        folder_id = _optional_id(request.args.get('folder_id'), 'Folder')
        return jsonify(courses.list_items(conn, session['user_id'], folder_id))
    except (courses.CourseValidationError, courses.CourseNotFoundError) as error:
        return _service_error(error)
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/courses/folders', methods=['POST'])
def create_folder():
    auth = _auth_error()
    if auth:
        return auth
    body = _json_body()
    conn = get_db()
    try:
        parent_id = _optional_id(body.get('parent_id'), 'Parent folder')
        folder = courses.create_folder(conn, session['user_id'], body.get('name'), parent_id)
        return jsonify({'folder': folder}), 201
    except (courses.CourseValidationError, courses.CourseNotFoundError,
            courses.CourseConflictError) as error:
        return _service_error(error)
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/courses/folders/<int:folder_id>', methods=['PATCH'])
def update_folder(folder_id):
    auth = _auth_error()
    if auth:
        return auth
    body = _json_body()
    conn = get_db()
    try:
        if 'name' in body and not isinstance(body['name'], str):
            raise courses.CourseValidationError('Folder name is invalid.')
        if not any(key in body for key in ('name', 'parent_id')):
            raise courses.CourseValidationError('No changes provided.')
        parent_id = _optional_id(body.get('parent_id'), 'Parent folder')
        folder = courses.update_folder(
            conn, session['user_id'], folder_id, name=body.get('name'),
            parent_id=parent_id, parent_provided='parent_id' in body,
        )
        return jsonify({'folder': folder})
    except (courses.CourseValidationError, courses.CourseNotFoundError,
            courses.CourseConflictError) as error:
        return _service_error(error)
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/courses/folders/<int:folder_id>', methods=['DELETE'])
def delete_folder(folder_id):
    auth = _auth_error()
    if auth:
        return auth
    conn = get_db()
    try:
        return jsonify({'deleted': courses.delete_folder(conn, session['user_id'], folder_id)})
    except courses.CourseNotFoundError as error:
        return _service_error(error)
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/courses/files', methods=['POST'])
def create_file():
    auth = _auth_error()
    if auth:
        return auth
    conn = get_db()
    try:
        folder_id = _optional_id(request.form.get('folder_id'), 'Folder')
        file_data = courses.create_file(
            conn, session['user_id'], request.files.get('file'),
            name=request.form.get('name'), folder_id=folder_id,
        )
        return jsonify({'file': file_data}), 201
    except (courses.CourseValidationError, courses.CourseNotFoundError,
            courses.CourseTooLargeError) as error:
        return _service_error(error)
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/courses/files/<int:file_id>', methods=['PATCH'])
def update_file(file_id):
    auth = _auth_error()
    if auth:
        return auth
    body = _json_body()
    conn = get_db()
    try:
        if 'name' in body and not isinstance(body['name'], str):
            raise courses.CourseValidationError('File name is invalid.')
        if not any(key in body for key in ('name', 'folder_id')):
            raise courses.CourseValidationError('No changes provided.')
        folder_id = _optional_id(body.get('folder_id'), 'Folder')
        file_data = courses.update_file(
            conn, session['user_id'], file_id, name=body.get('name'),
            folder_id=folder_id, folder_provided='folder_id' in body,
        )
        return jsonify({'file': file_data})
    except (courses.CourseValidationError, courses.CourseNotFoundError) as error:
        return _service_error(error)
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/courses/files/<int:file_id>', methods=['DELETE'])
def delete_file(file_id):
    auth = _auth_error()
    if auth:
        return auth
    conn = get_db()
    try:
        courses.delete_file(conn, session['user_id'], file_id)
        return '', 204
    except courses.CourseNotFoundError as error:
        return _service_error(error)
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/courses/files/<int:file_id>/download', methods=['GET'])
def download_file(file_id):
    auth = _auth_error()
    if auth:
        return auth
    conn = get_db()
    try:
        row, path = courses.get_file(conn, session['user_id'], file_id)
        inline = request.args.get('inline') == '1' and row[4] in courses.INLINE_TYPES
        response = send_file(
            path, mimetype=courses.ALLOWED_TYPES[row[4]], as_attachment=not inline,
            download_name=f'{row[3]}.{row[4]}', conditional=True,
        )
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Cache-Control'] = 'private, no-store'
        return response
    except courses.CourseNotFoundError as error:
        return _service_error(error)
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/courses/storage', methods=['GET'])
def storage():
    auth = _auth_error()
    if auth:
        return auth
    conn = get_db()
    try:
        return jsonify(courses.storage_usage(conn, session['user_id']))
    except PoolTimeout:
        raise
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()
