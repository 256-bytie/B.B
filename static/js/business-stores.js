// ---- My Stores (templates/partials/my_stores.html) ----
// Opened by the "My Stores" FAB on the Businesses screen (core.js calls the
// global openMyStores() named in the FAB's data-action). Shows the businesses
// created with the Create Business wizard in this session, newest first. The
// businesses themselves are persisted by the wizard (POST /api/businesses, see
// bcFinish in business-create.js) and listed on the Businesses screen; this
// list is still in-memory only (addMyStore() is called by bcFinish) and is
// not reloaded from the server yet. Cards come from buildBusinessCard()
// (businesses.js), so they look exactly like the Businesses list. Depends on
// showView (core.js) and openBusinessProfile (business-profile.js).

let myStores = [];

function addMyStore(business) {
	myStores.unshift(business);
}

function openMyStores() {
	renderMyStores();
	showView('my-stores');
	window.scrollTo(0, 0);
}

function myStoresBack() {
	showView('businesses');
}

function renderMyStores() {
	const list = document.getElementById('my-stores-list');
	list.innerHTML = '';
	myStores.forEach(function(store) {
		// Tapping a store opens its owner profile; Back there returns here.
		list.appendChild(buildBusinessCard(store, function() { openBusinessProfile(store, 'my-stores'); }));
	});
	document.getElementById('my-stores-empty').classList.toggle('hidden', myStores.length > 0);
	document.getElementById('my-stores-footer').classList.toggle('hidden', myStores.length === 0);
}
