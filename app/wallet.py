"""Credit wallet logic: balance, monthly free credits, and the ledger.

Deliberately Flask-free (plain sqlite3 connection in, plain values out) so
it can be exercised directly and reused by any route that later needs to
grant or spend credits - see app/routes/wallet.py for the HTTP layer.

Model
-----
The ledger (`credit_transactions`) is append-only and is the single source
of truth: a user's balance is the SUM of their rows, never a separately
stored counter, so the number on screen can't drift from the history
listed under it.

All timestamps are naive UTC, stored as 'YYYY-MM-DD HH:MM:SS' (the same
shape SQLite's CURRENT_TIMESTAMP produces). Callers may inject `now` to
make time-dependent behavior testable.
"""
import calendar
from datetime import datetime, timezone

MONTHLY_FREE_CREDITS = 50

# Ledger reasons / kinds written by this module.
REASON_MONTHLY_REWARD = 'monthly_reward'
KIND_FREE = 'free'
KIND_TOP_UP = 'top_up'
KIND_USAGE = 'usage'

DEFAULT_TX_LIMIT = 20
MAX_TX_LIMIT = 50

_DB_TS_FORMAT = '%Y-%m-%d %H:%M:%S'


class AlreadyClaimedError(Exception):
    """The monthly reward isn't claimable yet. `next_claim_at` is when it will be."""

    def __init__(self, next_claim_at):
        super().__init__('Monthly credits already claimed')
        self.next_claim_at = next_claim_at


class InsufficientCreditsError(Exception):
    """A spend would take the balance below zero."""


# ---- time helpers ----

def utcnow():
    """Current time as a naive UTC datetime."""
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def to_db_ts(dt):
    return dt.strftime(_DB_TS_FORMAT)


def from_db_ts(value):
    return datetime.strptime(value, _DB_TS_FORMAT)


def add_one_month(dt):
    """Same day next month, clamped to the target month's length (Jan 31 -> Feb 28/29)."""
    year = dt.year + (1 if dt.month == 12 else 0)
    month = 1 if dt.month == 12 else dt.month + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


# ---- ledger primitives ----

def get_balance(conn, user_id):
    row = conn.execute(
        'SELECT COALESCE(SUM(amount), 0) FROM credit_transactions WHERE user_id = ?',
        (user_id,)
    ).fetchone()
    return int(row[0])


def record_transaction(conn, user_id, amount, kind, reason, description, now=None):
    """Append one ledger entry and return its id. Does NOT commit.

    Spends (amount < 0) are refused if they would overdraw the balance.
    That check is only race-free when the caller already holds a write
    lock for the surrounding transaction (BEGIN IMMEDIATE), as
    claim_monthly_reward does.
    """
    if not isinstance(amount, int) or amount == 0:
        raise ValueError('amount must be a non-zero integer')
    if amount < 0 and get_balance(conn, user_id) + amount < 0:
        raise InsufficientCreditsError('Not enough credits')

    cursor = conn.execute(
        'INSERT INTO credit_transactions (user_id, amount, kind, reason, description, created_at) '
        'VALUES (?, ?, ?, ?, ?, ?)',
        (user_id, amount, kind, reason, description, to_db_ts(now or utcnow()))
    )
    return cursor.lastrowid


def get_transaction(conn, user_id, transaction_id):
    return conn.execute(
        'SELECT id, amount, kind, reason, description, created_at '
        'FROM credit_transactions WHERE id = ? AND user_id = ?',
        (transaction_id, user_id)
    ).fetchone()


def list_transactions(conn, user_id, limit=DEFAULT_TX_LIMIT, before_id=None):
    """Newest-first page of a user's ledger.

    Keyset-paginated on id (ids only ever increase, and entries are never
    backdated), same approach as the posts feed. Returns (rows, next_cursor)
    where next_cursor is the id to pass as `before_id` for the next page,
    or None when this page reached the end.
    """
    limit = max(1, min(int(limit), MAX_TX_LIMIT))
    params = [user_id]
    where = 'user_id = ?'
    if before_id is not None:
        where += ' AND id < ?'
        params.append(int(before_id))
    params.append(limit + 1)

    rows = conn.execute(
        'SELECT id, amount, kind, reason, description, created_at '
        f'FROM credit_transactions WHERE {where} ORDER BY id DESC LIMIT ?',
        params
    ).fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = rows[-1][0] if has_more else None
    return rows, next_cursor


# ---- monthly free credits ----

def get_monthly_reward_status(conn, user_id, now=None):
    """Whether the monthly reward can be claimed right now.

    One claim per month, measured from the user's last claim: a claim on
    Aug 15 unlocks the next on Sep 15. A user who has never claimed can
    claim immediately.

    Returns a dict of naive-UTC datetimes:
        {'amount', 'claimable', 'next_claim_at', 'last_claimed_at'}
    where next_claim_at is None whenever the reward is claimable now.
    """
    now = now or utcnow()
    row = conn.execute(
        'SELECT created_at FROM credit_transactions '
        'WHERE user_id = ? AND reason = ? ORDER BY id DESC LIMIT 1',
        (user_id, REASON_MONTHLY_REWARD)
    ).fetchone()

    if row is None:
        return {
            'amount': MONTHLY_FREE_CREDITS,
            'claimable': True,
            'next_claim_at': None,
            'last_claimed_at': None,
        }

    last_claimed_at = from_db_ts(row[0])
    next_claim_at = add_one_month(last_claimed_at)
    claimable = now >= next_claim_at
    return {
        'amount': MONTHLY_FREE_CREDITS,
        'claimable': claimable,
        'next_claim_at': None if claimable else next_claim_at,
        'last_claimed_at': last_claimed_at,
    }


def claim_monthly_reward(conn, user_id, now=None):
    """Grant the monthly free credits if they're claimable; return the new ledger row id.

    The eligibility check and the insert run inside one BEGIN IMMEDIATE
    transaction, so two simultaneous claims (double-tap, two tabs) can't
    both pass the check: the second waits for the first's commit, then
    sees the fresh entry and is refused. Raises AlreadyClaimedError.
    """
    now = now or utcnow()
    conn.execute('BEGIN IMMEDIATE')
    try:
        status = get_monthly_reward_status(conn, user_id, now)
        if not status['claimable']:
            conn.rollback()
            raise AlreadyClaimedError(status['next_claim_at'])

        transaction_id = record_transaction(
            conn,
            user_id,
            MONTHLY_FREE_CREDITS,
            KIND_FREE,
            REASON_MONTHLY_REWARD,
            f'Claimed {MONTHLY_FREE_CREDITS} free credits',
            now=now,
        )
        conn.commit()
        return transaction_id
    except AlreadyClaimedError:
        raise
    except Exception:
        conn.rollback()
        raise
