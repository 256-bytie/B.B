#!/bin/bash

# Tests for the Communities API (app/routes/communities.py).
# Run against a server started with an isolated DB (never beebo.db):
#   DB_PATH=beebo_test.db python app.py &
#   ./tests/test_communities.sh
# Uses unique per-run emails/names, so it's safe to re-run against the
# same test database.

BASE_URL="http://127.0.0.1:5050"
PASSED=0
FAILED=0
RUN_ID="$(date +%s)$$"
EMAIL_A="comm_a_${RUN_ID}@example.com"
EMAIL_B="comm_b_${RUN_ID}@example.com"
JAR_A="comm_cookie_a_${RUN_ID}.txt"
JAR_B="comm_cookie_b_${RUN_ID}.txt"
JAR_ANON="comm_cookie_anon_${RUN_ID}.txt"
NAME="Test Comm ${RUN_ID: -6}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${YELLOW}ℹ INFO${NC}: $1"; }
cleanup() { rm -f "$JAR_A" "$JAR_B" "$JAR_ANON"; }
trap cleanup EXIT

json_get() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print($2)" "$1" 2>/dev/null; }

signup() { # jar email -> csrf token
    curl -s -c "$1" -b "$1" -X POST "$BASE_URL/api/signup" \
        -H "Content-Type: application/json" \
        -d "{\"full_name\":\"Community Tester\",\"email\":\"$2\",\"password\":\"testpass123\"}" \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('csrf_token',''))"
}

# req JAR CSRF METHOD PATH [JSON] -> sets BODY and CODE
req() {
    local args=(-s -w "\n%{http_code}" -b "$1" -X "$3" "$BASE_URL$4")
    [[ -n "$2" ]] && args+=(-H "X-CSRF-Token: $2")
    [[ -n "$5" ]] && args+=(-H "Content-Type: application/json" -d "$5")
    local resp; resp=$(curl "${args[@]}")
    BODY=$(echo "$resp" | sed '$d'); CODE=$(echo "$resp" | tail -n1)
}

info "Starting Communities tests"
curl -s -c "$JAR_ANON" "$BASE_URL/api/session" > /dev/null

CSRF_A=$(signup "$JAR_A" "$EMAIL_A")
CSRF_B=$(signup "$JAR_B" "$EMAIL_B")
[[ -n "$CSRF_A" && -n "$CSRF_B" ]] && pass "Signed up users A and B" || { fail "Signup failed - aborting"; exit 1; }

# --- Create: auth, CSRF, validation ---
req "$JAR_ANON" "" POST /api/communities '{"name":"x","description":"y","topic":"gaming","type":"public"}'
[[ "$CODE" == "403" || "$CODE" == "401" ]] && pass "Create logged out rejected ($CODE)" || fail "Create logged out: $CODE $BODY"
req "$JAR_A" "" POST /api/communities '{"name":"x","description":"y","topic":"gaming","type":"public"}'
[[ "$CODE" == "403" ]] && pass "Create without CSRF rejected (403)" || fail "Create without CSRF: $CODE"
req "$JAR_A" "$CSRF_A" POST /api/communities '{"name":"x","description":"y","topic":"gaming","type":"secret"}'
[[ "$CODE" == "400" && -n "$(json_get "$BODY" "d['error']")" ]] && pass "Invalid type -> 400 {error}" || fail "Invalid type: $CODE $BODY"
req "$JAR_A" "$CSRF_A" POST /api/communities '{"name":"   ","description":"y","topic":"gaming","type":"public"}'
[[ "$CODE" == "400" ]] && pass "Empty name -> 400" || fail "Empty name: $CODE $BODY"
req "$JAR_A" "$CSRF_A" POST /api/communities '{"name":"x","description":"","topic":"gaming","type":"public"}'
[[ "$CODE" == "400" ]] && pass "Empty description -> 400" || fail "Empty description: $CODE $BODY"

# --- Create ---
req "$JAR_A" "$CSRF_A" POST /api/communities "{\"name\":\"$NAME\",\"description\":\"A test community\",\"topic\":\"student-life\",\"type\":\"public\"}"
SLUG=$(json_get "$BODY" "d['slug']")
[[ "$CODE" == "201" ]] && pass "Create -> 201" || fail "Create: $CODE $BODY"
[[ "$SLUG" =~ ^[a-z0-9]+$ && "$(json_get "$BODY" "d['id']")" == "$SLUG" ]] && pass "slug is [a-z0-9]+ and id == slug ($SLUG)" || fail "Bad slug/id: $BODY"
[[ "$(json_get "$BODY" "d['member_count']")" == "1" ]] && pass "member_count starts at 1" || fail "member_count: $BODY"
[[ "$(json_get "$BODY" "(d['membership']['is_member'], d['membership']['role'])")" == "(True, 'creator')" ]] && pass "Creator membership" || fail "membership: $BODY"
[[ "$(json_get "$BODY" "d['icon_bg'].startswith('bg-') and bool(d['icon_emoji']) and d['created_at'].endswith('Z')")" == "True" ]] && pass "icon_bg/icon_emoji/created_at shaped" || fail "shape: $BODY"

req "$JAR_B" "$CSRF_B" POST /api/communities "{\"name\":\"$NAME\",\"description\":\"dupe\",\"topic\":\"my custom topic\",\"type\":\"private\"}"
SLUG2=$(json_get "$BODY" "d['slug']")
[[ "$CODE" == "201" && -n "$SLUG2" && "$SLUG2" != "$SLUG" && "$SLUG2" == "$SLUG"* ]] && pass "Duplicate name gets suffixed slug ($SLUG2)" || fail "Dupe slug: $CODE $BODY"
[[ "$(json_get "$BODY" "d['icon_bg']")" == "bg-gray-100" ]] && pass "Custom topic uses fallback palette" || fail "Custom topic icon_bg: $BODY"

req "$JAR_A" "$CSRF_A" POST /api/communities '{"name":"mine","description":"reserved","topic":"gaming","type":"public"}'
[[ "$(json_get "$BODY" "d['slug']")" != "mine" ]] && pass "Reserved slug 'mine' not allocated" || fail "Got slug mine: $BODY"

# --- Get ---
req "$JAR_ANON" "" GET "/api/communities/$SLUG"
[[ "$CODE" == "200" && "$(json_get "$BODY" "(d['membership']['is_member'], d['membership']['role'])")" == "(False, None)" ]] \
    && pass "Get logged out -> 200, not a member" || fail "Anon get: $CODE $BODY"
req "$JAR_B" "" GET "/api/communities/$SLUG"
[[ "$(json_get "$BODY" "d['membership']['role']")" == "None" ]] && pass "Get as non-member -> role null" || fail "B get: $BODY"
req "$JAR_ANON" "" GET "/api/communities/nosuchcommunity${RUN_ID}"
[[ "$CODE" == "404" && "$(json_get "$BODY" "d['error']")" == "Community not found" ]] && pass "Unknown slug -> 404" || fail "404: $CODE $BODY"

# --- Posting requires membership ---
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" '{"content":"hi"}'
[[ "$CODE" == "403" && "$(json_get "$BODY" "d['error']")" == "Join this community to post" ]] && pass "Non-member post -> 403" || fail "Non-member post: $CODE $BODY"

# --- Join (idempotent) ---
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/join"
[[ "$CODE" == "200" && "$(json_get "$BODY" "(d['member_count'], d['membership']['role'])")" == "(2, 'member')" ]] && pass "Join -> member, count 2" || fail "Join: $CODE $BODY"
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/join"
[[ "$CODE" == "200" && "$(json_get "$BODY" "d['member_count']")" == "2" ]] && pass "Second join is a no-op" || fail "Rejoin: $CODE $BODY"

# --- Post ---
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" '{"content":"   "}'
[[ "$CODE" == "400" ]] && pass "Empty post -> 400" || fail "Empty post: $CODE $BODY"
LONG=$(python3 -c "print('a'*2001)")
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" "{\"content\":\"$LONG\"}"
[[ "$CODE" == "400" ]] && pass "Over-length post -> 400" || fail "Long post: $CODE"

for i in 1 2 3; do
    req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" "{\"content\":\"community post $i $RUN_ID\"}"
done
[[ "$CODE" == "201" && "$(json_get "$BODY" "sorted(d.keys()) == ['author','avatar_seed','content','created_at','id'] and d['author'] == d['avatar_seed']")" == "True" ]] \
    && pass "Post -> 201 with expected shape" || fail "Post: $CODE $BODY"
LAST_ID=$(json_get "$BODY" "d['id']")

req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts?limit=2"
[[ "$(json_get "$BODY" "len(d['posts'])")" == "2" && "$(json_get "$BODY" "d['posts'][0]['id']")" == "$LAST_ID" ]] \
    && pass "List posts (logged out), newest first, limit honored" || fail "List: $BODY"
CURSOR=$(json_get "$BODY" "d['next_cursor']")
req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts?limit=2&cursor=$CURSOR"
[[ "$(json_get "$BODY" "(len(d['posts']), d['next_cursor'])")" == "(1, None)" ]] && pass "Cursor page 2 ends with next_cursor null" || fail "Page 2: $BODY"

req "$JAR_ANON" "" GET "/api/communities/$SLUG2/posts"
[[ "$(json_get "$BODY" "len(d['posts'])")" == "0" ]] && pass "Posts are scoped to their community" || fail "Scope: $BODY"

req "$JAR_ANON" "" GET "/api/posts?limit=50"
[[ "$(json_get "$BODY" "any('$RUN_ID' in p['content'] for p in d['posts'])")" == "False" ]] && pass "Community posts excluded from main feed" || fail "Leaked into /api/posts"

# --- Mine ---
req "$JAR_ANON" "" GET /api/communities/mine
[[ "$CODE" == "401" ]] && pass "/mine logged out -> 401" || fail "/mine anon: $CODE"
req "$JAR_B" "" GET /api/communities/mine
[[ "$(json_get "$BODY" "[c['slug'] for c in d['communities']]")" == "['$SLUG', '$SLUG2']" ]] \
    && pass "/mine lists memberships, most recently joined first" || fail "/mine B: $BODY"

# --- Leave ---
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/leave"
[[ "$CODE" == "200" && "$(json_get "$BODY" "(d['member_count'], d['membership']['is_member'], d['membership']['role'])")" == "(1, False, None)" ]] \
    && pass "Leave -> not a member, count 1" || fail "Leave: $CODE $BODY"
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" '{"content":"after leaving"}'
[[ "$CODE" == "403" ]] && pass "Can't post after leaving" || fail "Post after leave: $CODE"

# --- Creator cannot leave ---
req "$JAR_A" "$CSRF_A" POST "/api/communities/$SLUG/leave"
[[ "$CODE" == "400" && -n "$(json_get "$BODY" "d['error']")" ]] && pass "Creator leave -> 400" || fail "Creator leave: $CODE $BODY"
req "$JAR_A" "" GET "/api/communities/$SLUG"
[[ "$(json_get "$BODY" "d['membership']['role']")" == "creator" ]] && pass "Creator still a member after rejected leave" || fail "Creator state: $BODY"

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ $FAILED -eq 0 ]]
