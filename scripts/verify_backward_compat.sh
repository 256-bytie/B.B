#!/bin/bash

echo "=== Verifying Backward Compatibility ==="
echo ""

# Test GET /api/posts structure
# NOTE: as of the Phase 4 pagination change, GET /api/posts returns
# {"posts": [...], "next_cursor": ...} instead of a bare array. This is an
# intentional, documented breaking change to this one endpoint's response
# shape (see backend prompt for "Add pagination to GET /api/posts").
echo "1. Testing GET /api/posts response structure..."
POSTS=$(curl -s http://localhost:5050/api/posts -b e2e_cookie.txt | python3 -c "
import json, sys
body = json.load(sys.stdin)
expected_top_keys = {'posts', 'next_cursor'}
actual_top_keys = set(body.keys())
if actual_top_keys != expected_top_keys:
    print(f'✗ FAIL: Top-level key mismatch')
    print(f'  Expected: {expected_top_keys}')
    print(f'  Actual: {actual_top_keys}')
else:
    posts = body['posts']
    if posts:
        post = posts[0]
        expected_keys = {'id', 'user_id', 'content', 'audience', 'created_at', 'comment_count',
                         'like_count', 'view_count', 'author_name', 'author_handle', 'author_avatar',
                         'username', 'bio', 'liked_by_user', 'images'}
        actual_keys = set(post.keys())
        if expected_keys == actual_keys:
            print('✓ PASS: All expected keys present')
        else:
            print(f'✗ FAIL: Key mismatch')
            print(f'  Expected: {expected_keys}')
            print(f'  Actual: {actual_keys}')
            print(f'  Missing: {expected_keys - actual_keys}')
            print(f'  Extra: {actual_keys - expected_keys}')
    else:
        print('✗ FAIL: No posts returned')
")
echo "$POSTS"
echo ""

# Test GET /api/posts/<id>/comments structure
echo "2. Testing GET /api/posts/<id>/comments response structure..."
COMMENTS=$(curl -s http://localhost:5050/api/posts/1/comments -b e2e_cookie.txt | python3 -c "
import json, sys
comments = json.load(sys.stdin)
if comments:
    comment = comments[0]
    expected_keys = {'id', 'post_id', 'author_name', 'author_handle', 'author_avatar',
                     'username', 'bio', 'content', 'created_at', 'like_count', 'liked_by_user'}
    actual_keys = set(comment.keys())
    if expected_keys == actual_keys:
        print('✓ PASS: All expected keys present')
    else:
        print(f'✗ FAIL: Key mismatch')
        print(f'  Expected: {expected_keys}')
        print(f'  Actual: {actual_keys}')
        print(f'  Missing: {expected_keys - actual_keys}')
        print(f'  Extra: {actual_keys - expected_keys}')
else:
    print('✗ FAIL: No comments returned')
")
echo "$COMMENTS"
echo ""

# Test GET /api/users/<id> structure
echo "3. Testing GET /api/users/<id> response structure..."
PROFILE=$(curl -s http://localhost:5050/api/users/9 -b e2e_cookie.txt | python3 -c "
import json, sys
profile = json.load(sys.stdin)
expected_keys = {'id', 'full_name', 'handle', 'profile_picture', 'cover_image', 'username', 
                 'bio', 'post_count', 'follower_count', 'following_count', 'is_following'}
actual_keys = set(profile.keys())
if expected_keys == actual_keys:
    print('✓ PASS: All expected keys present')
else:
    print(f'✗ FAIL: Key mismatch')
    print(f'  Expected: {expected_keys}')
    print(f'  Actual: {actual_keys}')
    print(f'  Missing: {expected_keys - actual_keys}')
    print(f'  Extra: {actual_keys - expected_keys}')
")
echo "$PROFILE"
echo ""

echo "=== Verification Complete ==="
