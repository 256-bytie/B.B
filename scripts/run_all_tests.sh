#!/bin/bash
set -e

echo "=========================================="
echo "Running Full Test Suite"
echo "=========================================="
echo ""

# Clean up
rm -f beebo_test.db cookies*.txt test_cookie.txt e2e_cookie.txt

# Start server
echo "Starting server with DB_PATH=beebo_test.db..."
DB_PATH=beebo_test.db python3 app.py > /tmp/server.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > /tmp/server.pid
sleep 3

if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "✗ Server failed to start"
    cat /tmp/server.log
    exit 1
fi

echo "✓ Server started (PID: $SERVER_PID)"
echo ""

# Run tests
TESTS=(
    "test_comments.sh"
    "test_comments2.sh"
    "test_follows.sh"
    "test_highlights.sh"
    "test_highlights_video.sh"
    "test_file_cleanup.sh"
    "test_wallet.sh"
)

PASSED=0
FAILED=0

for TEST in "${TESTS[@]}"; do
    echo "Running $TEST..."
    if ./$TEST > /tmp/${TEST}.log 2>&1; then
        echo "✓ $TEST PASSED"
        PASSED=$((PASSED + 1))
    else
        echo "✗ $TEST FAILED (see /tmp/${TEST}.log)"
        FAILED=$((FAILED + 1))
    fi
    echo ""
done

# Stop server
echo "Stopping server..."
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

echo "=========================================="
echo "Test Summary: $PASSED passed, $FAILED failed"
echo "=========================================="

if [ $FAILED -gt 0 ]; then
    exit 1
fi
