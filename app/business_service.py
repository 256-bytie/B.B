"""Business profile domain logic: validation, insert, and list queries.

Flask-free (a plain psycopg connection in, plain values out), matching
app/library_service.py and app/wallet.py. The HTTP layer is
app/routes/businesses.py. Validation mirrors the Create Business wizard in
static/js/business-create.js (same limits, same category list) so the
server enforces what the client already promises.
"""
import re

from psycopg.types.json import Jsonb

from app.serializers import serialize_business
from app.upload_utils import delete_if_local

VALID_CATEGORIES = [
    'Food & Drinks', 'Fashion & Clothing', 'Beauty & Personal Care',
    'Electronics & Gadgets', 'Health & Wellness', 'Education & Tutoring',
    'Printing & Stationery', 'Services & Repairs', 'Real Estate', 'Other',
]
DAY_KEYS = ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
SOCIAL_KEYS = ('instagram', 'facebook', 'x', 'tiktok')

MIN_NAME, MAX_NAME = 2, 60
MIN_LOCATION, MAX_LOCATION = 3, 120
MIN_DESCRIPTION, MAX_DESCRIPTION = 10, 500
MAX_SERVICES, MAX_SERVICE_LEN = 12, 40
MAX_PHONE, MAX_EMAIL, MAX_WEBSITE, MAX_SOCIAL = 20, 100, 120, 100

_TIME_RE = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')
_THEME_RE = re.compile(r'^#[0-9a-fA-F]{6}$')
_PHONE_RE = re.compile(r'^[+\d][\d\s()\-]{6,}$')
_EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
_WEBSITE_RE = re.compile(r'^(https?://)?[^\s./]+(\.[^\s./]+)+(/\S*)?$', re.IGNORECASE)

LIST_LIMIT = 50

_COLUMNS = ('id, owner_id, name, category, location, description, '
            'hours, services, contact, social, avatar_image, banner_image, '
            'created_at, theme_color')


class BusinessValidationError(Exception):
    """A 400: bad input. str(err) is the user-facing message."""


class BusinessPermissionError(Exception):
    """A 403: the business exists but belongs to another user."""


class BusinessNotFoundError(Exception):
    """A 404: no business exists with the requested id."""


def _text(value, label, minimum, maximum):
    if value is not None and not isinstance(value, str):
        raise BusinessValidationError(f'{label} is invalid.')
    value = (value or '').strip()
    if len(value) < minimum:
        raise BusinessValidationError(f'Enter your {label}.')
    if len(value) > maximum:
        raise BusinessValidationError(f'{label[0].upper()}{label[1:]} is too long.')
    return value


def _optional_text(value, label, maximum, pattern=None, pattern_message=None):
    if value is None:
        return ''
    if not isinstance(value, str):
        raise BusinessValidationError(f'{label} is invalid.')
    value = value.strip()
    if len(value) > maximum:
        raise BusinessValidationError(f'{label} is too long.')
    if value and pattern is not None and not pattern.match(value):
        raise BusinessValidationError(pattern_message)
    return value


def _clean_hours(hours):
    if not isinstance(hours, dict):
        raise BusinessValidationError('Set your opening hours.')
    cleaned = {}
    any_open = False
    for key in DAY_KEYS:
        day = hours.get(key)
        if not isinstance(day, dict) or not isinstance(day.get('open'), bool):
            raise BusinessValidationError('Set your opening hours.')
        opens, closes = day.get('from'), day.get('to')
        if day['open']:
            if (not isinstance(opens, str) or not isinstance(closes, str)
                    or not _TIME_RE.match(opens) or not _TIME_RE.match(closes)):
                raise BusinessValidationError('Opening hours contain an invalid time.')
            if closes <= opens:
                raise BusinessValidationError('Closing time must be after opening time.')
            any_open = True
        else:
            # Closed days keep whatever times the wizard sent, if valid.
            opens = opens if isinstance(opens, str) and _TIME_RE.match(opens) else '09:00'
            closes = closes if isinstance(closes, str) and _TIME_RE.match(closes) else '17:00'
        cleaned[key] = {'open': day['open'], 'from': opens, 'to': closes}
    if not any_open:
        raise BusinessValidationError('Turn on at least one day you are open.')
    return cleaned


def _clean_services(services):
    if services is None:
        return []
    if not isinstance(services, list):
        raise BusinessValidationError('Services are invalid.')
    if len(services) > MAX_SERVICES:
        raise BusinessValidationError(f'You can add up to {MAX_SERVICES} services.')
    cleaned, seen = [], set()
    for item in services:
        if not isinstance(item, str):
            raise BusinessValidationError('Services are invalid.')
        item = ' '.join(item.split())
        if not item:
            continue
        if len(item) > MAX_SERVICE_LEN:
            raise BusinessValidationError('A service name is too long.')
        if item.lower() in seen:
            continue
        seen.add(item.lower())
        cleaned.append(item)
    return cleaned


def _clean_contact(contact):
    if contact is None:
        contact = {}
    if not isinstance(contact, dict):
        raise BusinessValidationError('Contact information is invalid.')
    return {
        'phone': _optional_text(contact.get('phone'), 'Phone number', MAX_PHONE,
                                _PHONE_RE, 'Enter a valid phone number.'),
        'email': _optional_text(contact.get('email'), 'Email address', MAX_EMAIL,
                                _EMAIL_RE, 'Enter a valid email address.'),
        'website': _optional_text(contact.get('website'), 'Website', MAX_WEBSITE,
                                  _WEBSITE_RE, 'Enter a valid website.'),
    }


def _clean_social(social):
    if social is None:
        social = {}
    if not isinstance(social, dict):
        raise BusinessValidationError('Social media links are invalid.')
    return {key: _optional_text(social.get(key), 'Social media link', MAX_SOCIAL)
            for key in SOCIAL_KEYS}


def create_business(conn, owner_id, data):
    """Validate `data` (the wizard payload, minus documents) and insert a row.

    Returns the serialized business. Raises BusinessValidationError on bad
    input; nothing is written in that case.
    """
    if not isinstance(data, dict):
        raise BusinessValidationError('Invalid request.')

    name = _text(data.get('name'), 'business name', MIN_NAME, MAX_NAME)
    category = data.get('category')
    if category not in VALID_CATEGORIES:
        raise BusinessValidationError('Select a category.')
    location = _text(data.get('location'), 'location', MIN_LOCATION, MAX_LOCATION)
    description = _text(data.get('description'), 'description',
                        MIN_DESCRIPTION, MAX_DESCRIPTION)
    hours = _clean_hours(data.get('hours'))
    services = _clean_services(data.get('services'))
    contact = _clean_contact(data.get('contact'))
    social = _clean_social(data.get('social'))

    cursor = conn.cursor()
    try:
        cursor.execute(
            f'''
            INSERT INTO businesses
            (owner_id, name, category, location, description,
             hours, services, contact, social)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_COLUMNS}
            ''',
            (owner_id, name, category, location, description,
             Jsonb(hours), Jsonb(services), Jsonb(contact), Jsonb(social)),
        )
        row = cursor.fetchone()
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return serialize_business(row)


def list_businesses(conn, owner_id=None):
    """Businesses, newest first, capped at LIST_LIMIT (same cap as the
    Library list). Pass owner_id to restrict to one owner's businesses."""
    query = f'SELECT {_COLUMNS} FROM businesses'
    params = []
    if owner_id is not None:
        query += ' WHERE owner_id = %s'
        params.append(owner_id)
    query += ' ORDER BY id DESC LIMIT %s'
    params.append(LIST_LIMIT)

    cursor = conn.cursor()
    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.rollback()  # end the read transaction before the connection is pooled
    return [serialize_business(row) for row in rows]


def update_business_image(conn, business_id, user_id, kind, file_storage):
    """Validate, save, and replace a business avatar or banner image."""
    from app import user_service

    columns = {'avatar': 'avatar_image', 'banner': 'banner_image'}
    if kind not in columns:
        raise BusinessValidationError('Image kind must be avatar or banner.')

    column = columns[kind]
    cursor = conn.cursor()
    cursor.execute(
        f'SELECT owner_id, {column} FROM businesses WHERE id = %s',
        (business_id,),
    )
    row = cursor.fetchone()
    if not row:
        conn.rollback()
        raise BusinessNotFoundError('Business not found.')
    if row[0] != user_id:
        conn.rollback()
        raise BusinessPermissionError('You can only change images for your own business.')

    try:
        user_service._validate_image_file(file_storage)
    except user_service.UserValidationError as e:
        conn.rollback()
        raise BusinessValidationError(str(e))

    old_url = row[1]
    new_url = user_service._save_upload(file_storage)
    try:
        cursor.execute(
            f'UPDATE businesses SET {column} = %s WHERE id = %s RETURNING {_COLUMNS}',
            (new_url, business_id),
        )
        business = serialize_business(cursor.fetchone())
        conn.commit()
    except Exception:
        conn.rollback()
        delete_if_local(new_url, user_service.UPLOAD_FOLDER)
        raise

    delete_if_local(old_url, user_service.UPLOAD_FOLDER)
    return business


def update_business_theme(conn, business_id, user_id, color):
    """Set (or clear, with color=None) the owner-chosen accent color used on
    this business's cards in Businesses and My Stores."""
    if color is not None:
        if not isinstance(color, str) or not _THEME_RE.match(color.strip()):
            raise BusinessValidationError('Choose a valid theme color.')
        color = color.strip().upper()

    cursor = conn.cursor()
    cursor.execute('SELECT owner_id FROM businesses WHERE id = %s', (business_id,))
    row = cursor.fetchone()
    if not row:
        conn.rollback()
        raise BusinessNotFoundError('Business not found.')
    if row[0] != user_id:
        conn.rollback()
        raise BusinessPermissionError('You can only change the theme of your own business.')

    try:
        cursor.execute(
            f'UPDATE businesses SET theme_color = %s WHERE id = %s RETURNING {_COLUMNS}',
            (color, business_id),
        )
        business = serialize_business(cursor.fetchone())
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return business
