"""Authentication routes: signup, login, logout, session management."""
import secrets
import time
from flask import Blueprint, request, jsonify, session
from werkzeug.security import generate_password_hash, check_password_hash
from app.db import get_db

bp = Blueprint('auth', __name__)

# Login rate limiting: max 5 failed attempts per email+IP per 15 minutes
LOGIN_RATE_LIMIT_MAX = 5
LOGIN_RATE_LIMIT_WINDOW = 15 * 60  # 15 minutes in seconds
login_rate_limiter = {}  # {(email, ip): [timestamp1, timestamp2, ...]}


def _generate_csrf_token():
    """Generate a new CSRF token."""
    return secrets.token_hex(32)


def _ensure_csrf_token():
    """Ensure the session has a CSRF token, generating one if needed."""
    if 'csrf_token' not in session:
        session['csrf_token'] = _generate_csrf_token()
    return session['csrf_token']


def _rotate_csrf_token():
    """Generate a new CSRF token, replacing the old one."""
    session['csrf_token'] = _generate_csrf_token()
    return session['csrf_token']


@bp.route('/api/signup', methods=['POST'])
def signup():
    """Handle user registration"""
    data = request.get_json()

    # Validate required fields
    full_name = data.get('full_name', '').strip()
    email = data.get('email', '').strip().lower()
    password = data.get('password', '')

    if not full_name or not email or not password:
        return jsonify({'error': 'All fields are required'}), 400

    # Basic email validation
    if '@' not in email or '.' not in email:
        return jsonify({'error': 'Invalid email address'}), 400

    # Check password length
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Check if email already exists
        cursor.execute('SELECT id FROM users WHERE email = ?', (email,))
        if cursor.fetchone():
            conn.close()
            return jsonify({'error': 'Email already registered'}), 409

        # Hash password and insert user
        password_hash = generate_password_hash(password)

        # Generate username from email prefix
        base_username = email.split('@')[0]
        username = base_username

        # Check if username is taken (case-insensitive)
        cursor.execute('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', (username,))
        if cursor.fetchone():
            # If taken, we'll append a unique suffix after getting the user_id
            # First insert without username
            cursor.execute(
                'INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)',
                (full_name, email, password_hash)
            )
            user_id = cursor.lastrowid
            username = f"{base_username}{user_id}"
            cursor.execute('UPDATE users SET username = ? WHERE id = ?', (username, user_id))
        else:
            cursor.execute(
                'INSERT INTO users (full_name, email, password_hash, username) VALUES (?, ?, ?, ?)',
                (full_name, email, password_hash, username)
            )
            user_id = cursor.lastrowid

        conn.commit()
        conn.close()

        # Set session. `accounts` tracks every user_id that has successfully
        # authenticated in this browser session (via signup or login) so the
        # account switcher can offer instant switching between them without
        # re-entering a password - it's additive, never overwritten, so
        # signing up a second account here doesn't drop the first one.
        accounts = session.get('accounts', [])
        if user_id not in accounts:
            accounts.append(user_id)
        session['accounts'] = accounts
        session['user_id'] = user_id

        # Rotate CSRF token on signup (identity change)
        new_csrf_token = _rotate_csrf_token()

        return jsonify({
            'success': True,
            'csrf_token': new_csrf_token,
            'user': {
                'id': user_id,
                'email': email,
                'full_name': full_name,
                'profile_picture': None,
                'cover_image': None,
                'username': username,
                'bio': None
            }
        }), 201

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/login', methods=['POST'])
def login():
    """Handle user login"""
    data = request.get_json()

    email = data.get('email', '').strip().lower()
    password = data.get('password', '')

    if not email or not password:
        return jsonify({'error': 'Email and password are required'}), 400

    # Rate limiting setup: track by email+IP combination
    client_ip = request.remote_addr
    rate_key = (email, client_ip)
    now = time.time()

    if rate_key not in login_rate_limiter:
        login_rate_limiter[rate_key] = []

    # Remove timestamps outside the sliding window
    login_rate_limiter[rate_key] = [
        ts for ts in login_rate_limiter[rate_key]
        if now - ts < LOGIN_RATE_LIMIT_WINDOW
    ]

    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            'SELECT id, full_name, email, password_hash, profile_picture, cover_image, username, bio FROM users WHERE email = ?',
            (email,)
        )
        user = cursor.fetchone()

        if not user:
            conn.close()
            # Failed attempt: check rate limit before recording
            if len(login_rate_limiter[rate_key]) >= LOGIN_RATE_LIMIT_MAX:
                return jsonify({'error': 'Too many login attempts. Please try again later.'}), 429
            login_rate_limiter[rate_key].append(now)
            return jsonify({'error': 'Invalid email or password'}), 401

        user_id, full_name, user_email, password_hash, profile_picture, cover_image, username, bio = user

        # Verify password
        if not check_password_hash(password_hash, password):
            conn.close()
            # Failed attempt: check rate limit before recording
            if len(login_rate_limiter[rate_key]) >= LOGIN_RATE_LIMIT_MAX:
                return jsonify({'error': 'Too many login attempts. Please try again later.'}), 429
            login_rate_limiter[rate_key].append(now)
            return jsonify({'error': 'Invalid email or password'}), 401

        # Successful login - clear rate limit for this key
        if rate_key in login_rate_limiter:
            del login_rate_limiter[rate_key]

        # Set session. See the matching comment in signup() - this appends
        # to the same browser session's authenticated-accounts list rather
        # than replacing it, which is what lets "Add Account" log in a
        # second account without signing the first one out.
        accounts = session.get('accounts', [])
        if user_id not in accounts:
            accounts.append(user_id)
        session['accounts'] = accounts
        session['user_id'] = user_id

        # Rotate CSRF token on login (identity change)
        new_csrf_token = _rotate_csrf_token()

        return jsonify({
            'success': True,
            'csrf_token': new_csrf_token,
            'user': {
                'id': user_id,
                'email': user_email,
                'full_name': full_name,
                'profile_picture': profile_picture,
                'cover_image': cover_image,
                'username': username,
                'bio': bio
            }
        }), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/logout', methods=['POST'])
def logout():
    """Handle user logout"""
    session.clear()
    return jsonify({'success': True}), 200


@bp.route('/api/session', methods=['GET'])
def get_session():
    """Check if user is logged in. Also returns the account switcher's
    list of accounts: every user_id that has authenticated (via signup or
    login) in this browser session, re-hydrated from the users table on
    every call so it reflects current names/avatars rather than whatever
    was true at login time."""
    # Ensure CSRF token exists for this session (both logged in and logged out)
    csrf_token = _ensure_csrf_token()

    if 'user_id' not in session:
        return jsonify({'logged_in': False, 'csrf_token': csrf_token}), 200

    conn = get_db()
    cursor = conn.cursor()

    # Fetch current user data from DB
    cursor.execute(
        'SELECT id, full_name, email, profile_picture, cover_image, username, bio FROM users WHERE id = ?',
        (session['user_id'],)
    )
    current_user_row = cursor.fetchone()

    if not current_user_row:
        # User was deleted - clear session
        conn.close()
        session.clear()
        # Regenerate token after clearing session
        csrf_token = _ensure_csrf_token()
        return jsonify({'logged_in': False, 'csrf_token': csrf_token}), 200

    user_id, full_name, email, profile_picture, cover_image, username, bio = current_user_row

    # Build accounts list
    account_ids = session.get('accounts', [])
    if user_id not in account_ids:
        account_ids = account_ids + [user_id]

    accounts = []
    for account_id in account_ids:
        cursor.execute(
            'SELECT id, full_name, email, profile_picture, username FROM users WHERE id = ?',
            (account_id,)
        )
        row = cursor.fetchone()
        if row:
            row_id, row_full_name, row_email, row_profile_picture, row_username = row
            accounts.append({
                'id': row_id,
                'full_name': row_full_name,
                # Bug fix: this used to read the email's local-part
                # (row_email.split('@')[0]) unconditionally, ignoring the
                # username column entirely - so an edited username never
                # showed up here regardless of how fresh the fetch was.
                # Matches the same fallback convention used everywhere else
                # (see session.user.username || session.user.email.split('@')[0]
                # in profile-own.js) so a user who never set a custom
                # username still gets the same default they'd see elsewhere.
                'handle': row_username or row_email.split('@')[0],
                'profile_picture': row_profile_picture,
                'username': row_username
            })
    conn.close()

    return jsonify({
        'logged_in': True,
        'csrf_token': csrf_token,
        'user': {
            'id': user_id,
            'email': email,
            'full_name': full_name,
            'profile_picture': profile_picture,
            'cover_image': cover_image,
            'username': username,
            'bio': bio
        },
        'accounts': accounts
    }), 200


@bp.route('/api/session/switch', methods=['POST'])
def switch_account():
    """Switch the active account to one that has already authenticated in
    this browser session (via a prior /api/login or /api/signup call this
    session). This deliberately never accepts or checks a password - it
    only changes which already-verified identity is active, the same way
    established apps let you tap between accounts you've previously signed
    into on that device. Attempting to switch to any id not already present
    in this session's `accounts` list is rejected, so this can't be used
    as a side-door into someone else's account."""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    data = request.get_json() or {}
    target_id = data.get('user_id')
    try:
        target_id = int(target_id)
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid user_id'}), 400

    accounts = session.get('accounts', [])
    if session['user_id'] not in accounts:
        accounts = accounts + [session['user_id']]

    if target_id not in accounts:
        return jsonify({'error': 'That account is not signed in on this device'}), 403

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        'SELECT id, full_name, email, profile_picture, cover_image, username, bio FROM users WHERE id = ?',
        (target_id,)
    )
    row = cursor.fetchone()
    conn.close()

    if row is None:
        # Account existed when it was added to this session but has since
        # been deleted - drop it from the list rather than switching to it.
        session['accounts'] = [a for a in accounts if a != target_id]
        return jsonify({'error': 'Account no longer exists'}), 404

    user_id, full_name, email, profile_picture, cover_image, username, bio = row
    session['accounts'] = accounts
    session['user_id'] = user_id

    # Rotate CSRF token on account switch (identity change)
    new_csrf_token = _rotate_csrf_token()

    return jsonify({
        'success': True,
        'csrf_token': new_csrf_token,
        'user': {
            'id': user_id,
            'email': email,
            'full_name': full_name,
            'profile_picture': profile_picture,
            'cover_image': cover_image,
            'username': username,
            'bio': bio
        }
    }), 200
