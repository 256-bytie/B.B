#!/bin/bash

# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see CLAUDE.md Testing section).
# Running these against a server started without DB_PATH set will write
# test data into the real beebo.db.

BASE_URL="http://localhost:5050"
COOKIES_FILE="cookies_highlights_test.txt"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Testing Highlights Feature"
echo "=========================================="

# Clean up any existing cookies
rm -f "$COOKIES_FILE"

# Step 1: Sign up a test user
echo -e "\n${YELLOW}1. Signing up test user...${NC}"
SIGNUP_RESPONSE=$(curl -s -c "$COOKIES_FILE" -X POST "$BASE_URL/api/signup" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Highlights Tester",
    "email": "highlights@test.com",
    "password": "password123"
  }')

echo "$SIGNUP_RESPONSE" | python3 -m json.tool
USER_ID=$(echo "$SIGNUP_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['user']['id'])" 2>/dev/null)

if [ -z "$USER_ID" ]; then
  echo -e "${RED}Failed to sign up user${NC}"
  exit 1
fi

echo -e "${GREEN}User ID: $USER_ID${NC}"

# Step 2: Create a photo highlight
echo -e "\n${YELLOW}2. Creating photo highlight...${NC}"
# Create a small test image
convert -size 100x100 xc:blue /tmp/test_photo.jpg 2>/dev/null || {
  # Fallback if ImageMagick is not available
  echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" | base64 -d > /tmp/test_photo.jpg
}

PHOTO_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/test_photo.jpg" \
  -F "title=Summer Vibes")

echo "$PHOTO_RESPONSE" | python3 -m json.tool
PHOTO_ID=$(echo "$PHOTO_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('id', ''))" 2>/dev/null)

if [ -z "$PHOTO_ID" ]; then
  echo -e "${RED}Failed to create photo highlight${NC}"
else
  echo -e "${GREEN}Photo highlight created with ID: $PHOTO_ID${NC}"
fi

# Step 3: Create another photo highlight
echo -e "\n${YELLOW}3. Creating another photo highlight...${NC}"
PHOTO2_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/test_photo.jpg" \
  -F "title=Winter Fun")

echo "$PHOTO2_RESPONSE" | python3 -m json.tool
PHOTO2_ID=$(echo "$PHOTO2_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('id', ''))" 2>/dev/null)

if [ -z "$PHOTO2_ID" ]; then
  echo -e "${RED}Failed to create second photo highlight${NC}"
else
  echo -e "${GREEN}Second photo highlight created with ID: $PHOTO2_ID${NC}"
fi

# Step 4: Get user's highlights
echo -e "\n${YELLOW}4. Getting user's highlights...${NC}"
HIGHLIGHTS_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X GET "$BASE_URL/api/users/$USER_ID/highlights")

echo "$HIGHLIGHTS_RESPONSE" | python3 -m json.tool

# Count highlights
HIGHLIGHT_COUNT=$(echo "$HIGHLIGHTS_RESPONSE" | python3 -c "import sys, json; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo -e "${GREEN}Found $HIGHLIGHT_COUNT highlights${NC}"

# Step 5: Test validation - title too long
echo -e "\n${YELLOW}5. Testing validation - title too long...${NC}"
VALIDATION_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/test_photo.jpg" \
  -F "title=This title is definitely way too long for the maximum allowed")

echo "$VALIDATION_RESPONSE" | python3 -m json.tool

# Step 6: Test validation - no title
echo -e "\n${YELLOW}6. Testing validation - no title...${NC}"
NO_TITLE_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/test_photo.jpg" \
  -F "title=")

echo "$NO_TITLE_RESPONSE" | python3 -m json.tool

# Step 7: Delete a highlight
if [ -n "$PHOTO_ID" ]; then
  echo -e "\n${YELLOW}7. Deleting highlight ID $PHOTO_ID...${NC}"
  DELETE_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X DELETE "$BASE_URL/api/highlights/$PHOTO_ID")
  
  echo "$DELETE_RESPONSE" | python3 -m json.tool
  
  # Verify deletion
  echo -e "\n${YELLOW}8. Verifying deletion - getting highlights again...${NC}"
  VERIFY_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X GET "$BASE_URL/api/users/$USER_ID/highlights")
  
  echo "$VERIFY_RESPONSE" | python3 -m json.tool
  
  REMAINING_COUNT=$(echo "$VERIFY_RESPONSE" | python3 -c "import sys, json; print(len(json.load(sys.stdin)))" 2>/dev/null)
  echo -e "${GREEN}Remaining highlights: $REMAINING_COUNT${NC}"
fi

# Step 9: Test unauthorized access
echo -e "\n${YELLOW}9. Testing unauthorized access (no auth)...${NC}"
UNAUTH_RESPONSE=$(curl -s -X POST "$BASE_URL/api/highlights" \
  -F "media=@/tmp/test_photo.jpg" \
  -F "title=Unauthorized")

echo "$UNAUTH_RESPONSE" | python3 -m json.tool

# Step 10: Test deleting someone else's highlight (create second user)
echo -e "\n${YELLOW}10. Testing cross-user deletion protection...${NC}"
rm -f "$COOKIES_FILE"

# Sign up second user
USER2_RESPONSE=$(curl -s -c "$COOKIES_FILE" -X POST "$BASE_URL/api/signup" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Second User",
    "email": "user2@test.com",
    "password": "password123"
  }')

# Try to delete first user's highlight
if [ -n "$PHOTO2_ID" ]; then
  CROSS_DELETE=$(curl -s -b "$COOKIES_FILE" -X DELETE "$BASE_URL/api/highlights/$PHOTO2_ID")
  echo "$CROSS_DELETE" | python3 -m json.tool
fi

# Cleanup
rm -f "$COOKIES_FILE"
rm -f /tmp/test_photo.jpg

echo -e "\n${GREEN}=========================================="
echo "Test completed!"
echo "==========================================${NC}"
