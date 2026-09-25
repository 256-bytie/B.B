#!/usr/bin/env python3
"""Unit tests for app/wallet.py (ledger, monthly reward, pagination).

Runs against a throwaway temporary database - never beebo.db - and needs
no running server:  python3 test_wallet_logic.py
"""
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import datetime

_TMP = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
_TMP.close()
os.environ['DB_PATH'] = _TMP.name  # must be set before importing app.db

from app.db import init_db, get_db  # noqa: E402
from app import wallet  # noqa: E402


def dt(y, m, d, hh=10, mm=0, ss=0):
    return datetime(y, m, d, hh, mm, ss)


class WalletLogicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.conn = get_db()
        self.conn.execute('DELETE FROM credit_transactions')
        self.conn.execute('DELETE FROM users')
        self.conn.execute("INSERT INTO users (id, full_name, email, password_hash, username) VALUES (1,'A','a@x.com','x','a')")
        self.conn.execute("INSERT INTO users (id, full_name, email, password_hash, username) VALUES (2,'B','b@x.com','x','b')")
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    # ---- balance ----
    def test_new_user_balance_is_zero(self):
        self.assertEqual(wallet.get_balance(self.conn, 1), 0)

    def test_balance_is_sum_of_ledger_and_per_user(self):
        wallet.record_transaction(self.conn, 1, 200, 'top_up', 'top_up', 'Purchased 200 credits')
        wallet.record_transaction(self.conn, 1, -10, 'usage', 'post', 'Created a post')
        wallet.record_transaction(self.conn, 2, 5, 'free', 'monthly_reward', 'x')
        self.conn.commit()
        self.assertEqual(wallet.get_balance(self.conn, 1), 190)
        self.assertEqual(wallet.get_balance(self.conn, 2), 5)

    def test_overdraft_refused_and_zero_amount_rejected(self):
        wallet.record_transaction(self.conn, 1, 5, 'free', 'monthly_reward', 'x')
        with self.assertRaises(wallet.InsufficientCreditsError):
            wallet.record_transaction(self.conn, 1, -6, 'usage', 'post', 'x')
        wallet.record_transaction(self.conn, 1, -5, 'usage', 'post', 'x')  # exactly to zero is fine
        self.assertEqual(wallet.get_balance(self.conn, 1), 0)
        with self.assertRaises(ValueError):
            wallet.record_transaction(self.conn, 1, 0, 'usage', 'post', 'x')

    def test_schema_rejects_bad_kind(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(
                "INSERT INTO credit_transactions (user_id, amount, kind, reason, description) VALUES (1, 5, 'bogus', 'r', 'd')")

    # ---- monthly reward ----
    def test_first_claim_available_immediately_then_locked(self):
        now = dt(2026, 9, 20)
        st = wallet.get_monthly_reward_status(self.conn, 1, now)
        self.assertTrue(st['claimable'])
        self.assertIsNone(st['next_claim_at'])
        self.assertEqual(st['amount'], 50)

        tx_id = wallet.claim_monthly_reward(self.conn, 1, now)
        row = wallet.get_transaction(self.conn, 1, tx_id)
        self.assertEqual((row[1], row[2], row[3]), (50, 'free', 'monthly_reward'))
        self.assertEqual(wallet.get_balance(self.conn, 1), 50)

        st = wallet.get_monthly_reward_status(self.conn, 1, now)
        self.assertFalse(st['claimable'])
        self.assertEqual(st['next_claim_at'], dt(2026, 10, 20))
        self.assertEqual(st['last_claimed_at'], now)

    def test_second_claim_same_period_refused_and_balance_unchanged(self):
        now = dt(2026, 9, 20)
        wallet.claim_monthly_reward(self.conn, 1, now)
        with self.assertRaises(wallet.AlreadyClaimedError) as ctx:
            wallet.claim_monthly_reward(self.conn, 1, dt(2026, 10, 19, 23, 59, 59))
        self.assertEqual(ctx.exception.next_claim_at, dt(2026, 10, 20))
        self.assertEqual(wallet.get_balance(self.conn, 1), 50)

    def test_claim_unlocks_exactly_one_month_later(self):
        wallet.claim_monthly_reward(self.conn, 1, dt(2026, 9, 20))
        wallet.claim_monthly_reward(self.conn, 1, dt(2026, 10, 20))
        self.assertEqual(wallet.get_balance(self.conn, 1), 100)

    def test_month_end_clamping_and_year_rollover(self):
        self.assertEqual(wallet.add_one_month(dt(2026, 1, 31)), dt(2026, 2, 28))
        self.assertEqual(wallet.add_one_month(dt(2028, 1, 31)), dt(2028, 2, 29))
        self.assertEqual(wallet.add_one_month(dt(2026, 12, 15)), dt(2027, 1, 15))
        self.assertEqual(wallet.add_one_month(dt(2026, 3, 31)), dt(2026, 4, 30))

    def test_claims_are_per_user(self):
        now = dt(2026, 9, 20)
        wallet.claim_monthly_reward(self.conn, 1, now)
        self.assertTrue(wallet.get_monthly_reward_status(self.conn, 2, now)['claimable'])
        wallet.claim_monthly_reward(self.conn, 2, now)
        self.assertEqual(wallet.get_balance(self.conn, 2), 50)

    def test_concurrent_claims_grant_exactly_once(self):
        now = dt(2026, 9, 20)
        results = []

        def attempt():
            conn = get_db()
            conn.execute('PRAGMA busy_timeout = 10000')
            try:
                wallet.claim_monthly_reward(conn, 1, now)
                results.append('ok')
            except wallet.AlreadyClaimedError:
                results.append('refused')
            finally:
                conn.close()

        threads = [threading.Thread(target=attempt) for _ in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(results.count('ok'), 1, results)
        self.assertEqual(results.count('refused'), 7, results)
        self.assertEqual(wallet.get_balance(self.conn, 1), 50)

    # ---- history / pagination ----
    def test_history_newest_first_with_keyset_pagination(self):
        for i in range(1, 8):
            wallet.record_transaction(self.conn, 1, i, 'free', 'monthly_reward', f'#{i}')
        wallet.record_transaction(self.conn, 2, 99, 'free', 'monthly_reward', 'other user')
        self.conn.commit()

        page1, cur1 = wallet.list_transactions(self.conn, 1, limit=3)
        self.assertEqual([r[4] for r in page1], ['#7', '#6', '#5'])
        self.assertIsNotNone(cur1)
        page2, cur2 = wallet.list_transactions(self.conn, 1, limit=3, before_id=cur1)
        self.assertEqual([r[4] for r in page2], ['#4', '#3', '#2'])
        page3, cur3 = wallet.list_transactions(self.conn, 1, limit=3, before_id=cur2)
        self.assertEqual([r[4] for r in page3], ['#1'])
        self.assertIsNone(cur3)

    def test_exact_page_boundary_has_no_phantom_next_page(self):
        for i in range(3):
            wallet.record_transaction(self.conn, 1, 1, 'free', 'monthly_reward', str(i))
        rows, cur = wallet.list_transactions(self.conn, 1, limit=3)
        self.assertEqual(len(rows), 3)
        self.assertIsNone(cur)

    def test_limit_is_clamped(self):
        for i in range(60):
            wallet.record_transaction(self.conn, 1, 1, 'free', 'monthly_reward', str(i))
        self.conn.commit()
        rows, cur = wallet.list_transactions(self.conn, 1, limit=9999)
        self.assertEqual(len(rows), wallet.MAX_TX_LIMIT)
        self.assertIsNotNone(cur)
        rows, _ = wallet.list_transactions(self.conn, 1, limit=0)
        self.assertEqual(len(rows), 1)

    def test_empty_history(self):
        rows, cur = wallet.list_transactions(self.conn, 1)
        self.assertEqual(rows, [])
        self.assertIsNone(cur)


if __name__ == '__main__':
    try:
        result = unittest.main(exit=False, verbosity=2).result
    finally:
        os.unlink(_TMP.name)
    sys.exit(0 if result.wasSuccessful() else 1)
