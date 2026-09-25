// ---- Share bottom sheet ----
// Opens when the Share icon on a post card is tapped (feed, and the other
// lists that render the same card: profile tabs, search posts). Slides up
// from the bottom; dismissed by tapping the dimmed area, dragging down,
// pressing Escape, or choosing an action.
//
// Repost / Quote aren't built yet, so choosing one closes the sheet and
// shows the app's standard "Coming soon" toast rather than pretending.
//
// Loaded after comments.js (uses postCardContainerIds) and compose.js
// (uses showToast).
(function () {
	const sheet = document.getElementById('share-sheet');
	const backdrop = document.getElementById('share-sheet-backdrop');
	if (!sheet || !backdrop) return;

	const DRAG_START_PX = 6;         // movement before a press counts as a drag (vs. a tap)
	const CLOSE_DISTANCE_RATIO = 0.3; // dragged past this fraction of the sheet's height -> dismiss
	const FLICK_VELOCITY = 0.6;       // px/ms downward -> dismiss even if short
	const STALE_VELOCITY_MS = 100;    // a pause this long before release cancels flick momentum

	let isOpen = false;
	let lastTrigger = null;
	let drag = null;
	let suppressClick = false;

	function openShareSheet(trigger) {
		if (isOpen) return;
		isOpen = true;
		lastTrigger = trigger || null;

		sheet.style.transition = '';
		sheet.style.transform = '';
		backdrop.style.transition = '';
		backdrop.style.opacity = '';

		sheet.setAttribute('aria-hidden', 'false');
		document.body.classList.add('overlay-open');

		// Commit the closed (off-screen) state first so the class change
		// below has a starting point to transition from.
		void sheet.offsetHeight;
		sheet.classList.add('is-open');
		backdrop.classList.add('is-open');
		sheet.focus({ preventScroll: true });
	}

	function closeShareSheet(options) {
		if (!isOpen) return;
		isOpen = false;
		drag = null;

		// Clearing the inline drag styles here (with the CSS transitions
		// restored) lets the sheet animate from wherever a drag left it.
		sheet.style.transition = '';
		sheet.style.transform = '';
		backdrop.style.transition = '';
		backdrop.style.opacity = '';

		sheet.classList.remove('is-open');
		backdrop.classList.remove('is-open');
		sheet.setAttribute('aria-hidden', 'true');
		document.body.classList.remove('overlay-open');

		const restoreFocus = !options || options.restoreFocus !== false;
		if (restoreFocus && lastTrigger && document.contains(lastTrigger)) {
			lastTrigger.focus({ preventScroll: true });
		}
		lastTrigger = null;
	}

	// Exposed for other scripts/tests; not part of any public API.
	window.openShareSheet = openShareSheet;
	window.closeShareSheet = closeShareSheet;

	// ---- Opening: Share button on post cards ----
	postCardContainerIds.forEach(function (containerId) {
		const container = document.getElementById(containerId);
		if (!container) return;
		container.addEventListener('click', function (e) {
			const shareBtn = e.target.closest('.share-btn');
			if (!shareBtn) return;
			e.preventDefault();
			openShareSheet(shareBtn);
		});
	});

	// ---- Dismissing ----
	backdrop.addEventListener('click', function () { closeShareSheet(); });

	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && isOpen) closeShareSheet();
	});

	// Browser Back/Forward switches screens underneath; don't leave the
	// sheet floating over the wrong one.
	window.addEventListener('popstate', function () { closeShareSheet({ restoreFocus: false }); });

	// ---- Actions ----
	sheet.addEventListener('click', function (e) {
		if (suppressClick) return; // the click that ends a drag isn't a tap
		if (!e.target.closest('.share-sheet-action')) return;
		closeShareSheet();
		showToast('Coming soon');
	});

	// ---- Drag down to dismiss (touch, pen and mouse via Pointer Events) ----
	// The sheet has `touch-action: none` (style.css) so the browser doesn't
	// claim the gesture for scrolling and cancel the pointer stream.
	sheet.addEventListener('pointerdown', function (e) {
		if (!isOpen) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		drag = {
			id: e.pointerId,
			startY: e.clientY,
			lastY: e.clientY,
			lastT: performance.now(),
			velocity: 0,
			offset: 0,
			moved: false
		};
	});

	sheet.addEventListener('pointermove', function (e) {
		if (!drag || e.pointerId !== drag.id) return;
		const dy = e.clientY - drag.startY;

		if (!drag.moved) {
			if (Math.abs(dy) < DRAG_START_PX) return;
			drag.moved = true;
			// Capture only once it's clearly a drag, so plain taps keep
			// their normal click target.
			try { sheet.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
			sheet.style.transition = 'none';
			backdrop.style.transition = 'none';
		}

		const now = performance.now();
		const dt = now - drag.lastT;
		if (dt > 0) drag.velocity = (e.clientY - drag.lastY) / dt;
		drag.lastY = e.clientY;
		drag.lastT = now;

		// Dragging up meets resistance instead of pulling the sheet off its edge.
		drag.offset = dy > 0 ? dy : dy * 0.2;
		sheet.style.transform = 'translateY(' + drag.offset + 'px)';
		const fade = Math.max(0, drag.offset) / (sheet.offsetHeight || 1);
		backdrop.style.opacity = String(Math.max(0, 1 - fade));
	});

	function endDrag(e, cancelled) {
		if (!drag || e.pointerId !== drag.id) return;
		const d = drag;
		drag = null;
		if (!d.moved) return; // a tap - let the click handler deal with it

		suppressClick = true;
		setTimeout(function () { suppressClick = false; }, 50);

		const height = sheet.offsetHeight || 1;
		const stale = performance.now() - d.lastT > STALE_VELOCITY_MS;
		const velocity = stale ? 0 : d.velocity;
		const shouldClose = !cancelled && d.offset > 10 &&
			(d.offset > height * CLOSE_DISTANCE_RATIO || velocity > FLICK_VELOCITY);

		if (shouldClose) {
			closeShareSheet();
		} else {
			// Snap back to fully open.
			sheet.style.transition = '';
			backdrop.style.transition = '';
			sheet.style.transform = '';
			backdrop.style.opacity = '';
		}
	}

	sheet.addEventListener('pointerup', function (e) { endDrag(e, false); });
	sheet.addEventListener('pointercancel', function (e) { endDrag(e, true); });
})();
