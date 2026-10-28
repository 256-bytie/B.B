// ---- Business profile (templates/partials/business_profile.html) ----
// Shown by the Create Business wizard when it finishes (see bcFinish in
// business-create.js) and by My Stores. The business is the record the server
// returned, including avatar_url / banner_url. A brand-new business has no
// banner, logo, rating, reviews, followers or posts, so the template's empty
// states are what the owner sees. The two camera buttons (cover, business
// photo) upload the picked image to POST /api/businesses/<id>/image: the new
// photo is previewed at once from an object URL, then replaced by the
// server's URL on success, or rolled back with a toast on failure. Large
// phone photos are shrunk to a JPEG in the browser first so they fit the 5MB
// server limit. Depends on showView (core.js), apiFetch (core.js), showToast
// (compose.js) and renderMyStores (business-stores.js).

const BP_IMAGE_MAX_SIZE = 5 * 1024 * 1024; // same limit as the user profile photos
const BP_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']; // what the server accepts
const BP_IMAGE_RESIZE_ABOVE = 1024 * 1024; // photos up to 1MB are sent untouched
const BP_IMAGE_MAX_DIMENSION = 1600; // longest side after shrinking
const bpUploading = { avatar: false, banner: false };
let bpCurrent = null; // the business being shown

// Screen the back arrow returns to: Businesses after the wizard, or whichever
// screen opened the profile (My Stores passes 'my-stores').
let bpReturnView = 'businesses';

function openBusinessProfile(business, returnView) {
	bpReturnView = returnView || 'businesses';
	bpCurrent = business;
	document.getElementById('bp-name').textContent = business.name;
	document.getElementById('bp-category').textContent = business.category;
	bpShowImage('avatar', business.avatar_url);
	bpShowImage('banner', business.banner_url);
	showView('business-profile');
	window.scrollTo(0, 0);
}

function bpBack() {
	bpCloseMenu();
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

// Shrink big photos (typical phone shots are 3-8MB) to a JPEG no larger than
// BP_IMAGE_MAX_DIMENSION on the longest side. Small files, GIFs (to keep the
// animation) and anything the browser cannot decode are returned unchanged.
async function bpPrepareImage(file) {
	if (file.type === 'image/gif' || file.size <= BP_IMAGE_RESIZE_ABOVE) return file;
	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, BP_IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#fff'; // JPEG has no transparency
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		if (bitmap.close) bitmap.close();
		const blob = await new Promise(function(resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
		if (blob && blob.size < file.size) {
			const base = file.name.replace(/\.[^.]*$/, '') || 'photo';
			return new File([blob], base + '.jpg', { type: 'image/jpeg' });
		}
	} catch (err) { /* fall through: send the original */ }
	return file;
}

// kind: 'avatar' (business photo) or 'banner' (cover).
async function bpOnImagePicked(event, kind) {
	const picked = event.target.files && event.target.files[0];
	event.target.value = ''; // allow re-selecting the same file later
	const business = bpCurrent;
	if (!picked || !business) return;
	if (!BP_IMAGE_TYPES.includes(picked.type)) {
		showToast('Please choose a JPG, PNG, WebP or GIF image.');
		return;
	}
	if (bpUploading[kind]) return;
	bpUploading[kind] = true;

	const urlKey = kind + '_url';
	const previousUrl = business[urlKey];
	let previewUrl = null;
	try {
		const file = await bpPrepareImage(picked);
		if (file.size > BP_IMAGE_MAX_SIZE) {
			showToast('Image must be under 5MB.');
			return;
		}
		previewUrl = URL.createObjectURL(file);
		if (bpCurrent === business) bpShowImage(kind, previewUrl);

		const form = new FormData();
		form.append('kind', kind);
		form.append('file', file);
		const response = await apiFetch('/api/businesses/' + business.id + '/image', { method: 'POST', body: form });
		const data = await response.json().catch(function() { return {}; });
		if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

		business[urlKey] = data.business[urlKey];
		if (bpCurrent === business) bpShowImage(kind, business[urlKey]);
		showToast(kind === 'avatar' ? 'Business photo updated' : 'Cover photo updated');
	} catch (err) {
		if (bpCurrent === business) bpShowImage(kind, previousUrl);
		showToast(err.message === 'Failed to fetch' ? 'Network error. Please try again.' : err.message);
	} finally {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		bpUploading[kind] = false;
	}
}

// Menu rows, the more-options menu (other than Theme) and "Write a Notice" have no screens yet.
function bpComingSoon(label) {
	showToast(label + ' is coming soon');
}

// ---- More-options menu (vertical 3 dot button) ----
function bpToggleMenu() {
	const menu = document.getElementById('bp-menu');
	if (!menu) return;
	if (menu.classList.contains('hidden')) {
		menu.classList.remove('hidden');
		document.getElementById('bp-menu-backdrop').classList.remove('hidden');
		document.getElementById('bp-more-btn').setAttribute('aria-expanded', 'true');
	} else {
		bpCloseMenu();
	}
}

function bpCloseMenu() {
	const menu = document.getElementById('bp-menu');
	const backdrop = document.getElementById('bp-menu-backdrop');
	const btn = document.getElementById('bp-more-btn');
	if (menu) menu.classList.add('hidden');
	if (backdrop) backdrop.classList.add('hidden');
	if (btn) btn.setAttribute('aria-expanded', 'false');
}
