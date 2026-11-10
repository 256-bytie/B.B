#!/usr/bin/env python3
"""Unit tests for notification creation savepoint behavior."""
import logging
import unittest

from pg_support import isolated_database
isolated_database()

from app.db import get_db, init_db  # noqa: E402
from app import notification_service, wallet  # noqa: E402


class NotificationLogicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        logging.disable(logging.CRITICAL)

    @classmethod
    def tearDownClass(cls):
        logging.disable(logging.NOTSET)

    def setUp(self):
        self.conn = get_db()
        self.conn.execute('TRUNCATE users RESTART IDENTITY CASCADE')
        self.conn.execute("INSERT INTO users (id, full_name, email, password_hash, username) VALUES (1, 'A', 'a@x.com', 'x', 'a')")
        self.conn.execute("INSERT INTO users (id, full_name, email, password_hash, username) VALUES (2, 'B', 'b@x.com', 'x', 'b')")
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    def test_extract_mentions_normalizes_filters_and_caps(self):
        handles = notification_service.extract_mentions(
            'email a@b.com @Alice... (@alice), @Bob_1 @a.b '
            '@' + 'c' * 31 + ' @one @two @three @four @five @six @seven @eight @nine @ten @eleven'
        )
        self.assertEqual(
            handles,
            ['alice', 'bob_1', 'a.b', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'],
        )

    def test_resolve_mentions_returns_user_id_to_handle(self):
        self.conn.execute(
            "INSERT INTO users (id, full_name, email, password_hash, username) "
            "VALUES (3, 'Mixed', 'mixed@x.com', 'x', 'MiXeD_Name')"
        )
        self.conn.commit()
        resolved = notification_service.resolve_mentions(
            self.conn.cursor(), ['mixed_name', 'unknown']
        )
        self.assertEqual(resolved, {3: 'mixed_name'})

    def test_create_skips_self_and_duplicate(self):
        cursor = self.conn.cursor()
        self.assertFalse(notification_service.create(cursor, 1, 1, 'follow', 'user', 1, None))
        self.assertTrue(notification_service.create(cursor, 2, 1, 'follow', 'user', 2, None))
        self.assertFalse(notification_service.create(cursor, 2, 1, 'follow', 'user', 2, None))
        self.conn.commit()
        count = self.conn.execute('SELECT COUNT(*) FROM notifications').fetchone()[0]
        self.assertEqual(count, 1)

    def test_invalid_recipient_does_not_abort_outer_transaction(self):
        cursor = self.conn.cursor()
        self.assertFalse(notification_service.create(cursor, 999, 1, 'follow', 'user', 999, None))
        cursor.execute("UPDATE users SET bio = 'committed later' WHERE id = 1")
        self.conn.commit()
        bio = self.conn.execute('SELECT bio FROM users WHERE id = 1').fetchone()[0]
        self.assertEqual(bio, 'committed later')

    def test_null_target_type_is_visible(self):
        self.conn.execute('''
            INSERT INTO notifications
                (recipient_id, actor_id, type, target_type, target_id, post_id, dedupe_key)
            VALUES (2, 1, 'legacy', NULL, NULL, NULL, 'legacy:null')
        ''')
        self.conn.commit()

        wallet.claim_monthly_reward(self.conn, 2)
        items, next_cursor, count = notification_service.list_notifications(self.conn, 2)

        self.assertEqual([item['type'] for item in items], ['legacy'])
        self.assertIsNone(next_cursor)
        self.assertEqual(count, 1)

    def test_mark_read_expands_group_only_for_recipient(self):
        self.conn.execute("INSERT INTO users (id, full_name, email, password_hash, username) VALUES (3, 'C', 'c@x.com', 'x', 'c')")
        self.conn.execute("INSERT INTO posts (id, user_id, content) VALUES (1, 2, 'post')")
        rows = [
            (2, 1, 'post_like', 'post', 1, 1, 'post_like:1:post:1'),
            (2, 3, 'post_like', 'post', 1, 1, 'post_like:3:post:1'),
            (1, 3, 'post_like', 'post', 1, 1, 'post_like:3:post:1'),
        ]
        cursor = self.conn.cursor()
        cursor.executemany('''
            INSERT INTO notifications
                (recipient_id, actor_id, type, target_type, target_id, post_id, dedupe_key)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        ''', rows)
        self.conn.commit()
        selected_id = self.conn.execute('''
            SELECT id FROM notifications
            WHERE recipient_id = 2 AND actor_id = 3
        ''').fetchone()[0]

        count = notification_service.mark_read(self.conn, 2, ids=[selected_id])

        self.assertEqual(count, 0)
        recipient_two = self.conn.execute('''
            SELECT COUNT(*) FROM notifications
            WHERE recipient_id = 2 AND read_at IS NOT NULL
        ''').fetchone()[0]
        recipient_one = self.conn.execute('''
            SELECT COUNT(*) FROM notifications
            WHERE recipient_id = 1 AND read_at IS NOT NULL
        ''').fetchone()[0]
        self.assertEqual(recipient_two, 2)
        self.assertEqual(recipient_one, 0)


    def test_create_many_skips_actor_dedupes_and_reports_count(self):
        self.conn.execute("INSERT INTO users (id, full_name, email, password_hash, username) VALUES (3, 'C', 'c@x.com', 'x', 'c')")
        self.conn.commit()
        cursor = self.conn.cursor()
        inserted = notification_service.create_many(
            cursor, [1, 2, 3, 2], 1, 'community_post', 'post', 5, 5
        )
        self.conn.commit()
        self.assertEqual(inserted, 2)
        rows = self.conn.execute(
            'SELECT recipient_id, dedupe_key FROM notifications ORDER BY recipient_id'
        ).fetchall()
        self.assertEqual(rows, [(2, 'community_post:1:post:5'), (3, 'community_post:1:post:5')])
        again = notification_service.create_many(
            self.conn.cursor(), [2, 3], 1, 'community_post', 'post', 5, 5
        )
        self.conn.commit()
        self.assertEqual(again, 0)
        self.assertEqual(notification_service.create_many(self.conn.cursor(), [], 1, 'x', 'post', 1, 1), 0)
        self.assertEqual(notification_service.create_many(self.conn.cursor(), [1], 1, 'x', 'post', 1, 1), 0)

    def test_create_many_invalid_recipient_does_not_abort_outer_transaction(self):
        cursor = self.conn.cursor()
        inserted = notification_service.create_many(cursor, [999], 1, 'community_post', 'post', 5, 5)
        self.assertEqual(inserted, 0)
        cursor.execute("UPDATE users SET bio = 'after batch' WHERE id = 1")
        self.conn.commit()
        bio = self.conn.execute('SELECT bio FROM users WHERE id = 1').fetchone()[0]
        self.assertEqual(bio, 'after batch')

    def test_event_savepoint_swallows_failure_and_keeps_transaction(self):
        cursor = self.conn.cursor()
        with notification_service.event_savepoint(cursor):
            cursor.execute('SELECT 1 / 0')
        cursor.execute("UPDATE users SET bio = 'after event' WHERE id = 1")
        self.conn.commit()
        bio = self.conn.execute('SELECT bio FROM users WHERE id = 1').fetchone()[0]
        self.assertEqual(bio, 'after event')

    def test_create_system_inserts_null_fields_and_dedupes(self):
        cursor = self.conn.cursor()
        self.assertTrue(notification_service.create_system(cursor, 2, 'monthly_credits', 'monthly_credits:never'))
        self.assertFalse(notification_service.create_system(cursor, 2, 'monthly_credits', 'monthly_credits:never'))
        self.conn.commit()
        row = self.conn.execute(
            'SELECT actor_id, target_type, target_id, post_id, type FROM notifications WHERE recipient_id = 2'
        ).fetchall()
        self.assertEqual(row, [(None, None, None, None, 'monthly_credits')])

    def test_clear_system_deletes_only_that_users_rows_of_that_type(self):
        cursor = self.conn.cursor()
        notification_service.create_system(cursor, 1, 'monthly_credits', 'monthly_credits:never')
        notification_service.create_system(cursor, 2, 'monthly_credits', 'monthly_credits:never')
        notification_service.create_system(cursor, 2, 'other_system', 'other:1')
        notification_service.clear_system(cursor, 2, 'monthly_credits')
        self.conn.commit()
        rows = self.conn.execute(
            'SELECT recipient_id, type FROM notifications ORDER BY recipient_id, type'
        ).fetchall()
        self.assertEqual(rows, [(1, 'monthly_credits'), (2, 'other_system')])

    def test_ensure_monthly_credits_is_idempotent_and_respects_claims(self):
        def count():
            return self.conn.execute(
                "SELECT COUNT(*) FROM notifications WHERE recipient_id = 1 AND type = 'monthly_credits'"
            ).fetchone()[0]

        notification_service.ensure_monthly_credits(self.conn, 1)
        notification_service.ensure_monthly_credits(self.conn, 1)
        self.assertEqual(count(), 1)

        wallet.claim_monthly_reward(self.conn, 1)
        self.assertEqual(count(), 0)

        notification_service.ensure_monthly_credits(self.conn, 1)
        self.assertEqual(count(), 0)

        self.conn.execute(
            "UPDATE credit_transactions SET created_at = created_at - interval '31 days' "
            "WHERE user_id = 1 AND reason = 'monthly_reward'"
        )
        self.conn.commit()
        notification_service.ensure_monthly_credits(self.conn, 1)
        self.assertEqual(count(), 1)

    def test_ensure_monthly_credits_ignores_unknown_user(self):
        notification_service.ensure_monthly_credits(self.conn, 999)
        count = self.conn.execute('SELECT COUNT(*) FROM notifications').fetchone()[0]
        self.assertEqual(count, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
