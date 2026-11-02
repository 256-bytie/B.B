#!/usr/bin/env bash
set -u
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/test_guard.sh" || exit 1

BASE=http://127.0.0.1:5050
RUN="$(date +%s)$$"
TMP="/tmp/course_files_$RUN"
JAR_A="$TMP/a.cookies"
JAR_B="$TMP/b.cookies"
PASSED=0
FAILED=0
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
pass() { echo "PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
json() { python3 -c "import json,sys; print($2)" <<<"$1"; }
signup() {
    curl -s -c "$1" -H 'Content-Type: application/json' -d "{\"full_name\":\"Course Tester\",\"email\":\"$2\",\"password\":\"testpass123\"}" "$BASE/api/signup" |
        python3 -c "import json,sys; print(json.load(sys.stdin)['csrf_token'])"
}
request() {
    local jar=$1 token=$2 method=$3 path=$4 data=${5:-}
    local args=(-s -w $'\n%{http_code}' -b "$jar" -X "$method")
    [[ "$method" != GET ]] && args+=(-H "X-CSRF-Token: $token")
    [[ -n "$data" ]] && args+=(-H 'Content-Type: application/json' -d "$data")
    curl "${args[@]}" "$BASE$path"
}

printf 'hello courses\n' > "$TMP/notes.txt"
printf 'not a pdf' > "$TMP/bad.pdf"
printf '\x89PNG\r\n\x1a\ncontent' > "$TMP/image.png"
printf 'MZ executable' > "$TMP/fake.pdf"
truncate -s $((50 * 1024 * 1024)) "$TMP/oversized.txt"
python3 - "$TMP" <<'PY'
import os, sys, zipfile
root = sys.argv[1]
samples = {
    'sample.pdf': b'%PDF-1.4\n%%EOF', 'sample.doc': bytes.fromhex('d0cf11e0a1b11ae1'),
    'sample.ppt': bytes.fromhex('d0cf11e0a1b11ae1'), 'sample.xls': bytes.fromhex('d0cf11e0a1b11ae1'),
    'sample.jpg': bytes.fromhex('ffd8ffd9'), 'sample.jpeg': bytes.fromhex('ffd8ffd9'),
    'sample.png': bytes.fromhex('89504e470d0a1a0a'), 'sample.webp': b'RIFF\x04\x00\x00\x00WEBP',
    'sample.txt': b'plain utf-8', 'sample.md': b'# Markdown',
}
for name, data in samples.items():
    open(os.path.join(root, name), 'wb').write(data)
for ext, part in [('docx', 'word/document.xml'), ('pptx', 'ppt/presentation.xml'), ('xlsx', 'xl/workbook.xml')]:
    with zipfile.ZipFile(os.path.join(root, 'sample.' + ext), 'w') as archive:
        archive.writestr('[Content_Types].xml', '<Types/>')
        archive.writestr(part, '<root/>')
with zipfile.ZipFile(os.path.join(root, 'bad.docx'), 'w') as archive:
    archive.writestr('index.html', '<script>bad</script>')
PY

ANON=$(curl -s -w $'\n%{http_code}' "$BASE/api/courses/items")
[[ $(code "$ANON") == 401 ]] && pass 'authentication required' || fail 'authentication required'

TOKEN_A=$(signup "$JAR_A" "course_a_$RUN@example.com")
TOKEN_B=$(signup "$JAR_B" "course_b_$RUN@example.com")
NO_CSRF=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -X POST -H 'Content-Type: application/json' -d '{"name":"No token"}' "$BASE/api/courses/folders")
[[ $NO_CSRF == 403 ]] && pass 'CSRF required' || fail 'CSRF required'

ROOT_FOLDER=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders '{"name":"  Year   1  "}')
FOLDER_ID=$(json "$(body "$ROOT_FOLDER")" "json.load(sys.stdin)['folder']['id']")
[[ $(code "$ROOT_FOLDER") == 201 ]] && pass 'folder created' || fail 'folder created'
DUP=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders '{"name":"year 1"}')
[[ $(code "$DUP") == 409 ]] && pass 'folder duplicate is case insensitive' || fail 'folder duplicate'
DOTS=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders '{"name":"..."}')
[[ $(code "$DOTS") == 400 ]] && pass 'dots-only name rejected' || fail 'dots-only name rejected'
SPACE=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders '{"name":"     "}')
[[ $(code "$SPACE") == 400 ]] && pass 'whitespace-only name rejected' || fail 'whitespace-only name rejected'
LONG_NAME=$(python3 -c "import json; print(json.dumps({'name': 'x' * 31}))")
LONG=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders "$LONG_NAME")
[[ $(code "$LONG") == 400 ]] && pass 'long folder name rejected' || fail 'long folder name rejected'
NUL_NAME=$(python3 -c "import json; print(json.dumps({'name': 'A\\u0000 B'}))")
NUL=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders "$NUL_NAME")
[[ $(code "$NUL") == 201 && $(json "$(body "$NUL")" "json.load(sys.stdin)['folder']['name']") == 'A B' ]] && pass 'NUL control character stripped' || fail 'NUL cleaning'
CLEAN=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders '{"name":"../ x"}')
[[ $(code "$CLEAN") == 201 && $(json "$(body "$CLEAN")" "json.load(sys.stdin)['folder']['name']") == '.. x' ]] && pass 'path characters cleaned' || fail 'path characters cleaned'

PARENT=$FOLDER_ID
for depth in 2 3 4 5; do
    R=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders "{\"name\":\"Depth $depth\",\"parent_id\":$PARENT}")
    PARENT=$(json "$(body "$R")" "json.load(sys.stdin)['folder']['id']")
done
TOO_DEEP=$(request "$JAR_A" "$TOKEN_A" POST /api/courses/folders "{\"name\":\"Depth 6\",\"parent_id\":$PARENT}")
[[ $(code "$TOO_DEEP") == 400 ]] && pass 'depth limit enforced' || fail 'depth limit enforced'
CYCLE=$(request "$JAR_A" "$TOKEN_A" PATCH "/api/courses/folders/$FOLDER_ID" "{\"parent_id\":$PARENT}")
[[ $(code "$CYCLE") == 400 ]] && pass 'descendant move rejected' || fail 'descendant move rejected'

for ext in pdf doc docx ppt pptx xls xlsx txt md jpg jpeg png webp; do
    STATUS=$(curl -s -o "$TMP/upload.json" -w '%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $TOKEN_A" -F "file=@$TMP/sample.$ext" -F "folder_id=$FOLDER_ID" "$BASE/api/courses/files")
    [[ $STATUS == 201 ]] || fail "valid $ext upload"
done
pass 'all allowed types upload'
for file in bad.pdf fake.pdf bad.docx; do
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $TOKEN_A" -F "file=@$TMP/$file" "$BASE/api/courses/files")
    [[ $STATUS == 400 ]] || fail "wrong content $file"
done
pass 'content mismatches rejected'
OVERSIZED=$(curl -s -w $'\n%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $TOKEN_A" -F "file=@$TMP/oversized.txt" "$BASE/api/courses/files")
[[ $(code "$OVERSIZED") == 413 && $(body "$OVERSIZED") == *'"error"'* ]] && pass 'multipart request limit returns JSON 413' || fail 'oversize JSON 413'

FIRST=$(curl -s -b "$JAR_A" -H "X-CSRF-Token: $TOKEN_A" -F "file=@$TMP/notes.txt" -F 'name=Duplicate' "$BASE/api/courses/files")
SECOND=$(curl -s -b "$JAR_A" -H "X-CSRF-Token: $TOKEN_A" -F "file=@$TMP/notes.txt" -F 'name=duplicate' "$BASE/api/courses/files")
FILE_ID=$(json "$FIRST" "json.load(sys.stdin)['file']['id']")
[[ $(json "$SECOND" "json.load(sys.stdin)['file']['name']") == 'duplicate (1)' ]] && pass 'file duplicate gets suffix' || fail 'file duplicate suffix'

ITEMS=$(request "$JAR_A" "$TOKEN_A" GET "/api/courses/items?folder_id=$FOLDER_ID")
[[ $(json "$(body "$ITEMS")" "json.load(sys.stdin)['folder']['item_count']") == 14 ]] && pass 'item_count includes direct folders and files' || fail 'item_count incorrect'

for action in "GET /api/courses/items?folder_id=$FOLDER_ID" "PATCH /api/courses/folders/$FOLDER_ID" "DELETE /api/courses/folders/$FOLDER_ID" "PATCH /api/courses/files/$FILE_ID" "DELETE /api/courses/files/$FILE_ID" "GET /api/courses/files/$FILE_ID/download"; do
    set -- $action
    payload=''
    [[ $1 == PATCH ]] && payload='{"name":"Other"}'
    RESULT=$(request "$JAR_B" "$TOKEN_B" "$1" "$2" "$payload")
    [[ $(code "$RESULT") == 404 ]] || fail "isolation $action"
done
pass 'cross-user ids return 404'

HEADERS=$(curl -s -D - -o /dev/null -b "$JAR_A" "$BASE/api/courses/files/$FILE_ID/download?inline=1")
grep -qi '^Content-Type: text/plain' <<<"$HEADERS" && grep -qi '^X-Content-Type-Options: nosniff' <<<"$HEADERS" && grep -qi '^Cache-Control: private, no-store' <<<"$HEADERS" && grep -qi '^Content-Disposition: attachment' <<<"$HEADERS" && pass 'download headers are restrictive' || fail 'download headers'
STATIC=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/static/courses/1/anything.txt")
[[ $STATIC == 404 ]] && pass 'course files unavailable under static' || fail 'static course path exposed'

STORAGE=$(request "$JAR_A" "$TOKEN_A" GET /api/courses/storage)
[[ $(json "$(body "$STORAGE")" "json.load(sys.stdin)['quota_bytes']") == 524288000 ]] && pass 'storage quota reported' || fail 'storage quota'

USER_A=$(pg_psql -c "SELECT id FROM users WHERE email='course_a_$RUN@example.com'")
pg_psql -c "INSERT INTO course_files (user_id,name,file_type,mime_type,file_size,storage_key) SELECT $USER_A,'quota seed','txt','text/plain',524288000-COALESCE(sum(file_size),0)-20,'quota/$RUN' FROM course_files WHERE user_id=$USER_A"
curl -s -o "$TMP/q1" -w '%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $TOKEN_A" -F "file=@$TMP/notes.txt" -F 'name=Parallel one' "$BASE/api/courses/files" > "$TMP/q1.code" & Q1=$!
curl -s -o "$TMP/q2" -w '%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $TOKEN_A" -F "file=@$TMP/notes.txt" -F 'name=Parallel two' "$BASE/api/courses/files" > "$TMP/q2.code" & Q2=$!
wait "$Q1" "$Q2"
SORTED=$(cat "$TMP/q1.code" "$TMP/q2.code" | sort | tr '\n' ' ')
[[ $SORTED == '201 413 ' ]] && pass 'parallel near-quota uploads are atomic' || fail "parallel quota statuses: $SORTED"
while IFS= read -r key; do
    [[ -n $key ]] && rm -f "${COURSE_FILES_ROOT:-./private_uploads}/$key"
done < <(pg_psql -c "SELECT storage_key FROM course_files WHERE name LIKE 'Parallel %'")
pg_psql -c "DELETE FROM course_files WHERE storage_key='quota/$RUN' OR name LIKE 'Parallel %'"

BEFORE=$(find "${COURSE_FILES_ROOT:-./private_uploads}/courses/$USER_A" -type f 2>/dev/null | wc -l)
pg_psql -c "CREATE FUNCTION fail_course_insert_$RUN() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RAISE EXCEPTION 'forced failure'; END \$\$; CREATE TRIGGER fail_course_insert_$RUN BEFORE INSERT ON course_files FOR EACH ROW EXECUTE FUNCTION fail_course_insert_$RUN();"
FAILED_UPLOAD=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H "X-CSRF-Token: $TOKEN_A" -F "file=@$TMP/notes.txt" -F 'name=Must fail' "$BASE/api/courses/files")
AFTER=$(find "${COURSE_FILES_ROOT:-./private_uploads}/courses/$USER_A" -type f 2>/dev/null | wc -l)
pg_psql -c "DROP TRIGGER fail_course_insert_$RUN ON course_files; DROP FUNCTION fail_course_insert_$RUN();"
[[ $FAILED_UPLOAD == 500 && $BEFORE == "$AFTER" ]] && pass 'failed DB insert leaves no orphan' || fail 'failed insert orphan cleanup'

FOLDER_FILE_ID=$(json "$(cat "$TMP/upload.json")" "json.load(sys.stdin)['file']['id']")
KEY=$(pg_psql -c "SELECT storage_key FROM course_files WHERE id=$FOLDER_FILE_ID")
FULL="${COURSE_FILES_ROOT:-./private_uploads}/$KEY"
[[ -f $FULL ]] || fail 'uploaded blob exists'
DEL=$(request "$JAR_A" "$TOKEN_A" DELETE "/api/courses/folders/$FOLDER_ID")
[[ $(code "$DEL") == 200 && ! -f $FULL ]] && pass 'folder deletion removes rows and blobs' || fail 'folder deletion cleanup'

echo "Course tests: $PASSED passed, $FAILED failed"
[[ $FAILED == 0 ]]
