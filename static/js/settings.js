// ---- Settings screen ----
// A static list of settings rows (templates/partials/settings.html). Opened from the
// profile's settings button and the side nav; the back arrow returns to whichever screen it
// came from. Rows are wired by data-settings-action below.
//
//   search bar    -> full search screen (settings_search.html); results run the row actions below
//   account       -> the existing Edit Profile screen (Back returns here)
//   appearance    -> light/dark choice in a bottom sheet (theme.js owns the theme)
//   payment       -> Payment methods screen (empty state; Back returns here)
//     Add new card -> Add card form (validation only; nothing is stored or sent)
//   security, privacy, notifications -> no feature behind them yet ("Coming soon")

// Screens Settings can be opened from (the side nav is reachable from all of them).
const SETTINGS_RETURN_VIEWS = ['feed', 'courses', 'library', 'businesses', 'search', 'chat', 'profile', 'user-profile', 'wallet'];
let settingsReturnView = 'feed';

// Records where the user came from (showView clears the previous screen's `active`
// class, so it has to be read before switching) so Back can return there.
function openSettingsView() {
	const activeEl = document.querySelector('.view-section.active');
	const name = activeEl ? activeEl.id.replace(/-view$/, '') : 'feed';
	if (SETTINGS_RETURN_VIEWS.includes(name)) settingsReturnView = name;
	showView('settings');
}

function closeSettingsView() {
	closeSettingsSheet();
	showView(settingsReturnView || 'feed');
}

// ---- Payment methods ----
// Empty-state screen only; there is no card storage yet, so "Add new card" is a stub.
function openPaymentMethodsView() {
	showView('payment-methods');
}

function closePaymentMethodsView() {
	showView('settings');
}

function addPaymentCard() {
	openAddCardView();
}

// ---- Add card form ----
// Validation only. There is no card storage or payment processor yet, so nothing typed
// here is saved or sent anywhere, and the fields are wiped whenever the screen opens/closes.
// Real storage must tokenize through a processor (e.g. Stripe); never persist PAN/CVC ourselves.
function cardEls() {
	return {
		name: document.getElementById('card-name-input'),
		number: document.getElementById('card-number-input'),
		expiry: document.getElementById('card-expiry-input'),
		cvc: document.getElementById('card-cvc-input'),
		btn: document.getElementById('card-add-submit-btn')
	};
}

function isAmexNumber(digits) { return /^3[47]/.test(digits); }

function luhnValid(digits) {
	let sum = 0;
	let dbl = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (dbl) { d *= 2; if (d > 9) d -= 9; }
		sum += d;
		dbl = !dbl;
	}
	return sum % 10 === 0;
}

function formatCardNumber(digits) {
	if (isAmexNumber(digits)) {
		digits = digits.slice(0, 15);
		return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10)].filter(Boolean).join(' ');
	}
	digits = digits.slice(0, 19);
	return digits.replace(/(.{4})/g, '$1 ').trim();
}

function cardNumberValid(digits) {
	const len = isAmexNumber(digits) ? 15 : null;
	if (len) return digits.length === 15 && luhnValid(digits);
	return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

function cardExpiryValid(value) {
	const m = /^(\d{2})\/(\d{2})$/.exec(value);
	if (!m) return false;
	const month = parseInt(m[1], 10);
	const year = 2000 + parseInt(m[2], 10);
	if (month < 1 || month > 12) return false;
	const now = new Date();
	return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

function updateAddCardButton() {
	const el = cardEls();
	const digits = el.number.value.replace(/\D/g, '');
	const cvcLen = isAmexNumber(digits) ? 4 : 3;
	const ok = el.name.value.trim().length > 0 &&
		cardNumberValid(digits) &&
		cardExpiryValid(el.expiry.value) &&
		el.cvc.value.length === cvcLen;
	el.btn.disabled = !ok;
}

function resetAddCardForm() {
	const el = cardEls();
	if (!el.name) return;
	el.name.value = (typeof session !== 'undefined' && session && session.user && session.user.full_name) || '';
	el.number.value = '';
	el.expiry.value = '';
	el.cvc.value = '';
	updateAddCardButton();
}

function openAddCardView() {
	resetAddCardForm();
	showView('payment-card-add');
}

function closeAddCardView() {
	resetAddCardForm();
	showView('payment-methods');
}

function submitAddCard() {
	const el = cardEls();
	if (el.btn.disabled) return;
	resetAddCardForm();
	showToast('Adding cards isn\'t available yet');
}

(function initAddCardForm() {
	const el = cardEls();
	if (!el.name) return;

	el.name.addEventListener('input', updateAddCardButton);

	el.number.addEventListener('input', function () {
		const raw = el.number.value;
		const caret = el.number.selectionStart || 0;
		const digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, '').length;
		const formatted = formatCardNumber(raw.replace(/\D/g, ''));
		el.number.value = formatted;
		let pos = 0;
		let seen = 0;
		while (pos < formatted.length && seen < digitsBeforeCaret) {
			if (/\d/.test(formatted[pos])) seen++;
			pos++;
		}
		el.number.setSelectionRange(pos, pos);
		// A 3-digit CVC may be longer than the new brand allows; trim it.
		const max = isAmexNumber(formatted.replace(/\D/g, '')) ? 4 : 3;
		if (el.cvc.value.length > max) el.cvc.value = el.cvc.value.slice(0, max);
		updateAddCardButton();
	});

	el.expiry.addEventListener('input', function (e) {
		let digits = el.expiry.value.replace(/\D/g, '').slice(0, 4);
		if (digits.length === 1 && parseInt(digits, 10) > 1) digits = '0' + digits;
		const deleting = e.inputType && e.inputType.indexOf('delete') === 0;
		if (digits.length > 2) el.expiry.value = digits.slice(0, 2) + '/' + digits.slice(2);
		else if (digits.length === 2 && !deleting) el.expiry.value = digits + '/';
		else el.expiry.value = digits;
		updateAddCardButton();
	});

	el.cvc.addEventListener('input', function () {
		const max = isAmexNumber(el.number.value.replace(/\D/g, '')) ? 4 : 3;
		el.cvc.value = el.cvc.value.replace(/\D/g, '').slice(0, max);
		updateAddCardButton();
	});

	document.getElementById('card-add-form').addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { e.preventDefault(); submitAddCard(); }
	});
})();

// ---- Search ----
// Tapping the search bar on Settings opens a full search screen (settings_search.html). The
// results are the Settings rows themselves (labels read from the DOM, so they stay in sync),
// matched on label or the extra keywords below; tapping a result runs that row's action.
const SETTINGS_SEARCH_KEYWORDS = {
	account: ['profile', 'edit profile', 'username', 'name', 'bio', 'download data', 'deactivate', 'deactivation', 'delete account'],
	security: ['password', 'password reset', 'reset password', 'change password', 'authentication', '2fa', 'two-factor', 'sessions', 'login', 'log in', 'sign in'],
	privacy: ['block', 'blocked', 'mute', 'muted', 'visibility', 'interactions', 'who can see', 'private', 'safety'],
	payment: ['card', 'cards', 'billing', 'credit', 'debit', 'add card', 'payment'],
	appearance: ['theme', 'dark mode', 'light mode', 'dark', 'light', 'display', 'accessibility', 'contrast', 'motion', 'languages', 'language', 'preferred language', 'data usage', 'media', 'sound'],
	notifications: ['alerts', 'push', 'email', 'notification']
};

function settingsSearchItems() {
	return Array.prototype.map.call(document.querySelectorAll('#settings-view .settings-row[data-settings-action]'), function (row) {
		const action = row.dataset.settingsAction;
		return { action: action, label: row.querySelector('.settings-row-label').textContent.trim(), keywords: SETTINGS_SEARCH_KEYWORDS[action] || [] };
	});
}

function matchSettings(query) {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const scored = [];
	settingsSearchItems().forEach(function (item) {
		const label = item.label.toLowerCase();
		let score = -1;
		if (label.indexOf(q) === 0) score = 0;
		else if (label.indexOf(q) !== -1) score = 1;
		else if (item.keywords.some(function (k) { return k.indexOf(q) !== -1; })) score = 2;
		if (score >= 0) scored.push({ item: item, score: score });
	});
	scored.sort(function (a, b) { return a.score - b.score; });
	return scored.map(function (s) { return s.item; });
}

function renderSettingsSearch() {
	const input = document.getElementById('settings-search-input');
	const q = input ? input.value : '';
	const hint = document.getElementById('settings-search-hint');
	const empty = document.getElementById('settings-search-empty');
	const list = document.getElementById('settings-search-results');
	const clear = document.getElementById('settings-search-clear-btn');
	if (!list) return;
	const hasQuery = q.trim().length > 0;
	const results = matchSettings(q);
	list.textContent = '';
	results.forEach(function (item) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'ssearch-result';
		btn.setAttribute('role', 'option');
		btn.dataset.searchAction = item.action;
		btn.textContent = item.label;
		list.appendChild(btn);
	});
	if (hint) hint.hidden = hasQuery;
	if (empty) empty.hidden = !hasQuery || results.length > 0;
	if (clear) clear.hidden = !input || input.value.length === 0;
}

function openSettingsSearch() {
	const input = document.getElementById('settings-search-input');
	if (input) input.value = '';
	renderSettingsSearch();
	showView('settings-search');
	if (input) requestAnimationFrame(function () { input.focus(); });
}

function closeSettingsSearch() {
	const input = document.getElementById('settings-search-input');
	if (input) { input.blur(); input.value = ''; }
	renderSettingsSearch();
	showView('settings');
}

// Runs a Settings row's action from the search results.
function runSettingsSearchResult(action) {
	const input = document.getElementById('settings-search-input');
	if (input) input.blur();
	if (SETTINGS_ACTIONS[action]) SETTINGS_ACTIONS[action]();
}

// ---- Appearance and display screen ----
// Options are placeholders for now ("Coming soon"); none has a screen behind it yet.
function openAppearanceView() {
	showView('appearance-display');
}

function closeAppearanceView() {
	showView('settings');
}

// ---- Appearance sheet ----
function syncSettingsThemeChoice() {
	const current = getCurrentTheme();
	document.querySelectorAll('.settings-theme-option').forEach(function (btn) {
		btn.setAttribute('aria-checked', btn.dataset.themeChoice === current ? 'true' : 'false');
	});
}

function openSettingsSheet() {
	const sheet = document.getElementById('settings-appearance-sheet');
	const backdrop = document.getElementById('settings-appearance-backdrop');
	if (!sheet || !backdrop) return;
	syncSettingsThemeChoice();
	sheet.classList.remove('hidden');
	backdrop.classList.remove('hidden');
}

function closeSettingsSheet() {
	const sheet = document.getElementById('settings-appearance-sheet');
	const backdrop = document.getElementById('settings-appearance-backdrop');
	if (sheet) sheet.classList.add('hidden');
	if (backdrop) backdrop.classList.add('hidden');
}

// Row actions, shared by the Settings list and the search results.
const SETTINGS_ACTIONS = {
	account: function () { openEditProfileView('settings'); },
	security: function () { showToast('Coming soon'); },
	privacy: function () { showToast('Coming soon'); },
	payment: openPaymentMethodsView,
	appearance: openAppearanceView,
	notifications: function () { showToast('Coming soon'); }
};

(function initSettingsView() {
	const view = document.getElementById('settings-view');
	if (!view) return;

	view.addEventListener('click', function (e) {
		const row = e.target.closest('[data-settings-action]');
		if (row && SETTINGS_ACTIONS[row.dataset.settingsAction]) {
			SETTINGS_ACTIONS[row.dataset.settingsAction]();
			return;
		}
		const choice = e.target.closest('[data-theme-choice]');
		if (choice) {
			if (getCurrentTheme() !== choice.dataset.themeChoice) applyTheme(choice.dataset.themeChoice, true);
			syncSettingsThemeChoice();
			closeSettingsSheet();
		}
	});

	const adisp = document.getElementById('appearance-display-view');
	if (adisp) {
		adisp.addEventListener('click', function (e) {
			if (e.target.closest('[data-appearance-option]')) showToast('Coming soon');
		});
	}

	// Search screen: live results, clear button, tap a result to open that setting.
	const searchInput = document.getElementById('settings-search-input');
	const clearBtn = document.getElementById('settings-search-clear-btn');
	const results = document.getElementById('settings-search-results');
	if (searchInput) {
		searchInput.addEventListener('input', renderSettingsSearch);
		searchInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { e.preventDefault(); searchInput.blur(); }
		});
	}
	if (clearBtn) {
		clearBtn.addEventListener('click', function () {
			searchInput.value = '';
			renderSettingsSearch();
			searchInput.focus();
		});
	}
	if (results) {
		results.addEventListener('click', function (e) {
			const btn = e.target.closest('[data-search-action]');
			if (btn) runSettingsSearchResult(btn.dataset.searchAction);
		});
	}

	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') closeSettingsSheet();
	});
})();
