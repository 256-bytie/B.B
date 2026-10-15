"""Database initialization and connection management."""
import atexit
import os
import threading

from app.migrations import run_migrations


def _require_database_url():
    url = os.environ.get('DATABASE_URL')
    if not url:
        raise RuntimeError(
            'DATABASE_URL is not set; the PostgreSQL backend requires it.'
        )
    return url


def get_db_path():
    """Legacy compatibility name for startup reporting.

    The application talks to PostgreSQL via DATABASE_URL. This helper no
    longer selects a SQLite file; callers that only need the target name
    for a startup message should use get_db_name() instead.
    """
    return get_db_name()


def get_db_name():
    """Return only the database name from DATABASE_URL (never credentials)."""
    from urllib.parse import urlparse
    return urlparse(_require_database_url()).path.lstrip('/') or 'postgres'


def get_db_host():
    """Return only the host from DATABASE_URL (never credentials)."""
    from urllib.parse import urlparse
    return urlparse(_require_database_url()).hostname or 'localhost'


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
        url = _require_database_url()
        dbname = _database_name_from_url(url)
        if not dbname.startswith('beebo_test'):
            raise RuntimeError(
                'BEEBO_TEST=1 but DATABASE_URL points at database '
                f'"{dbname}", which does not start with "beebo_test". '
                'Refusing to run against a non-throwaway database.'
            )


def _connection_kwargs():
    """Shared psycopg connection options for the pool and migrations."""
    import psycopg
    from psycopg.rows import tuple_row
    url = _require_database_url()
    conn_params = psycopg.conninfo.conninfo_to_dict(url)
    conn_params.setdefault('options', '')
    if 'TimeZone=UTC' not in conn_params['options']:
        conn_params['options'] = (
            f"{conn_params['options']} -c TimeZone=UTC"
            if conn_params['options']
            else '-c TimeZone=UTC'
        )
    conninfo = psycopg.conninfo.make_conninfo('', **conn_params)
    return {
        'conninfo': conninfo,
        'row_factory': tuple_row,
        'autocommit': False,
    }


_pool_lock = threading.Lock()
_pool = None


def close_pool():
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None


atexit.register(close_pool)


def get_db():
    """Get a connection from the shared psycopg pool.

    The connection uses tuple rows, autocommit=False, and TimeZone=UTC.
    Existing call sites do `conn = get_db(); try: ... finally: conn.close()`:
    close() returns the connection to the pool, rolling back any uncommitted
    transaction. A pool timeout raises the same PoolTimeout the HTTP layer
    maps to a fast-fail 503.
    """
    import psycopg_pool
    _enforce_test_guard()
    global _pool
    with _pool_lock:
        if _pool is None:
            min_size = int(os.environ.get('PG_POOL_MIN', '1'))
            max_size = int(os.environ.get('PG_POOL_MAX', '8'))
            timeout = float(os.environ.get('PG_POOL_TIMEOUT', '5'))
            conn_kwargs = _connection_kwargs()
            conninfo = conn_kwargs.pop('conninfo')
            _pool = psycopg_pool.ConnectionPool(
                conninfo,
                kwargs=conn_kwargs,
                min_size=min_size,
                max_size=max_size,
                timeout=timeout,
                close_returns=True,
                open=False,
            )
            _pool.open()
    return _pool.getconn(timeout=_pool.timeout)


def init_db():
    """Initialize the database by applying PostgreSQL migrations."""
    _enforce_test_guard()
    import psycopg
    kwargs = _connection_kwargs()
    conn = psycopg.connect(kwargs['conninfo'], row_factory=kwargs['row_factory'])
    try:
        conn.autocommit = False
        run_migrations(conn)
    finally:
        conn.close()
