// ---- Chat sync: real 1:1 direct messaging (/api/chat/*) ----
// Backend: app/routes/chat.py (design record: docs/DIRECT_MESSAGING.md).
//
//  - Conversation list:  GET  /api/chat/conversations
//  - Start / reuse DM:   POST /api/chat/conversations {user_id}
//  - History:            GET  /api/chat/conversations/<id>/messages?before=&limit=
//  - Send:               POST /api/chat/conversations/<id>/messages {body, client_id}
//  - Unread cursor:      POST /api/chat/conversations/<id>/read {up_to}
//  - Live updates:       GET  /api/chat/updates?after=<highest message id>&wait_seconds=25
//                        (long-poll; resumes from the highest id seen, so nothing is
//                        missed or doubled across reconnects)
//
// Real DM conversation objects (chat.js `chatConversations`) have remote: true,
// id 'd<serverId>', serverId, userId. Their threads (chatThreads) hold
// { id, from, text, time, createdAt, clientId, state: 'sent' | 'sending' | 'failed' }
// with id === null until the server confirms. Nothing here ever shows a message as
// sent unless the server accepted it; failed sends stay visible with a Retry.
//
// Polling only runs while a chat screen is open (see chatOnViewChange, called from
// showView) because every held poll occupies a server thread.
//
// Loaded after chat.js; uses apiFetch / session / updateSessionInfo / showToast.

let chatListStatus = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'

const chatSync = {
	viewerId: null,
	generation: 0,   // bumped when the signed-in user changes: in-flight work is discarded
	loopId: 0,       // identifies the live poll loop (a stopped loop must never resume)
	polling: false,
	controller: null,
	cursor: 0,       // highest message id seen
	connected: true,
	sendSeq: 0
};

const CHAT_VIEW_NAMES = new Set(['chat', 'chat-conversation', 'chat-requests', 'chat-new-message', 'chat-new-group', 'chat-group-info', 'chat-group-media']);
const CHAT_POLL_WAIT_SECONDS = 25;
const CHAT_HISTORY_PAGE = 50;

// ---- Time formatting (server sends UTC 'YYYY-MM-DD HH:MM:SS') ----
function chatParseUtc(s) {
	return new Date(String(s).replace(' ', 'T') + 'Z').getTime();
}

function chatSameDay(a, b) {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function chatClock(d) {
	return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// Chats list: today -> clock, yesterday -> "Yesterday", else "Oct 9".
function chatFormatListTime(createdAt) {
	const d = new Date(chatParseUtc(createdAt));
	const now = new Date();
	if (chatSameDay(d, now)) return chatClock(d);
	const y = new Date(now); y.setDate(now.getDate() - 1);
	if (chatSameDay(d, y)) return 'Yesterday';
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Bubble: today -> clock, else "Oct 9, 14:05".
function chatFormatBubbleTime(createdAt) {
	const d = new Date(chatParseUtc(createdAt));
	if (chatSameDay(d, new Date())) return chatClock(d);
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + chatClock(d);
}

// ---- Viewer / state lifecycle ----
async function chatEnsureViewer() {
	if (!session) await updateSessionInfo();
	return session && session.user ? session.user.id : null;
}

// Account switch / logout: drop everything that belonged to the previous user.
function chatResetState(viewerId) {
	chatSync.generation += 1;
	chatStopPolling();
	chatSync.viewerId = viewerId;
	chatSync.cursor = 0;
	chatConversations = [];
	Object.keys(chatThreads).forEach(function (k) { delete chatThreads[k]; });
	chatListStatus = 'idle';
	chatSetConnection(true);
}

function chatHandleLoggedOut() {
	chatResetState(null);
}

function chatSetConnection(ok) {
	chatSync.connected = ok;
	['chat-list-offline-banner', 'chat-conv-offline-banner'].forEach(function (id) {
		const el = document.getElementById(id);
		if (el) el.classList.toggle('hidden', ok);
	});
}

function chatActiveViewName() {
	const el = document.querySelector('.view-section.active');
	return el ? el.id.replace(/-view$/, '') : null;
}

function chatChatViewActive() {
	return chatActiveViewName() === 'chat';
}

// ---- Conversations ----
function chatApplyConversationItem(item) {
	const id = 'd' + item.id;
	let conv = chatConversations.find(function (c) { return c.id === id; });
	if (!conv) {
		conv = { id: id, serverId: item.id, remote: true, isGroup: false, threadState: 'idle', threadLoaded: false, hasMore: false, activity: Date.now(), readUpTo: 0 };
		chatConversations.push(conv);
	}
	conv.userId = item.user.id;
	conv.name = item.user.full_name;
	conv.handle = item.user.handle;
	conv.avatar = item.user.profile_picture || null;
	const lm = item.last_message;
	if (lm) {
		conv.preview = chatPreviewText(lm.body);
		conv.time = chatFormatListTime(lm.created_at);
		conv.lastMessageId = lm.id;
		conv.activity = chatParseUtc(lm.created_at);
	} else {
		conv.preview = '';
		conv.time = '';
		conv.lastMessageId = 0;
	}
	// The thread you are looking at is read by definition.
	conv.unread = chatActiveConversationId === id ? 0 : item.unread_count;
	return conv;
}

function chatBumpCursor(id) {
	if (typeof id === 'number' && id > chatSync.cursor) chatSync.cursor = id;
}

async function chatReloadConversations(opts) {
	const silent = !!(opts && opts.silent);
	const gen = chatSync.generation;
	if (!silent) { chatListStatus = 'loading'; renderChatMessages(); }
	try {
		const res = await fetch('/api/chat/conversations');
		if (res.status === 401) { chatHandleLoggedOut(); return; }
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const data = await res.json();
		if (gen !== chatSync.generation) return;
		data.conversations.forEach(function (item) {
			chatApplyConversationItem(item);
			if (item.last_message) chatBumpCursor(item.last_message.id);
		});
		chatListStatus = 'ready';
		chatSetConnection(true);
		if (CHAT_VIEW_NAMES.has(chatActiveViewName())) chatStartPolling();
	} catch (err) {
		if (gen !== chatSync.generation) return;
		if (!silent || chatListStatus !== 'ready') chatListStatus = 'error';
		if (silent) chatSetConnection(false);
	}
	renderChatMessages();
}

// Called every time the Chats list opens (chat.js initChatView).
async function chatSyncInit() {
	const viewer = await chatEnsureViewer();
	if (viewer == null) return;
	if (chatSync.viewerId !== viewer) chatResetState(viewer); // first open, or the account changed
	const first = chatListStatus === 'idle' || chatListStatus === 'error';
	await chatReloadConversations({ silent: !first }); // starts polling once it succeeds
}

// showView hook: stop polling once the user leaves the chat screens.
function chatOnViewChange(viewName) {
	if (!CHAT_VIEW_NAMES.has(viewName)) chatStopPolling();
}

// Start (or reuse) the DM with `userId` on the server, then open it.
async function chatOpenDirectWith(userId) {
	const viewer = await chatEnsureViewer();
	if (viewer == null) throw new Error('Please log in again.');
	if (chatSync.viewerId !== viewer) chatResetState(viewer);
	let res;
	try {
		res = await apiFetch('/api/chat/conversations', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ user_id: userId })
		});
	} catch (err) {
		throw new Error('Network error. Check your connection and try again.');
	}
	if (res.status === 401) { chatHandleLoggedOut(); throw new Error('Please log in again.'); }
	const data = await res.json().catch(function () { return {}; });
	if (!res.ok) throw new Error(data.error || 'Couldn\u2019t start this conversation');
	const conv = chatApplyConversationItem(data);
	if (chatListStatus === 'idle') chatListStatus = 'ready';
	openChatConversation(conv.id);
	chatStartPolling();
}

// ---- Live updates (long-poll) ----
function chatStartPolling() {
	if (chatSync.polling) return;
	chatSync.polling = true;
	chatSync.loopId += 1;
	chatPollLoop(chatSync.loopId, chatSync.generation);
}

function chatStopPolling() {
	chatSync.polling = false;
	chatSync.loopId += 1;
	if (chatSync.controller) { try { chatSync.controller.abort(); } catch (e) { /* already done */ } }
	chatSync.controller = null;
}

function chatSleep(ms) {
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function chatPollLoop(loopId, gen) {
	let backoff = 1000;
	const live = function () { return chatSync.polling && loopId === chatSync.loopId && gen === chatSync.generation; };
	while (live()) {
		const controller = new AbortController();
		chatSync.controller = controller;
		try {
			const res = await fetch('/api/chat/updates?after=' + chatSync.cursor + '&wait_seconds=' + CHAT_POLL_WAIT_SECONDS, { signal: controller.signal });
			if (!live()) return;
			if (res.status === 401) { chatHandleLoggedOut(); return; }
			if (!res.ok) throw new Error('HTTP ' + res.status);
			const data = await res.json();
			if (!live()) return;
			if (!chatSync.connected) chatSetConnection(true);
			backoff = 1000;
			chatApplyUpdates(data);
		} catch (err) {
			if (!live()) return; // stopped on purpose (aborted)
			chatSetConnection(false);
			await chatSleep(backoff);
			backoff = Math.min(backoff * 2, 10000);
		}
	}
}

function chatApplyUpdates(data) {
	// Conversations first so a brand-new conversation exists before its messages arrive.
	(data.conversations || []).forEach(chatApplyConversationItem);
	const touched = new Set();
	(data.messages || []).forEach(function (msg) {
		chatBumpCursor(msg.id);
		const conv = chatIngestMessage(msg);
		if (conv) touched.add(conv.id);
	});
	if (chatChatViewActive()) renderChatMessages();
	if (chatActiveConversationId && touched.has(chatActiveConversationId)) {
		const conv = chatConversations.find(function (c) { return c.id === chatActiveConversationId; });
		if (conv) {
			const scroll = document.getElementById('chat-conv-scroll');
			const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
			renderChatConversation();
			if (nearBottom) scrollChatConversationToBottom();
			chatMarkRead(conv);
		}
	}
}

// Merge one server message into its (already loaded) thread. Returns the conversation.
function chatIngestMessage(msg) {
	const conv = chatConversations.find(function (c) { return c.serverId === msg.conversation_id; });
	if (!conv) return null;
	const thread = chatThreads[conv.id];
	if (!thread) return conv; // history not loaded yet: it is fetched when the thread opens
	if (thread.some(function (m) { return m.id === msg.id; })) return conv;
	const mine = msg.sender_id === chatSync.viewerId;
	if (mine) {
		// Our own send echoed back before its POST response did: settle the pending bubble.
		const pending = thread.find(function (m) { return m.id == null && m.text === msg.body; });
		if (pending) { chatSettle(pending, msg); return conv; }
	}
	const entry = chatEntryFromServer(msg, mine);
	const firstPending = thread.findIndex(function (m) { return m.id == null; });
	if (firstPending === -1) thread.push(entry);
	else thread.splice(firstPending, 0, entry);
	return conv;
}

function chatEntryFromServer(msg, mine) {
	return {
		id: msg.id,
		from: mine ? 'me' : 'them',
		text: msg.body,
		time: chatFormatBubbleTime(msg.created_at),
		createdAt: msg.created_at,
		state: 'sent'
	};
}

function chatSettle(entry, msg) {
	entry.id = msg.id;
	entry.createdAt = msg.created_at;
	entry.time = chatFormatBubbleTime(msg.created_at);
	entry.state = 'sent';
	delete entry.error;
}

// ---- Opening a conversation: history + read cursor ----
async function chatFetchHistory(conv, before) {
	let url = '/api/chat/conversations/' + conv.serverId + '/messages?limit=' + CHAT_HISTORY_PAGE;
	if (before) url += '&before=' + before;
	const res = await fetch(url);
	if (res.status === 401) { chatHandleLoggedOut(); throw new Error('Please log in again.'); }
	if (!res.ok) throw new Error('HTTP ' + res.status);
	return res.json();
}

async function chatSyncOpenConversation(conv) {
	const gen = chatSync.generation;
	const hadHistory = conv.threadLoaded;
	if (!hadHistory) { conv.threadState = 'loading'; renderChatConversation(); }
	try {
		const data = await chatFetchHistory(conv);
		if (gen !== chatSync.generation) return;
		const fresh = data.messages.map(function (m) { return chatEntryFromServer(m, m.sender_id === chatSync.viewerId); });
		const local = chatThreadFor(conv).filter(function (m) { return m.id == null; }); // still sending / failed
		fresh.forEach(function (m) { chatBumpCursor(m.id); });
		// (A failed message the server actually received is reconciled by Retry: the
		// same client_id returns the stored message instead of inserting a duplicate.)
		chatThreads[conv.id] = fresh.concat(local);
		conv.hasMore = !!data.has_more;
		conv.threadLoaded = true;
		conv.threadState = 'ready';
	} catch (err) {
		if (gen !== chatSync.generation) return;
		if (!hadHistory) conv.threadState = 'error';
		else chatSetConnection(false);
	}
	if (chatActiveConversationId === conv.id) {
		renderChatConversation();
		scrollChatConversationToBottom();
		chatMarkRead(conv);
	}
}

function chatRetryHistory() {
	const conv = chatConversations.find(function (c) { return c.id === chatActiveConversationId; });
	if (conv && conv.remote) chatSyncOpenConversation(conv);
}

async function chatLoadEarlier() {
	const conv = chatConversations.find(function (c) { return c.id === chatActiveConversationId; });
	if (!conv || !conv.remote || conv.loadingEarlier) return;
	const thread = chatThreadFor(conv);
	const first = thread.find(function (m) { return m.id != null; });
	if (!first) return;
	conv.loadingEarlier = true;
	renderChatConversation();
	const scroll = document.getElementById('chat-conv-scroll');
	const before = scroll.scrollHeight - scroll.scrollTop; // keep the viewport anchored
	try {
		const data = await chatFetchHistory(conv, first.id);
		const older = data.messages
			.filter(function (m) { return !thread.some(function (t) { return t.id === m.id; }); })
			.map(function (m) { return chatEntryFromServer(m, m.sender_id === chatSync.viewerId); });
		thread.unshift.apply(thread, older);
		conv.hasMore = !!data.has_more;
	} catch (err) {
		showToast('Couldn\u2019t load earlier messages');
	}
	conv.loadingEarlier = false;
	if (chatActiveConversationId === conv.id) {
		renderChatConversation();
		scroll.scrollTop = scroll.scrollHeight - before;
	}
}

// Tell the server the viewer has read up to the newest confirmed message.
async function chatMarkRead(conv) {
	const thread = chatThreads[conv.id] || [];
	let upTo = 0;
	thread.forEach(function (m) { if (m.id != null && m.id > upTo) upTo = m.id; });
	if (!upTo || upTo <= conv.readUpTo) return;
	conv.readUpTo = upTo;
	conv.unread = 0;
	try {
		const res = await apiFetch('/api/chat/conversations/' + conv.serverId + '/read', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ up_to: upTo })
		});
		if (!res.ok && res.status !== 204) conv.readUpTo = 0; // retry on the next opportunity
	} catch (err) {
		conv.readUpTo = 0;
	}
}

// ---- Sending ----
function chatNewClientId() {
	chatSync.sendSeq += 1;
	const rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
	return 'c-' + rand + '-' + chatSync.sendSeq;
}

function chatSendRemote(conv, text) {
	const entry = { id: null, from: 'me', text: text, time: chatClock(new Date()), createdAt: null, clientId: chatNewClientId(), state: 'sending' };
	chatThreadFor(conv).push(entry);
	if (chatActiveConversationId === conv.id) {
		renderChatConversation();
		scrollChatConversationToBottom();
	}
	chatPostMessage(conv, entry);
}

async function chatPostMessage(conv, entry) {
	const gen = chatSync.generation;
	entry.state = 'sending';
	delete entry.error;
	let res = null;
	let failure = null;
	try {
		res = await apiFetch('/api/chat/conversations/' + conv.serverId + '/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ body: entry.text, client_id: entry.clientId })
		});
	} catch (err) {
		failure = 'No connection. Message not sent.';
	}
	if (gen !== chatSync.generation) return;
	if (res && res.status === 401) { chatHandleLoggedOut(); return; }
	let data = null;
	if (res) {
		data = await res.json().catch(function () { return null; });
		if (!res.ok) failure = res.status === 429 ? 'Sending too fast. Try again in a moment.' : ((data && data.error) || 'Message not sent.');
	}
	const thread = chatThreadFor(conv);
	if (failure) {
		if (entry.id == null) { // an echo may already have settled it
			entry.state = 'failed';
			entry.error = failure;
		}
	} else if (data && data.message) {
		const msg = data.message;
		const twin = thread.find(function (m) { return m !== entry && m.id === msg.id; });
		if (twin) { // the poll delivered it first and matched another bubble: keep one
			thread.splice(thread.indexOf(entry), 1);
		} else {
			chatSettle(entry, msg);
		}
		chatBumpCursor(msg.id);
		conv.preview = chatPreviewText(msg.body);
		conv.time = chatFormatListTime(msg.created_at);
		conv.lastMessageId = Math.max(conv.lastMessageId || 0, msg.id);
		conv.activity = chatParseUtc(msg.created_at);
	}
	if (chatActiveConversationId === conv.id) renderChatConversation();
	if (chatChatViewActive()) renderChatMessages();
}

function chatRetrySend(clientId) {
	const conv = chatConversations.find(function (c) { return c.id === chatActiveConversationId; });
	if (!conv || !conv.remote) return;
	const entry = chatThreadFor(conv).find(function (m) { return m.clientId === clientId && m.state === 'failed'; });
	if (!entry) return;
	chatPostMessage(conv, entry); // marks it Sending synchronously
	renderChatConversation();
}

// ---- Rendering helpers used by chat.js ----
// Under the bubble of one of my messages: time, plus Sending... / Not sent + Retry.
// (No delivery ticks: there is no delivery/read-receipt feature.)
function chatRemoteMetaHtml(msg, timeHtml) {
	if (msg.state === 'sending') {
		return '<div class="flex items-center gap-1.5 mt-1.5 text-[13px] text-gray-500"><span>Sending\u2026</span></div>';
	}
	if (msg.state === 'failed') {
		return '<div class="flex items-center gap-2 mt-1.5 text-[13px]"><span class="text-brand-red">' + escapeHtml(msg.error || 'Not sent') + '</span>' +
			'<button type="button" class="chat-retry-btn font-semibold text-brand-red underline" data-chat-retry="' + escapeHtml(msg.clientId) + '">Retry</button></div>';
	}
	return '<div class="flex items-center gap-1.5 mt-1.5 text-[13px] text-gray-500"><span>' + timeHtml + '</span></div>';
}

// Day pill above the thread: real DMs show the day of the first loaded message
// (nothing while empty); groups (messages created in this session) show "Today".
function chatRenderDayLabel(conv, thread) {
	const wrap = document.getElementById('chat-conv-day');
	const label = document.getElementById('chat-conv-day-label');
	if (!conv.remote) { wrap.classList.remove('hidden'); label.textContent = 'Today'; return; }
	const first = thread.find(function (m) { return m.createdAt; });
	if (!first) { wrap.classList.add('hidden'); return; }
	const d = new Date(chatParseUtc(first.createdAt));
	const now = new Date();
	const y = new Date(now); y.setDate(now.getDate() - 1);
	label.textContent = chatSameDay(d, now) ? 'Today' : chatSameDay(d, y) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
	wrap.classList.remove('hidden');
}

// Top of a real DM thread: load-earlier button, or the loading / error / empty state.
function chatRemoteThreadPrefixHtml(conv, hasMessages) {
	if (hasMessages) {
		if (conv.hasMore && conv.threadState === 'ready') {
			return '<div class="flex justify-center"><button id="chat-load-earlier-btn" type="button" class="px-4 py-1.5 rounded-full bg-gray-100 text-[13px] font-semibold text-gray-700 active:bg-gray-200" data-chat-load-earlier="1">' + (conv.loadingEarlier ? 'Loading\u2026' : 'Load earlier messages') + '</button></div>';
		}
		return '';
	}
	if (conv.threadState === 'loading' || conv.threadState === 'idle') {
		return '<p id="chat-conv-loading" class="text-center text-sm text-gray-400 pt-10">Loading messages\u2026</p>';
	}
	if (conv.threadState === 'error') {
		return '<div id="chat-conv-error" class="text-center pt-10"><p class="text-sm text-gray-500">Couldn\u2019t load messages.</p><button id="chat-conv-retry-btn" type="button" class="mt-3 px-4 py-2 rounded-full bg-gray-100 text-sm font-semibold text-gray-900 active:bg-gray-200" data-chat-retry-history="1">Try again</button></div>';
	}
	return '<p id="chat-conv-empty" class="text-center text-sm text-gray-400 pt-10">No messages yet. Say hi!</p>';
}

// Delegated clicks inside the thread (the thread HTML is re-rendered often).
document.getElementById('chat-conv-thread').addEventListener('click', function (e) {
	const retry = e.target.closest('[data-chat-retry]');
	if (retry) { chatRetrySend(retry.dataset.chatRetry); return; }
	if (e.target.closest('[data-chat-retry-history]')) { chatRetryHistory(); return; }
	if (e.target.closest('[data-chat-load-earlier]')) { chatLoadEarlier(); }
});
