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
[[ "$CODE" == "201" && "$(json_get "$BODY" "'user_id' in d and 'author_handle' in d and 'like_count' in d and 'comment_count' in d and 'liked_by_user' in d and 'images' in d and 'community' in d and d['community']['slug'] == '$SLUG'")" == "True" ]] \
    && pass "Post -> 201 with full post shape + community key" || fail "Post: $CODE $BODY"
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

# --- Phase 3: Full post pipeline integration ---

# Multipart post with images
echo "Test image content" > /tmp/test_img_${RUN_ID}.txt
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" # multipart tested manually for now
# JSON post still works
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" '{"content":"json post"}'
[[ "$CODE" == "201" ]] && pass "JSON post (without images) -> 201" || fail "JSON post: $CODE"

# Logged out viewer gets liked_by_user=false
req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts"
ANON_LIKED=$(json_get "$BODY" "all(not p['liked_by_user'] for p in d['posts'])")
[[ "$ANON_LIKED" == "True" ]] && pass "Logged out -> liked_by_user false for all posts" || fail "Anon liked: $BODY"

# Like a community post
SOME_POST_ID=$(json_get "$BODY" "d['posts'][0]['id']")
req "$JAR_A" "$CSRF_A" POST "/api/posts/$SOME_POST_ID/like"
[[ "$CODE" == "200" && "$(json_get "$BODY" "d['liked']")" == "True" ]] && pass "Like community post -> 200" || fail "Like: $CODE $BODY"

# Verify like appears in community list for that user
req "$JAR_A" "" GET "/api/communities/$SLUG/posts"
LIKED_IN_LIST=$(json_get "$BODY" "any(p['id'] == $SOME_POST_ID and p['liked_by_user'] for p in d['posts'])")
[[ "$LIKED_IN_LIST" == "True" ]] && pass "Liked post shows liked_by_user=true in community list" || fail "Liked in list: $BODY"

# Comment on community post
req "$JAR_A" "$CSRF_A" POST "/api/posts/$SOME_POST_ID/comments" '{"content":"test comment"}'
[[ "$CODE" == "201" ]] && pass "Comment on community post -> 201" || fail "Comment: $CODE"

# Verify comment count updated in community list
req "$JAR_A" "" GET "/api/communities/$SLUG/posts"
COMMENT_COUNT=$(json_get "$BODY" "next((p['comment_count'] for p in d['posts'] if p['id'] == $SOME_POST_ID), 0)")
[[ "$COMMENT_COUNT" -ge "1" ]] && pass "Comment count updated in community list" || fail "Comment count: $COMMENT_COUNT"

# Delete community post (by author)
MY_POST_ID=$(json_get "$BODY" "next((p['id'] for p in d['posts'] if 'json post' in p['content']), None)")
req "$JAR_B" "$CSRF_B" DELETE "/api/posts/$MY_POST_ID"
[[ "$CODE" == "200" ]] && pass "Delete own community post -> 200" || fail "Delete: $CODE"

# Verify deleted post no longer in list
req "$JAR_B" "" GET "/api/communities/$SLUG/posts"
DELETED_ABSENT=$(json_get "$BODY" "not any(p['id'] == $MY_POST_ID for p in d['posts'])")
[[ "$DELETED_ABSENT" == "True" ]] && pass "Deleted post removed from community list" || fail "Deleted still present: $BODY"

# Try to delete another user's post -> 403 (use a different post that still exists)
OTHER_POST_ID=$(json_get "$BODY" "next((p['id'] for p in d['posts'] if p['id'] != $MY_POST_ID), None)")
req "$JAR_A" "$CSRF_A" DELETE "/api/posts/$OTHER_POST_ID"
[[ "$CODE" == "403" ]] && pass "Delete other user's post -> 403" || fail "Delete other: $CODE"

# Community posts excluded from global search
req "$JAR_ANON" "" GET "/api/search?q=$RUN_ID&type=posts"
SEARCH_EXCLUDED=$(json_get "$BODY" "not any('$RUN_ID' in p['content'] for p in d.get('posts', []))")
[[ "$SEARCH_EXCLUDED" == "True" ]] && pass "Community posts excluded from global search" || fail "Search leak: $BODY"

# Community posts excluded from profile post_count
req "$JAR_B" "" GET "/api/users/$(json_get "$(req "$JAR_B" "" GET /api/session; echo "$BODY")" "d['user']['id']")"
PROFILE_COUNT=$(json_get "$BODY" "d['post_count']")
# User B created 3 community posts in this community, but post_count should not include them
[[ "$PROFILE_COUNT" == "0" ]] && pass "Community posts excluded from profile post_count" || fail "Profile count: $PROFILE_COUNT"

# Pagination with 21+ posts
for i in {4..22}; do
    req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" "{\"content\":\"pagination test $i\"}" > /dev/null 2>&1
done
req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts?limit=20"
PAGE1_COUNT=$(json_get "$BODY" "len(d['posts'])")
PAGE1_CURSOR=$(json_get "$BODY" "d['next_cursor']")
[[ "$PAGE1_COUNT" == "20" && "$PAGE1_CURSOR" != "None" ]] && pass "Pagination: first page has 20 items + cursor" || fail "Page 1: $BODY"

req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts?limit=20&cursor=$PAGE1_CURSOR"
PAGE2_COUNT=$(json_get "$BODY" "len(d['posts'])")
PAGE2_CURSOR=$(json_get "$BODY" "d['next_cursor']")
[[ "$PAGE2_COUNT" -ge "1" && "$PAGE2_CURSOR" == "None" ]] && pass "Pagination: last page has null cursor" || fail "Page 2: $BODY"

# No duplicates across pages
req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts?limit=20"
P1_IDS=$(json_get "$BODY" "[p['id'] for p in d['posts']]")
CURS=$(json_get "$BODY" "d['next_cursor']")
req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts?limit=20&cursor=$CURS"
P2_IDS=$(json_get "$BODY" "[p['id'] for p in d['posts']]")
NO_DUPE_POSTS=$(python3 -c "p1=$P1_IDS; p2=$P2_IDS; print(len(set(p1) & set(p2)) == 0)")
[[ "$NO_DUPE_POSTS" == "True" ]] && pass "Pagination: no duplicates" || fail "Dupe posts"

# Main feed unchanged (regression)
req "$JAR_ANON" "" GET "/api/posts?limit=5"
MAIN_FEED_SHAPE=$(json_get "$BODY" "'posts' in d and 'next_cursor' in d and all('user_id' in p and 'author_handle' in p for p in d['posts'])")
[[ "$MAIN_FEED_SHAPE" == "True" ]] && pass "Main feed response unchanged (regression)" || fail "Main feed: $BODY"

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

# --- Browse/search directory (GET /api/communities) ---
req "$JAR_ANON" "" GET /api/communities
[[ "$CODE" == "200" && "$(json_get "$BODY" "'communities' in d and 'next_cursor' in d")" == "True" ]] \
    && pass "List communities logged out -> 200 with shape" || fail "List anon: $CODE $BODY"

# Check that public community appears with correct membership state
req "$JAR_A" "" GET /api/communities
FOUND_PUBLIC=$(json_get "$BODY" "any(c['slug'] == '$SLUG' and c['membership']['is_member'] and c['membership']['role'] == 'creator' for c in d['communities'])")
[[ "$FOUND_PUBLIC" == "True" ]] && pass "Public community appears with creator membership" || fail "Public community in list: $BODY"

req "$JAR_B" "" GET /api/communities
FOUND_AS_B=$(json_get "$BODY" "any(c['slug'] == '$SLUG' and not c['membership']['is_member'] and c['membership']['role'] is None for c in d['communities'])")
[[ "$FOUND_AS_B" == "True" ]] && pass "Public community shows non-member state for user B" || fail "Public as B: $BODY"

req "$JAR_ANON" "" GET /api/communities
FOUND_ANON=$(json_get "$BODY" "any(c['slug'] == '$SLUG' and not c['membership']['is_member'] and c['membership']['role'] is None for c in d['communities'])")
[[ "$FOUND_ANON" == "True" ]] && pass "Public community shows non-member state when logged out" || fail "Public anon: $BODY"

# Search by name (case-insensitive)
req "$JAR_ANON" "" GET "/api/communities?q=test"
MATCHES_NAME=$(json_get "$BODY" "any('test' in c['name'].lower() for c in d['communities'])")
[[ "$CODE" == "200" && "$MATCHES_NAME" == "True" ]] && pass "Search by name (case-insensitive) works" || fail "Search name: $BODY"

# Search by description
req "$JAR_ANON" "" GET "/api/communities?q=community"
MATCHES_DESC=$(json_get "$BODY" "any('community' in c['description'].lower() for c in d['communities'])")
[[ "$CODE" == "200" && "$MATCHES_DESC" == "True" ]] && pass "Search by description works" || fail "Search desc: $BODY"

# Search by slug
req "$JAR_ANON" "" GET "/api/communities?q=$SLUG"
MATCHES_SLUG=$(json_get "$BODY" "any(c['slug'] == '$SLUG' for c in d['communities'])")
[[ "$CODE" == "200" && "$MATCHES_SLUG" == "True" ]] && pass "Search by slug works" || fail "Search slug: $BODY"

# Non-matching search returns empty
UNIQUE_SEARCH="nosuchcommunity${RUN_ID}xyzabc"
req "$JAR_ANON" "" GET "/api/communities?q=$UNIQUE_SEARCH"
[[ "$(json_get "$BODY" "len(d['communities'])")" == "0" ]] && pass "Non-matching search returns empty array" || fail "Empty search: $BODY"

# LIKE escaping: % and _ should not be wildcards
req "$JAR_ANON" "" GET "/api/communities?q=%"
NOT_ALL=$(json_get "$BODY" "len(d['communities'])")
req "$JAR_ANON" "" GET /api/communities
ALL_COUNT=$(json_get "$BODY" "len(d['communities'])")
[[ "$NOT_ALL" != "$ALL_COUNT" ]] && pass "Search for % does not match everything (escaped)" || fail "% escape: found $NOT_ALL vs all $ALL_COUNT"

req "$JAR_ANON" "" GET "/api/communities?q=_"
NOT_ALL_UNDER=$(json_get "$BODY" "len(d['communities'])")
[[ "$NOT_ALL_UNDER" != "$ALL_COUNT" ]] && pass "Search for _ does not match everything (escaped)" || fail "_ escape: found $NOT_ALL_UNDER vs all $ALL_COUNT"

# Private community never appears
req "$JAR_ANON" "" GET /api/communities
PRIVATE_ABSENT=$(json_get "$BODY" "not any(c['slug'] == '$SLUG2' for c in d['communities'])")
[[ "$PRIVATE_ABSENT" == "True" ]] && pass "Private community excluded from list" || fail "Private in list: $BODY"

req "$JAR_B" "" GET "/api/communities?q=$SLUG2"
PRIVATE_SEARCH=$(json_get "$BODY" "not any(c['slug'] == '$SLUG2' for c in d['communities'])")
[[ "$PRIVATE_SEARCH" == "True" ]] && pass "Private community excluded from search by name" || fail "Private in search: $BODY"

# Pagination
SLUG_P1="testpag1${RUN_ID}"
SLUG_P2="testpag2${RUN_ID}"
SLUG_P3="testpag3${RUN_ID}"
req "$JAR_A" "$CSRF_A" POST /api/communities "{\"name\":\"Pagination 1\",\"description\":\"p1\",\"topic\":\"gaming\",\"type\":\"public\"}"
req "$JAR_A" "$CSRF_A" POST /api/communities "{\"name\":\"Pagination 2\",\"description\":\"p2\",\"topic\":\"gaming\",\"type\":\"public\"}"
req "$JAR_A" "$CSRF_A" POST /api/communities "{\"name\":\"Pagination 3\",\"description\":\"p3\",\"topic\":\"gaming\",\"type\":\"public\"}"

req "$JAR_ANON" "" GET "/api/communities?limit=2"
PAGE1_LEN=$(json_get "$BODY" "len(d['communities'])")
PAGE1_CURSOR=$(json_get "$BODY" "d['next_cursor']")
[[ "$PAGE1_LEN" == "2" && "$PAGE1_CURSOR" != "None" ]] && pass "Pagination: limit=2 returns 2 items with cursor" || fail "Page 1: $BODY"

req "$JAR_ANON" "" GET "/api/communities?limit=2&cursor=$PAGE1_CURSOR"
PAGE2_LEN=$(json_get "$BODY" "len(d['communities'])")
PAGE2_CURSOR=$(json_get "$BODY" "d['next_cursor']")
[[ "$PAGE2_LEN" -ge "1" ]] && pass "Pagination: cursor returns more items" || fail "Page 2: $BODY"

# Collect all ids from both pages to check for duplicates
req "$JAR_ANON" "" GET "/api/communities?limit=2"
PAGE1_IDS=$(json_get "$BODY" "[c['id'] for c in d['communities']]")
CURSOR=$(json_get "$BODY" "d['next_cursor']")
req "$JAR_ANON" "" GET "/api/communities?limit=2&cursor=$CURSOR"
PAGE2_IDS=$(json_get "$BODY" "[c['id'] for c in d['communities']]")
NO_DUPES=$(python3 -c "p1=$PAGE1_IDS; p2=$PAGE2_IDS; print(len(set(p1) & set(p2)) == 0)")
[[ "$NO_DUPES" == "True" ]] && pass "Pagination: no duplicates across pages" || fail "Duplicates: page1=$PAGE1_IDS page2=$PAGE2_IDS"

# Final page has null cursor
req "$JAR_ANON" "" GET "/api/communities?limit=9999"
FINAL_CURSOR=$(json_get "$BODY" "d['next_cursor']")
[[ "$FINAL_CURSOR" == "None" ]] && pass "Pagination: last page has null cursor" || fail "Final cursor: $FINAL_CURSOR"

# Bad limit and cursor values return 200
req "$JAR_ANON" "" GET "/api/communities?limit=0"
[[ "$CODE" == "200" ]] && pass "limit=0 returns 200 (clamped)" || fail "limit=0: $CODE"

req "$JAR_ANON" "" GET "/api/communities?limit=9999"
[[ "$CODE" == "200" ]] && pass "limit=9999 returns 200 (clamped)" || fail "limit=9999: $CODE"

req "$JAR_ANON" "" GET "/api/communities?limit=abc"
[[ "$CODE" == "200" ]] && pass "limit=abc returns 200 (ignored)" || fail "limit=abc: $CODE"

req "$JAR_ANON" "" GET "/api/communities?cursor=abc"
[[ "$CODE" == "200" ]] && pass "cursor=abc returns 200 (ignored)" || fail "cursor=abc: $CODE"

# No pk/integer-id leak beyond 'id' field (which is the slug)
req "$JAR_ANON" "" GET /api/communities
NO_PK_LEAK=$(json_get "$BODY" "all(c['id'] == c['slug'] and isinstance(c['id'], str) for c in d['communities'])")
[[ "$NO_PK_LEAK" == "True" ]] && pass "No integer pk leaked (id == slug)" || fail "PK leak check: $BODY"

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ $FAILED -eq 0 ]]
