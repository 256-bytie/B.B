// ---- Businesses list (templates/partials/businesses.html) ----
// Loads persisted businesses from GET /api/businesses each time the
// Businesses screen is shown (showView('businesses') calls
// initBusinessesView(), see core.js) and renders them into #business-list as
// clones of #business-card-template. Loading / error / empty states follow
// the Library list (library.js). buildBusinessCard() is shared with My Stores
// (business-stores.js) so both lists look identical. Depends on showView
// (core.js) only at call time.

const BUSINESS_MAX_FEATURES = 3;
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

function renderBusinesses() {
	const list = document.getElementById('business-list');
	const footer = document.getElementById('business-list-footer');
	list.innerHTML = '';
	footer.classList.add('hidden');

	if (businessesState.loading) {
		list.innerHTML = '<div class="text-center text-[13.5px] text-gray-400 py-10">Loading businesses\u2026</div>';
		return;
	}
	if (businessesState.error) {
		list.innerHTML = '<div class="text-center py-10">' +
			'<p class="text-[13.5px] text-gray-400 mb-3">Couldn\'t load businesses right now.</p>' +
			'<button type="button" onclick="fetchBusinesses()" class="text-[13.5px] font-semibold text-red-600">Try again</button></div>';
		return;
	}
	if (!businessesState.businesses.length) {
		list.innerHTML = '<div class="text-center text-[13.5px] text-gray-400 py-10">No businesses yet.</div>';
		return;
	}
	businessesState.businesses.forEach(function(business) {
		list.appendChild(buildBusinessCard(business));
	});
	footer.classList.remove('hidden');
}

// One card, cloned from #business-card-template and filled through its
// data-field hooks. Used by the Businesses list and by My Stores. Optional
// onOpen makes the card a tappable button (My Stores opens the profile).
function buildBusinessCard(business, onOpen) {
	const card = document.getElementById('business-card-template').content.firstElementChild.cloneNode(true);
	const field = function(name) { return card.querySelector('[data-field="' + name + '"]'); };

	if (business.avatarUrl) {
		// Business photo picked on the profile screen.
		field('image').src = business.avatarUrl;
		field('image').alt = business.name;
	} else {
		// No photo: swap the template's <img> for a same-size placeholder.
		const placeholder = document.createElement('div');
		placeholder.className = 'w-[120px] h-[120px] rounded-[12px] bg-gray-100 flex items-center justify-center text-gray-400 shrink-0';
		placeholder.innerHTML = '<i class="fas fa-store text-[32px]" aria-hidden="true"></i>';
		field('image').replaceWith(placeholder);
	}

	field('name').textContent = business.name;
	field('category').textContent = business.category;
	// No ratings or reviews exist yet.
	field('rating').textContent = '\u2014';
	field('stars').innerHTML = '<i class="far fa-star text-[16px] text-gray-200"></i>'.repeat(5);
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
