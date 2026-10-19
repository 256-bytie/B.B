// ---- Chat GIF + sticker picker and messages ----
// The picker (templates/partials/chat_gif_picker.html) is docked under the
// composer and opened by the composer's GIF icon. It has two modes, switched by
// the button at the end of the search bar:
//   gif      search + category chips + GIFs        <- static/gifs/manifest.json
//   sticker  search + stickers (no chips)          <- static/stickers/manifest.json
// Everything is a local file; there is no external API.
//
// Wire format: both are ordinary text messages, so backend, polling and delivery
// are unchanged.
//   GIF      "[gif:<id>]"          <id> = file name without ".gif"
//   sticker  "[sticker:<file>]"    <file> = full file name, e.g. "My Cat.webp"
// Message renderers turn the token into an image (chatBubbleHtml in chat.js) and
// show "GIF" / "Sticker" wherever a text preview is needed (chatPreviewText).
//
// File naming (lowercase letters, digits and hyphens only):
//   static/gifs/<category>_<name>.gif    or  <name>.gif for no category
//   static/stickers/<any name>.webp | .png   (stickers have no categories; any file name
//   works except one that starts with "." or contains [ ] / \ or control characters)

const CHAT_GIF_DIR = '/static/gifs/';
const CHAT_GIF_MANIFEST_URL = CHAT_GIF_DIR + 'manifest.json';
const CHAT_STICKER_DIR = '/static/stickers/';
const CHAT_STICKER_MANIFEST_URL = CHAT_STICKER_DIR + 'manifest.json';
const CHAT_GIF_TOKEN_RE = /^\[gif:([a-z0-9][a-z0-9_-]{0,80})\]$/i;
// Sticker file names are free-form. Excluded: a leading dot or space, [ ] / \ and control
// characters (they would break the token or the path). URLs always go through encodeURIComponent.
const CHAT_STICKER_TOKEN_RE = /^\[sticker:([^\s.\[\]\/\\\x00-\x1f][^\[\]\/\\\x00-\x1f]{0,119}\.(?:png|webp))\]$/i;
const CHAT_GIF_FILE_RE = /^([a-z0-9][a-z0-9-]*)(?:_([a-z0-9][a-z0-9-]*))?\.gif$/i;
const CHAT_STICKER_FILE_RE = /^([^\s.\[\]\/\\\x00-\x1f][^\[\]\/\\\x00-\x1f]{0,119})\.(?:png|webp)$/i;
// Chip order from the design; any other category found in the manifest is appended.
const CHAT_GIF_CHIPS = [
	['trending', 'Trending'], ['happy', 'Happy'], ['reaction', 'Reaction'],
	['meme', 'Meme'], ['love', 'Love'], ['funny', 'Funny']
];

// "[gif:<id>]" -> id, otherwise null.
function chatParseGif(text) {
	const m = CHAT_GIF_TOKEN_RE.exec(String(text == null ? '' : text).trim());
	return m ? m[1] : null;
}

// "[sticker:<file>]" -> file name, otherwise null.
function chatParseSticker(text) {
	const m = CHAT_STICKER_TOKEN_RE.exec(String(text == null ? '' : text).trim());
	return m ? m[1] : null;
}

// Text shown in list rows, reply quotes and the message sheet.
function chatPreviewText(text) {
	if (chatParseGif(text)) return 'GIF';
	if (chatParseSticker(text)) return 'Sticker';
	return text;
}

function chatGifImgHtml(id) {
	const src = escapeHtml(CHAT_GIF_DIR + id + '.gif');
	return '<img class="chat-gif-msg-img" src="' + src + '" alt="GIF" draggable="false" ' +
		'onload="chatGifImgLoaded(this)" onerror="chatGifImgFailed(this)">';
}

function chatStickerImgHtml(file) {
	const src = escapeHtml(CHAT_STICKER_DIR + encodeURIComponent(file));
	return '<img class="chat-sticker-msg-img" src="' + src + '" alt="Sticker" draggable="false" ' +
		'onload="chatGifImgLoaded(this)" onerror="chatGifImgFailed(this)">';
}

// Shared by GIF and sticker images in the thread.
function chatGifImgLoaded(img) {
	img.classList.add('is-loaded');
	// The bubble grew from its placeholder; keep the latest message in view when
	// the reader was already at the bottom.
	const scroll = document.getElementById('chat-conv-scroll');
	if (!scroll) return;
	const gap = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
	if (gap <= img.offsetHeight + 120) scroll.scrollTop = scroll.scrollHeight;
}

function chatGifImgFailed(img) {
	const note = document.createElement('span');
	note.className = 'chat-gif-msg-missing';
	note.textContent = img.classList.contains('chat-sticker-msg-img') ? 'Sticker unavailable' : 'GIF unavailable';
	img.replaceWith(note);
}

(function () {
	const picker = document.getElementById('chat-gif-picker');
	if (!picker) return;
	const view = document.getElementById('chat-conversation-view');
	const searchInput = document.getElementById('chat-gif-search-input');
	const chipsEl = document.getElementById('chat-gif-chips');
	const scrollEl = document.getElementById('chat-gif-scroll');
	const gridEl = document.getElementById('chat-gif-grid');
	const statusEl = document.getElementById('chat-gif-status');
	const handleEl = document.getElementById('chat-gif-handle');
	const toggleBtn = document.getElementById('chat-conv-gif-btn');
	const modeBtn = document.getElementById('chat-gif-mode-btn');

	// One entry per content type. items: { key, token, url, category, words }.
	const kinds = {
		gif: {
			manifestUrl: CHAT_GIF_MANIFEST_URL, listKey: 'gifs', parse: parseGifs,
			items: [], status: 'idle', loading: null
		},
		sticker: {
			manifestUrl: CHAT_STICKER_MANIFEST_URL, listKey: 'stickers', parse: parseStickers,
			items: [], status: 'idle', loading: null
		}
	};
	const state = { mode: 'gif', category: 'trending', query: '' };

	function cur() { return kinds[state.mode]; }

	function parseGifs(list) {
		const out = [];
		list.forEach(function (file) {
			const m = typeof file === 'string' ? CHAT_GIF_FILE_RE.exec(file) : null;
			if (!m) return;
			const category = m[2] ? m[1].toLowerCase() : '';
			const name = (m[2] || m[1]).toLowerCase().replace(/-/g, ' ');
			const id = file.slice(0, -4);
			out.push({
				key: id,
				token: '[gif:' + id + ']',
				url: CHAT_GIF_DIR + id + '.gif',
				category: category,
				words: (category + ' ' + name).trim()
			});
		});
		return out;
	}

	function parseStickers(list) {
		const out = [];
		list.forEach(function (file) {
			const m = typeof file === 'string' ? CHAT_STICKER_FILE_RE.exec(file) : null;
			if (!m) return;
			out.push({
				key: file,
				token: '[sticker:' + file + ']',
				url: CHAT_STICKER_DIR + encodeURIComponent(file),
				category: '',
				words: m[1].toLowerCase().replace(/[-_.\s]+/g, ' ').trim()
			});
		});
		return out;
	}

	function parseManifest(kind, data) {
		const list = Array.isArray(data) ? data : (data && Array.isArray(data[kind.listKey]) ? data[kind.listKey] : []);
		const seen = Object.create(null);
		return kind.parse(list).filter(function (it) {
			if (seen[it.key]) return false; // exact match: file names are case-sensitive
			seen[it.key] = true;
			return true;
		});
	}

	function load(kind) {
		if (kind.status === 'ready' || kind.loading) return;
		kind.status = 'loading';
		render();
		kind.loading = fetch(kind.manifestUrl, { cache: 'no-cache' })
			.then(function (res) {
				if (!res.ok) throw new Error('manifest ' + res.status);
				return res.json();
			})
			.then(function (data) {
				kind.items = parseManifest(kind, data);
				kind.status = 'ready';
			})
			.catch(function () { kind.status = 'error'; })
			.then(function () { kind.loading = null; render(); });
	}

	function chipList() {
		const known = {};
		CHAT_GIF_CHIPS.forEach(function (c) { known[c[0]] = true; });
		const extras = [];
		kinds.gif.items.forEach(function (it) {
			if (it.category && !known[it.category] && extras.indexOf(it.category) === -1) extras.push(it.category);
		});
		extras.sort();
		return CHAT_GIF_CHIPS.concat(extras.map(function (c) { return [c, c.charAt(0).toUpperCase() + c.slice(1)]; }));
	}

	function visibleItems() {
		const items = cur().items;
		const q = state.query.trim().toLowerCase();
		if (q) {
			const terms = q.split(/\s+/);
			return items.filter(function (it) {
				return terms.every(function (t) { return it.words.indexOf(t) !== -1; });
			});
		}
		if (state.mode === 'sticker' || state.category === 'trending') return items;
		return items.filter(function (it) { return it.category === state.category; });
	}

	function renderChips() {
		const gifMode = state.mode === 'gif';
		chipsEl.hidden = !gifMode; // stickers have no categories
		if (!gifMode) return;
		const searching = !!state.query.trim();
		chipsEl.innerHTML = chipList().map(function (c) {
			const on = !searching && c[0] === state.category;
			return '<button id="chat-gif-chip-' + escapeHtml(c[0]) + '" type="button" role="tab" class="chat-gif-chip' + (on ? ' is-active' : '') +
				'" data-category="' + escapeHtml(c[0]) + '" aria-selected="' + on + '">' + escapeHtml(c[1]) + '</button>';
		}).join('');
	}

	function tileHtml(it, i) {
		const sticker = state.mode === 'sticker';
		// Sticker file names are free-form (spaces, unicode), so their DOM ids use the grid index.
		return '<button id="chat-' + (sticker ? 'sticker-tile-' + i : 'gif-tile-' + escapeHtml(it.key)) + '" type="button" class="chat-gif-tile' +
			(sticker ? ' chat-sticker-tile' : '') + '" data-token="' + escapeHtml(it.token) +
			'" aria-label="Send ' + (sticker ? 'sticker' : 'GIF') + ': ' + escapeHtml(it.words) + '">' +
			'<img src="' + escapeHtml(it.url) + '" alt="" loading="lazy" decoding="async" draggable="false">' +
			(sticker ? '' : '<span class="chat-gif-badge">GIF</span>') + '</button>';
	}

	function renderGrid() {
		const kind = cur();
		const noun = state.mode === 'sticker' ? 'stickers' : 'GIFs';
		let msg = '';
		let retry = false;
		let items = [];
		if (kind.status === 'loading' || kind.status === 'idle') {
			msg = 'Loading ' + noun + '\u2026';
		} else if (kind.status === 'error') {
			msg = 'Couldn\u2019t load ' + noun + '.';
			retry = true;
		} else if (!kind.items.length) {
			msg = 'No ' + noun + ' yet.';
		} else {
			items = visibleItems();
			if (!items.length) {
				msg = state.query.trim() ? 'No ' + noun + ' found.' : 'No GIFs in this category.';
			}
		}
		gridEl.innerHTML = items.map(tileHtml).join('');
		statusEl.hidden = !msg;
		statusEl.textContent = msg;
		if (retry) {
			const btn = document.createElement('button');
			btn.id = 'chat-gif-retry-btn';
			btn.type = 'button';
			btn.textContent = 'Try again';
			btn.addEventListener('click', function () { load(cur()); });
			statusEl.appendChild(document.createElement('br'));
			statusEl.appendChild(btn);
		}
	}

	function render() {
		renderChips();
		renderGrid();
	}

	// Mode-dependent attributes: CSS reads data-mode (grid shape, which icon the switch shows).
	function applyMode() {
		const sticker = state.mode === 'sticker';
		picker.setAttribute('data-mode', state.mode);
		searchInput.placeholder = sticker ? 'Search stickers' : 'Search GIFs';
		searchInput.setAttribute('aria-label', searchInput.placeholder);
		if (modeBtn) modeBtn.setAttribute('aria-label', sticker ? 'Switch to GIFs' : 'Switch to stickers');
	}

	function setMode(mode) {
		state.mode = mode;
		state.category = 'trending';
		state.query = '';
		searchInput.value = '';
		applyMode();
		load(cur());
		render();
		scrollEl.scrollTop = 0;
	}

	function isOpen() { return !picker.hidden; }

	function open() {
		if (isOpen()) return;
		picker.hidden = false;
		view.setAttribute('data-gif-open', 'true');
		if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
		// The keyboard and the picker would fight for the bottom of the screen.
		if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
		load(cur());
		render();
		// The thread just shrank: keep the latest messages visible.
		window.requestAnimationFrame(function () {
			if (typeof scrollChatConversationToBottom === 'function') scrollChatConversationToBottom();
		});
	}

	function close() {
		if (!isOpen()) return;
		picker.hidden = true;
		view.removeAttribute('data-gif-open');
		if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
		// Always reopen on GIFs / Trending with an empty search.
		state.mode = 'gif';
		state.category = 'trending';
		state.query = '';
		searchInput.value = '';
		applyMode();
		scrollEl.scrollTop = 0;
	}

	function sendToken(token) {
		if (!chatParseGif(token) && !chatParseSticker(token)) return;
		if (chatDispatchMessage(token)) close();
	}

	window.toggleChatGifPicker = function () { if (isOpen()) close(); else open(); };
	window.closeChatGifPicker = close;

	if (modeBtn) modeBtn.addEventListener('click', function () {
		setMode(state.mode === 'gif' ? 'sticker' : 'gif');
	});

	chipsEl.addEventListener('click', function (e) {
		const chip = e.target.closest('.chat-gif-chip');
		if (!chip) return;
		state.category = chip.dataset.category;
		state.query = '';
		searchInput.value = '';
		render();
		scrollEl.scrollTop = 0;
	});

	gridEl.addEventListener('click', function (e) {
		const tile = e.target.closest('.chat-gif-tile');
		if (tile) sendToken(tile.dataset.token);
	});

	// A file listed in the manifest but missing on disk just drops out of the grid.
	gridEl.addEventListener('error', function (e) {
		if (e.target && e.target.tagName === 'IMG') {
			const tile = e.target.closest('.chat-gif-tile');
			if (tile) tile.remove();
		}
	}, true);

	searchInput.addEventListener('input', function () {
		state.query = searchInput.value;
		render();
		scrollEl.scrollTop = 0;
	});
	searchInput.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { e.preventDefault(); searchInput.blur(); }
	});

	// Tapping the message field brings the keyboard back, so the picker steps aside.
	const msgInput = document.getElementById('chat-conv-input');
	if (msgInput) msgInput.addEventListener('focus', close);

	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && isOpen()) close();
	});

	// Swipe down on the handle to dismiss; a tap on it dismisses too.
	let dragY = null;
	handleEl.addEventListener('touchstart', function (e) { dragY = e.touches[0].clientY; }, { passive: true });
	handleEl.addEventListener('touchmove', function (e) {
		if (dragY !== null && e.touches[0].clientY - dragY > 40) { dragY = null; close(); }
	}, { passive: true });
	handleEl.addEventListener('touchend', function () { dragY = null; }, { passive: true });
	handleEl.addEventListener('click', close);
})();
