"""Library file storage, upload, search, and download HTTP layer.

Validation, storage, and querying live in app/library_service.py; this
file only translates between HTTP (request parsing, status codes) and
that service.
"""
from flask import Blueprint, request, jsonify, session, send_from_directory
from app import library_service as lib
from app.db import get_db

bp = Blueprint('library', __name__)


@bp.route('/api/library/files', methods=['POST'])
def upload_file():
    """Upload a library file with metadata"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    file_storage = request.files.get('file')

    conn = get_db()
    try:
        file_data = lib.create_file(
            conn,
            user_id=session['user_id'],
            title=request.form.get('title'),
            category=request.form.get('category'),
            department=request.form.get('department'),
            course=request.form.get('course'),
            level=request.form.get('level'),
            file_storage=file_storage,
        )
        return jsonify({'file': file_data}), 201
    except lib.LibraryValidationError as e:
        return jsonify({'error': str(e)}), 400
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/library/files', methods=['GET'])
def get_files():
    """Get filtered list of library files"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    conn = get_db()
    try:
        files = lib.list_files(
            conn,
            current_user_id=session['user_id'],
            search=request.args.get('search', ''),
            category=request.args.get('category', ''),
            department=request.args.get('department', ''),
        )
        return jsonify({'files': files}), 200
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/library/departments', methods=['GET'])
def get_departments():
    """Get list of departments with file counts"""
    conn = get_db()
    try:
        return jsonify({'departments': lib.list_departments(conn)}), 200
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()


@bp.route('/api/library/files/<int:file_id>/download', methods=['GET'])
def download_file(file_id):
    """Download a library file with access control"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    conn = get_db()
    try:
        stored_filename, download_name = lib.prepare_download(
            conn, session['user_id'], file_id
        )
        return send_from_directory(
            lib.UPLOAD_FOLDER,
            stored_filename,
            as_attachment=True,
            download_name=download_name,
        )
    except lib.LibraryNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except lib.LibraryAccessDeniedError as e:
        return jsonify({'error': str(e)}), 403
    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500
    finally:
        conn.close()
