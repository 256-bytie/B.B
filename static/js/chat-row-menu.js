// ---- Chats list row menu (templates/partials/chat_row_menu.html) ----
// Long-press a conversation row in the Chats list -> floating popup with
// Mark as unread / Mute conversation / Pin conversation / Delete conversation.
//
// Scope: rows of #chat-messages-list only. Bubbles inside an open conversation
// have their own sheet (chat-message-actions.js) and are never touched here.
//
// Triggers: press-and-hold (touch, pen, mouse), right-click / Android long-press
// `contextmenu`, and the keyboard context-menu key (Shift+F10) on a focused row.
// Dismiss: tap outside, pick an action, Escape, scroll, resize, browser Back,
// leaving the Chats screen (core.js showView calls closeChatRowMenu()).
//
// UI only for now: picking an action just closes the menu. `target.conv` is the
// live object from chatMockMessages for the pressed row, so when behaviour is
// wired up each action applies to exactly that conversation.
//
// Loaded after chat.js (uses chatMockMessages).
(function () {
	const list = document.getElementById('chat-messages-list');
	const menu = document.getElementById('chat-row-menu');
	const backdrop = document.getElementById('chat-row-menu-backdrop');
	if (!list || !menu || !backdrop) return;

	const LONG_PRESS_MS = 450;
	const LONG_PRESS_SLOP_PX = 10;   // finger drift that turns a press into a scroll
	const IGNORE_BACKDROP_MS = 300;  // the finger that opened the menu must not also close it
	const SUPPRESS_CLICK_MS = 400;   // swallow the click that follows the releasing finger
	const EDGE_MARGIN_PX = 12;       // keep the popup this far from the viewport edges
	const ROW_GAP_PX = 4;            // gap between the row and the popup
	const ROW_INSET_PX = 16;         // row content inset (px-4): popup lines up with it

	let target = null;               // { conv, rowEl } while the menu is open
	let openedAt = 0;
	let press = null;                // { id, x, y, timer, row }
	let pressFired = false;          // a long-press opened the menu; the finger is still down
	let suppressClickUntil = 0;

	function isOpen() {
		return !menu.classList.contains('hidden');
	}

	function rowFor(el) {
		return el && el.closest ? el.closest('.chat-row[data-chat-row-id]') : null;
	}

	function conversationFor(rowEl) {
		const id = rowEl.dataset.chatRowId;
		return chatMockMessages.find(function (m) { return m.id === id; }) || null;
	}

	function place(rowEl) {
		const rowRect = rowEl.getBoundingClientRect();
		const listRect = list.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const vh = window.innerHeight;
		const w = menu.offsetWidth;
		const h = menu.offsetHeight;

		const maxLeft = Math.max(EDGE_MARGIN_PX, vw - w - EDGE_MARGIN_PX);
		const left = Math.min(Math.max(listRect.left + ROW_INSET_PX, EDGE_MARGIN_PX), maxLeft);

		// Below the row by default; flip above when it would run off the bottom.
		let top = rowRect.bottom + ROW_GAP_PX;
		let above = false;
		if (top + h > vh - EDGE_MARGIN_PX) {
			above = true;
			top = rowRect.top - h - ROW_GAP_PX;
		}
		// Neither fits (very short viewport): pin inside the viewport.
		if (top < EDGE_MARGIN_PX) {
			above = false;
			top = Math.max(EDGE_MARGIN_PX, Math.min(rowRect.bottom + ROW_GAP_PX, vh - h - EDGE_MARGIN_PX));
		}

		menu.style.left = left + 'px';
		menu.style.top = top + 'px';
		menu.style.transformOrigin = (above ? 'bottom' : 'top') + ' left';
	}

	function open(rowEl) {
		if (isOpen()) return;
		const conv = conversationFor(rowEl);
		if (!conv) return;

		target = { conv: conv, rowEl: rowEl };
		openedAt = performance.now();
		rowEl.classList.add('is-menu-target');

		// The software keyboard (search field) would fight the popup for space.
		if (document.activeElement && document.activeElement.blur && !rowEl.contains(document.activeElement)) {
			document.activeElement.blur();
		}

		// Measure while invisible, then reveal so the entry animation starts in place.
		menu.style.visibility = 'hidden';
		menu.classList.remove('hidden');
		backdrop.classList.remove('hidden');
		place(rowEl);
		menu.style.visibility = '';

		if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* unsupported */ } }
		menu.focus({ preventScroll: true });
	}

	function close() {
		if (!isOpen()) return;
		const t = target;
		const hadFocus = menu.contains(document.activeElement);
		target = null;
		menu.classList.add('hidden');
		backdrop.classList.add('hidden');
		menu.style.transformOrigin = '';
		if (t && t.rowEl) {
			t.rowEl.classList.remove('is-menu-target');
			if (hadFocus && t.rowEl.isConnected) t.rowEl.focus({ preventScroll: true });
		}
	}

	// core.js showView() calls this so the popup never outlives the Chats screen.
	window.closeChatRowMenu = close;

	// ---- Long-press detection (delegated on the list; rows are re-rendered) ----
	function cancelPress() {
		if (press) clearTimeout(press.timer);
		press = null;
	}

	list.addEventListener('pointerdown', function (e) {
		const row = rowFor(e.target);
		if (!row) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		cancelPress();
		pressFired = false;
		press = {
			id: e.pointerId,
			x: e.clientX,
			y: e.clientY,
			row: row,
			timer: setTimeout(function () {
				const r = press && press.row;
				press = null;
				if (!r) return;
				pressFired = true;
				open(r);
			}, LONG_PRESS_MS)
		};
	});

	list.addEventListener('pointermove', function (e) {
		if (!press || e.pointerId !== press.id) return;
		if (Math.abs(e.clientX - press.x) > LONG_PRESS_SLOP_PX || Math.abs(e.clientY - press.y) > LONG_PRESS_SLOP_PX) cancelPress();
	});
	list.addEventListener('pointerleave', cancelPress);

	// Release can land on the backdrop (mouse) or the row (touch capture), so
	// listen on document. Releasing after a long-press must not "tap" the row.
	function onRelease() {
		cancelPress();
		if (pressFired) {
			pressFired = false;
			suppressClickUntil = performance.now() + SUPPRESS_CLICK_MS;
		}
	}
	document.addEventListener('pointerup', onRelease);
	document.addEventListener('pointercancel', onRelease); // the browser took over for scrolling

	// Capture phase, before the row's inline onclick opens the conversation.
	list.addEventListener('click', function (e) {
		if (!rowFor(e.target)) return;
		if (pressFired || performance.now() < suppressClickUntil) {
			e.preventDefault();
			e.stopPropagation();
		}
	}, true);

	// Right-click (desktop), Android long-press and the keyboard context-menu key:
	// same menu, and suppress the native one either way.
	list.addEventListener('contextmenu', function (e) {
		const row = rowFor(e.target);
		if (!row) return;
		e.preventDefault();
		const fingerDown = !!press; // touch long-press: the release must not tap the row
		cancelPress();
		if (!isOpen()) {
			if (fingerDown) pressFired = true;
			open(row);
		}
	});
	backdrop.addEventListener('contextmenu', function (e) { e.preventDefault(); });

	// ---- Dismissing ----
	backdrop.addEventListener('click', function () {
		const now = performance.now();
		// The finger that opened the menu may release over the backdrop: not a dismiss tap.
		if (pressFired || now < suppressClickUntil || now - openedAt < IGNORE_BACKDROP_MS) return;
		close();
	});

	document.addEventListener('keydown', function (e) {
		if (!isOpen()) return;
		if (e.key === 'Escape' || e.key === 'Tab') { close(); return; }
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
			const i = items.indexOf(document.activeElement);
			const next = e.key === 'ArrowDown'
				? items[(i + 1) % items.length]
				: items[(i <= 0 ? items.length : i) - 1];
			if (next) next.focus();
		}
	});

	// A fixed popup would drift away from its row if the page moved underneath it.
	window.addEventListener('scroll', function () {
		if (performance.now() - openedAt < IGNORE_BACKDROP_MS) return; // keyboard hiding on open can nudge the page
		close();
	}, { passive: true });
	// Viewport changes (keyboard hiding, rotation): re-anchor to the row.
	window.addEventListener('resize', function () {
		if (!isOpen() || !target || !target.rowEl.isConnected) return;
		place(target.rowEl);
	});
	// Browser Back switches screens underneath; don't leave the popup over the wrong one.
	window.addEventListener('popstate', close);

	// ---- Actions (UI only: dismiss and nothing else) ----
	menu.addEventListener('click', function (e) {
		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		// target.conv is the pressed conversation; wire behaviour here later:
		// 'unread' | 'mute' | 'pin' | 'delete'.
		close();
	});
})();
