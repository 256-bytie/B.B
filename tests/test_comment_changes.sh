#!/bin/bash

# Manual test for comment user_id and delete functionality
# Run against a test database to avoid affecting production data

export DB_PATH=beebo_test.db

echo "=== Starting test server ==="
python3 app.py &
SERVER_PID=$!
sleep 3

cleanup() {
    echo "Stopping server..."
    kill $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "=== Testing Comment Changes ==="
echo ""

# 1. Sign up user A
echo "1. Creating user A..."
curl -s -X POST http://localhost:5050/api/signup \
  -H "Content-Type: application/json" \
  -d '{"full_name": "User A", "email": "usera@test.com", "password": "pass123"}' \
  -c cookies_a.txt > /dev/null

# 2. Sign up user B
echo "2. Creating user B..."
curl -s -X POST http://localhost:5050/api/signup \
  -H "Content-Type: application/json" \
  -d '{"full_name": "User B", "email": "userb@test.com", "password": "pass123"}' \
  -c cookies_b.txt > /dev/null

# 3. User A creates a post
echo "3. User A creates a post..."
POST_RESPONSE=$(curl -s -X POST http://localhost:5050/api/posts \
  -H "Content-Type: application/json" \
  -d '{"content": "Test post for comment deletion"}' \
  -b cookies_a.txt)
POST_ID=$(echo $POST_RESPONSE | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
echo "   Post ID: $POST_ID"

# 4. User B creates a comment
echo "4. User B creates a comment..."
COMMENT_RESPONSE=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "Comment from User B"}' \
  -b cookies_b.txt)
COMMENT_ID=$(echo $COMMENT_RESPONSE | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
echo "   Comment ID: $COMMENT_ID"
echo ""

# 5. Check if user_id is in create response
echo "5. Checking if user_id is in create response..."
if echo "$COMMENT_RESPONSE" | grep -q '"user_id"'; then
    USER_ID=$(echo "$COMMENT_RESPONSE" | grep -o '"user_id":[0-9]*' | cut -d':' -f2)
    echo "   ✓ user_id present in response: $USER_ID"
else
    echo "   ✗ user_id missing in create response"
    echo "   Response: $COMMENT_RESPONSE"
fi
echo ""

# 6. Get comments and check user_id
echo "6. Getting comments and checking user_id..."
COMMENTS=$(curl -s http://localhost:5050/api/posts/$POST_ID/comments)
if echo "$COMMENTS" | grep -q '"user_id"'; then
    echo "   ✓ user_id present in GET comments response"
else
    echo "   ✗ user_id missing in GET comments response"
    echo "   Response: $COMMENTS"
fi
echo ""

# 7. User A tries to delete User B's comment (should fail with 403)
echo "7. User A tries to delete User B's comment (should fail)..."
DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE \
  http://localhost:5050/api/comments/$COMMENT_ID \
  -b cookies_a.txt)
STATUS=$(echo "$DELETE_RESPONSE" | tail -n1)
if [ "$STATUS" = "403" ]; then
    echo "   ✓ Correctly rejected with 403"
else
    echo "   ✗ Expected 403, got $STATUS"
    echo "   Response: $DELETE_RESPONSE"
fi
echo ""

# 8. User B deletes their own comment (should succeed)
echo "8. User B deletes their own comment..."
DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE \
  http://localhost:5050/api/comments/$COMMENT_ID \
  -b cookies_b.txt)
STATUS=$(echo "$DELETE_RESPONSE" | tail -n1)
if [ "$STATUS" = "200" ]; then
    echo "   ✓ Successfully deleted with 200"
else
    echo "   ✗ Expected 200, got $STATUS"
    echo "   Response: $DELETE_RESPONSE"
fi
echo ""

# 9. Verify comment is deleted
echo "9. Verifying comment is deleted..."
COMMENTS_AFTER=$(curl -s http://localhost:5050/api/posts/$POST_ID/comments)
if echo "$COMMENTS_AFTER" | grep -q "\"id\":$COMMENT_ID"; then
    echo "   ✗ Comment still exists!"
else
    echo "   ✓ Comment successfully deleted"
fi
echo ""

echo "=== Test complete ==="
