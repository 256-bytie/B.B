#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/test_guard.sh" || exit 1

# Tests for the Businesses API: create (POST /api/businesses) and list
# (GET /api/businesses). Run against a server started with an isolated DB
# (never beebo.db):
#   ./test_businesses.sh
# Uses unique per-run emails and business names, so it needs no direct DB
# access and is safe to re-run against the same test database.

BASE_URL="http://127.0.0.1:5050"
PASSED=0
FAILED=0
RUN_ID="$(date +%s)$$"
EMAIL_A="biz_a_${RUN_ID}@example.com"
EMAIL_B="biz_b_${RUN_ID}@example.com"
JAR_A="biz_cookie_a_${RUN_ID}.txt"
JAR_B="biz_cookie_b_${RUN_ID}.txt"
JAR_ANON="biz_cookie_anon_${RUN_ID}.txt"
IMG_A="/tmp/biz_avatar_a_${RUN_ID}.png"
IMG_B="/tmp/biz_avatar_b_${RUN_ID}.png"
IMG_JPG="/tmp/biz_avatar_${RUN_ID}.jpg"
IMG_WEBP="/tmp/biz_banner_${RUN_ID}.webp"
BAD_IMAGE="/tmp/biz_bad_${RUN_ID}.txt"
LARGE_IMAGE="/tmp/biz_large_${RUN_ID}.png"
DOWNLOADED_IMAGE="/tmp/biz_downloaded_${RUN_ID}.png"
SAVED_UPLOAD_PATHS=()

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${YELLOW}ℹ INFO${NC}: $1"; }
cleanup() {
    rm -f "$JAR_A" "$JAR_B" "$JAR_ANON" "$IMG_A" "$IMG_B" "$IMG_JPG" "$IMG_WEBP" \
        "$BAD_IMAGE" "$LARGE_IMAGE" "$DOWNLOADED_IMAGE" \
        "${SAVED_UPLOAD_PATHS[@]}"
}
trap cleanup EXIT

# json_get '<json>' 'python expression on d' -> prints value
json_get() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print($2)" "$1" 2>/dev/null; }

signup() { # jar email -> csrf token
    curl -s -c "$1" -b "$1" -X POST "$BASE_URL/api/signup" \
        -H "Content-Type: application/json" \
        -d "{\"full_name\":\"Biz Tester\",\"email\":\"$2\",\"password\":\"testpass123\"}" \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('csrf_token',''))"
}

# payload NAME [python statements that modify dict p] -> JSON request body
payload() {
    python3 - "$1" "${2:-}" <<'PY'
import json, sys
days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
p = {
    'name': sys.argv[1], 'category': 'Food & Drinks', 'location': 'Main gate',
    'description': 'Fresh food for students.',
    'hours': {d: {'open': i < 5, 'from': '09:00', 'to': '17:00'} for i, d in enumerate(days)},
    'services': ['Delivery', 'Catering'],
    'contact': {'phone': '', 'email': '', 'website': ''},
    'social': {'instagram': '', 'facebook': '', 'x': '', 'tiktok': ''},
}
exec(sys.argv[2])
print(json.dumps(p))
PY
}

post_biz() { # jar csrf body -> "<body>\n<status>"
    curl -s -w "\n%{http_code}" -b "$1" -X POST "$BASE_URL/api/businesses" \
        -H "Content-Type: application/json" -H "X-CSRF-Token: $2" -d "$3"
}

upload_image() { # jar csrf business_id kind file -> "<body>\n<status>"
    local file_part="file=@$5"
    [[ -n "${6:-}" ]] && file_part="${file_part};type=$6"
    curl -s -w "\n%{http_code}" -b "$1" -X POST "$BASE_URL/api/businesses/$3/image" \
        -H "X-CSRF-Token: $2" -F "kind=$4" -F "$file_part"
}

track_upload() {
    [[ "$1" == /static/uploads/* ]] && SAVED_UPLOAD_PATHS+=("static/uploads/$(basename "$1")")
}

python3 - "$IMG_A" "$IMG_B" "$IMG_JPG" "$IMG_WEBP" <<'PY'
import struct, sys, zlib

def chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))

def png(red, green, blue):
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes([0, red, green, blue])))
            + chunk(b'IEND', b''))

open(sys.argv[1], 'wb').write(png(255, 0, 0))
open(sys.argv[2], 'wb').write(png(0, 0, 255))
open(sys.argv[3], 'wb').write(b'\xff\xd8\xff\xd9')
open(sys.argv[4], 'wb').write(b'RIFF\x04\x00\x00\x00WEBP')
PY
echo "not an image" > "$BAD_IMAGE"
cp "$IMG_A" "$LARGE_IMAGE"
truncate -s $((5 * 1024 * 1024 + 1)) "$LARGE_IMAGE"

info "Starting Businesses tests"

# --- Auth required ---
ANON_CSRF=$(curl -s -c "$JAR_ANON" "$BASE_URL/api/session" | python3 -c "import json,sys; print(json.load(sys.stdin).get('csrf_token',''))")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_ANON" "$BASE_URL/api/businesses")
[[ "$CODE" == "401" ]] && pass "GET /api/businesses requires login (401)" || fail "GET should be 401 logged out, got $CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_ANON" -X POST "$BASE_URL/api/businesses" \
    -H "Content-Type: application/json" -H "X-CSRF-Token: $ANON_CSRF" -d "$(payload "Anon $RUN_ID")")
[[ "$CODE" == "401" ]] && pass "POST /api/businesses requires login (401)" || fail "POST should be 401 logged out, got $CODE"

CSRF_A=$(signup "$JAR_A" "$EMAIL_A")
[[ -n "$CSRF_A" ]] && pass "Signed up user A" || { fail "Signup failed - aborting"; exit 1; }
CSRF_B=$(signup "$JAR_B" "$EMAIL_B")
[[ -n "$CSRF_B" ]] && pass "Signed up user B" || { fail "Signup B failed - aborting"; exit 1; }
UID_A=$(json_get "$(curl -s -b "$JAR_A" "$BASE_URL/api/session")" "d['user']['id']")

# --- CSRF ---
NAME_NOCSRF="NoCsrf $RUN_ID"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE_URL/api/businesses" \
    -H "Content-Type: application/json" -d "$(payload "$NAME_NOCSRF")")
[[ "$CODE" == "403" ]] && pass "POST without CSRF token rejected (403)" || fail "Expected 403 without CSRF, got $CODE"

# --- Create ---
NAME_A="Alpha $RUN_ID"
RESP=$(post_biz "$JAR_A" "$CSRF_A" "$(payload "$NAME_A" "p['owner_id'] = 999999999")")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "201" ]] && pass "Create business succeeds (201)" || fail "Expected 201, got $CODE: $BODY"
[[ "$(json_get "$BODY" "all(k in d['business'] for k in ['id','owner_id','name','category','location','description','hours','services','contact','social','created_at'])")" == "True" ]] \
    && pass "Response has every profile field" || fail "Missing fields: $BODY"
[[ "$(json_get "$BODY" "d['business']['name']")" == "$NAME_A" && "$(json_get "$BODY" "d['business']['services']")" == "['Delivery', 'Catering']" \
    && "$(json_get "$BODY" "d['business']['hours']['sat']['open']")" == "False" ]] \
    && pass "Values round-trip (name, services, hours)" || fail "Values changed: $BODY"
[[ "$(json_get "$BODY" "d['business']['owner_id']")" == "$UID_A" ]] \
    && pass "owner_id comes from the session, not the body" || fail "owner_id wrong (expected $UID_A): $BODY"
BIZ_ID_A=$(json_get "$BODY" "d['business']['id']")
[[ "$(json_get "$BODY" "d['business']['avatar_url'] is None and d['business']['banner_url'] is None")" == "True" ]] \
    && pass "New business image URLs default to null" || fail "New image fields wrong: $BODY"

# --- Business images ---
RESP=$(upload_image "$JAR_A" "$CSRF_A" "$BIZ_ID_A" avatar "$IMG_A")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
AVATAR_URL=$(json_get "$BODY" "d.get('business', {}).get('avatar_url', '')")
track_upload "$AVATAR_URL"
[[ "$CODE" == "200" && "$AVATAR_URL" == /static/uploads/* ]] \
    && pass "Owner can upload avatar (200, avatar_url set)" || fail "Avatar upload failed ($CODE): $BODY"
CODE=$(curl -s -o "$DOWNLOADED_IMAGE" -w "%{http_code}" "$BASE_URL$AVATAR_URL")
[[ "$CODE" == "200" ]] && cmp -s "$IMG_A" "$DOWNLOADED_IMAGE" \
    && pass "Uploaded avatar is publicly retrievable" || fail "Avatar retrieval failed ($CODE): $AVATAR_URL"

RESP=$(upload_image "$JAR_B" "$CSRF_B" "$BIZ_ID_A" avatar "$IMG_B")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "403" ]] && pass "Another user cannot upload business image (403)" || fail "Expected owner check 403, got $CODE: $BODY"

RESP=$(upload_image "$JAR_ANON" "$ANON_CSRF" "$BIZ_ID_A" avatar "$IMG_B")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "401" ]] && pass "Logged-out business image upload rejected (401)" || fail "Expected logged-out 401, got $CODE: $BODY"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE_URL/api/businesses/$BIZ_ID_A/image" \
    -F "kind=avatar" -F "file=@$IMG_B")
[[ "$CODE" == "403" ]] && pass "Business image upload requires CSRF (403)" || fail "Expected image CSRF 403, got $CODE"

RESP=$(upload_image "$JAR_A" "$CSRF_A" 999999999 avatar "$IMG_B")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "404" ]] && pass "Unknown business image upload returns 404" || fail "Expected unknown business 404, got $CODE: $BODY"

RESP=$(upload_image "$JAR_A" "$CSRF_A" "$BIZ_ID_A" logo "$IMG_B")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "400" && -n "$(json_get "$BODY" "d.get('error','')")" ]] \
    && pass "Bad image kind rejected (400)" || fail "Expected bad kind 400, got $CODE: $BODY"

RESP=$(upload_image "$JAR_A" "$CSRF_A" "$BIZ_ID_A" avatar "$BAD_IMAGE")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "400" && -n "$(json_get "$BODY" "d.get('error','')")" ]] \
    && pass "Non-image content rejected (400)" || fail "Expected non-image 400, got $CODE: $BODY"

RESP=$(upload_image "$JAR_A" "$CSRF_A" "$BIZ_ID_A" avatar "$LARGE_IMAGE")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "400" && -n "$(json_get "$BODY" "d.get('error','')")" ]] \
    && pass "Oversize image rejected (400)" || fail "Expected oversize 400, got $CODE: $BODY"

OLD_AVATAR_URL="$AVATAR_URL"
RESP=$(upload_image "$JAR_A" "$CSRF_A" "$BIZ_ID_A" avatar "$IMG_B")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
AVATAR_URL=$(json_get "$BODY" "d.get('business', {}).get('avatar_url', '')")
track_upload "$AVATAR_URL"
[[ "$CODE" == "200" && "$AVATAR_URL" == /static/uploads/* && "$AVATAR_URL" != "$OLD_AVATAR_URL" ]] \
    && pass "Replacing avatar returns a new URL" || fail "Avatar replacement failed ($CODE): $BODY"
[[ ! -f "static/uploads/$(basename "$OLD_AVATAR_URL")" ]] \
    && pass "Replacing avatar removes the old file" || fail "Old avatar file still exists: $OLD_AVATAR_URL"

RESP=$(upload_image "$JAR_A" "$CSRF_A" "$BIZ_ID_A" avatar "$IMG_JPG" image/jpeg)
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
AVATAR_URL=$(json_get "$BODY" "d.get('business', {}).get('avatar_url', '')")
track_upload "$AVATAR_URL"
[[ "$CODE" == "200" && "$AVATAR_URL" == *.jpg ]] \
    && pass "JPG upload is accepted and keeps .jpg extension" || fail "JPG extension was not preserved ($CODE): $BODY"

RESP=$(upload_image "$JAR_A" "$CSRF_A" "$BIZ_ID_A" banner "$IMG_WEBP" image/webp)
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
BANNER_URL=$(json_get "$BODY" "d.get('business', {}).get('banner_url', '')")
track_upload "$BANNER_URL"
[[ "$CODE" == "200" && "$BANNER_URL" == *.webp ]] \
    && pass "WebP upload is accepted and keeps .webp extension" || fail "WebP extension was not preserved ($CODE): $BODY"

# --- Validation: 400 and nothing stored ---
declare -A BAD=(
    ["short name"]="p['name'] = 'A'"
    ["bad category"]="p['category'] = 'Nope'"
    ["all days closed"]="p['hours'] = {d: {'open': False, 'from': '09:00', 'to': '17:00'} for d in p['hours']}"
    ["closing before opening"]="p['hours']['mon'] = {'open': True, 'from': '17:00', 'to': '09:00'}"
    ["bad email"]="p['contact']['email'] = 'nope'"
)
for LABEL in "${!BAD[@]}"; do
    NAME_BAD="Bad ${LABEL// /_} $RUN_ID"
    [[ "$LABEL" == "short name" ]] && BODY_BAD="$(payload "A")" || BODY_BAD="$(payload "$NAME_BAD" "${BAD[$LABEL]}")"
    RESP=$(post_biz "$JAR_A" "$CSRF_A" "$BODY_BAD")
    BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
    [[ "$CODE" == "400" && -n "$(json_get "$BODY" "d['error']")" ]] \
        && pass "Rejected ($LABEL): 400 with error message" || fail "Expected 400 for $LABEL, got $CODE: $BODY"
done
RESP=$(curl -s -w "\n%{http_code}" -b "$JAR_A" -X POST "$BASE_URL/api/businesses" \
    -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_A" -d '[1,2,3]')
[[ "$(echo "$RESP" | tail -n1)" == "400" ]] && pass "Non-object body rejected (400)" || fail "Expected 400 for array body: $RESP"
LIST=$(curl -s -b "$JAR_A" "$BASE_URL/api/businesses")
[[ "$(json_get "$LIST" "len([b for b in d['businesses'] if 'Bad ' in b['name'] and '$RUN_ID' in b['name']])")" == "0" ]] \
    && pass "Rejected requests stored nothing" || fail "A rejected business was stored: $LIST"

# --- Normalization ---
NAME_TRIM="Trim $RUN_ID"
RESP=$(post_biz "$JAR_A" "$CSRF_A" "$(payload "   $NAME_TRIM   " "p['services'] = ['  a  b ', 'A B', 'Fix']; del p['contact']; del p['social']")")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "201" && "$(json_get "$BODY" "d['business']['name']")" == "$NAME_TRIM" && "$(json_get "$BODY" "d['business']['services']")" == "['a b', 'Fix']" ]] \
    && pass "Name trimmed, services deduped, contact/social optional" || fail "Normalization wrong ($CODE): $BODY"

# --- List ---
NAME_B="Beta $RUN_ID"
post_biz "$JAR_B" "$CSRF_B" "$(payload "$NAME_B")" > /dev/null
R=$(curl -s -D - -b "$JAR_A" "$BASE_URL/api/businesses" | tr -d '\r')
[[ "$(echo "$R" | grep -i '^cache-control:')" == *"no-store"* ]] && pass "List is Cache-Control: no-store" || fail "Missing no-store header"
LIST=$(curl -s -b "$JAR_A" "$BASE_URL/api/businesses")
[[ "$(json_get "$LIST" "[b['name'] for b in d['businesses']].index('$NAME_B') < [b['name'] for b in d['businesses']].index('$NAME_A')")" == "True" ]] \
    && pass "List shows both users' businesses, newest first" || fail "Order or visibility wrong: $LIST"
[[ "$(json_get "$LIST" "next(b['avatar_url'] for b in d['businesses'] if b['id'] == $BIZ_ID_A)")" == "$AVATAR_URL" ]] \
    && pass "GET /api/businesses includes avatar_url" || fail "List avatar_url missing: $LIST"
[[ "$(json_get "$LIST" "len(d['businesses']) <= 50")" == "True" ]] && pass "List is capped at 50" || fail "List exceeds 50"
MINE=$(curl -s -b "$JAR_A" "$BASE_URL/api/businesses?mine=1")
[[ "$(json_get "$MINE" "all(b['owner_id'] == $UID_A for b in d['businesses']) and any(b['name'] == '$NAME_A' for b in d['businesses'])")" == "True" ]] \
    && pass "?mine=1 returns only the caller's businesses" || fail "mine filter wrong: $MINE"
[[ "$(json_get "$MINE" "next(b['avatar_url'] for b in d['businesses'] if b['id'] == $BIZ_ID_A)")" == "$AVATAR_URL" ]] \
    && pass "GET /api/businesses?mine=1 includes avatar_url" || fail "Mine avatar_url missing: $MINE"

# --- Persistence across sessions ---
curl -s -c "$JAR_A" -b "$JAR_A" -X POST "$BASE_URL/api/logout" -H "X-CSRF-Token: $CSRF_A" > /dev/null
LOGIN=$(curl -s -c "$JAR_A" -b "$JAR_A" -X POST "$BASE_URL/api/login" -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL_A\",\"password\":\"testpass123\"}")
CSRF_A=$(json_get "$LOGIN" "d.get('csrf_token','')")
LIST=$(curl -s -b "$JAR_A" "$BASE_URL/api/businesses")
[[ "$(json_get "$LIST" "any(b['name'] == '$NAME_A' for b in d['businesses'])")" == "True" ]] \
    && pass "Business persists across logout/login" || fail "Business lost after re-login: $LIST"
[[ "$(json_get "$LIST" "next(b['avatar_url'] for b in d['businesses'] if b['id'] == $BIZ_ID_A)")" == "$AVATAR_URL" ]] \
    && pass "Business avatar persists across logout/login" || fail "Avatar lost after re-login: $LIST"
[[ "$(json_get "$LIST" "next(b['banner_url'] for b in d['businesses'] if b['id'] == $BIZ_ID_A)")" == "$BANNER_URL" ]] \
    && pass "Business banner persists across logout/login" || fail "Banner lost after re-login: $LIST"

# --- Nothing here should have broken existing endpoints ---
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" "$BASE_URL/api/posts")
[[ "$CODE" == "200" ]] && pass "GET /api/posts still works" || fail "GET /api/posts returned $CODE"

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ $FAILED -eq 0 ]]
