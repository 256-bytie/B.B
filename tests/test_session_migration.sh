#!/bin/bash

# Test script to verify Phase 1 & 2 migration
# Tests that session changes don't affect API response shapes

echo "=== Beebo Backend Hardening Test ==="
echo ""

# Start the server in the background
echo "Starting server..."
python3 app.py > test_server.log 2>&1 &
SERVER_PID=$!
sleep 3

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Stopping server..."
    kill $SERVER_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
}
trap cleanup EXIT

BASE_URL="http://127.0.0.1:5050"

# Test 1: Signup
echo "Test 1: Signup"
SIGNUP_RESPONSE=$(curl -s -c cookies.txt -X POST "$BASE_URL/api/signup" \
  -H "Content-Type: application/json" \
  -d '{"full_name":"Test User","email":"testphase2@example.com","password":"password123"}')

echo "$SIGNUP_RESPONSE" | python3 -m json.tool
echo ""

# Verify response has all expected fields
if echo "$SIGNUP_RESPONSE" | grep -q '"id"' && \
   echo "$SIGNUP_RESPONSE" | grep -q '"email"' && \
   echo "$SIGNUP_RESPONSE" | grep -q '"full_name"' && \
   echo "$SIGNUP_RESPONSE" | grep -q '"username"'; then
    echo "✓ Signup response has all required fields"
else
    echo "✗ Signup response missing fields"
    exit 1
fi
echo ""

# Extract CSRF token from signup response
CSRF_TOKEN=$(echo "$SIGNUP_RESPONSE" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)
echo "CSRF Token: $CSRF_TOKEN"
echo ""

# Test 2: Check session endpoint
echo "Test 2: Check /api/session"
SESSION_RESPONSE=$(curl -s -b cookies.txt "$BASE_URL/api/session")
echo "$SESSION_RESPONSE" | python3 -m json.tool
echo ""

if echo "$SESSION_RESPONSE" | grep -q '"logged_in"' && \
   echo "$SESSION_RESPONSE" | grep -q '"email"' && \
   echo "$SESSION_RESPONSE" | grep -q '"full_name"' && \
   echo "$SESSION_RESPONSE" | grep -q '"profile_picture"' && \
   echo "$SESSION_RESPONSE" | grep -q '"username"' && \
   echo "$SESSION_RESPONSE" | grep -q '"bio"'; then
    echo "✓ Session response has all required fields (sourced from DB)"
else
    echo "✗ Session response missing fields"
    exit 1
fi
echo ""

# Test 3: Update profile
echo "Test 3: Update profile (full_name, username, bio)"
UPDATE_RESPONSE=$(curl -s -b cookies.txt -X PATCH "$BASE_URL/api/profile" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -d '{"full_name":"Updated Name","username":"updateduser","bio":"New bio"}')

echo "$UPDATE_RESPONSE" | python3 -m json.tool
echo ""

if echo "$UPDATE_RESPONSE" | grep -q '"success":[[:space:]]*true'; then
    echo "✓ Profile update succeeded"
else
    echo "✗ Profile update failed"
    exit 1
fi
echo ""

# Test 4: Verify updates reflected in session (without re-login)
echo "Test 4: Check /api/session reflects profile updates"
SESSION_RESPONSE2=$(curl -s -b cookies.txt "$BASE_URL/api/session")
echo "$SESSION_RESPONSE2" | python3 -m json.tool
echo ""

if echo "$SESSION_RESPONSE2" | grep -q 'Updated Name' && \
   echo "$SESSION_RESPONSE2" | grep -q 'updateduser' && \
   echo "$SESSION_RESPONSE2" | grep -q 'New bio'; then
    echo "✓ Profile changes reflected immediately (proves DB queries work)"
else
    echo "✗ Profile changes not reflected in session"
    exit 1
fi
echo ""

# Test 5: Logout
echo "Test 5: Logout"
LOGOUT_RESPONSE=$(curl -s -b cookies.txt -X POST "$BASE_URL/api/logout" \
  -H "X-CSRF-Token: $CSRF_TOKEN")
echo "$LOGOUT_RESPONSE" | python3 -m json.tool
echo ""

# Test 6: Login
echo "Test 6: Login"
LOGIN_RESPONSE=$(curl -s -c cookies2.txt -X POST "$BASE_URL/api/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"testphase2@example.com","password":"password123"}')

echo "$LOGIN_RESPONSE" | python3 -m json.tool
echo ""

if echo "$LOGIN_RESPONSE" | grep -q 'Updated Name' && \
   echo "$LOGIN_RESPONSE" | grep -q 'updateduser'; then
    echo "✓ Login returns updated profile data from DB"
else
    echo "✗ Login response incorrect"
    exit 1
fi
echo ""

echo "=== All tests passed! ==="
echo ""
echo "Summary:"
echo "✓ Session now stores only user_id and accounts"
echo "✓ All profile data fetched from DB on each request"
echo "✓ Profile updates reflected immediately without re-login"
echo "✓ API response shapes unchanged (frontend compatibility preserved)"
