"""Guard test targets before connecting; provision isolated unit-test databases."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def require_test_database():
    from psycopg.conninfo import conninfo_to_dict
    try:
        name = conninfo_to_dict(os.environ.get('DATABASE_URL', '')).get('dbname', '')
    except Exception:
        name = ''
    if not name.startswith('beebo_test'):
        raise SystemExit(f'Refusing test database {name!r}: name must start with beebo_test')
    os.environ['BEEBO_TEST'] = '1'
    return name


def isolated_database():
    if os.environ.get('DATABASE_URL'):
        require_test_database()
    if os.environ.get('BEEBO_UNIT_CHILD') != '1':
        environment = dict(os.environ, BEEBO_UNIT_CHILD='1')
        for key in ('DATABASE_URL', 'BEEBO_TEST_DB'):
            environment.pop(key, None)
        result = subprocess.run(
            ['bash', str(ROOT / 'scripts/pg_test_env.sh'), '--',
             sys.executable, '-B', str(Path(sys.argv[0]).resolve()), *sys.argv[1:]],
            env=environment, cwd=ROOT)
        raise SystemExit(result.returncode)
    require_test_database()


if __name__ == '__main__':
    require_test_database()
