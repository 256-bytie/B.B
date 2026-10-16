#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/test_guard.sh"
TEST="$1"
SERVER_PID=""
cleanup() {
    if [[ -n "$SERVER_PID" ]]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "$TEST" == *.py ]]; then
    python3 -B "$TEST"
    exit
fi
python3 - <<'CHECK'
import socket
with socket.socket() as listener:
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', 5050))
CHECK
python3 -B app.py >"$TEST_SERVER_LOG" 2>&1 &
SERVER_PID=$!
READY=0
for attempt in {1..100}; do
    kill -0 "$SERVER_PID" 2>/dev/null || { cat "$TEST_SERVER_LOG"; exit 1; }
    if command curl -sf http://127.0.0.1:5050/api/session >/dev/null; then
        READY=1
        break
    fi
    sleep 0.1
done
[[ "$READY" == 1 ]] || { cat "$TEST_SERVER_LOG"; exit 1; }
export BEEBO_SERVER_RUNNING=1
bash "$TEST"
