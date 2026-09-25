#!/bin/bash

# SPA route tests - verify that /profile and /u/<id> serve beebo.html correctly.
# These tests hit whatever server is running on localhost:5050.

echo "=== Testing SPA Routes ==="
echo ""

# 1. Test /profile route
echo "1. Testing GET /profile..."
PROFILE_RESP=$(curl -s -w "\n%{http_code}" http://localhost:5050/profile)
PROFILE_BODY=$(echo "$PROFILE_RESP" | head -n -1)
PROFILE_HTTP_CODE=$(echo "$PROFILE_RESP" | tail -n 1)

if [ "$PROFILE_HTTP_CODE" = "200" ]; then
  echo "   ✓ PASS: Returns 200"
else
  echo "   ✗ FAIL: Expected 200, got $PROFILE_HTTP_CODE"
fi

if echo "$PROFILE_BODY" | grep -q "<!DOCTYPE html>"; then
  echo "   ✓ PASS: Returns HTML content"
else
  echo "   ✗ FAIL: Response does not appear to be HTML"
fi

if echo "$PROFILE_BODY" | grep -q "beebo\|Beebo"; then
  echo "   ✓ PASS: Content appears to be beebo.html"
else
  echo "   ✗ FAIL: Content does not appear to be beebo.html"
fi
echo ""

# 2. Test /u/<id> route with a valid-format ID
echo "2. Testing GET /u/5..."
USER_RESP=$(curl -s -w "\n%{http_code}" http://localhost:5050/u/5)
USER_BODY=$(echo "$USER_RESP" | head -n -1)
USER_HTTP_CODE=$(echo "$USER_RESP" | tail -n 1)

if [ "$USER_HTTP_CODE" = "200" ]; then
  echo "   ✓ PASS: Returns 200"
else
  echo "   ✗ FAIL: Expected 200, got $USER_HTTP_CODE"
fi

if echo "$USER_BODY" | grep -q "<!DOCTYPE html>"; then
  echo "   ✓ PASS: Returns HTML content"
else
  echo "   ✗ FAIL: Response does not appear to be HTML"
fi

if echo "$USER_BODY" | grep -q "beebo\|Beebo"; then
  echo "   ✓ PASS: Content appears to be beebo.html"
else
  echo "   ✗ FAIL: Content does not appear to be beebo.html"
fi
echo ""

# 3. Test /u/<id> with another ID (99999 - doesn't need to exist)
echo "3. Testing GET /u/99999 (nonexistent user ID)..."
USER2_RESP=$(curl -s -w "\n%{http_code}" http://localhost:5050/u/99999)
USER2_BODY=$(echo "$USER2_RESP" | head -n -1)
USER2_HTTP_CODE=$(echo "$USER2_RESP" | tail -n 1)

if [ "$USER2_HTTP_CODE" = "200" ]; then
  echo "   ✓ PASS: Returns 200 (route serves static file regardless of user existence)"
else
  echo "   ✗ FAIL: Expected 200, got $USER2_HTTP_CODE"
fi

if echo "$USER2_BODY" | grep -q "<!DOCTYPE html>"; then
  echo "   ✓ PASS: Returns HTML content"
else
  echo "   ✗ FAIL: Response does not appear to be HTML"
fi
echo ""

# 4. Test /u/notanumber (should 404 - int converter rejects it)
echo "4. Testing GET /u/notanumber (invalid ID format)..."
INVALID_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5050/u/notanumber)

if [ "$INVALID_HTTP_CODE" = "404" ]; then
  echo "   ✓ PASS: Returns 404 (int: converter rejects non-integer)"
else
  echo "   ✗ FAIL: Expected 404, got $INVALID_HTTP_CODE"
fi
echo ""

# 5. Verify /profile and / serve the same file
echo "5. Verifying /profile and / serve the same content..."
ROOT_RESP=$(curl -s http://localhost:5050/)
PROFILE_RESP2=$(curl -s http://localhost:5050/profile)

if [ "$ROOT_RESP" = "$PROFILE_RESP2" ]; then
  echo "   ✓ PASS: Both routes serve identical content"
else
  echo "   ✗ FAIL: Content differs between / and /profile"
fi
echo ""

# 6. Verify /u/<id> and / serve the same file
echo "6. Verifying /u/1 and / serve the same content..."
USER_ROUTE_RESP=$(curl -s http://localhost:5050/u/1)

if [ "$ROOT_RESP" = "$USER_ROUTE_RESP" ]; then
  echo "   ✓ PASS: Both routes serve identical content"
else
  echo "   ✗ FAIL: Content differs between / and /u/1"
fi
echo ""

echo "=== Test Complete ==="
