#!/bin/bash

# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see CLAUDE.md Testing section).
# Running these against a server started without DB_PATH set will write
# test data into the real beebo.db.

echo "=== Testing Comment System ==="
echo ""

# 1. Login with existing user
echo "1. Logging in..."
curl -s -X POST http://localhost:5050/api/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "password123"}' \
  -c cookies.txt > /dev/null
echo "Logged in successfully"
echo ""

# 2. Create a test post
echo "2. Creating test post..."
POST_RESPONSE=$(curl -s -X POST http://localhost:5050/api/posts \
  -H "Content-Type: application/json" \
  -d '{"content": "This is a test post for comments"}' \
  -b cookies.txt)
echo "$POST_RESPONSE"
POST_ID=$(echo $POST_RESPONSE | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "Post ID: $POST_ID"
echo ""

# 3. Get comments for the post (should be empty)
echo "3. Getting comments (should be empty)..."
curl -s http://localhost:5050/api/posts/$POST_ID/comments
echo ""
echo ""

# 4. Add a comment to the post
echo "4. Adding a comment..."
COMMENT_RESPONSE=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "This is my first comment!"}' \
  -b cookies.txt)
echo "$COMMENT_RESPONSE"
echo ""

# 5. Add another comment
echo "5. Adding another comment..."
curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "This is my second comment with more detail about the post."}' \
  -b cookies.txt
echo ""
echo ""

# 6. Get all comments
echo "6. Getting all comments (should show 2)..."
curl -s http://localhost:5050/api/posts/$POST_ID/comments
echo ""
echo ""

# 7. Verify post comment_count was updated
echo "7. Verifying post comment_count (should be 2)..."
curl -s http://localhost:5050/api/posts | python3 -c "import sys, json; posts = json.load(sys.stdin)['posts']; print([p for p in posts if p['id'] == $POST_ID][0]['comment_count'])"
echo ""

# 8. Test error cases
echo "8. Testing error cases..."
echo "   a. Empty comment:"
curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": ""}' \
  -b cookies.txt
echo ""
echo ""

echo "   b. Non-existent post:"
curl -s -X POST http://localhost:5050/api/posts/99999/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "This should fail"}' \
  -b cookies.txt
echo ""
echo ""

echo "   c. Unauthenticated request:"
curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "This should fail"}'
echo ""
echo ""

echo "=== Test Complete ==="
rm -f cookies.txt

