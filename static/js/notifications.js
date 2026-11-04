// ---- Notifications screen ----
// Takeover screen opened from the feed header bell. This file is the
// frontend only: it renders whatever GET /api/notifications returns and
// reports read state back via POST /api/notifications/read. Neither
// endpoint exists yet (see docs/NOTIFICATIONS_ROADMAP.md), so until the
// backend ships, a 404 from the list endpoint is treated as "no
// notifications" and the screen shows its empty state. Any other failure
// shows the error state with a retry.
//
// Wire contract the screen expects (also the contract the backend should
// implement):
//   GET  /api/notifications?limit=&cursor=
//        -> { notifications: [Notification], next_cursor: id|null, unread_count: int }
//   POST /api/notifications/read   body {ids: [id]} or {all: true}
//        -> { unread_count: int }
//   Notification = {
//     id, type, created_at (ISO-8601 UTC), read: bool,
//     actor:   { id, full_name, handle, profile_picture } | null,
//     preview: string | null,           // one-line snippet of the post/comment
//     post:    <serialize_post shape> | null   // only for post-targeted types
//   }
//
// Adding a notification type later = one entry in NOTIFICATION_TYPES below.
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
// icon: svg inner markup (24x24, stroked); tone: Tailwind bg class for the
// small badge on the avatar; text(n): what follows the actor's name;
// open(n): where a tap goes.
const NOTIF_ICON_PATHS = {
	bell: '<path d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" stroke-linecap="round" stroke-linejoin="round"></path>',
	heart: '<path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" stroke-linecap="round" stroke-linejoin="round"></path>',
	comment: '<path d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" stroke-linecap="round" stroke-linejoin="round"></path>',
	reply: '<path d="m9 17-5-5 5-5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 18v-2a4 4 0 0 0-4-4H4" stroke-linecap="round" stroke-linejoin="round"></path>',
	follow: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="9" cy="7" r="4"></circle><path d="M19 8v6M22 11h-6" stroke-linecap="round" stroke-linejoin="round"></path>'
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

const NOTIFICATION_TYPES = {
	follow:        { icon: 'follow',  tone: 'bg-emerald-500', text: function () { return 'started following you'; },      open: notifOpenActorProfile },
	post_like:     { icon: 'heart',   tone: 'bg-brand-red',   text: function () { return 'liked your post'; },             open: notifOpenPost },
	post_comment:  { icon: 'comment', tone: 'bg-blue-500',    text: function () { return 'commented on your post'; },      open: notifOpenPost },
	comment_reply: { icon: 'reply',   tone: 'bg-blue-500',    text: function () { return 'replied to your comment'; },     open: notifOpenPost }
};
const NOTIFICATION_FALLBACK_TYPE = {
	icon: 'bell', tone: 'bg-gray-500',
	text: function (n) { return typeof n.text === 'string' && n.text ? n.text : 'sent you a notification'; },
	open: function () {}
};

function notifTypeOf(n) {
	return NOTIFICATION_TYPES[n.type] || NOTIFICATION_FALLBACK_TYPE;
}

// ---- Helpers ----

// created_at arrives as ISO-8601 UTC ("...Z", same as the wallet API). A
// value with no timezone marker is treated as UTC rather than local time.
function notifFormatTime(iso) {
	if (!iso) return '';
	const s = String(iso).replace(' ', 'T');
	const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z');
	if (isNaN(d.getTime())) return '';
	const mins = Math.floor((Date.now() - d.getTime()) / 60000);
	if (mins < 1) return 'Just now';
	if (mins < 60) return mins + 'm';
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return hrs + 'h';
	const days = Math.floor(hrs / 24);
	if (days < 7) return days + 'd';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function notifIconSvg(name, cls) {
	return '<svg class="' + cls + '" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' + (NOTIF_ICON_PATHS[name] || NOTIF_ICON_PATHS.bell) + '</svg>';
}

// Feed-header bell dot. Hidden unless there is something unread.
function setNotificationBadge(count) {
	const dot = document.getElementById('feed-notif-badge');
	if (dot) dot.classList.toggle('hidden', !(count > 0));
}

// ---- Data layer (the only place that talks to the network) ----

const notificationsApi = {
	async list(cursor) {
		let url = '/api/notifications?limit=' + NOTIFICATIONS_PAGE_SIZE;
		if (cursor != null) url += '&cursor=' + encodeURIComponent(cursor);
		const res = await fetch(url);
		// Backend not built yet: behave as an account with no notifications.
		if (res.status === 404) return { notifications: [], next_cursor: null, unread_count: 0 };
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

function renderNotifications() {
	const body = document.getElementById('notifications-body');
	const markAll = document.getElementById('notifications-mark-all');
	if (!body) return;
	const s = notificationsState;

	if (markAll) markAll.classList.toggle('hidden', !(s.status === 'ready' && s.unread > 0));
	setNotificationBadge(s.status === 'ready' ? s.unread : 0);

	if (s.status === 'loading') {
		body.innerHTML = notifSkeletonHtml();
	} else if (s.status === 'error') {
		body.innerHTML = notifMessageHtml('Couldn\'t load notifications', 'Check your connection and try again.', 'Try again', 'loadNotifications()');
	} else if (!s.items.length) {
		body.innerHTML = notifMessageHtml('No notifications yet', 'When people follow you or interact with your posts, you\'ll see it here.');
	} else {
		body.innerHTML = '<ul>' + s.items.map(notifRowHtml).join('') + '</ul>' + notifFooterHtml(s);
	}
}

function notifRowHtml(n) {
	const t = notifTypeOf(n);
	const a = n.actor || {};
	const name = a.full_name || a.handle || 'Someone';
	const avatar = a.profile_picture || ('https://api.dicebear.com/9.x/avataaars/svg?seed=' + encodeURIComponent(a.handle || name));
	const unread = !n.read;
	return '<li>'
		+ '<button type="button" class="notif-row w-full flex items-start gap-3 px-4 py-3.5 text-left' + (unread ? ' is-unread bg-red-50' : '') + '" data-notif-id="' + escapeHtml(n.id) + '" onclick="openNotification(this.dataset.notifId)">'
		+ '<span class="relative shrink-0">'
		+ '<img alt="" class="w-11 h-11 rounded-full bg-gray-200 border border-gray-100 object-cover" src="' + escapeHtml(avatar) + '"/>'
		+ '<span class="notif-type-badge absolute -bottom-0.5 -right-0.5 w-[20px] h-[20px] rounded-full flex items-center justify-center text-white ' + t.tone + '">' + notifIconSvg(t.icon, 'w-3 h-3') + '</span>'
		+ '</span>'
		+ '<span class="flex-1 min-w-0">'
		+ '<span class="block text-[15px] leading-snug text-gray-900"><span class="font-semibold">' + escapeHtml(name) + '</span> ' + escapeHtml(t.text(n)) + '</span>'
		+ (n.preview ? '<span class="block mt-0.5 text-[14px] leading-snug text-gray-500 truncate">' + escapeHtml(n.preview) + '</span>' : '')
		+ '<span class="block mt-1 text-[13px] text-gray-400">' + escapeHtml(notifFormatTime(n.created_at)) + '</span>'
		+ '</span>'
		+ (unread ? '<span class="shrink-0 mt-2 w-2.5 h-2.5 rounded-full bg-brand-red" aria-label="Unread"></span>' : '')
		+ '</button></li>';
}

function notifSkeletonHtml() {
	let rows = '';
	for (let i = 0; i < 6; i++) {
		rows += '<li class="flex items-start gap-3 px-4 py-3.5">'
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

// Dev aid: paints the populated state without a backend. Run
// notificationsDebugPreview() in the browser console while on this screen
// (or after opening it). Not called by the app itself.
function notificationsDebugPreview() {
	const ago = function (m) { return new Date(Date.now() - m * 60000).toISOString(); };
	notificationsLoadToken++;
	notificationsState = Object.assign(notificationsFreshState(), {
		status: 'ready', unread: 3, nextCursor: null,
		items: [
			{ id: 5, type: 'follow', read: false, created_at: ago(2), actor: { id: 2, full_name: 'Ada Obi', handle: 'ada' } },
			{ id: 4, type: 'post_like', read: false, created_at: ago(45), actor: { id: 3, full_name: 'Tunde Bello', handle: 'tunde' }, preview: 'Anyone have the CSC 301 past questions?', post: null },
			{ id: 3, type: 'comment_reply', read: false, created_at: ago(60 * 5), actor: { id: 4, full_name: 'Chioma', handle: 'chi' }, preview: 'Same here, check the library tab', post: null },
			{ id: 2, type: 'post_comment', read: true, created_at: ago(60 * 30), actor: { id: 5, full_name: 'Ife', handle: 'ife' }, preview: 'This is so true', post: null },
			{ id: 1, type: 'unknown_future_type', read: true, created_at: ago(60 * 24 * 12), actor: { id: 6, full_name: 'Beebo', handle: 'beebo' }, text: 'sent you a notification' }
		]
	});
	renderNotifications();
}
