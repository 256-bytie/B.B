// ---- Side navigation drawer: gesture-driven, three-stop reveal ----
// The drawer has three resting states - closed, mini (icon rail), and
// full (labeled drawer) - driven by animating the WIDTH of the #side-nav
// shell rather than a translateX transform. Growing the shell's width is
// what makes a short edge-swipe progressively reveal the mini rail, and a
// longer/continued swipe progressively expand that into the full drawer,
// instead of the layouts abruptly swapping.
//
// During a drag, width is set directly from touch position every
// touchmove (real-time tracking). The CSS transition defined in
// style.css only applies for the settle animation after touchend/tap -
// the side-nav-dragging class strips it for the duration of an active
// drag so the panel doesn't lag behind the finger.
//
// All click targets inside the panel use inline onclick (same convention
// used elsewhere in this app, e.g. the FAB buttons in feed.html) rather
// than addEventListener-with-a-bare-reference, so this file has no load-
// order dependency on core.js/comment-actions.js - see the ReferenceError
// incident in comments.js/comment-actions.js for why that matters.

const SIDE_NAV_EDGE_ZONE = 24; // px from the left screen edge that can start an open-drag
const SIDE_NAV_MINI_WIDTH = 76; // px - matches #side-nav-mini's fixed width
const SIDE_NAV_BACKDROP_MAX_OPACITY = 0.35;
const SIDE_NAV_SNAP_BIAS = 28; // px of directional bias applied before nearest-snap picks a stop, so a decisive flick commits to the next stop instead of springing back

// 'closed' | 'mini' | 'full'
let sideNavState = 'closed';
let sideNavFullWidth = 0; // measured from #side-nav-full - varies with viewport (82vw, capped 300px)
let sideNavDragging = false;
let sideNavAxisLocked = null; // null = undecided this gesture, true = horizontal, false = vertical
let sideNavStartX = 0;
let sideNavStartY = 0;
let sideNavCurrentX = 0;
let sideNavDragBaseWidth = 0; // shell width when the current drag began

function getSideNavEls() {
	return {
		panel: document.getElementById('side-nav'),
		mini: document.getElementById('side-nav-mini'),
		full: document.getElementById('side-nav-full'),
		backdrop: document.getElementById('side-nav-backdrop')
	};
}

// The drawer only makes sense on the logged-in, tab-bar-style screens -
// login/signup/create-post/edit-profile/gpa-calculator are all takeover
// screens with nowhere for a "back to feed/profile" drawer to send you.
// This list mirrors the one updateBottomNav() used to gate an earlier
// bottom nav bar on in core.js (the current bottom nav is narrower - see
// BOTTOM_NAV_ACTIVE_ITEM).
const SIDE_NAV_ELIGIBLE_VIEWS = ['feed-view', 'profile-view', 'courses-view', 'businesses-view', 'chat-view', 'library-view'];

function sideNavAvailable() {
	const activeView = document.querySelector('.view-section.active');
	return !!activeView && SIDE_NAV_ELIGIBLE_VIEWS.includes(activeView.id);
}

function measureSideNavFullWidth() {
	const { full } = getSideNavEls();
	return full ? full.offsetWidth : sideNavFullWidth;
}

function widthForState(state) {
	if (state === 'full') return sideNavFullWidth;
	if (state === 'mini') return SIDE_NAV_MINI_WIDTH;
	return 0;
}

function populateSideNav() {
	if (!session || !session.user) return;
	const handle = session.user.username || session.user.email.split('@')[0];
	const avatarSrc = session.user.profile_picture || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
	const avatarEl = document.getElementById('side-nav-avatar');
	const miniAvatarEl = document.getElementById('side-nav-mini-avatar');
	const nameEl = document.getElementById('side-nav-name');
	const handleEl = document.getElementById('side-nav-handle');
	if (avatarEl) avatarEl.src = avatarSrc;
	if (miniAvatarEl) miniAvatarEl.src = avatarSrc;
	if (nameEl) nameEl.textContent = session.user.full_name || '';
	if (handleEl) handleEl.textContent = `@${handle}`;
}

// Mirrors the active tab onto the matching side-nav rows (both the mini
// rail and full drawer copies share data-nav-key) so it doesn't just
// permanently show "Home" selected once you're actually on another view.
function applySideNavActiveState() {
	const activeView = document.querySelector('.view-section.active');
	const viewToKey = {
		'feed-view': 'home',
		'courses-view': 'courses',
		'profile-view': 'profile',
		'chat-view': 'chat',
		'library-view': 'library',
		'library-contribute-view': 'library',
		'search-view': 'search',
		'businesses-view': 'businesses',
		'wallet-view': 'wallet'
	};
	const activeKey = activeView ? viewToKey[activeView.id] : null;

	document.querySelectorAll('.side-nav-link[data-nav-key]').forEach(function(link) {
		const isActive = link.dataset.navKey === activeKey;
		link.classList.toggle('text-brand-red', isActive);
		link.classList.toggle('bg-red-50', isActive);
		link.classList.toggle('font-semibold', isActive && link.closest('#side-nav-full') !== null);
		link.classList.toggle('text-gray-500', !isActive);
		link.classList.toggle('font-medium', !isActive && link.closest('#side-nav-full') !== null);
	});
}

// px is the shell's width in pixels (0 = closed, SIDE_NAV_MINI_WIDTH =
// mini rail fully settled, sideNavFullWidth = full drawer fully settled).
// withTransition controls whether the CSS settle animation applies
// (false during an active drag, true for a snap-to-rest).
function setSideNavWidth(px, withTransition) {
	const { panel, mini, full, backdrop } = getSideNavEls();
	if (!panel) return;

	panel.classList.toggle('side-nav-dragging', !withTransition);
	if (backdrop) backdrop.classList.toggle('side-nav-dragging', !withTransition);

	panel.style.width = `${px}px`;

	// Cross-fade: the mini rail owns the closed->mini segment, the full
	// drawer owns the mini->full segment, so only one is ever animating
	// opacity at a time and the handoff between them lines up exactly at
	// the mini snap point.
	const miniSpan = SIDE_NAV_MINI_WIDTH || 1;
	const fullSpan = Math.max(sideNavFullWidth - SIDE_NAV_MINI_WIDTH, 1);
	const q = Math.min(1, Math.max(0, px / miniSpan));
	const p = Math.min(1, Math.max(0, (px - SIDE_NAV_MINI_WIDTH) / fullSpan));
	const miniOpacity = q * (1 - p);
	// Both layers occupy the same 0,0 box and the full drawer sits later
	// in the DOM (so it paints - and hit-tests - on top whenever they
	// overlap). Without this, an invisible (opacity 0) layer would still
	// intercept taps meant for whichever layer is actually showing.
	if (mini) {
		mini.style.opacity = String(miniOpacity);
		mini.style.pointerEvents = miniOpacity > 0.05 ? 'auto' : 'none';
	}
	if (full) {
		full.style.opacity = String(p);
		full.style.pointerEvents = p > 0.05 ? 'auto' : 'none';
	}

	if (backdrop) {
		const progress = sideNavFullWidth ? Math.min(1, Math.max(0, px / sideNavFullWidth)) : 0;
		backdrop.style.opacity = String(progress * SIDE_NAV_BACKDROP_MAX_OPACITY);
		backdrop.classList.toggle('pointer-events-none', progress <= 0);
	}
}

function goToSideNavState(state) {
	const { panel } = getSideNavEls();
	if (!panel) return;
	sideNavFullWidth = measureSideNavFullWidth();
	if (state !== 'closed') {
		populateSideNav();
		applySideNavActiveState();
	}
	sideNavState = state;
	setSideNavWidth(widthForState(state), true);
}

function openSideNav() {
	goToSideNavState('full');
}

function closeSideNav() {
	goToSideNavState('closed');
}

// ---- Touch handling ----
document.addEventListener('touchstart', function(e) {
	if (!sideNavAvailable()) return;
	const { panel } = getSideNavEls();
	if (!panel) return;
	const touch = e.touches[0];

	// A drag can start either from the screen's left edge (to open from
	// closed) or anywhere on the panel itself once it's showing the mini
	// rail or full drawer (to expand further or drag back closed).
	const startingFromEdge = sideNavState === 'closed' && touch.clientX <= SIDE_NAV_EDGE_ZONE;
	const startingFromPanel = sideNavState !== 'closed' && panel.contains(e.target);
	if (!startingFromEdge && !startingFromPanel) return;

	sideNavDragging = true;
	sideNavAxisLocked = null;
	sideNavFullWidth = measureSideNavFullWidth();
	sideNavDragBaseWidth = widthForState(sideNavState);
	sideNavStartX = touch.clientX;
	sideNavStartY = touch.clientY;
	sideNavCurrentX = touch.clientX;

	if (startingFromEdge) {
		populateSideNav();
		applySideNavActiveState();
	}
}, { passive: true });

document.addEventListener('touchmove', function(e) {
	if (!sideNavDragging) return;
	const touch = e.touches[0];
	sideNavCurrentX = touch.clientX;

	// Decide once per gesture whether this is the horizontal swipe that
	// drives the drawer, or a vertical scroll the page should keep
	// handling normally. Nothing is prevented yet in this ambiguous
	// window, so a vertical scroll starting near the edge is untouched.
	if (sideNavAxisLocked === null) {
		const dx = touch.clientX - sideNavStartX;
		const dy = touch.clientY - sideNavStartY;
		if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
		sideNavAxisLocked = Math.abs(dx) > Math.abs(dy);
		if (!sideNavAxisLocked) {
			sideNavDragging = false;
			return;
		}
	}

	// Confirmed horizontal drag for our drawer: stop the browser from also
	// treating this as its own gesture (edge-swipe-back on iOS Safari,
	// overscroll-triggered back/forward navigation on Chrome/Edge). This
	// listener has to be registered { passive: false } for preventDefault
	// to have any effect here - see the addEventListener call below.
	e.preventDefault();

	const delta = sideNavCurrentX - sideNavStartX;
	const px = Math.min(sideNavFullWidth, Math.max(0, sideNavDragBaseWidth + delta));
	setSideNavWidth(px, false);
}, { passive: false });

function endSideNavDrag() {
	if (!sideNavDragging) return;
	sideNavDragging = false;

	if (!sideNavAxisLocked) return; // never became a horizontal drag - nothing to settle

	const delta = sideNavCurrentX - sideNavStartX;
	const px = Math.min(sideNavFullWidth, Math.max(0, sideNavDragBaseWidth + delta));

	// Snap to whichever of the three stops is nearest, after nudging the
	// reading a little in the direction of travel - a decisive swipe past
	// a stop commits to the next one instead of springing back to where
	// it started.
	const direction = Math.sign(delta);
	const biased = px + direction * SIDE_NAV_SNAP_BIAS;
	const stops = [
		{ state: 'closed', width: 0 },
		{ state: 'mini', width: SIDE_NAV_MINI_WIDTH },
		{ state: 'full', width: sideNavFullWidth }
	];
	let nearest = stops[0];
	let nearestDist = Infinity;
	stops.forEach(function(stop) {
		const dist = Math.abs(biased - stop.width);
		if (dist < nearestDist) {
			nearestDist = dist;
			nearest = stop;
		}
	});

	goToSideNavState(nearest.state);
}

document.addEventListener('touchend', endSideNavDrag, { passive: true });
document.addEventListener('touchcancel', endSideNavDrag, { passive: true });

document.getElementById('side-nav-backdrop').addEventListener('click', closeSideNav);

// ---- Communities section: collapse chevron + favorite star ----
// Both are local, in-memory UI state only - there's no community backend
// yet (see the stub rows in side_nav.html), so nothing here persists
// across a reload or reopen of the drawer.
function toggleSideNavCommunities() {
	const list = document.getElementById('side-nav-communities-list');
	const toggleBtn = document.getElementById('side-nav-communities-toggle');
	if (!list || !toggleBtn) return;
	const collapsed = list.classList.toggle('hidden');
	toggleBtn.setAttribute('aria-expanded', String(!collapsed));
	toggleBtn.setAttribute('aria-label', collapsed ? 'Expand Your Communities' : 'Collapse Your Communities');
	const chevron = toggleBtn.querySelector('.side-nav-communities-chevron');
	if (chevron) chevron.classList.toggle('-rotate-90', collapsed);
}

function toggleSideNavStar(btn) {
	if (!btn) return;
	const nowActive = btn.getAttribute('aria-pressed') !== 'true';
	btn.setAttribute('aria-pressed', String(nowActive));
	const svg = btn.querySelector('svg');
	if (svg) svg.setAttribute('fill', nowActive ? 'currentColor' : 'none');
	btn.classList.toggle('text-yellow-400', nowActive);
	btn.classList.toggle('text-gray-300', !nowActive);
}
