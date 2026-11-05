#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/test_guard.sh" || exit 1

BASE_URL="http://127.0.0.1:5050"
RUN_ID="$(date +%s)$$"
JAR_A="notif_a_${RUN_ID}.txt"
JAR_B="notif_b_${RUN_ID}.txt"
JAR_C="notif_c_${RUN_ID}.txt"
JAR_ANON="notif_anon_${RUN_ID}.txt"
PASSED=0
FAILED=0

pass() { echo "✓ PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "✗ FAIL: $1"; FAILED=$((FAILED + 1)); }
cleanup() { rm -f "$JAR_A" "$JAR_B" "$JAR_C" "$JAR_ANON"; }
trap cleanup EXIT

signup() {
    curl -s -c "$1" -X POST "$BASE_URL/api/signup" \
        -H 'Content-Type: application/json' \
        -d "{\"full_name\":\"$2\",\"email\":\"$3\",\"password\":\"password123\"}"
}

api() {
    local jar="$1" method="$2" path="$3" body="${4:-}"
    local args=(-s -w "\n%{http_code}" -b "$jar" -X "$method" "$BASE_URL$path")
    if [[ -n "$body" ]]; then
        args+=(-H 'Content-Type: application/json' -d "$body")
    fi
    local response
    if [[ "$method" == GET ]]; then
        response=$(curl "${args[@]}")
    else
        local token
        token=$(curl -s -b "$jar" -c "$jar" "$BASE_URL/api/session" | jq -r '.csrf_token // empty')
        args+=(-H "X-CSRF-Token: $token")
        response=$(curl "${args[@]}")
    fi
    BODY=$(echo "$response" | sed '$d')
    CODE=$(echo "$response" | tail -n1)
}

assert_py() {
    local label="$1" expression="$2"
    if BODY_JSON="$BODY" python3 -c "import json,os; d=json.loads(os.environ['BODY_JSON']); assert $expression"; then
        pass "$label"
    else
        fail "$label: $CODE $BODY"
    fi
}

A=$(signup "$JAR_A" "User A" "notif_a_${RUN_ID}@example.com")
B=$(signup "$JAR_B" "User B" "notif_b_${RUN_ID}@example.com")
C=$(signup "$JAR_C" "User C" "notif_c_${RUN_ID}@example.com")
A_ID=$(echo "$A" | jq -r '.user.id'); A_USER=$(echo "$A" | jq -r '.user.username')
B_ID=$(echo "$B" | jq -r '.user.id'); B_USER=$(echo "$B" | jq -r '.user.username')
C_ID=$(echo "$C" | jq -r '.user.id'); C_USER=$(echo "$C" | jq -r '.user.username')
curl -s -c "$JAR_ANON" "$BASE_URL/api/session" >/dev/null

api "$JAR_A" POST "/api/users/$B_ID/follow"
api "$JAR_B" GET '/api/notifications'
assert_py "Follow creates one notification" "len(d['notifications']) == 1 and d['notifications'][0]['type'] == 'follow' and d['notifications'][0]['post'] is None"
api "$JAR_A" POST "/api/users/$B_ID/follow"
api "$JAR_A" POST "/api/users/$B_ID/follow"
api "$JAR_B" GET '/api/notifications'
assert_py "Re-follow is deduplicated" "sum(n['type'] == 'follow' for n in d['notifications']) == 1"

api "$JAR_B" POST '/api/posts' '{"content":"  Snapshot   preview content  "}'
POST_ID=$(echo "$BODY" | jq -r '.id')
api "$JAR_B" POST "/api/posts/$POST_ID/like"
api "$JAR_B" POST "/api/posts/$POST_ID/comments" '{"content":"self comment"}'
SELF_COMMENT=$(echo "$BODY" | jq -r '.id')
api "$JAR_B" POST "/api/posts/$POST_ID/comments" "{\"content\":\"self reply\",\"parent_comment_id\":$SELF_COMMENT}"
api "$JAR_B" GET '/api/notifications'
assert_py "Self like, comment, and reply create nothing" "sum(n['type'] in ('post_like','post_comment','comment_reply') for n in d['notifications']) == 0"

api "$JAR_A" POST "/api/posts/$POST_ID/like"
api "$JAR_B" GET '/api/notifications'
assert_py "Post like includes recipient-relative snapshot and preview" "any(n['type'] == 'post_like' and n['preview'] == 'Snapshot preview content' and n['post']['id'] == $POST_ID and n['post']['liked_by_user'] is True for n in d['notifications'])"
api "$JAR_A" POST "/api/posts/$POST_ID/like"
api "$JAR_A" POST "/api/posts/$POST_ID/like"
api "$JAR_B" GET '/api/notifications'
assert_py "Unlike and relike do not re-notify" "sum(n['type'] == 'post_like' for n in d['notifications']) == 1"

LONG_COMMENT="$(python3 -c "print('word ' * 30)")"
api "$JAR_A" POST "/api/posts/$POST_ID/comments" "{\"content\":\"$LONG_COMMENT\"}"
COMMENT_A=$(echo "$BODY" | jq -r '.id')
api "$JAR_C" POST "/api/posts/$POST_ID/comments" '{"content":"second top comment"}'
COMMENT_C=$(echo "$BODY" | jq -r '.id')
api "$JAR_B" GET '/api/notifications'
assert_py "Two comments create rows and previews truncate" "sum(n['type'] == 'post_comment' for n in d['notifications']) == 2 and any(len(n['preview']) == 120 and n['preview'].endswith('...') for n in d['notifications'] if n['type'] == 'post_comment')"

IMAGE_COMMENT=$(pg_psql -c "INSERT INTO comments (post_id,user_id,content,image_path) VALUES ($POST_ID,$A_ID,'','/static/uploads/test.png') RETURNING id;" | head -n1)
pg_psql -c "UPDATE posts SET comment_count = comment_count + 1 WHERE id=$POST_ID; INSERT INTO notifications (recipient_id,actor_id,type,target_type,target_id,post_id,dedupe_key) VALUES ($B_ID,$A_ID,'post_comment','comment',$IMAGE_COMMENT,$POST_ID,'post_comment:$A_ID:comment:$IMAGE_COMMENT');" >/dev/null
api "$JAR_B" GET '/api/notifications'
assert_py "Image-only comment preview is null" "any(n['type'] == 'post_comment' and n['preview'] is None for n in d['notifications'])"

api "$JAR_B" POST "/api/posts/$POST_ID/comments" "{\"content\":\"owner reply\",\"parent_comment_id\":$COMMENT_A}"
api "$JAR_A" GET '/api/notifications'
assert_py "Reply on own post notifies parent author" "sum(n['type'] == 'comment_reply' and n['actor']['id'] == $B_ID for n in d['notifications']) == 1"
api "$JAR_B" GET '/api/notifications'
assert_py "Reply never also notifies post author" "all(not (n['type'] == 'comment_reply' and n['actor']['id'] == $B_ID) for n in d['notifications'])"
api "$JAR_C" POST "/api/posts/$POST_ID/comments" "{\"content\":\"third party reply\",\"parent_comment_id\":$COMMENT_A}"
api "$JAR_A" GET '/api/notifications'
assert_py "Third-party reply notifies parent author only" "sum(n['type'] == 'comment_reply' and n['actor']['id'] == $C_ID for n in d['notifications']) == 1"
api "$JAR_B" GET '/api/notifications'
assert_py "Third-party reply does not notify post author" "all(not (n['type'] == 'comment_reply' and n['actor']['id'] == $C_ID) for n in d['notifications'])"

api "$JAR_B" GET '/api/notifications?limit=2'
PAGE1="$BODY"; CURSOR=$(echo "$BODY" | jq -r '.next_cursor')
api "$JAR_B" GET "/api/notifications?limit=2&cursor=$CURSOR"
PAGE2="$BODY"
PAGES="$PAGE1|$PAGE2" python3 - <<'PY' && pass "Pagination has no gaps or duplicates" || fail "Pagination walk"
import json, os
first, second = [json.loads(value) for value in os.environ['PAGES'].split('|')]
ids = [n['id'] for n in first['notifications'] + second['notifications']]
assert len(ids) == len(set(ids))
assert ids == sorted(ids, reverse=True)
PY
api "$JAR_B" GET '/api/notifications?limit=999'
assert_py "Limit clamps to 50" "len(d['notifications']) <= 50"

api "$JAR_B" GET '/api/notifications'
READ_ID=$(echo "$BODY" | jq -r '.notifications[0].id')
FOREIGN_ID=$(pg_psql -c "SELECT id FROM notifications WHERE recipient_id=$A_ID ORDER BY id DESC LIMIT 1;")
api "$JAR_B" POST '/api/notifications/read' "{\"ids\":[$READ_ID,$FOREIGN_ID]}"
COUNT_AFTER=$(echo "$BODY" | jq -r '.unread_count')
api "$JAR_A" GET '/api/notifications'
assert_py "Foreign notification ids are ignored" "any(n['id'] == $FOREIGN_ID and n['read'] is False for n in d['notifications'])"
api "$JAR_B" POST '/api/notifications/read' "{\"ids\":[$READ_ID]}"
[[ "$(echo "$BODY" | jq -r '.unread_count')" == "$COUNT_AFTER" ]] && pass "Mark by ids is idempotent" || fail "Mark by ids idempotency"
api "$JAR_B" POST '/api/notifications/read' '{"all":true}'
assert_py "Mark all clears unread count" "d['unread_count'] == 0"
api "$JAR_B" POST '/api/notifications/read' '{"all":true}'
assert_py "Mark all is idempotent" "d['unread_count'] == 0"

for payload in '{}' '{"ids":[]}' '{"ids":[true]}' '{"ids":[1],"all":true}' '{"all":false}'; do
    api "$JAR_B" POST '/api/notifications/read' "$payload"
    [[ "$CODE" == 400 ]] || fail "Invalid read payload accepted: $payload"
done
pass "Invalid read payloads return 400"
api "$JAR_ANON" GET '/api/notifications'; [[ "$CODE" == 401 ]] && pass "Logged-out list returns 401" || fail "Logged-out list: $CODE"
api "$JAR_ANON" POST '/api/notifications/read' '{"all":true}'; [[ "$CODE" == 401 ]] && pass "Logged-out read returns 401" || fail "Logged-out read: $CODE"

api "$JAR_A" POST "/api/posts/$POST_ID/comments" '{"content":"delete me"}'
DELETE_COMMENT=$(echo "$BODY" | jq -r '.id')
api "$JAR_B" GET '/api/notifications'
DELETE_NOTIFICATION=$(echo "$BODY" | jq -r ".notifications[] | select(.preview == \"delete me\") | .id")
api "$JAR_A" DELETE "/api/comments/$DELETE_COMMENT"
api "$JAR_B" GET '/api/notifications'
assert_py "Deleted comment removes notification from list and count" "all(n['id'] != $DELETE_NOTIFICATION for n in d['notifications']) and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"

api "$JAR_C" POST '/api/posts' '{"content":"temporary post"}'
DELETE_POST=$(echo "$BODY" | jq -r '.id')
api "$JAR_A" POST "/api/posts/$DELETE_POST/like"
api "$JAR_C" GET '/api/notifications'
DELETE_POST_NOTIFICATION=$(echo "$BODY" | jq -r ".notifications[] | select(.post.id == $DELETE_POST) | .id")
api "$JAR_C" DELETE "/api/posts/$DELETE_POST"
api "$JAR_C" GET '/api/notifications'
assert_py "Deleted post removes notification from list and count" "all(n['id'] != $DELETE_POST_NOTIFICATION for n in d['notifications']) and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"

COMM_ID=$(pg_psql -c "INSERT INTO communities (slug,name,description,topic,type,creator_id) VALUES ('notif-private-$RUN_ID','Private','x','x','private',$B_ID) RETURNING id;" | head -n1)
pg_psql -c "INSERT INTO community_members (community_id,user_id,role) VALUES ($COMM_ID,$B_ID,'creator'),($COMM_ID,$A_ID,'member');" >/dev/null
PRIVATE_POST=$(pg_psql -c "INSERT INTO posts (user_id,content,audience,community_id) VALUES ($B_ID,'private snapshot','Community',$COMM_ID) RETURNING id;" | head -n1)
api "$JAR_A" POST "/api/posts/$PRIVATE_POST/like"
api "$JAR_B" GET '/api/notifications'
assert_py "Private notification is visible while recipient is a member" "any(n['post'] and n['post']['id'] == $PRIVATE_POST for n in d['notifications'])"
pg_psql -c "DELETE FROM community_members WHERE community_id=$COMM_ID AND user_id=$B_ID;" >/dev/null
api "$JAR_B" GET '/api/notifications'
assert_py "Losing private access hides notification and unread count" "all(not (n['post'] and n['post']['id'] == $PRIVATE_POST) for n in d['notifications']) and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"

echo "Notifications: $PASSED passed, $FAILED failed"
[[ "$FAILED" == 0 ]]
