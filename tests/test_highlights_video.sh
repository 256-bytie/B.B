#!/bin/bash

# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see CLAUDE.md Testing section).
# Running these against a server started without DB_PATH set will write
# test data into the real beebo.db.

BASE_URL="http://localhost:5050"
COOKIES_FILE="cookies_video_test.txt"

echo "=========================================="
echo "Testing Video Highlight Upload"
echo "=========================================="

# Clean up
rm -f "$COOKIES_FILE"

# Sign up user
echo -e "\n1. Signing up test user..."
SIGNUP_RESPONSE=$(curl -s -c "$COOKIES_FILE" -X POST "$BASE_URL/api/signup" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Video Tester",
    "email": "video@test.com",
    "password": "password123"
  }')

USER_ID=$(echo "$SIGNUP_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)
echo "User ID: $USER_ID"

# Create a minimal valid MP4 file (very small test video)
echo -e "\n2. Creating test video file..."
# This is a minimal valid MP4 header
printf '\x00\x00\x00\x20\x66\x74\x79\x70\x69\x73\x6f\x6d\x00\x00\x02\x00\x69\x73\x6f\x6d\x69\x73\x6f\x32\x6d\x70\x34\x31' > /tmp/test_video.mp4
# Add some padding to make it a bit larger
dd if=/dev/zero bs=1024 count=10 >> /tmp/test_video.mp4 2>/dev/null

# Upload video highlight
echo -e "\n3. Uploading video highlight..."
VIDEO_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/test_video.mp4;type=video/mp4" \
  -F "title=My Video Highlight")

echo "$VIDEO_RESPONSE" | python3 -m json.tool

VIDEO_ID=$(echo "$VIDEO_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('id', ''))" 2>/dev/null)
VIDEO_KIND=$(echo "$VIDEO_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('kind', ''))" 2>/dev/null)

if [ "$VIDEO_KIND" = "video" ]; then
  echo -e "\n✓ Video uploaded successfully with kind='video'"
else
  echo -e "\n✗ Failed: Expected kind='video', got '$VIDEO_KIND'"
fi

# Test file size validation (create a file over 25MB)
echo -e "\n4. Testing 25MB file size limit..."
dd if=/dev/zero of=/tmp/large_video.mp4 bs=1M count=26 2>/dev/null
LARGE_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/large_video.mp4;type=video/mp4" \
  -F "title=Too Large")

echo "$LARGE_RESPONSE" | python3 -m json.tool

# Test invalid file type
echo -e "\n5. Testing invalid file type..."
echo "This is a text file" > /tmp/test.txt
INVALID_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/test.txt" \
  -F "title=Invalid File")

echo "$INVALID_RESPONSE" | python3 -m json.tool

# Get all highlights
echo -e "\n6. Getting all highlights..."
ALL_HIGHLIGHTS=$(curl -s -b "$COOKIES_FILE" -X GET "$BASE_URL/api/users/$USER_ID/highlights")
echo "$ALL_HIGHLIGHTS" | python3 -m json.tool

# Cleanup
rm -f "$COOKIES_FILE" /tmp/test_video.mp4 /tmp/large_video.mp4 /tmp/test.txt

echo -e "\n=========================================="
echo "Video Test Completed!"
echo "=========================================="
