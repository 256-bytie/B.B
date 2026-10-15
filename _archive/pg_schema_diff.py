#!/usr/bin/env python3
"""Compare the Postgres schema (migrations/pg/) against the final SQLite schema.

The reference SQLite schema is produced by running the current SQLite
migration path (app/sqlite_migrations.py, which replays migrations/*.sql) on a
fresh in-memory database — the same schema the pre-migration app used. The
Postgres schema is read live from DATABASE_URL (already migrated). The two are
normalized and compared on five dimensions: column names, nullability, foreign
keys (target + delete rule), CHECK constraints, and index definitions.

Known, intentional differences (type mappings and the rowid->seq replacement)
are normalized away and reported under a legend rather than as failures, so the
"unexplained differences" list should be empty for a correct baseline.

Usage (run from repo root so `app` imports resolve):

    source scripts/pg_test_env.sh
    python3 scripts/pg_schema_diff.py            # writes docs/pg_schema_diff.txt
    # or:  DATABASE_URL=... python3 scripts/pg_schema_diff.py
"""
import os
import re
import sqlite3
import sys

# --- normalization helpers ---------------------------------------------------

_WS = re.compile(r'\s+')

# Columns that reference an id but intentionally have no FK (polymorphic or
# quote-preserving), so they become BIGINT without being an FK column.
_ID_REF_NO_FK = {('likes', 'target_id'), ('posts', 'quoted_post_id')}


def _norm_ws(s):
    return _WS.sub(' ', s).strip()


def _strip_outer_parens(s):
    s = s.strip()
    while s.startswith('(') and s.endswith(')'):
        # only strip if the parens are matched around the whole string
        depth = 0
        ok = True
        for i, ch in enumerate(s):
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0 and i != len(s) - 1:
                    ok = False
                    break
        if not ok or depth != 0:
            break
        s = s[1:-1].strip()
    return s


def _norm_check(expr):
    """Normalize a CHECK expression to a canonical, comparable string."""
    e = expr.strip()
    e = re.sub(r'^CHECK\s*', '', e, flags=re.I)  # drop the CHECK keyword
    e = _strip_outer_parens(e)
    # PG renders IN (...) as `= ANY (ARRAY[...])`; fold it back to `IN (...)`.
    m = re.match(r'^(.+?)\s*=\s*ANY\s*\(\s*ARRAY\[(.*)\]\)\s*$', e, re.S)
    if m:
        e = f'{m.group(1)} IN ({m.group(2)})'
    e = e.replace('<>', '!=')            # PG renders != as <>
    e = re.sub(r'::[a-zA-Z_][a-zA-Z0-9_]*', '', e)   # drop ::text casts
    e = e.replace("'", '')               # drop string-literal quotes
    e = _strip_outer_parens(e)
    e = re.sub(r'\s*,\s*', ',', e)       # remove spaces around commas
    e = re.sub(r'\(\s*', '(', e)         # remove space after (
    e = re.sub(r'\s*\)', ')', e)         # remove space before )
    e = _norm_ws(e).lower()
    return e


def _extract_check_exprs(create_sql):
    """Pull every CHECK(...) expression out of a CREATE TABLE statement,
    handling nested parentheses."""
    exprs = []
    i = 0
    s = create_sql
    while True:
        j = s.find('CHECK', i)
        if j == -1:
            break
        k = j + len('CHECK')
        while k < len(s) and s[k] in ' \t':
            k += 1
        if k >= len(s) or s[k] != '(':
            i = j + 1
            continue
        # balanced-paren scan from k
        depth = 0
        end = k
        for p in range(k, len(s)):
            if s[p] == '(':
                depth += 1
            elif s[p] == ')':
                depth -= 1
                if depth == 0:
                    end = p
                    break
        exprs.append(s[k + 1:end])
        i = end + 1
    return exprs


def _extract_index_cols(index_sql):
    """Return [(col, desc_bool), ...] from a CREATE [UNIQUE] INDEX ... sql.

    The column list is the first parenthesized group (its opener is the first
    '(' in the statement); nested parens (e.g. lower(...)) are kept intact by
    matching the balanced close."""
    open_i = index_sql.find('(')
    if open_i == -1:
        return []
    depth = 0
    close_i = -1
    for p in range(open_i, len(index_sql)):
        ch = index_sql[p]
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                close_i = p
                break
    if close_i == -1:
        return []
    inner = index_sql[open_i + 1:close_i]
    cols = []
    depth = 0
    buf = ''
    for ch in inner:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            cols.append(buf)
            buf = ''
        else:
            buf += ch
    if buf.strip():
        cols.append(buf)
    out = []
    for c in cols:
        c = _norm_ws(c).lower()
        desc = bool(re.search(r'\bdesc\b', c))
        c = re.sub(r'\b(?:asc|desc)\b', '', c)
        c = _norm_ws(c)
        c = c.replace(' collate nocase', '')  # handled as lower() below
        out.append((c, desc))
    return out


# --- SQLite reference schema ------------------------------------------------

def sqlite_schema():
    from app.sqlite_migrations import run_sqlite_migrations

    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys = ON')
    run_sqlite_migrations(conn)

    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]

    schema = {'tables': set(tables), 'columns': {}, 'pks': {}, 'uniques': {},
              'fks': {}, 'checks': {}, 'indexes': {}}

    for t in tables:
        # columns, pk
        cols = conn.execute(f'PRAGMA table_info("{t}")').fetchall()
        # SQLite reports notnull=0 for INTEGER PRIMARY KEY columns even though
        # they are implicitly NOT NULL, so a column is nullable only when
        # notnull=0 AND it is not part of the primary key.
        schema['columns'][t] = [(c[1], (c[3] == 0) and (c[5] == 0), (c[2] or '').upper()) for c in cols]
        pk = sorted([c[1] for c in cols if c[5] > 0], key=lambda n: [c[5] for c in cols if c[1] == n][0])
        schema['pks'][t] = pk

        # foreign keys
        fks = []
        for fk in conn.execute(f'PRAGMA foreign_key_list("{t}")').fetchall():
            fks.append((fk[3], fk[2], fk[4], fk[6]))  # from, ref_table, ref_col, on_delete
        schema['fks'][t] = fks

        # unique constraints + check constraints from CREATE TABLE sql
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()
        create_sql = row[0] if row else ''
        schema['checks'][t] = [_norm_check(e) for e in _extract_check_exprs(create_sql)]

        # unique constraints via index_list (origin 'u')
        uniques = []
        for idx in conn.execute(f'PRAGMA index_list("{t}")').fetchall():
            seqno, name, unique, origin, partial = idx
            if origin == 'u' and unique:
                icols = [r[2] for r in conn.execute(f'PRAGMA index_info("{name}")').fetchall()]
                uniques.append(tuple(sorted(icols)))
        schema['uniques'][t] = uniques

    # named secondary indexes (idx_*)
    for name, sql in conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx\\_%' ESCAPE '\\' AND sql IS NOT NULL"):
        m = re.match(r'CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+(\S+)\s*\(', sql, re.I)
        if not m:
            continue
        table = m.group(2).strip('"')
        cols = _extract_index_cols(sql)
        # normalize the username index's COLLATE NOCASE to lower(username)
        if name == 'idx_users_username_unique':
            cols = [(f'lower({c[0]})', c[1]) if c[0] == 'username' else c for c in cols]
        schema['indexes'][name] = (table, cols, bool(m.group(1)))

    conn.close()
    return schema


# --- Postgres live schema ---------------------------------------------------

def pg_schema(conn):
    schema = {'tables': set(), 'columns': {}, 'pks': {}, 'uniques': {},
              'fks': {}, 'checks': {}, 'indexes': {}}
    cur = conn.cursor()

    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
    tables = sorted(r[0] for r in cur.fetchall())
    schema['tables'] = set(tables)

    for t in tables:
        cur.execute("""
            SELECT column_name, is_nullable, data_type
            FROM information_schema.columns
            WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position""", (t,))
        schema['columns'][t] = [(r[0], r[1] == 'YES', r[2]) for r in cur.fetchall()]

        cur.execute("""
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema
            WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema='public' AND tc.table_name=%s
            ORDER BY kcu.ordinal_position""", (t,))
        schema['pks'][t] = [r[0] for r in cur.fetchall()]

        cur.execute("""
            SELECT tc.constraint_name
            FROM information_schema.table_constraints tc
            WHERE tc.constraint_type='UNIQUE' AND tc.table_schema='public' AND tc.table_name=%s""", (t,))
        uniques = []
        for (cname,) in cur.fetchall():
            cur.execute("""
                SELECT column_name FROM information_schema.key_column_usage
                WHERE constraint_name=%s AND table_schema='public' ORDER BY ordinal_position""", (cname,))
            uniques.append(tuple(sorted(r[0] for r in cur.fetchall())))
        schema['uniques'][t] = uniques

        cur.execute("""
            SELECT kcu.column_name, ccu.table_name, ccu.column_name, rc.delete_rule
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
            JOIN information_schema.referential_constraints rc
              ON rc.constraint_name=tc.constraint_name AND rc.constraint_schema=tc.constraint_schema
            WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' AND tc.table_name=%s
            ORDER BY kcu.ordinal_position""", (t,))
        schema['fks'][t] = [(r[0], r[1], r[2], r[3]) for r in cur.fetchall()]

        cur.execute("""
            SELECT pg_get_constraintdef(oid) FROM pg_constraint
            WHERE contype='c' AND connamespace='public'::regnamespace
              AND conrelid=%s::regclass""", (t,))
        schema['checks'][t] = [_norm_check(r[0]) for r in cur.fetchall()]

    cur.execute("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx\\_%' ESCAPE '\\'")
    for name, indexdef in cur.fetchall():
        m = re.match(r'CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+\S+\s+USING\s+\S+\s*\(', indexdef, re.I)
        if not m:
            continue
        table = indexdef.split(' ON ')[1].split(' USING ')[0].split('.')[-1].strip()
        cols = _extract_index_cols(indexdef)
        schema['indexes'][name] = (table, cols, bool(m.group(1)))

    return schema


# --- comparison -------------------------------------------------------------

def _type_is_fk_or_id(table, col, sqlite_schema):
    fk_cols = {f[0] for f in sqlite_schema['fks'].get(table, [])}
    if col in fk_cols:
        return True
    pk = sqlite_schema['pks'].get(table, [])
    if col == 'id' and pk == ['id']:
        return True
    return False


def expected_pg_type(table, col, sqlite_type, is_id_or_fk):
    if is_id_or_fk or (table, col) in _ID_REF_NO_FK:
        return 'bigint'
    if sqlite_type == 'TIMESTAMP':
        return 'timestamptz'
    if (table, col) in {('communities', 'created_at'), ('community_members', 'joined_at')}:
        return 'timestamptz'
    if sqlite_type == 'TEXT':
        return 'text'
    if sqlite_type == 'INTEGER':
        return 'integer'
    return 'text'


_PG_TYPE_MAP = {
    'bigint': 'bigint', 'integer': 'integer', 'text': 'text',
    'timestamp with time zone': 'timestamptz',
}


def compare(sqlite, pg):
    lines = []
    intentional = []

    # 1. tables
    only_sqlite = sqlite['tables'] - pg['tables']
    only_pg = pg['tables'] - sqlite['tables']
    # schema_migrations exists on both sides (created by the runners); any
    # table only in sqlite would be a real gap.
    for t in sorted(only_sqlite):
        lines.append(f'TABLE missing in PG: {t}')
    for t in sorted(only_pg):
        lines.append(f'TABLE only in PG: {t}')

    # 2+3. columns (name + nullability) and types
    for t in sorted(sqlite['tables'] & pg['tables']):
        sq_cols = {c[0]: (c[1], c[2]) for c in sqlite['columns'][t]}
        pg_cols = {c[0]: (c[1], c[2]) for c in pg['columns'][t]}
        for name in sorted(sq_cols.keys() - pg_cols.keys()):
            lines.append(f'COLUMN {t}.{name}: in SQLite but missing in PG')
        for name in sorted(pg_cols.keys() - sq_cols.keys()):
            if t == 'community_members' and name == 'seq':
                intentional.append('community_members.seq (BIGINT IDENTITY UNIQUE) '
                                   'replaces SQLite rowid ordering; no SQLite counterpart')
            else:
                lines.append(f'COLUMN {t}.{name}: only in PG (unexplained)')
        for name in sorted(sq_cols.keys() & pg_cols.keys()):
            sq_null, sq_type = sq_cols[name]
            pg_null, pg_type = pg_cols[name]
            if sq_null != pg_null:
                lines.append(f'NULLABILITY {t}.{name}: sqlite={sq_null} pg={pg_null}')
            exp = expected_pg_type(t, name, sq_type, _type_is_fk_or_id(t, name, sqlite))
            actual = _PG_TYPE_MAP.get(pg_type)
            if actual != exp:
                lines.append(f'TYPE {t}.{name}: sqlite={sq_type} pg={pg_type} (expected {exp})')

    # 4. foreign keys
    for t in sorted(sqlite['tables'] & pg['tables']):
        sq_map = {f[0]: f for f in sqlite['fks'][t]}          # keyed by from-col
        pg_map = {f[0]: f for f in pg['fks'][t]}
        for col in sorted(sq_map.keys() - pg_map.keys()):
            lines.append(f'FK {t}.{col}: in SQLite but missing in PG')
        for col in sorted(pg_map.keys() - sq_map.keys()):
            lines.append(f'FK {t}.{col}: only in PG (unexplained)')
        for col in sorted(sq_map.keys() & pg_map.keys()):
            if sq_map[col] != pg_map[col]:
                lines.append(f'FK {t}.{col}: sqlite={sq_map[col]} pg={pg_map[col]}')

    # 5. CHECK constraints
    for t in sorted(sqlite['tables'] & pg['tables']):
        sq_checks = set(sqlite['checks'][t])
        pg_checks = set(pg['checks'][t])
        for c in sorted(sq_checks - pg_checks):
            lines.append(f'CHECK {t}: in SQLite but missing in PG: {c}')
        for c in sorted(pg_checks - sq_checks):
            lines.append(f'CHECK {t}: only in PG (unexplained): {c}')

    # 6. indexes (named idx_*)
    sq_idx = sqlite['indexes']
    pg_idx = pg['indexes']
    for name in sorted(sq_idx.keys() - pg_idx.keys()):
        lines.append(f'INDEX {name}: in SQLite but missing in PG')
    for name in sorted(pg_idx.keys() - sq_idx.keys()):
        lines.append(f'INDEX {name}: only in PG (unexplained)')
    for name in sorted(sq_idx.keys() & pg_idx.keys()):
        sq_tbl, sq_cols, sq_uni = sq_idx[name]
        pg_tbl, pg_cols, pg_uni = pg_idx[name]
        if sq_tbl != pg_tbl:
            lines.append(f'INDEX {name}: table sqlite={sq_tbl} pg={pg_tbl}')
        if sq_cols != pg_cols:
            lines.append(f'INDEX {name}: cols sqlite={sq_cols} pg={pg_cols}')
        if sq_uni != pg_uni:
            lines.append(f'INDEX {name}: unique sqlite={sq_uni} pg={pg_uni}')

    # unique constraints (excluding the seq extra column)
    for t in sorted(sqlite['tables'] & pg['tables']):
        sq_uniques = {u for u in sqlite['uniques'][t]}
        pg_uniques = {u for u in pg['uniques'][t] if u != ('seq',)}
        for u in sorted(sq_uniques - pg_uniques):
            lines.append(f'UNIQUE {t}: in SQLite but missing in PG: {u}')
        for u in sorted(pg_uniques - sq_uniques):
            lines.append(f'UNIQUE {t}: only in PG (unexplained): {u}')

    return lines, intentional


def main():
    if not os.environ.get('DATABASE_URL'):
        print('DATABASE_URL is not set; run via `source scripts/pg_test_env.sh` first', file=sys.stderr)
        sys.exit(2)

    sqlite = sqlite_schema()
    import psycopg
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        pg = pg_schema(conn)

    lines, intentional = compare(sqlite, pg)

    out = []
    out.append('=== Beebo SQLite -> PostgreSQL schema comparison ===')
    out.append('')
    out.append('Intentional differences (explained):')
    if intentional:
        for i in intentional:
            out.append(f'  - {i}')
    out.append('  - id columns: INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED BY DEFAULT AS IDENTITY')
    out.append('  - FK columns: INTEGER -> BIGINT')
    out.append('  - TIMESTAMP DEFAULT CURRENT_TIMESTAMP -> TIMESTAMPTZ DEFAULT now()')
    out.append('  - communities.created_at / community_members.joined_at: TEXT (datetime(\'now\')) -> TIMESTAMPTZ NOT NULL DEFAULT now()')
    out.append('  - users.username: UNIQUE ... COLLATE NOCASE -> UNIQUE INDEX on lower(username)')
    out.append('  - schema_migrations.applied_at: TIMESTAMP -> timestamptz DEFAULT now()')
    out.append('')
    out.append(f'Unexplained differences: {len(lines)}')
    if lines:
        for l in lines:
            out.append(f'  {l}')
    else:
        out.append('  (none)')
    out.append('')

    text = '\n'.join(out) + '\n'
    out_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'pg_schema_diff.txt')
    with open(out_path, 'w') as f:
        f.write(text)
    print(text)
    print(f'wrote {out_path}')
    if lines:
        sys.exit(1)


if __name__ == '__main__':
    main()
