#!/usr/bin/env python3
"""Read-only SQLite ETL. Never repairs source data or disables constraints."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
from graphlib import TopologicalSorter
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid
import json

import psycopg
from psycopg import sql


def ident(name):
    return sql.Identifier(name)


def report(rows):
    print(f"{'Check':48} | {'Status':6} | Details")
    print('-' * 100)
    for check, status, detail in rows:
        print(f'{check:48} | {status:6} | {detail}')


def timestamp(value, table, row_id, column):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(
        r'\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?', value
    ):
        raise ValueError(f'{table} id={row_id} {column}={value!r}: invalid timestamp')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc)
    except ValueError as error:
        raise ValueError(f'{table} id={row_id} {column}={value!r}: {error}') from error


def schema(connection):
    versions = {row[0] for row in connection.execute('SELECT version FROM public.schema_migrations')}
    required = {int(path.name.split('_')[0]) for path in
                (Path(__file__).resolve().parents[1] / 'migrations/pg').glob('[0-9]*_*.sql')}
    if not required <= versions:
        raise ValueError('Target has unapplied migrations')
    columns = {}
    for table, column, datatype, identity in connection.execute("""
        SELECT table_name, column_name, data_type, is_identity
        FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name <> 'schema_migrations' ORDER BY table_name, ordinal_position
    """):
        columns.setdefault(table, []).append((column, datatype, identity == 'YES'))
    foreign_keys = connection.execute("""
        SELECT child.relname, parent.relname,
               array_agg(ca.attname ORDER BY keys.ordinality),
               array_agg(pa.attname ORDER BY keys.ordinality), constraint_row.conname
        FROM pg_constraint constraint_row
        JOIN pg_class child ON child.oid = conrelid
        JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = confrelid
        CROSS JOIN LATERAL unnest(conkey, confkey) WITH ORDINALITY keys(child_key, parent_key, ordinality)
        JOIN pg_attribute ca ON ca.attrelid = child.oid AND ca.attnum = keys.child_key
        JOIN pg_attribute pa ON pa.attrelid = parent.oid AND pa.attnum = keys.parent_key
        WHERE contype = 'f' AND namespace.nspname = 'public'
        GROUP BY child.relname, parent.relname, constraint_row.conname
    """).fetchall()
    dependencies = {table: set() for table in columns}
    for child, parent, *_ in foreign_keys:
        if parent not in columns:
            raise ValueError(f'Unsupported external FK: {child} -> {parent}')
        if child != parent:
            dependencies[child].add(parent)
    return columns, foreign_keys, list(TopologicalSorter(dependencies).static_order())


def source_rows(source, columns):
    tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if tables - set(columns) - {'sqlite_sequence', 'schema_migrations'} or set(columns) - tables:
        raise ValueError('Source/target application table sets differ')
    data = {}
    for table, metadata in columns.items():
        names = [column for column, *_ in metadata]
        source_names = {row[1] for row in source.execute(f'PRAGMA table_info("{table}")')}
        expected = set(names) - ({'seq'} if table == 'community_members' else set())
        if source_names != expected:
            raise ValueError(f'{table}: source/target columns differ')
        selection = ', '.join('rowid' if table == 'community_members' and name == 'seq'
                              else '"' + name.replace('"', '""') + '"' for name in names)
        data[table] = []
        for row in source.execute(f'SELECT {selection} FROM "{table}"'):
            row_id = row[names.index('id')] if 'id' in names else row[:2]
            data[table].append(tuple(timestamp(value, table, row_id, name)
                                     if datatype == 'timestamp with time zone' else value
                                     for value, (name, datatype, _) in zip(row, metadata)))
    return data


def quarantine(data, columns, target_user_ids):
    names = {table: [column for column, *_ in metadata] for table, metadata in columns.items()}
    excluded = {table: set() for table in data}
    existing_users = {row[names['users'].index('id')] for row in data['users']}
    missing = set()
    for table, rows in data.items():
        fields = names[table]
        for field in ('user_id', 'creator_id', 'sender_id', 'follower_id', 'followee_id'):
            if field in fields:
                missing.update(row[fields.index(field)] for row in rows if row[fields.index(field)] not in existing_users)
    for table, rows in data.items():
        fields = names[table]
        for field in ('user_id', 'creator_id', 'sender_id', 'follower_id', 'followee_id'):
            if field in fields:
                excluded[table].update(i for i, row in enumerate(rows) if row[fields.index(field)] in missing)
    def ids(table):
        return {data[table][i][names[table].index('id')] for i in excluded[table] if 'id' in names[table]}
    changed = True
    while changed:
        changed = False
        post_ids, comment_ids, community_ids = ids('posts'), ids('comments'), ids('communities')
        conversation_ids = ids('conversations')
        rules = [('comments', 'post_id', post_ids), ('comments', 'parent_comment_id', comment_ids),
                 ('post_images', 'post_id', post_ids), ('dislikes', 'comment_id', comment_ids),
                 ('posts', 'quoted_post_id', post_ids), ('posts', 'community_id', community_ids),
                 ('community_members', 'community_id', community_ids), ('messages', 'conversation_id', conversation_ids),
                 ('conversation_reads', 'conversation_id', conversation_ids), ('conversation_state', 'conversation_id', conversation_ids)]
        for table, field, values in rules:
            if table in data and field in names[table]:
                before = len(excluded[table])
                excluded[table].update(i for i, row in enumerate(data[table]) if row[names[table].index(field)] in values)
                changed |= before != len(excluded[table])
        if 'likes' in data:
            before = len(excluded['likes'])
            fields = names['likes']
            excluded['likes'].update(i for i, row in enumerate(data['likes']) if
                (row[fields.index('target_type')] == 'post' and row[fields.index('target_id')] in post_ids) or
                (row[fields.index('target_type')] == 'comment' and row[fields.index('target_id')] in comment_ids))
            changed |= before != len(excluded['likes'])
        for table, field, values in (('posts', 'user_id', missing), ('comments', 'user_id', missing)):
            if table in data:
                before=len(excluded[table]); excluded[table].update(i for i,row in enumerate(data[table]) if row[names[table].index(field)] in values); changed |= before != len(excluded[table])
    return excluded


def save_quarantine(source, data, excluded):
    root = Path(__file__).resolve().parents[1]
    target = root / 'backups' / ('quarantine_' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
    target.parent.mkdir(exist_ok=True)
    payload = {}
    for table, indexes in excluded.items():
        if indexes:
            columns = [row[1] for row in source.execute(f'PRAGMA table_info("{table}")')]
            payload[table] = [dict(zip(columns, data[table][i])) for i in sorted(indexes)]
    target.write_text(json.dumps(payload, default=str, indent=2) + '\n')
    print(f'Quarantine file: {target}')
    return target


def source_findings(source):
    findings = []
    integrity = source.execute('PRAGMA integrity_check').fetchall()
    findings.append(('SQLite integrity', 'PASS' if integrity == [('ok',)] else 'FAIL', integrity))
    findings.append(('SQLite foreign_key_check', 'INFO', source.execute('PRAGMA foreign_key_check').fetchall()))
    queries = {
        'Polymorphic likes (not enforced)': "SELECT id FROM likes WHERE (target_type='post' AND target_id NOT IN (SELECT id FROM posts)) OR (target_type='comment' AND target_id NOT IN (SELECT id FROM comments))",
        'Dislike orphans (validated below)': 'SELECT id FROM dislikes WHERE comment_id NOT IN (SELECT id FROM comments)',
        'Dangling quotes (allowed)': 'SELECT id FROM posts WHERE quoted_post_id NOT IN (SELECT id FROM posts)',
        'posts.like_count drift': "SELECT id, like_count FROM posts WHERE like_count IS NOT (SELECT count(*) FROM likes WHERE target_type='post' AND target_id=posts.id)",
        'posts.comment_count drift': 'SELECT id, comment_count FROM posts WHERE comment_count IS NOT (SELECT count(*) FROM comments WHERE post_id=posts.id)',
        'comments.like_count drift': "SELECT id, like_count FROM comments WHERE like_count IS NOT (SELECT count(*) FROM likes WHERE target_type='comment' AND target_id=comments.id)",
        'Zero ledger amounts (validated below)': 'SELECT id FROM credit_transactions WHERE amount=0',
    }
    for label, query in queries.items():
        rows = source.execute(query).fetchall()
        findings.append((label, 'WARN' if rows else 'PASS', rows))
    balances = source.execute('SELECT user_id, sum(amount) FROM credit_transactions GROUP BY user_id ORDER BY user_id').fetchall()
    findings.append(('Ledger balances (user, balance)', 'INFO', balances))
    return findings


def preflight(connection, columns, foreign_keys, data, findings):
    """Temporary LIKE tables enforce actual PG types, checks and unique indexes."""
    for table, metadata in columns.items():
        stage = 'etl_' + table
        connection.execute(sql.SQL('CREATE TEMP TABLE {} (LIKE public.{} INCLUDING ALL) ON COMMIT DROP').format(ident(stage), ident(table)))
        names = sql.SQL(', ').join(ident(column) for column, *_ in metadata)
        query = sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(
            ident(stage), names, sql.SQL(', ').join(sql.Placeholder() for _ in metadata))
        failures = 0
        for row in data[table]:
            try:
                with connection.transaction():
                    connection.execute(query, row)
            except psycopg.IntegrityError as error:
                failures += 1
                key = row[[column for column, *_ in metadata].index('id')] if any(column == 'id' for column, *_ in metadata) else row[:2]
                findings.append((table + ' constraint', 'FAIL', f'id/key={key}: {error.diag.message_primary}; {error.diag.message_detail}'))
        findings.append((table + ' checks/unique/not-null', 'FAIL' if failures else 'PASS', f'{failures} rejected rows'))
    for child, parent, child_columns, parent_columns, name in foreign_keys:
        join = sql.SQL(' AND ').join(sql.SQL('child.{} = parent.{}').format(ident(left), ident(right))
                                     for left, right in zip(child_columns, parent_columns))
        nonnull = sql.SQL(' AND ').join(sql.SQL('child.{} IS NOT NULL').format(ident(column)) for column in child_columns)
        rows = connection.execute(sql.SQL('SELECT child.* FROM {} child WHERE {} AND NOT EXISTS (SELECT 1 FROM {} parent WHERE {})').format(
            ident('etl_' + child), nonnull, ident('etl_' + parent), join)).fetchall()
        metadata = [column for column, *_ in columns[child]]
        keys = [row[metadata.index('id')] if 'id' in metadata else row[:2] for row in rows]
        findings.append((name, 'FAIL' if rows else 'PASS', f'orphan ids/keys={keys}'))
    report(findings)
    if any(status == 'FAIL' for _, status, _ in findings):
        raise ValueError('Source violates enforced constraints; no data repaired or loaded. Obtain an approved valid backup.')


def reset_sequences(connection, columns):
    maximums = {}
    for table, metadata in columns.items():
        for column, _, identity in metadata:
            if not identity:
                continue
            sequence = connection.execute('SELECT pg_get_serial_sequence(%s, %s)', ('public.' + table, column)).fetchone()[0]
            maximum = connection.execute(sql.SQL('SELECT max({}) FROM public.{}').format(ident(column), ident(table))).fetchone()[0]
            maximums[table] = (column, maximum or 0)
            connection.execute('SELECT setval(%s, %s, %s)', (sequence, max(maximum or 0, 1), bool(maximum)))
    return maximums


def prove_sequences(connection, maximums):
    """Fresh related fixtures avoid collisions and work even on empty sources."""
    token = uuid.uuid4().hex
    results = []
    connection.execute('SAVEPOINT sequence_proof')
    def insert(table, values):
        column = maximums[table][0] if table in maximums else 'conversation_id'
        row_id = connection.execute(sql.SQL('INSERT INTO public.{} ({}) VALUES ({}) RETURNING {}').format(
            ident(table), sql.SQL(', ').join(map(ident, values)),
            sql.SQL(', ').join(sql.Placeholder() for _ in values), ident(column)), tuple(values.values())).fetchone()[0]
        expected = maximums[table][1] + 1 if table in maximums else row_id
        results.append((table + ' insert/sequence', 'PASS' if row_id == expected else 'FAIL', f'{column}={row_id}, expected={expected}'))
        return row_id
    try:
        user = insert('users', dict(full_name='ETL proof', email=token, password_hash='!'))
        other = connection.execute("INSERT INTO public.users(full_name,email,password_hash) VALUES ('ETL proof', %s, '!') RETURNING id", (token + 'other',)).fetchone()[0]
        community = insert('communities', dict(slug=token, name=token, description='', topic='', type='public', creator_id=user))
        post = insert('posts', dict(user_id=user, content='proof'))
        comment = insert('comments', dict(post_id=post, user_id=user, content='proof'))
        insert('post_images', dict(post_id=post, image_path='/proof', position=0))
        insert('likes', dict(user_id=user, target_type='post', target_id=post))
        insert('dislikes', dict(user_id=user, comment_id=comment))
        insert('follows', dict(follower_id=user, followee_id=other))
        insert('highlights', dict(user_id=user, title='proof', kind='photo', media_url='/proof'))
        insert('search_history', dict(user_id=user, query='proof'))
        insert('library_files', dict(user_id=user, title='proof', category='proof', file_path='/proof', file_type='pdf', file_size=1))
        insert('credit_transactions', dict(user_id=user, amount=1, kind='free', reason='proof', description='proof'))
        insert('community_members', dict(community_id=community, user_id=user, role='member'))
        conversation = insert('conversations', dict(user_low_id=user, user_high_id=other))
        insert('messages', dict(conversation_id=conversation, sender_id=user, body='proof'))
        insert('conversation_reads', dict(conversation_id=conversation, user_id=user))
        insert('conversation_state', dict(conversation_id=conversation))
    finally:
        connection.execute('ROLLBACK TO SAVEPOINT sequence_proof')
        connection.execute('RELEASE SAVEPOINT sequence_proof')
    return results


def repair_counters(connection, data, excluded, columns):
    names = {table: [column for column, *_ in metadata] for table, metadata in columns.items()}
    post_ids = set()
    comment_ids = set()
    for i in excluded.get('likes', set()):
        row = data['likes'][i]
        fields = names['likes']
        target = row[fields.index('target_id')]
        if row[fields.index('target_type')] == 'post':
            post_ids.add(target)
        elif row[fields.index('target_type')] == 'comment':
            comment_ids.add(target)
    for i in excluded.get('comments', set()):
        comment_ids.discard(data['comments'][i][names['comments'].index('id')])
        post_ids.add(data['comments'][i][names['comments'].index('post_id')])
    for table, identifiers, counter, query in (
            ('posts', post_ids, 'like_count', "SELECT count(*) FROM likes WHERE target_type='post' AND target_id=%s"),
            ('posts', post_ids, 'comment_count', 'SELECT count(*) FROM comments WHERE post_id=%s'),
            ('comments', comment_ids, 'like_count', "SELECT count(*) FROM likes WHERE target_type='comment' AND target_id=%s")):
        for identifier in sorted(identifiers):
            if identifier not in {row[names[table].index('id')] for row in data[table]} or identifier in {data[table][i][names[table].index('id')] for i in excluded.get(table, set())}:
                continue
            old = connection.execute(sql.SQL('SELECT {} FROM public.{} WHERE id=%s').format(ident(counter), ident(table)), (identifier,)).fetchone()[0]
            new = connection.execute(query, (identifier,)).fetchone()[0]
            if old != new:
                connection.execute(sql.SQL('UPDATE public.{} SET {}=%s WHERE id=%s').format(ident(table), ident(counter)), (new, identifier))
                print(f'Counter repair {table} id={identifier}: {counter} {old} -> {new}')


def verify(source, connection, columns, excluded=None, source_data=None):
    results = []
    excluded = excluded or {table: set() for table in columns}
    source_data = source_data or source_rows(source, columns)
    for table in columns:
        source_count = source.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        target_count = connection.execute(sql.SQL('SELECT count(*) FROM public.{}').format(ident(table))).fetchone()[0]
        expected = source_count - len(excluded.get(table, set()))
        results.append((table + ' count', 'PASS' if expected == target_count else 'FAIL', f'SQLite={source_count}, excluded={len(excluded.get(table, set()))}, PG={target_count}'))
    queries = {'Credit balances': 'SELECT user_id, sum(amount) FROM credit_transactions GROUP BY user_id ORDER BY user_id'}
    excluded_like_ids = {source_data['likes'][i][0] for i in excluded.get('likes', set())}
    excluded_comment_ids = {source_data['comments'][i][0] for i in excluded.get('comments', set())}
    excluded_post_ids = {source_data['posts'][i][0] for i in excluded.get('posts', set())}
    post_like_targets = {source_data['likes'][i][2] for i in excluded.get('likes', set()) if source_data['likes'][i][1] == 'post'}
    comment_like_targets = {source_data['likes'][i][2] for i in excluded.get('likes', set()) if source_data['likes'][i][1] == 'comment'}
    post_comment_targets = {source_data['comments'][i][1] for i in excluded.get('comments', set())}
    for table, metadata in columns.items():
        counters = [column for column, *_ in metadata if column.endswith('_count')]
        if not counters:
            continue
        names = [column for column, *_ in metadata]
        expected = []
        for index, row in enumerate(source.execute(f'SELECT {", ".join(names)} FROM "{table}"').fetchall()):
            if index in excluded.get(table, set()):
                continue
            identifier = row[names.index('id')]
            values = {counter: row[names.index(counter)] for counter in counters}
            if table == 'posts' and (identifier in post_like_targets or identifier in post_comment_targets):
                values['like_count'] = source.execute('SELECT count(*) FROM likes WHERE target_type=? AND target_id=? AND id NOT IN (%s)' % (','.join('?' * len(excluded_like_ids)) or 'NULL'), ('post', identifier, *excluded_like_ids)).fetchone()[0]
                values['comment_count'] = source.execute('SELECT count(*) FROM comments WHERE post_id=? AND id NOT IN (%s)' % (','.join('?' * len(excluded_comment_ids)) or 'NULL'), (identifier, *excluded_comment_ids)).fetchone()[0]
            elif table == 'comments' and identifier in comment_like_targets:
                values['like_count'] = source.execute('SELECT count(*) FROM likes WHERE target_type=? AND target_id=? AND id NOT IN (%s)' % (','.join('?' * len(excluded_like_ids)) or 'NULL'), ('comment', identifier, *excluded_like_ids)).fetchone()[0]
            expected.append((identifier, *(values[counter] for counter in counters)))
        right = connection.execute(sql.SQL('SELECT id, {} FROM public.{} ORDER BY id').format(sql.SQL(', ').join(ident(counter) for counter in counters), ident(table))).fetchall()
        results.append((table + ' counters', 'PASS' if expected == right else 'FAIL', f'{len(expected)} rows compared'))
    for label, query in queries.items():
        left = source.execute(query).fetchall()
        right = connection.execute(query).fetchall()
        results.append((label, 'PASS' if left == right else 'FAIL', f'{len(left)} rows compared'))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--truncate', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--allow-nontest', action='store_true')
    parser.add_argument('--quarantine-orphans', action='store_true')
    args = parser.parse_args()
    url = os.environ.get('DATABASE_URL')
    if not url:
        raise ValueError('DATABASE_URL is required')
    name = psycopg.conninfo.conninfo_to_dict(url).get('dbname', '')
    if not name or (not name.startswith('beebo_test_') and not args.allow_nontest):
        raise ValueError('Refusing non-test target; require beebo_test_* or explicit --allow-nontest for cutover')
    with closing(sqlite3.connect(args.source.resolve().as_uri() + '?mode=ro', uri=True)) as source:
        source.execute('BEGIN')
        with psycopg.connect(url) as connection:
            connection.execute("SET LOCAL search_path = public")
            connection.execute("SET LOCAL TIME ZONE 'UTC'")
            actual = connection.execute('SELECT current_database()').fetchone()[0]
            if actual != name:
                raise ValueError('Target database name mismatch')
            print(f'Target: {actual}')
            columns, foreign_keys, order = schema(connection)
            table_list = sql.SQL(', ').join(sql.Identifier('public', table) for table in order)
            connection.execute(sql.SQL('LOCK TABLE {} IN ACCESS EXCLUSIVE MODE').format(table_list))
            occupied = [(table, connection.execute(sql.SQL('SELECT count(*) FROM public.{}').format(ident(table))).fetchone()[0]) for table in order]
            occupied = [(table, count) for table, count in occupied if count]
            if occupied and not args.truncate:
                raise ValueError(f'Non-empty target: {occupied}; refusing without --truncate')
            data = source_rows(source, columns)
            source_data = {table: list(rows) for table, rows in data.items()}
            excluded = {table: set() for table in data}
            if args.quarantine_orphans:
                excluded = quarantine(data, columns, set())
                save_quarantine(source, data, excluded)
                for table in data:
                    data[table] = [row for i, row in enumerate(data[table]) if i not in excluded[table]]
            else:
                missing = source.execute('SELECT id FROM posts WHERE user_id NOT IN (SELECT id FROM users)').fetchall()
                if missing:
                    raise ValueError('Source contains orphan rows; rerun with --quarantine-orphans')
            preflight(connection, columns, foreign_keys, data, source_findings(source))
            print('Load order:', ', '.join(order))
            connection.execute(sql.SQL('TRUNCATE {} RESTART IDENTITY').format(table_list))
            for table in order:
                names = sql.SQL(', ').join(ident(column) for column, *_ in columns[table])
                connection.execute(sql.SQL('INSERT INTO public.{} ({}) SELECT {} FROM {}').format(
                    ident(table), names, names, ident('etl_' + table)))
            maximums = reset_sequences(connection, columns)
            repair_counters(connection, source_data, excluded, columns)
            results = verify(source, connection, columns, excluded, source_data)
            for table in columns:
                source_count = source.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                excluded_count = len(excluded[table])
                loaded_count = len(data[table])
                results.append((table + ' reconciliation', 'PASS' if source_count == excluded_count + loaded_count else 'FAIL', f'source={source_count}, excluded={excluded_count}, loaded={loaded_count}'))
            results.extend(prove_sequences(connection, maximums))
            reset_sequences(connection, columns)
            report(results)
            if any(status != 'PASS' for _, status, _ in results):
                raise ValueError('Verification failed; rolling back')
            if args.dry_run:
                connection.rollback()
                print('DRY RUN: rolled back all target changes')
            else:
                connection.commit()
                print('Committed verified migration')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, psycopg.Error, sqlite3.Error) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
