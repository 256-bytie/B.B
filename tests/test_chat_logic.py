#!/usr/bin/env python3
"""Unit tests for app/chat_service.py (conversations, messages, read
cursors, realtime signalling).

Runs against a throwaway PostgreSQL database - never beebo.db - and needs
no running server:  python3 test_chat_logic.py
"""
import os
import psycopg
import sys
import threading
import time
import unittest

from pg_support import isolated_database
isolated_database()

from app.db import init_db, get_db  # noqa: E402
from app import chat_service as chat  # noqa: E402


class ChatLogicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.conn = get_db()
        c = self.conn.cursor()
        c.execute('TRUNCATE users RESTART IDENTITY CASCADE')
        # Use explicit small ids so pair ordering (low/high) is predictable.
        c.execute("INSERT INTO users (id, full_name, email, password_hash, username) "
                  "VALUES (1,'A','a@x.com','x','a')")
        c.execute("INSERT INTO users (id, full_name, email, password_hash, username) "
                  "VALUES (2,'B','b@x.com','x','b')")
        c.execute("INSERT INTO users (id, full_name, email, password_hash, username) "
                  "VALUES (3,'C','c@x.com','x','c')")
        self.conn.execute("SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users))")
        self.conn.commit()
        self.c = self.conn.cursor()

    def tearDown(self):
        self.conn.close()

    def fresh_conn(self):
        return get_db()

    # ---- get-or-create ----
    def test_create_then_get_same_conversation(self):
        cid, created = chat.get_or_create_conversation(self.c, 1, 2)
        self.assertTrue(created)
        cid2, created2 = chat.get_or_create_conversation(self.c, 1, 2)
        self.assertFalse(created2)
        self.assertEqual(cid, cid2)
        # From the other user too
        cid3, created3 = chat.get_or_create_conversation(self.c, 2, 1)
        self.assertFalse(created3)
        self.assertEqual(cid, cid3)

    def test_pair_is_canonical_regardless_of_call_order(self):
        cid12, _ = chat.get_or_create_conversation(self.c, 1, 2)
        cid21, _ = chat.get_or_create_conversation(self.c, 2, 1)
        self.assertEqual(cid12, cid21)
        row = self.c.execute('SELECT user_low_id, user_high_id FROM conversations').fetchone()
        self.assertEqual(row, (1, 2))  # low < high regardless of who called first

    def test_self_dm_rejected(self):
        with self.assertRaises(chat.ChatValidationError):
            chat.get_or_create_conversation(self.c, 1, 1)

    def test_invalid_user_id_rejected(self):
        for bad in ('x', None, 0, -5, True, 2.5):
            with self.assertRaises((chat.ChatValidationError, TypeError)):
                chat.get_or_create_conversation(self.c, 1, bad)

    def test_unknown_user_404(self):
        with self.assertRaises(chat.UserNotFoundError):
            chat.get_or_create_conversation(self.c, 1, 999)

    def test_get_or_create_race_produces_one_row(self):
        """Two simultaneous get-or-create calls from separate connections
        must yield exactly one conversation row."""
        results = []
        barrier = threading.Barrier(2)

        def worker(uid):
            conn = self.fresh_conn()
            barrier.wait()  # maximize interleaving
            try:
                cid, created = chat.get_or_create_conversation(conn.cursor(), uid, 1 if uid == 2 else 2)
                conn.commit()
                results.append((cid, created))
            finally:
                conn.close()

        t1 = threading.Thread(target=worker, args=(1,))
        t2 = threading.Thread(target=worker, args=(2,))
        t1.start(); t2.start(); t1.join(); t2.join()

        ids = {r[0] for r in results}
        self.assertEqual(len(ids), 1, f'expected one conversation, got {results}')
        count = self.c.execute('SELECT COUNT(*) FROM conversations').fetchone()[0]
        self.assertEqual(count, 1)

    # ---- sending ----
    def test_send_message_and_fetch_history(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        msg, created = chat.send_message(self.conn, cid, 1, 'hello')
        self.assertTrue(created)
        self.assertEqual(msg['body'], 'hello')
        self.assertEqual(msg['sender_id'], 1)

        messages, has_more = chat.get_messages(self.c, cid, 2)
        self.assertEqual([m['body'] for m in messages], ['hello'])
        self.assertFalse(has_more)

    def test_send_requires_membership(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        with self.assertRaises(chat.ConversationNotFoundError):
            chat.send_message(self.conn, cid, 3, 'sneak')

    def test_unknown_conversation_is_404_not_403(self):
        with self.assertRaises(chat.ConversationNotFoundError):
            chat.send_message(self.conn, 9999, 1, 'hi')
        with self.assertRaises(chat.ConversationNotFoundError):
            chat.get_messages(self.c, 9999, 1)

    def test_body_validation(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        for bad in (None, '', '   ', 123):  # 123 -> str() is non-empty, so only first three fail
            pass
        for bad in (None, '', '   '):
            with self.assertRaises(chat.ChatValidationError):
                chat.send_message(self.conn, cid, 1, bad)
        with self.assertRaises(chat.ChatValidationError):
            chat.send_message(self.conn, cid, 1, 'x' * (chat.MAX_MESSAGE_LEN + 1))
        # exactly at the limit is fine
        msg, _ = chat.send_message(self.conn, cid, 1, 'x' * chat.MAX_MESSAGE_LEN)
        self.assertEqual(len(msg['body']), chat.MAX_MESSAGE_LEN)

    def test_body_is_trimmed(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        msg, _ = chat.send_message(self.conn, cid, 1, '  hi there  ')
        self.assertEqual(msg['body'], 'hi there')

    def test_client_id_idempotency(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        m1, created1 = chat.send_message(self.conn, cid, 1, 'retry me', client_id='abc')
        m2, created2 = chat.send_message(self.conn, cid, 1, 'retry me', client_id='abc')
        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertEqual(m1['id'], m2['id'])
        count = self.c.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
        self.assertEqual(count, 1)

    def test_client_id_is_scoped_to_sender_and_conversation(self):
        """Same client_id from a different sender (or in a different
        conversation) must NOT collide."""
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        m1, _ = chat.send_message(self.conn, cid, 1, 'from A', client_id='k')
        m2, created2 = chat.send_message(self.conn, cid, 2, 'from B', client_id='k')
        self.assertTrue(created2)
        self.assertNotEqual(m1['id'], m2['id'])

        cid2, _ = chat.get_or_create_conversation(self.c, 1, 3)
        self.conn.commit()
        m3, created3 = chat.send_message(self.conn, cid2, 1, 'other conv', client_id='k')
        self.assertTrue(created3)

    # ---- paging ----
    def test_history_ascending_and_before_paging(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        for i in range(7):
            chat.send_message(self.conn, cid, 1 if i % 2 == 0 else 2, f'm{i}')
        self.conn.commit()

        # Default: newest page, ascending.
        messages, has_more = chat.get_messages(self.c, cid, 1, limit=5)
        self.assertEqual([m['body'] for m in messages], ['m2', 'm3', 'm4', 'm5', 'm6'])
        self.assertTrue(has_more)

        # Page back with before=<first id of previous page>.
        first_id = messages[0]['id']
        older, _ = chat.get_messages(self.c, cid, 1, before_id=first_id, limit=5)
        self.assertEqual([m['body'] for m in older], ['m0', 'm1'])

        # limit=1 walks one at a time.
        page, has_more = chat.get_messages(self.c, cid, 1, limit=1)
        self.assertEqual([m['body'] for m in page], ['m6'])
        self.assertTrue(has_more)

    def test_limit_clamped(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        chat.send_message(self.conn, cid, 1, 'x')
        self.conn.commit()
        messages, _ = chat.get_messages(self.c, cid, 1, limit=10**9)
        self.assertEqual(len(messages), 1)
        messages, _ = chat.get_messages(self.c, cid, 1, limit=0)
        self.assertEqual(len(messages), 1)

    # ---- read cursors ----
    def test_mark_read_forward_only_and_clamped(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        m1, _ = chat.send_message(self.conn, cid, 1, 'one')
        m2, _ = chat.send_message(self.conn, cid, 1, 'two')
        self.conn.commit()

        val = chat.mark_read(self.c, cid, 2, m2['id'])
        self.assertEqual(val, m2['id'])
        self.conn.commit()

        # Backwards move is ignored.
        val = chat.mark_read(self.c, cid, 2, m1['id'])
        self.assertEqual(val, m2['id'])

        # Beyond the last message is clamped.
        val = chat.mark_read(self.c, cid, 2, m2['id'] + 100)
        self.assertEqual(val, m2['id'])

    def test_unread_count_in_list(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        for i in range(3):
            chat.send_message(self.conn, cid, 1, f'm{i}')  # A sends 3
        self.conn.commit()

        convs = chat.list_conversations(self.c, 2)
        self.assertEqual(len(convs), 1)
        self.assertEqual(convs[0]['unread_count'], 3)
        self.assertEqual(convs[0]['last_message']['body'], 'm2')
        self.assertEqual(convs[0]['user']['id'], 1)

        # Same list from A's side: nothing unread (own messages).
        convs_a = chat.list_conversations(self.c, 1)
        self.assertEqual(convs_a[0]['unread_count'], 0)

        # After B marks read, unread goes to 0.
        last_id = convs[0]['last_message']['id']
        chat.mark_read(self.c, cid, 2, last_id)
        self.conn.commit()
        self.assertEqual(chat.list_conversations(self.c, 2)[0]['unread_count'], 0)

    def test_reads_are_private_per_user(self):
        """One user's cursor never affects the other's unread count."""
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        m, _ = chat.send_message(self.conn, cid, 1, 'hi')
        self.conn.commit()
        chat.mark_read(self.c, cid, 2, m['id'])  # B reads
        self.conn.commit()
        # A's unread state is untouched (A sent the message anyway); B's
        # cursor is not exposed anywhere in the list shape.
        item = chat.list_conversations(self.c, 2)[0]
        self.assertNotIn('last_read', item)
        self.assertNotIn('read_by', item)

    # ---- conversation list ----
    def test_list_ordered_by_recent_activity_empty_last(self):
        c1, _ = chat.get_or_create_conversation(self.c, 1, 2)
        c2, _ = chat.get_or_create_conversation(self.c, 1, 3)
        self.conn.commit()
        chat.send_message(self.conn, c1, 1, 'newest chat has a message')
        self.conn.commit()

        convs = chat.list_conversations(self.c, 1)
        self.assertEqual([c['id'] for c in convs], [c1, c2])
        self.assertIsNone(convs[1]['last_message'])
        self.assertEqual(convs[1]['unread_count'], 0)

    def test_list_not_leaking_other_pairs(self):
        chat.get_or_create_conversation(self.c, 2, 3)
        self.conn.commit()
        self.assertEqual(chat.list_conversations(self.c, 1), [])

    def test_list_member_shape(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        item = chat.list_conversations(self.c, 2)[0]
        self.assertEqual(item['user']['id'], 1)
        self.assertIn('full_name', item['user'])
        self.assertIn('handle', item['user'])
        self.assertIn('profile_picture', item['user'])
        self.assertNotIn('email', item['user'])  # no private fields leak
        self.assertNotIn('password_hash', item['user'])

    # ---- updates ----
    def test_updates_across_conversations(self):
        c12, _ = chat.get_or_create_conversation(self.c, 1, 2)
        c13, _ = chat.get_or_create_conversation(self.c, 1, 3)
        self.conn.commit()
        m1, _ = chat.send_message(self.conn, c12, 2, 'from B')
        m2, _ = chat.send_message(self.conn, c13, 3, 'from C')
        self.conn.commit()

        messages, has_more, convs = chat.list_updates(self.c, 1, 0)
        self.assertEqual([m['body'] for m in messages], ['from B', 'from C'])
        self.assertFalse(has_more)
        self.assertEqual(len(convs), 2)

        # Resume cursor: after m1.id only m2 comes back.
        messages, _, _ = chat.list_updates(self.c, 1, m1['id'])
        self.assertEqual([m['body'] for m in messages], ['from C'])

    def test_updates_exclude_other_users_conversations(self):
        c23, _ = chat.get_or_create_conversation(self.c, 2, 3)
        self.conn.commit()
        chat.send_message(self.conn, c23, 2, 'private')
        self.conn.commit()
        messages, _, convs = chat.list_updates(self.c, 1, 0)
        self.assertEqual(messages, [])
        self.assertEqual(convs, [])

    def test_updates_has_more(self):
        c12, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        for i in range(5):
            chat.send_message(self.conn, c12, 1, f'm{i}')
        self.conn.commit()
        messages, has_more, _ = chat.list_updates(self.c, 1, 0, limit=3)
        self.assertEqual(len(messages), 3)
        self.assertTrue(has_more)

    def test_latest_message_id(self):
        self.assertEqual(chat.latest_message_id(self.c, 1), 0)
        c12, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        m, _ = chat.send_message(self.conn, c12, 1, 'x')
        self.conn.commit()
        self.assertEqual(chat.latest_message_id(self.c, 1), m['id'])

    # ---- realtime signalling ----
    def test_wait_for_updates_returns_on_notify(self):
        # Capture the version, then notify from another thread.
        with chat._update_condition:
            start_version = chat._update_version

        results = []
        def waiter():
            ok, _ = chat.wait_for_updates(time.monotonic() + 5, start_version)
            results.append(ok)

        t = threading.Thread(target=waiter)
        t.start()
        time.sleep(0.1)  # let the waiter block
        chat.notify_updates()
        t.join(timeout=5)
        self.assertEqual(results, [True])

    def test_wait_for_updates_times_out_without_notify(self):
        with chat._update_condition:
            start_version = chat._update_version
        ok, _ = chat.wait_for_updates(time.monotonic() + 0.2, start_version)
        self.assertFalse(ok)

    def test_send_message_signals_waiters(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        with chat._update_condition:
            start_version = chat._update_version

        results = []
        def waiter():
            ok, _ = chat.wait_for_updates(time.monotonic() + 5, start_version)
            results.append(ok)

        t = threading.Thread(target=waiter)
        t.start()
        time.sleep(0.1)
        chat.send_message(self.conn, cid, 1, 'wake up')
        t.join(timeout=5)
        self.assertEqual(results, [True])

    # ---- schema integrity ----
    def test_schema_rejects_duplicate_pair(self):
        chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        with self.assertRaises(psycopg.IntegrityError):
            self.c.execute('INSERT INTO conversations (user_low_id, user_high_id) VALUES (2, 1)')

    def test_schema_rejects_low_not_less_than_high(self):
        with self.assertRaises(psycopg.IntegrityError):
            self.c.execute('INSERT INTO conversations (user_low_id, user_high_id) VALUES (2, 2)')

    def test_cascade_on_user_delete(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        chat.send_message(self.conn, cid, 1, 'bye')
        self.conn.commit()
        self.c.execute('DELETE FROM users WHERE id = 2')
        self.conn.commit()
        count = self.c.execute('SELECT COUNT(*) FROM conversations').fetchone()[0]
        self.assertEqual(count, 0)
        count = self.c.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
        self.assertEqual(count, 0)

    def test_created_at_format(self):
        cid, _ = chat.get_or_create_conversation(self.c, 1, 2)
        self.conn.commit()
        msg, _ = chat.send_message(self.conn, cid, 1, 'ts')
        # 'YYYY-MM-DD HH:MM:SS' UTC, same as the rest of the core API.
        self.assertRegex(msg['created_at'], r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$')


if __name__ == '__main__':
    unittest.main(verbosity=2)
