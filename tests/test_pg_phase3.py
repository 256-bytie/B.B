"""Phase 3 parity and concurrency checks, exclusively on a throwaway database."""
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from pg_support import require_test_database
require_test_database()
from app import create_app, db, chat_service, search_service, wallet
from app.serializers import timestamp_text, _iso_utc


def main():
    assert os.environ.get('BEEBO_TEST') == '1'
    assert db.get_db_name().startswith('beebo_test')
    db.init_db()
    url = os.environ['DATABASE_URL']
    with psycopg.connect(url) as connection:
        users = []
        for name in ['Phase3 Viewer', 'John']:
            users.append(connection.execute(
                'INSERT INTO users (full_name,email,password_hash,username) VALUES (%s,%s,%s,%s) RETURNING id',
                (name, name + '@phase3.test', 'unused', name.replace(' ', '_'))
            ).fetchone()[0])
        conversation, created = chat_service.get_or_create_conversation(connection.cursor(), *users)
        assert created
    with psycopg.connect(url) as connection:
        results = [search_service._search_people(connection.cursor(), term, users[0], 50)
                   for term in ['john', 'JOHN', 'John']]
        assert results[0] == results[1] == results[2] and results[0]
        assert connection.execute('SELECT %s ILIKE %s ESCAPE %s',
                                  ('test_data', 'test\\_data', '\\')).fetchone()[0]
    print('PASS: john/JOHN/John parity and bound ESCAPE')

    barrier = threading.Barrier(20)
    committed = []
    commit_lock = threading.Lock()

    class OrderedCommit:
        def __init__(self, connection):
            self.connection = connection

        def cursor(self):
            return self.connection.cursor()

        def rollback(self):
            self.connection.rollback()

        def commit(self):
            message_id = self.connection.execute(
                'SELECT max(id) FROM messages WHERE conversation_id=%s', (conversation,)
            ).fetchone()[0]
            with commit_lock:
                self.connection.commit()
                committed.append(message_id)

    def send(index):
        with psycopg.connect(url) as connection:
            barrier.wait(timeout=20)
            message, inserted = chat_service.send_message(
                OrderedCommit(connection), conversation, users[0], str(index), str(index))
            assert inserted
            return message['id']

    with ThreadPoolExecutor(max_workers=20) as executor:
        identifiers = list(executor.map(send, range(20)))
    assert len(set(identifiers)) == 20
    assert committed == sorted(identifiers), committed
    with psycopg.connect(url) as connection:
        assert connection.execute('SELECT last_message_id FROM conversation_state WHERE conversation_id=%s',
                                  (conversation,)).fetchone()[0] == max(identifiers)
    print('PASS: 20 parallel sends, ordered commits, unique ids, state=max(id)')

    barrier = threading.Barrier(10)

    def claim(index):
        with psycopg.connect(url) as connection:
            barrier.wait(timeout=20)
            try:
                wallet.claim_monthly_reward(connection, users[0])
                return True
            except wallet.AlreadyClaimedError:
                return False

    with ThreadPoolExecutor(max_workers=10) as executor:
        assert sum(executor.map(claim, range(10))) == 1
    with psycopg.connect(url) as connection:
        assert connection.execute('SELECT count(*) FROM credit_transactions WHERE user_id=%s',
                                  (users[0],)).fetchone()[0] == 1
    print('PASS: 10 parallel monthly claims, exactly one success and ledger row')
    january = datetime(2024, 1, 31, tzinfo=timezone.utc)
    assert wallet.add_one_month(january) == datetime(2024, 2, 29, tzinfo=timezone.utc)
    shifted = datetime(2024, 1, 1, 2, tzinfo=timezone(timedelta(hours=2)))
    assert timestamp_text(shifted) == '2024-01-01 00:00:00'
    assert _iso_utc(shifted) == '2024-01-01T00:00:00Z'
    client = create_app().test_client()
    with client.session_transaction() as session:
        session['user_id'] = users[0]
        session['csrf_token'] = 'phase3-token'
    created_post = client.post('/api/posts', json={'content': 'Phase3 timestamp check'},
                               headers={'X-CSRF-Token': 'phase3-token'})
    assert created_post.status_code == 201, created_post.get_json()
    feed = client.get('/api/posts')
    response = client.get('/api/wallet')
    assert feed.status_code == response.status_code == 200
    post = next(post for post in feed.get_json()['posts'] if post['id'] == created_post.get_json()['id'])
    datetime.strptime(post['created_at'], '%Y-%m-%d %H:%M:%S')
    print('Feed spot check:', post)
    print('Wallet spot check:', response.get_json())


if __name__ == '__main__':
    main()
