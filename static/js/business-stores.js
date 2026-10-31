// ---- My Stores (templates/partials/my_stores.html) ----
// Opened by the "My Stores" FAB on the Businesses screen (core.js calls the
// global openMyStores() called by the Stores button on the Businesses screen). Loads the current
// user's own businesses from GET /api/businesses?mine=1 each time it opens,
// newest first, with loading / error / empty states like the Businesses list
// (businesses.js). Cards come from buildBusinessCard(), so they look exactly
// like that list. Depends on showView (core.js) and openBusinessProfile
// (business-profile.js).

let myStores = [];
const myStoresState = { loading: false, error: false, requestId: 0 };

function openMyStores() {
	showView('my-stores');
	window.scrollTo(0, 0);
	fetchMyStores();
}

function myStoresBack() {
	showView('businesses');
}

async function fetchMyStores() {
	const requestId = ++myStoresState.requestId;
	myStoresState.loading = true;
	myStoresState.error = false;
	renderMyStores();
	try {
		const response = await fetch('/api/businesses?mine=1');
		if (!response.ok) throw new Error('request failed');
		const data = await response.json();
		if (requestId !== myStoresState.requestId) return;
		myStores = data.businesses || [];
	} catch (err) {
		if (requestId !== myStoresState.requestId) return;
		myStoresState.error = true;
	}
	myStoresState.loading = false;
	renderMyStores();
}

function renderMyStores() {
	const list = document.getElementById('my-stores-list');
	const empty = document.getElementById('my-stores-empty');
	const footer = document.getElementById('my-stores-footer');
	list.innerHTML = '';
	empty.classList.add('hidden');
	footer.classList.add('hidden');

	if (myStoresState.loading) {
		list.innerHTML = '<div class="text-center text-[13.5px] text-gray-400 py-10">Loading your stores\u2026</div>';
		return;
	}
	if (myStoresState.error) {
		list.innerHTML = '<div class="text-center py-10">' +
			'<p class="text-[13.5px] text-gray-400 mb-3">Couldn\'t load your stores right now.</p>' +
			'<button type="button" onclick="fetchMyStores()" class="text-[13.5px] font-semibold text-red-600">Try again</button></div>';
		return;
	}
	if (!myStores.length) {
		empty.classList.remove('hidden');
		return;
	}
	myStores.forEach(function(store) {
		// Tapping a store opens its owner profile; Back there returns here.
		list.appendChild(buildBusinessCard(store, function() { openBusinessProfile(store, 'my-stores'); }));
	});
	footer.classList.remove('hidden');
}
