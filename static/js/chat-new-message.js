// ---- New message + New group screens (templates/partials/chat_new_message.html) ----
// Opened by the Chats list FAB. "New message" lists people you can DM (search by
// name or username, live), has a "Create a group" row, and tapping a person opens
// the existing direct conversation with them or starts a new one. "New group" lets
// you pick participants + an optional name and creates a group conversation.
//
// Conversations are client-side only, like the rest of chat (chatMockMessages /
// chatMockThreads in chat.js): nothing is persisted and a reload resets them.
//
// User data (see "User directory" below):
//  - typed query: GET /api/search?type=people (existing endpoint, matches
//    name/username/bio; results are narrowed here to name + username)
//  - empty query: people from the existing direct conversations in chatMockMessages.
//    There is no "list all users" endpoint yet (backend is written separately), so
//    chatDirectoryLocal() is the single place to swap once one exists.
//
// Loaded after chat.js (uses chatMockMessages, chatMockThreads, chatAvatarUrl,
// openChatConversation, chatListRestoreOnce / chatListScrollY) and feed.js (escapeHtml).
(function () {
	const SEARCH_DEBOUNCE_MS = 250;
	const REMOTE_LIMIT = 30;
	const MIN_GROUP_MEMBERS = 2;

	// ---- User directory ----
	// A user is { key, id, name, handle, avatar }. `key` is the lowercase handle and is
	// what de-duplicates local and remote results and identifies a row.
	function normalizeQuery(q) {
		return (q || '').trim().replace(/^@+/, '').toLowerCase();
	}

	function matches(user, q) {
		return user.name.toLowerCase().includes(q) || user.handle.toLowerCase().includes(q);
	}

	// Direct-message contacts already in the Chats list (groups excluded).
	function chatDirectoryLocal(q) {
		return chatMockMessages
			.filter(function (m) { return !m.isGroup && m.handle; })
			.map(function (m) {
				return { key: m.handle.toLowerCase(), id: null, name: m.name, handle: m.handle, avatar: m.avatar || null };
			})
			.filter(function (u) { return !q || matches(u, q); });
	}

	// Throws on network/HTTP failure; resolves to users already narrowed to name/username.
	async function chatDirectoryRemote(q) {
		const params = new URLSearchParams({ q: q, type: 'people', limit: String(REMOTE_LIMIT) });
		const res = await fetch('/api/search?' + params.toString());
		if (!res.ok) throw new Error('search failed: ' + res.status);
		const data = await res.json();
		return (data.people || [])
			.map(function (p) {
				const handle = p.handle || p.username || '';
				return { key: handle.toLowerCase(), id: p.id, name: p.full_name || handle, handle: handle, avatar: p.profile_picture || null };
			})
			.filter(function (u) { return u.handle && matches(u, q); });
	}

	function mergeUsers(first, second) {
		const seen = new Set();
		return first.concat(second).filter(function (u) {
			if (seen.has(u.key)) return false;
			seen.add(u.key);
			return true;
		});
	}

	// ---- Reusable searchable user list (one instance per screen) ----
	// cfg: { input, list, rowHtml(user) -> html, onPick(user) }
	// Typing re-filters instantly from local contacts, then merges server results
	// (debounced; stale responses are dropped via `seq`). No submit needed.
	function createUserPicker(cfg) {
		let users = [];
		let query = '';
		let loading = false;
		let failed = false;
		let seq = 0;
		let timer = null;
		const byKey = new Map();

		function emptyMessage() {
			if (!query) return 'Search for people by name or username.';
			if (loading) return 'Searching\u2026';
			if (failed) return 'Couldn\u2019t search right now. Try again.';
			return 'No users found.';
		}

		function render() {
			byKey.clear();
			users.forEach(function (u) { byKey.set(u.key, u); });
			if (users.length === 0) {
				cfg.list.innerHTML = '<p class="text-center text-sm text-gray-400 px-6 pt-10">' + escapeHtml(emptyMessage()) + '</p>';
				return;
			}
			cfg.list.innerHTML = users.map(cfg.rowHtml).join('');
		}

		async function fetchRemote(q, mySeq) {
			try {
				const remote = await chatDirectoryRemote(q);
				if (mySeq !== seq) return; // a newer query superseded this one
				failed = false;
				users = mergeUsers(chatDirectoryLocal(q), remote);
			} catch (err) {
				if (mySeq !== seq) return;
				failed = true;
			}
			loading = false;
			render();
		}

		function setQuery(raw) {
			clearTimeout(timer);
			seq += 1;
			query = normalizeQuery(raw);
			failed = false;
			users = chatDirectoryLocal(query);
			if (!query) {
				loading = false;
			} else {
				loading = true;
				const mySeq = seq;
				timer = setTimeout(function () { fetchRemote(query, mySeq); }, SEARCH_DEBOUNCE_MS);
			}
			render();
		}

		cfg.input.addEventListener('input', function () { setQuery(cfg.input.value); });
		cfg.list.addEventListener('click', function (e) {
			const row = e.target.closest('[data-user-key]');
			if (!row) return;
			const user = byKey.get(row.dataset.userKey);
			if (user) cfg.onPick(user);
		});

		return {
			refresh: function () { setQuery(cfg.input.value); }, // re-read the field, reload the list
			rerender: render                                     // same users, e.g. after a selection change
		};
	}

	function userRowInner(user) {
		return '<img src="' + escapeHtml(chatAvatarUrl(user.handle, user.avatar)) + '" alt="" class="w-11 h-11 rounded-full object-cover bg-gray-100 shrink-0">' +
			'<div class="flex-1 min-w-0 ml-3">' +
				'<p class="font-bold text-gray-900 text-[15px] leading-tight truncate">' + escapeHtml(user.name) + '</p>' +
				'<p class="text-gray-500 text-[14px] leading-snug truncate">@' + escapeHtml(user.handle) + '</p>' +
			'</div>';
	}

	// ---- New message screen ----
	const nmInput = document.getElementById('chat-new-message-search');
	const nmList = document.getElementById('chat-new-message-list');
	if (!nmInput || !nmList) return;

	const nmPicker = createUserPicker({
		input: nmInput,
		list: nmList,
		rowHtml: function (u) {
			return '<button type="button" class="w-full flex items-center px-4 py-2.5 text-left active:bg-gray-50" data-user-key="' + escapeHtml(u.key) + '">' + userRowInner(u) + '</button>';
		},
		onPick: openDirectConversation
	});

	let nmRestoreOnce = false; // set when returning from New group so the search text survives

	window.openChatNewMessage = function () {
		chatListScrollY = window.scrollY; // so Cancel can put the list back where it was
		showView('chat-new-message');
	};

	window.initChatNewMessageView = function () {
		if (nmRestoreOnce) {
			nmRestoreOnce = false;
			nmPicker.refresh();
			return;
		}
		nmInput.value = '';
		nmPicker.refresh();
		window.scrollTo(0, 0);
	};

	// Cancel: back to the Chats list exactly as it was (filter tab, search text, scroll).
	window.closeChatNewMessage = function () {
		chatListRestoreOnce = true;
		showView('chat');
		window.scrollTo(0, chatListScrollY);
	};

	// Existing direct conversation with this person, else start a new one.
	function openDirectConversation(user) {
		let conv = chatMockMessages.find(function (m) { return !m.isGroup && m.handle && m.handle.toLowerCase() === user.key; });
		if (!conv) {
			conv = {
				id: 'u-' + (user.id != null ? user.id : user.key),
				name: user.name,
				handle: user.handle,
				avatar: user.avatar,
				preview: '',
				time: '',
				unread: 0
			};
			chatMockThreads[conv.id] = []; // empty thread: no phantom incoming message
			chatMockMessages.unshift(conv);
		}
		openChatConversation(conv.id);
	}

	// ---- New group screen ----
	const ngName = document.getElementById('chat-new-group-name');
	const ngInput = document.getElementById('chat-new-group-search');
	const ngList = document.getElementById('chat-new-group-list');
	const ngChips = document.getElementById('chat-new-group-chips');
	const ngCreate = document.getElementById('chat-new-group-create-btn');
	const ngHint = document.getElementById('chat-new-group-hint');
	if (!ngName || !ngInput || !ngList || !ngChips || !ngCreate || !ngHint) return;

	const selected = new Map(); // key -> user, insertion-ordered

	const ngPicker = createUserPicker({
		input: ngInput,
		list: ngList,
		rowHtml: function (u) {
			const on = selected.has(u.key);
			const box = on
				? '<span class="w-6 h-6 rounded-full bg-brand-red text-white flex items-center justify-center shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>'
				: '<span class="w-6 h-6 rounded-full border-2 border-gray-300 shrink-0"></span>';
			return '<button type="button" class="w-full flex items-center px-4 py-2.5 text-left active:bg-gray-50" role="checkbox" aria-checked="' + on + '" data-user-key="' + escapeHtml(u.key) + '">' + userRowInner(u) + box + '</button>';
		},
		onPick: function (u) {
			if (selected.has(u.key)) selected.delete(u.key);
			else selected.set(u.key, u);
			syncGroupUi();
			ngPicker.rerender();
		}
	});

	function syncGroupUi() {
		const users = Array.from(selected.values());
		ngChips.classList.toggle('hidden', users.length === 0);
		ngChips.innerHTML = users.map(function (u) {
			return '<button type="button" class="flex items-center gap-1.5 bg-gray-100 rounded-full pl-1 pr-2.5 py-1 text-[13px] text-gray-900 active:opacity-70" data-chip-key="' + escapeHtml(u.key) + '" aria-label="Remove ' + escapeHtml(u.name) + '">' +
				'<img src="' + escapeHtml(chatAvatarUrl(u.handle, u.avatar)) + '" alt="" class="w-5 h-5 rounded-full object-cover bg-gray-200">' +
				'<span class="max-w-[120px] truncate">' + escapeHtml(u.name) + '</span>' +
				'<svg class="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"></path></svg>' +
				'</button>';
		}).join('');
		const ok = users.length >= MIN_GROUP_MEMBERS;
		ngCreate.disabled = !ok;
		ngHint.textContent = users.length === 0
			? 'Select at least ' + MIN_GROUP_MEMBERS + ' people.'
			: users.length + ' selected' + (ok ? '' : ' \u2022 select at least ' + MIN_GROUP_MEMBERS);
	}

	ngChips.addEventListener('click', function (e) {
		const chip = e.target.closest('[data-chip-key]');
		if (!chip) return;
		selected.delete(chip.dataset.chipKey);
		syncGroupUi();
		ngPicker.rerender();
	});

	window.openChatNewGroup = function () {
		showView('chat-new-group');
	};

	window.initChatNewGroupView = function () {
		selected.clear();
		ngName.value = '';
		ngInput.value = '';
		syncGroupUi();
		ngPicker.refresh();
		window.scrollTo(0, 0);
	};

	// Cancel: back to New message with its search text intact.
	window.closeChatNewGroup = function () {
		nmRestoreOnce = true;
		showView('chat-new-message');
	};

	window.createChatGroup = function () {
		const users = Array.from(selected.values());
		if (users.length < MIN_GROUP_MEMBERS) return;
		const id = 'g-' + Date.now();
		const conv = {
			id: id,
			name: '',
			customName: ngName.value.trim(), // empty = system-generated name
			handle: id, // seeds the generated avatar
			avatar: null,
			preview: '',
			time: '',
			unread: 0,
			isGroup: true
		};
		chatSetGroupMembers(conv, users.map(function (u) { return { id: u.id, name: u.name, handle: u.handle }; }));
		if (conv.customName) conv.name = conv.customName;
		chatMockThreads[id] = [];
		chatMockMessages.unshift(conv);
		openChatConversation(id);
	};
})();
