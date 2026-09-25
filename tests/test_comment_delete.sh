#!/bin/bash
set -e

echo "=== Testing comment user_id and delete functionality ==="

# Start server in background
python3 app.py &
SERVER_PID=$!
sleep 2

# Cleanup function
cleanup() {
    echo "Stopping server..."
    kill $SERVER_PID 2>/dev/null || true
    rm -f test_cookies_a.txt test_cookies_b.txt
}
trap cleanup EXIT

# Register and login user A
echo "1. Creating user A..."
curl -s -c test_cookies_a.txt -X POST http://localhost:5050/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"testa@example.com","password":"password123","full_name":"Test A"}' > /dev/null

curl -s -b test_cookies_a.txt -c test_cookies_a.txt -X POST http://localhost:5050/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"testa@example.com","password":"password123"}' > /dev/null

# Register and login user B
echo "2. Creating user B..."
curl -s -c test_cookies_b.txt -X POST http://localhost:5050/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"testb@example.com","password":"password123","full_name":"Test B"}' > /dev/null

curl -s -b test_cookies_b.txt -c test_cookies_b.txt -X POST http://localhost:5050/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"testb@example.com","password":"password123"}' > /dev/null

# User A creates a post
echo "3. User A creates a post..."
POST_RESPONSE=$(curl -s -b test_cookies_a.txt -X POST http://localhost:5050/api/posts \
  -H "Content-Type: application/json" \
  -d '{"content":"Test post for comments"}')
POST_ID=$(echo $POST_RESPONSE | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
echo "   Post ID: $POST_ID"

# User B creates a comment
echo "4. User B creates a comment..."
COMMENT_RESPONSE=$(curl -s -b test_cookies_b.txt -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content":"Test comment from B"}')
COMMENT_ID=$(echo $COMMENT_RESPONSE | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
echo "   Comment ID: $COMMENT_ID"

# Check if user_id is in the response
if echo $COMMENT_RESPONSE | grep -q '"user_id"'; then
    echo "   ✓ user_id present in create response"
else
    echo "   ✗ user_id missing in create response"
    exit 1
fi

# User A fetches comments (should see user_id)
echo "5. User A fetches comments..."
COMMENTS_RESPONSE=$(curl -s -b test_cookies_a.txt http://localhost:5050/api/posts/$POST_ID/comments)
if echo $COMMENTS_RESPONSE | grep -q '"user_id"'; then
    echo "   ✓ user_id present in get comments response"
else
    echo "   ✗ user_id missing in get comments response"
    exit 1
fi

# User A tries to delete B's comment (should fail with 403)
echo "6. User A tries to delete B's comment (should fail)..."
DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -b test_cookies_a.txt -X DELETE \
  http://localhost:5050/api/comments/$COMMENT_ID)
STATUS_CODE=$(echo "$DELETE_RESPONSE" | tail -n1)
if [ "$STATUS_CODE" = "403" ]; then
    echo "   ✓ Correctly rejected with 403"
else
    echo "   ✗ Expected 403, got $STATUS_CODE"
    exit 1
fi

# User B deletes their own comment (should succeed)
echo "7. User B deletes their own comment..."
DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -b test_cookies_b.txt -X DELETE \
  http://localhost:5050/api/comments/$COMMENT_ID)
STATUS_CODE=$(echo "$DELETE_RESPONSE" | tail -n1)
if [ "$STATUS_CODE" = "200" ]; then
    echo "   ✓ Successfully deleted with 200"
else
    echo "   ✗ Expected 200, got $STATUS_CODE"
    exit 1
fi

# Verify comment is gone (should return empty array)
echo "8. Verifying comment is deleted..."
COMMENTS_AFTER=$(curl -s -b test_cookies_a.txt http://localhost:5050/api/posts/$POST_ID/comments)
if echo $COMMENTS_AFTER | grep -q "\"id\":$COMMENT_ID"; then
    echo "   ✗ Comment still exists"
    exit 1
else
    echo "   ✓ Comment successfully deleted"
fi

# Verify comment_count was decremented
echo "9. Verifying comment_count decremented..."
POST_AFTER=$(curl -s -b test_cookies_a.txt http://localhost:5050/api/posts)
COMMENT_COUNT=$(echo $POST_AFTER | grep -o "\"comment_count\":[0-9]*" | head -1 | cut -d':' -f2)
if [ "$COMMENT_COUNT" = "0" ]; then
    echo "   ✓ comment_count is 0"
else
    echo "   ✗ comment_count is $COMMENT_COUNT, expected 0"
    exit 1
fi

echo ""
echo "=== All tests passed! ==="
