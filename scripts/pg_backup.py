"""Custom-format backups and guarded, disposable restore verification."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone
import uuid

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict


ROOT = Path(__file__).resolve().parents[1]


def run_tool(tool, parameters, arguments, **kwargs):
    environment = dict(os.environ)
    for key, value in parameters.items():
        environment[{'dbname': 'PGDATABASE', 'user': 'PGUSER',
                     'password': 'PGPASSWORD', 'host': 'PGHOST',
                     'port': 'PGPORT', 'sslmode': 'PGSSLMODE'}.get(
                         key, 'PG' + key.upper())] = str(value)
    command = [tool, *arguments]
    if not shutil.which(tool):
        container = os.environ.get('PG_TEST_CONTAINER')
        if not container:
            raise RuntimeError(f'{tool} missing; install PostgreSQL client tools or set PG_TEST_CONTAINER')
        command = ['docker', 'exec', '-i']
        for key in environment:
            if key.startswith('PG'):
                command += ['-e', key]
        command += [container, tool, *arguments]
    subprocess.run(command, env=environment, check=True, **kwargs)


def counts(connection):
    tables = connection.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    ).fetchall()
    return {name: connection.execute(sql.SQL('SELECT count(*) FROM public.{}').format(
        sql.Identifier(name))).fetchone()[0] for (name,) in tables}


def main():
    parameters = conninfo_to_dict(os.environ['DATABASE_URL'])
    name = parameters.get('dbname', '')
    if not name:
        raise RuntimeError('DATABASE_URL must name a source database')
    directory = ROOT / 'backups'
    directory.mkdir(exist_ok=True)
    if sys.argv[1] == 'backup':
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        target = directory / f'{name}_{stamp}.dump'
        temporary = target.with_suffix('.partial')
        try:
            with temporary.open('xb') as output:
                os.chmod(temporary, 0o600)
                run_tool('pg_dump', parameters, ['-Fc', '--no-owner', '--no-acl'], stdout=output)
            temporary.replace(target)
            for old in sorted(directory.glob(f'{name}_*.dump'), reverse=True)[7:]:
                old.unlink()
        finally:
            temporary.unlink(missing_ok=True)
        print(f'PASS backup: {target} ({target.stat().st_size} bytes); retained newest 7 for {name}')
        return
    candidates = sorted(directory.glob(f'{name}_*.dump'), reverse=True)
    if not candidates:
        raise RuntimeError(f'No dump available for {name}')
    target = 'beebo_test_restore_' + uuid.uuid4().hex
    admin_parameters = dict(parameters, dbname=os.environ.get('PG_MAINT_DB', 'postgres'))
    with psycopg.connect(**admin_parameters, autocommit=True) as admin:
        admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(target)))
        try:
            with candidates[0].open('rb') as dump:
                run_tool('pg_restore', dict(parameters, dbname=target),
                         ['--exit-on-error', '--no-owner', '--no-acl', '-d', target], stdin=dump)
            with psycopg.connect(**parameters) as source, psycopg.connect(
                    **dict(parameters, dbname=target)) as restored:
                source_counts, restored_counts = counts(source), counts(restored)
                for table in sorted(source_counts.keys() | restored_counts.keys()):
                    print(f'{table}: source={source_counts.get(table)} restored={restored_counts.get(table)}')
                if source_counts != restored_counts:
                    raise RuntimeError('Restore row counts differ; source must remain quiescent since backup')
            print(f'PASS restore: {candidates[0].name} -> {target}; all table counts match')
        finally:
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(target)))
            print(f'Dropped {target}')


if __name__ == '__main__':
    main()
