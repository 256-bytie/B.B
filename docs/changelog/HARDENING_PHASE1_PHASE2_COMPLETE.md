# Beebo Backend Hardening - Phase 1 & 2 Complete

## Overview
Successfully completed Phase 1 (hardening) and Phase 2 (server-side sessions) migration for the Beebo backend. **All changes are backend-internal only** - the existing beebo.html frontend continues to work without any modifications.

## Phase 1: Hardening Changes

### 1. Security Configuration
- **Changed `app.run()`**: Set `debug=False` (was `True`)
- **Changed host binding**: Set `host='127.0.0.1'` (was `'0.0.0.0'`)
  - Now only accepts local connections by default
  - For deployment, use a proper WSGI server (gunicorn, uwsgi) with reverse proxy

### 2. Dependencies Management
- **Created `requirements.txt`** with pinned versions:
  - Flask==3.0.2
  - flask-cors==6.0.5
  - Flask-Session==0.8.0
  - Werkzeug==3.0.1

### 3. Git Configuration
- **Created `.gitignore`** excluding:
  - `beebo.db` (database)
  - `.flask_secret_key` (secret key)
  - `static/uploads/*` (uploaded files, folder tracked via `.gitkeep`)
  - `flask_session/` (server-side session storage)
  - Python cache files

### 4. Database Indexes
Added performance indexes (all created with `IF NOT EXISTS` for safety):

**posts table:**
- `idx_posts_user_id` on `user_id`
- `idx_posts_created_at` on `created_at`

**comments table:**
- `idx_comments_post_id` on `post_id`

**likes table:**
- `idx_likes_target` on `(target_type, target_id)`
- `idx_likes_user_id` on `user_id`

These indexes optimize common queries (user's posts, recent posts, post comments, like lookups).

### 5. Upload Size Limit
- **Set `MAX_CONTENT_LENGTH`**: 30MB limit on request body size
- Prevents memory exhaustion from oversized uploads
- Rejects requests before buffering into memory

## Phase 2: Server-Side Sessions

### Architecture Change
**Before:** Session cookie contained all user profile data (email, full_name, profile_picture, cover_image, username, bio)

**After:** Session cookie contains only a session ID; server-side storage holds only:
- `user_id` (integer)
- `accounts` (list of authenticated user IDs for account switching)

All profile data is now fetched from the database on each request.

### Implementation Details

#### 1. Flask-Session Configuration
```python
app.config['SESSION_TYPE'] = 'filesystem'
app.config['SESSION_FILE_DIR'] = './flask_session'
app.config['SESSION_PERMANENT'] = False
app.config['SESSION_USE_SIGNER'] = True
Session(app)
```

#### 2. Session Writes (Modified)
Updated routes to store only `user_id` and `accounts`:

- **`/api/signup`** (lines 258-264): Now sets only `session['user_id']` and `session['accounts']`
- **`/api/login`** (lines 323-328): Same
- **`/api/session/switch`** (lines 451-453): Same
- **`/api/profile/picture`** (line 660): Removed `session['profile_picture']` update
- **`/api/profile/cover`** (line 717): Removed `session['cover_image']` update
- **`/api/profile`** (lines 786-789): Removed session updates for `full_name`, `username`, `bio`

#### 3. Session Reads (Redirected to DB)
Updated routes to query database instead of reading from session:

- **`/api/session`** (lines 358-405): Now queries DB for current user data
  - Fetches: `id, full_name, email, profile_picture, cover_image, username, bio`
  - Handles deleted users gracefully (clears session, returns logged_out)
  - Still re-hydrates accounts list from DB for account switcher

### API Response Compatibility
**Verified:** All API endpoints return the exact same JSON structure as before:

- **`/api/signup`**: Returns `{success: true, user: {...}}` with all profile fields
- **`/api/login`**: Returns `{success: true, user: {...}}` with all profile fields
- **`/api/session`**: Returns `{logged_in: true, user: {...}, accounts: [...]}` with all fields
- **`/api/session/switch`**: Returns `{success: true, user: {...}}` with all profile fields
- **`/api/profile`**: Returns `{success: true, full_name, username, bio}`
- **`/api/profile/picture`**: Returns `{success: true, profile_picture}`
- **`/api/profile/cover`**: Returns `{success: true, cover_image}`

### Benefits

1. **Profile updates reflect immediately** without requiring re-login
   - Frontend shows updated name/username/bio on next request
   - No stale session data

2. **Smaller session cookies**
   - Session ID only (vs. full profile data)
   - Reduces bandwidth and cookie size limits

3. **Single source of truth**
   - Profile data always comes from database
   - No sync issues between session and DB

4. **Better security**
   - Profile data not in client-accessible cookie
   - Server-side session storage

## Testing

### Verification Results
Ran comprehensive test covering:

1. ✓ **Signup flow** - Creates user, returns all fields
2. ✓ **Session endpoint** - Returns full user data from DB
3. ✓ **Profile update** - Updates name, username, bio
4. ✓ **Immediate reflection** - Changes visible without re-login
5. ✓ **Login flow** - Returns updated profile data
6. ✓ **Account switching** - Multi-account list still works

### Tested Scenarios
- New user signup
- Login with existing user
- Profile updates (name, username, bio)
- Profile picture upload (session no longer updated)
- Cover image upload (session no longer updated)
- Account switching between multiple accounts
- Session persistence across requests

All tests passed. Frontend compatibility confirmed.

## Files Changed

### New Files
- `requirements.txt` - Pinned dependencies
- `.gitignore` - Git exclusions
- `static/uploads/.gitkeep` - Tracks empty upload folder

### Modified Files
- `app.py` - All Phase 1 & 2 changes

## Migration Notes

### For Existing Installations
1. **Install Flask-Session**: `pip install Flask-Session==0.8.0`
2. **Run the app once** to create indexes: `python3 app.py` (then Ctrl+C)
3. **Existing sessions will break** - users must re-login once
   - Old sessions have `email`, `full_name`, etc. but no DB lookup logic
   - After re-login, new session format is used

### For Production Deployment
1. Use a WSGI server (gunicorn, uwsgi) instead of Flask dev server
2. Set `host='0.0.0.0'` in production config if needed for reverse proxy
3. Consider Redis-backed sessions for multi-server deployments
   - Change `SESSION_TYPE` to `'redis'` and configure connection

## Session Reads Audit

Searched entire codebase for `session['` reads - all redirected to DB queries:

- `session['user_id']` - Still used (required for authentication)
- `session['accounts']` - Still used (required for account switching)
- `session['email']` - ❌ Removed, now from DB
- `session['full_name']` - ❌ Removed, now from DB
- `session['profile_picture']` - ❌ Removed, now from DB
- `session['cover_image']` - ❌ Removed, now from DB
- `session['username']` - ❌ Removed, now from DB
- `session['bio']` - ❌ Removed, now from DB

No endpoints read profile fields from session anymore - all read from DB.

## Conclusion

✓ Phase 1 hardening complete - debug off, indexes added, upload limits set, dependencies pinned

✓ Phase 2 server-side sessions complete - minimal session data, DB-backed profile queries

✓ Frontend compatibility preserved - beebo.html requires no changes

✓ All functionality tested and working - signup, login, profile updates, account switching

The backend is now more secure, more performant, and maintains a single source of truth for user data.
