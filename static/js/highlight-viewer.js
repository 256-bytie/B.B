// ---- Highlight viewer ----
// Full-screen, story-style viewer opened from the profile's Highlights row
// (templates/partials/highlight_viewer.html). Data comes from highlights.js:
// loadUserHighlights() / getHighlightItems() / loadHighlightItemMedia().
//
// Controls: tap the left third = previous item, tap the rest = next item, hold = pause
// (chrome fades out), swipe down or X = close. The plus button adds media to the open
// highlight through the existing upload sheet (see openHighlightUploadSheet).
// Photos run for HV_PHOTO_MS; videos run for their own duration and drive the progress bar.
// Running past the last item closes the viewer (back to the profile).

const HV_PHOTO_MS = 5000;
const HV_HOLD_MS = 200;
const HV_SWIPE_CLOSE_PX = 90;
const HV_PREV_ZONE = 0.33; // left share of the screen that means "previous"

const hv = {
	open: false,
	highlightId: null,
	highlight: null,
	items: [],
	index: 0,
	token: 0,        // bumps on every item change; stale async loads compare against it
	kind: '',        // 'photo' | 'video' for the item on screen
	ready: false,    // media on screen and progress running
	elapsed: 0,      // photo clock, ms
	lastTs: 0,
	raf: 0,
	pauseReasons: new Set(),
	revoke: null,    // revokes the current blob URL
	fills: [],
	down: null,
	holdTimer: 0
};

// Relative age, weeks all the way past a week ("now", "5m", "3h", "2d", "113w").
function formatHighlightAge(ts) {
	const seconds = Math.max(0, (Date.now() - ts) / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (minutes < 1) return 'now';
	if (minutes < 60) return minutes + 'm';
	if (hours < 24) return hours + 'h';
	if (days < 7) return days + 'd';
	return Math.floor(days / 7) + 'w';
}

(function initHighlightViewer() {
	const overlay = document.getElementById('highlight-viewer-overlay');
	if (!overlay) return;
	const stage = document.getElementById('highlight-viewer-stage');
	const imgEl = document.getElementById('highlight-viewer-img');
	const videoEl = document.getElementById('highlight-viewer-video');
	const progressEl = document.getElementById('highlight-viewer-progress');
	const coverEl = document.getElementById('highlight-viewer-cover');
	const titleEl = document.getElementById('highlight-viewer-title');
	const ageEl = document.getElementById('highlight-viewer-age');
	const audioEl = document.getElementById('highlight-viewer-audio');
	const audioTextEl = document.getElementById('highlight-viewer-audio-text');
	const addBtn = document.getElementById('highlight-viewer-add-btn');
	const closeBtn = document.getElementById('highlight-viewer-close-btn');

	// ---- pause / resume ----
	window.hvPause = function (reason) {
		if (!hv.open) return;
		hv.pauseReasons.add(reason);
		if (hv.kind === 'video') videoEl.pause();
	};
	window.hvResume = function (reason) {
		if (!hv.open || !hv.pauseReasons.delete(reason)) return;
		if (!hv.pauseReasons.size && hv.ready && hv.kind === 'video') playVideo();
	};

	function playVideo() {
		const p = videoEl.play();
		if (p && p.catch) {
			// Autoplay with sound can be refused; fall back to muted rather than a frozen item.
			p.catch(function () { videoEl.muted = true; videoEl.play().catch(function () {}); });
		}
	}

	// ---- progress ----
	function buildSegments() {
		progressEl.innerHTML = hv.items.map(function () { return '<div class="hv-seg"><i></i></div>'; }).join('');
		hv.fills = Array.prototype.slice.call(progressEl.querySelectorAll('i'));
	}

	function paintSegments() {
		hv.fills.forEach(function (fill, i) {
			fill.style.width = i < hv.index ? '100%' : '0%';
		});
	}

	function setProgress(frac) {
		const fill = hv.fills[hv.index];
		if (fill) fill.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
	}

	function tick(ts) {
		hv.raf = window.requestAnimationFrame(tick);
		const dt = hv.lastTs ? ts - hv.lastTs : 0;
		hv.lastTs = ts;
		if (!hv.ready || hv.pauseReasons.size) return;
		if (hv.kind === 'video') {
			if (videoEl.duration > 0) setProgress(videoEl.currentTime / videoEl.duration);
		} else {
			hv.elapsed += dt;
			setProgress(hv.elapsed / HV_PHOTO_MS);
			if (hv.elapsed >= HV_PHOTO_MS) next();
		}
	}

	// ---- header ----
	function renderHeader() {
		const h = hv.highlight;
		const item = hv.items[hv.index];
		titleEl.textContent = h.title || 'Highlights';
		coverEl.innerHTML = h.cover
			? '<img src="' + escapeHtml(h.cover) + '" alt="">'
			: '<i class="fa-solid fa-video"></i>';
		const created = (item && item.createdAt) || parseInt(h.id, 10) || Date.now();
		ageEl.textContent = formatHighlightAge(created);
		const audio = ((item && item.audio) || h.audio || '').trim();
		audioTextEl.textContent = audio;
		audioEl.style.display = audio ? 'flex' : 'none';
	}

	// ---- media ----
	function releaseMedia() {
		videoEl.pause();
		videoEl.onloadedmetadata = videoEl.onended = videoEl.onerror = videoEl.onplaying = null;
		imgEl.onload = imgEl.onerror = null;
		videoEl.removeAttribute('src');
		videoEl.load();
		imgEl.removeAttribute('src');
		imgEl.classList.add('hidden');
		videoEl.classList.add('hidden');
		if (hv.revoke) { hv.revoke(); hv.revoke = null; }
	}

	// Photos/videos close to the screen's shape fill it edge to edge; anything else (a wide
	// landscape photo) is letterboxed instead of being cropped to a sliver.
	function fitMedia(el, w, h) {
		if (!w || !h) return;
		const ratio = (w / h) / (window.innerWidth / window.innerHeight);
		el.classList.toggle('is-cover', ratio > 0.7 && ratio < 1.4);
	}

	function skipBroken() {
		showToast('Couldn\u2019t load this item.');
		next();
	}

	async function showItem(index) {
		const token = ++hv.token;
		hv.index = index;
		hv.ready = false;
		hv.elapsed = 0;
		hv.lastTs = 0;
		releaseMedia();
		paintSegments();
		renderHeader();

		const item = hv.items[index];
		let media = null;
		try {
			media = await loadHighlightItemMedia(hv.highlight, item);
		} catch (error) {
			console.error('Error loading highlight media:', error);
		}
		if (token !== hv.token || !hv.open) { if (media && media.revoke) media.revoke(); return; }
		if (!media) { skipBroken(); return; }
		hv.revoke = media.revoke || null;

		if (item.kind === 'video') {
			hv.kind = 'video';
			videoEl.muted = false;
			videoEl.onloadedmetadata = function () { fitMedia(videoEl, videoEl.videoWidth, videoEl.videoHeight); };
			videoEl.onplaying = function () { if (token === hv.token) hv.ready = true; };
			videoEl.onended = function () { if (token === hv.token) next(); };
			videoEl.onerror = function () { if (token === hv.token) skipBroken(); };
			videoEl.src = media.url;
			videoEl.classList.remove('hidden');
			if (!hv.pauseReasons.size) playVideo();
			else hv.ready = true; // paused (e.g. add sheet open): progress resumes via hvResume
		} else {
			hv.kind = 'photo';
			imgEl.onload = function () {
				if (token !== hv.token) return;
				fitMedia(imgEl, imgEl.naturalWidth, imgEl.naturalHeight);
				hv.ready = true;
			};
			imgEl.onerror = function () { if (token === hv.token) skipBroken(); };
			imgEl.src = media.url;
			imgEl.classList.remove('hidden');
		}
	}

	function next() {
		if (hv.index + 1 >= hv.items.length) { close(); return; }
		showItem(hv.index + 1);
	}

	function prev() {
		showItem(Math.max(0, hv.index - 1)); // on the first item this restarts it
	}

	// ---- open / close ----
	window.openHighlightViewer = function (highlightId, startIndex) {
		const highlight = loadUserHighlights().find(function (h) { return h.id === highlightId; });
		const items = highlight ? getHighlightItems(highlight) : [];
		if (!highlight || !items.length) {
			showToast('Nothing to show in this highlight yet.');
			return;
		}
		hv.open = true;
		hv.highlightId = highlightId;
		hv.highlight = highlight;
		hv.items = items;
		hv.pauseReasons.clear();
		hv.down = null;
		overlay.dataset.holding = '';
		overlay.style.transform = '';
		overlay.style.opacity = '';
		overlay.classList.remove('hidden');
		document.body.classList.add('overlay-open');
		buildSegments();
		cancelAnimationFrame(hv.raf);
		hv.raf = window.requestAnimationFrame(tick);
		showItem(Math.min(Math.max(startIndex || 0, 0), items.length - 1));
	};

	function close() {
		if (!hv.open) return;
		hv.open = false;
		hv.token++;
		hv.ready = false;
		cancelAnimationFrame(hv.raf);
		clearTimeout(hv.holdTimer);
		hv.pauseReasons.clear();
		releaseMedia();
		overlay.classList.add('hidden');
		overlay.classList.remove('hv-snap-back');
		overlay.style.transform = '';
		overlay.style.opacity = '';
		overlay.dataset.holding = '';
		document.body.classList.remove('overlay-open');
		progressEl.innerHTML = '';
		hv.fills = [];
		hv.items = [];
		hv.highlight = null;
	}
	window.closeHighlightViewer = close;

	// Called by highlights.js after media was added to a highlight: reload it and jump to the new item.
	window.refreshHighlightViewer = function (highlightId) {
		if (!hv.open || hv.highlightId !== highlightId) return;
		const highlight = loadUserHighlights().find(function (h) { return h.id === highlightId; });
		const items = highlight ? getHighlightItems(highlight) : [];
		if (!highlight || !items.length) return;
		hv.highlight = highlight;
		hv.items = items;
		buildSegments();
		showItem(items.length - 1);
	};

	// ---- gestures on the stage ----
	stage.addEventListener('pointerdown', function (e) {
		if (e.button > 0 || hv.down) return;
		hv.down = { x: e.clientX, y: e.clientY, dy: 0, moved: false, held: false };
		try { stage.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
		clearTimeout(hv.holdTimer);
		hv.holdTimer = setTimeout(function () {
			if (!hv.down || hv.down.moved) return;
			hv.down.held = true;
			overlay.dataset.holding = 'true';
			window.hvPause('hold');
		}, HV_HOLD_MS);
	});

	stage.addEventListener('pointermove', function (e) {
		const d = hv.down;
		if (!d) return;
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		if (!d.moved && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
			d.moved = true;
			clearTimeout(hv.holdTimer);
		}
		if (d.moved && !d.held && dy > 0 && Math.abs(dy) > Math.abs(dx)) {
			d.dy = dy; // swipe-down-to-close drags the whole viewer
			overlay.classList.remove('hv-snap-back');
			overlay.style.transform = 'translateY(' + dy + 'px)';
			overlay.style.opacity = String(Math.max(0.4, 1 - dy / 700));
		}
	});

	function endGesture(e, cancelled) {
		const d = hv.down;
		if (!d) return;
		hv.down = null;
		clearTimeout(hv.holdTimer);
		try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
		if (d.held) {
			overlay.dataset.holding = '';
			window.hvResume('hold');
			return;
		}
		if (d.dy > 0) {
			if (!cancelled && d.dy > HV_SWIPE_CLOSE_PX) { close(); return; }
			overlay.classList.add('hv-snap-back');
			overlay.style.transform = '';
			overlay.style.opacity = '';
			return;
		}
		if (cancelled || d.moved) return;
		if (e.clientX < window.innerWidth * HV_PREV_ZONE) prev(); else next();
	}
	stage.addEventListener('pointerup', function (e) { endGesture(e, false); });
	stage.addEventListener('pointercancel', function (e) { endGesture(e, true); });
	stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });

	// ---- buttons, keys, lifecycle ----
	closeBtn.addEventListener('click', close);
	addBtn.addEventListener('click', function () {
		if (!hv.open) return;
		window.hvPause('add'); // resumed by endHighlightAddMode() in highlights.js
		openHighlightUploadSheet(hv.highlightId);
	});

	document.addEventListener('keydown', function (e) {
		if (!hv.open) return;
		if (e.key === 'Escape') close();
		else if (e.key === 'ArrowRight') next();
		else if (e.key === 'ArrowLeft') prev();
	});
	document.addEventListener('visibilitychange', function () {
		if (document.hidden) window.hvPause('hidden'); else window.hvResume('hidden');
	});
	window.addEventListener('popstate', close);
})();
