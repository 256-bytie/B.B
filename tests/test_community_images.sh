#!/bin/bash
set -e
BASE_URL="http://127.0.0.1:5050"
RUN_ID="$(date +%s)$$"
JAR="community_images_${RUN_ID}.txt"
IMG="/tmp/community_${RUN_ID}.png"
trap 'rm -f "$JAR" "$IMG"' EXIT
printf '\211PNG\r\n\032\n' > "$IMG"
csrf=$(curl -s -c "$JAR" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/signup" -d "{\"full_name\":\"Image Tester\",\"email\":\"images_${RUN_ID}@example.com\",\"password\":\"testpass123\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf_token"])')
resp=$(curl -s -w '\n%{http_code}' -b "$JAR" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/communities" -d '{"name":"Image Community","description":"uploads","topic":"art","type":"public"}')
body=$(echo "$resp" | sed '$d'); test "$(echo "$resp" | tail -n1)" = 201
slug=$(echo "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["slug"])')
upload() { curl -s -w '\n%{http_code}' -b "$JAR" -H "X-CSRF-Token: $csrf" -X POST "$BASE_URL/api/communities/$slug/$1" -F "image=@$IMG;type=image/png"; }
resp=$(upload icon); body=$(echo "$resp" | sed '$d'); test "$(echo "$resp" | tail -n1)" = 200
icon=$(echo "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["icon_image"])'); [[ "$icon" == /static/uploads/* ]]; test -f "static/${icon#/static/}"
resp=$(upload cover); body=$(echo "$resp" | sed '$d'); test "$(echo "$resp" | tail -n1)" = 200
echo "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["cover_image"] and d["icon_image"]'
resp=$(curl -s -w '\n%{http_code}' -b "$JAR" -H "X-CSRF-Token: $csrf" -X POST "$BASE_URL/api/communities/$slug/icon"); test "$(echo "$resp" | tail -n1)" = 400
resp=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$BASE_URL/api/communities/$slug/icon"); test "$(echo "$resp" | tail -n1)" = 403
echo "Community image upload tests passed"
