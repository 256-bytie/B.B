"""Database initialization and connection management."""
import sqlite3
import os

from app.migrations import run_migrations


def get_db_path():
    """Get the database path from environment or use default."""
    return os.environ.get('DB_PATH', 'beebo.db')


def get_db():
    """Get a database connection with foreign keys enabled."""
    conn = sqlite3.connect(get_db_path())
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_db():
    """Initialize the database with users table"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA foreign_keys = ON')
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            profile_picture TEXT,
            cover_image TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # Migration for databases created before profile_picture/cover_image existed.
    # CREATE TABLE IF NOT EXISTS above is a no-op on an existing table, so add
    # the columns here if they're missing. NULL means "no custom image set" —
    # the frontend falls back to the generated DiceBear avatar / default cover.
    cursor.execute("PRAGMA table_info(users)")
    existing_columns = {row[1] for row in cursor.fetchall()}
    if 'profile_picture' not in existing_columns:
        cursor.execute('ALTER TABLE users ADD COLUMN profile_picture TEXT')
    if 'cover_image' not in existing_columns:
        cursor.execute('ALTER TABLE users ADD COLUMN cover_image TEXT')
    if 'username' not in existing_columns:
        cursor.execute('ALTER TABLE users ADD COLUMN username TEXT')
    if 'bio' not in existing_columns:
        cursor.execute('ALTER TABLE users ADD COLUMN bio TEXT')
    conn.commit()

    # Backfill username for existing rows that have NULL
    cursor.execute('SELECT id, email, username FROM users WHERE username IS NULL')
    users_needing_username = cursor.fetchall()

    for user_id, email, _ in users_needing_username:
        # Start with email prefix
        base_username = email.split('@')[0]
        username = base_username

        # Check if this username is already taken (case-insensitive)
        cursor.execute('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?', (username, user_id))
        if cursor.fetchone():
            # Collision detected, append user_id to make it unique
            username = f"{base_username}{user_id}"

        cursor.execute('UPDATE users SET username = ? WHERE id = ?', (username, user_id))

    conn.commit()

    # Create unique index on username if it doesn't exist
    cursor.execute('''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique
        ON users(username COLLATE NOCASE)
    ''')
    conn.commit()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            audience TEXT DEFAULT 'Academic',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            comment_count INTEGER DEFAULT 0,
            like_count INTEGER DEFAULT 0,
            view_count INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS post_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL,
            image_path TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            like_count INTEGER DEFAULT 0,
            FOREIGN KEY (post_id) REFERENCES posts(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')

    # Migration: add parent_comment_id for threaded replies
    cursor.execute("PRAGMA table_info(comments)")
    comments_columns = {row[1] for row in cursor.fetchall()}
    if 'parent_comment_id' not in comments_columns:
        cursor.execute('''
            ALTER TABLE comments ADD COLUMN parent_comment_id INTEGER
            REFERENCES comments(id)
        ''')
    conn.commit()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS likes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            target_type TEXT NOT NULL CHECK(target_type IN ('post','comment')),
            target_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, target_type, target_id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS dislikes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            comment_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, comment_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (comment_id) REFERENCES comments(id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS follows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            follower_id INTEGER NOT NULL,
            followee_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(follower_id, followee_id),
            FOREIGN KEY (follower_id) REFERENCES users(id),
            FOREIGN KEY (followee_id) REFERENCES users(id)
        )
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id)
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS highlights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('photo','video')),
            media_url TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_highlights_user ON highlights(user_id)
    ''')

    # Additional indexes for performance
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at)
    ''')
    # Covers the user_id-filtered + keyset-cursor-paginated query path used
    # by GET /api/posts?user_id=... (profile screens), added in the
    # pagination phase (Phase 4 of the Option A migration plan).
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_posts_user_created
        ON posts(user_id, created_at DESC, id DESC)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_likes_user_id ON likes(user_id)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_dislikes_comment_id ON dislikes(comment_id)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_dislikes_user_id ON dislikes(user_id)
    ''')

    conn.commit()

    # Search history: per-user recent search terms (see app/routes/search.py).
    # Deliberately just (user_id, query) rather than also caching result
    # counts/type — history only ever needs to re-run the search, and
    # caching stale counts would just be another thing to invalidate.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS search_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            query TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_search_history_user
        ON search_history(user_id, created_at DESC)
    ''')
    conn.commit()

    # Library files table for document uploads
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS library_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            department TEXT,
            course TEXT,
            level TEXT,
            file_path TEXT NOT NULL,
            file_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('pending','approved','rejected')),
            download_count INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')

    # Indexes for library_files
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_library_files_department ON library_files(department)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_library_files_category ON library_files(category)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_library_files_created ON library_files(created_at)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_library_files_status ON library_files(status)
    ''')
    conn.commit()

    # Credit wallet ledger (see app/wallet.py). Append-only: a user's
    # balance is SUM(amount) over their rows, never a separately stored
    # number, so it can't drift from the history it's displayed next to.
    # `kind` drives the badge in the UI (top_up / usage / free); `reason`
    # identifies what produced the entry (top_up, monthly_reward, post,
    # comment, reply, ...). Positive amount = credits in, negative = spent.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS credit_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount INTEGER NOT NULL CHECK(amount != 0),
            kind TEXT NOT NULL CHECK(kind IN ('top_up','usage','free')),
            reason TEXT NOT NULL,
            description TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ''')
    # Serves both the balance SUM and the newest-first keyset pagination
    # of the history list; the (user_id, reason, id) index serves the
    # "when did this user last claim their monthly reward" lookup.
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_credit_tx_user
        ON credit_transactions(user_id, id DESC)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_credit_tx_user_reason
        ON credit_transactions(user_id, reason, id DESC)
    ''')

    conn.commit()

    # Future schema changes go in migrations/ (see app/migrations.py) as
    # numbered .sql files instead of more ALTER TABLE blocks above.
    run_migrations(conn)

    conn.close()
