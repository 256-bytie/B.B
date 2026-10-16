#!/usr/bin/env bash
# Throwaway-PostgreSQL test environment helper.
#
# Creates a database named beebo_test_<random> on the local PostgreSQL server,
# points DATABASE_URL and BEEBO_TEST=1 at it, and drops it automatically when
# the calling shell exits (trap on EXIT).
#
# Credentials come from the standard PostgreSQL environment variables — nothing
# is hardcoded or committed:
#   PGHOST     (default: localhost)
#   PGPORT     (default: 5432)
#   PGUSER     (required)
#   PGPASSWORD (required)
#   PG_MAINT_DB (default: postgres) — the maintenance DB used for CREATE/DROP.
#
# Usage:
#   # Interactive / scripted test session: source it, then run the app/tests.
#   source scripts/pg_test_env.sh
#   python app.py                 # or run migrations, tests, etc.
#   exit                          # the trap drops the database on exit
#
#   # One-shot: run a single command under a throwaway database.
#   scripts/pg_test_env.sh -- python app.py
#
# The throwaway database is always dropped on exit, so it never accumulates.
# Only databases whose name starts with "beebo_test" are ever created or
# dropped by this script (and the app refuses to touch any other DB when
# BEEBO_TEST=1; see app/db.py).

set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
MAINT_DB="${PG_MAINT_DB:-postgres}"

: "${PGUSER:?PGUSER is required (standard PostgreSQL env var)}"
: "${PGPASSWORD:?PGPASSWORD is required (standard PostgreSQL env var)}"

# --- internal helpers -------------------------------------------------------

# Run a Python snippet (stdin) with psycopg against the maintenance database.
# Exposes PG* + DBNAME via env. Safe DB-name interpolation is enforced below.
_pg_admin() {
    PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER="$PGUSER" PGPASSWORD="$PGPASSWORD" \
        MAINT_DB="$MAINT_DB" DBNAME="${BEEBO_TEST_DB:-}" \
        python3 - "$@"
}

_assert_safe_name() {
    local name="$1"
    if [[ ! "$name" =~ ^beebo_test_[a-z0-9_]+$ ]]; then
        echo "pg_test_env: refusing unsafe database name '$name'" >&2
        return 1
    fi
}

# --- public commands --------------------------------------------------------

pg_test_new_name() {
    printf 'beebo_test_%s_%s_%s' \
        "$(date +%s)" "$$" "$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
}

pg_test_create() {
    local name="${1:-$(pg_test_new_name)}"
    _assert_safe_name "$name"
    BEEBO_TEST_DB="$name" _pg_admin <<'PY'
import os, psycopg
name = os.environ['DBNAME']
with psycopg.connect(
        host=os.environ['PGHOST'], port=os.environ['PGPORT'],
        user=os.environ['PGUSER'], password=os.environ['PGPASSWORD'],
        dbname=os.environ['MAINT_DB'], autocommit=True) as conn:
    conn.execute(f'CREATE DATABASE "{name}"')
PY
    printf '%s\n' "$name"
}

pg_test_drop() {
    local name="${1:-${BEEBO_TEST_DB:-}}"
    [[ -n "$name" ]] || return 0
    _assert_safe_name "$name"
    BEEBO_TEST_DB="$name" _pg_admin <<'PY'
import os, psycopg
name = os.environ['DBNAME']
with psycopg.connect(
        host=os.environ['PGHOST'], port=os.environ['PGPORT'],
        user=os.environ['PGUSER'], password=os.environ['PGPASSWORD'],
        dbname=os.environ['MAINT_DB'], autocommit=True) as conn:
    conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
PY
}

pg_test_url() {
    local name="${1:-${BEEBO_TEST_DB:-}}"
    [[ -n "$name" ]] || return 1
    _assert_safe_name "$name"
    BEEBO_TEST_DB="$name" _pg_admin <<'PY'
import os
from urllib.parse import quote
name = os.environ['DBNAME']
url = 'postgresql://{u}:{p}@{h}:{port}/{db}'.format(
    u=quote(os.environ['PGUSER'], safe=''),
    p=quote(os.environ['PGPASSWORD'], safe=''),
    h=os.environ['PGHOST'],
    port=os.environ['PGPORT'],
    db=name,
)
print(url)
PY
}

# --- setup / teardown -------------------------------------------------------

if [[ -n "${DATABASE_URL:-}" ]]; then
    python3 -B "$(dirname "${BASH_SOURCE[0]}")/../tests/pg_support.py"
fi

BEEBO_TEST_DB="$(pg_test_new_name)"
trap 'pg_test_drop "$BEEBO_TEST_DB"' EXIT
pg_test_create "$BEEBO_TEST_DB"
DATABASE_URL="$(pg_test_url "$BEEBO_TEST_DB")"
BEEBO_TEST=1

export BEEBO_TEST_DB DATABASE_URL BEEBO_TEST

_teardown() {
    pg_test_drop "$BEEBO_TEST_DB"
    unset BEEBO_TEST_DB DATABASE_URL BEEBO_TEST || true
}
trap _teardown EXIT

echo "pg_test_env: created throwaway database '$BEEBO_TEST_DB'" >&2
echo "pg_test_env: target=$PGHOST/$BEEBO_TEST_DB" >&2
echo "pg_test_env: BEEBO_TEST=$BEEBO_TEST (database dropped on shell exit)" >&2

# If run (not sourced) with `-- <command>`, execute that command now.
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    # Sourced: return control to the caller with the env set.
    return 0 2>/dev/null || true
fi

if [[ "${1:-}" == "--" ]]; then
    shift
    "$@"
fi
