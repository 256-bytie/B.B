#!/bin/bash

# Race condition regression tests for like_post and like_comment.
# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see CLAUDE.md Testing section).

echo "=== Testing Like Race Conditions ==="
echo ""

# Cleanup from previous runs
rm -f cookies_test_user.txt

DB_PATH="${DB_PATH:-beebo_test.db}"

# 1. Sign up a test user
echo "1. Creating test user..."
SIGNUP=$(curl -s -X POST http://localhost:5050/api/signup \
  -H "Content-Type: application/json" \
  -d '{"full_name": "Race Test User", "email": "racetest@example.com", "password": "password123"}' \
  -c cookies_test_user.txt)
USER_ID=$(echo $SIGNUP | jq -r '.user.id')
CSRF_TOKEN=$(echo $SIGNUP | jq -r '.csrf_token')
echo "   Test user created: ID=$USER_ID"
echo ""

# 2. Create a test post
echo "2. Creating test post..."
POST_RESP=$(curl -s -X POST http://localhost:5050/api/posts \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -b cookies_test_user.txt \
  -d '{"content": "Test post for race condition", "audience": "General"}')
POST_ID=$(echo $POST_RESP | jq -r '.id')
echo "   Test post created: ID=$POST_ID"
echo ""

# 3. Concurrent like requests on post (5 simultaneous requests)
echo "3. Firing 5 concurrent POST /api/posts/$POST_ID/like requests..."
RESP1=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
PID1=$!
RESP2=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
PID2=$!
RESP3=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
PID3=$!
RESP4=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
PID4=$!
RESP5=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
PID5=$!

wait $PID1
wait $PID2
wait $PID3
wait $PID4
wait $PID5

echo "   All requests completed"
echo ""

# 4. Check for 500 errors or database error messages
echo "4. Checking responses for errors..."
HAS_ERROR=0

if echo "$RESP1" | grep -q "Database error\|error"; then
  ERROR1=$(echo $RESP1 | jq -r '.error // empty')
  if [ -n "$ERROR1" ] && [[ "$ERROR1" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 1 contains database error: $ERROR1"
    HAS_ERROR=1
  fi
fi

if echo "$RESP2" | grep -q "Database error\|error"; then
  ERROR2=$(echo $RESP2 | jq -r '.error // empty')
  if [ -n "$ERROR2" ] && [[ "$ERROR2" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 2 contains database error: $ERROR2"
    HAS_ERROR=1
  fi
fi

if echo "$RESP3" | grep -q "Database error\|error"; then
  ERROR3=$(echo $RESP3 | jq -r '.error // empty')
  if [ -n "$ERROR3" ] && [[ "$ERROR3" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 3 contains database error: $ERROR3"
    HAS_ERROR=1
  fi
fi

if echo "$RESP4" | grep -q "Database error\|error"; then
  ERROR4=$(echo $RESP4 | jq -r '.error // empty')
  if [ -n "$ERROR4" ] && [[ "$ERROR4" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 4 contains database error: $ERROR4"
    HAS_ERROR=1
  fi
fi

if echo "$RESP5" | grep -q "Database error\|error"; then
  ERROR5=$(echo $RESP5 | jq -r '.error // empty')
  if [ -n "$ERROR5" ] && [[ "$ERROR5" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 5 contains database error: $ERROR5"
    HAS_ERROR=1
  fi
fi

if [ $HAS_ERROR -eq 0 ]; then
  echo "   ✓ PASS: No database errors in any response"
else
  echo "   Responses for debugging:"
  echo "   RESP1: $RESP1"
  echo "   RESP2: $RESP2"
  echo "   RESP3: $RESP3"
  echo "   RESP4: $RESP4"
  echo "   RESP5: $RESP5"
fi
echo ""

# 5. Check database: should have exactly 1 like row
echo "5. Checking database for like row count..."
LIKE_ROW_COUNT=$(sqlite3 $DB_PATH "SELECT COUNT(*) FROM likes WHERE user_id=$USER_ID AND target_type='post' AND target_id=$POST_ID;")
echo "   Likes table row count: $LIKE_ROW_COUNT"

if [ "$LIKE_ROW_COUNT" = "1" ]; then
  echo "   ✓ PASS: Exactly 1 row in likes table"
elif [ "$LIKE_ROW_COUNT" = "0" ]; then
  echo "   ✓ PASS: 0 rows (all requests toggled off, valid race outcome)"
else
  echo "   ✗ FAIL: Expected 0 or 1 row, found $LIKE_ROW_COUNT"
fi
echo ""

# 6. Check denormalized counter matches actual row count
echo "6. Checking denormalized like_count..."
POST_LIKE_COUNT=$(sqlite3 $DB_PATH "SELECT like_count FROM posts WHERE id=$POST_ID;")
echo "   posts.like_count: $POST_LIKE_COUNT"
echo "   Actual likes rows: $LIKE_ROW_COUNT"

if [ "$POST_LIKE_COUNT" = "$LIKE_ROW_COUNT" ]; then
  echo "   ✓ PASS: Denormalized counter matches actual row count"
else
  echo "   ✗ FAIL: Counter drift detected (like_count=$POST_LIKE_COUNT, actual=$LIKE_ROW_COUNT)"
fi
echo ""

# 7. Create a test comment for comment-like race testing
echo "7. Creating test comment..."
COMMENT_RESP=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -b cookies_test_user.txt \
  -d '{"content": "Test comment for race condition"}')
COMMENT_ID=$(echo $COMMENT_RESP | jq -r '.id')
echo "   Test comment created: ID=$COMMENT_ID"
echo ""

# 8. Concurrent like requests on comment (5 simultaneous requests)
echo "8. Firing 5 concurrent POST /api/comments/$COMMENT_ID/like requests..."
CRESP1=$(curl -s -X POST http://localhost:5050/api/comments/$COMMENT_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
CPID1=$!
CRESP2=$(curl -s -X POST http://localhost:5050/api/comments/$COMMENT_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
CPID2=$!
CRESP3=$(curl -s -X POST http://localhost:5050/api/comments/$COMMENT_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
CPID3=$!
CRESP4=$(curl -s -X POST http://localhost:5050/api/comments/$COMMENT_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
CPID4=$!
CRESP5=$(curl -s -X POST http://localhost:5050/api/comments/$COMMENT_ID/like -H "X-CSRF-Token: $CSRF_TOKEN" -b cookies_test_user.txt) &
CPID5=$!

wait $CPID1
wait $CPID2
wait $CPID3
wait $CPID4
wait $CPID5

echo "   All requests completed"
echo ""

# 9. Check for 500 errors on comment likes
echo "9. Checking comment like responses for errors..."
HAS_ERROR=0

if echo "$CRESP1" | grep -q "Database error\|error"; then
  CERROR1=$(echo $CRESP1 | jq -r '.error // empty')
  if [ -n "$CERROR1" ] && [[ "$CERROR1" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 1 contains database error: $CERROR1"
    HAS_ERROR=1
  fi
fi

if echo "$CRESP2" | grep -q "Database error\|error"; then
  CERROR2=$(echo $CRESP2 | jq -r '.error // empty')
  if [ -n "$CERROR2" ] && [[ "$CERROR2" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 2 contains database error: $CERROR2"
    HAS_ERROR=1
  fi
fi

if echo "$CRESP3" | grep -q "Database error\|error"; then
  CERROR3=$(echo $CRESP3 | jq -r '.error // empty')
  if [ -n "$CERROR3" ] && [[ "$CERROR3" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 3 contains database error: $CERROR3"
    HAS_ERROR=1
  fi
fi

if echo "$CRESP4" | grep -q "Database error\|error"; then
  CERROR4=$(echo $CRESP4 | jq -r '.error // empty')
  if [ -n "$CERROR4" ] && [[ "$CERROR4" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 4 contains database error: $CERROR4"
    HAS_ERROR=1
  fi
fi

if echo "$CRESP5" | grep -q "Database error\|error"; then
  CERROR5=$(echo $CRESP5 | jq -r '.error // empty')
  if [ -n "$CERROR5" ] && [[ "$CERROR5" == *"Database error"* ]]; then
    echo "   ✗ FAIL: Response 5 contains database error: $CERROR5"
    HAS_ERROR=1
  fi
fi

if [ $HAS_ERROR -eq 0 ]; then
  echo "   ✓ PASS: No database errors in any response"
else
  echo "   Responses for debugging:"
  echo "   CRESP1: $CRESP1"
  echo "   CRESP2: $CRESP2"
  echo "   CRESP3: $CRESP3"
  echo "   CRESP4: $CRESP4"
  echo "   CRESP5: $CRESP5"
fi
echo ""

# 10. Check database: should have exactly 1 comment-like row
echo "10. Checking database for comment-like row count..."
COMMENT_LIKE_ROW_COUNT=$(sqlite3 $DB_PATH "SELECT COUNT(*) FROM likes WHERE user_id=$USER_ID AND target_type='comment' AND target_id=$COMMENT_ID;")
echo "    Likes table row count: $COMMENT_LIKE_ROW_COUNT"

if [ "$COMMENT_LIKE_ROW_COUNT" = "1" ]; then
  echo "    ✓ PASS: Exactly 1 row in likes table"
elif [ "$COMMENT_LIKE_ROW_COUNT" = "0" ]; then
  echo "    ✓ PASS: 0 rows (all requests toggled off, valid race outcome)"
else
  echo "    ✗ FAIL: Expected 0 or 1 row, found $COMMENT_LIKE_ROW_COUNT"
fi
echo ""

# 11. Check denormalized counter for comment
echo "11. Checking denormalized like_count for comment..."
COMMENT_LIKE_COUNT=$(sqlite3 $DB_PATH "SELECT like_count FROM comments WHERE id=$COMMENT_ID;")
echo "    comments.like_count: $COMMENT_LIKE_COUNT"
echo "    Actual likes rows: $COMMENT_LIKE_ROW_COUNT"

if [ "$COMMENT_LIKE_COUNT" = "$COMMENT_LIKE_ROW_COUNT" ]; then
  echo "    ✓ PASS: Denormalized counter matches actual row count"
else
  echo "    ✗ FAIL: Counter drift detected (like_count=$COMMENT_LIKE_COUNT, actual=$COMMENT_LIKE_ROW_COUNT)"
fi
echo ""

echo "=== Test Complete ==="
rm -f cookies_test_user.txt
