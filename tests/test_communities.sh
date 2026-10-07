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
JAR_C="comm_cookie_c_${RUN_ID}.txt"
EMAIL_C="comm_c_${RUN_ID}@example.com"
NAME="Test Comm ${RUN_ID: -6}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${YELLOW}ℹ INFO${NC}: $1"; }
PNG="/tmp/cm_${RUN_ID}.png"; BADFILE="/tmp/cm_${RUN_ID}.txt"
cleanup() { rm -f "$JAR_A" "$JAR_B" "$JAR_C" "$JAR_ANON" "$PNG" "$BADFILE"; }
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

# mreq JAR CSRF PATH [curl -F args...] -> multipart POST, sets BODY and CODE
mreq() {
    local jar="$1" csrf="$2" path="$3"; shift 3
    local resp; resp=$(curl -s -w "\n%{http_code}" -b "$jar" -X POST "$BASE_URL$path" -H "X-CSRF-Token: $csrf" "$@")
    BODY=$(echo "$resp" | sed '$d'); CODE=$(echo "$resp" | tail -n1)
}

# Fixtures: a valid 1x1 PNG and a non-image file.
python3 - "$PNG" <<'PY'
import struct, sys, zlib
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + chunk(b'IEND', b''))
open(sys.argv[1], 'wb').write(png)
PY
echo "not an image" > "$BADFILE"

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
mreq "$JAR_B" "$CSRF_B" "/api/communities/$SLUG/posts" -F "content=nonmember image $RUN_ID" -F "images=@$PNG;type=image/png"
[[ "$CODE" == "403" ]] && pass "Non-member multipart post -> 403" || fail "Non-member multipart: $CODE $BODY"

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

# SLUG2 is private and created by B: B sees an empty list (posts are scoped
# to their community); an outsider gets 404 (Phase 4).
req "$JAR_B" "" GET "/api/communities/$SLUG2/posts"
[[ "$CODE" == "200" && "$(json_get "$BODY" "len(d['posts'])")" == "0" ]] && pass "Posts are scoped to their community" || fail "Scope: $CODE $BODY"
req "$JAR_ANON" "" GET "/api/communities/$SLUG2/posts"
[[ "$CODE" == "404" ]] && pass "Private community posts hidden from outsiders" || fail "Private outsider posts: $CODE $BODY"

# --- Home feed includes community posts (private: members only) ---
req "$JAR_ANON" "" GET "/api/posts?limit=50"
[[ "$CODE" == "200" && "$(json_get "$BODY" "any('$RUN_ID' in p['content'] and p.get('community', {}).get('slug') == '$SLUG' and p['community'].get('name') and p['community']['is_member'] is False for p in d['posts'])")" == "True" ]] \
    && pass "Home feed includes public community posts with community {slug,name,is_member:false} (logged out)" || fail "Home feed community post: $CODE $BODY"

req "$JAR_B" "" GET "/api/posts?limit=50"
[[ "$(json_get "$BODY" "any(p.get('community', {}).get('slug') == '$SLUG' and p['community']['is_member'] is True for p in d['posts'])")" == "True" ]] \
    && pass "Home feed marks is_member:true for the member's own community" || fail "Home feed is_member: $BODY"

PRIV_NAME="Priv${RUN_ID: -6}"
req "$JAR_A" "$CSRF_A" POST "/api/communities" "{\"name\":\"$PRIV_NAME\",\"description\":\"d\",\"topic\":\"Tech\",\"type\":\"private\"}"
PRIV_SLUG=$(json_get "$BODY" "d['id']")
req "$JAR_A" "$CSRF_A" POST "/api/communities/$PRIV_SLUG/posts" "{\"content\":\"private home feed post $RUN_ID\"}"
PRIV_POST_ID=$(json_get "$BODY" "d['id']")
[[ "$CODE" == "201" ]] || fail "Private community post create: $CODE $BODY"
req "$JAR_A" "" GET "/api/posts?limit=50"
[[ "$(json_get "$BODY" "any(p['id'] == $PRIV_POST_ID for p in d['posts'])")" == "True" ]] \
    && pass "Private community post appears in the Home feed for its member" || fail "Private post missing for member: $BODY"
req "$JAR_B" "" GET "/api/posts?limit=50"
B_SEES_PRIV=$(json_get "$BODY" "any(p['id'] == $PRIV_POST_ID for p in d['posts'])")
req "$JAR_ANON" "" GET "/api/posts?limit=50"
ANON_SEES_PRIV=$(json_get "$BODY" "any(p['id'] == $PRIV_POST_ID for p in d['posts'])")
[[ "$B_SEES_PRIV" == "False" && "$ANON_SEES_PRIV" == "False" ]] \
    && pass "Private community post hidden from the Home feed for non-members and logged-out" || fail "Private post leaked: B=$B_SEES_PRIV anon=$ANON_SEES_PRIV"
req "$JAR_A" "$CSRF_A" DELETE "/api/posts/$PRIV_POST_ID"

# --- Phase 3: Full post pipeline integration ---

# --- Multipart posts (images) ---
mreq "$JAR_B" "$CSRF_B" "/api/communities/$SLUG/posts" -F "content=image post $RUN_ID" -F "images=@$PNG;type=image/png"
IMG_POST_ID=$(json_get "$BODY" "d['id']")
IMG_URL=$(json_get "$BODY" "d['images'][0]")
[[ "$CODE" == "201" && "$(json_get "$BODY" "len(d['images']) == 1 and d['community']['slug'] == '$SLUG'")" == "True" ]] \
    && pass "Multipart post with 1 image -> 201, 1 image, community key" || fail "Multipart 1 image: $CODE $BODY"

[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$IMG_URL")" == "200" ]] && pass "Uploaded image is served" || fail "Image not served: $IMG_URL"

mreq "$JAR_B" "$CSRF_B" "/api/communities/$SLUG/posts" -F "content=two images $RUN_ID" -F "images=@$PNG;type=image/png" -F "images=@$PNG;type=image/png"
IMG2_POST_ID=$(json_get "$BODY" "d['id']")
IMG2_URLS=$(json_get "$BODY" "' '.join(d['images'])")
[[ "$CODE" == "201" && "$(json_get "$BODY" "len(d['images']) == 2")" == "True" ]] && pass "Multipart post with 2 images -> 201" || fail "Multipart 2 images: $CODE $BODY"

req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts"
[[ "$(json_get "$BODY" "any(p['id'] == $IMG_POST_ID and p['images'] == ['$IMG_URL'] for p in d['posts'])")" == "True" ]] \
    && pass "Image post lists with its image URL" || fail "Image post in list: $BODY"

mreq "$JAR_B" "$CSRF_B" "/api/communities/$SLUG/posts" -F "content=bad image $RUN_ID" -F "images=@$BADFILE;type=text/plain"
BAD_CODE="$CODE"
req "$JAR_ANON" "" GET "/api/communities/$SLUG/posts"
[[ "$BAD_CODE" == "400" && "$(json_get "$BODY" "not any('bad image $RUN_ID' in p['content'] for p in d['posts'])")" == "True" ]] \
    && pass "Invalid image -> 400 and no post inserted" || fail "Invalid image: $BAD_CODE $BODY"

mreq "$JAR_B" "$CSRF_B" "/api/communities/$SLUG/posts" -F "content=too many $RUN_ID" \
    -F "images=@$PNG;type=image/png" -F "images=@$PNG;type=image/png" -F "images=@$PNG;type=image/png" \
    -F "images=@$PNG;type=image/png" -F "images=@$PNG;type=image/png"
[[ "$CODE" == "400" ]] && pass "More than 4 images -> 400" || fail "5 images: $CODE $BODY"

mreq "$JAR_B" "$CSRF_B" "/api/communities/$SLUG/posts" -F "content=" -F "images=@$PNG;type=image/png"
[[ "$CODE" == "400" ]] && pass "Image with empty content -> 400 (text required)" || fail "Image-only: $CODE $BODY"

mreq "$JAR_ANON" "" "/api/communities/$SLUG/posts" -F "content=anon $RUN_ID" -F "images=@$PNG;type=image/png"
[[ "$CODE" == "401" || "$CODE" == "403" ]] && pass "Logged-out multipart post rejected ($CODE)" || fail "Anon multipart: $CODE"

# Deleting an image post removes its files.
req "$JAR_B" "$CSRF_B" DELETE "/api/posts/$IMG_POST_ID"
D1="$CODE"
req "$JAR_B" "$CSRF_B" DELETE "/api/posts/$IMG2_POST_ID"
D2="$CODE"
GONE=1; for u in $IMG_URL $IMG2_URLS; do [[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$u")" == "404" ]] || GONE=0; done
[[ "$D1" == "200" && "$D2" == "200" && "$GONE" == "1" ]] && pass "Deleting image posts removes image files" || fail "Image cleanup: $D1 $D2 gone=$GONE"

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

# --- Leakage filters ---
# /api/search* require a login (anonymous gets 401), so use JAR_A. Each check
# has a positive control (a main-feed post that MUST be found) so an error
# response can't pass as "nothing leaked".
TAG_C="cmtag${RUN_ID: -6}"; TAG_M="mntag${RUN_ID: -6}"
req "$JAR_B" "$CSRF_B" POST "/api/communities/$SLUG/posts" "{\"content\":\"tagged community post $RUN_ID #$TAG_C\"}"
[[ "$CODE" == "201" ]] || fail "Tagged community post: $CODE $BODY"
req "$JAR_B" "$CSRF_B" POST "/api/posts" "{\"content\":\"main feed post $RUN_ID #$TAG_M\"}"
MAIN_POST_ID=$(json_get "$BODY" "d['id']")
[[ "$CODE" == "201" ]] || fail "Main feed post: $CODE $BODY"

req "$JAR_A" "" GET "/api/search?q=$RUN_ID&type=posts"
[[ "$CODE" == "200" && "$(json_get "$BODY" "any('main feed post' in p['content'] for p in d['posts'])")" == "True" ]] \
    && pass "Search finds the main-feed post (positive control)" || fail "Search control: $CODE $BODY"
[[ "$(json_get "$BODY" "not any('community post' in p['content'] for p in d['posts'])")" == "True" ]] \
    && pass "Community posts excluded from global search" || fail "Search leak: $BODY"

req "$JAR_A" "" GET "/api/search/suggestions?q=$TAG_M"
[[ "$CODE" == "200" && "$(json_get "$BODY" "any(s['text'].lower() == '#$TAG_M' for s in d['suggestions'])")" == "True" ]] \
    && pass "Suggestions include the main-feed hashtag (positive control)" || fail "Suggestion control: $CODE $BODY"
req "$JAR_A" "" GET "/api/search/suggestions?q=$TAG_C"
[[ "$CODE" == "200" && "$(json_get "$BODY" "not any('$TAG_C' in s['text'].lower() for s in d['suggestions'])")" == "True" ]] \
    && pass "Community hashtag excluded from suggestions" || fail "Suggestion leak: $CODE $BODY"

req "$JAR_A" "" GET "/api/search?q=$TAG_C&type=topics"
[[ "$CODE" == "200" && "$(json_get "$BODY" "len(d['topics']) == 0")" == "True" ]] \
    && pass "Community hashtag excluded from topics search" || fail "Topics leak: $CODE $BODY"
req "$JAR_A" "" GET "/api/search?q=$TAG_M&type=topics"
[[ "$CODE" == "200" && "$(json_get "$BODY" "len(d['topics']) >= 1")" == "True" ]] \
    && pass "Topics search finds the main-feed hashtag (positive control)" || fail "Topics control: $CODE $BODY"

req "$JAR_A" "" GET "/api/search/trending?limit=20"
[[ "$CODE" == "200" && "$(json_get "$BODY" "not any(t['tag'] == '$TAG_C'.lower() for t in d['topics'])")" == "True" ]] \
    && pass "Community hashtag excluded from trending" || fail "Trending leak: $CODE $BODY"

# Profile: count and feed exclude community posts but include main-feed ones.
req "$JAR_B" "" GET "/api/session"
B_ID=$(json_get "$BODY" "d['user']['id']")
req "$JAR_B" "" GET "/api/users/$B_ID"
PROFILE_COUNT=$(json_get "$BODY" "d['post_count']")
# B has several community posts plus exactly one main-feed post.
[[ "$PROFILE_COUNT" == "1" ]] && pass "Profile post_count excludes community posts (1 main post)" || fail "Profile count: $PROFILE_COUNT"

req "$JAR_ANON" "" GET "/api/posts?user_id=$B_ID&limit=50"
[[ "$(json_get "$BODY" "[p['id'] for p in d['posts']] == [$MAIN_POST_ID]")" == "True" ]] \
    && pass "Profile feed contains only the main-feed post" || fail "Profile feed: $BODY"

req "$JAR_B" "$CSRF_B" DELETE "/api/posts/$MAIN_POST_ID"
[[ "$CODE" == "200" ]] || fail "Main post cleanup: $CODE"

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

# ============================================================
# Phase 4: access control (public / restricted / private)
# ============================================================
CSRF_C=$(signup "$JAR_C" "$EMAIL_C")
req "$JAR_B" "" GET "/api/session"; B_USER=$(json_get "$BODY" "d['user']['username']")
req "$JAR_C" "" GET "/api/session"; C_USER=$(json_get "$BODY" "d['user']['username']")
mkc() { # type -> slug (creator A)
    req "$JAR_A" "$CSRF_A" POST /api/communities "{\"name\":\"$1 ${RUN_ID: -6}\",\"description\":\"d\",\"topic\":\"Tech\",\"type\":\"$1\"}"
    json_get "$BODY" "d['slug']"
}
PUB=$(mkc public); RST=$(mkc restricted); PRV=$(mkc private)
mkpost() { # slug -> post id (as A)
    req "$JAR_A" "$CSRF_A" POST "/api/communities/$1/posts" "{\"content\":\"p4 post $RUN_ID\"}"; json_get "$BODY" "d['id']"
}
mkcomment() { # post id -> comment id (as A)
    req "$JAR_A" "$CSRF_A" POST "/api/posts/$1/comments" "{\"content\":\"p4 comment $RUN_ID\"}"; json_get "$BODY" "d['id']"
}
PUB_P=$(mkpost "$PUB"); RST_P=$(mkpost "$RST"); PRV_P=$(mkpost "$PRV")
PUB_C=$(mkcomment "$PUB_P"); RST_C=$(mkcomment "$RST_P"); PRV_C=$(mkcomment "$PRV_P")
[[ -n "$PUB_C" && -n "$RST_C" && -n "$PRV_C" ]] && pass "P4 fixtures: 3 communities, posts, comments" || { fail "P4 fixtures"; }

expect() { # label expected_code [expected_error]  (uses CODE/BODY)
    local ok=1; [[ "$CODE" == "$2" ]] || ok=0
    [[ -z "$3" || "$(json_get "$BODY" "d.get('error')")" == "$3" ]] || ok=0
    [[ $ok == 1 ]] && pass "$1" || fail "$1 -> $CODE $BODY"
}

# --- public: any logged-in user interacts without joining; posting still needs membership ---
req "$JAR_C" "$CSRF_C" POST "/api/posts/$PUB_P/comments" '{"content":"outsider comment"}'; expect "Public: non-member can comment" 201
req "$JAR_C" "$CSRF_C" POST "/api/posts/$PUB_P/like"; expect "Public: non-member can like post" 200
req "$JAR_C" "$CSRF_C" POST "/api/comments/$PUB_C/like"; expect "Public: non-member can like comment" 200
req "$JAR_C" "$CSRF_C" POST "/api/communities/$PUB/posts" '{"content":"x"}'; expect "Public: non-member cannot post" 403 "Join this community to post"

# --- restricted: view open, everything else members only ---
req "$JAR_ANON" "" GET "/api/communities/$RST"; expect "Restricted: logged-out can view community" 200
req "$JAR_ANON" "" GET "/api/communities/$RST/posts"; expect "Restricted: logged-out can read posts" 200
req "$JAR_ANON" "" GET "/api/posts/$RST_P/comments"; expect "Restricted: logged-out can read comments" 200
req "$JAR_C" "$CSRF_C" POST "/api/communities/$RST/join"; expect "Restricted: outsider join -> 403 invite-only" 403 "This community is invite-only"
req "$JAR_C" "$CSRF_C" POST "/api/communities/$RST/posts" '{"content":"x"}'; expect "Restricted: outsider post -> 403" 403 "Join this community to post"
req "$JAR_C" "$CSRF_C" POST "/api/posts/$RST_P/comments" '{"content":"x"}'; expect "Restricted: outsider comment -> 403" 403 "Join this community to comment"
req "$JAR_C" "$CSRF_C" POST "/api/posts/$RST_P/like"; expect "Restricted: outsider like post -> 403" 403 "Join this community to like"
req "$JAR_C" "$CSRF_C" POST "/api/comments/$RST_C/like"; expect "Restricted: outsider like comment -> 403" 403 "Join this community to like"
req "$JAR_A" "$CSRF_A" POST "/api/posts/$RST_P/like"; expect "Restricted control: creator likes post" 200
req "$JAR_A" "$CSRF_A" POST "/api/posts/$RST_P/comments" '{"content":"control"}'; expect "Restricted control: creator comments" 201
req "$JAR_ANON" "" POST "/api/posts/$RST_P/comments" '{"content":"x"}'; [[ "$CODE" == "401" || "$CODE" == "403" ]] && pass "Restricted: logged-out comment rejected ($CODE)" || fail "Restricted anon comment: $CODE"

# --- private: indistinguishable from nonexistent for non-members and logged-out ---
req "$JAR_C" "" GET "/api/communities/no-such-slug-$RUN_ID"; UNK_COMM="$BODY"
req "$JAR_C" "" GET "/api/posts/999999999/comments"; UNK_POST="$BODY"
req "$JAR_C" "$CSRF_C" POST "/api/comments/999999999/like"; UNK_CMT="$BODY"
priv_denied() { # label jar csrf method path [json]
    req "$2" "$3" "$4" "$5" "$6"
    local want="$UNK_COMM"; [[ "$5" == /api/posts/* ]] && want="$UNK_POST"; [[ "$5" == /api/comments/* ]] && want="$UNK_CMT"
    [[ "$CODE" == "404" && "$BODY" == "$want" ]] && pass "$1" || fail "$1 -> $CODE $BODY (want 404 $want)"
}
for who in C ANON; do
    jar="JAR_$who"; csrf="CSRF_$who"; [[ $who == ANON ]] && csrf=""
    jar="${!jar}"; csrf="${!csrf}"
    priv_denied "Private/$who: GET community 404 == unknown" "$jar" "$csrf" GET "/api/communities/$PRV"
    priv_denied "Private/$who: GET posts 404 == unknown" "$jar" "$csrf" GET "/api/communities/$PRV/posts"
    priv_denied "Private/$who: GET comments 404 == unknown" "$jar" "$csrf" GET "/api/posts/$PRV_P/comments"
done
priv_denied "Private/C: join 404 == unknown" "$JAR_C" "$CSRF_C" POST "/api/communities/$PRV/join"
priv_denied "Private/C: leave 404 == unknown" "$JAR_C" "$CSRF_C" POST "/api/communities/$PRV/leave"
priv_denied "Private/C: post 404 == unknown" "$JAR_C" "$CSRF_C" POST "/api/communities/$PRV/posts" '{"content":"x"}'
priv_denied "Private/C: comment 404 == unknown" "$JAR_C" "$CSRF_C" POST "/api/posts/$PRV_P/comments" '{"content":"x"}'
priv_denied "Private/C: like post 404 == unknown" "$JAR_C" "$CSRF_C" POST "/api/posts/$PRV_P/like"
priv_denied "Private/C: like comment 404 == unknown" "$JAR_C" "$CSRF_C" POST "/api/comments/$PRV_C/like"
req "$JAR_A" "" GET "/api/communities/$PRV/posts"; expect "Private control: creator reads posts" 200
req "$JAR_A" "" GET "/api/posts/$PRV_P/comments"; expect "Private control: creator reads comments" 200

# --- add member ---
req "$JAR_B" "$CSRF_B" POST "/api/communities/$PRV/members" "{\"username\":\"$C_USER\"}"; expect "Add member: private outsider -> 404" 404 "Community not found"
req "$JAR_B" "$CSRF_B" POST "/api/communities/$RST/members" "{\"username\":\"$C_USER\"}"; expect "Add member: restricted non-creator -> 403" 403 "Only the creator can add members"
req "$JAR_A" "$CSRF_A" POST "/api/communities/$PRV/members" '{"username":"no_such_user_zz"}'; expect "Add member: unknown username -> 400" 400 "No user with that username"
req "$JAR_A" "$CSRF_A" POST "/api/communities/$PRV/members" '{}'; expect "Add member: missing username -> 400" 400
req "$JAR_A" "" GET "/api/communities/$PRV"; MC0=$(json_get "$BODY" "d['member_count']")
req "$JAR_A" "$CSRF_A" POST "/api/communities/$PRV/members" "{\"username\":\"$(echo "$C_USER" | tr '[:lower:]' '[:upper:]')\"}"
[[ "$CODE" == "201" && "$(json_get "$BODY" "d['member_count']")" == "$((MC0 + 1))" ]] && pass "Add member: creator adds C (case-insensitive), count +1" || fail "Add member: $CODE $BODY"
req "$JAR_A" "$CSRF_A" POST "/api/communities/$PRV/members" "{\"username\":\"$C_USER\"}"
[[ "$(json_get "$BODY" "d['member_count']")" == "$((MC0 + 1))" ]] && pass "Add member: re-add is a no-op" || fail "Re-add: $BODY"
req "$JAR_C" "" GET "/api/communities/$PRV"; expect "Added member can now view the private community" 200
req "$JAR_C" "$CSRF_C" POST "/api/posts/$PRV_P/comments" '{"content":"member comment"}'; expect "Added member can comment" 201
req "$JAR_C" "$CSRF_C" POST "/api/posts/$PRV_P/like"; expect "Added member can like post" 200
req "$JAR_C" "$CSRF_C" POST "/api/comments/$PRV_C/like"; expect "Added member can like comment" 200
req "$JAR_C" "$CSRF_C" POST "/api/communities/$PRV/posts" '{"content":"member post"}'; expect "Added member can post" 201
req "$JAR_C" "$CSRF_C" POST "/api/communities/$PRV/members" "{\"username\":\"$B_USER\"}"; expect "Member (non-creator) cannot add members" 403 "Only the creator can add members"
req "$JAR_C" "" GET "/api/posts?limit=50"
[[ "$(json_get "$BODY" "any(p['id'] == $PRV_P for p in d['posts'])")" == "True" ]] && pass "Home feed shows the private post to an added member" || fail "Home feed member: $BODY"

# --- remove member ---
req "$JAR_C" "$CSRF_C" DELETE "/api/communities/$PRV/members/$B_USER"; expect "Remove member: non-creator -> 403" 403 "Only the creator can remove members"
req "$JAR_A" "$CSRF_A" DELETE "/api/communities/$PRV/members/$B_USER"; expect "Remove member: non-member target -> 400" 400 "That user is not a member"
req "$JAR_A" "$CSRF_A" GET "/api/session"; A_USER=$(json_get "$BODY" "d['user']['username']")
req "$JAR_A" "$CSRF_A" DELETE "/api/communities/$PRV/members/$A_USER"; expect "Remove member: creator cannot be removed -> 400" 400 "The creator can't be removed"
req "$JAR_A" "$CSRF_A" DELETE "/api/communities/$PRV/members/$C_USER"; expect "Remove member: creator removes C" 200
priv_denied "Removed member immediately gets 404 on the private community" "$JAR_C" "$CSRF_C" GET "/api/communities/$PRV"
priv_denied "Removed member gets 404 on private comments" "$JAR_C" "$CSRF_C" GET "/api/posts/$PRV_P/comments"
req "$JAR_C" "" GET "/api/posts?limit=50"
[[ "$(json_get "$BODY" "not any(p['id'] == $PRV_P for p in d['posts'])")" == "True" ]] && pass "Home feed hides the private post again after removal" || fail "Home feed removed: $BODY"
req "$JAR_A" "" GET "/api/posts/$PRV_P/comments"
[[ "$(json_get "$BODY" "any('member comment' in c['content'] for c in d)")" == "True" ]] \
    && pass "Removed member's comments are kept" || fail "Removed member comments: $BODY"

# --- leave / rejoin ---
req "$JAR_B" "$CSRF_B" POST "/api/communities/$RST/join"; expect "Restricted: B (not added) cannot join" 403 "This community is invite-only"
req "$JAR_A" "$CSRF_A" POST "/api/communities/$RST/members" "{\"username\":\"$B_USER\"}"; expect "Restricted: creator adds B" 201
req "$JAR_B" "$CSRF_B" POST "/api/communities/$RST/leave"; expect "Restricted: B leaves" 200
req "$JAR_B" "$CSRF_B" POST "/api/communities/$RST/join"; expect "Restricted: rejoin after leaving -> 403" 403 "This community is invite-only"
req "$JAR_B" "$CSRF_B" POST "/api/communities/$PUB/join"; expect "Public: join" 200
req "$JAR_B" "$CSRF_B" POST "/api/communities/$PUB/leave"; expect "Public: leave" 200
req "$JAR_B" "$CSRF_B" POST "/api/communities/$PUB/join"; expect "Public: rejoin -> 200" 200

# --- cross-community comment attachment ---
req "$JAR_A" "$CSRF_A" POST "/api/posts/$PUB_P/comments" "{\"content\":\"reply\",\"parent_comment_id\":$PRV_C}"
[[ "$CODE" == "400" || "$CODE" == "404" ]] && pass "Parent comment from another community rejected ($CODE)" || fail "Cross-parent: $CODE $BODY"

# --- Home feed carries community.type ---
req "$JAR_A" "" GET "/api/posts?limit=50"
[[ "$(json_get "$BODY" "all(p['community'].get('type') in ('public','restricted','private') for p in d['posts'] if p.get('community'))")" == "True" ]] && pass "Home feed community key includes type" || fail "Home feed type: $BODY"

# --- main-feed (non-community) posts unaffected ---
req "$JAR_A" "$CSRF_A" POST /api/posts "{\"content\":\"p4 main post $RUN_ID\"}"; MAIN_P=$(json_get "$BODY" "d['id']")
req "$JAR_C" "$CSRF_C" POST "/api/posts/$MAIN_P/comments" '{"content":"stranger comment"}'; expect "Main feed: stranger can comment" 201
req "$JAR_C" "$CSRF_C" POST "/api/posts/$MAIN_P/like"; expect "Main feed: stranger can like" 200
req "$JAR_ANON" "" GET "/api/posts/$MAIN_P/comments"; expect "Main feed: logged-out can read comments" 200
req "$JAR_A" "$CSRF_A" DELETE "/api/posts/$MAIN_P"

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ $FAILED -eq 0 ]]
