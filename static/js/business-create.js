// ---- Create Business wizard (templates/partials/business_create.html) ----
// Opened by the "Create" FAB on the Businesses screen (core.js calls the
// global openBusinessCreate() named in the FAB's data-action). Everything
// lives in the in-memory bcDraft, which is rebuilt each time the wizard
// opens. bcBuildPayload() is the single place the request body is read from;
// bcFinish() POSTs it to /api/businesses. Depends on escapeHtml (feed.js),
// showView (core.js), apiFetch (core.js), showToast (compose.js), addMyStore
// (business-stores.js) and openBusinessProfile (business-profile.js).

const BC_TOTAL_STEPS = 3;
const BC_CATEGORIES = [
	'Food & Drinks', 'Fashion & Clothing', 'Beauty & Personal Care',
	'Electronics & Gadgets', 'Health & Wellness', 'Education & Tutoring',
	'Printing & Stationery', 'Services & Repairs', 'Real Estate', 'Other'
];
const BC_DAYS = [
	{ key: 'mon', label: 'Monday', short: 'Mon' },
	{ key: 'tue', label: 'Tuesday', short: 'Tue' },
	{ key: 'wed', label: 'Wednesday', short: 'Wed' },
	{ key: 'thu', label: 'Thursday', short: 'Thu' },
	{ key: 'fri', label: 'Friday', short: 'Fri' },
	{ key: 'sat', label: 'Saturday', short: 'Sat' },
	{ key: 'sun', label: 'Sunday', short: 'Sun' }
];
const BC_SOCIALS = [
	{ key: 'instagram', label: 'Instagram', placeholder: '@yourbrand or profile link' },
	{ key: 'facebook', label: 'Facebook', placeholder: 'Page name or link' },
	{ key: 'x', label: 'X (Twitter)', placeholder: '@yourbrand or profile link' },
	{ key: 'tiktok', label: 'TikTok', placeholder: '@yourbrand or profile link' }
];
const BC_MAX_SERVICES = 12;
const BC_MAX_DOCS = 3;
const BC_MAX_DOC_BYTES = 5 * 1024 * 1024;
const BC_MIN_NAME = 2;
const BC_MIN_LOCATION = 3;
const BC_MIN_DESCRIPTION = 10;
// Fields whose sheet should pop the keyboard straight away.
const BC_FOCUS_SHEETS = ['location', 'services', 'contact', 'social'];

let bcStep = 1;
let bcDraft = null;
let bcSheetKind = null;

function bcNewDraft() {
	const hours = {};
	BC_DAYS.forEach(function(d, i) {
		hours[d.key] = { open: i < 5, from: '09:00', to: '17:00' }; // Mon-Fri 9-5 as the starting point
	});
	return {
		name: '', category: '', location: '', description: '',
		hours: hours, hoursSet: false,
		services: [],
		contact: { phone: '', email: '', website: '' },
		social: { instagram: '', facebook: '', x: '', tiktok: '' },
		documents: [] // File objects, kept in memory only
	};
}

// ---- Entry / navigation ----

function openBusinessCreate() {
	bcDraft = bcNewDraft();
	bcCloseSheet();
	document.getElementById('bc-name').value = '';
	const desc = document.getElementById('bc-description');
	desc.value = '';
	bcUpdateDescriptionCount();
	document.querySelectorAll('[data-bc-card]').forEach(function(card) {
		bcSetError(card.getAttribute('data-bc-card'), null);
	});
	bcRenderSummaries();
	bcGoToStep(1);
	showView('business-create');
}

function bcBack() {
	if (bcStep > 1) {
		bcGoToStep(bcStep - 1);
	} else {
		bcCloseSheet();
		showView('businesses');
	}
}

function bcNext() {
	if (!bcValidateStep(bcStep)) return;
	if (bcStep < BC_TOTAL_STEPS) {
		bcGoToStep(bcStep + 1);
	} else {
		bcFinish();
	}
}

function bcGoToStep(step) {
	bcStep = step;
	document.querySelectorAll('#business-create-view .bc-step-section').forEach(function(sec) {
		const isCurrent = Number(sec.dataset.step) === step;
		sec.classList.toggle('hidden', !isCurrent);
		sec.classList.remove('bc-step-enter');
		if (isCurrent) {
			void sec.offsetWidth; // restart the entrance animation
			sec.classList.add('bc-step-enter');
		}
	});
	document.querySelectorAll('#business-create-view .bc-step-dot').forEach(function(dot) {
		const n = Number(dot.dataset.step);
		dot.dataset.state = n < step ? 'done' : (n === step ? 'active' : 'todo');
		if (n === step) dot.setAttribute('aria-current', 'step'); else dot.removeAttribute('aria-current');
	});
	// The first connector is always filled, as in the design; the second fills
	// once step 3 is reached.
	document.querySelectorAll('#business-create-view .bc-step-line').forEach(function(line) {
		line.classList.toggle('is-filled', Number(line.dataset.line) < Math.max(step, 2));
	});
	document.getElementById('bc-step-label').textContent = 'Step ' + step + ' of ' + BC_TOTAL_STEPS;
	document.getElementById('bc-back-btn').classList.toggle('hidden', step === 1);
	document.getElementById('bc-next-label').textContent = step === BC_TOTAL_STEPS ? 'Done' : 'Next';
	document.getElementById('bc-scroll').scrollTop = 0;
}

function bcBuildPayload() {
	const d = bcDraft;
	return {
		name: d.name.trim(),
		category: d.category,
		location: d.location.trim(),
		description: d.description.trim(),
		hours: d.hours,
		services: d.services.slice(),
		contact: Object.assign({}, d.contact),
		social: Object.assign({}, d.social),
		documents: d.documents // File objects; the upload will need them
	};
}

let bcSaving = false;

// Persist the business (POST /api/businesses), then add it to My Stores and
// open its profile. Verification documents are collected by the wizard but not
// uploaded yet, so they are left out of the request body.
async function bcFinish() {
	if (bcSaving) return;
	const payload = bcBuildPayload();
	delete payload.documents;

	bcSaving = true;
	const btn = document.getElementById('bc-next-btn');
	const backBtn = document.getElementById('bc-back-btn');
	const label = document.getElementById('bc-next-label');
	btn.disabled = true;
	backBtn.disabled = true;
	label.textContent = 'Saving\u2026';
	try {
		const response = await apiFetch('/api/businesses', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		const data = await response.json().catch(function() { return {}; });
		if (!response.ok) {
			showToast(data.error || 'Something went wrong. Please try again.');
			return;
		}
		addMyStore(data.business);
		openBusinessProfile(data.business);
	} catch (err) {
		showToast('Network error. Please try again.');
	} finally {
		bcSaving = false;
		btn.disabled = false;
		backBtn.disabled = false;
		label.textContent = bcStep === BC_TOTAL_STEPS ? 'Done' : 'Next';
	}
}

// ---- Validation / errors ----

function bcSetError(field, message) {
	const card = document.querySelector('[data-bc-card="' + field + '"]');
	const err = document.querySelector('[data-bc-error="' + field + '"]');
	if (card) card.dataset.invalid = message ? 'true' : 'false';
	if (err) {
		err.textContent = message || '';
		err.classList.toggle('hidden', !message);
	}
}

function bcValidateStep(step) {
	const d = bcDraft;
	const checks = [];
	if (step === 1) {
		checks.push(['name', d.name.trim().length >= BC_MIN_NAME, 'Enter your business name']);
		checks.push(['category', !!d.category, 'Select a category']);
		checks.push(['location', d.location.trim().length >= BC_MIN_LOCATION, 'Enter your location']);
	} else if (step === 2) {
		checks.push(['description', d.description.trim().length >= BC_MIN_DESCRIPTION, 'Add a short description (at least ' + BC_MIN_DESCRIPTION + ' characters)']);
		checks.push(['hours', d.hoursSet, 'Set your opening hours']);
	}
	let firstBad = null;
	checks.forEach(function(c) {
		bcSetError(c[0], c[1] ? null : c[2]);
		if (!c[1] && !firstBad) firstBad = c[0];
	});
	if (firstBad) {
		const card = document.querySelector('[data-bc-card="' + firstBad + '"]');
		if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
		return false;
	}
	return true;
}

// ---- Inline inputs ----

function bcOnName(value) {
	bcDraft.name = value;
	if (value.trim().length >= BC_MIN_NAME) bcSetError('name', null);
}

function bcOnDescription(el) {
	bcDraft.description = el.value;
	bcUpdateDescriptionCount();
	if (el.value.trim().length >= BC_MIN_DESCRIPTION) bcSetError('description', null);
}

function bcUpdateDescriptionCount() {
	const el = document.getElementById('bc-description');
	document.getElementById('bc-description-count').textContent = el.value.length + '/' + el.maxLength;
}

// ---- Row summaries (the grey sub-line on each chevron row) ----

function bcSetSummary(field, text) {
	const el = document.querySelector('[data-bc-summary="' + field + '"]');
	if (!el) return;
	el.textContent = text || el.dataset.placeholder;
	el.classList.toggle('text-gray-900', !!text);
	el.classList.toggle('text-gray-500', !text);
}

function bcFormatTime(hhmm) {
	const parts = String(hhmm).split(':');
	const h = parseInt(parts[0], 10);
	const m = parts[1] || '00';
	if (isNaN(h)) return '';
	return ((h % 12) || 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
}

// "Mon-Fri · 9:00 AM - 5:00 PM"; extra groups of days collapse to "+N more".
function bcHoursSummary() {
	if (!bcDraft.hoursSet) return '';
	const groups = [];
	BC_DAYS.forEach(function(day, i) {
		const h = bcDraft.hours[day.key];
		if (!h.open) return;
		const last = groups[groups.length - 1];
		if (last && last.endIndex === i - 1 && last.from === h.from && last.to === h.to) {
			last.endIndex = i;
			last.end = day.short;
		} else {
			groups.push({ start: day.short, end: day.short, endIndex: i, from: h.from, to: h.to });
		}
	});
	if (!groups.length) return '';
	const g = groups[0];
	const days = g.start === g.end ? g.start : g.start + '\u2013' + g.end;
	let text = days + ' \u00b7 ' + bcFormatTime(g.from) + ' \u2013 ' + bcFormatTime(g.to);
	if (groups.length > 1) text += ' +' + (groups.length - 1) + ' more';
	return text;
}

function bcRenderSummaries() {
	const d = bcDraft;
	bcSetSummary('category', d.category);
	bcSetSummary('location', d.location.trim());
	bcSetSummary('hours', bcHoursSummary());
	let services = '';
	if (d.services.length) {
		services = d.services.slice(0, 2).join(', ');
		if (d.services.length > 2) services += ' +' + (d.services.length - 2) + ' more';
	}
	bcSetSummary('services', services);
	const contact = [];
	if (d.contact.phone) contact.push('Phone');
	if (d.contact.email) contact.push('Email');
	if (d.contact.website) contact.push('Website');
	bcSetSummary('contact', contact.join(', '));
	bcSetSummary('social', BC_SOCIALS.filter(function(s) { return d.social[s.key]; }).map(function(s) { return s.label; }).join(', '));
	bcSetSummary('documents', d.documents.length ? d.documents.length + (d.documents.length === 1 ? ' document added' : ' documents added') : '');
}

// ---- Bottom sheet ----

function bcSheetError(message) {
	const el = document.getElementById('bc-sheet-error');
	el.textContent = message || '';
	el.classList.toggle('hidden', !message);
}

function bcBuildSheet(kind) {
	const d = bcDraft;
	const inputCls = 'w-full h-12 px-4 rounded-xl bg-gray-50 border border-gray-200 text-[15px] text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-red/20 focus:border-brand-red/40';
	if (kind === 'category') {
		return {
			title: 'Category', save: null,
			html: '<div class="-mx-5">' + BC_CATEGORIES.map(function(c, i) {
				const on = d.category === c;
				return '<button type="button" onclick="bcPickCategory(' + i + ')" aria-pressed="' + on + '" class="w-full flex items-center justify-between px-5 py-3.5 text-left text-[15px] active:bg-gray-50 transition-colors ' + (on ? 'text-brand-red font-semibold' : 'text-gray-900') + '">' +
					'<span>' + escapeHtml(c) + '</span>' +
					(on ? '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>' : '') +
					'</button>';
			}).join('') + '</div>'
		};
	}
	if (kind === 'location') {
		return {
			title: 'Location', save: 'Save',
			html: '<p class="text-[14px] text-gray-500 mb-3">Area, street or campus where customers can find you.</p>' +
				'<input type="text" id="bc-sheet-location" maxlength="120" autocomplete="off" placeholder="Enter your location" value="' + escapeHtml(d.location) + '" onkeydown="if(event.key===\'Enter\'){event.preventDefault();bcSaveSheet();}" class="' + inputCls + '">'
		};
	}
	if (kind === 'hours') {
		return {
			title: 'Opening Hours', save: 'Save',
			html: '<div class="divide-y divide-gray-100">' + BC_DAYS.map(function(day) {
				const h = d.hours[day.key];
				const dis = h.open ? '' : ' disabled';
				const timeCls = 'bc-time h-10 px-2 rounded-lg bg-gray-50 border border-gray-200 text-[14px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-red/20 disabled:opacity-40';
				return '<div class="flex items-center gap-3 py-3" data-day="' + day.key + '">' +
					'<span class="w-[88px] text-[14px] font-medium text-gray-900">' + day.label + '</span>' +
					'<label class="relative inline-flex items-center cursor-pointer shrink-0">' +
						'<input type="checkbox" class="sr-only peer" id="bc-h-' + day.key + '-open" aria-label="' + day.label + ' open"' + (h.open ? ' checked' : '') + ' onchange="bcToggleDay(\'' + day.key + '\', this.checked)">' +
						'<span class="w-10 h-6 bg-gray-200 rounded-full transition-colors peer-checked:bg-brand-red after:content-[\'\'] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:bg-white after:rounded-full after:shadow after:transition-transform peer-checked:after:translate-x-4"></span>' +
					'</label>' +
					'<div class="flex-1 flex items-center justify-end gap-1.5 min-w-0">' +
						'<input type="time" id="bc-h-' + day.key + '-from" aria-label="' + day.label + ' opens" value="' + h.from + '" class="' + timeCls + '"' + dis + '>' +
						'<span class="text-gray-400 text-[13px]">&ndash;</span>' +
						'<input type="time" id="bc-h-' + day.key + '-to" aria-label="' + day.label + ' closes" value="' + h.to + '" class="' + timeCls + '"' + dis + '>' +
					'</div></div>';
			}).join('') + '</div>'
		};
	}
	if (kind === 'services') {
		return {
			title: 'Services', save: 'Done',
			html: '<p class="text-[14px] text-gray-500 mb-3">Add up to ' + BC_MAX_SERVICES + ' services or products you offer.</p>' +
				'<div class="flex gap-2"><input type="text" id="bc-sheet-service" maxlength="40" autocomplete="off" placeholder="e.g. Phone repair" onkeydown="if(event.key===\'Enter\'){event.preventDefault();bcAddService();}" class="' + inputCls + ' flex-1 min-w-0">' +
				'<button type="button" onclick="bcAddService()" class="h-12 px-5 rounded-xl bg-gray-900 text-white font-semibold text-[14px] active:opacity-90">Add</button></div>' +
				'<div id="bc-services-list" class="flex flex-wrap gap-2 mt-4"></div>'
		};
	}
	if (kind === 'contact') {
		return {
			title: 'Contact Information', save: 'Save',
			html: '<p class="text-[14px] text-gray-500 mb-3">Add at least one way for customers to reach you. All fields are optional.</p>' +
				'<div class="space-y-3">' +
				'<input type="tel" inputmode="tel" id="bc-sheet-phone" maxlength="20" autocomplete="off" placeholder="Phone number" value="' + escapeHtml(d.contact.phone) + '" class="' + inputCls + '">' +
				'<input type="email" id="bc-sheet-email" maxlength="100" autocomplete="off" placeholder="Email address" value="' + escapeHtml(d.contact.email) + '" class="' + inputCls + '">' +
				'<input type="url" inputmode="url" id="bc-sheet-website" maxlength="120" autocomplete="off" placeholder="Website" value="' + escapeHtml(d.contact.website) + '" class="' + inputCls + '">' +
				'</div>'
		};
	}
	if (kind === 'social') {
		return {
			title: 'Social Media', save: 'Save',
			html: '<p class="text-[14px] text-gray-500 mb-3">Link the pages customers can follow you on.</p><div class="space-y-3">' +
				BC_SOCIALS.map(function(s) {
					return '<div><label for="bc-sheet-social-' + s.key + '" class="block text-[13px] font-semibold text-gray-900 mb-1">' + s.label + '</label>' +
						'<input type="text" id="bc-sheet-social-' + s.key + '" maxlength="100" autocomplete="off" autocapitalize="none" placeholder="' + escapeHtml(s.placeholder) + '" value="' + escapeHtml(d.social[s.key]) + '" class="' + inputCls + '"></div>';
				}).join('') + '</div>'
		};
	}
	// documents
	return {
		title: 'Verification', save: 'Done',
		html: '<p class="text-[14px] text-gray-500 mb-3">Add a business license or other proof (PDF, JPG or PNG, up to ' + BC_MAX_DOCS + ' files, 5 MB each).</p>' +
			'<input type="file" id="bc-doc-input" class="hidden" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple onchange="bcOnDocsPicked(this)">' +
			'<button type="button" onclick="document.getElementById(\'bc-doc-input\').click()" class="w-full h-12 rounded-xl border border-dashed border-gray-300 text-gray-900 font-semibold text-[14px] active:bg-gray-50 transition-colors">Choose files</button>' +
			'<div id="bc-docs-list" class="mt-3 space-y-2"></div>'
	};
}

function bcOpenSheet(kind) {
	const cfg = bcBuildSheet(kind);
	bcSheetKind = kind;
	document.getElementById('bc-sheet-title').textContent = cfg.title;
	const body = document.getElementById('bc-sheet-body');
	body.innerHTML = cfg.html;
	body.scrollTop = 0;
	const footer = document.getElementById('bc-sheet-footer');
	footer.classList.toggle('hidden', !cfg.save);
	if (cfg.save) document.getElementById('bc-sheet-save').textContent = cfg.save;
	bcSheetError(null);
	if (kind === 'services') bcRenderServices();
	if (kind === 'documents') bcRenderDocs();
	document.getElementById('bc-sheet-backdrop').classList.add('is-open');
	const sheet = document.getElementById('bc-sheet');
	sheet.classList.add('is-open');
	sheet.setAttribute('aria-hidden', 'false');
	if (BC_FOCUS_SHEETS.includes(kind)) {
		setTimeout(function() {
			const first = body.querySelector('input:not([type="checkbox"]):not([disabled])');
			if (first && bcSheetKind === kind) first.focus();
		}, 320);
	}
}

function bcCloseSheet() {
	bcSheetKind = null;
	const sheet = document.getElementById('bc-sheet');
	if (!sheet) return;
	if (sheet.contains(document.activeElement)) document.activeElement.blur();
	sheet.classList.remove('is-open');
	sheet.setAttribute('aria-hidden', 'true');
	document.getElementById('bc-sheet-backdrop').classList.remove('is-open');
}

document.addEventListener('keydown', function(e) {
	if (e.key === 'Escape' && bcSheetKind) bcCloseSheet();
});

// Save button: text-style sheets commit here; list-style sheets (services,
// documents) already applied each change, so Save just closes them.
function bcSaveSheet() {
	const d = bcDraft;
	const val = function(id) { return document.getElementById(id).value.trim(); };
	if (bcSheetKind === 'location') {
		const loc = val('bc-sheet-location');
		if (loc.length < BC_MIN_LOCATION) { bcSheetError('Enter your location'); return; }
		d.location = loc;
		bcSetError('location', null);
	} else if (bcSheetKind === 'hours') {
		const next = {};
		let anyOpen = false;
		for (let i = 0; i < BC_DAYS.length; i++) {
			const day = BC_DAYS[i];
			const open = document.getElementById('bc-h-' + day.key + '-open').checked;
			const from = document.getElementById('bc-h-' + day.key + '-from').value;
			const to = document.getElementById('bc-h-' + day.key + '-to').value;
			if (open) {
				if (!from || !to) { bcSheetError('Set opening and closing times for ' + day.label); return; }
				if (to <= from) { bcSheetError('Closing time must be after opening time on ' + day.label); return; }
				anyOpen = true;
			}
			next[day.key] = { open: open, from: from || '09:00', to: to || '17:00' };
		}
		if (!anyOpen) { bcSheetError('Turn on at least one day you are open'); return; }
		d.hours = next;
		d.hoursSet = true;
		bcSetError('hours', null);
	} else if (bcSheetKind === 'contact') {
		const phone = val('bc-sheet-phone');
		const email = val('bc-sheet-email');
		const website = val('bc-sheet-website');
		if (phone && !/^[+\d][\d\s()\-]{6,}$/.test(phone)) { bcSheetError('Enter a valid phone number'); return; }
		if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { bcSheetError('Enter a valid email address'); return; }
		if (website && !/^(https?:\/\/)?[^\s.\/]+(\.[^\s.\/]+)+(\/\S*)?$/i.test(website)) { bcSheetError('Enter a valid website'); return; }
		d.contact = { phone: phone, email: email, website: website };
	} else if (bcSheetKind === 'social') {
		BC_SOCIALS.forEach(function(s) { d.social[s.key] = val('bc-sheet-social-' + s.key); });
	}
	bcRenderSummaries();
	bcCloseSheet();
}

// ---- Category ----

function bcPickCategory(index) {
	bcDraft.category = BC_CATEGORIES[index];
	bcSetError('category', null);
	bcRenderSummaries();
	bcCloseSheet();
}

// ---- Hours ----

function bcToggleDay(key, checked) {
	['from', 'to'].forEach(function(part) {
		document.getElementById('bc-h-' + key + '-' + part).disabled = !checked;
	});
}

// ---- Services ----

function bcRenderServices() {
	const list = document.getElementById('bc-services-list');
	if (!list) return;
	list.innerHTML = bcDraft.services.map(function(s, i) {
		return '<span class="inline-flex items-center gap-1.5 pl-3.5 pr-2 py-1.5 rounded-full bg-gray-100 text-gray-900 text-[14px]">' + escapeHtml(s) +
			'<button type="button" aria-label="Remove ' + escapeHtml(s) + '" onclick="bcRemoveService(' + i + ')" class="w-5 h-5 rounded-full flex items-center justify-center text-gray-500 active:bg-gray-200">' +
			'<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></span>';
	}).join('');
}

function bcAddService() {
	const input = document.getElementById('bc-sheet-service');
	const value = input.value.trim().replace(/\s+/g, ' ');
	if (!value) return;
	if (bcDraft.services.length >= BC_MAX_SERVICES) { bcSheetError('You can add up to ' + BC_MAX_SERVICES + ' services'); return; }
	if (bcDraft.services.some(function(s) { return s.toLowerCase() === value.toLowerCase(); })) { bcSheetError('That service is already added'); return; }
	bcSheetError(null);
	bcDraft.services.push(value);
	input.value = '';
	input.focus();
	bcRenderServices();
	bcRenderSummaries();
}

function bcRemoveService(index) {
	bcDraft.services.splice(index, 1);
	bcSheetError(null);
	bcRenderServices();
	bcRenderSummaries();
}

// ---- Verification documents ----

function bcFormatSize(bytes) {
	return bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function bcRenderDocs() {
	const list = document.getElementById('bc-docs-list');
	if (!list) return;
	list.innerHTML = bcDraft.documents.map(function(f, i) {
		return '<div class="flex items-center gap-3 px-3.5 py-3 rounded-xl border border-gray-200">' +
			'<span class="flex-1 min-w-0"><span class="block text-[14px] font-medium text-gray-900 truncate">' + escapeHtml(f.name) + '</span>' +
			'<span class="block text-[12.5px] text-gray-500">' + bcFormatSize(f.size) + '</span></span>' +
			'<button type="button" aria-label="Remove ' + escapeHtml(f.name) + '" onclick="bcRemoveDoc(' + i + ')" class="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-gray-500 active:bg-gray-100">' +
			'<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>';
	}).join('');
}

function bcOnDocsPicked(input) {
	const problems = [];
	Array.prototype.forEach.call(input.files, function(f) {
		const okType = /\.(pdf|jpe?g|png)$/i.test(f.name) || /^(application\/pdf|image\/(jpeg|png))$/.test(f.type);
		if (!okType) { problems.push(f.name + ' is not a PDF, JPG or PNG'); return; }
		if (f.size > BC_MAX_DOC_BYTES) { problems.push(f.name + ' is over 5 MB'); return; }
		if (bcDraft.documents.length >= BC_MAX_DOCS) { problems.push('You can add up to ' + BC_MAX_DOCS + ' files'); return; }
		bcDraft.documents.push(f);
	});
	input.value = ''; // allow re-picking the same file after removing it
	bcSheetError(problems.length ? problems[0] : null);
	bcRenderDocs();
	bcRenderSummaries();
}

function bcRemoveDoc(index) {
	bcDraft.documents.splice(index, 1);
	bcSheetError(null);
	bcRenderDocs();
	bcRenderSummaries();
}
