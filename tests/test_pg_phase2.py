"""PostgreSQL smoke and pool checks; run through scripts/pg_test_env.sh."""
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pg_support import require_test_database
require_test_database()
from app import create_app, db


def main():
    assert os.environ.get('BEEBO_TEST') == '1'
    assert db.get_db_name().startswith('beebo_test')
    os.environ.update(PG_POOL_MIN='1', PG_POOL_MAX='1', PG_POOL_TIMEOUT='0.2')
    db.init_db()
    db.init_db()
    app = create_app()
    first = app.test_client()
    second = app.test_client()

    def call(client, method, path, data=None):
        with client.session_transaction() as session:
            token = session.get('csrf_token', '')
        response = client.open(path, method=method, json=data,
                               headers={'X-CSRF-Token': token})
        payload = response.get_json()
        assert response.status_code < 400, (path, response.status_code, payload)
        print(method, path, response.status_code)
        return payload

    alpha = call(first, 'POST', '/api/signup', {
        'full_name': 'Smoke Alpha', 'email': 'pgalpha@example.test', 'password': 'testing123',
    })['user']
    beta = call(second, 'POST', '/api/signup', {
        'full_name': 'Smoke Beta', 'email': 'pgbeta@example.test', 'password': 'testing123',
    })['user']
    call(first, 'POST', '/api/login', {'email': alpha['email'], 'password': 'testing123'})
    post = call(first, 'POST', '/api/posts', {'content': 'Smoke #Post', 'audience': 'Public'})
    call(second, 'POST', f'/api/posts/{post["id"]}/comments', {'content': 'Smoke comment'})
    call(second, 'POST', f'/api/posts/{post["id"]}/like')
    call(second, 'POST', f'/api/users/{alpha["id"]}/follow')
    community = call(first, 'POST', '/api/communities', {
        'name': 'Smoke Club', 'description': 'Smoke community', 'topic': 'General', 'type': 'public',
    })
    call(second, 'POST', f'/api/communities/{community["slug"]}/join')
    call(second, 'POST', f'/api/communities/{community["slug"]}/join')
    call(first, 'GET', f'/api/communities/{community["slug"]}/members')
    call(first, 'GET', f'/api/communities/{community["slug"]}/members/all?q=Smoke')
    conversation = call(first, 'POST', '/api/chat/conversations', {'user_id': beta['id']})
    call(first, 'POST', f'/api/chat/conversations/{conversation["id"]}/messages', {'body': 'Smoke DM'})
    wallet = call(first, 'GET', '/api/wallet')
    assert wallet['balance'] == 0, wallet
    call(first, 'GET', '/api/posts')
    call(first, 'GET', f'/api/posts/{post["id"]}/comments')
    call(first, 'GET', '/api/search?q=Smoke')
    call(first, 'GET', '/api/search/trending')
    call(first, 'GET', '/api/communities?q=Smoke')

    connection = db.get_db()
    assert connection.execute('SHOW TimeZone').fetchone() == ('UTC',)
    assert not connection.autocommit
    connection.execute('UPDATE users SET bio = %s WHERE id = %s', ('uncommitted', alpha['id']))
    connection.close()
    connection = db.get_db()
    assert connection.execute('SELECT bio FROM users WHERE id = %s', (alpha['id'],)).fetchone() == (None,)
    started = time.monotonic()
    response = first.get('/api/posts')
    elapsed = time.monotonic() - started
    assert response.status_code == 503 and response.is_json, response.data
    assert elapsed < 2, elapsed
    connection.close()
    print(f'PASS: smoke, migrations twice, rollback, UTC, tuple rows, JSON 503 in {elapsed:.3f}s')


if __name__ == '__main__':
    try:
        main()
    finally:
        db.close_pool()
