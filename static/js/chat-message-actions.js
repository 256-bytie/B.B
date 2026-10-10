// ---- Chat message actions (templates/partials/chat_message_sheet.html) ----
// Long-press a bubble in the conversation screen -> bottom sheet with the
// message preview, quick reactions, and Copy / Reply / Forward / Delete.
//
// Triggers: press-and-hold (touch, pen, mouse), right-click / Android
// long-press `contextmenu`, and Enter on a focused bubble.
// Dismiss: tap the dimmed area, drag the sheet down, Escape, browser Back.
//
// Mock-data-only, like the rest of chat: reactions/forwards/deletes mutate
// the in-memory thread arrays in chat.js and are lost on reload.
//
// Loaded after chat.js (uses chatMockMessages, chatThreadFor,
// renderChatConversation, setChatReplyTarget, ...) and compose.js (showToast).
(function () {
	const actionSheetEl = document.getElementById('chat-message-sheet');
	const actionBackdropEl = document.getElementById('chat-message-sheet-backdrop');
	const forwardSheetEl = document.getElementById('chat-forward-sheet');
	const forwardBackdropEl = document.getElementById('chat-forward-sheet-backdrop');
	const thread = document.getElementById('chat-conv-thread');
	if (!actionSheetEl || !actionBackdropEl || !forwardSheetEl || !forwardBackdropEl || !thread) return;

	const LONG_PRESS_MS = 450;
	const LONG_PRESS_SLOP_PX = 10;    // finger drift that turns a press into a scroll
	const DRAG_START_PX = 6;          // movement before a press on the sheet counts as a drag
	const CLOSE_DISTANCE_RATIO = 0.3; // dragged past this fraction of the sheet's height -> dismiss
	const FLICK_VELOCITY = 0.6;       // px/ms downward -> dismiss even if short
	const STALE_VELOCITY_MS = 100;    // a pause this long before release cancels flick momentum
	const IGNORE_BACKDROP_MS = 300;   // the finger that opened the sheet must not also close it

	// ---- Reusable slide-up sheet (open/close + drag-down dismiss) ----
	// Same behavior as static/js/share-sheet.js; kept separate so that file is untouched.
	function createSheet(sheet, backdrop, hooks) {
		let isOpen = false;
		let drag = null;
		let suppressClick = false;
		let openedAt = 0;

		function open() {
			if (isOpen) return;
			isOpen = true;
			openedAt = performance.now();
			sheet.style.transition = '';
			sheet.style.transform = '';
			backdrop.style.transition = '';
			backdrop.style.opacity = '';
			sheet.setAttribute('aria-hidden', 'false');
			document.body.classList.add('overlay-open');
			void sheet.offsetHeight; // commit the closed state so the transition has a start
			sheet.classList.add('is-open');
			backdrop.classList.add('is-open');
			sheet.focus({ preventScroll: true });
		}

		function close(options) {
			if (!isOpen) return;
			isOpen = false;
			drag = null;
			sheet.style.transition = '';
			sheet.style.transform = '';
			backdrop.style.transition = '';
			backdrop.style.opacity = '';
			sheet.classList.remove('is-open');
			backdrop.classList.remove('is-open');
			sheet.setAttribute('aria-hidden', 'true');
			document.body.classList.remove('overlay-open');
			if (hooks && hooks.onClose) hooks.onClose(options || {});
		}

		backdrop.addEventListener('click', function () {
			if (performance.now() - openedAt < IGNORE_BACKDROP_MS) return;
			close();
		});

		sheet.addEventListener('pointerdown', function (e) {
			if (!isOpen) return;
			if (e.pointerType === 'mouse' && e.button !== 0) return;
			// Scrollable regions (emoji row, forward list) own their own gestures.
			if (e.target.closest('[data-sheet-no-drag]')) return;
			drag = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: performance.now(), velocity: 0, offset: 0, moved: false };
		});

		sheet.addEventListener('pointermove', function (e) {
			if (!drag || e.pointerId !== drag.id) return;
			const dy = e.clientY - drag.startY;
			if (!drag.moved) {
				if (Math.abs(dy) < DRAG_START_PX) return;
				drag.moved = true;
				try { sheet.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
				sheet.style.transition = 'none';
				backdrop.style.transition = 'none';
			}
			const now = performance.now();
			const dt = now - drag.lastT;
			if (dt > 0) drag.velocity = (e.clientY - drag.lastY) / dt;
			drag.lastY = e.clientY;
			drag.lastT = now;
			drag.offset = dy > 0 ? dy : dy * 0.2; // resistance when dragging up
			sheet.style.transform = 'translateY(' + drag.offset + 'px)';
			const fade = Math.max(0, drag.offset) / (sheet.offsetHeight || 1);
			backdrop.style.opacity = String(Math.max(0, 1 - fade));
		});

		function endDrag(e, cancelled) {
			if (!drag || e.pointerId !== drag.id) return;
			const d = drag;
			drag = null;
			if (!d.moved) return; // a tap - the click handler deals with it
			suppressClick = true;
			setTimeout(function () { suppressClick = false; }, 50);
			const height = sheet.offsetHeight || 1;
			const stale = performance.now() - d.lastT > STALE_VELOCITY_MS;
			const velocity = stale ? 0 : d.velocity;
			const shouldClose = !cancelled && d.offset > 10 &&
				(d.offset > height * CLOSE_DISTANCE_RATIO || velocity > FLICK_VELOCITY);
			if (shouldClose) {
				close();
			} else {
				sheet.style.transition = '';
				backdrop.style.transition = '';
				sheet.style.transform = '';
				backdrop.style.opacity = '';
			}
		}
		sheet.addEventListener('pointerup', function (e) { endDrag(e, false); });
		sheet.addEventListener('pointercancel', function (e) { endDrag(e, true); });

		return {
			open: open,
			close: close,
			isOpen: function () { return isOpen; },
			wasJustDragged: function () { return suppressClick; }
		};
	}

	// ---- State for the message the sheet is acting on ----
	// `msg` is the live object inside chatMockThreads[convId], so reactions and
	// deletes act on exactly what was pressed even if indexes shift later.
	let target = null; // { conv, msg, bubbleEl }

	function activeConversation() {
		return chatMockMessages.find(function (m) { return m.id === chatActiveConversationId; }) || null;
	}

	const scrollEl = document.getElementById('chat-conv-scroll');
	let padTimer = null;

	// Keep the pressed bubble visible above the sheet: give the thread bottom
	// padding equal to the sheet height (so even the last message can scroll up),
	// then scroll just enough.
	function revealAboveSheet(bubbleEl) {
		if (!scrollEl || !bubbleEl) return;
		clearTimeout(padTimer);
		const sheetH = actionSheetEl.offsetHeight;
		scrollEl.style.transition = 'none';
		scrollEl.style.paddingBottom = sheetH + 'px';
		const b = bubbleEl.getBoundingClientRect();
		const s = scrollEl.getBoundingClientRect();
		const limit = window.innerHeight - sheetH - 16;
		const need = b.bottom - limit;
		const room = b.top - s.top - 8; // never push the bubble's top out of view
		if (need > 0) scrollEl.scrollTo({ top: scrollEl.scrollTop + Math.max(0, Math.min(need, room)), behavior: 'smooth' });
	}

	function releaseSheetPadding() {
		if (!scrollEl) return;
		// Animate the padding away alongside the sheet so the thread doesn't jump.
		scrollEl.style.transition = 'padding-bottom 300ms cubic-bezier(0.32, 0.72, 0, 1)';
		scrollEl.style.paddingBottom = '';
		clearTimeout(padTimer);
		padTimer = setTimeout(function () { scrollEl.style.transition = ''; }, 320);
	}

	// True only while Forward swaps the action sheet for the picker, which still needs `target`.
	let forwarding = false;
	const actionSheet = createSheet(actionSheetEl, actionBackdropEl, {
		onClose: function () {
			releaseSheetPadding();
			if (!forwarding) target = null; // dismissed, or an action finished with it
		}
	});
	const forwardSheet = createSheet(forwardSheetEl, forwardBackdropEl, {
		onClose: function () { target = null; }
	});

	// ---- Opening ----
	function openMessageSheet(bubbleEl) {
		if (actionSheet.isOpen() || forwardSheet.isOpen()) return;
		const conv = activeConversation();
		if (!conv || !bubbleEl) return;
		const index = Number(bubbleEl.dataset.chatMsgIndex);
		const msg = chatThreadFor(conv)[index];
		if (!msg) return;

		target = { conv: conv, msg: msg, bubbleEl: bubbleEl };

		// The software keyboard would fight the sheet for the bottom of the screen.
		if (document.activeElement && document.activeElement !== bubbleEl && document.activeElement.blur) {
			document.activeElement.blur();
		}

		document.getElementById('chat-message-sheet-preview').textContent = msg.text;
		const mine = msg.reactions && msg.reactions.me;
		actionSheetEl.querySelectorAll('.chat-sheet-react').forEach(function (btn) {
			const on = btn.dataset.emoji === mine;
			btn.classList.toggle('is-selected', on);
			btn.setAttribute('aria-pressed', on ? 'true' : 'false');
		});
		const reactions = document.getElementById('chat-message-sheet-reactions');
		if (reactions) reactions.scrollLeft = 0;

		if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* unsupported */ } }
		actionSheet.open();
		revealAboveSheet(bubbleEl);
	}

	// ---- Long-press detection (delegated on the thread) ----
	let press = null; // { id, x, y, timer, bubble }

	function cancelPress() {
		if (press) clearTimeout(press.timer);
		press = null;
	}

	thread.addEventListener('pointerdown', function (e) {
		const bubble = e.target.closest('.chat-msg-bubble');
		if (!bubble) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		cancelPress();
		press = {
			id: e.pointerId,
			x: e.clientX,
			y: e.clientY,
			bubble: bubble,
			timer: setTimeout(function () {
				const b = press && press.bubble;
				press = null;
				if (b) openMessageSheet(b);
			}, LONG_PRESS_MS)
		};
	});

	thread.addEventListener('pointermove', function (e) {
		if (!press || e.pointerId !== press.id) return;
		if (Math.abs(e.clientX - press.x) > LONG_PRESS_SLOP_PX || Math.abs(e.clientY - press.y) > LONG_PRESS_SLOP_PX) cancelPress();
	});
	thread.addEventListener('pointerup', cancelPress);
	thread.addEventListener('pointercancel', cancelPress); // the browser took over for scrolling
	thread.addEventListener('pointerleave', cancelPress);
	if (scrollEl) scrollEl.addEventListener('scroll', cancelPress, { passive: true });

	// Right-click (desktop) and the long-press context menu (Android): same sheet,
	// and suppress the native menu either way.
	thread.addEventListener('contextmenu', function (e) {
		const bubble = e.target.closest('.chat-msg-bubble');
		if (!bubble) return;
		e.preventDefault();
		cancelPress();
		openMessageSheet(bubble);
	});

	// Keyboard: Enter / Space on a focused bubble.
	thread.addEventListener('keydown', function (e) {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		const bubble = e.target.closest('.chat-msg-bubble');
		if (!bubble || bubble !== e.target) return;
		e.preventDefault();
		openMessageSheet(bubble);
	});

	// ---- Dismissing ----
	document.addEventListener('keydown', function (e) {
		if (e.key !== 'Escape') return;
		const dialog = document.getElementById('chat-delete-dialog');
		if (dialog && !dialog.classList.contains('hidden')) { closeDeleteDialog(); return; }
		if (forwardSheet.isOpen()) forwardSheet.close();
		else if (actionSheet.isOpen()) actionSheet.close();
	});

	// Browser Back switches screens underneath; don't leave a sheet over the wrong one.
	window.addEventListener('popstate', function () {
		actionSheet.close({ restoreFocus: false });
		forwardSheet.close({ restoreFocus: false });
		closeDeleteDialog();
	});

	// ---- Actions ----
	async function copyText(text) {
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch (err) { /* fall through to the legacy path */ }
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
		document.body.appendChild(ta);
		ta.select();
		ta.setSelectionRange(0, text.length);
		let ok = false;
		try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
		ta.remove();
		return ok;
	}

	function reactTo(emoji) {
		if (!target) return;
		const msg = target.msg;
		const reactions = msg.reactions || (msg.reactions = {});
		if (reactions.me === emoji) delete reactions.me; // tapping your own reaction removes it
		else reactions.me = emoji;
		if (!reactions.me && !reactions.them) delete msg.reactions;
		actionSheet.close();
		target = null;
		renderChatConversation();
	}

	function doCopy() {
		if (!target) return;
		const text = target.msg.text;
		actionSheet.close();
		target = null;
		copyText(text).then(function (ok) {
			showToast(ok ? 'Message copied' : 'Could not copy message');
		});
	}

	function doReply() {
		if (!target) return;
		const msg = target.msg;
		actionSheet.close();
		target = null;
		setChatReplyTarget({ from: msg.from, text: msg.text });
		const input = document.getElementById('chat-conv-input');
		if (input) input.focus();
	}

	function doForward() {
		if (!target) return;
		forwarding = true;
		actionSheet.close();
		forwarding = false;
		renderForwardList();
		forwardSheet.open();
	}

	function renderForwardList() {
		const list = document.getElementById('chat-forward-list');
		list.innerHTML = chatMockMessages.map(function (c) {
			return `
			<div class="flex items-center px-3 py-2.5" data-forward-conv="${escapeHtml(c.id)}">
				<img src="${escapeHtml(chatAvatarUrl(c.handle, c.avatar))}" alt="" class="w-11 h-11 rounded-full object-cover bg-gray-100 shrink-0">
				<p class="flex-1 min-w-0 ml-3 font-semibold text-gray-900 text-[15px] truncate">${escapeHtml(c.name)}</p>
				<button type="button" class="chat-forward-send ml-2 shrink-0 px-4 h-9 rounded-full bg-brand-red text-white text-[14px] font-semibold active:scale-95 transition-transform duration-100" data-conv-id="${escapeHtml(c.id)}">Send</button>
			</div>`;
		}).join('');
	}

	function forwardTo(convId, btn) {
		if (!target || btn.disabled) return;
		const dest = chatMockMessages.find(function (c) { return c.id === convId; });
		if (!dest) return;
		const time = new Date().toTimeString().slice(0, 5);
		chatThreadFor(dest).push({ from: 'me', text: target.msg.text, time: time, status: 'sent', forwarded: true });
		dest.preview = target.msg.text;
		dest.time = time;
		btn.disabled = true;
		btn.textContent = 'Sent';
		btn.className = 'chat-forward-send ml-2 shrink-0 px-4 h-9 rounded-full bg-gray-100 text-gray-500 text-[14px] font-semibold';
		showToast('Forwarded to ' + dest.name);
		if (dest.id === chatActiveConversationId) {
			renderChatConversation();
			scrollChatConversationToBottom();
		}
	}

	// Delete: confirm first (same as comment deletion), then remove the message.
	const deleteDialog = document.getElementById('chat-delete-dialog');
	const deleteBackdrop = document.getElementById('chat-delete-backdrop');
	let deleteTarget = null;

	function openDeleteDialog() {
		if (!target) return;
		deleteTarget = { conv: target.conv, msg: target.msg };
		actionSheet.close();
		target = null;
		deleteBackdrop.classList.remove('hidden');
		deleteDialog.classList.remove('hidden');
		document.getElementById('chat-delete-cancel-btn').focus();
	}

	function closeDeleteDialog() {
		deleteTarget = null;
		deleteBackdrop.classList.add('hidden');
		deleteDialog.classList.add('hidden');
	}

	function confirmDelete() {
		if (!deleteTarget) return;
		const t = deleteTarget;
		closeDeleteDialog();
		const msgs = chatThreadFor(t.conv);
		const i = msgs.indexOf(t.msg);
		if (i === -1) return;
		msgs.splice(i, 1);
		chatSyncListRowToThread(t.conv); // keep list preview/time = last thread message
		renderChatConversation();
		showToast('Message deleted');
	}

	document.getElementById('chat-delete-confirm-btn').addEventListener('click', confirmDelete);
	document.getElementById('chat-delete-cancel-btn').addEventListener('click', closeDeleteDialog);
	deleteBackdrop.addEventListener('click', closeDeleteDialog);

	// ---- Sheet click routing ----
	actionSheetEl.addEventListener('click', function (e) {
		if (actionSheet.wasJustDragged()) return; // the click that ends a drag isn't a tap
		const react = e.target.closest('.chat-sheet-react');
		if (react) { reactTo(react.dataset.emoji); return; }
		const action = e.target.closest('.chat-sheet-action');
		if (!action) return;
		const kind = action.dataset.action;
		if (kind === 'copy') doCopy();
		else if (kind === 'reply') doReply();
		else if (kind === 'forward') doForward();
		else if (kind === 'delete') openDeleteDialog();
	});

	forwardSheetEl.addEventListener('click', function (e) {
		if (forwardSheet.wasJustDragged()) return;
		const send = e.target.closest('.chat-forward-send');
		if (send) forwardTo(send.dataset.convId, send);
	});

	// Exposed for tests; not a public API.
	window.openChatMessageSheet = openMessageSheet;
	window.closeChatMessageSheet = function () { actionSheet.close(); forwardSheet.close(); };
})();
