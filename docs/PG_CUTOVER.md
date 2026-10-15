# PostgreSQL cutover

Do not cut over until rehearsal passes on an unmodified backup. The current
backup has enforced FK violations: stop, report the rows, and obtain an
explicitly approved data-resolution plan. The ETL never repairs or skips rows.

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
   python3 -B scripts/migrate_sqlite_to_pg.py "$backup" --dry-run
   python3 -B scripts/migrate_sqlite_to_pg.py "$backup"
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
