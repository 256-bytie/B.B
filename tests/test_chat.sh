#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/test_guard.sh" || exit 1

# End-to-end tests for the direct messaging API (conversations, messages,
# read cursors, long-poll updates). Run against a server started with an
# isolated DB (never beebo.db):
#   bash tests/test_chat.sh
# Uses unique per-run emails, so it needs no direct DB access and is safe
# to re-run against the same test database.

BASE_URL="http://127.0.0.1:5050"
PASSED=0
FAILED=0
RUN_ID="$(date +%s)$$"
EMAIL_A="chat_a_${RUN_ID}@example.com"
EMAIL_B="chat_b_${RUN_ID}@example.com"
EMAIL_C="chat_c_${RUN_ID}@example.com"
JAR_A="chat_cookie_a_${RUN_ID}.txt"
JAR_B="chat_cookie_b_${RUN_ID}.txt"
JAR_C="chat_cookie_c_${RUN_ID}.txt"
JAR_ANON="chat_cookie_anon_${RUN_ID}.txt"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${YELLOW}ℹ INFO${NC}: $1"; }
cleanup() { rm -f "$JAR_A" "$JAR_B" "$JAR_C" "$JAR_ANON"; }
trap cleanup EXIT

# json_get '<json>' 'python expression on d' -> prints value
json_get() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print($2)" "$1" 2>/dev/null; }

signup() { # jar email -> "csrf_token user_id"
    curl -s -c "$1" -b "$1" -X POST "$BASE_URL/api/signup" \
        -H "Content-Type: application/json" \
        -d "{\"full_name\":\"Chat Tester\",\"email\":\"$2\",\"password\":\"testpass123\"}" \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('csrf_token',''), d.get('user',{}).get('id',''))"
}

http() { # method jar url [data] [csrf] -> "\n<status>" appended body
    local method=$1 jar=$2 url=$3 data=$4 csrf=$5
    if [[ -n "$data" ]]; then
        curl -s -w "\n%{http_code}" -X "$method" -b "$jar" "$url" \
            -H "Content-Type: application/json" ${csrf:+-H "X-CSRF-Token: $csrf"} \
            -d "$data"
    else
        curl -s -w "\n%{http_code}" -X "$method" -b "$jar" "$url"
    fi
}

info "Starting Direct Messaging tests"

# --- auth required ---
curl -s -c "$JAR_ANON" "$BASE_URL/api/session" > /dev/null
for path in "/api/chat/conversations" "/api/chat/updates"; do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_ANON" "$BASE_URL$path")
    [[ "$CODE" == "401" ]] && pass "GET $path requires login (401)" || fail "GET $path should be 401 logged out, got $CODE"
done

# --- signup three users ---
read -r CSRF_A A_ID <<< "$(signup "$JAR_A" "$EMAIL_A")"
read -r CSRF_B B_ID <<< "$(signup "$JAR_B" "$EMAIL_B")"
read -r CSRF_C C_ID <<< "$(signup "$JAR_C" "$EMAIL_C")"
[[ -n "$CSRF_A" && -n "$A_ID" ]] && pass "Signed up users A/B/C (A id=$A_ID)" || { fail "Signup failed - aborting"; exit 1; }

# --- CSRF enforced ---
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_A" -X POST "$BASE_URL/api/chat/conversations" \
    -H "Content-Type: application/json" -d "{\"user_id\": $B_ID}")
[[ "$CODE" == "403" ]] && pass "Create conversation without CSRF rejected (403)" || fail "Expected 403 without CSRF, got $CODE"

# --- create conversation ---
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations" "{\"user_id\": $B_ID}" "$CSRF_A")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "201" ]] && pass "A starts DM with B (201)" || fail "Expected 201, got $CODE: $BODY"
CONV_ID=$(json_get "$BODY" "d['id']")
[[ "$(json_get "$BODY" "d['user']['id']")" == "$B_ID" ]] && pass "Conversation carries the other user's public shape" || fail "Bad user object: $BODY"
[[ "$(json_get "$BODY" "d['last_message']")" == "None" ]] && pass "New conversation has no last_message" || fail "Expected null last_message: $BODY"
[[ "$(json_get "$BODY" "d['unread_count']")" == "0" ]] && pass "New conversation unread_count 0" || fail "Expected 0: $BODY"

# duplicate returns same conversation with 200
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations" "{\"user_id\": $B_ID}" "$CSRF_A")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "200" && "$(json_get "$BODY" "d['id']")" == "$CONV_ID" ]] \
    && pass "Duplicate start returns same conversation (200)" || fail "Expected 200 same id, got $CODE: $BODY"

# from the other user: same conversation
RESP=$(http POST "$JAR_B" "$BASE_URL/api/chat/conversations" "{\"user_id\": $A_ID}" "$CSRF_B")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "200" && "$(json_get "$BODY" "d['id']")" == "$CONV_ID" && "$(json_get "$BODY" "d['user']['id']")" == "$A_ID" ]] \
    && pass "B starting with A returns the same conversation, user=A" || fail "Got $CODE: $BODY"

# --- validation: self, invalid, unknown ---
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations" "{\"user_id\": $A_ID}" "$CSRF_A")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "400" ]] && pass "Self-DM rejected (400)" || fail "Expected 400 for self-DM, got $CODE"
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations" "{\"user_id\": 999999}" "$CSRF_A")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "404" ]] && pass "Unknown user rejected (404)" || fail "Expected 404 for unknown user, got $CODE"
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations" "{\"user_id\": \"nope\"}" "$CSRF_A")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "400" ]] && pass "Non-integer user_id rejected (400)" || fail "Expected 400 for bad user_id, got $CODE"

# --- send messages ---
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations/$CONV_ID/messages" '{"body": "hello B", "client_id": "c1"}' "$CSRF_A")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "201" ]] && pass "A sends message (201)" || fail "Expected 201, got $CODE: $BODY"
MSG1_ID=$(json_get "$BODY" "d['message']['id']")
[[ "$(json_get "$BODY" "d['message']['sender_id']")" == "$A_ID" && "$(json_get "$BODY" "d['message']['body']")" == "hello B" ]] \
    && pass "Message carries sender_id from session (not body)" || fail "Bad message: $BODY"

# idempotent retry: same client_id -> 200, same message, not duplicated
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations/$CONV_ID/messages" '{"body": "hello B", "client_id": "c1"}' "$CSRF_A")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "200" && "$(json_get "$BODY" "d['message']['id']")" == "$MSG1_ID" ]] \
    && pass "Retry with same client_id returns existing message (200)" || fail "Expected 200 same id, got $CODE: $BODY"

# same client_id from another sender is a different message
RESP=$(http POST "$JAR_B" "$BASE_URL/api/chat/conversations/$CONV_ID/messages" '{"body": "hi A", "client_id": "c1"}' "$CSRF_B")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "201" ]] && pass "Same client_id from other sender is a new message" || fail "Expected 201, got $CODE: $BODY"
MSG2_ID=$(json_get "$BODY" "d['message']['id']")

# validation
for bad in '{"body": ""}' '{"body": "   "}'; do
    RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations/$CONV_ID/messages" "$bad" "$CSRF_A")
    CODE=$(echo "$RESP" | tail -n1)
    [[ "$CODE" == "400" ]] && pass "Empty body rejected (400): $bad" || fail "Expected 400 for $bad, got $CODE"
done
LONG=$(python3 -c "print('x'*2001)")
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations/$CONV_ID/messages" "{\"body\": \"$LONG\"}" "$CSRF_A")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "400" ]] && pass "Over-2000-char body rejected (400)" || fail "Expected 400 for long body, got $CODE"

# trimmed body stored
RESP=$(http POST "$JAR_A" "$BASE_URL/api/chat/conversations/$CONV_ID/messages" '{"body": "  padded  "}' "$CSRF_A")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "d['message']['body']")" == "padded" ]] && pass "Body is trimmed" || fail "Trim failed: $BODY"
MSG3_ID=$(json_get "$BODY" "d['message']['id']")

# --- recipient sees it: list + history + unread ---
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/conversations")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "len(d['conversations'])")" == "1" ]] && pass "B's list has 1 conversation" || fail "Bad list: $BODY"
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/conversations")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "d['conversations'][0]['unread_count']")" == "2" ]] && pass "B has unread_count 2 (A sent 2, B's own excluded)" || fail "Expected 2 unread: $BODY"
[[ "$(json_get "$BODY" "d['conversations'][0]['last_message']['body']")" == "padded" ]] && pass "last_message is newest" || fail "Bad last_message: $BODY"
[[ "$(json_get "$BODY" "d['conversations'][0]['user']['id']")" == "$A_ID" ]] && pass "List user is the other participant" || fail "Bad user: $BODY"

RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/conversations/$CONV_ID/messages")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$(json_get "$BODY" "' '.join(m['body'] for m in d['messages'])")" == "hello B hi A padded" ]] \
    && pass "History ascending (oldest first)" || fail "Bad history: $BODY"
[[ "$(json_get "$BODY" "d['has_more']")" == "False" ]] && pass "has_more False on complete page" || fail "has_more wrong: $BODY"

# --- paging ---
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/conversations/$CONV_ID/messages?limit=2")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "' '.join(m['body'] for m in d['messages'])")" == "hi A padded" && "$(json_get "$BODY" "d['has_more']")" == "True" ]] \
    && pass "limit=2 returns newest 2 ascending + has_more" || fail "Paging wrong: $BODY"
BEFORE=$(json_get "$BODY" "d['messages'][0]['id']")
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/conversations/$CONV_ID/messages?before=$BEFORE")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "' '.join(m['body'] for m in d['messages'])")" == "hello B" && "$(json_get "$BODY" "d['has_more']")" == "False" ]] \
    && pass "before=<id> pages further back" || fail "before-paging wrong: $BODY"

# --- read cursor ---
# A sent "hello B" (MSG1) and "padded" (MSG3); B sent "hi A" (MSG2).
# B's unread before reading = 2. Reading up_to=MSG2 ("hi A") covers MSG1
# too, leaving only MSG3 unread.
RESP=$(http POST "$JAR_B" "$BASE_URL/api/chat/conversations/$CONV_ID/read" "{\"up_to\": $MSG2_ID}" "$CSRF_B")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "204" ]] && pass "Mark read returns 204" || fail "Expected 204, got $CODE"
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/conversations")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "d['conversations'][0]['unread_count']")" == "1" ]] && pass "Unread drops to 1 after reading up to msg2" || fail "Unread wrong: $BODY"
RESP=$(http POST "$JAR_B" "$BASE_URL/api/chat/conversations/$CONV_ID/read" "{\"up_to\": $MSG1_ID}" "$CSRF_B")
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/conversations")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "d['conversations'][0]['unread_count']")" == "1" ]] && pass "Cursor never moves backwards" || fail "Backwards move changed unread: $BODY"
RESP=$(http POST "$JAR_B" "$BASE_URL/api/chat/conversations/$CONV_ID/read" "{\"up_to\": 999999}" "$CSRF_B")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "204" ]] && pass "up_to beyond last message clamped (204)" || fail "Clamp failed, got $CODE"

# --- cross-user access (404, do not reveal existence) ---
RESP=$(http GET "$JAR_C" "$BASE_URL/api/chat/conversations/$CONV_ID/messages")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "404" ]] && pass "Outsider reading history gets 404" || fail "Expected 404, got $CODE"
RESP=$(http POST "$JAR_C" "$BASE_URL/api/chat/conversations/$CONV_ID/messages" '{"body": "sneak"}' "$CSRF_C")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "404" ]] && pass "Outsider posting gets 404" || fail "Expected 404, got $CODE"
RESP=$(http POST "$JAR_C" "$BASE_URL/api/chat/conversations/$CONV_ID/read" '{"up_to": 1}' "$CSRF_C")
CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "404" ]] && pass "Outsider marking read gets 404" || fail "Expected 404, got $CODE"
RESP=$(http GET "$JAR_C" "$BASE_URL/api/chat/conversations")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "len(d['conversations'])")" == "0" ]] && pass "Outsider's list is empty (cannot discover the conversation)" || fail "Leaked conversation: $BODY"

# --- updates endpoint ---
# Long-poll: B resumes from the last message id it already has (MSG3),
# waits up to 10s; A sends "realtime!" 1s in; the poll must return early
# with exactly that message and none of the older ones.
(
    sleep 1
    http POST "$JAR_A" "$BASE_URL/api/chat/conversations/$CONV_ID/messages" '{"body": "realtime!"}' "$CSRF_A" > /dev/null
) &
SENDER_PID=$!
START=$(date +%s)
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/updates?after=$MSG3_ID&wait_seconds=10")
ELAPSED=$(( $(date +%s) - START ))
wait $SENDER_PID 2>/dev/null
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n1)
[[ "$CODE" == "200" && "$(json_get "$BODY" "len(d['messages'])")" == "1" && "$(json_get "$BODY" "d['messages'][0]['body']")" == "realtime!" ]] \
    && pass "Long-poll delivers only the new message without refresh" || fail "Long-poll failed ($CODE): $BODY"
[[ "$ELAPSED" -lt 8 ]] && pass "Long-poll returned early (~${ELAPSED}s, not the full 10s)" || fail "Long-poll waited the full timeout (${ELAPSED}s)"

LAST_ID=$(json_get "$BODY" "d['messages'][-1]['id']")
[[ -n "$LAST_ID" && "$LAST_ID" != "None" ]] || { fail "No last message id from updates, cannot continue updates tests"; LAST_ID=0; }
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/updates?after=$LAST_ID&wait_seconds=0")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "len(d['messages'])")" == "0" ]] && pass "Resume cursor: nothing new after last id" || fail "Cursor leaked old messages: $BODY"

# Timeout path: no messages sent; wait_seconds=2 must return after ~2s with empty page.
START=$(date +%s%N)
RESP=$(http GET "$JAR_B" "$BASE_URL/api/chat/updates?after=$LAST_ID&wait_seconds=2")
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
[[ "$ELAPSED_MS" -ge 1800 && "$ELAPSED_MS" -lt 6000 ]] \
    && pass "Idle long-poll returns after its timeout (${ELAPSED_MS}ms)" || fail "Idle long-poll timing off: ${ELAPSED_MS}ms"

# updates exclude other users' conversations: C polls; C is in no
# conversation, so nothing (from the A<->B thread) may appear.
RESP=$(http GET "$JAR_C" "$BASE_URL/api/chat/updates?after=0")
BODY=$(echo "$RESP" | sed '$d')
LEAKED=$(json_get "$BODY" "len(d['messages']) + len(d['conversations'])")
[[ "$LEAKED" == "0" ]] && pass "Updates exclude conversations the viewer is not in" || fail "Leaked messages: $BODY"

# conv_after narrows the conversation list
RESP=$(http GET "$JAR_C" "$BASE_URL/api/chat/updates?conv_after=999999")
BODY=$(echo "$RESP" | sed '$d')
[[ "$(json_get "$BODY" "len(d['conversations'])")" == "0" ]] && pass "conv_after filters the conversation list" || fail "conv_after ignored: $BODY"

# --- rate limit (20 per 10s) ---
# Note: C hits its own limiter bucket (limiters are per-user); C is not a
# member of the conversation, so these all 404 until the limiter trips.
RL_BLOCKED=0
for i in $(seq 1 25); do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR_C" -X POST "$BASE_URL/api/chat/conversations/$CONV_ID/messages" \
        -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_C" -d "{\"body\": \"spam $i\"}")
    [[ "$CODE" == "429" ]] && RL_BLOCKED=$((RL_BLOCKED + 1))
done
[[ "$RL_BLOCKED" -ge 1 ]] && pass "Rate limit kicks in on message spam (got $RL_BLOCKED x 429)" || fail "No 429 after 25 rapid sends"

# --- persistence across restart is covered by the test runner restarting ---
info "Note: restart persistence is verified by scripts/run_all_tests.sh restarting the server between suites"

echo ""
echo "=========================================="
echo "Chat tests: $PASSED passed, $FAILED failed"
echo "=========================================="
[[ "$FAILED" -eq 0 ]] || exit 1
