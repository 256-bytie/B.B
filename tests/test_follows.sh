#!/bin/bash

# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see CLAUDE.md Testing section).
# Running these against a server started without DB_PATH set will write
# test data into the real beebo.db.

echo "=== Testing Follow System ==="
echo ""

# Cleanup from previous runs
rm -f cookies_a.txt cookies_b.txt

# 1. Sign up two test users
echo "1. Creating two test users..."
SIGNUP_A=$(curl -s -X POST http://localhost:5050/api/signup \
  -H "Content-Type: application/json" \
  -d '{"full_name": "User A", "email": "usera@example.com", "password": "password123"}' \
  -c cookies_a.txt)
USER_A_ID=$(echo $SIGNUP_A | jq -r '.user.id')
echo "   User A created: ID=$USER_A_ID"

SIGNUP_B=$(curl -s -X POST http://localhost:5050/api/signup \
  -H "Content-Type: application/json" \
  -d '{"full_name": "User B", "email": "userb@example.com", "password": "password123"}' \
  -c cookies_b.txt)
USER_B_ID=$(echo $SIGNUP_B | jq -r '.user.id')
echo "   User B created: ID=$USER_B_ID"
echo ""

# 2. User A follows User B
echo "2. User A follows User B..."
FOLLOW_RESP=$(curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow \
  -b cookies_a.txt)
FOLLOWING=$(echo $FOLLOW_RESP | jq -r '.following')
FOLLOWER_COUNT=$(echo $FOLLOW_RESP | jq -r '.follower_count')
if [ "$FOLLOWING" = "true" ] && [ "$FOLLOWER_COUNT" = "1" ]; then
  echo "   ✓ PASS: following=true, follower_count=1"
else
  echo "   ✗ FAIL: Expected following=true and follower_count=1, got following=$FOLLOWING, follower_count=$FOLLOWER_COUNT"
fi
echo ""

# 3. Fetch User B's public profile as User A
echo "3. Fetching User B's profile as User A..."
PROFILE_RESP=$(curl -s http://localhost:5050/api/users/$USER_B_ID -b cookies_a.txt)
IS_FOLLOWING=$(echo $PROFILE_RESP | jq -r '.is_following')
PROFILE_FOLLOWER_COUNT=$(echo $PROFILE_RESP | jq -r '.follower_count')
if [ "$IS_FOLLOWING" = "true" ] && [ "$PROFILE_FOLLOWER_COUNT" = "1" ]; then
  echo "   ✓ PASS: is_following=true, follower_count=1"
else
  echo "   ✗ FAIL: Expected is_following=true and follower_count=1, got is_following=$IS_FOLLOWING, follower_count=$PROFILE_FOLLOWER_COUNT"
fi
echo ""

# 4. User A unfollows User B
echo "4. User A unfollows User B..."
UNFOLLOW_RESP=$(curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow \
  -b cookies_a.txt)
FOLLOWING=$(echo $UNFOLLOW_RESP | jq -r '.following')
FOLLOWER_COUNT=$(echo $UNFOLLOW_RESP | jq -r '.follower_count')
if [ "$FOLLOWING" = "false" ] && [ "$FOLLOWER_COUNT" = "0" ]; then
  echo "   ✓ PASS: following=false, follower_count=0"
else
  echo "   ✗ FAIL: Expected following=false and follower_count=0, got following=$FOLLOWING, follower_count=$FOLLOWER_COUNT"
fi
echo ""

# 5. Follow → unfollow → follow cycle (3x)
echo "5. Follow/unfollow cycle (3 times)..."
for i in 1 2 3; do
  curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow -b cookies_a.txt > /dev/null
  curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow -b cookies_a.txt > /dev/null
done
curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow -b cookies_a.txt > /dev/null
ROW_COUNT=$(sqlite3 beebo.db "SELECT COUNT(*) FROM follows WHERE follower_id=$USER_A_ID AND followee_id=$USER_B_ID;")
if [ "$ROW_COUNT" = "1" ]; then
  echo "   ✓ PASS: Exactly 1 row exists in follows table"
else
  echo "   ✗ FAIL: Expected 1 row, found $ROW_COUNT"
fi
echo ""

# 6. Self-follow attempt
echo "6. User A attempts to follow themselves..."
SELF_FOLLOW=$(curl -s -X POST http://localhost:5050/api/users/$USER_A_ID/follow \
  -b cookies_a.txt)
ERROR_MSG=$(echo $SELF_FOLLOW | jq -r '.error')
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:5050/api/users/$USER_A_ID/follow -b cookies_a.txt)
if [ "$HTTP_CODE" = "400" ] && [[ "$ERROR_MSG" == *"Cannot follow yourself"* ]]; then
  echo "   ✓ PASS: Returns 400 with correct error message"
else
  echo "   ✗ FAIL: Expected 400 with 'Cannot follow yourself', got $HTTP_CODE with '$ERROR_MSG'"
fi
echo ""

# 7. Follow a nonexistent user
echo "7. User A follows nonexistent user (ID=99999)..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:5050/api/users/99999/follow -b cookies_a.txt)
if [ "$HTTP_CODE" = "404" ]; then
  echo "   ✓ PASS: Returns 404"
else
  echo "   ✗ FAIL: Expected 404, got $HTTP_CODE"
fi
echo ""

# 8. Concurrency test (race condition regression)
echo "8. Concurrent follow requests (race condition test)..."
# First ensure we're not following
curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow -b cookies_a.txt > /dev/null
PROFILE_CHECK=$(curl -s http://localhost:5050/api/users/$USER_B_ID -b cookies_a.txt)
IS_FOLLOWING=$(echo $PROFILE_CHECK | jq -r '.is_following')
if [ "$IS_FOLLOWING" = "true" ]; then
  # Unfollow first
  curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow -b cookies_a.txt > /dev/null
fi

# Fire two follow requests simultaneously
RESP1=$(curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow -b cookies_a.txt) &
RESP2=$(curl -s -X POST http://localhost:5050/api/users/$USER_B_ID/follow -b cookies_a.txt) &
wait

# Check both responses succeeded (no 500 error)
ERROR1=$(echo $RESP1 | jq -r '.error // empty')
ERROR2=$(echo $RESP2 | jq -r '.error // empty')
ROW_COUNT=$(sqlite3 beebo.db "SELECT COUNT(*) FROM follows WHERE follower_id=$USER_A_ID AND followee_id=$USER_B_ID;")

if [ -z "$ERROR1" ] && [ -z "$ERROR2" ] && [ "$ROW_COUNT" = "1" ]; then
  echo "   ✓ PASS: No errors, exactly 1 row in follows table"
else
  echo "   ✗ FAIL: error1='$ERROR1', error2='$ERROR2', row_count=$ROW_COUNT"
fi
echo ""

# 9. Unauthenticated follow attempt
echo "9. Unauthenticated follow attempt..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:5050/api/users/$USER_B_ID/follow)
if [ "$HTTP_CODE" = "401" ]; then
  echo "   ✓ PASS: Returns 401"
else
  echo "   ✗ FAIL: Expected 401, got $HTTP_CODE"
fi
echo ""

echo "=== Test Complete ==="
rm -f cookies_a.txt cookies_b.txt
