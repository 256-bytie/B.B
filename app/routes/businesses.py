"""Business profile HTTP layer: create, list, image uploads, and card theme.

Validation and queries live in app/business_service.py; this file only
translates between HTTP (request parsing, status codes) and that service.
"""
from flask import Blueprint, request, jsonify, session
from app import business_service as biz
from app.db import get_db
from psycopg_pool import PoolTimeout


bp = Blueprint('businesses', __name__)


def _json(payload, status=200):
    """JSON response that browsers must not cache: a newly created business
    has to appear in the list on the very next fetch."""
    response = jsonify(payload)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


@bp.route('/api/businesses', methods=['POST'])
def create_business():
    """Create a business profile owned by the current user."""
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    data = request.get_json(silent=True)

    conn = get_db()
    try:
        business = biz.create_business(conn, session['user_id'], data)
        return _json({'business': business}, 201)
    except biz.BusinessValidationError as e:
        return _json({'error': str(e)}, 400)
    except PoolTimeout:
        raise
    except Exception:
        return _json({'error': 'Something went wrong. Please try again.'}, 500)
    finally:
        conn.close()


@bp.route('/api/businesses', methods=['GET'])
def get_businesses():
    """List businesses, newest first. `?mine=1` restricts to the current
    user's own businesses."""
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    owner_id = session['user_id'] if request.args.get('mine') == '1' else None

    conn = get_db()
    try:
        return _json({'businesses': biz.list_businesses(conn, owner_id)})
    except PoolTimeout:
        raise
    except Exception:
        return _json({'error': 'Something went wrong. Please try again.'}, 500)
    finally:
        conn.close()


@bp.route('/api/businesses/<int:business_id>/image', methods=['POST'])
def update_business_image(business_id):
    """Replace an owner-controlled business avatar or banner."""
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    conn = get_db()
    try:
        business = biz.update_business_image(
            conn,
            business_id,
            session['user_id'],
            request.form.get('kind'),
            request.files.get('file'),
        )
        return _json({'business': business})
    except biz.BusinessValidationError as e:
        return _json({'error': str(e)}, 400)
    except biz.BusinessPermissionError as e:
        return _json({'error': str(e)}, 403)
    except biz.BusinessNotFoundError as e:
        return _json({'error': str(e)}, 404)
    except PoolTimeout:
        raise
    except Exception:
        return _json({'error': 'Something went wrong. Please try again.'}, 500)
    finally:
        conn.close()


@bp.route('/api/businesses/<int:business_id>/theme', methods=['POST'])
def update_business_theme(business_id):
    """Set or clear (color: null) the accent color of an owned business's cards."""
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or 'color' not in data:
        return _json({'error': 'Invalid request.'}, 400)

    conn = get_db()
    try:
        business = biz.update_business_theme(conn, business_id, session['user_id'], data['color'])
        return _json({'business': business})
    except biz.BusinessValidationError as e:
        return _json({'error': str(e)}, 400)
    except biz.BusinessPermissionError as e:
        return _json({'error': str(e)}, 403)
    except biz.BusinessNotFoundError as e:
        return _json({'error': str(e)}, 404)
    except PoolTimeout:
        raise
    except Exception:
        return _json({'error': 'Something went wrong. Please try again.'}, 500)
    finally:
        conn.close()
