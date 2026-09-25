# Phase 3 Cleanup: Complete

## Changes Made

### Issue 1: Removed Dead Code in create_comment()
**File:** `app/routes/posts.py`

**Before (lines 303-322):** Dead serializer call followed by manual dict building
```python
# Manually append liked_by_user=False since this is a new comment
row_with_liked = row + (0,)
comment = serialize_comment(row_with_liked, False)
# Remove the liked_by_user key added by serialize_comment and re-add without it in response
# Actually, we need to keep it - let me check the original
# Original code returned it without liked_by_user, so we need to manually build it
comment_id, post_id, content, created_at, like_count, full_name, email, profile_picture, username, bio = row
handle = email.split('@')[0]
comment = {
    'id': comment_id,
    'post_id': post_id,
    'author_name': full_name,
    'author_handle': handle,
    'author_avatar': profile_picture,
    'username': username,
    'bio': bio,
    'content': content,
    'created_at': created_at,
    'like_count': like_count
}
```

**After (lines 303-304):** Clean single call to serializer
```python
comment = serialize_comment(row)
return jsonify(comment), 201
```

**Implementation:** Modified `serialize_comment()` in `app/serializers.py` to:
- Accept `liked_by_user=None` as optional parameter
- Detect row length (10 vs 11 elements) to handle both create_comment (10) and get_comments (11)
- Omit `liked_by_user` key from output dict when None
- Include `liked_by_user` as boolean when provided

**Verification:** 
- ✓ POST /api/posts/<id>/comments response has 10 keys, NO `liked_by_user`
- ✓ GET /api/posts/<id>/comments response has 11 keys, includes `liked_by_user: false`

### Issue 2: Use serialize_user_public() in get_user_public_profile()
**File:** `app/routes/users.py`

**Before (lines 84-97):** Manual dict building with duplicated fields
```python
user_id_val, full_name, email, profile_picture, cover_image, username, bio = row
return jsonify({
    'id': user_id_val,
    'full_name': full_name,
    'handle': email.split('@')[0],
    'profile_picture': profile_picture,
    'cover_image': cover_image,
    'username': username,
    'bio': bio,
    'post_count': post_count,
    'follower_count': follower_count,
    'following_count': following_count,
    'is_following': is_following
}), 200
```

**After (lines 84-91):** Use serializer for shared fields, extend with route-specific fields
```python
# Build response using serializer for shared fields, then add route-specific fields
profile = serialize_user_public(row)
profile.update({
    'post_count': post_count,
    'follower_count': follower_count,
    'following_count': following_count,
    'is_following': is_following
})
return jsonify(profile), 200
```

**Verification:**
- ✓ GET /api/users/<id> response has all 11 expected keys in correct structure

## Verification Results

### Step 1: Manual curl checks ✓
Both endpoints return byte-for-byte identical JSON structure:

**POST /api/posts/1/comments:**
```json
{
    "id": 1,
    "post_id": 1,
    "author_name": "Verify User",
    "author_handle": "verify",
    "author_avatar": null,
    "username": "verify",
    "bio": null,
    "content": "Test comment",
    "created_at": "2026-08-25 08:28:19",
    "like_count": 0
}
```
✓ 10 keys, NO `liked_by_user` (correct for create)

**GET /api/posts/1/comments:**
```json
[{
    "id": 1,
    "post_id": 1,
    "author_name": "Verify User",
    "author_handle": "verify",
    "author_avatar": null,
    "username": "verify",
    "bio": null,
    "content": "Test comment",
    "created_at": "2026-08-25 08:28:19",
    "like_count": 0,
    "liked_by_user": false
}]
```
✓ 11 keys, includes `liked_by_user` (correct for get)

**GET /api/users/1:**
```json
{
    "id": 1,
    "full_name": "Verify User",
    "handle": "verify",
    "profile_picture": null,
    "cover_image": null,
    "username": "verify",
    "bio": null,
    "post_count": 1,
    "follower_count": 0,
    "following_count": 0,
    "is_following": false
}
```
✓ All 11 expected keys present

### Step 2: Test Scripts ✓
- ✓ test_comments.sh - PASS
- ✓ test_comments2.sh - PASS

### Step 3: beebo.html ✓
- MD5: 31e46c96c5913400525910f03cf686e1
- Size: 228708 bytes
- ✓ Confirmed unchanged

### Step 4: Failure Analysis

#### test_follows.sh

**Test 5 Failure:**
```bash
# Line 76
ROW_COUNT=$(sqlite3 beebo.db "SELECT COUNT(*) FROM follows WHERE follower_id=$USER_A_ID AND followee_id=$USER_B_ID;")
```
**Analysis:** Pre-existing test hygiene issue
- The test queries `beebo.db` (hardcoded path on line 76)
- The server runs with `DB_PATH=beebo_test.db` (per CLAUDE.md instructions)
- The follow operations succeed (rows written to beebo_test.db)
- The verification query checks the wrong database (beebo.db), finds 0 rows
- **Conclusion:** Not a backend regression. Test script needs to use `$DB_PATH` or `beebo_test.db`

**Test 8 Failure:**
```bash
# Line 126
ROW_COUNT=$(sqlite3 beebo.db "SELECT COUNT(*) FROM follows WHERE follower_id=$USER_A_ID AND followee_id=$USER_B_ID;")
```
**Analysis:** Same root cause as Test 5
- Concurrent follow requests succeed (verified by tests 2-4 passing)
- Race condition handling works correctly (no 500 errors)
- Verification queries wrong database
- **Conclusion:** Not a backend regression. Same test hygiene issue.

**Evidence the backend is correct:**
- Tests 2, 3, 4 pass (follow, unfollow work correctly)
- Actual data verification: `sqlite3 beebo_test.db "SELECT COUNT(*) FROM follows" → 1`
- No API errors returned from the toggle operations

#### test_session_migration.sh

**Test 3 Failure:**
```bash
# Line 11
python3 app.py > test_server.log 2>&1 &
```
**Analysis:** Pre-existing test hygiene issue
- The script starts its own server WITHOUT setting `DB_PATH`
- Server defaults to `beebo.db` (contains real/stale data)
- Test attempts to sign up with email `testphase2@example.com`
- Email already exists in beebo.db from previous test run
- Returns "Email already registered" error
- Test fails on line 30 because signup response is an error, not user data
- **Conclusion:** Not a backend regression. Test needs to either:
  - Set `DB_PATH=beebo_test.db` when starting server, OR
  - Use unique email addresses (e.g., `testphase2_$(date +%s)@example.com`), OR
  - Clean up beebo.db before running

**Evidence the backend is correct:**
- When run with a fresh user, profile update returns `{"success": true, ...}` correctly
- All Phase 3 manual tests against test database pass
- No code changes touched the auth or profile update logic

## Summary

Both issues resolved successfully:
1. ✓ Dead code removed from create_comment, consolidated to single serializer call
2. ✓ get_user_public_profile now uses serialize_user_public() for shared fields

All test failures are confirmed pre-existing test script issues:
- test_follows.sh tests 5 & 8: Query wrong database (beebo.db vs beebo_test.db)
- test_session_migration.sh: Starts server without DB_PATH, hits stale data in beebo.db

Zero endpoint behavior changes. Zero response structure changes. Zero regressions introduced.
