"""The post length limit lives in three places that must agree.

The server (MAX_CONTENT_LEN), the compose script (COMPOSE_MAX_CHARS) and the
textarea's maxlength attribute in the template. A stale maxlength silently
truncates pasted text before any script or API check can run, so API-level
tests cannot catch it. Pure file checks: no database, no server.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
failures = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else '✗ FAIL ') + name + ('' if ok else f' :: {detail}'))
    if not ok:
        failures.append(name)


def grab(path, pattern):
    match = re.search(pattern, (ROOT / path).read_text(encoding='utf-8'))
    return int(match.group(1)) if match else None


server = grab('app/post_service.py', r'(?m)^MAX_CONTENT_LEN\s*=\s*(\d+)')
script = grab('static/js/compose.js', r'const COMPOSE_MAX_CHARS\s*=\s*(\d+)')
maxlen = grab('templates/partials/post_create.html', r'id="create-post-textarea"[^>]*\smaxlength="(\d+)"')
counter = grab('templates/partials/post_create.html', r'id="char-counter"[^>]*>0/(\d+)<')

check('server limit found', server is not None)
check('compose script limit equals server limit', script == server, f'script={script} server={server}')
check('textarea maxlength equals server limit', maxlen == server, f'maxlength={maxlen} server={server}')
check('initial counter text equals server limit', counter == server, f'counter={counter} server={server}')

if failures:
    print(f'\n✗ {len(failures)} check(s) failed')
    sys.exit(1)
print('\nPost limit is consistent everywhere')
