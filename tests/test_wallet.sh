#!/bin/bash

# Tests for the Wallet API: balance, monthly free credits, transaction history.
# Run against a server started with an isolated DB (never beebo.db):
#   DB_PATH=beebo_test.db python app.py &
#   ./test_wallet.sh
# Uses unique per-run emails, so it needs no direct DB access and is safe
# to re-run against the same test database.

BASE_URL="http://127.0.0.1:5050"
PASSED=0
FAILED=0
RUN_ID="$(date +%s)$$"
EMAIL_A="wallet_a_${RUN_ID}@example.com"
EMAIL_B="wallet_b_${RUN_ID}@example.com"
JAR_A="wallet_cookie_a_${RUN_ID}.txt"
JAR_B="wallet_cookie_b_${RUN_ID}.txt"
JAR_ANON="wallet_cookie_anon_${RUN_ID}.txt"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${YELLOW}ℹ INFO${NC}: $1"; }
cleanup() { rm -f "$JAR_A" "$JAR_B" "$JAR_ANON"; }
trap cleanup EXIT

# json_get '<json>' 'python expression on d' -> prints value
json_get() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print($2)" "$1" 2>/dev/null; }

signup() { # jar email -> csrf token
    curl -s -c "$1" -b "$1" -X POST "$BASE_URL/api/signup" \
        -H "Content-Type: application/json" \
        -d "{\"full_name\":\"Wallet Tester\",\"email\":\"$2\",\"password\":\"testpass123\"}" \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('csrf_token',''))"
}

info "Starting Wallet tests"

# --- Auth required ---
curl -s -c "$JAR_ANON" "$BASE_URL/api/session" > /dev/null
for path in /api/wallet /api/wallet/transactions; do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_ANON" "$BASE_URL$path")
    [[ "$CODE" == "401" ]] && pass "GET $path requires login (401)" || fail "GET $path should be 401 logged out, got $CODE"
done

CSRF_A=$(signup "$JAR_A" "$EMAIL_A")
[[ -n "$CSRF_A" ]] && pass "Signed up user A" || { fail "Signup failed - aborting"; exit 1; }

# --- Fresh wallet ---
R=$(curl -s -b "$JAR_A" "$BASE_URL/api/wallet")
[[ "$(json_get "$R" "d['balance']")" == "0" ]] && pass "New user starts at 0 credits" || fail "Expected balance 0, got: $R"
[[ "$(json_get "$R" "d['monthly_reward']['claimable']")" == "True" ]] && pass "Monthly reward claimable for a new user" || fail "Expected claimable: $R"
[[ "$(json_get "$R" "d['monthly_reward']['amount']")" == "50" ]] && pass "Monthly reward amount is 50" || fail "Expected amount 50: $R"

R=$(curl -s -b "$JAR_A" "$BASE_URL/api/wallet/transactions")
[[ "$(json_get "$R" "len(d['transactions'])")" == "0" && "$(json_get "$R" "d['next_cursor']")" == "None" ]] \
    && pass "Empty history for a new user" || fail "Expected empty history: $R"

HDR=$(curl -s -D - -o /dev/null -b "$JAR_A" "$BASE_URL/api/wallet" | tr -d '\r' | grep -i '^cache-control:')
[[ "$HDR" == *"no-store"* ]] && pass "Wallet responses are Cache-Control: no-store" || fail "Missing no-store header: '$HDR'"

# --- CSRF ---
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE_URL/api/wallet/claim")
[[ "$CODE" == "403" ]] && pass "Claim without CSRF token rejected (403)" || fail "Expected 403 without CSRF, got $CODE"
R=$(curl -s -b "$JAR_A" "$BASE_URL/api/wallet")
[[ "$(json_get "$R" "d['balance']")" == "0" ]] && pass "Rejected claim granted nothing" || fail "Balance changed by rejected claim: $R"

# --- Claim ---
RESP=$(curl -s -w "\n%{http_code}" -b "$JAR_A" -X POST "$BASE_URL/api/wallet/claim" -H "X-CSRF-Token: $CSRF_A")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "201" ]] && pass "Claim succeeds (201)" || fail "Expected 201, got $CODE: $BODY"
[[ "$(json_get "$BODY" "d['balance']")" == "50" ]] && pass "Balance is 50 after claim" || fail "Expected balance 50: $BODY"
[[ "$(json_get "$BODY" "d['monthly_reward']['claimable']")" == "False" ]] && pass "Reward no longer claimable" || fail "Still claimable: $BODY"
[[ "$(json_get "$BODY" "d['monthly_reward']['next_claim_at'] is not None")" == "True" ]] && pass "next_claim_at is returned" || fail "Missing next_claim_at: $BODY"
[[ "$(json_get "$BODY" "'%s %s %s' % (d['transaction']['amount'], d['transaction']['kind'], d['transaction']['reason'])")" == "50 free monthly_reward" ]] \
    && pass "Claim returns the ledger entry" || fail "Unexpected transaction: $BODY"

# --- Double claim ---
RESP=$(curl -s -w "\n%{http_code}" -b "$JAR_A" -X POST "$BASE_URL/api/wallet/claim" -H "X-CSRF-Token: $CSRF_A")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "409" ]] && pass "Second claim refused (409)" || fail "Expected 409, got $CODE: $BODY"
[[ "$(json_get "$BODY" "d['balance']")" == "50" ]] && pass "Balance unchanged after refused claim" || fail "Balance changed: $BODY"

# --- Persistence: fresh session for the same account still sees it ---
curl -s -c "$JAR_A" -b "$JAR_A" -X POST "$BASE_URL/api/logout" -H "X-CSRF-Token: $CSRF_A" > /dev/null
LOGIN=$(curl -s -c "$JAR_A" -b "$JAR_A" -X POST "$BASE_URL/api/login" -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL_A\",\"password\":\"testpass123\"}")
CSRF_A=$(json_get "$LOGIN" "d.get('csrf_token','')")
R=$(curl -s -b "$JAR_A" "$BASE_URL/api/wallet")
[[ "$(json_get "$R" "d['balance']")" == "50" && "$(json_get "$R" "d['monthly_reward']['claimable']")" == "False" ]] \
    && pass "Balance and claim state persist across logout/login" || fail "State lost after re-login: $R"

# --- History + pagination params ---
R=$(curl -s -b "$JAR_A" "$BASE_URL/api/wallet/transactions?limit=10")
[[ "$(json_get "$R" "len(d['transactions'])")" == "1" && "$(json_get "$R" "d['transactions'][0]['description']")" == "Claimed 50 free credits" ]] \
    && pass "History lists the claim" || fail "Unexpected history: $R"
[[ "$(json_get "$R" "d['transactions'][0]['created_at'].endswith('Z')")" == "True" ]] && pass "Timestamps are ISO-8601 UTC (Z)" || fail "Timestamp format: $R"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" "$BASE_URL/api/wallet/transactions?cursor=abc")
[[ "$CODE" == "400" ]] && pass "Invalid cursor rejected (400)" || fail "Expected 400 for bad cursor, got $CODE"
R=$(curl -s -b "$JAR_A" "$BASE_URL/api/wallet/transactions?limit=99999&cursor=1")
[[ "$(json_get "$R" "d['transactions']")" == "[]" ]] && pass "Huge limit is clamped and cursor is honored" || fail "Unexpected: $R"

# --- Isolation between users ---
CSRF_B=$(signup "$JAR_B" "$EMAIL_B")
R=$(curl -s -b "$JAR_B" "$BASE_URL/api/wallet")
[[ "$(json_get "$R" "d['balance']")" == "0" && "$(json_get "$R" "d['monthly_reward']['claimable']")" == "True" ]] \
    && pass "User B's wallet is independent of user A's" || fail "User B leaked state: $R"
R=$(curl -s -b "$JAR_B" "$BASE_URL/api/wallet/transactions")
[[ "$(json_get "$R" "len(d['transactions'])")" == "0" ]] && pass "User B cannot see user A's history" || fail "History leaked: $R"

# --- Nothing here should have broken existing endpoints ---
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" "$BASE_URL/api/posts")
[[ "$CODE" == "200" ]] && pass "GET /api/posts still works" || fail "GET /api/posts returned $CODE"

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ $FAILED -eq 0 ]]
