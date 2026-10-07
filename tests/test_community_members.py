#!/usr/bin/env python3
"""Tests for GET /api/communities/<slug>/members.

Uses a temporary database and Flask test client; never touches beebo.db.
"""
import atexit
import os
import sys
import tempfile
import unittest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO_ROOT)
_TEMP_ROOT = tempfile.TemporaryDirectory(prefix='beebo-community-members-')
atexit.register(_TEMP_ROOT.cleanup)
os.environ['DB_PATH'] = os.path.join(_TEMP_ROOT.name, 'test.db')
os.environ['SECRET_KEY'] = 'community-members-test-key'
sys.dont_write_bytecode = True

from flask.sessions import SecureCookieSessionInterface  # noqa: E402
from app import create_app  # noqa: E402
from app.db import get_db, init_db  # noqa: E402


class CommunityMembersApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cwd = os.getcwd()
        os.chdir(_TEMP_ROOT.name)
        try:
            cls.app = create_app()
        finally:
            os.chdir(cwd)
        cls.app.config['TESTING'] = True
        # These tests exercise route behavior, not Flask-Session persistence.
        cls.app.session_interface = SecureCookieSessionInterface()

    def setUp(self):
        conn = get_db()
        conn.execute('DELETE FROM community_members')
        conn.execute('DELETE FROM communities')
        conn.execute('DELETE FROM users')
        for user_id in range(1, 7):
            conn.execute('''
                INSERT INTO users
                    (id, full_name, email, password_hash, profile_picture,
                     cover_image, username, bio)
                VALUES (?, ?, ?, 'test', ?, ?, ?, ?)
            ''', (
                user_id,
                f'User {user_id}',
                f'user{user_id}@example.com',
                f'/profile/{user_id}.png',
                f'/cover/{user_id}.png',
                f'user{user_id}',
                f'Bio {user_id}',
            ))
        conn.execute('''
            INSERT INTO communities (id, slug, name, description, topic, type, creator_id)
            VALUES (1, 'members-test', 'Members Test', 'Test community', 'discussion', 'public', 1)
        ''')
        conn.execute('''
            INSERT INTO community_members (community_id, user_id, role, joined_at)
            VALUES (1, 1, 'creator', '2026-01-01 00:00:00')
        ''')
        conn.commit()
        conn.close()

    def add_members(self, members):
        conn = get_db()
        conn.execute('DELETE FROM community_members WHERE community_id = 1')
        conn.executemany('''
            INSERT INTO community_members (community_id, user_id, role, joined_at)
            VALUES (1, ?, ?, ?)
        ''', members)
        conn.commit()
        conn.close()

    def get_members(self, viewer_id=None):
        client = self.app.test_client()
        if viewer_id is not None:
            with client.session_transaction() as flask_session:
                flask_session['user_id'] = viewer_id
        return client.get('/api/communities/members-test/members')

    def test_creator_only_response(self):
        response = self.get_members()
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['admin']['id'], 1)
        self.assertEqual(data['moderators'], [])
        self.assertEqual([user['id'] for user in data['all']], [1])
        self.assertEqual(
            set(data['admin']),
            {'id', 'full_name', 'handle', 'profile_picture', 'cover_image', 'username', 'bio'},
        )

    def test_member_viewer_is_first(self):
        self.add_members([
            (1, 'creator', '2026-01-01 00:00:00'),
            (2, 'member', '2026-01-02 00:00:00'),
        ])
        response = self.get_members(viewer_id=2)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['all'][0]['id'], 2)

    def test_logged_out_and_nonmember_start_with_a_community_member(self):
        self.add_members([
            (1, 'creator', '2026-01-01 00:00:00'),
            (2, 'member', '2026-01-02 00:00:00'),
            (3, 'member', '2026-01-03 00:00:00'),
            (4, 'member', '2026-01-04 00:00:00'),
            (5, 'member', '2026-01-05 00:00:00'),
        ])
        member_ids = {1, 2, 3, 4, 5}
        for viewer_id in (None, 6):
            response = self.get_members(viewer_id=viewer_id)
            self.assertEqual(response.status_code, 200)
            self.assertIn(response.get_json()['all'][0]['id'], member_ids)

    def test_six_members_get_viewer_then_newest_three_without_duplicates(self):
        members = [
            (1, 'creator', '2026-01-01 00:00:00'),
            (2, 'member', '2026-01-02 00:00:00'),
            (3, 'moderator', '2026-01-03 00:00:00'),
            (4, 'member', '2026-01-04 00:00:00'),
            (5, 'moderator', '2026-01-05 00:00:00'),
            (6, 'moderator', '2026-01-05 00:00:00'),
        ]
        self.add_members(members)
        response = self.get_members(viewer_id=3)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual([user['id'] for user in data['all']], [3, 6, 5, 4])
        self.assertEqual(len({user['id'] for user in data['all']}), 4)
        self.assertEqual([user['id'] for user in data['moderators']], [3, 5, 6])

    def test_private_community_is_hidden_from_nonmember(self):
        conn = get_db()
        conn.execute("UPDATE communities SET type = 'private' WHERE id = 1")
        conn.commit()
        conn.close()
        response = self.get_members(viewer_id=6)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json(), {'error': 'Community not found'})

    def get_all_members(self, query='', viewer_id=None):
        client = self.app.test_client()
        if viewer_id is not None:
            with client.session_transaction() as flask_session:
                flask_session['user_id'] = viewer_id
        return client.get('/api/communities/members-test/members/all' + query)

    def seed_full_roster(self):
        self.add_members([
            (1, 'creator', '2026-01-01 00:00:00'),
            (2, 'member', '2026-01-02 00:00:00'),
            (3, 'moderator', '2026-01-03 00:00:00'),
            (4, 'member', '2026-01-04 00:00:00'),
            (5, 'member', '2026-01-05 00:00:00'),
        ])

    def test_full_list_returns_everyone_viewer_first_then_newest(self):
        self.seed_full_roster()
        data = self.get_all_members(viewer_id=2).get_json()
        self.assertEqual([u['id'] for u in data['all']], [2, 5, 4, 3, 1])
        self.assertEqual(data['admin']['id'], 1)
        self.assertEqual([u['id'] for u in data['moderators']], [3])
        self.assertFalse(data['has_more'])

    def test_full_list_paginates_and_omits_sections_after_first_page(self):
        self.seed_full_roster()
        first = self.get_all_members('?limit=2&offset=0', viewer_id=2).get_json()
        self.assertEqual([u['id'] for u in first['all']], [2, 5])
        self.assertTrue(first['has_more'])
        second = self.get_all_members('?limit=2&offset=2', viewer_id=2).get_json()
        self.assertEqual([u['id'] for u in second['all']], [4, 3])
        self.assertTrue(second['has_more'])
        self.assertIsNone(second['admin'])
        self.assertEqual(second['moderators'], [])
        last = self.get_all_members('?limit=2&offset=4', viewer_id=2).get_json()
        self.assertEqual([u['id'] for u in last['all']], [1])
        self.assertFalse(last['has_more'])

    def test_full_list_search_filters_by_name_or_username(self):
        self.seed_full_roster()
        data = self.get_all_members('?q=USER 4').get_json()
        self.assertEqual([u['id'] for u in data['all']], [4])
        self.assertIsNone(data['admin'])
        self.assertEqual(data['moderators'], [])
        data = self.get_all_members('?q=user3').get_json()
        self.assertEqual([u['id'] for u in data['moderators']], [3])
        self.assertEqual(self.get_all_members('?q=%25').get_json()['all'], [])

    def test_full_list_private_community_hidden_from_nonmember(self):
        conn = get_db()
        conn.execute("UPDATE communities SET type = 'private' WHERE id = 1")
        conn.commit()
        conn.close()
        self.assertEqual(self.get_all_members(viewer_id=6).status_code, 404)

    def put_notifications(self, level, viewer_id=None):
        client = self.app.test_client()
        with client.session_transaction() as flask_session:
            flask_session['csrf_token'] = 'test-token'
            if viewer_id is not None:
                flask_session['user_id'] = viewer_id
        return client, client.put('/api/communities/members-test/notifications', json={'level': level},
                                  headers={'X-CSRF-Token': 'test-token'})

    def test_notification_level_defaults_to_off_and_is_saved_per_member(self):
        self.add_members([(1, 'creator', '2026-01-01 00:00:00'), (2, 'member', '2026-01-02 00:00:00')])
        client, res = self.put_notifications('popular', viewer_id=2)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()['notification_level'], 'popular')
        self.assertEqual(client.get('/api/communities/members-test').get_json()['membership']['notification_level'], 'popular')
        creator = self.app.test_client()
        with creator.session_transaction() as flask_session:
            flask_session['user_id'] = 1
        self.assertEqual(creator.get('/api/communities/members-test').get_json()['membership']['notification_level'], 'off')

    def test_notification_level_rejects_invalid_nonmember_and_logged_out(self):
        self.add_members([(2, 'member', '2026-01-02 00:00:00')])
        self.assertEqual(self.put_notifications('loud', viewer_id=2)[1].status_code, 400)
        self.assertEqual(self.put_notifications('all', viewer_id=6)[1].status_code, 403)
        self.assertEqual(self.put_notifications('all')[1].status_code, 401)
        logged_out = self.app.test_client().get('/api/communities/members-test').get_json()
        self.assertIsNone(logged_out['membership']['notification_level'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
