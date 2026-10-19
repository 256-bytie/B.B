// Chat view + conversation screen.
//
// Direct (1:1) conversations are REAL: loaded from /api/chat/* and kept live by
// long-polling (chat-sync.js). Their conversation objects carry `remote: true`
// (id 'd<serverId>', `serverId`, `userId`); their threads hold server messages.
// Groups and the other UI-only features (group info, row menu actions, message
// requests) are still client-side only: they start EMPTY, nothing is seeded, and
// they are lost on reload. See docs/CHATS_FLOW_DOCUMENTATION.md.

let chatConversations = [];

// Active Messages filter: 'all' | 'unread' | 'groups'.
let chatActiveFilter = 'all';

// Message requests have no backend yet: the screen shows its empty state.
let chatRequestsNew = [];
let chatRequestsEarlier = [];

// Threads keyed by conversation id. from: 'them' | 'me'.
// Remote DM message: { id, from, text, time, createdAt, clientId, state }
// where state is 'sent' | 'sending' | 'failed' (id is null until the server confirms).
const chatThreads = {};

// ---- Group names ----
// A group is either user-named (`customName` set: always kept) or system-named
// (`customName` empty: `name` is derived from `members` and re-derived whenever
// they change). `name` stays the single display field read by the list, the
// conversation header, forward picker, etc.
// Format: "A", "A and B", "A, B and N other(s)" (display names of the members).
function chatGeneratedGroupName(members) {
	const names = members.map(m => m.name).filter(Boolean);
	if (names.length <= 2) return names.join(' and ');
	const others = names.length - 2;
	return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'}`;
}

// Single entry point for changing a group's membership; refreshes the
// generated name unless the group has a custom one.
function chatSetGroupMembers(conv, members) {
	conv.members = members;
	if (!conv.customName) conv.name = chatGeneratedGroupName(members);
}

// Fills in every per-group field (roles, settings) a group may be missing, so
// the Group info screen can rely on them. Idempotent. A group that predates the
// custom/generated split keeps its current name as a custom name.
// myRole: 'admin' | 'member' (the signed-in user's role in THIS group).
function chatEnsureGroupModel(conv) {
	if (!conv || !conv.isGroup) return conv;
	if (conv.customName === undefined) conv.customName = conv.name;
	conv.members = conv.members || [];
	conv.myRole = conv.myRole || 'member';
	conv.muted = !!conv.muted;
	conv.disappearing = conv.disappearing || 'off'; // 'off' | '24h' | '7d' | '90d'
	conv.blockScreenshots = !!conv.blockScreenshots;
	conv.inviteLink = conv.inviteLink || { enabled: false, code: '' };
	conv.permissions = Object.assign({ editInfo: 'everyone', addMembers: 'everyone' }, conv.permissions); // 'everyone' | 'admins'
	return conv;
}

// Conversation header (avatar + name) for a conversation; also called after a rename.
function refreshChatConversationHeader(conv) {
	document.getElementById('chat-conv-avatar').src = chatAvatarUrl(conv.handle, conv.avatar);
	document.getElementById('chat-conv-avatar').alt = conv.name;
	document.getElementById('chat-conv-name').textContent = conv.name;
}

function chatAvatarUrl(handle, avatar) {
	return avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
}

// Delivery status icon for outgoing messages: 'sent' = single grey tick,
// 'delivered' = double grey ticks, 'read' = double green ticks.
function chatStatusIconHtml(status, sizeClass) {
	const st = status || 'sent';
	const color = st === 'read' ? 'text-green-500' : 'text-gray-500';
	const path = st === 'sent'
		? 'M5 13l4 4L19 7'
		: 'M1.5 13l4.5 4.5L15 7.5M9 15.5l1 1L19.5 6.5';
	return `<svg class="${sizeClass} ${color} shrink-0" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-label="${st}" role="img"><path d="${path}" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

// Last message of a conversation's thread, or null if it has no thread yet
// (e.g. an accepted request: its preview is an incoming message).
function chatLastMessage(conv) {
	const thread = chatThreads[conv.id];
	return thread && thread.length ? thread[thread.length - 1] : null;
}

// Re-render the Messages list each time the view opens, and reset the search
// field / filter so it doesn't carry stale state between visits (mirrors the
// feed/profile view-init hooks in core.js).
// Set by closeChatNewMessage() (chat-new-message.js) so cancelling out of the New
// message screen returns to the list exactly as it was left (filter tab, search
// text, scroll position) instead of the usual reset below.
let chatListRestoreOnce = false;
let chatListScrollY = 0;

function initChatView() {
	if (chatListRestoreOnce) {
		chatListRestoreOnce = false;
		updateChatFilterUi();
		renderChatMessages(); // reads the still-intact search field + active filter
		chatSyncInit();
		return;
	}
	document.getElementById('chat-search-row').classList.add('hidden');
	const input = document.getElementById('chat-search-input');
	if (input) input.value = '';
	chatActiveFilter = 'all';
	updateChatFilterUi();
	renderChatMessages();
	chatSyncInit(); // load real conversations + start live updates
}

// ---- Header "more options" menu (⋮) ----
// Popover under the ⋮ button with one item: Requests (opens the Message Requests screen).
function toggleChatMenu() {
	const popover = document.getElementById('chat-menu-popover');
	if (!popover) return;
	if (popover.classList.contains('hidden')) openChatMenu();
	else closeChatMenu();
}

function openChatMenu() {
	document.getElementById('chat-menu-popover').classList.remove('hidden');
	document.getElementById('chat-menu-backdrop').classList.remove('hidden');
	document.getElementById('chat-menu-btn').setAttribute('aria-expanded', 'true');
}

function closeChatMenu() {
	const popover = document.getElementById('chat-menu-popover');
	if (!popover) return;
	popover.classList.add('hidden');
	document.getElementById('chat-menu-backdrop').classList.add('hidden');
	document.getElementById('chat-menu-btn').setAttribute('aria-expanded', 'false');
}

function openChatRequestsFromMenu() {
	closeChatMenu();
	openChatRequests();
}

document.addEventListener('keydown', function (e) {
	if (e.key === 'Escape') closeChatMenu();
});

function toggleChatSearch() {
	const row = document.getElementById('chat-search-row');
	row.classList.toggle('hidden');
	if (!row.classList.contains('hidden')) {
		const input = document.getElementById('chat-search-input');
		if (input) input.focus();
	} else {
		const input = document.getElementById('chat-search-input');
		if (input) input.value = '';
		renderChatMessages();
	}
}

function filterChatMessages(query) {
	renderChatMessages(query);
}

function setChatFilter(filter) {
	chatActiveFilter = filter;
	updateChatFilterUi();
	const input = document.getElementById('chat-search-input');
	renderChatMessages(input ? input.value : '');
}

function updateChatFilterUi() {
	const on = ['bg-white', 'text-gray-900', 'font-semibold', 'shadow-sm'];
	const off = ['text-gray-500', 'font-medium'];
	['all', 'unread', 'groups'].forEach(f => {
		const btn = document.getElementById(`chat-filter-${f}`);
		if (!btn) return;
		const active = f === chatActiveFilter;
		btn.classList.add(...(active ? on : off));
		btn.classList.remove(...(active ? off : on));
		btn.setAttribute('aria-selected', active ? 'true' : 'false');
	});
}

function renderChatMessages(query) {
	const container = document.getElementById('chat-messages-list');
	if (query === undefined) {
		const input = document.getElementById('chat-search-input');
		query = input ? input.value : '';
	}
	const q = (query || '').trim().toLowerCase();
	// Most recent activity first (remote: last message time; local groups: creation time).
	let rows = chatConversations.slice().sort((a, b) => (b.activity || 0) - (a.activity || 0));
	if (chatActiveFilter === 'unread') rows = rows.filter(m => m.unread > 0);
	else if (chatActiveFilter === 'groups') rows = rows.filter(m => m.isGroup);
	if (q) rows = rows.filter(m => m.name.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q));

	if (rows.length === 0) {
		if (chatListStatus === 'loading' && chatConversations.length === 0) {
			container.innerHTML = '<p id="chat-list-loading" class="text-center text-sm text-gray-400 pt-16">Loading conversations\u2026</p>';
		} else if (chatListStatus === 'error' && chatConversations.length === 0) {
			container.innerHTML = '<div id="chat-list-error" class="text-center pt-16 px-6"><p class="text-sm text-gray-500">Couldn\u2019t load your conversations.</p><button id="chat-list-retry-btn" type="button" class="mt-3 px-4 py-2 rounded-full bg-gray-100 text-sm font-semibold text-gray-900 active:bg-gray-200" onclick="chatReloadConversations()">Try again</button></div>';
		} else {
			const msg = q ? 'No messages found.'
				: chatActiveFilter === 'unread' ? 'No unread messages.'
				: chatActiveFilter === 'groups' ? 'No group chats yet.'
				: 'No conversations yet. Tap the chat button to start one.';
			container.innerHTML = `<p class="text-center text-sm text-gray-400 px-6 pt-16">${msg}</p>`;
		}
		return;
	}

	container.innerHTML = rows.map(m => {
		const last = m.remote ? null : chatLastMessage(m); // real DMs show no delivery ticks
		const statusIcon = last && last.from === 'me' ? chatStatusIconHtml(last.status, 'w-4 h-4 mr-1') : '';
		return `
		<div id="chat-row-${m.id}" data-chat-row-id="${m.id}" class="chat-row flex items-center px-4 py-3 border-b border-gray-100 cursor-pointer active:bg-gray-50" role="button" tabindex="0" onclick="openChatConversation('${m.id}')" onkeydown="if (event.key === 'Enter') openChatConversation('${m.id}')">
			<div class="relative shrink-0">
				<img src="${chatAvatarUrl(m.handle, m.avatar)}" alt="${escapeHtml(m.name)}" class="w-12 h-12 rounded-full object-cover bg-gray-100">
			</div>
			<div class="flex-1 min-w-0 ml-3">
				<p class="font-bold text-gray-900 text-[15px] leading-tight truncate">${escapeHtml(m.name)}</p>
				<p class="flex items-center text-gray-500 text-[13px] leading-snug mt-0.5">${statusIcon}<span class="truncate">${escapeHtml(m.preview)}</span></p>
			</div>
			<div class="flex flex-col items-end ml-2 shrink-0">
				<span class="text-[11px] text-gray-500">${m.time}</span>
				${m.unread > 0 ? `<span class="mt-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-red text-white text-[11px] font-semibold leading-none flex items-center justify-center">${m.unread}</span>` : ''}
			</div>
		</div>`;
	}).join('');
}

// ---- Message Requests screen (templates/partials/chat_requests.html) ----
// Separate full-screen view (`chat-requests`), opened from the Chats list ⋮ menu.
function openChatRequests() {
	showView('chat-requests'); // initChatRequestsView renders the lists
}

function closeChatRequests() {
	showView('chat'); // initChatView re-renders Messages (picks up accepted requests)
}

function initChatRequestsView() {
	renderChatRequests();
	window.scrollTo(0, 0);
}

function renderChatRequests() {
	const emptyState = document.getElementById('chat-requests-empty');
	const list = document.getElementById('chat-requests-list');
	const hasRequests = chatRequestsNew.length > 0 || chatRequestsEarlier.length > 0;

	if (!hasRequests) {
		emptyState.classList.remove('hidden');
		emptyState.classList.add('flex');
		list.innerHTML = '';
		return;
	}
	emptyState.classList.add('hidden');
	emptyState.classList.remove('flex');

	const section = (label, rows) => {
		if (rows.length === 0) return '';
		return `
			<p class="px-4 pt-4 pb-2 text-xs font-bold text-gray-400 tracking-wide uppercase">${label}</p>
			${rows.map(r => chatRequestRow(r)).join('')}
		`;
	};

	list.innerHTML = section('New requests', chatRequestsNew) + section('Earlier', chatRequestsEarlier);
}

function chatRequestRow(r) {
	return `
		<div class="flex items-start px-4 py-3 border-b border-gray-100" id="chat-request-${r.id}">
			<img src="${escapeHtml(chatAvatarUrl(r.handle, r.avatar))}" alt="${escapeHtml(r.name)}" class="w-12 h-12 rounded-full object-cover shrink-0 bg-gray-100">
			<div class="flex-1 min-w-0 ml-3">
				<p class="font-bold text-gray-900 text-sm truncate">${escapeHtml(r.name)}</p>
				<p class="text-gray-500 text-sm line-clamp-2">${escapeHtml(r.preview)}</p>
			</div>
			<div class="flex flex-col items-end ml-2 shrink-0">
				<span class="text-xs text-gray-500 mb-2">${escapeHtml(r.time)}</span>
				<div class="flex items-center gap-2">
					<button id="chat-request-decline-${r.id}" type="button" class="w-8 h-8 rounded-full bg-gray-100 text-gray-500 flex items-center justify-center hover:bg-gray-200" onclick="declineChatRequest('${r.id}')" aria-label="Decline">
						<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
							<path d="M6 18L18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"></path>
						</svg>
					</button>
					<button id="chat-request-accept-${r.id}" type="button" class="w-8 h-8 rounded-full bg-brand-red text-white flex items-center justify-center hover:bg-red-700" onclick="acceptChatRequest('${r.id}')" aria-label="Accept">
						<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
							<path d="M4.5 12.75l6 6 9-13.5" stroke-linecap="round" stroke-linejoin="round"></path>
						</svg>
					</button>
				</div>
			</div>
		</div>
	`;
}

function findChatRequest(id) {
	return chatRequestsNew.find(r => r.id === id) || chatRequestsEarlier.find(r => r.id === id);
}

function removeChatRequest(id) {
	chatRequestsNew = chatRequestsNew.filter(r => r.id !== id);
	chatRequestsEarlier = chatRequestsEarlier.filter(r => r.id !== id);
}

function acceptChatRequest(id) {
	const request = findChatRequest(id);
	if (request) {
		chatConversations.unshift({
			id: `m-${request.id}`,
			name: request.name,
			handle: request.handle,
			avatar: request.avatar,
			preview: request.preview,
			time: request.time,
			unread: 0,
		});
	}
	removeChatRequest(id);
	renderChatRequests(); // stays on the requests screen; Messages refreshes when you go back
}

function declineChatRequest(id) {
	removeChatRequest(id);
	renderChatRequests();
}


// ---- Conversation screen (templates/partials/chat_conversation.html) ----
let chatActiveConversationId = null;

function chatThreadFor(conv) {
	if (!chatThreads[conv.id]) {
		// Real DMs start empty and are filled from the server. A local conversation
		// with a preview (e.g. an accepted request) gets that preview as its message.
		chatThreads[conv.id] = (!conv.remote && conv.preview) ? [{ from: 'them', text: conv.preview, time: conv.time }] : [];
	}
	return chatThreads[conv.id];
}

function openChatConversation(id) {
	const conv = chatConversations.find(m => m.id === id);
	if (!conv) return;
	chatActiveConversationId = id;
	clearChatReplyTarget(); // a pending reply never carries into another thread
	closeChatGifPicker(); // never carry an open picker into another thread
	conv.unread = 0; // opening a thread reads it

	refreshChatConversationHeader(conv);
	// There is no presence backend: real DMs show no status line, groups show "Group".
	const statusEl = document.getElementById('chat-conv-status');
	statusEl.classList.toggle('hidden', !!conv.remote);
	document.getElementById('chat-conv-status-text').textContent = 'Group';
	document.getElementById('chat-conv-dot').classList.add('hidden');
	document.getElementById('chat-conv-input').value = '';

	renderChatConversation();
	showView('chat-conversation');
	scrollChatConversationToBottom();
	if (conv.remote) chatSyncOpenConversation(conv); // fetch history, mark read
}

function closeChatConversation() {
	if (typeof closeChatMessageSheet === 'function') closeChatMessageSheet();
	closeChatGifPicker();
	clearChatReplyTarget();
	chatActiveConversationId = null;
	showView('chat'); // initChatView re-renders the list with updated previews
}

// Label for a reply quote: "You" for own messages, the other person's name otherwise.
function chatReplyLabel(from, conv) {
	return from === 'me' ? 'You' : conv.name;
}

// "Forwarded" tag + quoted reply block shown at the top of a bubble.
function chatBubbleLeadHtml(msg, conv, mine) {
	let html = '';
	if (msg.forwarded) {
		html += `<p class="flex items-center gap-1 text-[13px] italic mb-1 ${mine ? 'text-white/80' : 'text-gray-500'}"><svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="m15 14 5-5-5-5"></path><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"></path></svg>Forwarded</p>`;
	}
	if (msg.replyTo) {
		html += `<div class="mb-2 pl-2.5 py-1 pr-2 rounded-lg border-l-[3px] ${mine ? 'bg-black/10 border-white/70' : 'bg-black/5 border-gray-400'}"><p class="text-[13px] font-semibold ${mine ? 'text-white' : 'text-gray-900'} truncate">${escapeHtml(chatReplyLabel(msg.replyTo.from, conv))}</p><p class="text-[14px] line-clamp-2 ${mine ? 'text-white/90' : 'text-gray-500'}">${escapeHtml(msg.replyTo.text)}</p></div>`;
	}
	return html;
}

// Reaction chip hanging off the bubble's lower edge. reactions = { me?, them? }.
function chatReactionChipHtml(msg, mine) {
	const r = msg.reactions;
	if (!r) return '';
	const counts = {};
	[r.them, r.me].filter(Boolean).forEach(e => { counts[e] = (counts[e] || 0) + 1; });
	const emojis = Object.keys(counts);
	if (!emojis.length) return '';
	const inner = emojis.map(e => `<span>${escapeHtml(e)}${counts[e] > 1 ? `<span class="ml-0.5 text-[12px] text-gray-500">${counts[e]}</span>` : ''}</span>`).join('');
	return `<div class="chat-reaction-chip relative -mt-2.5 ${mine ? 'self-end mr-3' : 'inline-flex ml-3'} flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-gray-200 shadow-sm text-[15px] leading-tight">${inner}</div>`;
}

// `index` is the message's position in its thread; the long-press handler
// (chat-message-actions.js) reads it back from data-chat-msg-index.
function chatBubbleHtml(msg, conv, index) {
	const text = escapeHtml(msg.text);
	const time = escapeHtml(msg.time);
	const mine = msg.from === 'me';
	const attrs = `data-chat-msg-index="${index}" tabindex="0" aria-haspopup="dialog"`;
	const lead = chatBubbleLeadHtml(msg, conv, mine);
	const chip = chatReactionChipHtml(msg, mine);
	// GIF and sticker messages (body "[gif:<id>]" / "[sticker:<file>]", see chat-gif.js)
	// render as an image. Without a reply/forward header they drop the bubble chrome;
	// with one they keep the bubble.
	const gifId = chatParseGif(msg.text);
	const stickerId = gifId ? null : chatParseSticker(msg.text);
	const mediaHtml = gifId ? chatGifImgHtml(gifId) : (stickerId ? chatStickerImgHtml(stickerId) : '');
	const bareMedia = !!mediaHtml && !lead;
	const content = mediaHtml || text;
	const bubbleSize = mediaHtml ? 'p-2' : 'px-4 py-2.5';
	const mineBubbleCls = bareMedia ? 'chat-msg-gif' : `bg-brand-red text-white text-[16px] leading-[1.45] rounded-[22px] ${bubbleSize} break-words`;
	const themBubbleCls = bareMedia ? 'chat-msg-gif' : `bg-gray-100 text-gray-900 text-[16px] leading-[1.45] rounded-[22px] ${bubbleSize} break-words`;
	if (mine) {
		return `
		<div class="flex flex-col items-end">
			<div class="chat-msg-bubble max-w-[78%] ${mineBubbleCls}" ${attrs}>${lead}${content}</div>
			${chip}
			${conv.remote ? chatRemoteMetaHtml(msg, time) : `<div class="flex items-center gap-1.5 mt-1.5 text-[13px] text-gray-500"><span>${time}</span>${chatStatusIconHtml(msg.status, 'w-[18px] h-[18px]')}</div>`}
		</div>`;
	}
	return `
		<div class="flex items-start gap-3">
			<img src="${escapeHtml(chatAvatarUrl(conv.handle, conv.avatar))}" alt="" class="w-10 h-10 rounded-full object-cover bg-gray-100 shrink-0">
			<div class="min-w-0 max-w-[78%]">
				<div class="chat-msg-bubble ${themBubbleCls}" ${attrs}>${lead}${content}</div>
				${chip}
				<p class="mt-1.5 text-[13px] text-gray-500">${time}</p>
			</div>
		</div>`;
}

function renderChatConversation() {
	const conv = chatConversations.find(m => m.id === chatActiveConversationId);
	if (!conv) return;
	const thread = chatThreadFor(conv);
	chatRenderDayLabel(conv, thread);
	document.getElementById('chat-conv-thread').innerHTML =
		(conv.remote ? chatRemoteThreadPrefixHtml(conv, thread.length > 0) : '') +
		thread.map((msg, i) => chatBubbleHtml(msg, conv, i)).join('');
}

function scrollChatConversationToBottom() {
	const scroll = document.getElementById('chat-conv-scroll');
	scroll.scrollTop = scroll.scrollHeight;
}

// ---- Reply state ----
// Snapshot of the message being replied to ({ from, text }), or null. Set by the
// Reply action (chat-message-actions.js); shown in #chat-reply-bar above the
// composer and attached to the next sent message as `replyTo`.
let chatReplyTarget = null;

function setChatReplyTarget(target) {
	chatReplyTarget = target;
	renderChatReplyBar();
}

function clearChatReplyTarget() {
	chatReplyTarget = null;
	renderChatReplyBar();
}

function renderChatReplyBar() {
	const bar = document.getElementById('chat-reply-bar');
	if (!bar) return;
	if (!chatReplyTarget) {
		bar.classList.add('hidden');
		return;
	}
	const conv = chatConversations.find(m => m.id === chatActiveConversationId);
	document.getElementById('chat-reply-bar-name').textContent = conv ? chatReplyLabel(chatReplyTarget.from, conv) : '';
	document.getElementById('chat-reply-bar-text').textContent = chatReplyTarget.text;
	bar.classList.remove('hidden');
}

// Re-derive a list row's preview/time from its thread (after a delete).
// An emptied thread leaves a blank preview/time.
function chatSyncListRowToThread(conv) {
	const last = chatLastMessage(conv);
	conv.preview = last ? chatPreviewText(last.text) : '';
	conv.time = last ? last.time : '';
}

// Real DMs go through chatSendRemote (chat-sync.js). Groups stay client-side only:
// appends to the in-memory thread and updates the list row; nothing is persisted.
function sendChatMessage() {
	const input = document.getElementById('chat-conv-input');
	const text = input.value.trim();
	const conv = chatConversations.find(m => m.id === chatActiveConversationId);
	if (!text || !conv) return;
	input.value = '';
	chatDispatchMessage(text);
	input.focus();
}

// Appends `text` to the active conversation as a sent message (real DMs go through
// chat-sync.js; groups stay client-side). Shared by the composer and the GIF
// picker (chat-gif.js), so neither touches the other's draft. Returns false when
// there is no active conversation.
function chatDispatchMessage(text) {
	const conv = chatConversations.find(m => m.id === chatActiveConversationId);
	if (!text || !conv) return false;

	if (conv.remote) { // real DM: server-backed, optimistic with failure/retry (chat-sync.js)
		clearChatReplyTarget();
		chatSendRemote(conv, text);
		return true;
	}

	const time = new Date().toTimeString().slice(0, 5);
	const msg = { from: 'me', text, time, status: 'sent' };
	if (chatReplyTarget) msg.replyTo = { from: chatReplyTarget.from, text: chatReplyTarget.text };
	chatThreadFor(conv).push(msg);
	conv.preview = chatPreviewText(text);
	conv.time = time;

	clearChatReplyTarget();
	renderChatConversation();
	scrollChatConversationToBottom();
	return true;
}
