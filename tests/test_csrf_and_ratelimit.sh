#!/bin/bash

# Test script for Phase 5: CSRF protection and login rate limiting

BASE_URL="http://127.0.0.1:5050"
PASSED=0
FAILED=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    FAILED=$((FAILED + 1))
}

info() {
    echo -e "${YELLOW}ℹ INFO${NC}: $1"
}

# Cleanup function
cleanup() {
    rm -f csrf_test_cookie.txt csrf_test_cookie2.txt
}

trap cleanup EXIT

# Clean up test users from previous runs
sqlite3 beebo.db "DELETE FROM users WHERE email IN ('csrftest@example.com', 'csrftest2@example.com', 'ratetest@example.com', 'different@example.com');" 2>/dev/null || true

info "Starting CSRF and Rate Limit Tests"
echo ""

# Test 1: GET /api/session returns csrf_token when logged out
info "Test 1: GET /api/session returns csrf_token when logged out"
RESPONSE=$(curl -s -c csrf_test_cookie.txt "$BASE_URL/api/session")
CSRF_TOKEN=$(echo "$RESPONSE" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)
LOGGED_IN=$(echo "$RESPONSE" | grep -o '"logged_in":[^,}]*' | cut -d':' -f2)

if [[ "$LOGGED_IN" == "false" && -n "$CSRF_TOKEN" ]]; then
    pass "Session returns csrf_token when logged out"
else
    fail "Session should return csrf_token when logged out (logged_in=$LOGGED_IN, token=$CSRF_TOKEN)"
fi
echo ""

# Test 2: Signup returns a csrf_token
info "Test 2: Signup returns a new csrf_token"
SIGNUP_RESPONSE=$(curl -s -b csrf_test_cookie.txt -c csrf_test_cookie.txt \
    -X POST "$BASE_URL/api/signup" \
    -H "Content-Type: application/json" \
    -d '{
        "full_name": "CSRF Test User",
        "email": "csrftest@example.com",
        "password": "testpass123"
    }')

NEW_CSRF=$(echo "$SIGNUP_RESPONSE" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)
SUCCESS=$(echo "$SIGNUP_RESPONSE" | grep -o '"success":[^,}]*' | cut -d':' -f2)

if [[ "$SUCCESS" == "true" && -n "$NEW_CSRF" && "$NEW_CSRF" != "$CSRF_TOKEN" ]]; then
    pass "Signup returns rotated csrf_token"
    CSRF_TOKEN="$NEW_CSRF"
else
    fail "Signup should return new csrf_token (success=$SUCCESS, new_token=$NEW_CSRF)"
fi
echo ""

# Test 3: GET /api/session returns csrf_token when logged in
info "Test 3: GET /api/session returns csrf_token when logged in"
SESSION_RESPONSE=$(curl -s -b csrf_test_cookie.txt "$BASE_URL/api/session")
SESSION_CSRF=$(echo "$SESSION_RESPONSE" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)
LOGGED_IN=$(echo "$SESSION_RESPONSE" | grep -o '"logged_in":[^,}]*' | cut -d':' -f2)

if [[ "$LOGGED_IN" == "true" && "$SESSION_CSRF" == "$CSRF_TOKEN" ]]; then
    pass "Session returns same csrf_token when logged in"
else
    fail "Session should return csrf_token when logged in (logged_in=$LOGGED_IN, token=$SESSION_CSRF)"
fi
echo ""

# Test 4: Mutating request without CSRF token is rejected
info "Test 4: POST without X-CSRF-Token header is rejected with 403"
RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie.txt \
    -X POST "$BASE_URL/api/posts" \
    -H "Content-Type: application/json" \
    -d '{"content": "Test post"}')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)
ERROR_MSG=$(echo "$BODY" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)

if [[ "$HTTP_CODE" == "403" && "$ERROR_MSG" == "Invalid CSRF token" ]]; then
    pass "POST without CSRF token rejected with 403"
else
    fail "POST without CSRF token should return 403 (got $HTTP_CODE, error='$ERROR_MSG')"
fi
echo ""

# Test 5: Mutating request with wrong CSRF token is rejected
info "Test 5: POST with wrong X-CSRF-Token is rejected with 403"
RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie.txt \
    -X POST "$BASE_URL/api/posts" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: wrong_token_12345" \
    -d '{"content": "Test post"}')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)
ERROR_MSG=$(echo "$BODY" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)

if [[ "$HTTP_CODE" == "403" && "$ERROR_MSG" == "Invalid CSRF token" ]]; then
    pass "POST with wrong CSRF token rejected with 403"
else
    fail "POST with wrong CSRF token should return 403 (got $HTTP_CODE, error='$ERROR_MSG')"
fi
echo ""

# Test 6: Mutating request with valid CSRF token succeeds
info "Test 6: POST with valid X-CSRF-Token succeeds"
RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie.txt \
    -X POST "$BASE_URL/api/posts" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"content": "Test post with valid CSRF token", "audience": "General"}')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)
POST_ID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -n1 | cut -d':' -f2)

if [[ "$HTTP_CODE" == "201" && -n "$POST_ID" ]]; then
    pass "POST with valid CSRF token succeeded (created post $POST_ID)"
else
    fail "POST with valid CSRF token should succeed (got $HTTP_CODE, post_id=$POST_ID)"
fi
echo ""

# Test 7: PATCH /api/profile requires CSRF token
info "Test 7: PATCH /api/profile requires CSRF token"
RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie.txt \
    -X PATCH "$BASE_URL/api/profile" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"full_name": "CSRF Test Updated", "username": "csrftest", "bio": "Updated bio"}')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)
SUCCESS=$(echo "$BODY" | grep -o '"success":[^,}]*' | cut -d':' -f2)

if [[ "$HTTP_CODE" == "200" && "$SUCCESS" == "true" ]]; then
    pass "PATCH with valid CSRF token succeeded"
else
    fail "PATCH with valid CSRF token should succeed (got $HTTP_CODE, success=$SUCCESS)"
fi
echo ""

# Test 8: DELETE requires CSRF token
info "Test 8: DELETE /api/posts/<id> requires CSRF token"
if [[ -n "$POST_ID" ]]; then
    RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie.txt \
        -X DELETE "$BASE_URL/api/posts/$POST_ID" \
        -H "X-CSRF-Token: $CSRF_TOKEN")

    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | head -n-1)
    SUCCESS=$(echo "$BODY" | grep -o '"success":[^,}]*' | cut -d':' -f2)

    if [[ "$HTTP_CODE" == "200" && "$SUCCESS" == "true" ]]; then
        pass "DELETE with valid CSRF token succeeded"
    else
        fail "DELETE with valid CSRF token should succeed (got $HTTP_CODE, success=$SUCCESS)"
    fi
else
    fail "No post ID to test DELETE"
fi
echo ""

# Test 9: Login returns rotated csrf_token
info "Test 9: Login returns a new csrf_token"
# Logout first
curl -s -b csrf_test_cookie.txt -c csrf_test_cookie.txt \
    -X POST "$BASE_URL/api/logout" \
    -H "X-CSRF-Token: $CSRF_TOKEN" > /dev/null

# Get new session token
SESSION_RESPONSE=$(curl -s -b csrf_test_cookie.txt -c csrf_test_cookie.txt "$BASE_URL/api/session")
OLD_TOKEN=$(echo "$SESSION_RESPONSE" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)

# Login
LOGIN_RESPONSE=$(curl -s -b csrf_test_cookie.txt -c csrf_test_cookie.txt \
    -X POST "$BASE_URL/api/login" \
    -H "Content-Type: application/json" \
    -d '{
        "email": "csrftest@example.com",
        "password": "testpass123"
    }')

LOGIN_CSRF=$(echo "$LOGIN_RESPONSE" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)
SUCCESS=$(echo "$LOGIN_RESPONSE" | grep -o '"success":[^,}]*' | cut -d':' -f2)

if [[ "$SUCCESS" == "true" && -n "$LOGIN_CSRF" && "$LOGIN_CSRF" != "$OLD_TOKEN" ]]; then
    pass "Login returns rotated csrf_token"
    CSRF_TOKEN="$LOGIN_CSRF"
else
    fail "Login should return new csrf_token (success=$SUCCESS, old=$OLD_TOKEN, new=$LOGIN_CSRF)"
fi
echo ""

# Test 10: Account switch returns rotated csrf_token
info "Test 10: Account switch returns a new csrf_token"
# Create second account
SIGNUP2_RESPONSE=$(curl -s -b csrf_test_cookie.txt -c csrf_test_cookie.txt \
    -X POST "$BASE_URL/api/signup" \
    -H "Content-Type: application/json" \
    -d '{
        "full_name": "CSRF Test User 2",
        "email": "csrftest2@example.com",
        "password": "testpass123"
    }')

USER2_ID=$(echo "$SIGNUP2_RESPONSE" | grep -o '"id":[0-9]*' | head -n1 | cut -d':' -f2)
CSRF_AFTER_SIGNUP=$(echo "$SIGNUP2_RESPONSE" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)

if [[ -n "$USER2_ID" ]]; then
    # Get first user's ID
    SESSION_RESPONSE=$(curl -s -b csrf_test_cookie.txt "$BASE_URL/api/session")
    USER1_ID=$(echo "$SESSION_RESPONSE" | grep -o '"accounts":\[[^]]*\]' | grep -o '"id":[0-9]*' | head -n1 | cut -d':' -f2)
    
    if [[ -n "$USER1_ID" ]]; then
        # Switch back to first account
        SWITCH_RESPONSE=$(curl -s -b csrf_test_cookie.txt -c csrf_test_cookie.txt \
            -X POST "$BASE_URL/api/session/switch" \
            -H "Content-Type: application/json" \
            -H "X-CSRF-Token: $CSRF_AFTER_SIGNUP" \
            -d "{\"user_id\": $USER1_ID}")

        SWITCH_CSRF=$(echo "$SWITCH_RESPONSE" | grep -o '"csrf_token":"[^"]*"' | cut -d'"' -f4)
        SUCCESS=$(echo "$SWITCH_RESPONSE" | grep -o '"success":[^,}]*' | cut -d':' -f2)

        if [[ "$SUCCESS" == "true" && -n "$SWITCH_CSRF" && "$SWITCH_CSRF" != "$CSRF_AFTER_SIGNUP" ]]; then
            pass "Account switch returns rotated csrf_token"
        else
            fail "Account switch should return new csrf_token (success=$SUCCESS, old=$CSRF_AFTER_SIGNUP, new=$SWITCH_CSRF)"
        fi
    else
        fail "Could not get first user ID"
    fi
else
    fail "Could not create second user for switch test"
fi
echo ""

# Test 11-16: Login rate limiting
info "Test 11-16: Login rate limiting (5 attempts per email+IP per 15 min)"

# Create a fresh user for rate limit testing
RATE_TEST_EMAIL="ratetest@example.com"
curl -s -c csrf_test_cookie2.txt \
    -X POST "$BASE_URL/api/signup" \
    -H "Content-Type: application/json" \
    -d "{
        \"full_name\": \"Rate Test User\",
        \"email\": \"$RATE_TEST_EMAIL\",
        \"password\": \"correctpass\"
    }" > /dev/null

# Logout
curl -s -b csrf_test_cookie2.txt -X POST "$BASE_URL/api/logout" > /dev/null

# Make 5 failed login attempts
ATTEMPT_COUNT=0
for i in {1..5}; do
    RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie2.txt \
        -X POST "$BASE_URL/api/login" \
        -H "Content-Type: application/json" \
        -d "{
            \"email\": \"$RATE_TEST_EMAIL\",
            \"password\": \"wrongpassword\"
        }")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    if [[ "$HTTP_CODE" == "401" ]]; then
        ATTEMPT_COUNT=$((ATTEMPT_COUNT + 1))
    fi
done

if [[ "$ATTEMPT_COUNT" == "5" ]]; then
    pass "5 failed login attempts allowed"
else
    fail "Should allow 5 failed attempts (got $ATTEMPT_COUNT)"
fi
echo ""

# Test 12: 6th attempt should be rate limited
info "Test 12: 6th failed login attempt returns 429"
RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie2.txt \
    -X POST "$BASE_URL/api/login" \
    -H "Content-Type: application/json" \
    -d "{
        \"email\": \"$RATE_TEST_EMAIL\",
        \"password\": \"wrongpassword\"
    }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)
ERROR_MSG=$(echo "$BODY" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)

if [[ "$HTTP_CODE" == "429" && "$ERROR_MSG" == "Too many login attempts. Please try again later." ]]; then
    pass "6th failed attempt rate limited with 429"
else
    fail "6th attempt should return 429 (got $HTTP_CODE, error='$ERROR_MSG')"
fi
echo ""

# Test 13: Successful login clears rate limit
info "Test 13: Successful login resets rate limit counter"
RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie2.txt \
    -X POST "$BASE_URL/api/login" \
    -H "Content-Type: application/json" \
    -d "{
        \"email\": \"$RATE_TEST_EMAIL\",
        \"password\": \"correctpass\"
    }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)
SUCCESS=$(echo "$BODY" | grep -o '"success":[^,}]*' | cut -d':' -f2)

if [[ "$HTTP_CODE" == "200" && "$SUCCESS" == "true" ]]; then
    pass "Successful login clears rate limit"
else
    fail "Successful login should work (got $HTTP_CODE, success=$SUCCESS)"
fi
echo ""

# Test 14: After successful login, failed attempts start fresh counter
info "Test 14: After successful login, rate limit counter is reset"
# Logout
curl -s -b csrf_test_cookie2.txt -X POST "$BASE_URL/api/logout" > /dev/null

# Try one failed attempt - should work (not still rate limited)
RESPONSE=$(curl -s -w "\n%{http_code}" -b csrf_test_cookie2.txt \
    -X POST "$BASE_URL/api/login" \
    -H "Content-Type: application/json" \
    -d "{
        \"email\": \"$RATE_TEST_EMAIL\",
        \"password\": \"wrongpassword\"
    }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

if [[ "$HTTP_CODE" == "401" ]]; then
    pass "Failed attempt after successful login is allowed (counter reset)"
else
    fail "Should allow failed attempt after successful login (got $HTTP_CODE)"
fi
echo ""

# Test 15: Different email is not affected by other email's rate limit
info "Test 15: Different email unaffected by another's rate limit"
DIFFERENT_EMAIL="different@example.com"
# Create user
curl -s \
    -X POST "$BASE_URL/api/signup" \
    -H "Content-Type: application/json" \
    -d "{
        \"full_name\": \"Different User\",
        \"email\": \"$DIFFERENT_EMAIL\",
        \"password\": \"correctpass\"
    }" > /dev/null

# First make 5 failed attempts on rate_test email to max it out
for i in {1..5}; do
    curl -s -X POST "$BASE_URL/api/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"$RATE_TEST_EMAIL\", \"password\": \"wrongpassword\"}" > /dev/null
done

# Now try the different email - should work (different key)
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$BASE_URL/api/login" \
    -H "Content-Type: application/json" \
    -d "{
        \"email\": \"$DIFFERENT_EMAIL\",
        \"password\": \"wrongpassword\"
    }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

if [[ "$HTTP_CODE" == "401" ]]; then
    pass "Different email unaffected by other email's rate limit"
else
    fail "Different email should be unaffected (got $HTTP_CODE)"
fi
echo ""

# Summary
echo ""
echo "======================================"
echo "Test Summary"
echo "======================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo "======================================"

if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
