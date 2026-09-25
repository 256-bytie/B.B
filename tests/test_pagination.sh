#!/bin/bash

# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see CLAUDE.md Testing section).
# Running these against a server started without DB_PATH set will write
# test data into the real beebo.db.

BASE_URL="http://localhost:5050"

echo "=== Testing GET /api/posts pagination ==="
echo ""

rm -f cookies_pg_a.txt cookies_pg_b.txt

FAIL_COUNT=0

# 1. Sign up two users (so we can exercise the user_id filter too)
echo "1. Creating two test users..."
SIGNUP_A=$(curl -s -c cookies_pg_a.txt -X POST "$BASE_URL/api/signup" \
  -H "Content-Type: application/json" \
  -d '{"full_name": "Page User A", "email": "pageusera@example.com", "password": "password123"}')
USER_A_ID=$(echo "$SIGNUP_A" | jq -r '.user.id')

SIGNUP_B=$(curl -s -c cookies_pg_b.txt -X POST "$BASE_URL/api/signup" \
  -H "Content-Type: application/json" \
  -d '{"full_name": "Page User B", "email": "pageuserb@example.com", "password": "password123"}')
USER_B_ID=$(echo "$SIGNUP_B" | jq -r '.user.id')
echo "   User A: $USER_A_ID, User B: $USER_B_ID"
echo ""

# 2. User A creates 5 posts (Academic), User B creates 3 posts (Community)
echo "2. Creating posts (5 from A/Academic, 3 from B/Community)..."
A_POST_IDS=()
for i in 1 2 3 4 5; do
  RESP=$(curl -s -X POST "$BASE_URL/api/posts" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"Page test A post $i\", \"audience\": \"Academic\"}" \
    -b cookies_pg_a.txt)
  A_POST_IDS+=("$(echo "$RESP" | jq -r '.id')")
done

B_POST_IDS=()
for i in 1 2 3; do
  RESP=$(curl -s -X POST "$BASE_URL/api/posts" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"Page test B post $i\", \"audience\": \"Community\"}" \
    -b cookies_pg_b.txt)
  B_POST_IDS+=("$(echo "$RESP" | jq -r '.id')")
done
echo "   A post ids: ${A_POST_IDS[*]}"
echo "   B post ids: ${B_POST_IDS[*]}"
echo ""
# 3. Full unpaginated list (baseline) for the whole table, no filters.
echo "3. Fetching full unpaginated list as baseline (limit=50)..."
FULL_LIST=$(curl -s "$BASE_URL/api/posts?limit=50" -b cookies_pg_a.txt | jq -r '.posts[].id')
FULL_COUNT=$(echo "$FULL_LIST" | wc -l)
echo "   Total posts in table: $FULL_COUNT"
echo ""

# --- Test: limit=2 returns exactly 2 posts and non-null next_cursor ---
echo "4. GET /api/posts?limit=2 returns exactly 2 posts with non-null next_cursor..."
PAGE1=$(curl -s "$BASE_URL/api/posts?limit=2" -b cookies_pg_a.txt)
PAGE1_COUNT=$(echo "$PAGE1" | jq '.posts | length')
PAGE1_CURSOR=$(echo "$PAGE1" | jq -r '.next_cursor')
if [ "$PAGE1_COUNT" = "2" ] && [ "$PAGE1_CURSOR" != "null" ]; then
  echo "   ✓ PASS: got 2 posts, next_cursor=$PAGE1_CURSOR"
else
  echo "   ✗ FAIL: expected 2 posts + non-null next_cursor, got count=$PAGE1_COUNT cursor=$PAGE1_CURSOR"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo ""

# --- Test: following next_cursor gives next page, no overlap/no gap vs full list ---
echo "5. Following next_cursor walks the whole list with no overlap/no gap..."
ALL_IDS=()
CURSOR=""
PAGE_NUM=0
while true; do
  PAGE_NUM=$((PAGE_NUM + 1))
  if [ -z "$CURSOR" ]; then
    RESP=$(curl -s "$BASE_URL/api/posts?limit=2" -b cookies_pg_a.txt)
  else
    RESP=$(curl -s "$BASE_URL/api/posts?limit=2&cursor=$CURSOR" -b cookies_pg_a.txt)
  fi
  PAGE_IDS=$(echo "$RESP" | jq -r '.posts[].id')
  for id in $PAGE_IDS; do
    ALL_IDS+=("$id")
  done
  CURSOR=$(echo "$RESP" | jq -r '.next_cursor')
  if [ "$CURSOR" = "null" ] || [ $PAGE_NUM -gt 50 ]; then
    break
  fi
done

# Compare walked ids (deduped/sorted) against full baseline list
WALKED_SORTED=$(printf '%s\n' "${ALL_IDS[@]}" | sort -n)
WALKED_UNIQUE_SORTED=$(printf '%s\n' "${ALL_IDS[@]}" | sort -n -u)
FULL_SORTED=$(echo "$FULL_LIST" | sort -n)

if [ "$WALKED_SORTED" = "$WALKED_UNIQUE_SORTED" ] && [ "$WALKED_SORTED" = "$FULL_SORTED" ]; then
  echo "   ✓ PASS: paginated walk matches full list exactly, no duplicates, no gaps"
else
  echo "   ✗ FAIL: paginated walk does not match full list"
  echo "   Walked: $(printf '%s ' "${ALL_IDS[@]}")"
  echo "   Full:   $(echo "$FULL_LIST" | tr '\n' ' ')"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo ""

# --- Test: last page returns next_cursor: null ---
echo "6. Last page returns next_cursor: null..."
LAST_PAGE=$(curl -s "$BASE_URL/api/posts?limit=$FULL_COUNT" -b cookies_pg_a.txt)
LAST_CURSOR=$(echo "$LAST_PAGE" | jq -r '.next_cursor')
LAST_COUNT=$(echo "$LAST_PAGE" | jq '.posts | length')
if [ "$LAST_CURSOR" = "null" ] && [ "$LAST_COUNT" = "$FULL_COUNT" ]; then
  echo "   ✓ PASS: next_cursor is null on the last page ($LAST_COUNT posts)"
else
  echo "   ✗ FAIL: expected next_cursor=null with $FULL_COUNT posts, got cursor=$LAST_CURSOR count=$LAST_COUNT"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo ""

# --- Test: user_id filter returns only that user's posts, still paginated ---
echo "7. GET /api/posts?user_id=<A> returns only User A's posts, paginated..."
UA_PAGE1=$(curl -s "$BASE_URL/api/posts?user_id=$USER_A_ID&limit=2" -b cookies_pg_a.txt)
UA_PAGE1_IDS=$(echo "$UA_PAGE1" | jq -r '.posts[].id')
UA_PAGE1_USER_IDS=$(echo "$UA_PAGE1" | jq -r '.posts[].user_id' | sort -u)
UA_CURSOR=$(echo "$UA_PAGE1" | jq -r '.next_cursor')

ALL_UA_IDS=()
CURSOR="$UA_CURSOR"
for id in $UA_PAGE1_IDS; do ALL_UA_IDS+=("$id"); done
PAGE_NUM=0
while [ "$CURSOR" != "null" ]; do
  PAGE_NUM=$((PAGE_NUM + 1))
  [ $PAGE_NUM -gt 50 ] && break
  RESP=$(curl -s "$BASE_URL/api/posts?user_id=$USER_A_ID&limit=2&cursor=$CURSOR" -b cookies_pg_a.txt)
  for id in $(echo "$RESP" | jq -r '.posts[].id'); do ALL_UA_IDS+=("$id"); done
  CURSOR=$(echo "$RESP" | jq -r '.next_cursor')
done

EXPECTED_A_SORTED=$(printf '%s\n' "${A_POST_IDS[@]}" | sort -n)
ACTUAL_A_SORTED=$(printf '%s\n' "${ALL_UA_IDS[@]}" | sort -n)

if [ "$UA_PAGE1_USER_IDS" = "$USER_A_ID" ] && [ "$ACTUAL_A_SORTED" = "$EXPECTED_A_SORTED" ]; then
  echo "   ✓ PASS: user_id filter returns exactly User A's ${#A_POST_IDS[@]} posts across pages"
else
  echo "   ✗ FAIL: user_ids in page1=$UA_PAGE1_USER_IDS, expected only $USER_A_ID"
  echo "   Expected ids: $(printf '%s ' "${A_POST_IDS[@]}"), got: $(printf '%s ' "${ALL_UA_IDS[@]}")"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo ""

# --- Test: user_id + audience combined ---
echo "8. GET /api/posts?user_id=<B>&audience=Community combines both filters..."
UB_COMMUNITY=$(curl -s "$BASE_URL/api/posts?user_id=$USER_B_ID&audience=Community&limit=50" -b cookies_pg_b.txt)
UB_IDS=$(echo "$UB_COMMUNITY" | jq -r '.posts[].id' | sort -n)
UB_AUDIENCES=$(echo "$UB_COMMUNITY" | jq -r '.posts[].audience' | sort -u)
EXPECTED_B_SORTED=$(printf '%s\n' "${B_POST_IDS[@]}" | sort -n)

if [ "$UB_IDS" = "$EXPECTED_B_SORTED" ] && { [ "$UB_AUDIENCES" = "Community" ] || [ -z "$UB_AUDIENCES" ]; }; then
  echo "   ✓ PASS: user_id+audience filter returns exactly User B's Community posts"
else
  echo "   ✗ FAIL: expected ids $(printf '%s ' "${B_POST_IDS[@]}") all Community, got ids=$UB_IDS audiences=$UB_AUDIENCES"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Sanity: a mismatched combination (User B + Academic) should return none of B's posts
UB_ACADEMIC=$(curl -s "$BASE_URL/api/posts?user_id=$USER_B_ID&audience=Academic&limit=50" -b cookies_pg_b.txt)
UB_ACADEMIC_COUNT=$(echo "$UB_ACADEMIC" | jq '.posts | length')
if [ "$UB_ACADEMIC_COUNT" = "0" ]; then
  echo "   ✓ PASS: user_id=B&audience=Academic correctly returns 0 posts (B never posted Academic)"
else
  echo "   ✗ FAIL: expected 0 posts for user_id=B&audience=Academic, got $UB_ACADEMIC_COUNT"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo ""

# --- Test: a post inserted between two page fetches (live traffic) does not
# cause a duplicate or a skipped post in already-fetched pages. This is the
# core guarantee keyset pagination gives over offset pagination: fetching
# page 1 fixes a cursor (the id boundary), so a newer post inserted after
# page 1 was fetched sorts *before* that boundary in DESC order and never
# appears in page 2's `id < cursor` window - no shift, no duplicate, no gap. ---
echo "9. Live insert between page fetches does not duplicate or skip posts..."

# Fetch page 1 (limit=2) — this fixes next_cursor as our boundary.
LIVE_PAGE1=$(curl -s "$BASE_URL/api/posts?limit=2" -b cookies_pg_a.txt)
LIVE_PAGE1_IDS=$(echo "$LIVE_PAGE1" | jq -r '.posts[].id')
LIVE_CURSOR=$(echo "$LIVE_PAGE1" | jq -r '.next_cursor')

# Simulate live traffic: a brand new post lands *after* page 1 was fetched,
# before page 2 is fetched. This new post's id is higher than everything
# already paginated.
NEW_POST_RESP=$(curl -s -X POST "$BASE_URL/api/posts" \
  -H "Content-Type: application/json" \
  -d '{"content": "Inserted between page fetches", "audience": "Academic"}' \
  -b cookies_pg_a.txt)
NEW_POST_ID=$(echo "$NEW_POST_RESP" | jq -r '.id')

# Now fetch page 2 using the cursor captured before the insert.
LIVE_PAGE2=$(curl -s "$BASE_URL/api/posts?limit=2&cursor=$LIVE_CURSOR" -b cookies_pg_a.txt)
LIVE_PAGE2_IDS=$(echo "$LIVE_PAGE2" | jq -r '.posts[].id')

# The new post must not appear in page 2 (it's newer than the cursor
# boundary, so it belongs "above" page 1, not inside page 2's window) and
# there must be no overlap between page 1 and page 2.
OVERLAP=$(comm -12 <(echo "$LIVE_PAGE1_IDS" | sort -n) <(echo "$LIVE_PAGE2_IDS" | sort -n))
NEW_IN_PAGE2=$(echo "$LIVE_PAGE2_IDS" | grep -c "^${NEW_POST_ID}$" || true)

if [ -z "$OVERLAP" ] && [ "$NEW_IN_PAGE2" = "0" ]; then
  echo "   ✓ PASS: new post (id=$NEW_POST_ID) did not leak into page 2, no overlap with page 1"
else
  echo "   ✗ FAIL: overlap='$OVERLAP', new post in page2 count=$NEW_IN_PAGE2"
  echo "   Page1: $(echo "$LIVE_PAGE1_IDS" | tr '\n' ' ')"
  echo "   Page2: $(echo "$LIVE_PAGE2_IDS" | tr '\n' ' ')"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo ""

echo "=== Test Complete: $FAIL_COUNT failure(s) ==="
rm -f cookies_pg_a.txt cookies_pg_b.txt

exit $FAIL_COUNT
