#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/test_guard.sh" || exit 1
set -e

BASE=http://localhost:5050
RUN=$RANDOM$RANDOM
PASS=0; FAIL=0

if [[ "${BEEBO_SERVER_RUNNING:-0}" != 1 ]]; then
    python3 -B app.py &
    SERVER_PID=$!
    sleep 3
fi
cleanup() {
    kill "${SERVER_PID:-}" 2>/dev/null || true
    rm -f jar_a_$RUN.txt jar_b_$RUN.txt jar_c_$RUN.txt
}
trap cleanup EXIT

check() {  # check "label" expected actual
    if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS+1))
    else echo "  FAIL  $1 (expected '$2', got '$3')"; FAIL=$((FAIL+1)); fi
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
http_code() { test_curl -s -o /dev/null -w '%{http_code}' "$@"; }

signup_login() {  # jar email name
    test_curl -s -c "$1" -X POST $BASE/api/signup -H 'Content-Type: application/json' \
        -d "{\"email\":\"$2\",\"password\":\"password123\",\"full_name\":\"$3\"}" >/dev/null
    test_curl -s -b "$1" -c "$1" -X POST $BASE/api/login -H 'Content-Type: application/json' \
        -d "{\"email\":\"$2\",\"password\":\"password123\"}" >/dev/null
}
new_post() {  # jar content -> id
    test_curl -s -b "$1" -X POST $BASE/api/posts -H 'Content-Type: application/json' \
        -d "{\"content\":\"$2\"}" | jget "d['id']"
}
repost()   { test_curl -s -b "$1" -X POST   $BASE/api/posts/$2/repost; }
unrepost() { test_curl -s -b "$1" -X DELETE $BASE/api/posts/$2/repost; }
db_count() { pg_psql -c "$1"; }

A=jar_a_$RUN.txt; B=jar_b_$RUN.txt; C=jar_c_$RUN.txt
echo "== setup"
signup_login $A "rp_a_$RUN@example.com" "Author A"
signup_login $B "rp_b_$RUN@example.com" "Reposter B"
signup_login $C "rp_c_$RUN@example.com" "Outsider C"
UID_A=$(db_count "SELECT id FROM users WHERE email='rp_a_$RUN@example.com'")
UID_B=$(db_count "SELECT id FROM users WHERE email='rp_b_$RUN@example.com'")
UID_C=$(db_count "SELECT id FROM users WHERE email='rp_c_$RUN@example.com'")

echo "== repost is idempotent"
P1=$(new_post $A "repost target $RUN")
R1=$(repost $B $P1)
check "first repost reposted=True" True "$(echo "$R1" | jget "d['reposted']")"
check "first repost share_count=1" 1 "$(echo "$R1" | jget "d['share_count']")"
R2=$(repost $B $P1)
check "second repost share_count still 1" 1 "$(echo "$R2" | jget "d['share_count']")"
check "one DB row" 1 "$(db_count "SELECT count(*) FROM reposts WHERE user_id=$UID_B AND post_id=$P1")"
check "one notification for author" 1 "$(db_count "SELECT count(*) FROM notifications WHERE type='post_repost' AND recipient_id=$UID_A AND post_id=$P1")"

echo "== payload fields"
FEED=$(test_curl -s -b $B "$BASE/api/posts?limit=50")
check "reposted_by_user true for B" True "$(echo "$FEED" | jget "[p for p in d['posts'] if p['id']==$P1][0]['reposted_by_user']")"
FEED_A=$(test_curl -s -b $A "$BASE/api/posts?limit=50")
check "reposted_by_user false for A" False "$(echo "$FEED_A" | jget "[p for p in d['posts'] if p['id']==$P1][0]['reposted_by_user']")"
check "share_count=1 in feed" 1 "$(echo "$FEED_A" | jget "[p for p in d['posts'] if p['id']==$P1][0]['share_count']")"
check "feed items are not reposts" False "$(echo "$FEED_A" | jget "[p for p in d['posts'] if p['id']==$P1][0]['is_repost']")"

echo "== reposts tab"
TAB=$(test_curl -s -b $C "$BASE/api/users/$UID_B/reposts")
check "tab contains post" True "$(echo "$TAB" | jget "$P1 in [p['id'] for p in d['posts']]")"
check "is_repost true" True "$(echo "$TAB" | jget "d['posts'][0]['is_repost']")"
check "reposted_by.id" "$UID_B" "$(echo "$TAB" | jget "d['posts'][0]['reposted_by']['id']")"
check "author is original author" "$UID_A" "$(echo "$TAB" | jget "d['posts'][0]['user_id']")"
check "other user's tab empty" 0 "$(test_curl -s -b $C "$BASE/api/users/$UID_C/reposts" | jget "len(d['posts'])")"

echo "== undo"
U1=$(unrepost $B $P1)
check "undo reposted=False" False "$(echo "$U1" | jget "d['reposted']")"
check "undo share_count=0" 0 "$(echo "$U1" | jget "d['share_count']")"
U2=$(unrepost $B $P1)
check "second undo is a no-op" 0 "$(echo "$U2" | jget "d['share_count']")"
check "DB row gone" 0 "$(db_count "SELECT count(*) FROM reposts WHERE post_id=$P1")"
repost $B $P1 >/dev/null
check "re-repost does not re-notify" 1 "$(db_count "SELECT count(*) FROM notifications WHERE type='post_repost' AND post_id=$P1")"

echo "== share_count = quotes + reposts"
test_curl -s -b $C -X POST $BASE/api/posts -H 'Content-Type: application/json' \
    -d "{\"content\":\"quote $RUN\",\"quoted_post_id\":$P1}" >/dev/null
check "quote + repost = 2" 2 "$(test_curl -s -b $A "$BASE/api/posts?limit=50" | jget "[p for p in d['posts'] if p['id']==$P1][0]['share_count']")"

echo "== self-repost: allowed, no notification"
P2=$(new_post $A "self repost $RUN")
check "self repost ok" True "$(repost $A $P2 | jget "d['reposted']")"
check "no self notification" 0 "$(db_count "SELECT count(*) FROM notifications WHERE type='post_repost' AND post_id=$P2")"

echo "== pagination (limit=2, cursor = repost id)"
for i in 1 2 3; do PX=$(new_post $A "page $i $RUN"); repost $C $PX >/dev/null; done
PG1=$(test_curl -s -b $A "$BASE/api/users/$UID_C/reposts?limit=2")
check "page 1 has 2 items" 2 "$(echo "$PG1" | jget "len(d['posts'])")"
CUR=$(echo "$PG1" | jget "d['next_cursor']")
check "next_cursor present" True "$([[ "$CUR" != None && -n "$CUR" ]] && echo True || echo False)"
PG2=$(test_curl -s -b $A "$BASE/api/users/$UID_C/reposts?limit=2&cursor=$CUR")
check "page 2 has 1 item" 1 "$(echo "$PG2" | jget "len(d['posts'])")"
check "page 2 end (no cursor)" None "$(echo "$PG2" | jget "d['next_cursor']")"
check "no overlap" 3 "$(python3 - "$PG1" "$PG2" <<'PY'
import json,sys
ids=[p['repost_id'] for s in sys.argv[1:] for p in json.loads(s)['posts']]
print(len(set(ids)))
PY
)"

echo "== private community"
SLUG=rp-priv-$RUN
pg_psql -c "INSERT INTO communities (slug,name,description,topic,type,creator_id) VALUES ('$SLUG','Priv $RUN','d','t','private',$UID_A)" >/dev/null
CID=$(db_count "SELECT id FROM communities WHERE slug='$SLUG'")
pg_psql -c "INSERT INTO community_members (community_id,user_id,role) VALUES ($CID,$UID_A,'creator')" >/dev/null
PP=$(db_count "INSERT INTO posts (user_id,content,community_id) VALUES ($UID_A,'private $RUN',$CID) RETURNING id" | head -1)
check "non-member gets 404" 404 "$(http_code -b $C -X POST $BASE/api/posts/$PP/repost)"
pg_psql -c "INSERT INTO community_members (community_id,user_id,role) VALUES ($CID,$UID_C,'member')" >/dev/null
check "member gets 403" 403 "$(http_code -b $C -X POST $BASE/api/posts/$PP/repost)"
check "no row created" 0 "$(db_count "SELECT count(*) FROM reposts WHERE post_id=$PP")"

echo "== errors and auth"
check "missing post 404" 404 "$(http_code -b $B -X POST $BASE/api/posts/99999999/repost)"
check "undo missing post 404" 404 "$(http_code -b $B -X DELETE $BASE/api/posts/99999999/repost)"
check "logged-out reposts tab 401" 401 "$(http_code "$BASE/api/users/$UID_B/reposts")"
check "logged-out POST rejected" 403 "$(http_code -X POST $BASE/api/posts/$P1/repost)"

echo "== cascade on original delete"
check "reposts exist before" 1 "$(db_count "SELECT count(*) FROM reposts WHERE post_id=$P1 AND user_id=$UID_B")"
test_curl -s -b $A -X DELETE $BASE/api/posts/$P1 >/dev/null
check "reposts gone after delete" 0 "$(db_count "SELECT count(*) FROM reposts WHERE post_id=$P1")"
check "tab no longer lists it" False "$(test_curl -s -b $C "$BASE/api/users/$UID_B/reposts" | jget "$P1 in [p['id'] for p in d['posts']]")"

echo
echo "Passed: $PASS  Failed: $FAIL"
[[ $FAIL -eq 0 ]]
