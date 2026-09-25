#!/bin/bash

# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see CLAUDE.md Testing section).
# Running these against a server started without DB_PATH set will write
# test data into the real beebo.db.

echo "=== Testing Comment System ==="
echo ""

# 1. Sign up a test user
echo "1. Creating test user..."
SIGNUP_RESPONSE=$(curl -s -X POST http://localhost:5050/api/signup \
  -H "Content-Type: application/json" \
  -d '{"full_name": "Test User", "email": "test@example.com", "password": "password123"}' \
  -c cookies.txt)
echo "Signup response: $SIGNUP_RESPONSE"
echo ""

# 2. Create a test post
echo "2. Creating test post..."
POST_RESPONSE=$(curl -s -X POST http://localhost:5050/api/posts \
  -H "Content-Type: application/json" \
  -d '{"content": "This is a test post for comments"}' \
  -b cookies.txt)
echo "Post response: $POST_RESPONSE"
POST_ID=$(echo $POST_RESPONSE | grep -o '"id":[0-9]*' | grep -o '[0-9]*' | head -1)
echo "Post ID: $POST_ID"
echo ""

# 3. Get comments for the post (should be empty)
echo "3. Getting comments (should be empty)..."
curl -s http://localhost:5050/api/posts/$POST_ID/comments | jq '.'
echo ""

# 4. Add a comment to the post
echo "4. Adding a comment..."
COMMENT_RESPONSE=$(curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "This is my first comment!"}' \
  -b cookies.txt)
echo "$COMMENT_RESPONSE" | jq '.'
echo ""

# 5. Add another comment
echo "5. Adding another comment..."
curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "This is my second comment with more detail about the post."}' \
  -b cookies.txt | jq '.'
echo ""

# 6. Get all comments
echo "6. Getting all comments..."
curl -s http://localhost:5050/api/posts/$POST_ID/comments | jq '.'
echo ""

# 7. Verify post comment_count was updated
echo "7. Verifying post comment_count..."
curl -s http://localhost:5050/api/posts | jq ".posts[0].comment_count"
echo ""

# 8. Test error cases
echo "8. Testing error cases..."
echo "   a. Empty comment:"
curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": ""}' \
  -b cookies.txt | jq '.'
echo ""

echo "   b. Non-existent post:"
curl -s -X POST http://localhost:5050/api/posts/99999/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "This should fail"}' \
  -b cookies.txt | jq '.'
echo ""

echo "   c. Unauthenticated request:"
curl -s -X POST http://localhost:5050/api/posts/$POST_ID/comments \
  -H "Content-Type: application/json" \
  -d '{"content": "This should fail"}' | jq '.'
echo ""

echo "=== Test Complete ==="
rm -f cookies.txt

