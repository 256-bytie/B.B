"""Database initialization and connection management."""
import os
import sqlite3

from app.migrations import run_migrations
from app.sqlite_migrations import run_sqlite_migrations


def get_db_path():
    """Get the database path from environment or use default."""
    return os.environ.get('DB_PATH', 'beebo.db')


def get_db():
    """Get a SQLite database connection with foreign keys enabled.

    This remains the SQLite connection used by the application's query code
    during the transition. The PostgreSQL connection path is added in a later
    phase; this phase ports only schema initialization / migrations.
    """
    conn = sqlite3.connect(get_db_path())
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def _database_name_from_url(url):
    """Return the database name (path component) of a DATABASE_URL."""
    from urllib.parse import urlparse
    return urlparse(url).path.lstrip('/')


def _enforce_test_guard():
    """Refuse to run against a non-throwaway database when BEEBO_TEST=1.

    The throwaway-database harness (scripts/pg_test_env.sh) always sets
    BEEBO_TEST=1 and points DATABASE_URL at a `beebo_test_<random>` database.
    If BEEBO_TEST=1 but the target database does not start with `beebo_test`,
    abort rather than risk writing to real data.
    """
    if os.environ.get('BEEBO_TEST') == '1':
        url = os.environ.get('DATABASE_URL')
        if url:
            dbname = _database_name_from_url(url)
            if not dbname.startswith('beebo_test'):
                raise RuntimeError(
                    'BEEBO_TEST=1 but DATABASE_URL points at database '
                    f'"{dbname}", which does not start with "beebo_test". '
                    'Refusing to run against a non-throwaway database.'
                )


def _pg_connection():
    """Open a psycopg connection for running migrations.

    This is the minimal PostgreSQL path needed to apply migrations; the
    application's own data-access connection (get_db) is ported in a later
    phase.
    """
    import psycopg
    url = os.environ.get('DATABASE_URL')
    if not url:
        raise RuntimeError(
            'DATABASE_URL is not set; the PostgreSQL backend requires it.'
        )
    return psycopg.connect(url)


def init_db():
    """Initialize the database by applying migrations.

    Backend is selected by environment variable:
      * DATABASE_URL set -> PostgreSQL, migrations from migrations/pg/.
      * otherwise        -> SQLite (transitional), migrations from migrations/.
    """
    _enforce_test_guard()

    if os.environ.get('DATABASE_URL'):
        conn = _pg_connection()
        try:
            run_migrations(conn)
        finally:
            conn.close()
        return

    conn = sqlite3.connect(get_db_path())
    try:
        conn.execute('PRAGMA foreign_keys = ON')
        run_sqlite_migrations(conn)
    finally:
        conn.close()
