#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/test_guard.sh" || exit 1

BASE_URL="http://127.0.0.1:5050"
RUN_ID="$(date +%s)$$"
JAR_A="notif_a_${RUN_ID}.txt"
JAR_B="notif_b_${RUN_ID}.txt"
JAR_C="notif_c_${RUN_ID}.txt"
JAR_D="notif_d_${RUN_ID}.txt"
JAR_E="notif_e_${RUN_ID}.txt"
JAR_F="notif_f_${RUN_ID}.txt"
JAR_ANON="notif_anon_${RUN_ID}.txt"
PASSED=0
FAILED=0

pass() { echo "✓ PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "✗ FAIL: $1"; FAILED=$((FAILED + 1)); }
cleanup() { rm -f "$JAR_A" "$JAR_B" "$JAR_C" "$JAR_D" "$JAR_E" "$JAR_F" "$JAR_ANON"; }
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
D=$(signup "$JAR_D" "User D" "notif_d_${RUN_ID}@example.com")
E=$(signup "$JAR_E" "User E" "notif_e_${RUN_ID}@example.com")
A_ID=$(echo "$A" | jq -r '.user.id'); A_USER=$(echo "$A" | jq -r '.user.username')
B_ID=$(echo "$B" | jq -r '.user.id'); B_USER=$(echo "$B" | jq -r '.user.username')
C_ID=$(echo "$C" | jq -r '.user.id'); C_USER=$(echo "$C" | jq -r '.user.username')
D_ID=$(echo "$D" | jq -r '.user.id'); D_USER=$(echo "$D" | jq -r '.user.username')
E_ID=$(echo "$E" | jq -r '.user.id'); E_USER=$(echo "$E" | jq -r '.user.username')
curl -s -c "$JAR_ANON" "$BASE_URL/api/session" >/dev/null

# Keep the Phase 1/2 assertions focused on social notifications; monthly
# credits are now materialized lazily by GET /api/notifications.
for jar in "$JAR_A" "$JAR_B" "$JAR_C" "$JAR_D" "$JAR_E"; do
    api "$jar" POST '/api/wallet/claim'
    [[ "$CODE" == 201 ]] || fail "Claim fixture monthly credits: $CODE $BODY"
done

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

api "$JAR_C" POST "/api/posts/$POST_ID/like"
api "$JAR_D" POST "/api/posts/$POST_ID/like"
api "$JAR_B" GET '/api/notifications'
assert_py "Post likes aggregate with newest actor" "sum(n['type'] == 'post_like' for n in d['notifications']) == 1 and next(n for n in d['notifications'] if n['type'] == 'post_like')['others_count'] == 2 and next(n for n in d['notifications'] if n['type'] == 'post_like')['actor']['id'] == $D_ID and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"
AGGREGATE_ID=$(echo "$BODY" | jq -r '.notifications[] | select(.type == "post_like") | .id')
api "$JAR_B" POST '/api/notifications/read' "{\"ids\":[$AGGREGATE_ID]}"
api "$JAR_B" GET '/api/notifications'
assert_py "Marking an aggregate marks the whole group" "next(n for n in d['notifications'] if n['type'] == 'post_like')['read'] is True"
COUNT_BEFORE_FOURTH=$(echo "$BODY" | jq -r '.unread_count')
api "$JAR_E" POST "/api/posts/$POST_ID/like"
api "$JAR_B" GET '/api/notifications'
assert_py "A new like revives the aggregate unread" "d['notifications'][0]['type'] == 'post_like' and d['notifications'][0]['actor']['id'] == $E_ID and d['notifications'][0]['others_count'] == 3 and d['notifications'][0]['read'] is False and d['unread_count'] == $((COUNT_BEFORE_FOURTH + 1))"
api "$JAR_E" POST "/api/posts/$POST_ID/like"
api "$JAR_B" GET '/api/notifications'
assert_py "Unlike leaves aggregate others_count unchanged" "next(n for n in d['notifications'] if n['type'] == 'post_like')['others_count'] == 3"

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

api "$JAR_C" POST "/api/comments/$COMMENT_A/like"
api "$JAR_A" GET '/api/notifications'
assert_py "Comment like includes comment preview and parent snapshot" "sum(n['type'] == 'comment_like' for n in d['notifications']) == 1 and any(n['type'] == 'comment_like' and n['actor']['id'] == $C_ID and n['preview'].startswith('word word') and n['post']['id'] == $POST_ID and n['community'] is None for n in d['notifications'])"
api "$JAR_C" POST "/api/comments/$COMMENT_A/like"
api "$JAR_C" POST "/api/comments/$COMMENT_A/like"
api "$JAR_A" POST "/api/comments/$COMMENT_A/like"
api "$JAR_A" GET '/api/notifications'
assert_py "Comment re-like dedupes and self-like creates nothing" "sum(n['type'] == 'comment_like' for n in d['notifications']) == 1"
api "$JAR_D" POST "/api/comments/$COMMENT_A/like"
api "$JAR_A" GET '/api/notifications'
assert_py "Comment likes aggregate separately from post likes" "sum(n['type'] == 'comment_like' for n in d['notifications']) == 1 and next(n for n in d['notifications'] if n['type'] == 'comment_like')['others_count'] == 1"

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

api "$JAR_A" POST '/api/posts' '{"content":"second aggregation target"}'
SECOND_POST=$(echo "$BODY" | jq -r '.id')
api "$JAR_C" POST "/api/posts/$SECOND_POST/like"
api "$JAR_D" POST "/api/posts/$SECOND_POST/like"
api "$JAR_A" GET '/api/notifications'
assert_py "Likes on different posts stay separate" "sum(n['type'] == 'post_like' for n in d['notifications']) == 1 and next(n for n in d['notifications'] if n['type'] == 'post_like')['post']['id'] == $SECOND_POST"

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

api "$JAR_A" DELETE "/api/comments/$COMMENT_A"
api "$JAR_A" GET '/api/notifications'
assert_py "Deleting a comment removes its comment-like aggregate" "all(n['type'] != 'comment_like' for n in d['notifications'])"

api "$JAR_C" POST '/api/posts' '{"content":"temporary post"}'
DELETE_POST=$(echo "$BODY" | jq -r '.id')
api "$JAR_A" POST "/api/posts/$DELETE_POST/like"
api "$JAR_C" GET '/api/notifications'
DELETE_POST_NOTIFICATION=$(echo "$BODY" | jq -r ".notifications[] | select(.post.id == $DELETE_POST) | .id")
api "$JAR_C" DELETE "/api/posts/$DELETE_POST"
api "$JAR_C" GET '/api/notifications'
assert_py "Deleted post removes notification from list and count" "all(n['id'] != $DELETE_POST_NOTIFICATION for n in d['notifications']) and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"

api "$JAR_A" POST '/api/posts' '{"content":"quote source"}'
QUOTE_SOURCE=$(echo "$BODY" | jq -r '.id')
api "$JAR_C" POST '/api/posts' "{\"content\":\"quote notification text\",\"quoted_post_id\":$QUOTE_SOURCE}"
QUOTE_POST=$(echo "$BODY" | jq -r '.id')
api "$JAR_A" GET '/api/notifications'
assert_py "Quote notification snapshots and opens the quote" "any(n['type'] == 'post_quote' and n['actor']['id'] == $C_ID and n['preview'] == 'quote notification text' and n['post']['id'] == $QUOTE_POST and n['post']['user_id'] == $C_ID and n['others_count'] == 0 for n in d['notifications'])"
api "$JAR_A" POST '/api/posts' "{\"content\":\"self quote\",\"quoted_post_id\":$QUOTE_SOURCE}"
api "$JAR_A" GET '/api/notifications'
assert_py "Self quote creates no notification" "sum(n['type'] == 'post_quote' for n in d['notifications']) == 1"
api "$JAR_C" DELETE "/api/posts/$QUOTE_POST"
api "$JAR_A" GET '/api/notifications'
assert_py "Deleting the quote post removes its notification" "all(not (n['type'] == 'post_quote' and n['post'] and n['post']['id'] == $QUOTE_POST) for n in d['notifications'])"

COMM_ID=$(pg_psql -c "INSERT INTO communities (slug,name,description,topic,type,creator_id) VALUES ('notif-private-$RUN_ID','Private','x','x','private',$B_ID) RETURNING id;" | head -n1)
pg_psql -c "INSERT INTO community_members (community_id,user_id,role) VALUES ($COMM_ID,$B_ID,'creator'),($COMM_ID,$A_ID,'member');" >/dev/null
PRIVATE_POST=$(pg_psql -c "INSERT INTO posts (user_id,content,audience,community_id) VALUES ($B_ID,'private snapshot','Community',$COMM_ID) RETURNING id;" | head -n1)
api "$JAR_A" POST "/api/posts/$PRIVATE_POST/like"
api "$JAR_B" GET '/api/notifications'
assert_py "Private notification is visible while recipient is a member" "any(n['post'] and n['post']['id'] == $PRIVATE_POST for n in d['notifications'])"
pg_psql -c "DELETE FROM community_members WHERE community_id=$COMM_ID AND user_id=$B_ID;" >/dev/null
api "$JAR_B" GET '/api/notifications'
assert_py "Losing private access hides notification and unread count" "all(not (n['post'] and n['post']['id'] == $PRIVATE_POST) for n in d['notifications']) and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"

JOIN_COMM_ID=$(pg_psql -c "INSERT INTO communities (slug,name,description,topic,type,creator_id) VALUES ('notif-join-$RUN_ID','Join Notices','x','x','public',$A_ID) RETURNING id;" | head -n1)
pg_psql -c "INSERT INTO community_members (community_id,user_id,role) VALUES ($JOIN_COMM_ID,$A_ID,'creator'),($JOIN_COMM_ID,$B_ID,'moderator'),($JOIN_COMM_ID,$C_ID,'member');" >/dev/null
api "$JAR_D" POST "/api/communities/notif-join-$RUN_ID/join"
api "$JAR_A" GET '/api/notifications'
assert_py "Community join notifies creator with payload" "sum(n['type'] == 'community_join' and n['actor']['id'] == $D_ID for n in d['notifications']) == 1 and any(n['type'] == 'community_join' and n['community'] == {'slug':'notif-join-$RUN_ID','name':'Join Notices'} and n['post'] is None and n['preview'] is None for n in d['notifications'])"
api "$JAR_B" GET '/api/notifications'
assert_py "Community join notifies moderators" "sum(n['type'] == 'community_join' and n['actor']['id'] == $D_ID for n in d['notifications']) == 1"
api "$JAR_C" GET '/api/notifications'
assert_py "Community join skips plain members" "all(not (n['type'] == 'community_join' and n['actor']['id'] == $D_ID) for n in d['notifications'])"
api "$JAR_D" POST "/api/communities/notif-join-$RUN_ID/join"
api "$JAR_D" POST "/api/communities/notif-join-$RUN_ID/leave"
api "$JAR_D" POST "/api/communities/notif-join-$RUN_ID/join"
api "$JAR_A" GET '/api/notifications'
assert_py "Double join and rejoin do not create another row" "sum(n['type'] == 'community_join' and n['actor']['id'] == $D_ID for n in d['notifications']) == 1"

PRIVATE_JOIN_ID=$(pg_psql -c "INSERT INTO communities (slug,name,description,topic,type,creator_id) VALUES ('notif-private-join-$RUN_ID','Private Join','x','x','private',$A_ID) RETURNING id;" | head -n1)
pg_psql -c "INSERT INTO community_members (community_id,user_id,role) VALUES ($PRIVATE_JOIN_ID,$A_ID,'creator'),($PRIVATE_JOIN_ID,$B_ID,'moderator'),($PRIVATE_JOIN_ID,$D_ID,'member'); INSERT INTO notifications (recipient_id,actor_id,type,target_type,target_id,post_id,dedupe_key) VALUES ($B_ID,$D_ID,'community_join','community',$PRIVATE_JOIN_ID,NULL,'community_join:$D_ID:community:$PRIVATE_JOIN_ID');" >/dev/null
api "$JAR_B" GET '/api/notifications'
PRIVATE_JOIN_NOTIFICATION=$(echo "$BODY" | jq -r ".notifications[] | select(.community.slug == \"notif-private-join-$RUN_ID\") | .id")
PRIVATE_COUNT_BEFORE=$(echo "$BODY" | jq -r '.unread_count')
pg_psql -c "DELETE FROM community_members WHERE community_id=$PRIVATE_JOIN_ID AND user_id=$B_ID;" >/dev/null
api "$JAR_B" GET '/api/notifications'
assert_py "A moderator who leaves cannot see community joins" "all(n['id'] != $PRIVATE_JOIN_NOTIFICATION for n in d['notifications']) and d['unread_count'] == $((PRIVATE_COUNT_BEFORE - 1))"

PRIVATE_QUOTE_COMM=$(pg_psql -c "INSERT INTO communities (slug,name,description,topic,type,creator_id) VALUES ('notif-private-quote-$RUN_ID','Private Quote','x','x','private',$C_ID) RETURNING id;" | head -n1)
pg_psql -c "INSERT INTO community_members (community_id,user_id,role) VALUES ($PRIVATE_QUOTE_COMM,$C_ID,'creator');" >/dev/null
api "$JAR_C" POST "/api/communities/notif-private-quote-$RUN_ID/posts" "{\"content\":\"hidden community quote\",\"quoted_post_id\":$QUOTE_SOURCE}"
HIDDEN_QUOTE=$(echo "$BODY" | jq -r '.id')
api "$JAR_A" GET '/api/notifications'
assert_py "Private community quote is hidden from list and count" "all(not (n['post'] and n['post']['id'] == $HIDDEN_QUOTE) for n in d['notifications']) and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"

api "$JAR_B" GET '/api/notifications?limit=2'
ALL_PAGES="$BODY"
CURSOR=$(echo "$BODY" | jq -r '.next_cursor // empty')
while [[ -n "$CURSOR" ]]; do
    api "$JAR_B" GET "/api/notifications?limit=2&cursor=$CURSOR"
    ALL_PAGES="$ALL_PAGES|$BODY"
    CURSOR=$(echo "$BODY" | jq -r '.next_cursor // empty')
done
PAGES="$ALL_PAGES" python3 - <<'PY' && pass "Mixed pagination has no gaps and unread count matches" || fail "Mixed pagination aggregation"
import json, os
pages = [json.loads(value) for value in os.environ['PAGES'].split('|')]
items = [item for page in pages for item in page['notifications']]
ids = [item['id'] for item in items]
assert len(ids) == len(set(ids))
assert ids == sorted(ids, reverse=True)
assert pages[0]['unread_count'] == sum(not item['read'] for item in items)
PY

# ---------------------------------------------------------------------------
# Phase 3: mention, community_post (all + popular), monthly_credits
# ---------------------------------------------------------------------------
F=$(signup "$JAR_F" "User F" "notif_f_${RUN_ID}@example.com")
F_ID=$(echo "$F" | jq -r '.user.id')

# monthly_credits: F has never claimed. Four parallel first reads must create one row.
for _ in 1 2 3 4; do curl -s -b "$JAR_F" "$BASE_URL/api/notifications" >/dev/null & done
wait
[[ "$(pg_psql -c "SELECT COUNT(*) FROM notifications WHERE recipient_id=$F_ID AND type='monthly_credits';")" == "1" ]] \
    && pass "Concurrent first reads create one monthly credits row" || fail "Concurrent monthly credits rows"
api "$JAR_F" GET '/api/notifications'
assert_py "Monthly credits item has null actor and post and counts as unread" "len(d['notifications']) == 1 and d['notifications'][0]['type'] == 'monthly_credits' and d['notifications'][0]['actor'] is None and d['notifications'][0]['post'] is None and d['notifications'][0]['preview'] is None and d['notifications'][0]['read'] is False and d['unread_count'] == 1"
api "$JAR_F" POST '/api/wallet/claim'
[[ "$CODE" == 201 ]] && pass "Fixture claim for F" || fail "Fixture claim for F: $CODE $BODY"
api "$JAR_F" GET '/api/notifications'
assert_py "Claiming removes monthly credits row and it is not re-created before next claim" "len(d['notifications']) == 0 and d['unread_count'] == 0"
pg_psql -c "UPDATE credit_transactions SET created_at = created_at - interval '31 days' WHERE user_id=$F_ID AND reason='monthly_reward';" >/dev/null
api "$JAR_F" GET '/api/notifications'
assert_py "A new claim cycle creates a new monthly credits row" "len(d['notifications']) == 1 and d['notifications'][0]['type'] == 'monthly_credits' and d['unread_count'] == 1"
api "$JAR_F" POST '/api/wallet/claim'

# mention: post
api "$JAR_B" POST '/api/posts' "{\"content\":\"hello @$A_USER mention post\"}"
MENTION_POST=$(echo "$BODY" | jq -r '.id')
api "$JAR_A" GET '/api/notifications?limit=50'
assert_py "Post mention notifies with snapshot and preview" "sum(n['type'] == 'mention' and n['actor']['id'] == $B_ID and n['post']['id'] == $MENTION_POST and n['preview'] == 'hello @$A_USER mention post' and n['others_count'] == 0 for n in d['notifications']) == 1"
api "$JAR_A" POST '/api/posts' "{\"content\":\"self @$A_USER mention\"}"
api "$JAR_B" POST '/api/posts' "{\"content\":\"ping @nobody_$RUN_ID and a@b.com\"}"
[[ "$CODE" == 201 ]] && pass "Unknown handle and email-like text do not break post creation" || fail "Unknown handle post: $CODE $BODY"
api "$JAR_A" GET '/api/notifications?limit=50'
assert_py "Self mention creates nothing" "all(not (n['type'] == 'mention' and (n['preview'] or '').startswith('self @')) for n in d['notifications'])"

# mention precedence: quote
api "$JAR_D" POST '/api/posts' "{\"content\":\"quote with @$A_USER\",\"quoted_post_id\":$QUOTE_SOURCE}"
QUOTE_MENTION=$(echo "$BODY" | jq -r '.id')
api "$JAR_A" GET '/api/notifications?limit=50'
assert_py "Mention wins over post_quote for the same post" "[n['type'] for n in d['notifications'] if n['post'] and n['post']['id'] == $QUOTE_MENTION] == ['mention']"

# mention precedence: top-level comment
api "$JAR_C" POST "/api/posts/$SECOND_POST/comments" "{\"content\":\"@$A_USER precedence marker\"}"
api "$JAR_A" GET '/api/notifications?limit=50'
assert_py "Comment mention previews the comment and suppresses post_comment" "sum(n['type'] == 'mention' and n['actor']['id'] == $C_ID and n['post']['id'] == $SECOND_POST and 'precedence marker' in (n['preview'] or '') for n in d['notifications']) == 1 and all(not (n['type'] == 'post_comment' and 'precedence marker' in (n['preview'] or '')) for n in d['notifications'])"

# mention precedence: reply
api "$JAR_B" POST "/api/posts/$SECOND_POST/comments" '{"content":"parent for reply mention"}'
REPLY_PARENT=$(echo "$BODY" | jq -r '.id')
api "$JAR_A" POST "/api/posts/$SECOND_POST/comments" "{\"content\":\"@$B_USER reply mention\",\"parent_comment_id\":$REPLY_PARENT}"
api "$JAR_B" GET '/api/notifications?limit=50'
assert_py "Reply mention suppresses comment_reply" "sum(n['type'] == 'mention' and n['actor']['id'] == $A_ID and 'reply mention' in (n['preview'] or '') for n in d['notifications']) == 1 and all(not (n['type'] == 'comment_reply' and 'reply mention' in (n['preview'] or '')) for n in d['notifications'])"

api "$JAR_B" DELETE "/api/posts/$MENTION_POST"
api "$JAR_A" GET '/api/notifications?limit=50'
assert_py "Deleting the post removes its mention" "all(not (n['post'] and n['post']['id'] == $MENTION_POST) for n in d['notifications']) and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"

# community_post
CP_SLUG="notif-post-$RUN_ID"
CP_COMM_ID=$(pg_psql -c "INSERT INTO communities (slug,name,description,topic,type,creator_id) VALUES ('$CP_SLUG','Post Notices','x','x','public',$A_ID) RETURNING id;" | head -n1)
pg_psql -c "INSERT INTO community_members (community_id,user_id,role,notification_level) VALUES ($CP_COMM_ID,$A_ID,'creator','all'),($CP_COMM_ID,$B_ID,'member','all'),($CP_COMM_ID,$C_ID,'member','popular'),($CP_COMM_ID,$D_ID,'member','off'),($CP_COMM_ID,$E_ID,'member','muted');" >/dev/null
api "$JAR_A" POST "/api/communities/$CP_SLUG/posts" '{"content":"community post notify"}'
CP_POST=$(echo "$BODY" | jq -r '.id')
api "$JAR_B" GET '/api/notifications?limit=50'
assert_py "Level all member is notified with snapshot, preview and community" "sum(n['type'] == 'community_post' and n['actor']['id'] == $A_ID and n['post']['id'] == $CP_POST and n['preview'] == 'community post notify' and n['community'] == {'slug':'$CP_SLUG','name':'Post Notices'} for n in d['notifications']) == 1"
for pair in "A:$JAR_A" "C:$JAR_C" "D:$JAR_D" "E:$JAR_E" "F:$JAR_F"; do
    label="${pair%%:*}"; jar="${pair#*:}"
    api "$jar" GET '/api/notifications?limit=50'
    assert_py "User $label gets no community_post at creation (author, popular, off, muted, non-member)" "all(not (n['type'] == 'community_post' and n['post'] and n['post']['id'] == $CP_POST) for n in d['notifications'])"
done

# popular threshold: five likes (author included) notify popular members exactly once
for jar in "$JAR_A" "$JAR_B" "$JAR_D" "$JAR_E"; do api "$jar" POST "/api/posts/$CP_POST/like"; done
api "$JAR_C" GET '/api/notifications?limit=50'
assert_py "Popular member is not notified before the threshold" "all(n['type'] != 'community_post' for n in d['notifications'])"
api "$JAR_F" POST "/api/posts/$CP_POST/like"
api "$JAR_C" GET '/api/notifications?limit=50'
assert_py "Fifth like notifies popular member once" "sum(n['type'] == 'community_post' and n['actor']['id'] == $A_ID and n['post']['id'] == $CP_POST and n['community']['slug'] == '$CP_SLUG' for n in d['notifications']) == 1"
api "$JAR_F" POST "/api/posts/$CP_POST/like"
api "$JAR_F" POST "/api/posts/$CP_POST/like"
api "$JAR_C" GET '/api/notifications?limit=50'
assert_py "Re-crossing the threshold does not duplicate" "sum(n['type'] == 'community_post' for n in d['notifications']) == 1"
api "$JAR_B" GET '/api/notifications?limit=50'
assert_py "Level all member is not notified again at the threshold" "sum(n['type'] == 'community_post' and n['post']['id'] == $CP_POST for n in d['notifications']) == 1"

api "$JAR_A" DELETE "/api/posts/$CP_POST"
api "$JAR_B" GET '/api/notifications?limit=50'
assert_py "Deleting the community post removes community_post rows and plain posts created none" "all(n['type'] != 'community_post' for n in d['notifications']) and d['unread_count'] == sum(not n['read'] for n in d['notifications'])"
api "$JAR_C" GET '/api/notifications?limit=50'
assert_py "Deleting the community post removes the popular notification" "all(n['type'] != 'community_post' for n in d['notifications'])"

echo "Notifications: $PASSED passed, $FAILED failed"
[[ "$FAILED" == 0 ]]
