#!/usr/bin/env bash
# Test suite for comment image uploads (multipart replies)
set -e

API="http://localhost:5050"
DB="beebo_test.db"

echo "=== Comment Images Test Suite ==="

# Cleanup function
cleanup() {
    rm -f test_image.png test_large.png test_invalid.txt
}
trap cleanup EXIT

# Create test image (1x1 PNG, ~70 bytes)
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > test_image.png

# Create oversized image (>5MB)
dd if=/dev/zero of=test_large.png bs=1M count=6 2>/dev/null

# Create non-image file
echo "not an image" > test_invalid.txt

# Test 1: Signup and login
echo "[1/10] Signup and login..."
SIGNUP_RESP=$(curl -s -X POST "$API/api/signup" \
    -H "Content-Type: application/json" \
    -d '{"full_name":"Image Tester","email":"imgtester@test.com","password":"pass123"}' \
    -c cookies.txt)

if echo "$SIGNUP_RESP" | grep -q '"user_id"'; then
    echo "✓ Signup successful"
else
    echo "✗ Signup failed: $SIGNUP_RESP"
    exit 1
fi

CSRF_TOKEN=$(echo "$SIGNUP_RESP" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)

# Test 2: Create a post to comment on
echo "[2/10] Creating post..."
POST_RESP=$(curl -s -X POST "$API/api/posts" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -d '{"content":"Post for image comment testing","audience":"Academic"}')

POST_ID=$(echo "$POST_RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
if [ -z "$POST_ID" ]; then
    echo "✗ Failed to create post: $POST_RESP"
    exit 1
fi
echo "✓ Post created (ID: $POST_ID)"

# Test 3: Multipart reply with image
echo "[3/10] Creating comment with image..."
COMMENT_RESP=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=Comment with image" \
    -F "image=@test_image.png")

COMMENT_ID=$(echo "$COMMENT_RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
IMAGE_URL=$(echo "$COMMENT_RESP" | grep -o '"/static/uploads/[^"]*"' | tr -d '"')

if [ -z "$COMMENT_ID" ] || [ -z "$IMAGE_URL" ]; then
    echo "✗ Failed to create comment with image: $COMMENT_RESP"
    exit 1
fi
echo "✓ Comment with image created (ID: $COMMENT_ID, image: $IMAGE_URL)"

# Verify file exists on disk
IMAGE_FILE="${IMAGE_URL#/static/uploads/}"
if [ ! -f "static/uploads/$IMAGE_FILE" ]; then
    echo "✗ Image file not found on disk: static/uploads/$IMAGE_FILE"
    exit 1
fi
echo "✓ Image file exists on disk"

# Test 4: Image-only comment (empty content)
echo "[4/10] Creating image-only comment..."
IMG_ONLY_RESP=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=" \
    -F "image=@test_image.png")

if echo "$IMG_ONLY_RESP" | grep -q '"id"'; then
    IMG_ONLY_ID=$(echo "$IMG_ONLY_RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
    echo "✓ Image-only comment created (ID: $IMG_ONLY_ID)"
else
    echo "✗ Image-only comment failed: $IMG_ONLY_RESP"
    exit 1
fi

# Test 5: No image + empty content → 400
echo "[5/10] Testing empty content without image (should fail)..."
EMPTY_RESP=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -d '{"content":""}')

if echo "$EMPTY_RESP" | grep -q "Content cannot be empty"; then
    echo "✓ Empty content correctly rejected"
else
    echo "✗ Empty content should have been rejected: $EMPTY_RESP"
    exit 1
fi

# Test 6: Non-image file → 400
echo "[6/10] Testing non-image file (should fail)..."
INVALID_RESP=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=Invalid file" \
    -F "image=@test_invalid.txt")

if echo "$INVALID_RESP" | grep -q "Only image files are supported"; then
    echo "✓ Non-image file correctly rejected"
else
    echo "✗ Non-image file should have been rejected: $INVALID_RESP"
    exit 1
fi

# Verify no file was written
if ls static/uploads/*.txt 2>/dev/null | grep -q .; then
    echo "✗ Non-image file was written to disk"
    exit 1
fi
echo "✓ No file written for rejected upload"

# Test 7: Oversized image → 400
echo "[7/10] Testing oversized image (should fail)..."
LARGE_RESP=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=Large image" \
    -F "image=@test_large.png")

if echo "$LARGE_RESP" | grep -q "must be under 5MB"; then
    echo "✓ Oversized image correctly rejected"
else
    echo "✗ Oversized image should have been rejected: $LARGE_RESP"
    exit 1
fi

# Test 8: Image reply with parent_comment_id
echo "[8/10] Creating image reply to comment..."
REPLY_RESP=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=Reply with image" \
    -F "parent_comment_id=$COMMENT_ID" \
    -F "image=@test_image.png")

REPLY_ID=$(echo "$REPLY_RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
PARENT_ID=$(echo "$REPLY_RESP" | grep -o '"parent_comment_id":[0-9]*' | cut -d':' -f2)

if [ "$PARENT_ID" = "$COMMENT_ID" ]; then
    echo "✓ Image reply linked correctly (reply ID: $REPLY_ID, parent: $PARENT_ID)"
else
    echo "✗ Image reply linkage failed: $REPLY_RESP"
    exit 1
fi

# Test 9: GET .../comments returns image for image comments, null otherwise
echo "[9/10] Fetching comments to verify image field..."
GET_RESP=$(curl -s -X GET "$API/api/posts/$POST_ID/comments" -b cookies.txt)

# Check that image comments have image URLs
if echo "$GET_RESP" | grep -q '"image":"/static/uploads/'; then
    echo "✓ Image field present for image comments"
else
    echo "✗ Image field missing in GET response: $GET_RESP"
    exit 1
fi

# Check that null is returned for comments without images
if echo "$GET_RESP" | grep -q '"image":null'; then
    echo "✓ Image field null for text-only comments"
else
    echo "✗ Image field should be null for text-only comments"
    exit 1
fi

# Test 10: JSON text-only comment still works
echo "[10/10] Creating JSON text-only comment..."
TEXT_RESP=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -d '{"content":"Plain text comment"}')

if echo "$TEXT_RESP" | grep -q '"id"' && echo "$TEXT_RESP" | grep -q '"image":null'; then
    echo "✓ JSON text-only comment works with image:null"
else
    echo "✗ JSON text-only comment failed: $TEXT_RESP"
    exit 1
fi

echo ""
echo "=== All comment image tests passed ==="

# Test 11: Delete comment with image → file removed
echo "[11/13] Testing comment deletion removes image file..."
COMMENT_WITH_IMG=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=To be deleted" \
    -F "image=@test_image.png")

DEL_COMMENT_ID=$(echo "$COMMENT_WITH_IMG" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
DEL_IMAGE_URL=$(echo "$COMMENT_WITH_IMG" | grep -o '"/static/uploads/[^"]*"' | tr -d '"')
DEL_IMAGE_FILE="${DEL_IMAGE_URL#/static/uploads/}"

if [ ! -f "static/uploads/$DEL_IMAGE_FILE" ]; then
    echo "✗ Image file not found before deletion"
    exit 1
fi

# Delete the comment
curl -s -X DELETE "$API/api/comments/$DEL_COMMENT_ID" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt > /dev/null

# Verify file was removed
if [ -f "static/uploads/$DEL_IMAGE_FILE" ]; then
    echo "✗ Image file not removed after comment deletion"
    exit 1
fi
echo "✓ Comment image file removed on deletion"

# Test 12: Delete comment with image reply beneath it → both files removed
echo "[12/13] Testing cascading delete removes reply image..."
PARENT_WITH_IMG=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=Parent comment" \
    -F "image=@test_image.png")

PARENT_ID_DEL=$(echo "$PARENT_WITH_IMG" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
PARENT_IMG_URL=$(echo "$PARENT_WITH_IMG" | grep -o '"/static/uploads/[^"]*"' | tr -d '"')
PARENT_IMG_FILE="${PARENT_IMG_URL#/static/uploads/}"

CHILD_WITH_IMG=$(curl -s -X POST "$API/api/posts/$POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=Child reply" \
    -F "parent_comment_id=$PARENT_ID_DEL" \
    -F "image=@test_image.png")

CHILD_IMG_URL=$(echo "$CHILD_WITH_IMG" | grep -o '"/static/uploads/[^"]*"' | tr -d '"')
CHILD_IMG_FILE="${CHILD_IMG_URL#/static/uploads/}"

# Verify both files exist before deletion
if [ ! -f "static/uploads/$PARENT_IMG_FILE" ] || [ ! -f "static/uploads/$CHILD_IMG_FILE" ]; then
    echo "✗ Image files not found before cascading deletion"
    exit 1
fi

# Delete parent comment
curl -s -X DELETE "$API/api/comments/$PARENT_ID_DEL" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt > /dev/null

# Verify both files were removed
if [ -f "static/uploads/$PARENT_IMG_FILE" ] || [ -f "static/uploads/$CHILD_IMG_FILE" ]; then
    echo "✗ Not all image files removed after cascading deletion"
    exit 1
fi
echo "✓ Both parent and child image files removed on cascading delete"

# Test 13: Delete post with image comments → files removed
echo "[13/13] Testing post deletion removes comment images..."
NEW_POST=$(curl -s -X POST "$API/api/posts" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -d '{"content":"Post for deletion test","audience":"Academic"}')

NEW_POST_ID=$(echo "$NEW_POST" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)

# Add comment with image
POST_DEL_COMMENT=$(curl -s -X POST "$API/api/posts/$NEW_POST_ID/comments" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt \
    -F "content=Comment on post to delete" \
    -F "image=@test_image.png")

POST_DEL_IMG_URL=$(echo "$POST_DEL_COMMENT" | grep -o '"/static/uploads/[^"]*"' | tr -d '"')
POST_DEL_IMG_FILE="${POST_DEL_IMG_URL#/static/uploads/}"

if [ ! -f "static/uploads/$POST_DEL_IMG_FILE" ]; then
    echo "✗ Image file not found before post deletion"
    exit 1
fi

# Delete the post
curl -s -X DELETE "$API/api/posts/$NEW_POST_ID" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b cookies.txt > /dev/null

# Verify file was removed
if [ -f "static/uploads/$POST_DEL_IMG_FILE" ]; then
    echo "✗ Comment image file not removed after post deletion"
    exit 1
fi
echo "✓ Comment image file removed on post deletion"

echo ""
echo "=== All 13 comment image tests passed ==="
