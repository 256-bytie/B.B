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


if __name__ == '__main__':
    unittest.main(verbosity=2)
