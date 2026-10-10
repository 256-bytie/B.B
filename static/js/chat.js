// Chat view + conversation screen - mock-data-only for this pass (see HANDOVER.md §3/§5).
// No backend calls here: two lists (Messages on the Chats screen, Message
// Requests on their own screen) are seeded from inline mock arrays and mutated
// client-side only. State resets on reload.

let chatMockMessages = [
	{ id: 'm1', name: 'Persistence Tester', handle: 'persistence-tester', avatar: null, preview: 'Hey! How are you doing?', time: '23:15', unread: 2, online: true },
	{ id: 'm2', name: 'Test User', handle: 'test-user', avatar: null, preview: "Sure, let's meet tomorrow.", time: '20:10', unread: 1, online: false },
	{ id: 'm3', name: 'Not Lvke', handle: 'not-lvke', avatar: null, preview: 'Alright, thanks!', time: '18:45', unread: 0, online: true },
	{ id: 'm4', name: 'Design Hackathon 2026', handle: 'design-hackathon-2026', avatar: null, preview: 'Olivia sent a photo', time: '17:20', unread: 3, isGroup: true },
];

// Active Messages filter: 'all' | 'unread' | 'groups'.
let chatActiveFilter = 'all';

let chatMockRequestsNew = [
	{ id: 'r1', name: 'Emma Johnson', handle: 'emma-johnson', avatar: null, preview: 'Hi! I came across your profile and wanted to say hello.', time: '22:30' },
	{ id: 'r2', name: 'Daniel Lee', handle: 'daniel-lee', avatar: null, preview: "Hey, I'd like to connect with you.", time: '21:15' },
	{ id: 'r3', name: 'Sophia Brown', handle: 'sophia-brown', avatar: null, preview: 'Hello! Can we chat?', time: '19:45' },
];

let chatMockRequestsEarlier = [
	{ id: 'r4', name: 'Liam Wilson', handle: 'liam-wilson', avatar: null, preview: 'Sent you a message', time: 'Yesterday' },
	{ id: 'r5', name: 'Olivia Martinez', handle: 'olivia-martinez', avatar: null, preview: 'Sent you a message', time: '2d ago' },
];

// Hardcoded threads, keyed by chatMockMessages id. from: 'them' | 'me'.
// A conversation with no entry here (e.g. an accepted request) falls back to
// a single incoming message built from its preview (chatThreadFor). The list
// row's preview/time are derived from the thread's last message at seed time.
const chatMockThreads = {
	m1: [
		{ from: 'them', text: 'Hey! How are you doing?', time: '23:15' },
		{ from: 'me', text: "I'm doing well, thanks! How about you?", time: '23:16' },
		{ from: 'them', text: "I'm good too. Just working on a project right now.", time: '23:17' },
		{ from: 'me', text: "That's great! What kind of project is it?", time: '23:18' },
		{ from: 'them', text: "It's a mobile app. Almost done with the first version.", time: '23:19' },
		{ from: 'me', text: "Nice! Can't wait to see it.", time: '23:20', status: 'read' },
	],
	m2: [
		{ from: 'them', text: 'Are you free tomorrow?', time: '20:08' },
		{ from: 'me', text: 'I think so. What time works for you?', time: '20:09', status: 'delivered' },
		{ from: 'them', text: "Sure, let's meet tomorrow.", time: '20:10' },
	],
	m3: [
		{ from: 'me', text: 'Just sent over the notes.', time: '18:43', status: 'read' },
		{ from: 'them', text: 'Alright, thanks!', time: '18:45' },
	],
};

// Keep the Messages list consistent with each thread's last message.
chatMockMessages.forEach(m => {
	const thread = chatMockThreads[m.id];
	if (thread && thread.length) {
		m.preview = thread[thread.length - 1].text;
		m.time = thread[thread.length - 1].time;
	}
});

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
	const thread = chatMockThreads[conv.id];
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
		return;
	}
	document.getElementById('chat-search-row').classList.add('hidden');
	const input = document.getElementById('chat-search-input');
	if (input) input.value = '';
	chatActiveFilter = 'all';
	updateChatFilterUi();
	renderChatMessages();
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
	let rows = chatMockMessages;
	if (chatActiveFilter === 'unread') rows = rows.filter(m => m.unread > 0);
	else if (chatActiveFilter === 'groups') rows = rows.filter(m => m.isGroup);
	if (q) rows = rows.filter(m => m.name.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q));

	if (rows.length === 0) {
		const msg = q ? 'No messages found.'
			: chatActiveFilter === 'unread' ? 'No unread messages.'
			: chatActiveFilter === 'groups' ? 'No group chats yet.'
			: 'No messages found.';
		container.innerHTML = `<p class="text-center text-sm text-gray-400 pt-16">${msg}</p>`;
		return;
	}

	container.innerHTML = rows.map(m => {
		const last = chatLastMessage(m);
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
	const hasRequests = chatMockRequestsNew.length > 0 || chatMockRequestsEarlier.length > 0;

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

	list.innerHTML = section('New requests', chatMockRequestsNew) + section('Earlier', chatMockRequestsEarlier);
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
	return chatMockRequestsNew.find(r => r.id === id) || chatMockRequestsEarlier.find(r => r.id === id);
}

function removeChatRequest(id) {
	chatMockRequestsNew = chatMockRequestsNew.filter(r => r.id !== id);
	chatMockRequestsEarlier = chatMockRequestsEarlier.filter(r => r.id !== id);
}

function acceptChatRequest(id) {
	const request = findChatRequest(id);
	if (request) {
		chatMockMessages.unshift({
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
	if (!chatMockThreads[conv.id]) {
		chatMockThreads[conv.id] = [{ from: 'them', text: conv.preview, time: conv.time }];
	}
	return chatMockThreads[conv.id];
}

function openChatConversation(id) {
	const conv = chatMockMessages.find(m => m.id === id);
	if (!conv) return;
	chatActiveConversationId = id;
	clearChatReplyTarget(); // a pending reply never carries into another thread
	conv.unread = 0; // opening a thread reads it

	document.getElementById('chat-conv-avatar').src = chatAvatarUrl(conv.handle, conv.avatar);
	document.getElementById('chat-conv-avatar').alt = conv.name;
	document.getElementById('chat-conv-name').textContent = conv.name;
	// Presence comes from the mock `online` flag (groups show no presence).
	const online = !!conv.online && !conv.isGroup;
	document.getElementById('chat-conv-status-text').textContent = conv.isGroup ? 'Group' : (online ? 'Online' : 'Offline');
	const dot = document.getElementById('chat-conv-dot');
	dot.classList.toggle('bg-green-500', online);
	dot.classList.toggle('bg-gray-400', !online);
	dot.classList.toggle('hidden', !!conv.isGroup);
	document.getElementById('chat-conv-input').value = '';

	renderChatConversation();
	showView('chat-conversation');
	scrollChatConversationToBottom();
}

function closeChatConversation() {
	if (typeof closeChatMessageSheet === 'function') closeChatMessageSheet();
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
	if (mine) {
		return `
		<div class="flex flex-col items-end">
			<div class="chat-msg-bubble max-w-[78%] bg-brand-red text-white text-[16px] leading-[1.45] rounded-[22px] px-4 py-3 break-words" ${attrs}>${lead}${text}</div>
			${chip}
			<div class="flex items-center gap-1.5 mt-1.5 text-[13px] text-gray-500"><span>${time}</span>${chatStatusIconHtml(msg.status, 'w-[18px] h-[18px]')}</div>
		</div>`;
	}
	return `
		<div class="flex items-start gap-3">
			<img src="${escapeHtml(chatAvatarUrl(conv.handle, conv.avatar))}" alt="" class="w-10 h-10 rounded-full object-cover bg-gray-100 shrink-0">
			<div class="min-w-0 max-w-[78%]">
				<div class="chat-msg-bubble bg-gray-100 text-gray-900 text-[16px] leading-[1.45] rounded-[22px] px-4 py-3 break-words" ${attrs}>${lead}${text}</div>
				${chip}
				<p class="mt-1.5 text-[13px] text-gray-500">${time}</p>
			</div>
		</div>`;
}

function renderChatConversation() {
	const conv = chatMockMessages.find(m => m.id === chatActiveConversationId);
	if (!conv) return;
	document.getElementById('chat-conv-thread').innerHTML =
		chatThreadFor(conv).map((msg, i) => chatBubbleHtml(msg, conv, i)).join('');
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
	const conv = chatMockMessages.find(m => m.id === chatActiveConversationId);
	document.getElementById('chat-reply-bar-name').textContent = conv ? chatReplyLabel(chatReplyTarget.from, conv) : '';
	document.getElementById('chat-reply-bar-text').textContent = chatReplyTarget.text;
	bar.classList.remove('hidden');
}

// Re-derive a list row's preview/time from its thread (after a delete).
// An emptied thread leaves a blank preview/time.
function chatSyncListRowToThread(conv) {
	const last = chatLastMessage(conv);
	conv.preview = last ? last.text : '';
	conv.time = last ? last.time : '';
}

// Client-side only, like accept/decline: appends to the in-memory thread and
// updates the list row; nothing is persisted and a reload resets it.
function sendChatMessage() {
	const input = document.getElementById('chat-conv-input');
	const text = input.value.trim();
	const conv = chatMockMessages.find(m => m.id === chatActiveConversationId);
	if (!text || !conv) return;

	const time = new Date().toTimeString().slice(0, 5);
	const msg = { from: 'me', text, time, status: 'sent' };
	if (chatReplyTarget) msg.replyTo = { from: chatReplyTarget.from, text: chatReplyTarget.text };
	chatThreadFor(conv).push(msg);
	conv.preview = text;
	conv.time = time;

	input.value = '';
	clearChatReplyTarget();
	renderChatConversation();
	scrollChatConversationToBottom();
	input.focus();
}
