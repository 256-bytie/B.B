Work in this repo's `app.py` and the existing `test_*.sh` scripts only. Do not touch `beebo.html`.

## Context

`app.py` currently hardcodes `DB_PATH = 'beebo.db'`. Every test script (`test_comments.sh`, `test_comments2.sh`, `test_follows.sh`) runs curl against a live `localhost:5050` server, which reads/writes that same file. There is no test/production separation. During the last backend session, running the test suite reset `beebo.db` to a fresh schema and wiped 7 real user accounts down to the 2 accounts the tests created. That data loss is being recovered separately — this task is to make sure it can't happen again.

## Task 1 — Make DB_PATH configurable

Change:
```python
DB_PATH = 'beebo.db'
```
to:
```python
DB_PATH = os.environ.get('DB_PATH', 'beebo.db')
```
`os` is already imported. Default stays `'beebo.db'` so normal (non-test) runs are unaffected.

## Task 2 — Print which database is in use on startup

Right after the `DB_PATH` line (or wherever `init_db()` is called at module load), add a startup print so it's impossible to miss which file the running server is pointed at, e.g.:
```python
print(f"[beebo] Using database: {DB_PATH}")
```
This should show up in the terminal every time `python app.py` runs, before any requests are handled. Anyone starting the server — human or agent — sees immediately whether they're on `beebo.db` or a test file.

## Task 3 — Update the test workflow to never touch the production DB

Add a short `TESTING.md` (or a clearly marked section at the top of `CLAUDE.md` if one already covers testing — check first, don't duplicate) documenting the required workflow:

```
# Run the server against an isolated test database - never the real one
DB_PATH=beebo_test.db python app.py &

# In another terminal, run the test suite
./test_comments.sh
./test_comments2.sh
./test_follows.sh

# Clean up the test db when done (safe to delete - it's not beebo.db)
rm -f beebo_test.db
```

Make it explicit in that doc: `beebo.db` is production data and must never be the target of a test run. `beebo_test.db` (or any name other than `beebo.db`) is always safe to delete/reset.

## Task 4 — Add a guard comment at the top of each test script

At the top of `test_comments.sh`, `test_comments2.sh`, and `test_follows.sh`, add a comment block (don't change any test logic):
```bash
# These tests hit whatever server is running on localhost:5050.
# Before running: start the server with DB_PATH=beebo_test.db (see TESTING.md).
# Running these against a server started without DB_PATH set will write
# test data into the real beebo.db.
```

## Constraints

- Don't change any existing route logic, response shapes, or test assertions.
- Don't rename `DB_PATH` or change its default value — only make it overridable.
- Don't delete or modify `beebo.db` or `beebo_test.db` as part of this task.
- Confirm the fix works: start the server with `DB_PATH=beebo_test.db python app.py`, confirm the startup print shows `beebo_test.db`, run one of the existing test scripts, then confirm via a direct sqlite check that `beebo.db`'s row counts and `sqlite_sequence` values are completely unchanged before/after.

Report back what changed per task, plus the before/after row counts proving `beebo.db` was untouched by the test run.
