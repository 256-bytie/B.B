#!/bin/bash

# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see CLAUDE.md Testing section).
# Running these against a server started without DB_PATH set will write
# test data into the real beebo.db.

BASE_URL="http://localhost:5050"
COOKIES_FILE="cookies_cleanup_test.txt"

echo "Testing file cleanup on highlight deletion..."

# Sign up
curl -s -c "$COOKIES_FILE" -X POST "$BASE_URL/api/signup" \
  -H "Content-Type: application/json" \
  -d '{"full_name": "Cleanup Test", "email": "cleanup@test.com", "password": "password123"}' > /dev/null

USER_ID=$(curl -s -b "$COOKIES_FILE" "$BASE_URL/api/session" | python3 -c "import sys, json; print(json.load(sys.stdin)['user']['id'])")

# Create test image
echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" | base64 -d > /tmp/test_cleanup.jpg

# Upload highlight and capture the filename
echo -e "\nUploading highlight..."
RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/test_cleanup.jpg" \
  -F "title=Test Cleanup")

echo "$RESPONSE" | python3 -m json.tool

HIGHLIGHT_ID=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
MEDIA_URL=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['cover'])")
FILENAME=$(basename "$MEDIA_URL")

echo -e "\nHighlight ID: $HIGHLIGHT_ID"
echo "Filename: $FILENAME"

# Check if file exists
if [ -f "static/uploads/$FILENAME" ]; then
  echo "✓ File exists before deletion"
else
  echo "✗ File does not exist before deletion"
fi

# Delete highlight
echo -e "\nDeleting highlight..."
curl -s -b "$COOKIES_FILE" -X DELETE "$BASE_URL/api/highlights/$HIGHLIGHT_ID" | python3 -m json.tool

# Check if file was deleted
sleep 1
if [ ! -f "static/uploads/$FILENAME" ]; then
  echo "✓ File was successfully deleted"
else
  echo "✗ File still exists after deletion"
fi

# Cleanup
rm -f "$COOKIES_FILE" /tmp/test_cleanup.jpg

echo -e "\nFile cleanup test completed!"
