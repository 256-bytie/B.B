# Personal Courses Storage

Course folders and files are private to their owning user. Metadata lives in
PostgreSQL (`course_folders`, `course_files`) and blobs live below
`COURSE_FILES_ROOT/courses/<user_id>/` (default `./private_uploads`). Blob names
are random UUIDs; display names never become paths. Storage directories use
mode `0700`, and every blob operation checks that the resolved path remains
inside the configured root.

Uploads stream to a temporary file in the destination directory, validate both
extension and content, then use `os.replace`. The database transaction locks
the owning `users` row while checking the 500 MB quota and inserting metadata,
so concurrent requests cannot both pass near the limit. Failed inserts remove
the staged blob. Folder deletion commits cascading row deletion before
best-effort blob cleanup.

The API supports `pdf`, Office OLE and Open XML documents, UTF-8 `txt`/`md`,
and `jpg`/`jpeg`/`png`/`webp`. ZIP uploads are intentionally excluded because
their product and zip-bomb policy remains undecided. Office Open XML ZIPs are
not extracted and are capped at 4096 entries and 100 MB declared uncompressed
size.

The global Flask request limit is 50 MB including multipart framing, so the
effective maximum file size is slightly less than 50 MB even though the
service's raw-file limit is 50 MB. Course requests rejected by Flask receive a
JSON `413`.

Database backup scripts only run `pg_dump`; they do not include uploaded
blobs. Back up `private_uploads/` separately and consistently with the database
(for example, a filesystem snapshot taken alongside the database backup).

There is currently no account-deletion endpoint. Foreign-key cascades remove
course rows if a user is deleted directly, but a future account-deletion flow
must also remove `COURSE_FILES_ROOT/courses/<user_id>/` after the database
commit.
