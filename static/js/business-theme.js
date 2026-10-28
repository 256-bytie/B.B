// ---- Business theme screen (templates/partials/business_theme.html) ----
// Opened from the "Theme" item in the business profile's 3 dot menu. The owner picks
// an accent color (preset swatch, hue slider, hex field or eyedropper) and sees a live
// preview: the real Businesses / My Stores card (buildBusinessCard, businesses.js)
// rendered from the business being edited (bpCurrent in business-profile.js) with that
// color. "Save theme" stores it on the business (POST /api/businesses/<id>/theme), so
// the accent and the cover-backed card style appear on that business's cards only.
// Nothing else in the app is recolored.
// Depends on showView/apiFetch (core.js), showToast (compose.js), bpCurrent
// (business-profile.js), buildBusinessCard/businessShade (businesses.js).

const BT_DEFAULT = '#DA292E';
const BT_PRESETS = [
	{ name: 'Red', hex: '#DA292E' },
	{ name: 'Blue', hex: '#2563EB' },
	{ name: 'Purple', hex: '#7C3AED' },
	{ name: 'Green', hex: '#16A34A' },
	{ name: 'Orange', hex: '#F97316' },
	{ name: 'Pink', hex: '#EC4899' }
];
let btAccent = BT_DEFAULT; // color being previewed
let btSaved = null;        // color stored on the business (null = no theme)
let btBusy = false;

function btNormalizeHex(value) {
	let v = String(value || '').trim().replace(/^#/, '');
	if (/^[0-9a-f]{3}$/i.test(v)) v = v.split('').map(function (c) { return c + c; }).join('');
	return /^[0-9a-f]{6}$/i.test(v) ? '#' + v.toUpperCase() : null;
}

function btHexToHue(hex) {
	const n = parseInt(hex.slice(1), 16);
	const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (x) { return x / 255; });
	const max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]);
	const d = max - min;
	if (d === 0) return 0;
	let h;
	if (max === c[0]) h = ((c[1] - c[2]) / d) % 6;
	else if (max === c[1]) h = (c[2] - c[0]) / d + 2;
	else h = (c[0] - c[1]) / d + 4;
	return Math.round(((h * 60) + 360) % 360);
}

function btHueToHex(h) {
	const s = 0.72, l = 0.5;
	const k = function (n) { return (n + h / 30) % 12; };
	const a = s * Math.min(l, 1 - l);
	const f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
	return '#' + [f(0), f(8), f(4)].map(function (x) {
		return Math.round(x * 255).toString(16).padStart(2, '0');
	}).join('').toUpperCase();
}

function btRenderSwatches() {
	const box = document.getElementById('bt-swatches');
	if (!box || box.childElementCount) return;
	BT_PRESETS.forEach(function (p) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'bt-swatch-btn';
		btn.setAttribute('role', 'radio');
		btn.setAttribute('aria-label', p.name);
		btn.dataset.hex = p.hex;
		btn.innerHTML = '<span class="bt-swatch" style="background:' + p.hex + '"><i class="fa-solid fa-check"></i></span><span class="bt-swatch-label"></span>';
		btn.querySelector('.bt-swatch-label').textContent = p.name;
		btn.addEventListener('click', function () { btSetAccent(p.hex); });
		box.appendChild(btn);
	});
}

function btRenderPreview() {
	const box = document.getElementById('bt-preview');
	const business = Object.assign({}, (typeof bpCurrent !== 'undefined' && bpCurrent) || {}, { theme_color: btAccent });
	box.replaceChildren(buildBusinessCard(business));
}

function btSyncButtons() {
	const save = document.getElementById('bt-save');
	save.disabled = btBusy || btAccent === btSaved;
	save.textContent = btBusy ? 'Saving\u2026' : (btAccent === btSaved ? 'Saved' : 'Save theme');
	document.getElementById('bt-reset').classList.toggle('hidden', !btSaved);
}

function btRender() {
	const root = document.getElementById('bt-root');
	root.style.setProperty('--bt-accent', btAccent);
	document.querySelectorAll('#bt-swatches .bt-swatch-btn').forEach(function (btn) {
		btn.setAttribute('aria-checked', btn.dataset.hex === btAccent ? 'true' : 'false');
	});
	const hue = document.getElementById('bt-hue');
	if (document.activeElement !== hue) hue.value = btHexToHue(btAccent);
	const hex = document.getElementById('bt-hex');
	if (document.activeElement !== hex) hex.value = btAccent;
	document.getElementById('bt-dot').style.background = btAccent;
	btRenderPreview();
	btSyncButtons();
}

function btSetAccent(hex) {
	const clean = btNormalizeHex(hex);
	if (!clean) return;
	btAccent = clean;
	btRender();
}

function btPickColor() {
	if (window.EyeDropper) {
		new window.EyeDropper().open().then(function (r) { btSetAccent(r.sRGBHex); }).catch(function () {});
		return;
	}
	const input = document.getElementById('bt-color-fallback');
	input.value = btAccent.toLowerCase();
	input.click();
}

async function btPostTheme(color) {
	if (btBusy || !bpCurrent) return false;
	const business = bpCurrent;
	btBusy = true;
	btSyncButtons();
	try {
		const response = await apiFetch('/api/businesses/' + business.id + '/theme', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ color: color })
		});
		const data = await response.json().catch(function () { return {}; });
		if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
		Object.assign(business, data.business); // same object the My Stores list holds
		btSaved = business.theme_color || null;
		return true;
	} catch (err) {
		showToast(err.message === 'Failed to fetch' ? 'Network error. Please try again.' : err.message);
		return false;
	} finally {
		btBusy = false;
		btSyncButtons();
	}
}

async function btSave() {
	if (await btPostTheme(btAccent)) showToast('Theme saved');
}

async function btReset() {
	if (await btPostTheme(null)) {
		btAccent = BT_DEFAULT;
		btRender();
		showToast('Theme reset');
	}
}

function bpOpenTheme() {
	if (typeof bpCloseMenu === 'function') bpCloseMenu();
	btSaved = (bpCurrent && bpCurrent.theme_color) || null;
	btAccent = btSaved || BT_DEFAULT;
	btRenderSwatches();
	btRender();
	showView('business-theme');
	window.scrollTo(0, 0);
}

function btBack() {
	showView('business-profile');
}

(function initBusinessTheme() {
	const hue = document.getElementById('bt-hue');
	const hex = document.getElementById('bt-hex');
	const fallback = document.getElementById('bt-color-fallback');
	if (!hue || !hex) return;

	hue.addEventListener('input', function () { btSetAccent(btHueToHex(Number(hue.value))); });
	hex.addEventListener('input', function () {
		const digits = hex.value.replace('#', '');
		if (digits.length === 3 || digits.length === 6) btSetAccent(hex.value);
	});
	hex.addEventListener('blur', function () { hex.value = btAccent; });
	if (fallback) fallback.addEventListener('input', function () { btSetAccent(fallback.value); });
})();
