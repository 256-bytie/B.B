# PostgreSQL cutover

## Small-host suggestions (not applied)

For a 1 vCPU, 2 GB host shared by PostgreSQL and Flask, consider these starting
values, not automatic configuration changes:

```conf
shared_buffers = 256MB
effective_cache_size = 768MB
work_mem = 4MB
maintenance_work_mem = 64MB
max_connections = 30
```

Use `PG_POOL_MAX=8`, well below `max_connections`, leaving room for maintenance
and administrative connections. This is a per-process pool; retain the current
single-process deployment. `work_mem` is per query operation, not a global
budget; `effective_cache_size` is a planner estimate, not allocated memory.
Measure actual memory use before applying any settings.

## Backup rehearsal

With `DATABASE_URL` pointing only to a throwaway `beebo_test_*` database:

```bash
bash scripts/backup_pg.sh
bash scripts/restore_check.sh
```

These rehearsal tools refuse non-test source databases. Install matching
PostgreSQL client tools; local Docker rehearsals can instead set
`PG_TEST_CONTAINER=beebo-pg` (the connection settings must work inside it).
Dumps are custom format (`pg_dump -Fc`), mode 0600, timestamped in `backups/`;
only successful dumps enter retention, keeping the newest seven per source DB.
Restore checks use the latest dump for that source, compare every public table's
row count, and drop the generated `beebo_test_restore_*` database even on failure.
Keep the source quiescent from backup through comparison: live writes can cause
a legitimate count mismatch. Errors exit nonzero; counts alone do not verify
all data values. These scripts do not enable a production backup policy.

## Cutover procedure

Do not cut over until rehearsal passes on an unmodified backup. The current
backup has enforced FK violations: stop, report the rows, and obtain an
explicitly approved data-resolution plan. The ETL never repairs source data. With `--quarantine-orphans`, it writes excluded rows in full to `backups/quarantine_<timestamp>.json`, excludes their dependency closure, and repairs only surviving aggregate counters affected by those exclusions. Without the flag, orphaned source rows remain a refusal.

1. Stop the app using its deployment supervisor; keep it stopped through verification.
2. Take a consistent backup and record hashes (SQLite CLI required):
   ```bash
   backup="backups/cutover_$(date -u +%Y%m%dT%H%M%SZ).db"
   sqlite3 'file:beebo.db?mode=ro' ".backup '$backup'"
   sha256sum beebo.db "$backup" > "$backup.sha256"
   ```
3. Set `DATABASE_URL` securely to the intended, already-migrated empty database.
   Development rehearsals must use `beebo_test_*`. For production cutover only,
   explicitly add `--allow-nontest` to both commands:
   ```bash
   python3 -B scripts/migrate_sqlite_to_pg.py "$backup" --quarantine-orphans --dry-run
   python3 -B scripts/migrate_sqlite_to_pg.py "$backup" --quarantine-orphans
   sha256sum -c "$backup.sha256"
   ```
   `--truncate` explicitly replaces existing app data, without a typing prompt.
   Dry-run performs all checks and rolls back, including truncation and sequences.
4. Require every verification row to be PASS: all table counts, per-user balances,
   all counter columns, membership ordering, and rolled-back sequence inserts.
5. Start the PostgreSQL app with `DATABASE_URL` using the deployment supervisor
   (local entry point: `python3 -B app.py`). Check login, feed, wallet, post creation,
   likes/comments, communities, and messages.
6. Rollback: stop the app, retain PostgreSQL for investigation, verify the saved
   `beebo.db` hash, deploy `main`, unset `DATABASE_URL`, and restart with untouched
   `beebo.db`. Writes made after PostgreSQL startup are not in SQLite; reconcile
   them explicitly before accepting data loss. Never overwrite `beebo.db`.
