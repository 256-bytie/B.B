// ---- Business profile (templates/partials/business_profile.html) ----
// Shown by the Create Business wizard when it finishes (see bcFinish in
// business-create.js). The business is the record the server returned after
// saving it (photos are not persisted yet), and a brand-new business has no
// banner, logo, rating, reviews, followers or posts, so the template's empty
// states are what the owner sees. When the backend exists, this is where
// those values get filled in. The two camera buttons (cover, business photo)
// follow the user profile's pattern but stay local for now: the picked image
// is previewed from an object URL and kept on the business object (so My
// Stores shows it too), with the File itself held for the future upload.
// Depends on showView (core.js), showToast (compose.js) and renderMyStores
// (business-stores.js).

const BP_IMAGE_MAX_SIZE = 5 * 1024 * 1024; // same limit as the user profile photos
let bpCurrent = null; // the business being shown

// Screen the back arrow returns to: Businesses after the wizard, or whichever
// screen opened the profile (My Stores passes 'my-stores').
let bpReturnView = 'businesses';

function openBusinessProfile(business, returnView) {
	bpReturnView = returnView || 'businesses';
	bpCurrent = business;
	document.getElementById('bp-name').textContent = business.name;
	document.getElementById('bp-category').textContent = business.category;
	bpShowImage('avatar', business.avatarUrl);
	bpShowImage('banner', business.bannerUrl);
	showView('business-profile');
	window.scrollTo(0, 0);
}

function bpBack() {
	// My Stores is not re-rendered by showView, so refresh it to pick up a
	// photo changed here.
	if (bpReturnView === 'my-stores') renderMyStores();
	showView(bpReturnView);
}

// Show the picked image, or fall back to the placeholder when there is none.
function bpShowImage(kind, url) {
	const img = document.getElementById('bp-' + kind + '-img');
	const placeholder = document.getElementById('bp-' + kind + '-placeholder');
	if (url) {
		img.src = url;
		img.classList.remove('hidden');
		placeholder.classList.add('hidden');
	} else {
		img.removeAttribute('src');
		img.classList.add('hidden');
		placeholder.classList.remove('hidden');
	}
}

// kind: 'avatar' (business photo) or 'banner' (cover). Mirrors
// handleProfileImageSelected() in profile-own.js, minus the network upload.
function bpOnImagePicked(event, kind) {
	const file = event.target.files && event.target.files[0];
	event.target.value = ''; // allow re-selecting the same file later
	if (!file || !bpCurrent) return;
	if (!file.type.startsWith('image/')) {
		showToast('Please choose an image file.');
		return;
	}
	if (file.size > BP_IMAGE_MAX_SIZE) {
		showToast('Image must be under 5MB.');
		return;
	}
	const urlKey = kind + 'Url';
	if (bpCurrent[urlKey]) URL.revokeObjectURL(bpCurrent[urlKey]);
	bpCurrent[urlKey] = URL.createObjectURL(file);
	bpCurrent[kind + 'File'] = file; // TODO(backend): upload this File
	bpShowImage(kind, bpCurrent[urlKey]);
	showToast(kind === 'avatar' ? 'Business photo updated' : 'Cover photo updated');
}

// Menu rows, the settings gear and "Write a Notice" have no screens yet.
function bpComingSoon(label) {
	showToast(label + ' is coming soon');
}
