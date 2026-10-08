#!/bin/bash
set -euo pipefail

# Run with DB_PATH=beebo_test.db against a local server on port 5050.
BASE_URL="http://127.0.0.1:5050"
RUN_ID="$(date +%s)$$"
JAR_A="/tmp/quote_a_${RUN_ID}.jar"
JAR_B="/tmp/quote_b_${RUN_ID}.jar"
PNG="/tmp/quote_${RUN_ID}.png"
trap 'rm -f "$JAR_A" "$JAR_B" "$PNG" "/tmp/quote_error_${RUN_ID}.json"' EXIT

python3 - "$PNG" <<'PY'
import struct, sys, zlib
def chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00'))
       + chunk(b'IEND', b''))
open(sys.argv[1], 'wb').write(png)
PY

signup() {
    curl -s -c "$1" -H 'Content-Type: application/json' \
        -d "{\"full_name\":\"$2\",\"email\":\"quote_${2}_${RUN_ID}@example.com\",\"password\":\"password123\"}" \
        "$BASE_URL/api/signup" >/dev/null
}
signup "$JAR_A" A
signup "$JAR_B" B
csrf() {
    curl -s -b "$1" "$BASE_URL/api/session" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf_token"])'
}
CSRF_A=$(csrf "$JAR_A")
CSRF_B=$(csrf "$JAR_B")
post() {
    curl -s -b "$1" -H "X-CSRF-Token: $2" -H 'Content-Type: application/json' \
        -d "$3" "$BASE_URL/api/posts"
}
assert_json() {
    python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert eval(sys.argv[2]), sys.argv[2]' "$1" "$2" "${3-}" "${4-}"
}
http_code() {
    curl -s -o "/tmp/quote_error_${RUN_ID}.json" -w '%{http_code}' "$@"
}

# Plain post and JSON-number quote creation.
ORIGINAL=$(post "$JAR_A" "$CSRF_A" '{"content":"quote target surface_marker"}')
ORIGINAL_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$ORIGINAL")
assert_json "$ORIGINAL" 'd["quoted_post"] is None'
curl -s -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -X POST "$BASE_URL/api/posts/$ORIGINAL_ID/like" >/dev/null
QUOTE=$(post "$JAR_B" "$CSRF_B" "{\"content\":\"json quote surface_marker\",\"quoted_post_id\":$ORIGINAL_ID}")
QUOTE_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$QUOTE")
assert_json "$QUOTE" 'd["quoted_post"]["id"] == int(sys.argv[3]) and set(("id", "user_id", "author_name", "author_handle", "author_avatar", "content", "created_at", "images", "like_count", "comment_count", "liked_by_user")) <= set(d["quoted_post"])' "$ORIGINAL_ID"

# Multipart quote id string and attached image.
MULTIPART=$(curl -s -b "$JAR_B" -H "X-CSRF-Token: $CSRF_B" \
    -F 'content=multipart quote surface_marker' -F "quoted_post_id=$ORIGINAL_ID" \
    -F "images=@$PNG;type=image/png" "$BASE_URL/api/posts")
MULTIPART_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$MULTIPART")
assert_json "$MULTIPART" 'd["quoted_post"]["id"] == int(sys.argv[3]) and len(d["images"]) == 1' "$ORIGINAL_ID"

# Quote-of-quote is allowed and embeds only one level.
NESTED=$(post "$JAR_A" "$CSRF_A" "{\"content\":\"quote of quote surface_marker\",\"quoted_post_id\":$QUOTE_ID}")
NESTED_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$NESTED")
assert_json "$NESTED" 'd["quoted_post"]["id"] == int(sys.argv[3]) and "quoted_post" not in d["quoted_post"]' "$QUOTE_ID"

# Invalid ids are 400; missing and private-inaccessible targets are 404.
for bad_id in 'not-a-number' 0 -1; do
    code=$(http_code -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -H 'Content-Type: application/json' \
        -d "{\"content\":\"bad quote\",\"quoted_post_id\":\"$bad_id\"}" "$BASE_URL/api/posts")
    [[ "$code" == 400 ]]
done
code=$(http_code -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -H 'Content-Type: application/json' \
    -d '{"content":"missing quote","quoted_post_id":99999999}' "$BASE_URL/api/posts")
[[ "$code" == 404 ]]
assert_json "$(cat "/tmp/quote_error_${RUN_ID}.json")" 'd["error"] == "Post not found"'

# Feed and profile/search include the key; the quoted like state follows viewer.
FEED_A=$(curl -s -b "$JAR_A" "$BASE_URL/api/posts?limit=50")
FEED_B=$(curl -s -b "$JAR_B" "$BASE_URL/api/posts?limit=50")
assert_json "$FEED_A" 'all("quoted_post" in p for p in d["posts"]) and next(p for p in d["posts"] if p["id"] == int(sys.argv[3]))["quoted_post"]["liked_by_user"] is True' "$QUOTE_ID"
assert_json "$FEED_B" 'set(("id", "user_id", "author_name", "author_handle", "author_avatar", "content", "created_at", "images", "like_count", "comment_count", "liked_by_user")) <= set(next(p for p in d["posts"] if p["id"] == int(sys.argv[3]))["quoted_post"]) and next(p for p in d["posts"] if p["id"] == int(sys.argv[3]))["quoted_post"]["liked_by_user"] is False' "$QUOTE_ID"
USER_A_ID=$(curl -s -b "$JAR_A" "$BASE_URL/api/session" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["id"])')
PROFILE=$(curl -s -b "$JAR_A" "$BASE_URL/api/posts?user_id=$USER_A_ID&limit=50")
assert_json "$PROFILE" 'all("quoted_post" in p for p in d["posts"]) and any(p["id"] == int(sys.argv[3]) for p in d["posts"])' "$NESTED_ID"
SEARCH=$(curl -s -b "$JAR_A" "$BASE_URL/api/search?q=surface_marker&type=posts&limit=50")
assert_json "$SEARCH" 'all("quoted_post" in p for p in d["posts"]) and any(p["id"] == int(sys.argv[3]) for p in d["posts"])' "$QUOTE_ID"

# Community create and logged-out public community list.
COMMUNITY=$(curl -s -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -H 'Content-Type: application/json' \
    -d "{\"name\":\"Quote Public ${RUN_ID: -6}\",\"description\":\"quote test\",\"topic\":\"discussion\",\"type\":\"public\"}" \
    "$BASE_URL/api/communities")
SLUG=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["slug"])' <<<"$COMMUNITY")
COMMUNITY_QUOTE=$(curl -s -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -H 'Content-Type: application/json' \
    -d "{\"content\":\"community quote surface_marker\",\"quoted_post_id\":$ORIGINAL_ID}" \
    "$BASE_URL/api/communities/$SLUG/posts")
COMMUNITY_QUOTE_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$COMMUNITY_QUOTE")
assert_json "$COMMUNITY_QUOTE" 'd["quoted_post"]["id"] == int(sys.argv[3]) and d["community"]["slug"] == sys.argv[4]' "$ORIGINAL_ID" "$SLUG"
COMMUNITY_LIST=$(curl -s "$BASE_URL/api/communities/$SLUG/posts?limit=50")
assert_json "$COMMUNITY_LIST" 'all("quoted_post" in p for p in d["posts"]) and any(p["id"] == int(sys.argv[3]) for p in d["posts"])' "$COMMUNITY_QUOTE_ID"

# Private original is indistinguishable from a missing original for outsiders.
PRIVATE=$(curl -s -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -H 'Content-Type: application/json' \
    -d "{\"name\":\"Quote Private ${RUN_ID: -6}\",\"description\":\"private\",\"topic\":\"discussion\",\"type\":\"private\"}" \
    "$BASE_URL/api/communities")
PRIVATE_SLUG=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["slug"])' <<<"$PRIVATE")
PRIVATE_POST=$(curl -s -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -H 'Content-Type: application/json' \
    -d '{"content":"private quote target"}' "$BASE_URL/api/communities/$PRIVATE_SLUG/posts")
PRIVATE_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$PRIVATE_POST")
code=$(http_code -b "$JAR_B" -H "X-CSRF-Token: $CSRF_B" -H 'Content-Type: application/json' \
    -d "{\"content\":\"private denied\",\"quoted_post_id\":$PRIVATE_ID}" "$BASE_URL/api/posts")
[[ "$code" == 404 ]]
assert_json "$(cat "/tmp/quote_error_${RUN_ID}.json")" 'd["error"] == "Post not found"'
PRIVATE_QUOTE=$(post "$JAR_A" "$CSRF_A" "{\"content\":\"private quote wrapper\",\"quoted_post_id\":$PRIVATE_ID}")
PRIVATE_QUOTE_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$PRIVATE_QUOTE")
OUTSIDER_FEED=$(curl -s -b "$JAR_B" "$BASE_URL/api/posts?limit=50")
assert_json "$OUTSIDER_FEED" 'next(p for p in d["posts"] if p["id"] == int(sys.argv[3]))["quoted_post"] == {"id": int(sys.argv[4]), "unavailable": True}' "$PRIVATE_QUOTE_ID" "$PRIVATE_ID"

# Deleting an original keeps its quote id; deleting a quote only removes itself.
curl -s -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -X DELETE "$BASE_URL/api/posts/$ORIGINAL_ID" >/dev/null
DELETED_FEED=$(curl -s -b "$JAR_B" "$BASE_URL/api/posts?limit=50")
assert_json "$DELETED_FEED" 'next(p for p in d["posts"] if p["id"] == int(sys.argv[3]))["quoted_post"] == {"id": int(sys.argv[4]), "unavailable": True}' "$QUOTE_ID" "$ORIGINAL_ID"
curl -s -b "$JAR_A" -H "X-CSRF-Token: $CSRF_A" -X DELETE "$BASE_URL/api/posts/$NESTED_ID" >/dev/null
AFTER_QUOTE_DELETE=$(curl -s -b "$JAR_A" "$BASE_URL/api/posts?limit=50")
assert_json "$AFTER_QUOTE_DELETE" 'not any(p["id"] == int(sys.argv[3]) for p in d["posts"]) and any(p["id"] == int(sys.argv[4]) for p in d["posts"])' "$NESTED_ID" "$QUOTE_ID"
curl -s -b "$JAR_B" -H "X-CSRF-Token: $CSRF_B" -X DELETE "$BASE_URL/api/posts/$MULTIPART_ID" >/dev/null

echo 'quote posts: PASS'
