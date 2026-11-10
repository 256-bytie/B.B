#!/usr/bin/env bash
set -euo pipefail
ROOT="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${DATABASE_URL:-}" ]]; then
    python3 -B "$ROOT/tests/pg_support.py"
fi
SUITE=$(mktemp -d "${TMPDIR:-/tmp}/beebo_test_suite_XXXXXX")
tar -C "$ROOT" --exclude=.git --exclude='*.db' --exclude=.env --exclude=__pycache__ --exclude=flask_session --exclude='cookies*.txt' -cf - . | tar -C "$SUITE" -xf -
cd "$SUITE"
# Termux has no writable /tmp: point hardcoded /tmp/ paths in the staged tests at $TMPDIR.
if [[ -n "${TMPDIR:-}" && "${TMPDIR%/}" != /tmp ]]; then
    sed -i "s#/tmp/#${TMPDIR%/}/#g" tests/*.sh tests/*.py
fi
export PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$SUITE${PYTHONPATH:+:$PYTHONPATH}"
unset BEEBO_TEST_DB DATABASE_URL
PASSED=0
FAILED=0
for TEST in tests/test_*.sh tests/test_*.py; do
    LOG="$SUITE/$(basename "$TEST").log"
    export TEST_SERVER_LOG="$SUITE/$(basename "$TEST").server.log"
    echo "Running $TEST..."
    if [[ "$TEST" == *_logic.py || "$TEST" == *test_community_members.py ]]; then
        COMMAND=(python3 -B "$TEST")
    else
        COMMAND=(bash scripts/pg_test_env.sh -- bash scripts/run_one_test.sh "$TEST")
    fi
    if "${COMMAND[@]}" >"$LOG" 2>&1 && ! grep -Eq '✗|Traceback \(most recent call last\):|command not found|No such file or directory' "$LOG"; then
        echo "PASS $TEST"
        PASSED=$((PASSED + 1))
    else
        echo "FAIL $TEST (see $LOG)"
        tail -15 "$LOG"
        FAILED=$((FAILED + 1))
    fi
done
echo "Test Summary: $PASSED passed, $FAILED failed"
echo "Logs: $SUITE"
[[ "$FAILED" == 0 ]]
