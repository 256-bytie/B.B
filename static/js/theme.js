// ---- Light/Dark theme system ----
// The actual color swap is CSS-only (see the ".dark ..." overrides in
// style.css, keyed off a `dark` class on <html>). This file only owns:
// deciding which theme is active, persisting it, applying/removing the
// class, keeping every theme-switcher icon in the UI in sync, and adding
// a short-lived transition so the swap animates instead of snapping.
//
// The class itself is already applied before first paint by the inline
// script in _preamble.html (to avoid a flash of the wrong theme) - this
// file re-derives the same value on load so the two never disagree, and
// owns every change after that.

const THEME_STORAGE_KEY = 'beebo-theme';
const THEME_TRANSITION_MS = 220;

function getStoredTheme() {
	try {
		return localStorage.getItem(THEME_STORAGE_KEY);
	} catch (e) {
		return null;
	}
}

function getCurrentTheme() {
	return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function setThemeToggleIcons(theme) {
	// Every theme-switcher button in the UI (currently: the full drawer
	// footer and the mini rail) shares this class, so a single query
	// keeps them all in sync regardless of how many exist.
	document.querySelectorAll('.theme-toggle-icon').forEach(function(icon) {
		icon.classList.toggle('fa-moon', theme === 'light');
		icon.classList.toggle('fa-sun', theme === 'dark');
	});
	document.querySelectorAll('.theme-toggle-btn').forEach(function(btn) {
		btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
	});
}

function applyTheme(theme, withTransition) {
	const root = document.documentElement;

	if (withTransition) {
		// Scoped to a class instead of a permanent global rule, so normal
		// hovers/interactions elsewhere in the app never pick up a
		// transition they didn't ask for - only the moment of the switch does.
		root.classList.add('theme-transitioning');
		window.setTimeout(function() {
			root.classList.remove('theme-transitioning');
		}, THEME_TRANSITION_MS);
	}

	root.classList.toggle('dark', theme === 'dark');
	setThemeToggleIcons(theme);

	try {
		localStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch (e) {}
}

function toggleTheme() {
	applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark', true);
}

function initTheme() {
	// _preamble.html's inline script already set the class pre-paint;
	// this just brings the icons/storage in line with that decision
	// (no transition - this is page load, not a user-initiated switch).
	const stored = getStoredTheme();
	const theme = stored === 'dark' ? 'dark' : (getCurrentTheme() === 'dark' ? 'dark' : 'light');
	applyTheme(theme, false);
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initTheme);
} else {
	initTheme();
}
