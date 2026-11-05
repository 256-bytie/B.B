#!/usr/bin/env python3
"""Unit tests for notification creation savepoint behavior."""
import logging
import unittest

from pg_support import isolated_database
isolated_database()

from app.db import get_db, init_db  # noqa: E402
from app import notification_service  # noqa: E402


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
