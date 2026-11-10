// ---- Notifications screen ----
// Takeover screen opened from the feed header bell. It renders whatever
// GET /api/notifications returns and reports read state back via
// POST /api/notifications/read (backend: app/routes/notifications.py).
// Any list failure shows the error state with a retry.
//
// Wire contract (see docs/NOTIFICATIONS_ROADMAP.md):
//   GET  /api/notifications?limit=&cursor=
//        -> { notifications: [Notification], next_cursor: id|null, unread_count: int }
//   POST /api/notifications/read   body {ids: [id]} or {all: true}
//        -> { unread_count: int }
//   Notification = {
//     id, type, created_at (ISO-8601 UTC), read: bool,
//     actor:   { id, full_name, handle, profile_picture } | null,  // null for system types
//     preview: string | null,           // one-line snippet of the post/comment
//     post:    <serialize_post shape> | null,   // post-targeted types only
//     others_count: int,                // like types: other likers folded into this row
//     community: { slug, name } | null  // community_join / community_post
//   }
// unread_count counts display rows (an aggregated like row counts once).
//
// Adding a notification type = one entry in NOTIFICATION_TYPES below.
// Unknown types still render (generic row) so a newer server never breaks an
// older client.

const NOTIFICATIONS_PAGE_SIZE = 20;
let notificationsLoadToken = 0;   // discards responses from superseded loads

function notificationsFreshState() {
	return {
		status: 'loading',      // 'loading' | 'ready' | 'error'
		items: [],
		nextCursor: null,       // id to page from, or null when everything is loaded
		unread: 0,
		loadingMore: false
	};
}
let notificationsState = notificationsFreshState();

// ---- Type registry ----
// icon: key into NOTIF_ICON_PATHS (24x24, stroked); tone: Tailwind bg class
// for the small badge on the avatar (or the tile for system rows); accent:
// text colour for the emphasised object word ("post", a community name);
// verb(n): what follows the actor's name; object(n): emphasised word after
// the verb, or ''; open(n): where a tap goes. System types (no actor) set
// system: true and provide title(n) and optional detail(n) instead.
const NOTIF_ICON_PATHS = {
	bell: '<path d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" stroke-linecap="round" stroke-linejoin="round"></path>',
	heart: '<path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" stroke-linecap="round" stroke-linejoin="round"></path>',
	comment: '<path d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" stroke-linecap="round" stroke-linejoin="round"></path>',
	reply: '<path d="m9 17-5-5 5-5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 18v-2a4 4 0 0 0-4-4H4" stroke-linecap="round" stroke-linejoin="round"></path>',
	follow: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="9" cy="7" r="4"></circle><path d="M19 8v6M22 11h-6" stroke-linecap="round" stroke-linejoin="round"></path>',
	quote: '<path d="M7 8h4v4a4 4 0 0 1-4 4M15 8h4v4a4 4 0 0 1-4 4" stroke-linecap="round" stroke-linejoin="round"></path>',
	at: '<path d="M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 1 0-2.636 6.364M16.5 12V8.25" stroke-linecap="round" stroke-linejoin="round"></path>',
	users: '<circle cx="9" cy="8" r="3"></circle><path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="17" cy="9" r="2.5"></circle><path d="M17 14a4 4 0 0 1 4 4v1" stroke-linecap="round" stroke-linejoin="round"></path>',
	credits: '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v8M8 12h8" stroke-linecap="round" stroke-linejoin="round"></path>'
};

function notifOpenPost(n) {
	// There is no GET /api/posts/<id>; the post overlay is fed from a post
	// object (see CLAUDE.md "Key data flow"). Post-targeted notifications
	// therefore carry a serialize_post snapshot in `post`.
	if (!n.post || n.post.id == null) {
		showToast('This post is no longer available');
		return;
	}
	openCommentOverlay(quotedPostToPostData(n.post));
}

function notifOpenActorProfile(n) {
	const a = n.actor;
	if (!a || a.id == null) return;
	openUserProfileView({ id: a.id, name: a.full_name, handle: a.handle, avatar: a.profile_picture });
}

function notifOpenCommunity(n) {
	if (!n.community || !n.community.slug) {
		showToast('This community is no longer available');
		return;
	}
	openCommunityView(n.community.slug);
}

function notifOpenWallet() {
	openWalletView();
}

function notifCommunityName(n) {
	return n.community && n.community.name ? n.community.name : 'a community';
}

const NOTIFICATION_TYPES = {
	follow:          { icon: 'follow',  tone: 'bg-emerald-500', accent: '',                verb: function () { return 'started following you'; }, object: function () { return ''; },        open: notifOpenActorProfile },
	post_like:       { icon: 'heart',   tone: 'bg-brand-red',   accent: 'text-brand-red',  verb: function () { return 'liked your'; },             object: function () { return 'post'; },    open: notifOpenPost },
	comment_like:    { icon: 'heart',   tone: 'bg-brand-red',   accent: 'text-brand-red',  verb: function () { return 'liked your'; },             object: function () { return 'comment'; }, open: notifOpenPost },
	post_comment:    { icon: 'comment', tone: 'bg-blue-500',    accent: 'text-blue-500',   verb: function () { return 'commented on your'; },      object: function () { return 'post'; },    open: notifOpenPost },
	comment_reply:   { icon: 'reply',   tone: 'bg-blue-500',    accent: 'text-blue-500',   verb: function () { return 'replied to your'; },        object: function () { return 'comment'; }, open: notifOpenPost },
	post_quote:      { icon: 'quote',   tone: 'bg-indigo-500',  accent: 'text-indigo-500', verb: function () { return 'quoted your'; },            object: function () { return 'post'; },    open: notifOpenPost },
	mention:         { icon: 'at',      tone: 'bg-violet-500',  accent: '',                verb: function () { return 'mentioned you'; },         object: function () { return ''; },        open: notifOpenPost },
	community_post:  { icon: 'users',   tone: 'bg-teal-500',    accent: 'text-teal-600',   verb: function () { return 'posted in'; },              object: notifCommunityName,                open: notifOpenPost },
	community_join:  { icon: 'users',   tone: 'bg-teal-500',    accent: 'text-teal-600',   verb: function () { return 'joined'; },                 object: notifCommunityName,                open: notifOpenCommunity },
	monthly_credits: { icon: 'credits', tone: 'bg-amber-500',   accent: '', system: true,
		title: function () { return 'Your monthly credits are ready'; },
		detail: function () { return 'Claim them from your wallet.'; },
		open: notifOpenWallet }
};
const NOTIFICATION_FALLBACK_TYPE = {
	icon: 'bell', tone: 'bg-gray-500', accent: '',
	verb: function (n) { return typeof n.text === 'string' && n.text ? n.text : 'sent you a notification'; },
	object: function () { return ''; },
	open: function () {}
};

function notifTypeOf(n) {
	return NOTIFICATION_TYPES[n.type] || NOTIFICATION_FALLBACK_TYPE;
}

// ---- Helpers ----

// created_at arrives as ISO-8601 UTC ("...Z", same as the wallet API). A
// value with no timezone marker is treated as UTC rather than local time.
function notifParseTime(iso) {
	if (!iso) return null;
	const s = String(iso).replace(' ', 'T');
	const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z');
	return isNaN(d.getTime()) ? null : d;
}

function notifFormatTime(iso) {
	const d = notifParseTime(iso);
	if (!d) return '';
	const mins = Math.floor((Date.now() - d.getTime()) / 60000);
	if (mins < 1) return 'Just now';
	if (mins < 60) return mins + 'm';
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return hrs + 'h';
	const days = Math.floor(hrs / 24);
	if (days < 7) return days + 'd';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Section a row belongs to, by the viewer's local calendar day: today, the
// six days before it ("This week"), or anything older.
const NOTIF_SECTION_LABELS = { today: 'Today', week: 'This week', earlier: 'Earlier' };

function notifSectionOf(iso, now) {
	const d = notifParseTime(iso);
	if (!d) return 'earlier';
	const base = now || new Date();
	const startOfToday = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
	const t = d.getTime();
	if (t >= startOfToday) return 'today';
	if (t >= startOfToday - 6 * 86400000) return 'week';
	return 'earlier';
}

// Items arrive newest-first, so consecutive rows share a section; start a
// new group whenever the section changes. Returns [{key, label, items}].
function notifGroupItems(items, now) {
	const groups = [];
	items.forEach(function (n) {
		const key = notifSectionOf(n.created_at, now);
		const last = groups[groups.length - 1];
		if (last && last.key === key) {
			last.items.push(n);
		} else {
			groups.push({ key: key, label: NOTIF_SECTION_LABELS[key], items: [n] });
		}
	});
	return groups;
}

function notifIconSvg(name, cls) {
	return '<svg class="' + cls + '" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' + (NOTIF_ICON_PATHS[name] || NOTIF_ICON_PATHS.bell) + '</svg>';
}

// Feed-header bell dot. Hidden unless there is something unread.
function setNotificationBadge(count) {
	const dot = document.getElementById('feed-notif-badge');
	if (dot) dot.classList.toggle('hidden', !(count > 0));
}

// Asks the server for the unread count and updates the bell dot. Called when
// the feed is shown and when the app returns to the foreground; the dot is
// otherwise only updated by the notifications screen itself. Failures (e.g.
// logged out) just hide the dot.
let notificationsBadgeToken = 0;
async function refreshNotificationBadge() {
	const token = ++notificationsBadgeToken;
	try {
		const res = await fetch('/api/notifications?limit=1');
		if (token !== notificationsBadgeToken) return;
		if (!res.ok) { setNotificationBadge(0); return; }
		const data = await res.json();
		if (token !== notificationsBadgeToken) return;
		setNotificationBadge(typeof data.unread_count === 'number' ? data.unread_count : 0);
	} catch (err) {
		/* leave the dot as it was */
	}
}

let notificationsBadgeCheckedAt = 0;
document.addEventListener('visibilitychange', function () {
	if (document.visibilityState !== 'visible') return;
	const feed = document.getElementById('feed-view');
	if (!feed || !feed.classList.contains('active')) return;
	if (Date.now() - notificationsBadgeCheckedAt < 30000) return;
	notificationsBadgeCheckedAt = Date.now();
	refreshNotificationBadge();
});

// ---- Data layer (the only place that talks to the network) ----

const notificationsApi = {
	async list(cursor) {
		let url = '/api/notifications?limit=' + NOTIFICATIONS_PAGE_SIZE;
		if (cursor != null) url += '&cursor=' + encodeURIComponent(cursor);
		const res = await fetch(url);
		if (!res.ok) throw new Error('request failed');
		return res.json();
	},
	async markRead(body) {
		const res = await apiFetch('/api/notifications/read', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error('request failed');
		return res.json();
	}
};

// ---- Navigation ----

function openNotificationsView() {
	showView('notifications');
}

function closeNotificationsView() {
	showView('feed');
}

// Called by showView() each time the screen opens: start clean (nothing from
// a previous account/visit flashes) and reload from the server.
function initNotificationsView() {
	notificationsState = notificationsFreshState();
	loadNotifications();
}

// ---- Loading ----

async function loadNotifications() {
	const token = ++notificationsLoadToken;
	notificationsState = notificationsFreshState();
	renderNotifications();

	try {
		const data = await notificationsApi.list(null);
		if (token !== notificationsLoadToken) return;
		notificationsState.items = data.notifications || [];
		notificationsState.nextCursor = data.next_cursor == null ? null : data.next_cursor;
		notificationsState.unread = notifUnreadFrom(data, notificationsState.items);
		notificationsState.status = 'ready';
	} catch (err) {
		if (token !== notificationsLoadToken) return;
		notificationsState.status = 'error';
	}
	renderNotifications();
}

async function loadMoreNotifications() {
	if (notificationsState.loadingMore || notificationsState.nextCursor == null) return;
	const token = notificationsLoadToken;
	notificationsState.loadingMore = true;
	renderNotifications();
	try {
		const data = await notificationsApi.list(notificationsState.nextCursor);
		if (token !== notificationsLoadToken) return;
		const seen = new Set(notificationsState.items.map(function (n) { return n.id; }));
		(data.notifications || []).forEach(function (n) { if (!seen.has(n.id)) notificationsState.items.push(n); });
		notificationsState.nextCursor = data.next_cursor == null ? null : data.next_cursor;
		notificationsState.unread = notifUnreadFrom(data, notificationsState.items);
	} catch (err) {
		if (token !== notificationsLoadToken) return;
		showToast('Could not load more');
	}
	notificationsState.loadingMore = false;
	renderNotifications();
}

function notifUnreadFrom(data, items) {
	if (typeof data.unread_count === 'number') return data.unread_count;
	return items.filter(function (n) { return !n.read; }).length;
}

// ---- Read state ----

async function openNotification(id) {
	const n = notificationsState.items.find(function (x) { return String(x.id) === String(id); });
	if (!n) return;
	if (!n.read) {
		n.read = true;
		notificationsState.unread = Math.max(0, notificationsState.unread - 1);
		renderNotifications();
		// Best effort: a failed write is reconciled on the next load.
		notificationsApi.markRead({ ids: [n.id] }).catch(function () {});
	}
	notifTypeOf(n).open(n);
}

async function markAllNotificationsRead() {
	const state = notificationsState;
	const hadUnread = state.items.filter(function (n) { return !n.read; });
	if (!hadUnread.length && !(state.unread > 0)) return;
	const prevUnread = state.unread;
	hadUnread.forEach(function (n) { n.read = true; });
	state.unread = 0;
	renderNotifications();
	try {
		await notificationsApi.markRead({ all: true });
	} catch (err) {
		if (state === notificationsState) {
			hadUnread.forEach(function (n) { n.read = false; });
			state.unread = prevUnread;
			renderNotifications();
		}
		showToast('Could not mark all as read');
	}
}

// ---- Rendering ----

function notifSubtitle(s) {
	if (s.status !== 'ready' || !s.items.length) return '';
	if (s.unread > 0) return 'You have ' + s.unread + ' unread notification' + (s.unread === 1 ? '' : 's');
	return 'You\'re all caught up';
}

function renderNotifications() {
	const body = document.getElementById('notifications-body');
	const markAll = document.getElementById('notifications-mark-all');
	const subtitle = document.getElementById('notifications-subtitle');
	if (!body) return;
	const s = notificationsState;

	if (markAll) markAll.classList.toggle('hidden', !(s.status === 'ready' && s.unread > 0));
	if (subtitle) {
		const text = notifSubtitle(s);
		subtitle.textContent = text;
		subtitle.classList.toggle('hidden', !text);
	}
	setNotificationBadge(s.status === 'ready' ? s.unread : 0);

	if (s.status === 'loading') {
		body.innerHTML = notifSkeletonHtml();
	} else if (s.status === 'error') {
		body.innerHTML = notifMessageHtml('Couldn\'t load notifications', 'Check your connection and try again.', 'Try again', 'loadNotifications()');
	} else if (!s.items.length) {
		body.innerHTML = notifMessageHtml('No notifications yet', 'When people follow you or interact with your posts, you\'ll see it here.');
	} else {
		body.innerHTML = notifGroupItems(s.items).map(notifSectionHtml).join('') + notifFooterHtml(s);
	}
}

function notifSectionHtml(group) {
	return '<section aria-label="' + escapeHtml(group.label) + '">'
		+ '<h2 class="px-4 pt-5 pb-2 text-[15px] font-bold text-gray-900">' + escapeHtml(group.label) + '</h2>'
		+ '<ul>' + group.items.map(notifRowHtml).join('') + '</ul>'
		+ '</section>';
}

// First image of the post the notification is about, as a small square on
// the right of the row. Text-only posts and non-post types show nothing.
function notifThumbHtml(n) {
	const imgs = n.post && Array.isArray(n.post.images) ? n.post.images : [];
	if (!imgs.length || !imgs[0]) return '';
	return '<img alt="" loading="lazy" class="notif-thumb w-12 h-12 rounded-lg object-cover shrink-0 bg-gray-100 border border-gray-100" src="' + escapeHtml(imgs[0]) + '"/>';
}

// "Name [and N others] verb [object]" - or the system title for actor-less
// types. The object word is the accent-coloured link-style word from the
// reference designs ("liked your post", "posted in <community>").
function notifHeadlineHtml(n, t) {
	if (t.system) return '<span class="font-semibold">' + escapeHtml(t.title(n)) + '</span>';
	const a = n.actor || {};
	const name = a.full_name || a.handle || 'Someone';
	const others = Math.max(0, parseInt(n.others_count, 10) || 0);
	let html = '<span class="font-semibold">' + escapeHtml(name) + '</span>';
	if (others > 0) html += ' and ' + others + ' other' + (others === 1 ? '' : 's');
	html += ' ' + escapeHtml(t.verb(n));
	const object = t.object(n);
	if (object) html += ' <span class="font-semibold ' + t.accent + '">' + escapeHtml(object) + '</span>';
	return html;
}

// Left visual: the actor's avatar with a small type badge, or a coloured
// tile for system rows that have no actor.
function notifLeadHtml(n, t) {
	if (t.system) {
		return '<span class="notif-lead-tile w-11 h-11 rounded-full flex items-center justify-center text-white shrink-0 ' + t.tone + '">' + notifIconSvg(t.icon, 'w-5 h-5') + '</span>';
	}
	const a = n.actor || {};
	const name = a.full_name || a.handle || 'Someone';
	const avatar = a.profile_picture || ('https://api.dicebear.com/9.x/avataaars/svg?seed=' + encodeURIComponent(a.handle || name));
	return '<span class="relative shrink-0">'
		+ '<img alt="" class="w-11 h-11 rounded-full bg-gray-200 border border-gray-100 object-cover" src="' + escapeHtml(avatar) + '"/>'
		+ '<span class="notif-type-badge absolute -bottom-0.5 -right-0.5 w-[20px] h-[20px] rounded-full flex items-center justify-center text-white ' + t.tone + '">' + notifIconSvg(t.icon, 'w-3 h-3') + '</span>'
		+ '</span>';
}

function notifRowHtml(n) {
	const t = notifTypeOf(n);
	const unread = !n.read;
	const secondary = n.preview || (t.system && t.detail ? t.detail(n) : '');
	return '<li class="border-b border-gray-100 last:border-b-0">'
		+ '<button type="button" class="notif-row relative w-full flex items-start gap-3 pl-6 pr-4 py-3.5 text-left' + (unread ? ' is-unread bg-red-50' : '') + '" data-notif-id="' + escapeHtml(n.id) + '" onclick="openNotification(this.dataset.notifId)">'
		+ (unread ? '<span class="notif-unread-dot absolute left-2.5 top-8 w-2 h-2 rounded-full bg-brand-red" aria-label="Unread"></span>' : '')
		+ notifLeadHtml(n, t)
		+ '<span class="flex-1 min-w-0">'
		+ '<span class="block text-[15px] leading-snug text-gray-900">' + notifHeadlineHtml(n, t) + '</span>'
		+ (secondary ? '<span class="block mt-0.5 text-[14px] leading-snug text-gray-500 truncate">' + escapeHtml(secondary) + '</span>' : '')
		+ '<span class="block mt-1 text-[13px] text-gray-400">' + escapeHtml(notifFormatTime(n.created_at)) + '</span>'
		+ '</span>'
		+ notifThumbHtml(n)
		+ '</button></li>';
}

function notifSkeletonHtml() {
	let rows = '';
	for (let i = 0; i < 6; i++) {
		rows += '<li class="flex items-start gap-3 pl-6 pr-4 py-3.5">'
			+ '<div class="w-11 h-11 rounded-full skeleton-shimmer shrink-0"></div>'
			+ '<div class="flex-1 space-y-2 pt-1"><div class="h-3.5 rounded skeleton-shimmer w-4/5"></div><div class="h-3 rounded skeleton-shimmer w-2/5"></div></div>'
			+ '</li>';
	}
	return '<ul aria-busy="true" aria-label="Loading notifications">' + rows + '</ul>';
}

function notifMessageHtml(title, subtitle, buttonLabel, onclick) {
	return '<div class="flex flex-col items-center text-center px-6 pt-24">'
		+ '<div class="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 mb-4">' + notifIconSvg('bell', 'w-8 h-8') + '</div>'
		+ '<p class="text-[17px] font-semibold text-gray-900">' + escapeHtml(title) + '</p>'
		+ '<p class="text-[14px] text-gray-500 mt-1 max-w-[280px]">' + escapeHtml(subtitle) + '</p>'
		+ (buttonLabel ? '<button type="button" onclick="' + onclick + '" class="wallet-primary-btn mt-5 h-11 px-6 rounded-full text-[15px] font-semibold active:scale-[0.98] transition-transform duration-100">' + escapeHtml(buttonLabel) + '</button>' : '')
		+ '</div>';
}

function notifFooterHtml(s) {
	if (s.nextCursor == null) return '';
	return '<div class="flex justify-center py-5"><button type="button" onclick="loadMoreNotifications()" class="text-[15px] font-semibold text-gray-500 hover:text-gray-700"' + (s.loadingMore ? ' disabled' : '') + '>' + (s.loadingMore ? 'Loading…' : 'Load more') + '</button></div>';
}

// Dev aid: paints a populated state without a backend. Run
// notificationsDebugPreview() in the browser console (the screen must be
// open). Covers every registered type, an aggregated like row, a system row,
// thumbnails, and all three date sections. Not called by the app itself.
function notificationsDebugPreview() {
	const ago = function (m) { return new Date(Date.now() - m * 60000).toISOString(); };
	const thumb = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fca5a5"/><stop offset="1" stop-color="#93c5fd"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/></svg>');
	const post = { id: 1, images: [thumb], content: 'preview post' };
	notificationsLoadToken++;
	notificationsState = Object.assign(notificationsFreshState(), {
		status: 'ready', unread: 6, nextCursor: null,
		items: [
			{ id: 12, type: 'monthly_credits', read: false, created_at: ago(1), actor: null, preview: null, post: null },
			{ id: 11, type: 'follow', read: false, created_at: ago(2), actor: { id: 2, full_name: 'Ada Obi', handle: 'ada' } },
			{ id: 10, type: 'post_like', read: false, created_at: ago(45), others_count: 3, actor: { id: 3, full_name: 'Tunde Bello', handle: 'tunde' }, preview: 'Anyone have the CSC 301 past questions?', post: post },
			{ id: 9, type: 'mention', read: false, created_at: ago(60 * 5), actor: { id: 4, full_name: 'Chioma', handle: 'chi' }, preview: '@you check the library tab', post: null },
			{ id: 8, type: 'community_post', read: false, created_at: ago(60 * 7), actor: { id: 5, full_name: 'Ife', handle: 'ife' }, community: { slug: 'csc', name: 'CSC 300L' }, preview: 'Lab 3 is moved to Friday', post: post },
			{ id: 7, type: 'post_comment', read: false, created_at: ago(60 * 30), actor: { id: 5, full_name: 'Ife', handle: 'ife' }, preview: 'This is so true', post: null },
			{ id: 6, type: 'comment_reply', read: true, created_at: ago(60 * 24 * 2), actor: { id: 6, full_name: 'Kunle', handle: 'kunle' }, preview: 'Same here', post: null },
			{ id: 5, type: 'comment_like', read: true, created_at: ago(60 * 24 * 3), others_count: 1, actor: { id: 7, full_name: 'Zainab', handle: 'zee' }, preview: 'Same here, check the library tab', post: null },
			{ id: 4, type: 'post_quote', read: true, created_at: ago(60 * 24 * 5), actor: { id: 8, full_name: 'Emeka', handle: 'emeka' }, preview: 'Worth reading this thread', post: null },
			{ id: 3, type: 'community_join', read: true, created_at: ago(60 * 24 * 12), actor: { id: 9, full_name: 'Sade', handle: 'sade' }, community: { slug: 'csc', name: 'CSC 300L' } },
			{ id: 1, type: 'unknown_future_type', read: true, created_at: ago(60 * 24 * 40), actor: { id: 10, full_name: 'Beebo', handle: 'beebo' }, text: 'sent you a notification' }
		]
	});
	renderNotifications();
}
