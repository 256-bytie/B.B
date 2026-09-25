// Chat view - mock-data-only for this pass (see HANDOVER.md §3/§5).
// No backend calls here: two lists (Messages, Requests) are seeded from
// inline mock arrays and mutated client-side only. State resets on reload.

let chatMockMessages = [
	{ id: 'm1', name: 'Persistence Tester', handle: 'persistence-tester', avatar: null, preview: 'Hey! How are you doing?', time: '23:15', unread: 2 },
	{ id: 'm2', name: 'Test User', handle: 'test-user', avatar: null, preview: "Sure, let's meet tomorrow.", time: '20:10', unread: 1 },
	{ id: 'm3', name: 'Not Lvke', handle: 'not-lvke', avatar: null, preview: 'Alright, thanks!', time: '18:45', unread: 0 },
];

let chatMockRequestsNew = [
	{ id: 'r1', name: 'Emma Johnson', handle: 'emma-johnson', avatar: null, preview: 'Hi! I came across your profile and wanted to say hello.', time: '22:30' },
	{ id: 'r2', name: 'Daniel Lee', handle: 'daniel-lee', avatar: null, preview: "Hey, I'd like to connect with you.", time: '21:15' },
	{ id: 'r3', name: 'Sophia Brown', handle: 'sophia-brown', avatar: null, preview: 'Hello! Can we chat?', time: '19:45' },
];

let chatMockRequestsEarlier = [
	{ id: 'r4', name: 'Liam Wilson', handle: 'liam-wilson', avatar: null, preview: 'Sent you a message', time: 'Yesterday' },
	{ id: 'r5', name: 'Olivia Martinez', handle: 'olivia-martinez', avatar: null, preview: 'Sent you a message', time: '2d ago' },
];

function chatAvatarUrl(handle, avatar) {
	return avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
}

// Re-seed and re-render everything each time the view opens, and reset
// the search field / active tab so it doesn't carry stale state between
// visits (mirrors the feed/profile view-init hooks in core.js).
function initChatView() {
	document.getElementById('chat-search-row').classList.add('hidden');
	const input = document.getElementById('chat-search-input');
	if (input) input.value = '';
	switchChatTab('messages');
	renderChatMessages();
	renderChatRequests();
}

function switchChatTab(tab) {
	const messagesTab = document.getElementById('chat-tab-messages');
	const requestsTab = document.getElementById('chat-tab-requests');
	const messagesView = document.getElementById('chat-messages-view');
	const requestsView = document.getElementById('chat-requests-view');

	const activeClasses = ['text-red-500', 'font-semibold', 'border-b-2', 'border-red-500'];
	const inactiveClasses = ['text-gray-500', 'font-medium'];

	if (tab === 'messages') {
		messagesTab.classList.add(...activeClasses);
		messagesTab.classList.remove(...inactiveClasses);
		requestsTab.classList.add(...inactiveClasses);
		requestsTab.classList.remove(...activeClasses);
		messagesView.classList.remove('hidden');
		requestsView.classList.add('hidden');
	} else {
		requestsTab.classList.add(...activeClasses);
		requestsTab.classList.remove(...inactiveClasses);
		messagesTab.classList.add(...inactiveClasses);
		messagesTab.classList.remove(...activeClasses);
		requestsView.classList.remove('hidden');
		messagesView.classList.add('hidden');
	}
}

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

function renderChatMessages(query) {
	const container = document.getElementById('chat-messages-list');
	const q = (query || '').trim().toLowerCase();
	const rows = q
		? chatMockMessages.filter(m => m.name.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q))
		: chatMockMessages;

	if (rows.length === 0) {
		container.innerHTML = '<p class="text-center text-sm text-gray-400 pt-16">No messages found.</p>';
		return;
	}

	container.innerHTML = rows.map(m => `
		<div class="flex items-center px-4 py-3 border-b border-gray-100">
			<img src="${chatAvatarUrl(m.handle, m.avatar)}" alt="${m.name}" class="w-12 h-12 rounded-full object-cover shrink-0 bg-gray-100">
			<div class="flex-1 min-w-0 ml-3">
				<p class="font-bold text-gray-900 text-sm truncate">${m.name}</p>
				<p class="text-gray-500 text-sm truncate">${m.preview}</p>
			</div>
			<div class="flex flex-col items-end ml-2 shrink-0">
				<span class="text-xs text-gray-500">${m.time}</span>
				${m.unread > 0 ? `<span class="mt-1 min-w-[20px] h-5 px-1 rounded-full bg-brand-red text-white text-xs flex items-center justify-center">${m.unread}</span>` : ''}
			</div>
		</div>
	`).join('');
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
			<img src="${chatAvatarUrl(r.handle, r.avatar)}" alt="${r.name}" class="w-12 h-12 rounded-full object-cover shrink-0 bg-gray-100">
			<div class="flex-1 min-w-0 ml-3">
				<p class="font-bold text-gray-900 text-sm truncate">${r.name}</p>
				<p class="text-gray-500 text-sm line-clamp-2">${r.preview}</p>
			</div>
			<div class="flex flex-col items-end ml-2 shrink-0">
				<span class="text-xs text-gray-500 mb-2">${r.time}</span>
				<div class="flex items-center gap-2">
					<button type="button" class="w-8 h-8 rounded-full bg-gray-100 text-gray-500 flex items-center justify-center hover:bg-gray-200" onclick="declineChatRequest('${r.id}')" aria-label="Decline">
						<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
							<path d="M6 18L18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"></path>
						</svg>
					</button>
					<button type="button" class="w-8 h-8 rounded-full bg-brand-red text-white flex items-center justify-center hover:bg-red-700" onclick="acceptChatRequest('${r.id}')" aria-label="Accept">
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
	renderChatRequests();
	renderChatMessages();
}

function declineChatRequest(id) {
	removeChatRequest(id);
	renderChatRequests();
}
