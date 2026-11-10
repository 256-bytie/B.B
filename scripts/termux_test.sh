#!/usr/bin/env bash
# Beebo test runner for Termux.
#
# Safe by construction: it never connects to your real database. Every test
# runs against a throwaway beebo_test_* database that is dropped afterwards
# (scripts/pg_test_env.sh + tests/pg_support.py enforce the name guard).
# PostgreSQL credentials are read from .env only to learn the user/password;
# DATABASE_URL itself is never exported to the tests.
#
# Usage (from the repo root or anywhere):
#   bash scripts/termux_test.sh check              # environment self-check
#   bash scripts/termux_test.sh logic              # tests/test_notifications_logic.py
#   bash scripts/termux_test.sh notif              # tests/test_notifications.sh
#   bash scripts/termux_test.sh one tests/X.sh|.py # any single test
#   bash scripts/termux_test.sh all                # whole suite
#
# The real app also listens on port 5050, so stop it before shell tests.

set -uo pipefail

ROOT="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

LOGDIR="${TMPDIR:-$HOME}/beebo_test_logs"
PGDATA="${PREFIX:-/usr}/var/lib/postgresql"
FAIL_PATTERN='✗|Traceback \(most recent call last\):|command not found|No such file or directory'

command -v termux-wake-lock >/dev/null && termux-wake-lock

# --- helpers ----------------------------------------------------------------

start_postgres() {
    pg_isready -q && return 0

    # A crashed or killed server leaves postmaster.pid behind, and Android
    # recycles PIDs, so pg_ctl then refuses to start ("lock file already
    # exists"). Remove the file only when the PID it names is not postgres.
    local pidfile="$PGDATA/postmaster.pid" pid
    if [ -f "$pidfile" ]; then
        pid="$(head -n 1 "$pidfile" 2>/dev/null)"
        if [ -n "$pid" ] && ps -p "$pid" -o args= 2>/dev/null | grep -q postgres; then
            echo "A postgres process (PID $pid) exists but is not accepting connections; waiting for it ..."
        else
            echo "Removing stale $pidfile (PID ${pid:-unknown} is not postgres)"
            rm -f "$pidfile"
        fi
    fi

    pg_isready -q || pg_ctl -D "$PGDATA" -l "$HOME/pg.log" start >/dev/null 2>&1
    local _
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        pg_isready -q && return 0
        sleep 1
    done
    echo "PostgreSQL failed to start. Last lines of ~/pg.log:"
    tail -n 5 "$HOME/pg.log" 2>/dev/null
    return 1
}

# Export PGHOST/PGPORT/PGUSER/PGPASSWORD parsed from DATABASE_URL in .env.
# Nothing else from .env is loaded and nothing is printed.
load_pg_credentials() {
    [ -f .env ] || { echo ".env missing (only needed to read the Postgres user/password)"; return 1; }
    local creds
    creds="$(python3 - <<'PY'
import re, shlex
from urllib.parse import urlparse, unquote
url = ''
for line in open('.env', encoding='utf-8'):
    m = re.match(r'\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$', line)
    if m:
        url = m.group(1).strip('"\'')
parsed = urlparse(url)
if not parsed.username:
    raise SystemExit('DATABASE_URL not found in .env or it has no user')
values = {
    'PGHOST': parsed.hostname or 'localhost',
    'PGPORT': str(parsed.port or 5432),
    'PGUSER': unquote(parsed.username),
    # pg_test_env.sh insists on a non-empty password; local trust auth ignores it.
    'PGPASSWORD': unquote(parsed.password) if parsed.password else 'unused',
}
for key, value in values.items():
    print(f'export {key}={shlex.quote(value)}')
PY
)" || { echo "$creds"; return 1; }
    eval "$creds"
    unset DATABASE_URL BEEBO_TEST BEEBO_TEST_DB
}

port_5050_free() {
    python3 - <<'PY'
import socket
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(('127.0.0.1', 5050))
except OSError:
    raise SystemExit(1)
PY
}

need_free_port() {
    port_5050_free && return 0
    echo "Port 5050 is busy (your normal app is probably running)."
    echo "Stop it first, e.g.: pkill -f 'python3 -B app.py'"
    return 1
}

# Copy the repo to a scratch dir so tests never write into your real
# static/uploads or flask_session. Same exclusions as run_all_tests.sh.
stage_suite() {
    SUITE="$(mktemp -d "${TMPDIR:-/tmp}/beebo_test_suite_XXXXXX")" || return 1
    tar -C "$ROOT" --exclude=.git --exclude='*.db' --exclude=.env --exclude=__pycache__ \
        --exclude=flask_session --exclude='cookies*.txt' -cf - . | tar -C "$SUITE" -xf - || return 1
    cd "$SUITE" || return 1
    # Termux has no writable /tmp: point hardcoded /tmp/ paths in the staged tests at $TMPDIR.
    if [[ -n "${TMPDIR:-}" && "${TMPDIR%/}" != /tmp ]]; then
        sed -i "s#/tmp/#${TMPDIR%/}/#g" tests/*.sh tests/*.py
    fi
    export PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$SUITE${PYTHONPATH:+:$PYTHONPATH}"
}

cleanup() {
    cd "$ROOT" 2>/dev/null || true
    [[ -n "${SUITE:-}" && -d "$SUITE" ]] && rm -rf "$SUITE"
}
trap cleanup EXIT

run_one() {
    local test="$1" log
    [[ -f "$ROOT/$test" || -f "$test" ]] || { echo "No such test: $test"; return 2; }
    test="${test#"$ROOT"/}"
    mkdir -p "$LOGDIR"
    log="$LOGDIR/$(basename "$test").log"
    stage_suite || return 2
    export TEST_SERVER_LOG="$LOGDIR/$(basename "$test").server.log"

    local cmd
    if [[ "$test" == *_logic.py || "$test" == *test_community_members.py ]]; then
        cmd=(python3 -B "$test")
    else
        need_free_port || return 2
        cmd=(bash scripts/pg_test_env.sh -- bash scripts/run_one_test.sh "$test")
    fi

    echo "Running $test ..."
    "${cmd[@]}" 2>&1 | tee "$log"
    local status=${PIPESTATUS[0]}
    if [[ $status -eq 0 ]] && ! grep -Eq "$FAIL_PATTERN" "$log"; then
        echo "PASS $test"
        return 0
    fi
    echo "FAIL $test (exit $status)"
    echo "Log: $log"
    [[ -f "$TEST_SERVER_LOG" ]] && echo "Server log: $TEST_SERVER_LOG"
    return 1
}

do_check() {
    local ok=0 tool
    for tool in python3 psql pg_isready pg_ctl curl jq; do
        if command -v "$tool" >/dev/null; then echo "✓ $tool"; else echo "✗ missing: $tool  (pkg install postgresql jq curl python)"; ok=1; fi
    done
    if python3 -c 'import flask, flask_cors, flask_session, psycopg, psycopg_pool' 2>/dev/null; then
        echo "✓ python packages"
    else
        echo "✗ python packages missing  (pip install -r requirements.txt)"; ok=1
    fi
    [[ $ok -eq 0 ]] || return 1
    if port_5050_free; then echo "✓ port 5050 free"; else echo "✗ port 5050 busy (stop the app: pkill -f 'python3 -B app.py')"; ok=1; fi
    echo "Creating and dropping a throwaway database ..."
    if bash scripts/pg_test_env.sh -- true; then
        echo "✓ throwaway database create/drop works (role has CREATEDB)"
    else
        echo "✗ could not create a throwaway database. Check PG credentials/CREATEDB privilege."
        ok=1
    fi
    return $ok
}

# --- main -------------------------------------------------------------------

mode="${1:-}"
case "$mode" in
    check|logic|notif|one|all) ;;
    *) sed -n '2,19p' "$0"; exit 2 ;;
esac

start_postgres || exit 1
load_pg_credentials || exit 1

case "$mode" in
    check) do_check ;;
    logic) run_one tests/test_notifications_logic.py ;;
    notif) run_one tests/test_notifications.sh ;;
    one)   [[ -n "${2:-}" ]] || { echo "usage: termux_test.sh one tests/<file>"; exit 2; }
           run_one "$2" ;;
    all)   need_free_port || exit 2
           bash scripts/run_all_tests.sh ;;
esac
