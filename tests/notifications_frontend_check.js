// Pure-logic checks for static/js/notifications.js (no browser, no server).
// Loads the browser script into a vm context with minimal stubs.
// Run: TZ=UTC node tests/notifications_frontend_check.js   (see test_notifications_ui.sh)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {
	console,
	document: { addEventListener() {}, getElementById() { return null; }, visibilityState: 'visible' },
	fetch() { throw new Error('no network in this test'); },
	escapeHtml: function (v) {
		return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	},
	showToast() {}, apiFetch() {}
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'notifications.js'), 'utf8')
	+ '\n;this.api = { notifSectionOf, notifGroupItems, notifHeadlineHtml, notifRowHtml, notifTypeOf, notifSubtitle, NOTIFICATION_TYPES, NOTIFICATION_FALLBACK_TYPE };', ctx);
const api = ctx.api;

let failed = 0;
function check(name, cond, detail) {
	if (cond) { console.log('✓ PASS ' + name); } else { failed++; console.log('✗ FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// Every type the backend can emit must be registered (Phase 1-3).
['follow', 'post_like', 'comment_like', 'post_comment', 'comment_reply', 'post_quote',
	'mention', 'community_post', 'community_join', 'monthly_credits'].forEach(function (t) {
	check('registered type ' + t, !!api.NOTIFICATION_TYPES[t]);
});
check('unknown type falls back instead of throwing', api.notifTypeOf({ type: 'from_the_future' }) === api.NOTIFICATION_FALLBACK_TYPE);

// Sections use the viewer's local calendar day.
const now = new Date(2026, 10, 7, 15, 0, 0);   // 7 Nov 2026, 15:00 local
const at = function (y, m, d, h) { return new Date(y, m, d, h, 0, 0).toISOString(); };
check('today (earlier this morning)', api.notifSectionOf(at(2026, 10, 7, 0), now) === 'today');
check('yesterday is this week', api.notifSectionOf(at(2026, 10, 6, 23), now) === 'week');
check('six days ago is this week', api.notifSectionOf(at(2026, 10, 1, 9), now) === 'week');
check('seven days ago is earlier', api.notifSectionOf(at(2026, 9, 31, 9), now) === 'earlier');
check('bad timestamp is earlier', api.notifSectionOf('not a date', now) === 'earlier');
check('missing timestamp is earlier', api.notifSectionOf(null, now) === 'earlier');
const grouped = api.notifGroupItems([
	{ id: 3, created_at: at(2026, 10, 7, 12) }, { id: 2, created_at: at(2026, 10, 5, 12) },
	{ id: 1, created_at: at(2026, 9, 1, 12) }, { id: 0, created_at: at(2026, 8, 1, 12) }], now);
check('groups in order with merged earlier', grouped.map(function (g) { return g.key + ':' + g.items.length; }).join(',') === 'today:1,week:1,earlier:2', JSON.stringify(grouped.map(function (g) { return g.key; })));
check('empty list has no groups', api.notifGroupItems([], now).length === 0);

// Headlines.
const actor = { id: 1, full_name: 'Ada', handle: 'ada' };
const html = function (n) { return api.notifHeadlineHtml(n, api.notifTypeOf(n)); };
check('single liker', html({ type: 'post_like', actor: actor }).includes('liked your') && !html({ type: 'post_like', actor: actor }).includes(' other'));
check('1 other (singular)', html({ type: 'post_like', actor: actor, others_count: 1 }).includes('and 1 other liked'));
check('N others (plural)', html({ type: 'comment_like', actor: actor, others_count: 4 }).includes('and 4 others liked'));
check('garbage others_count ignored', !html({ type: 'post_like', actor: actor, others_count: 'x' }).includes('other'));
check('community name is the object', html({ type: 'community_join', actor: actor, community: { slug: 's', name: 'CSC' } }).includes('>CSC</span>'));
check('missing community has a safe fallback', html({ type: 'community_post', actor: actor, community: null }).includes('a community'));
check('system row has no actor name', html({ type: 'monthly_credits', actor: null }) === '<span class="font-semibold">Your monthly credits are ready</span>');
check('actor-less non-system row says Someone', html({ type: 'follow', actor: null }).includes('Someone'));
check('fallback uses server text', html({ type: 'x', actor: actor, text: 'did a thing' }).includes('did a thing'));

// Escaping.
const evil = { type: 'post_like', read: false, id: '5" onclick="x', actor: { id: 1, full_name: '<img src=x onerror=alert(1)>', handle: 'h' }, preview: '<script>alert(1)</script>', created_at: new Date().toISOString(), post: { id: 1, images: ['x" onerror="y'] } };
const row = api.notifRowHtml(evil);
check('no raw tags in row', !/<img src=x|<script>/.test(row), row);
check('no attribute breakout in id or image', (row.match(/\sonclick="/g) || []).length === 1 && !/\sonerror="/.test(row), row);

// Subtitle.
const st = function (o) { return api.notifSubtitle(Object.assign({ status: 'ready', items: [{}], unread: 0 }, o)); };
check('subtitle singular', st({ unread: 1 }) === 'You have 1 unread notification');
check('subtitle plural', st({ unread: 3 }) === 'You have 3 unread notifications');
check('subtitle caught up', st({}) === 'You\'re all caught up');
check('subtitle hidden while loading', st({ status: 'loading', unread: 3 }) === '');
check('subtitle hidden when empty', st({ items: [] }) === '');

if (failed) { console.log('\n✗ ' + failed + ' check(s) failed'); process.exit(1); }
console.log('\nAll notification frontend checks passed');
