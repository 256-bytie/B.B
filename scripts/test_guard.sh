#!/usr/bin/env bash
_TEST_ROOT="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 -B "$_TEST_ROOT/tests/pg_support.py" || { return 1 2>/dev/null || exit 1; }
export BEEBO_TEST=1

pg_psql() {
    python3 -B "$_TEST_ROOT/tests/pg_support.py" || return 1
    if command -v psql >/dev/null; then
        command psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 -At "$@"
    else
        docker exec -i "${PG_TEST_CONTAINER:-beebo-pg}" psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 -At "$@"
    fi
}

test_curl() {
    local jar="" method="GET" previous="" argument token
    for argument in "$@"; do
        case "$previous" in
            -b|--cookie) jar="$argument" ;;
            -X|--request) method="$argument" ;;
        esac
        previous="$argument"
    done
    if [[ -n "$jar" && "$method" != GET ]]; then
        token=$(command curl -s -b "$jar" -c "$jar" http://localhost:5050/api/session | python3 -c 'import json,sys; print(json.load(sys.stdin).get("csrf_token", ""))') || return 1
        command curl -H "X-CSRF-Token: $token" "$@"
    else
        command curl "$@"
    fi
}
