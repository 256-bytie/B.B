// ---- Group info & settings (templates/partials/chat_group_info.html) ----
// Tap a group's avatar/name in the conversation header -> Group info for THAT group.
// Every read and write goes through the active conversation object
// (chatConversations entry for chatActiveConversationId), never global state, so
// settings only ever affect the group they were changed in. The conversation stays
// the active one the whole time (these screens never call closeChatConversation),
// and Back restores its scroll position; the thread, draft and reply state are untouched.
//
// Like the rest of chat the data is client-side only (see chat.js): changes live on
// the conversation object, so they show up in the list and conversation header
// immediately and last until the page reloads.
//
// Roles (conv.myRole = the signed-in user's role in this group):
//  - admin: everything.
//  - member: may rename / add people only if conv.permissions allows ('everyone');
//    disappearing messages, screenshots, invite link and permissions are view-only.
//
// Loaded after chat-new-message.js (openChatAddMembers) and chat.js.
(function () {
	const view = document.getElementById('chat-group-info-view');
	const mediaView = document.getElementById('chat-group-media-view');
	const sheet = document.getElementById('chat-group-sheet');
	const sheetBackdrop = document.getElementById('chat-group-sheet-backdrop');
	const sheetTitle = document.getElementById('chat-group-sheet-title');
	const sheetBody = document.getElementById('chat-group-sheet-body');
	if (!view || !mediaView || !sheet || !sheetBackdrop) return;

	const DISAPPEARING = [
		{ value: 'off', label: 'Off' },
		{ value: '24h', label: '24 hours' },
		{ value: '7d', label: '7 days' },
		{ value: '90d', label: '90 days' }
	];
	const PERMISSION_CHOICES = [
		{ value: 'everyone', label: 'All members' },
		{ value: 'admins', label: 'Admins only' }
	];
	const MUTE_ICON = '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"></path><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path><path d="m2 2 20 20"></path>';
	const BELL_ICON = '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>';
	const CHECK_ICON = '<svg class="w-5 h-5 text-brand-red" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

	let conversationScrollTop = 0; // restored when Back returns to the conversation
	let mediaTab = 'media';
	let sheetKind = null;
	let confirmingLeave = false;

	function activeGroup() {
		const conv = chatConversations.find(function (m) { return m.id === chatActiveConversationId; });
		return conv && conv.isGroup ? chatEnsureGroupModel(conv) : null;
	}

	// ---- Roles ----
	function isAdmin(conv) { return conv.myRole === 'admin'; }
	function can(conv, action) {
		if (isAdmin(conv)) return true;
		if (action === 'editInfo') return conv.permissions.editInfo === 'everyone';
		if (action === 'addMembers') return conv.permissions.addMembers === 'everyone';
		return false; // manageSettings / manageInvite / managePermissions: admins only
	}

	// ---- Navigation ----
	window.openChatGroupInfo = function () {
		const conv = activeGroup();
		if (!conv) return; // 1:1 conversations have no group info
		const scroller = document.getElementById('chat-conv-scroll');
		conversationScrollTop = scroller ? scroller.scrollTop : 0;
		showView('chat-group-info');
	};

	window.closeChatGroupInfo = function () {
		closeSheet();
		showView('chat-conversation'); // no re-init: thread, draft and reply bar are as they were
		const scroller = document.getElementById('chat-conv-scroll');
		if (scroller) scroller.scrollTop = conversationScrollTop;
	};

	window.initChatGroupInfoView = function () {
		const conv = activeGroup();
		if (!conv) { showView('chat'); return; }
		renderInfo(conv);
		window.scrollTo(0, 0);
	};

	// ---- Group info rendering (always from the conversation's current data) ----
	function img(handle, avatar, cls) {
		return '<img src="' + escapeHtml(chatAvatarUrl(handle, avatar)) + '" alt="" class="' + cls + '">';
	}

	function groupPictureHtml(conv) {
		const m = conv.members.slice(0, 2);
		if (m.length < 2) return img(conv.handle, conv.avatar, 'absolute inset-x-0 mx-auto top-0 w-[104px] h-[104px] rounded-full object-cover bg-gray-100');
		return img(m[0].handle, m[0].avatar, 'absolute left-0 top-0 w-[84px] h-[84px] rounded-full object-cover bg-gray-200') +
			img(m[1].handle, m[1].avatar, 'absolute right-0 bottom-0 w-[84px] h-[84px] rounded-full object-cover bg-gray-100 border-4 border-white');
	}

	function renderInfo(conv) {
		document.getElementById('chat-group-info-avatar').innerHTML = groupPictureHtml(conv);
		document.getElementById('chat-group-info-name').textContent = conv.name;

		const canEdit = can(conv, 'editInfo');
		document.getElementById('chat-group-info-edit-btn').classList.toggle('invisible', !canEdit);
		document.getElementById('chat-group-info-change-name-btn').classList.toggle('hidden', !canEdit);

		const add = document.getElementById('chat-group-info-add-btn');
		const canAdd = can(conv, 'addMembers');
		add.classList.toggle('opacity-40', !canAdd);
		add.setAttribute('aria-disabled', String(!canAdd));

		const mute = document.getElementById('chat-group-info-mute-btn');
		mute.setAttribute('aria-pressed', String(conv.muted));
		mute.setAttribute('aria-label', conv.muted ? 'Unmute group' : 'Mute group');
		document.getElementById('chat-group-info-mute-icon').innerHTML = conv.muted ? BELL_ICON : MUTE_ICON;
		document.getElementById('chat-group-info-mute-label').textContent = conv.muted ? 'Unmute' : 'Mute';

		const dis = DISAPPEARING.find(function (o) { return o.value === conv.disappearing; });
		document.getElementById('chat-group-info-disappearing-value').textContent = dis ? dis.label : 'Off';
		document.getElementById('chat-group-info-screenshots-value').textContent = conv.blockScreenshots ? 'On' : 'Off';
		document.getElementById('chat-group-info-invite-value').textContent = conv.inviteLink.enabled ? 'On' : 'Off';

		document.getElementById('chat-group-info-participants-title').textContent = 'Participants (' + (conv.members.length + 1) + ')';
		const rows = [{ name: 'You', handle: '', avatar: null, role: conv.myRole, you: true }].concat(conv.members);
		document.getElementById('chat-group-info-participants').innerHTML = rows.map(function (p) {
			const avatar = p.you
				? '<span class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 text-[15px] font-bold shrink-0">Y</span>'
				: img(p.handle, p.avatar, 'w-10 h-10 rounded-full object-cover bg-gray-100 shrink-0');
			return '<div class="flex items-center py-2.5">' + avatar +
				'<div class="flex-1 min-w-0 ml-3"><p class="text-[15px] font-semibold text-gray-900 truncate">' + escapeHtml(p.name) + '</p>' +
				(p.handle ? '<p class="text-[14px] text-gray-500 truncate">@' + escapeHtml(p.handle) + '</p>' : '') + '</div>' +
				(p.role === 'admin' ? '<span class="text-[12px] font-semibold text-gray-500 bg-gray-100 rounded-full px-2.5 py-0.5">Admin</span>' : '') +
				'</div>';
		}).join('');
	}

	// ---- Quick actions ----
	window.onChatGroupAdd = function () {
		const conv = activeGroup();
		if (!conv) return;
		if (!can(conv, 'addMembers')) { showToast('Only admins can add people'); return; }
		openChatAddMembers(conv);
	};

	window.toggleChatGroupMute = function () {
		const conv = activeGroup();
		if (!conv) return;
		conv.muted = !conv.muted;
		renderInfo(conv);
		showToast(conv.muted ? 'Group muted' : 'Group unmuted');
	};

	// ---- Sheet (rename / more / settings) ----
	function optionRow(label, selected, attrs, disabled) {
		return '<button type="button" ' + attrs + (disabled ? ' disabled' : '') + ' role="radio" aria-checked="' + selected + '" class="w-full flex items-center justify-between px-3 py-3.5 rounded-xl text-left text-[16px] text-gray-900 ' + (disabled ? 'opacity-50' : 'active:bg-gray-100') + '">' +
			'<span>' + escapeHtml(label) + '</span>' + (selected ? CHECK_ICON : '') + '</button>';
	}

	function note(text) {
		return '<p class="px-3 pt-2 pb-1 text-[13px] text-gray-500">' + escapeHtml(text) + '</p>';
	}

	function inviteUrl(conv) {
		return window.location.origin + '/chat/join/' + conv.inviteLink.code;
	}

	function newInviteCode() {
		return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
	}

	function renderSheet(conv) {
		const admin = isAdmin(conv);
		const adminNote = admin ? '' : note('Only admins can change this.');
		if (sheetKind === 'rename') {
			sheetTitle.textContent = 'Group name';
			const auto = chatGeneratedGroupName(conv.members);
			sheetBody.innerHTML =
				'<div class="px-3 pt-2">' +
				'<input id="chat-group-rename-input" type="text" maxlength="50" value="' + escapeHtml(conv.customName) + '" placeholder="' + escapeHtml(auto || 'Group name') + '" class="w-full bg-gray-100 rounded-full px-4 py-3 text-[16px] text-gray-900 border-none outline-none focus:ring-0" autocomplete="off" aria-label="Group name">' +
				(conv.members.length ? '<p class="px-2 pt-2 text-[13px] text-gray-500">Leave empty to use the automatic name: ' + escapeHtml(auto) + '</p>' : '') +
				'<p id="chat-group-rename-error" class="hidden px-2 pt-2 text-[13px] text-brand-red"></p>' +
				'<div class="flex gap-3 pt-4">' +
				'<button id="chat-group-rename-cancel-btn" type="button" data-act="close" class="flex-1 py-3 rounded-full bg-gray-100 text-[16px] font-semibold text-gray-900 active:bg-gray-200">Cancel</button>' +
				'<button id="chat-group-rename-save-btn" type="button" data-act="save-name" class="flex-1 py-3 rounded-full bg-brand-red text-white text-[16px] font-semibold active:opacity-80">Save</button>' +
				'</div></div>';
		} else if (sheetKind === 'more') {
			sheetTitle.textContent = 'More';
			sheetBody.innerHTML = confirmingLeave
				? note('You will no longer receive messages from this group.') +
				  '<div class="flex gap-3 px-3 pt-3">' +
				  '<button id="chat-group-leave-cancel-btn" type="button" data-act="leave-cancel" class="flex-1 py-3 rounded-full bg-gray-100 text-[16px] font-semibold text-gray-900 active:bg-gray-200">Cancel</button>' +
				  '<button id="chat-group-leave-confirm-btn" type="button" data-act="leave-confirm" class="flex-1 py-3 rounded-full bg-brand-red text-white text-[16px] font-semibold active:opacity-80">Leave</button></div>'
				: '<button id="chat-group-leave-btn" type="button" data-act="leave" class="w-full flex items-center gap-4 px-3 py-3.5 rounded-xl text-left active:bg-gray-100">' +
				  '<svg class="w-6 h-6 text-brand-red shrink-0" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="m16 17 5-5-5-5"></path><path d="M21 12H9"></path></svg>' +
				  '<span class="text-[16px] font-medium text-brand-red">Leave group</span></button>';
		} else if (sheetKind === 'disappearing') {
			sheetTitle.textContent = 'Disappearing messages';
			sheetBody.innerHTML = DISAPPEARING.map(function (o) {
				return optionRow(o.label, conv.disappearing === o.value, 'data-act="set-disappearing" data-value="' + o.value + '"', !admin);
			}).join('') + adminNote;
		} else if (sheetKind === 'screenshots') {
			sheetTitle.textContent = 'Block screenshots';
			sheetBody.innerHTML =
				optionRow('Off', !conv.blockScreenshots, 'data-act="set-screenshots" data-value="off"', !admin) +
				optionRow('On', conv.blockScreenshots, 'data-act="set-screenshots" data-value="on"', !admin) +
				note('Records the group\u2019s screenshot preference. Browsers cannot prevent screenshots, so this is not enforced here.') + adminNote;
		} else if (sheetKind === 'invite') {
			sheetTitle.textContent = 'Group invite link';
			const on = conv.inviteLink.enabled;
			sheetBody.innerHTML =
				optionRow('Off', !on, 'data-act="set-invite" data-value="off"', !admin) +
				optionRow('On', on, 'data-act="set-invite" data-value="on"', !admin) +
				(on
					? '<div class="mx-3 mt-2 rounded-xl bg-gray-100 px-4 py-3 text-[14px] text-gray-900 break-all">' + escapeHtml(inviteUrl(conv)) + '</div>' +
					  '<div class="flex gap-3 px-3 pt-3">' +
					  '<button id="chat-group-invite-copy-btn" type="button" data-act="copy-invite" class="flex-1 py-3 rounded-full bg-brand-red text-white text-[16px] font-semibold active:opacity-80">Copy link</button>' +
					  (admin ? '<button id="chat-group-invite-reset-btn" type="button" data-act="reset-invite" class="flex-1 py-3 rounded-full bg-gray-100 text-[16px] font-semibold text-gray-900 active:bg-gray-200">Reset link</button>' : '') +
					  '</div>' + note('Anyone with the link can join while it is On.')
					: note('Turn the link on to let people join this group.')) + adminNote;
		} else if (sheetKind === 'permissions') {
			sheetTitle.textContent = 'Permissions';
			const group = function (heading, key) {
				return '<p class="px-3 pt-3 pb-1 text-[14px] font-semibold text-gray-500">' + heading + '</p>' +
					PERMISSION_CHOICES.map(function (o) {
						return optionRow(o.label, conv.permissions[key] === o.value, 'data-act="set-permission" data-key="' + key + '" data-value="' + o.value + '"', !admin);
					}).join('');
			};
			sheetBody.innerHTML = group('Who can edit group info', 'editInfo') + group('Who can add members', 'addMembers') + adminNote;
		}
	}

	window.openChatGroupSheet = function (kind) {
		const conv = activeGroup();
		if (!conv) return;
		if (kind === 'rename' && !can(conv, 'editInfo')) { showToast('Only admins can edit group info'); return; }
		sheetKind = kind;
		confirmingLeave = false;
		renderSheet(conv);
		sheetBackdrop.classList.remove('hidden');
		sheet.classList.remove('hidden');
		sheet.focus({ preventScroll: true });
		if (kind === 'rename') {
			const input = document.getElementById('chat-group-rename-input');
			if (input) { input.focus(); input.select(); }
		}
	};

	function closeSheet() {
		sheetKind = null;
		confirmingLeave = false;
		sheet.classList.add('hidden');
		sheetBackdrop.classList.add('hidden');
	}
	window.closeChatGroupSheet = closeSheet;
	sheetBackdrop.addEventListener('click', closeSheet);
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && sheetKind) closeSheet();
		if (e.key === 'Enter' && sheetKind === 'rename' && e.target && e.target.id === 'chat-group-rename-input') saveName();
	});

	// A custom name replaces the generated one; saving it empty goes back to the
	// generated name (derived from the members, kept in sync by chatSetGroupMembers).
	function saveName() {
		const conv = activeGroup();
		if (!conv) return;
		const typed = document.getElementById('chat-group-rename-input').value.trim();
		if (!typed && conv.members.length === 0) {
			const err = document.getElementById('chat-group-rename-error');
			err.textContent = 'Enter a group name.';
			err.classList.remove('hidden');
			return;
		}
		conv.customName = typed;
		conv.name = typed || chatGeneratedGroupName(conv.members);
		refreshChatConversationHeader(conv);
		renderChatMessages(); // list row shows the new name when the list is next shown
		closeSheet();
		renderInfo(conv);
		showToast('Group name updated');
	}

	function leaveGroup() {
		const conv = activeGroup();
		if (!conv) return;
		const i = chatConversations.indexOf(conv);
		if (i !== -1) chatConversations.splice(i, 1);
		delete chatThreads[conv.id];
		closeSheet();
		chatActiveConversationId = null;
		showView('chat'); // list re-initialises without the group
		showToast('You left the group');
	}

	sheetBody.addEventListener('click', function (e) {
		const btn = e.target.closest('[data-act]');
		if (!btn || btn.disabled) return;
		const conv = activeGroup();
		if (!conv) return;
		const v = btn.dataset.value;
		switch (btn.dataset.act) {
			case 'close': closeSheet(); return;
			case 'save-name': saveName(); return;
			case 'leave': confirmingLeave = true; renderSheet(conv); return;
			case 'leave-cancel': confirmingLeave = false; renderSheet(conv); return;
			case 'leave-confirm': leaveGroup(); return;
			case 'set-disappearing': if (isAdmin(conv)) { conv.disappearing = v; closeSheet(); renderInfo(conv); } return;
			case 'set-screenshots': if (isAdmin(conv)) { conv.blockScreenshots = v === 'on'; closeSheet(); renderInfo(conv); } return;
			case 'set-invite':
				if (!isAdmin(conv)) return;
				conv.inviteLink.enabled = v === 'on';
				if (conv.inviteLink.enabled && !conv.inviteLink.code) conv.inviteLink.code = newInviteCode();
				renderSheet(conv); renderInfo(conv);
				return;
			case 'reset-invite':
				if (!isAdmin(conv)) return;
				conv.inviteLink.code = newInviteCode();
				renderSheet(conv);
				showToast('Invite link reset');
				return;
			case 'copy-invite':
				copyText(inviteUrl(conv)).then(function (ok) { showToast(ok ? 'Link copied' : 'Couldn\u2019t copy link'); });
				return;
			case 'set-permission':
				if (!isAdmin(conv)) return;
				conv.permissions[btn.dataset.key] = v;
				renderSheet(conv); renderInfo(conv);
				return;
		}
	});

	async function copyText(text) {
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch (e) { /* fall through */ }
		return false;
	}

	// ---- Media, Links, Docs (from this group's thread) ----
	// Thread messages are text-only today, so Media and Docs fill in once messages
	// carry `image` / `file` ({ name, size }) attachments; Links are found in message text.
	function collect(conv, tab) {
		const thread = chatThreadFor(conv);
		const out = [];
		thread.forEach(function (msg) {
			if (tab === 'media' && msg.image) out.push({ src: msg.image });
			if (tab === 'docs' && msg.file) out.push({ name: msg.file.name, size: msg.file.size || '', who: chatReplyLabel(msg.from, conv), time: msg.time });
			if (tab === 'links' && msg.text) {
				(msg.text.match(/https?:\/\/[^\s]+/g) || []).forEach(function (url) {
					out.push({ url: url, who: chatReplyLabel(msg.from, conv), time: msg.time });
				});
			}
		});
		return out;
	}

	function renderMedia(conv) {
		['media', 'links', 'docs'].forEach(function (t) {
			const b = document.getElementById('chat-group-media-tab-' + t);
			const on = t === mediaTab;
			b.setAttribute('aria-selected', String(on));
			b.className = 'flex-1 py-3 text-[15px] font-semibold border-b-2 ' + (on ? 'text-gray-900 border-gray-900' : 'text-gray-500 border-transparent');
		});
		const items = collect(conv, mediaTab);
		const box = document.getElementById('chat-group-media-content');
		if (items.length === 0) {
			box.innerHTML = '<p class="text-center text-sm text-gray-400 px-6 pt-16">' + ({ media: 'No media shared in this group yet.', links: 'No links shared in this group yet.', docs: 'No documents shared in this group yet.' })[mediaTab] + '</p>';
		} else if (mediaTab === 'media') {
			box.innerHTML = '<div class="grid grid-cols-3 gap-0.5">' + items.map(function (i) {
				return '<img src="' + escapeHtml(i.src) + '" alt="" class="w-full aspect-square object-cover bg-gray-100">';
			}).join('') + '</div>';
		} else if (mediaTab === 'links') {
			box.innerHTML = items.map(function (i) {
				return '<a href="' + escapeHtml(i.url) + '" target="_blank" rel="noopener noreferrer" class="block px-4 py-3 border-b border-gray-100 active:bg-gray-50"><p class="text-[15px] text-[#1d9bf0] break-all">' + escapeHtml(i.url) + '</p><p class="text-[13px] text-gray-500 mt-0.5">' + escapeHtml(i.who) + ' \u2022 ' + escapeHtml(i.time || '') + '</p></a>';
			}).join('');
		} else {
			box.innerHTML = items.map(function (i) {
				return '<div class="px-4 py-3 border-b border-gray-100"><p class="text-[15px] text-gray-900 break-all">' + escapeHtml(i.name) + '</p><p class="text-[13px] text-gray-500 mt-0.5">' + escapeHtml(i.size) + (i.size ? ' \u2022 ' : '') + escapeHtml(i.who) + ' \u2022 ' + escapeHtml(i.time || '') + '</p></div>';
			}).join('');
		}
	}

	window.openChatGroupMedia = function () {
		if (!activeGroup()) return;
		mediaTab = 'media';
		showView('chat-group-media');
	};
	window.closeChatGroupMedia = function () { showView('chat-group-info'); };
	window.initChatGroupMediaView = function () {
		const conv = activeGroup();
		if (!conv) { showView('chat'); return; }
		renderMedia(conv);
		window.scrollTo(0, 0);
	};
	mediaView.querySelector('[role="tablist"]').addEventListener('click', function (e) {
		const b = e.target.closest('[data-tab]');
		const conv = activeGroup();
		if (!b || !conv) return;
		mediaTab = b.dataset.tab;
		renderMedia(conv);
	});
})();
