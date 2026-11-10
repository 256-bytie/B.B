#!/usr/bin/env bash
# Frontend logic checks for the notifications screen (static/js/notifications.js).
# Needs Node (Termux: pkg install nodejs); skips cleanly when it is absent.
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
    echo "SKIP: node not installed (pkg install nodejs)"
    exit 0
fi
TZ=UTC node tests/notifications_frontend_check.js
