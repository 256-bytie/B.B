#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/test_guard.sh" || exit 1
set -euo pipefail
python3 -B tests/test_pg_phase3.py
