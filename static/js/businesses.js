// ---- Businesses screen (templates/partials/businesses.html) ----
// Loads persisted businesses from GET /api/businesses each time the Businesses screen
// is shown (showView('businesses') calls initBusinessesView(), see core.js) and renders
// carousels under the promo banner: "Featured" (businesses with a cover image), then
// "Food & drinks" and "Shops & gadgets" (every other category). Loading / error / empty states go in #business-status.
// buildBusinessCard() (below) is the list card shared with My Stores (business-stores.js)
// and the Theme preview (business-theme.js). Depends on showView (core.js), showToast
// (compose.js) only at call time.

const BUSINESS_MAX_FEATURES = 3;
const BUSINESS_FOOD_CATEGORY = 'Food & Drinks';
const BUSINESS_DOT_MAX = 5;
const BUSINESS_FEATURED_MAX = 10;
const BUSINESS_HEARTS_KEY = 'beebo-business-hearts';
const businessesState = {
	businesses: [],
	loading: false,
	error: false,
	requestId: 0 // guards against an older response overwriting a newer one
};

// Called by showView('businesses')'s per-view hook each time the view opens.
function initBusinessesView() {
	fetchBusinesses();
}

async function fetchBusinesses() {
	const requestId = ++businessesState.requestId;
	businessesState.loading = true;
	businessesState.error = false;
	renderBusinesses();
	try {
		const response = await fetch('/api/businesses');
		if (!response.ok) throw new Error('request failed');
		const data = await response.json();
		if (requestId !== businessesState.requestId) return;
		businessesState.businesses = data.businesses || [];
	} catch (err) {
		if (requestId !== businessesState.requestId) return;
		businessesState.error = true;
	}
	businessesState.loading = false;
	renderBusinesses();
}

function businessSection(id) {
	return document.getElementById('business-section-' + id);
}

function renderBusinesses() {
	const status = document.getElementById('business-status');
	const groups = { featured: [], food: [], shops: [] };
	if (!businessesState.loading && !businessesState.error) {
		businessesState.businesses.forEach(function(b) {
			(b.category === BUSINESS_FOOD_CATEGORY ? groups.food : groups.shops).push(b);
		});
		groups.featured = businessesState.businesses.filter(function(b) { return !!b.banner_url; }).slice(0, BUSINESS_FEATURED_MAX);
	}

	status.innerHTML = '';
	status.classList.add('hidden');
	if (businessesState.loading) {
		showBusinessStatus('<div class="text-[13.5px] text-gray-400 py-6">Loading businesses\u2026</div>');
	} else if (businessesState.error) {
		showBusinessStatus('<p class="text-[13.5px] text-gray-400 mb-3">Couldn\'t load businesses right now.</p>' +
			'<button type="button" onclick="fetchBusinesses()" class="text-[13.5px] font-semibold text-red-600">Try again</button>');
	} else if (!businessesState.businesses.length) {
		showBusinessStatus('<div class="text-[13.5px] text-gray-400 py-6">No businesses yet.</div>');
	}

	renderBusinessSection('featured', groups.featured, 'featured');
	renderBusinessSection('food', groups.food, 'large');
	renderBusinessSection('shops', groups.shops, 'small');
}

function showBusinessStatus(html) {
	const status = document.getElementById('business-status');
	status.innerHTML = html;
	status.classList.remove('hidden');
}

// One card, cloned from #business-card-template and filled through its
// data-field hooks. Used by the Businesses list and by My Stores. Optional
// onOpen makes the card a tappable button (My Stores opens the profile).
function buildBusinessCard(business, onOpen) {
	const card = document.getElementById('business-card-template').content.firstElementChild.cloneNode(true);
	const field = function(name) { return card.querySelector('[data-field="' + name + '"]'); };

	if (business.avatar_url) {
		// Business photo uploaded from the profile screen.
		field('image').src = business.avatar_url;
		field('image').alt = business.name;
	} else {
		// No photo yet: swap the template's <img> for a same-size placeholder.
		const placeholder = document.createElement('div');
		placeholder.className = 'w-[70px] h-[70px] rounded-[10px] bg-gray-100 flex items-center justify-center text-gray-400 shrink-0';
		placeholder.innerHTML = '<i class="fas fa-store text-[24px]" aria-hidden="true"></i>';
		field('image').replaceWith(placeholder);
	}

	field('name').textContent = business.name;
	field('category').textContent = business.category;
	// No ratings or reviews exist yet.
	field('rating').textContent = '\u2014';
	field('stars').innerHTML = '<i class="far fa-star text-[11px] text-gray-200"></i>'.repeat(5);
	field('review-count').textContent = '(0)';
	field('address').textContent = business.location;

	// Features row: the first services, as ticked items.
	const features = field('features');
	const featureTpl = document.getElementById('business-feature-available');
	const services = (business.services || []).slice(0, BUSINESS_MAX_FEATURES);
	services.forEach(function(service) {
		const item = featureTpl.content.firstElementChild.cloneNode(true);
		item.querySelector('[data-field="label"]').textContent = service;
		features.appendChild(item);
	});
	if (!services.length) features.classList.add('hidden');

	applyBusinessCardTheme(card, business);

	if (onOpen) {
		card.classList.add('cursor-pointer', 'active:opacity-90', 'transition-opacity');
		card.setAttribute('role', 'button');
		card.setAttribute('tabindex', '0');
		card.setAttribute('aria-label', business.name);
		card.addEventListener('click', onOpen);
		card.addEventListener('keydown', function(e) {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
		});
	}
	return card;
}

// Mix two #RRGGBB colors: amount 0 = hex, 1 = otherHex.
function businessShade(hex, otherHex, amount) {
	const a = parseInt(hex.slice(1), 16), b = parseInt(otherHex.slice(1), 16);
	const mix = function(shift) {
		const x = (a >> shift) & 255, y = (b >> shift) & 255;
		return Math.round(x + (y - x) * amount);
	};
	return '#' + [16, 8, 0].map(function(shift) { return mix(shift).toString(16).padStart(2, '0'); }).join('');
}

// Owner-chosen theme (Theme screen, business-theme.js): a business with a
// theme_color gets an accent-colored card with its cover on the right, fading into
// the accent. Businesses without one keep the plain white card. Styling lives in
// style.css under .bb-themed-card.
function applyBusinessCardTheme(card, business) {
	const accent = business.theme_color;
	if (!/^#[0-9a-f]{6}$/i.test(accent || '')) return;

	card.classList.add('bb-themed-card');
	card.style.setProperty('--bb-card-accent', accent);
	card.style.setProperty('--bb-card-dark', businessShade(accent, '#000000', 0.5));
	card.style.setProperty('--bb-card-light', businessShade(accent, '#ffffff', 0.35));
	card.firstElementChild.classList.add('bb-card-avatar');
	card.lastElementChild.classList.add('bb-card-text');

	let cover;
	if (business.banner_url) {
		cover = document.createElement('img');
		cover.src = business.banner_url;
		cover.alt = '';
		cover.className = 'bb-card-cover';
	} else {
		cover = document.createElement('div');
		cover.className = 'bb-card-cover bb-card-cover-empty';
	}
	const fade = document.createElement('div');
	fade.className = 'bb-card-fade';
	card.prepend(cover, fade);
}

// ---- Category carousels ----
function businessHearts() {
	try { return JSON.parse(localStorage.getItem(BUSINESS_HEARTS_KEY) || '[]'); } catch (e) { return []; }
}

// Heart on a card: remembered on this device only (no server-side favorites yet).
function toggleBusinessHeart(id) {
	const hearts = businessHearts();
	const i = hearts.indexOf(id);
	if (i === -1) hearts.push(id); else hearts.splice(i, 1);
	try { localStorage.setItem(BUSINESS_HEARTS_KEY, JSON.stringify(hearts)); } catch (e) {}
	return i === -1;
}

function businessRgba(hex, alpha) {
	const n = parseInt(hex.slice(1), 16);
	return 'rgba(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',') + ',' + alpha + ')';
}

// size 'large' = wide Food & drinks card (rating row, heart); 'featured' = Featured card (heart);
// 'small' = compact Shops & gadgets card.
function buildShowcaseCard(business, size) {
	const large = size === 'large';
	const featured = size === 'featured';
	const theme = /^#[0-9a-f]{6}$/i.test(business.theme_color || '') ? business.theme_color : null;
	const base = theme ? businessShade(theme, '#000000', 0.45) : '#1f1f1f';

	const card = document.createElement('article');
	card.className = 'relative shrink-0 snap-start rounded-2xl overflow-hidden ' +
		(large ? 'w-[72%] max-w-[300px] min-w-[240px] h-[150px]' : featured ? 'w-[158px] h-[150px]' : 'w-[158px] h-[112px]');
	card.style.background = theme ? 'linear-gradient(135deg,' + theme + ',' + base + ')' : 'linear-gradient(135deg,#8a8f98,#3b3f46)';
	card.style.boxShadow = '0 2px 10px rgba(0,0,0,0.10)';

	if (business.banner_url) {
		const cover = document.createElement('img');
		cover.src = business.banner_url;
		cover.alt = '';
		cover.loading = 'lazy';
		cover.className = 'absolute inset-0 w-full h-full object-cover';
		cover.addEventListener('error', function() { cover.remove(); });
		card.appendChild(cover);
	}

	const shade = document.createElement('div');
	shade.className = 'absolute inset-0';
	shade.style.background = 'linear-gradient(to top,' + businessRgba(base, theme ? 0.92 : 0.82) + ' 0%,' +
		businessRgba(base, theme ? 0.55 : 0.4) + ' 42%,' + businessRgba(base, 0) + ' 78%)';
	card.appendChild(shade);

	if (large || featured) {
		const heart = document.createElement('button');
		heart.type = 'button';
		heart.setAttribute('aria-label', 'Save ' + business.name);
		heart.className = 'absolute top-2.5 right-2.5 w-7 h-7 flex items-center justify-center active:scale-90 transition-transform' + (featured ? ' rounded-full' : '');
		if (featured) heart.style.background = 'rgba(0,0,0,.28)';
		const icon = document.createElement('i');
		const paint = function(on) {
			icon.className = (on ? 'fa-solid' : 'fa-regular') + ' fa-heart ' + (featured ? 'text-[13px]' : 'text-[17px]');
			icon.style.color = on ? '#ff4d57' : '#fff';
			heart.setAttribute('aria-pressed', on ? 'true' : 'false');
		};
		paint(businessHearts().indexOf(business.id) !== -1);
		heart.appendChild(icon);
		heart.addEventListener('click', function(e) { e.stopPropagation(); paint(toggleBusinessHeart(business.id)); });
		card.appendChild(heart);
	}

	const text = document.createElement('div');
	text.className = 'absolute left-0 right-0 bottom-0 min-w-0 ' + (large ? 'p-3' : 'p-2.5');
	text.style.color = '#fff';

	const name = document.createElement('p');
	name.className = (large ? 'text-[17px]' : 'text-[14px]') + ' font-bold leading-tight truncate';
	name.textContent = business.name;
	text.appendChild(name);

	const category = document.createElement('p');
	category.className = (large ? 'text-[13px]' : 'text-[11px]') + ' leading-tight mt-0.5 truncate';
	category.style.opacity = '.9';
	category.textContent = business.category;
	text.appendChild(category);

	if (large) {
		// No ratings exist yet: five empty stars and (0).
		const rating = document.createElement('p');
		rating.className = 'flex items-center gap-1.5 mt-1';
		rating.style.opacity = '.9';
		rating.innerHTML = '<span class="flex gap-[2px] text-[11px]">' + '<i class="fa-regular fa-star"></i>'.repeat(5) + '</span><span class="text-[12px]">(0)</span>';
		text.appendChild(rating);
	}

	const place = document.createElement('p');
	place.className = 'flex items-center gap-1.5 leading-tight min-w-0 ' + (large ? 'text-[13px] mt-1.5' : 'text-[11px] mt-1');
	place.style.opacity = '.92';
	const pin = document.createElement('i');
	pin.className = 'fa-solid fa-location-dot shrink-0 ' + (large ? 'text-[12px]' : 'text-[10px]');
	const where = document.createElement('span');
	where.className = 'truncate';
	where.textContent = business.location;
	place.append(pin, where);
	text.appendChild(place);

	card.appendChild(text);
	return card;
}

function renderBusinessSection(id, items, size) {
	const section = businessSection(id);
	if (!section) return;
	const scroller = section.querySelector('[data-role="scroll"]');
	scroller.innerHTML = '';
	section.classList.toggle('hidden', !items.length);
	if (!items.length) return;
	items.forEach(function(business) { scroller.appendChild(buildShowcaseCard(business, size)); });
	scroller.scrollLeft = 0;
	renderBusinessDots(section, Math.min(items.length, BUSINESS_DOT_MAX));
	requestAnimationFrame(function() { updateBusinessSection(id); });
	// Re-check once the screen is visible and images/fonts have settled.
	setTimeout(function() { updateBusinessSection(id); }, 250);
}

// Pagination dots (Food & drinks): small, one highlighted; they follow the carousel's scroll.
function renderBusinessDots(section, count) {
	const dots = section.querySelector('[data-role="dots"]');
	if (!dots) return;
	dots.innerHTML = '';
	for (let i = 0; i < count; i++) {
		const dot = document.createElement('span');
		dot.className = 'w-1.5 h-1.5 rounded-full';
		dots.appendChild(dot);
	}
	dots.classList.toggle('hidden', count < 2);
	dots.classList.toggle('flex', count >= 2);
}

// Arrow visible while more cards are off-screen on the right; active dot tracks scroll position.
function updateBusinessSection(id) {
	const section = businessSection(id);
	if (!section) return;
	const scroller = section.querySelector('[data-role="scroll"]');
	const next = section.querySelector('[data-role="next"]');
	const max = scroller.scrollWidth - scroller.clientWidth;
	const more = max - scroller.scrollLeft > 8;
	next.classList.toggle('hidden', !more);
	next.classList.toggle('flex', more);

	const dots = section.querySelectorAll('[data-role="dots"] span');
	if (dots.length) {
		const active = max > 0 ? Math.round(scroller.scrollLeft / max * (dots.length - 1)) : 0;
		dots.forEach(function(dot, i) { dot.style.background = i === active ? '#F97316' : '#D1D5DB'; });
	}
}

function scrollBusinessSection(id) {
	const section = businessSection(id);
	const scroller = section && section.querySelector('[data-role="scroll"]');
	if (scroller) scroller.scrollBy({ left: scroller.clientWidth * 0.7, behavior: 'smooth' });
}

// Banner button: jump to a category section.
function scrollToBusinessSection(id) {
	const section = businessSection(id);
	if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

window.addEventListener('resize', function() {
	updateBusinessSection('featured');
	updateBusinessSection('food');
	updateBusinessSection('shops');
});
