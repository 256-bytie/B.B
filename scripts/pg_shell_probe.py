#!/usr/bin/env python3
"""Run legacy shell-test SQL probes against a guarded throwaway PostgreSQL DB."""
import os
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests'))
from pg_support import require_test_database
require_test_database()
with psycopg.connect(os.environ['DATABASE_URL']) as connection:
    cursor = connection.execute(sys.argv[-1])
    if cursor.description:
        for row in cursor:
            print('|'.join('' if value is None else str(value) for value in row))
