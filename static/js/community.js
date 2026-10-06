// ---- Communities ----
//
// Server contract (app/routes/communities.py):
//   GET    /api/communities?q=&cursor=&limit=  -> {communities: [...], next_cursor}
//   GET    /api/communities/mine               -> {communities: [...]}
//   POST   /api/communities                    body: {name, description, topic, type}
//   GET    /api/communities/<slug>
//   POST   /api/communities/<slug>/join        -> full community object
//   POST   /api/communities/<slug>/leave       -> full community object
//   GET    /api/communities/<slug>/posts?cursor=&limit=
//   POST   /api/communities/<slug>/posts       body: {content}
// (No update route yet: the Edit Community screen is UI-only.)
//
// `communityApi` talks to those routes only. Any non-2xx response or
// network failure throws a CommunityApiError carrying the server's
// {error} message and HTTP status; callers decide how to surface it.

// ---- Reference data ----

const COMMUNITY_TOPICS = [
	{ key: 'education', label: 'Education', icon: 'M11.7 2.8a.75.75 0 01.6 0l9 4a.75.75 0 010 1.4l-9 4a.75.75 0 01-.6 0l-9-4a.75.75 0 010-1.4l9-4z M4.5 10.2v3.9c0 .3.15.55.4.7 1.05.65 3.7 1.95 7.1 1.95s6.05-1.3 7.1-1.95a.8.8 0 00.4-.7v-3.9 M19.5 10.5v5.25' },
	{ key: 'student-life', label: 'Student Life', icon: 'M17 20.7a9 9 0 003.7-.5 3 3 0 00-4.7-2.7m.9 3.2v.03c0 .22-.01.44-.03.66A11.9 11.9 0 0112 21c-2.17 0-4.2-.58-5.96-1.58a6 6 0 01-.04-.7m12 0a6 6 0 00-.94-3.2m0 0A6 6 0 0012 12.75a6 6 0 00-5.06 2.77m0 0a3 3 0 00-4.68 2.72A9 9 0 005 20.7m.94-3.2A6 6 0 015 20.7M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z' },
	{ key: 'technology', label: 'Technology', icon: 'M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25' },
	{ key: 'gaming', label: 'Gaming', icon: 'M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.4 48.4 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.5 48.5 0 01-.298 3.99 1.98 1.98 0 001.933 2.226h6.62' },
	{ key: 'art-creativity', label: 'Art & Creativity', icon: 'M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42' },
	{ key: 'fitness-health', label: 'Fitness & Health', icon: 'M4.5 12.75l6 6 9-13.5' },
	{ key: 'career-jobs', label: 'Career & Jobs', icon: 'M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 00.75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 00-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0112 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 01-.673-.38m0 0A2.18 2.18 0 013 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 013.413-.387m7.5 0V5.25A2.25 2.25 0 0013.5 3h-3a2.25 2.25 0 00-2.25 2.25v.894m7.5 0a48.667 48.667 0 00-7.5 0' },
	{ key: 'discussion', label: 'Discussion', icon: 'M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM21 12c0 4.556-4.03 8.25-9 8.25a9.76 9.76 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z' }
];

// All three types are enforced server-side (Phase 4: community_access.py),
// so the create wizard offers all of them. `creatable: false` hides a type.
const COMMUNITY_TYPES = [
	{ value: 'public', creatable: true, label: 'Public', desc: 'Anyone can search for, view, and contribute to this community.', icon: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0zM3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 000 18M12.5 3a17 17 0 010 18' },
	{ value: 'restricted', creatable: true, label: 'Restricted', desc: 'Anyone can view, but only approved members can contribute.', icon: 'M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178zM15 12a3 3 0 11-6 0 3 3 0 016 0z' },
	{ value: 'private', creatable: true, label: 'Private', desc: 'Only approved members can view and contribute.', icon: 'M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z' }
];

// ---- Data layer ----

const COMMUNITY_POST_MAX_LEN = 2000; // matches post_service.MAX_CONTENT_LEN

class CommunityApiError extends Error {
	constructor(message, status) {
		super(message);
		this.name = 'CommunityApiError';
		this.status = status; // 0 = network failure
	}
}

const communityApi = {
	async _request(url, options = {}, fallbackMessage = 'Something went wrong. Try again.') {
		let res;
		try {
			res = await apiFetch(url, options);
		} catch (e) {
			throw new CommunityApiError('Network error. Check your connection.', 0);
		}
		let data = null;
		try { data = await res.json(); } catch (e) {}
		if (!res.ok) {
			throw new CommunityApiError((data && data.error) || fallbackMessage, res.status);
		}
		return data;
	},

	_json(method, body) {
		return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
	},

	get(slug) {
		return this._request(`/api/communities/${encodeURIComponent(slug)}`, {}, 'Could not load community.');
	},

	// Directory/search. Resolves to {communities, next_cursor}.
	async browse(q, cursor, limit) {
		const params = new URLSearchParams();
		if (q) params.set('q', q);
		if (cursor) params.set('cursor', cursor);
		if (limit) params.set('limit', limit);
		const qs = params.toString();
		const data = await this._request(`/api/communities${qs ? '?' + qs : ''}`, {}, 'Could not load communities.');
		return { communities: (data && data.communities) || [], next_cursor: (data && data.next_cursor) || null };
	},

	async listMine() {
		const data = await this._request('/api/communities/mine', {}, 'Could not load your communities.');
		return (data && data.communities) || [];
	},

	create(payload) {
		return this._request('/api/communities', this._json('POST', payload), 'Could not create community.');
	},

	// Resolves to the full community object (fresh member_count + membership).
	setMembership(slug, join) {
		const path = join ? 'join' : 'leave';
		return this._request(`/api/communities/${encodeURIComponent(slug)}/${path}`, { method: 'POST' },
			join ? 'Could not join community.' : 'Could not leave community.');
	},

	async listPosts(slug, cursor) {
		const params = new URLSearchParams();
		if (cursor) params.set('cursor', cursor);
		const qs = params.toString();
		const data = await this._request(`/api/communities/${encodeURIComponent(slug)}/posts${qs ? '?' + qs : ''}`, {}, 'Could not load posts.');
		return { posts: (data && data.posts) || [], next_cursor: (data && data.next_cursor) || null };
	},

	async createPost(slug, content, files) {
		if (files && files.length > 0) {
			const form = new FormData();
			form.append('content', content);
			for (const file of files) {
				form.append('images', file);
			}
			return this._request(`/api/communities/${encodeURIComponent(slug)}/posts`,
				{ method: 'POST', body: form }, 'Could not post. Try again.');
		} else {
			return this._request(`/api/communities/${encodeURIComponent(slug)}/posts`,
				this._json('POST', { content }), 'Could not post. Try again.');
		}
	}
};

// ---- Create Community wizard ----

let communityCreateState = { step: 1, topic: null, customTopic: '', type: null, name: '', description: '', submitting: false };

function communityCreateFreshState() {
	return { step: 1, topic: null, customTopic: '', type: null, name: '', description: '', submitting: false };
}

function openCommunityCreateView() {
	communityCreateState = communityCreateFreshState();
	document.getElementById('community-create-topic-search').value = '';
	document.getElementById('community-create-custom-topic-input').value = '';
	document.getElementById('community-create-custom-topic-wrap').classList.add('hidden');
	document.getElementById('community-create-name').value = '';
	document.getElementById('community-create-description').value = '';
	document.getElementById('community-create-error').classList.add('hidden');
	renderCommunityCreateTopicGrid();
	renderCommunityCreateTypeList();
	communityCreateGoToStep(1);
	showView('community-create');
}

function communityCreateBack() {
	if (communityCreateState.step > 1) {
		communityCreateGoToStep(communityCreateState.step - 1);
	} else {
		showView('feed');
	}
}

function communityCreateGoToStep(step) {
	communityCreateState.step = step;
	document.querySelectorAll('.community-create-step').forEach(el => el.classList.add('hidden'));
	document.getElementById(`community-create-step-${step}`).classList.remove('hidden');
	document.getElementById('community-create-step-badge').textContent = `${step} of 3`;
	document.getElementById('community-create-next-label').textContent = step === 3 ? 'Create Community' : 'Next';
	document.getElementById('community-create-error').classList.add('hidden');
	communityCreateUpdateNextEnabled();
}

function renderCommunityCreateTopicGrid() {
	const grid = document.getElementById('community-create-topic-grid');
	const query = document.getElementById('community-create-topic-search').value.trim().toLowerCase();
	const topics = query ? COMMUNITY_TOPICS.filter(t => t.label.toLowerCase().includes(query)) : COMMUNITY_TOPICS;
	grid.innerHTML = topics.map(t => {
		const selected = communityCreateState.topic === t.key;
		return `<button type="button" onclick="communityCreateSelectTopic('${t.key}')" class="flex items-center gap-2.5 px-4 py-3.5 rounded-2xl border text-[14px] font-medium transition-colors text-left ${selected ? 'border-brand-red bg-red-50 text-brand-red' : 'border-gray-200 text-gray-800 hover:bg-gray-50'}">
			<svg class="w-4.5 h-4.5 shrink-0" style="width:18px;height:18px" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${t.icon}" stroke-linecap="round" stroke-linejoin="round"></path></svg>
			<span class="truncate">${escapeHtml(t.label)}</span>
		</button>`;
	}).join('');
}

function communityCreateSelectTopic(key) {
	communityCreateState.topic = key;
	communityCreateState.customTopic = '';
	document.getElementById('community-create-custom-topic-wrap').classList.add('hidden');
	document.getElementById('community-create-custom-topic-chevron').style.transform = '';
	renderCommunityCreateTopicGrid();
	communityCreateUpdateNextEnabled();
}

function communityCreateToggleCustomTopic() {
	const wrap = document.getElementById('community-create-custom-topic-wrap');
	const chevron = document.getElementById('community-create-custom-topic-chevron');
	const opening = wrap.classList.contains('hidden');
	wrap.classList.toggle('hidden');
	chevron.style.transform = opening ? 'rotate(90deg)' : '';
	if (opening) document.getElementById('community-create-custom-topic-input').focus();
}

function communityCreateCustomTopicInput(value) {
	communityCreateState.customTopic = value.trim();
	communityCreateState.topic = communityCreateState.customTopic ? '__custom__' : null;
	renderCommunityCreateTopicGrid();
	communityCreateUpdateNextEnabled();
}

function renderCommunityCreateTypeList() {
	const list = document.getElementById('community-create-type-list');
	list.innerHTML = COMMUNITY_TYPES.filter(t => t.creatable).map(t => {
		const selected = communityCreateState.type === t.value;
		return `<button type="button" onclick="communityCreateSelectType('${t.value}')" class="w-full flex items-start gap-4 px-4 py-4 rounded-2xl border text-left transition-colors ${selected ? 'border-brand-red bg-red-50' : 'border-gray-200 hover:bg-gray-50'}">
			<span class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${selected ? 'bg-brand-red text-white' : 'bg-gray-100 text-gray-600'}">
				<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${t.icon}" stroke-linecap="round" stroke-linejoin="round"></path></svg>
			</span>
			<span class="flex-1 min-w-0">
				<span class="block text-[16px] font-bold text-gray-900">${t.label}</span>
				<span class="block text-[13px] text-gray-500 mt-0.5 leading-snug">${t.desc}</span>
			</span>
			<span class="w-5 h-5 rounded-full border-2 shrink-0 mt-1 flex items-center justify-center ${selected ? 'border-brand-red' : 'border-gray-300'}">
				${selected ? '<span class="w-2.5 h-2.5 rounded-full bg-brand-red"></span>' : ''}
			</span>
		</button>`;
	}).join('');
}

function communityCreateSelectType(value) {
	communityCreateState.type = value;
	renderCommunityCreateTypeList();
	communityCreateUpdateNextEnabled();
}

function communityCreateUpdateCounters() {
	const name = document.getElementById('community-create-name').value;
	const desc = document.getElementById('community-create-description').value;
	communityCreateState.name = name.trim();
	communityCreateState.description = desc.trim();
	document.getElementById('community-create-name-count').textContent = `${name.length}/21`;
	document.getElementById('community-create-desc-count').textContent = `${desc.length}/500`;
	communityCreateUpdateNextEnabled();
}

function communityCreateStepValid(step) {
	if (step === 1) return !!communityCreateState.topic;
	if (step === 2) return !!communityCreateState.type;
	if (step === 3) return communityCreateState.name.length > 0 && communityCreateState.description.length > 0;
	return false;
}

function communityCreateUpdateNextEnabled() {
	const btn = document.getElementById('community-create-next-btn');
	btn.disabled = !communityCreateStepValid(communityCreateState.step);
}

async function communityCreateNext() {
	if (!communityCreateStepValid(communityCreateState.step)) return;
	if (communityCreateState.step < 3) {
		communityCreateGoToStep(communityCreateState.step + 1);
		return;
	}
	await communityCreateSubmit();
}

async function communityCreateSubmit() {
	if (communityCreateState.submitting) return;
	communityCreateState.submitting = true;
	const btn = document.getElementById('community-create-next-btn');
	const spinner = document.getElementById('community-create-next-spinner');
	const errorDiv = document.getElementById('community-create-error');
	btn.disabled = true;
	spinner.classList.remove('hidden');
	errorDiv.classList.add('hidden');

	const topicKey = communityCreateState.topic === '__custom__' ? communityCreateState.customTopic : communityCreateState.topic;
	try {
		const community = await communityApi.create({
			name: communityCreateState.name,
			description: communityCreateState.description,
			topic: topicKey,
			type: communityCreateState.type
		});
		showToast('Community created');
		openCommunityView(community.slug || community.id);
	} catch (e) {
		errorDiv.textContent = e.message || 'Could not create community. Try again.';
		errorDiv.classList.remove('hidden');
		communityCreateState.submitting = false;
		communityCreateUpdateNextEnabled();
		spinner.classList.add('hidden');
	}
}

// ---- Community detail view ----

const COMMUNITY_RETURN_VIEWS = ['feed', 'courses', 'library', 'businesses', 'search', 'chat', 'profile', 'user-profile', 'wallet', 'community-browse'];
let communityReturnView = 'feed';
let communityCurrentSlug = null;
let communityCurrentData = null;
let communityLoadToken = 0;

function openCommunityView(slug) {
	const activeEl = document.querySelector('.view-section.active');
	const name = activeEl ? activeEl.id.replace(/-view$/, '') : 'feed';
	if (COMMUNITY_RETURN_VIEWS.includes(name)) communityReturnView = name;
	communityCurrentSlug = slug;
	showView('community');
	loadCommunityView();
}

function closeCommunityView() {
	// The browse list is not reloaded on return, so push any membership
	// change made on this screen into its cached rows first.
	if (communityCurrentData) communityBrowseSyncItem(communityCurrentData);
	if (communityReturnView === 'search') searchRestoreOnce = true;
	showView(communityReturnView || 'feed');
}

async function loadCommunityView() {
	if (!communityCurrentSlug) return;
	const token = ++communityLoadToken;
	const errorEl = document.getElementById('community-error');
	errorEl.classList.add('hidden');
	document.getElementById('community-content').classList.add('hidden');
	try {
		const community = await communityApi.get(communityCurrentSlug);
		if (token !== communityLoadToken) return;
		communityCurrentData = community;
		renderCommunityHeader(community);
		document.getElementById('community-content').classList.remove('hidden');
		switchCommunityTab('posts');
	} catch (e) {
		if (token !== communityLoadToken) return;
		const notFound = e.status === 404;
		if (e.status === 404 || e.status === 403) communityForgetSlug(communityCurrentSlug);
		document.getElementById('community-error-title').textContent = notFound ? 'Community not found' : "Couldn't load this community";
		document.getElementById('community-error-detail').textContent = notFound ? 'It may have been removed or the link is wrong.' : (e.message || 'Check your connection and try again.');
		document.getElementById('community-error-retry').classList.toggle('hidden', notFound);
		errorEl.classList.remove('hidden');
	}
}

// A community that 404s/403s for this viewer (removed, made private, or the
// person was removed from it) must not linger in cached lists.
function communityForgetSlug(slug) {
	const i = communityBrowseItems.findIndex(c => c.slug === slug);
	if (i !== -1) {
		communityBrowseItems.splice(i, 1);
		communityBrowseRender();
	}
	if (typeof refreshSideNavCommunities === 'function') refreshSideNavCommunities();
}

function communityTopicIcon(topicKey) {
	const t = COMMUNITY_TOPICS.find(x => x.key === topicKey);
	return t ? t.icon : COMMUNITY_TOPICS[COMMUNITY_TOPICS.length - 1].icon;
}

function communityFormatCount(n) {
	if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
	return String(n);
}

function renderCommunityHeader(community) {
	document.getElementById('community-name').textContent = community.name;
	document.getElementById('community-description').textContent = community.description || '';
	document.getElementById('community-description').classList.toggle('hidden', !community.description);

	const typeMeta = COMMUNITY_TYPES.find(t => t.value === community.type);

	// "51 members" + optional green "N online". The server does not report
	// presence yet, so the online chip only renders if/when the community
	// object carries a numeric `online_count`; nothing is faked.
	document.getElementById('community-meta-members').textContent = `${communityFormatCount(community.member_count || 0)} members`;
	const onlineEl = document.getElementById('community-meta-online');
	const hasOnline = typeof community.online_count === 'number';
	onlineEl.classList.toggle('hidden', !hasOnline);
	onlineEl.classList.toggle('inline-flex', hasOnline);
	if (hasOnline) document.getElementById('community-meta-online-text').textContent = `${communityFormatCount(community.online_count)} online`;

	const iconEl = document.getElementById('community-icon');
	iconEl.textContent = community.icon_emoji || '\u{1F465}';

	document.getElementById('community-banner-icon').innerHTML = `<path d="${communityTopicIcon(community.topic)}" stroke-linecap="round" stroke-linejoin="round"></path>`;

	const role = community.membership ? community.membership.role : null;
	const isMember = community.membership ? community.membership.is_member : false;
	const actionBtn = document.getElementById('community-action-btn');
	const ACTION_PILL = 'h-9 rounded-full flex items-center justify-center transition-colors active:scale-[0.98] duration-100 ';
	if (role === 'creator' || role === 'moderator') {
		// Pencil -> Edit Community screen (light outlined circle, matches More options).
		actionBtn.className = ACTION_PILL + 'w-9 border border-gray-200 text-gray-700 hover:bg-gray-50';
		actionBtn.setAttribute('aria-label', 'Edit community');
		actionBtn.innerHTML = '<svg class="w-[17px] h-[17px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16.9 3.6a2.1 2.1 0 013 3L8 18.5l-4 1 1-4L16.9 3.6z" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
		actionBtn.dataset.mode = 'manage';
	} else if (isMember) {
		actionBtn.className = ACTION_PILL + 'pl-3.5 pr-4 gap-1.5 border border-gray-200 text-[13px] font-semibold text-gray-900 hover:bg-gray-50';
		actionBtn.setAttribute('aria-label', 'Joined');
		actionBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"></path></svg> Joined`;
		actionBtn.dataset.mode = 'leave';
	} else if (community.type === 'restricted') {
		// Restricted: members are added by the creator; there is nothing to click.
		actionBtn.className = ACTION_PILL + 'px-4 border border-gray-200 text-[13px] font-semibold text-gray-400 cursor-default';
		actionBtn.setAttribute('aria-label', 'Invite only');
		actionBtn.innerHTML = 'Invite only';
		actionBtn.dataset.mode = 'none';
	} else {
		actionBtn.className = ACTION_PILL + 'px-4 border border-gray-200 text-[13px] font-semibold text-gray-900 hover:bg-gray-50';
		actionBtn.setAttribute('aria-label', 'Join');
		actionBtn.innerHTML = 'Join';
		actionBtn.dataset.mode = 'join';
	}
	actionBtn.disabled = actionBtn.dataset.mode === 'none';

	document.getElementById('community-about-description').textContent = community.description || '';
	document.getElementById('community-about-type').textContent = typeMeta ? `${typeMeta.label} — ${typeMeta.desc}` : '';
	document.getElementById('community-about-created').textContent = community.created_at ? new Date(community.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
}

let communityMembershipBusy = false;

async function communityHandleActionBtn() {
	if (!communityCurrentData || communityMembershipBusy) return;
	const btn = document.getElementById('community-action-btn');
	const mode = btn.dataset.mode;
	if (mode === 'none') return;
	if (mode === 'manage') {
		openCommunityEdit();
		return;
	}
	const join = mode === 'join';
	if (!join) {
		const rejoinNote = communityCurrentData.type === 'public' ? '' : " You'll need to be added again to rejoin.";
		if (!confirm(`Leave ${communityCurrentData.name}?${rejoinNote}`)) return;
	}
	const slug = communityCurrentSlug;
	communityMembershipBusy = true;
	btn.disabled = true;
	try {
		const community = await communityApi.setMembership(slug, join);
		if (slug !== communityCurrentSlug) return; // user navigated away mid-request
		communityCurrentData = community;
		renderCommunityHeader(community);
		showToast(join ? `Joined ${community.name}` : `Left ${community.name}`);
		communityBrowseSyncItem(community);
		refreshSideNavCommunities();
	} catch (e) {
		showToast(e.message || 'Something went wrong. Try again.');
	} finally {
		communityMembershipBusy = false;
		btn.disabled = btn.dataset.mode === 'none'; // leaving a restricted community lands on the inert pill
	}
}

function switchCommunityTab(tab) {
	document.querySelectorAll('.community-tab').forEach(btn => {
		const active = btn.dataset.tab === tab;
		btn.classList.toggle('bg-gray-100', active);
		btn.classList.toggle('text-gray-900', active);
		btn.classList.toggle('font-semibold', active);
		btn.classList.toggle('text-gray-500', !active);
		btn.classList.toggle('font-medium', !active);
	});
	document.getElementById('community-feed-controls').classList.toggle('hidden', tab !== 'posts');
	communitySetSortMenu(false);
	document.querySelectorAll('.community-panel').forEach(panel => panel.classList.add('hidden'));
	document.getElementById(`community-panel-${tab}`).classList.remove('hidden');
	if (tab === 'posts') {
		communityPostsItems = [];
		communityPostsCursor = null;
		loadCommunityPosts(true);
	}
}

// ---- Sort menu (Best / Hot / New) ----
// Only "Best" (the feed's current ordering) exists server-side; Hot and New
// need ranking support, so they close the menu with the standard toast and
// leave the selection unchanged.

let communitySort = 'best';

function communityIsSortMenuOpen() {
	const menu = document.getElementById('community-sort-menu');
	return !!menu && !menu.classList.contains('hidden');
}

function communitySetSortMenu(open) {
	const menu = document.getElementById('community-sort-menu');
	const btn = document.getElementById('community-sort-btn');
	if (!menu || !btn) return;
	menu.classList.toggle('hidden', !open);
	// Keep the compact menu inside the viewport: if left-aligned under the
	// button it would overflow the right edge, flip it to right-aligned.
	menu.classList.remove('right-0', 'left-auto');
	menu.classList.add('left-0');
	if (open) {
		const r = menu.getBoundingClientRect();
		if (r.right > window.innerWidth - 8) {
			menu.classList.remove('left-0');
			menu.classList.add('left-auto', 'right-0');
		}
	}
	btn.setAttribute('aria-expanded', String(open));
	btn.classList.toggle('bg-gray-100', open);
	btn.classList.toggle('text-gray-900', open);
	btn.classList.toggle('text-gray-500', !open);
	document.getElementById('community-sort-chevron').classList.toggle('rotate-180', open);
}

function communityToggleSortMenu(event) {
	if (event) event.stopPropagation();
	communitySetSortMenu(!communityIsSortMenuOpen());
}

function communitySelectSort(value) {
	communitySetSortMenu(false);
	if (value !== communitySort) {
		showToast('Coming soon');
		return;
	}
}

document.addEventListener('click', function(e) {
	if (communityIsSortMenuOpen() && !e.target.closest('#community-sort-menu')) communitySetSortMenu(false);
});
document.addEventListener('keydown', function(e) {
	if (e.key === 'Escape' && communityIsSortMenuOpen()) communitySetSortMenu(false);
});

// ---- Edit Community (UI only: no update endpoint exists yet) ----

const COMMUNITY_EDIT_PRIVACY_COPY = {
	public: "Anyone can find this community and see what's inside.",
	restricted: "Anyone can find this community and see what's inside, but only approved members can post.",
	private: "Only approved members can find this community and see what's inside."
};
let communityEditOriginal = null;

function openCommunityEdit() {
	const c = communityCurrentData;
	if (!c) return;
	communityEditOriginal = { name: c.name || '', description: c.description || '' };
	const photo = document.getElementById('community-edit-photo');
	photo.className = `w-full h-full rounded-full flex items-center justify-center text-[44px] ${c.icon_bg || 'bg-sky-100'}`;
	photo.textContent = c.icon_emoji || '\u{1F465}';
	document.getElementById('community-edit-cover-icon').innerHTML = `<path d="${communityTopicIcon(c.topic)}" stroke-linecap="round" stroke-linejoin="round"></path>`;
	const typeMeta = COMMUNITY_TYPES.find(t => t.value === c.type) || COMMUNITY_TYPES[0];
	document.getElementById('community-edit-privacy-icon').innerHTML = `<path d="${typeMeta.icon}" stroke-linecap="round" stroke-linejoin="round"></path>`;
	document.getElementById('community-edit-privacy-label').textContent = typeMeta.label;
	document.getElementById('community-edit-privacy-desc').textContent = COMMUNITY_EDIT_PRIVACY_COPY[typeMeta.value] || typeMeta.desc;
	document.getElementById('community-edit-name').value = communityEditOriginal.name;
	document.getElementById('community-edit-description').value = communityEditOriginal.description;
	communityEditUpdate();
	showView('community-edit');
	window.scrollTo(0, 0);
}

function communityEditBack() {
	showView('community');
}

function communityEditUpdate() {
	const nameEl = document.getElementById('community-edit-name');
	const descEl = document.getElementById('community-edit-description');
	const nameCount = document.getElementById('community-edit-name-count');
	const descCount = document.getElementById('community-edit-desc-count');
	nameCount.textContent = `${nameEl.value.length}/50`;
	descCount.textContent = `${descEl.value.length}/200`;
	descCount.classList.toggle('text-red-500', descEl.value.length > 200);
	descCount.classList.toggle('text-gray-400', descEl.value.length <= 200);
	const o = communityEditOriginal || { name: '', description: '' };
	const dirty = nameEl.value.trim() !== o.name || descEl.value.trim() !== o.description;
	document.getElementById('community-edit-save-btn').disabled = !(dirty && nameEl.value.trim().length > 0);
}

function communityEditSave() {
	// Persisting needs a backend update route that does not exist yet.
	showToast('Coming soon');
}

let communityPostsItems = [];
let communityPostsCursor = null;
let communityPostsLoading = false;
let communityPostsToken = 0;

async function loadCommunityPosts(reset) {
	if (communityPostsLoading && !reset) return;
	if (!reset && communityPostsCursor === null) return;
	const slug = communityCurrentSlug;
	const list = document.getElementById('community-posts-list');
	const loading = document.getElementById('community-posts-loading');
	const empty = document.getElementById('community-posts-empty');
	const errorEl = document.getElementById('community-posts-error');
	const footer = document.getElementById('community-posts-footer');

	communityPostsLoading = true;
	// A reset invalidates every in-flight request; a stale response must
	// neither render nor touch the shared loading flag.
	if (reset) communityPostsToken++;
	const token = communityPostsToken;

	if (reset) {
		communityPostsItems = [];
		communityPostsCursor = null;
		loading.classList.remove('hidden');
		empty.classList.add('hidden');
		empty.classList.remove('flex');
		errorEl.classList.add('hidden');
		errorEl.classList.remove('flex');
		footer.classList.add('hidden');
		list.innerHTML = '';
	} else {
		footer.innerHTML = '<button type="button" class="w-full py-3 text-sm text-gray-400" disabled>Loading…</button>';
	}

	try {
		const page = await communityApi.listPosts(slug, reset ? null : communityPostsCursor);
		if (slug !== communityCurrentSlug || token !== communityPostsToken) return;
		communityPostsLoading = false;
		loading.classList.add('hidden');

		// Dedupe by post id
		const seen = new Set(communityPostsItems.map(p => p.id));
		const newPosts = page.posts.filter(p => !seen.has(p.id));
		communityPostsItems = communityPostsItems.concat(newPosts);
		communityPostsCursor = page.next_cursor;

		if (reset) {
			if (!communityPostsItems.length) {
				empty.classList.remove('hidden');
				empty.classList.add('flex');
				footer.classList.add('hidden');
				return;
			}
			list.innerHTML = communityPostsItems.map(buildPostCardHtml).join('');
		} else {
			list.insertAdjacentHTML('beforeend', newPosts.map(buildPostCardHtml).join(''));
		}

		// Show/hide "Load more" button
		if (communityPostsCursor) {
			footer.classList.remove('hidden');
			footer.innerHTML = '<button type="button" onclick="loadCommunityPosts(false)" class="w-full py-3 text-sm text-gray-500 hover:text-gray-700 font-medium">Load more</button>';
		} else {
			footer.classList.add('hidden');
		}
	} catch (e) {
		if (slug !== communityCurrentSlug || token !== communityPostsToken) return;
		communityPostsLoading = false;
		loading.classList.add('hidden');
		if (reset || !communityPostsItems.length) {
			document.getElementById('community-posts-error-detail').textContent = e.message || 'Check your connection and try again.';
			errorEl.classList.remove('hidden');
			errorEl.classList.add('flex');
			footer.classList.add('hidden');
		} else {
			showToast(e.message || "Couldn't load more posts.");
			footer.classList.remove('hidden');
			footer.innerHTML = '<button type="button" onclick="loadCommunityPosts(false)" class="w-full py-3 text-sm text-gray-500 hover:text-gray-700 font-medium">Load more</button>';
		}
	}
}

// Called by removePostFromDom (comments.js) after a confirmed delete. Keeps
// the in-memory list in sync, restores the empty state when the last post
// is gone, and pulls the next page if the visible page was emptied but more
// posts exist.
function communityOnPostRemoved(postId) {
	const id = String(postId);
	if (!communityPostsItems.some(p => String(p.id) === id)) return;
	communityPostsItems = communityPostsItems.filter(p => String(p.id) !== id);
	const list = document.getElementById('community-posts-list');
	if (!list || list.querySelector('article[data-post-id]')) return;
	if (communityPostsCursor !== null) {
		loadCommunityPosts(false);
		return;
	}
	const empty = document.getElementById('community-posts-empty');
	empty.classList.remove('hidden');
	empty.classList.add('flex');
	document.getElementById('community-posts-footer').classList.add('hidden');
}

let communityComposerFiles = [];
const COMMUNITY_POST_MAX_IMAGES = 4;

function communityComposerAutoGrow(el) {
	el.style.height = '40px';
	el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	const len = el.value.length;
	const counter = document.getElementById('community-composer-count');
	const nearLimit = len >= COMMUNITY_POST_MAX_LEN - 200;
	counter.classList.toggle('hidden', !nearLimit);
	counter.classList.toggle('text-red-500', len >= COMMUNITY_POST_MAX_LEN);
	counter.classList.toggle('text-gray-400', len < COMMUNITY_POST_MAX_LEN);
	counter.textContent = `${len}/${COMMUNITY_POST_MAX_LEN}`;
	const btn = document.getElementById('community-composer-post-btn');
	btn.disabled = el.value.trim().length === 0 || communityPostBusy;
}

function communityComposerPhotoClick() {
	const input = document.createElement('input');
	input.type = 'file';
	input.accept = 'image/*';
	input.multiple = true;
	input.onchange = (e) => {
		const files = Array.from(e.target.files || []);
		for (const file of files) {
			if (communityComposerFiles.length >= COMMUNITY_POST_MAX_IMAGES) {
				showToast(`A post can have at most ${COMMUNITY_POST_MAX_IMAGES} images.`);
				break;
			}
			if (file.size > 5 * 1024 * 1024) {
				showToast('Each image must be under 5MB.');
				continue;
			}
			communityComposerFiles.push(file);
		}
		communityComposerRenderPreviews();
		communityComposerAutoGrow(document.getElementById('community-composer-input'));
	};
	input.click();
}

function communityComposerRenderPreviews() {
	const container = document.getElementById('community-composer-previews');
	if (!communityComposerFiles.length) {
		container.classList.add('hidden');
		container.innerHTML = '';
		return;
	}
	container.classList.remove('hidden');
	container.innerHTML = communityComposerFiles.map((file, i) => {
		const url = URL.createObjectURL(file);
		return `<div class="relative w-20 h-20 rounded-lg overflow-hidden bg-gray-100">
			<img src="${url}" alt="" class="w-full h-full object-cover">
			<button type="button" onclick="communityComposerRemoveImage(${i})" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/50 text-white flex items-center justify-center text-xs hover:bg-black/70">✕</button>
		</div>`;
	}).join('');
}

function communityComposerRemoveImage(index) {
	communityComposerFiles.splice(index, 1);
	communityComposerRenderPreviews();
	communityComposerAutoGrow(document.getElementById('community-composer-input'));
}

let communityPostBusy = false;

async function submitCommunityPost() {
	if (communityPostBusy) return;
	const input = document.getElementById('community-composer-input');
	const content = input.value.trim();
	if (!content) return;
	if (!communityCurrentSlug) return;
	const slug = communityCurrentSlug;
	const btn = document.getElementById('community-composer-post-btn');
	communityPostBusy = true;
	btn.disabled = true;
	try {
		const post = await communityApi.createPost(slug, content, communityComposerFiles);
		if (slug !== communityCurrentSlug) return;

		// Prepend the new post to the list
		const list = document.getElementById('community-posts-list');
		const empty = document.getElementById('community-posts-empty');
		if (empty.classList.contains('flex')) {
			empty.classList.add('hidden');
			empty.classList.remove('flex');
		}
		list.insertAdjacentHTML('afterbegin', buildPostCardHtml(post));
		communityPostsItems.unshift(post);

		// Clear composer
		input.value = '';
		communityComposerFiles = [];
		communityComposerRenderPreviews();
		communityComposerAutoGrow(input);
	} catch (e) {
		showToast(e.message || 'Could not post. Try again.');
	} finally {
		communityPostBusy = false;
		communityComposerAutoGrow(input);
	}
}

// ---- Community browse / discovery ----
// Directory backed by GET /api/communities. Newest first, keyset paginated
// via an opaque next_cursor; `communityBrowseQuery` is the committed query
// (debounced from the input). Private communities are excluded server-side.

const COMMUNITY_BROWSE_PAGE = 20;
let communityBrowseQuery = '';
let communityBrowseItems = [];
let communityBrowseCursor = null;
let communityBrowseToken = 0;
let communityBrowseLoading = false;
let communityBrowseTimer = null;
let communityBrowseJoining = new Set();

function openCommunityBrowseView() {
	communityBrowseQuery = '';
	communityBrowseItems = [];
	communityBrowseCursor = null;
	document.getElementById('community-browse-input').value = '';
	showView('community-browse');
	communityBrowseLoad(true);
}

function closeCommunityBrowseView() {
	showView('feed');
}

function communityBrowseOnInput(value) {
	clearTimeout(communityBrowseTimer);
	communityBrowseTimer = setTimeout(() => {
		const q = value.trim();
		if (q === communityBrowseQuery) return;
		communityBrowseQuery = q;
		communityBrowseLoad(true);
	}, 300);
}

function communityBrowseSetState(state, detail) {
	const show = (id, on, flex) => {
		const el = document.getElementById(id);
		el.classList.toggle('hidden', !on);
		if (flex) el.classList.toggle('flex', on);
	};
	show('community-browse-loading', state === 'loading');
	show('community-browse-empty', state === 'empty', true);
	show('community-browse-error', state === 'error', true);
	if (state === 'error') document.getElementById('community-browse-error-detail').textContent = detail || 'Check your connection and try again.';
}

function communityRowActionHtml(c) {
	const m = c.membership || {};
	if (m.role === 'creator') return '<span class="shrink-0 text-[12px] font-semibold text-gray-400 px-2">Yours</span>';
	if (m.is_member) return '<span class="shrink-0 text-[13px] font-semibold text-gray-500 px-2 flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"></path></svg>Joined</span>';
	if (c.type === 'restricted') return '<span class="shrink-0 text-[12px] font-semibold text-gray-400 px-2">Invite only</span>';
	const busy = communityBrowseJoining.has(c.slug);
	return `<button type="button" class="community-browse-join shrink-0 h-8 px-4 rounded-full bg-brand-red text-white text-[13px] font-semibold disabled:opacity-40 active:scale-[0.98] transition-transform duration-100" data-slug="${escapeHtml(c.slug)}" ${busy ? 'disabled' : ''}>Join</button>`;
}

function communityRowHtml(c) {
	const count = `${communityFormatCount(c.member_count || 0)} member${c.member_count === 1 ? '' : 's'}`;
	return `<li class="flex items-center gap-3 px-4 py-3">
		<button type="button" class="community-row-open flex-1 min-w-0 flex items-center gap-3 text-left" data-slug="${escapeHtml(c.slug)}">
			<span class="w-11 h-11 rounded-xl ${escapeHtml(c.icon_bg || 'bg-gray-100')} flex items-center justify-center text-xl shrink-0">${escapeHtml(c.icon_emoji || '👥')}</span>
			<span class="flex-1 min-w-0">
				<span class="block text-[15px] font-bold text-gray-900 truncate">${escapeHtml(c.name)}</span>
				<span class="block text-[13px] text-gray-500 truncate">${count}${c.description ? ' · ' + escapeHtml(c.description) : ''}</span>
			</span>
		</button>
		${communityRowActionHtml(c)}
	</li>`;
}

function communityBrowseRender() {
	document.getElementById('community-browse-list').innerHTML = communityBrowseItems.map(communityRowHtml).join('');
	document.getElementById('community-browse-more').classList.toggle('hidden', !communityBrowseCursor);
}

// reset=true: fresh first page for the current query. false: next page.
async function communityBrowseLoad(reset) {
	if (communityBrowseLoading && !reset) return;
	if (!reset && !communityBrowseCursor) return;
	const token = ++communityBrowseToken;
	communityBrowseLoading = true;
	const more = document.getElementById('community-browse-more');
	if (reset) {
		communityBrowseItems = [];
		communityBrowseCursor = null;
		document.getElementById('community-browse-list').innerHTML = '';
		more.classList.add('hidden');
		communityBrowseSetState('loading');
	} else {
		more.disabled = true;
		more.textContent = 'Loading…';
	}
	try {
		const page = await communityApi.browse(communityBrowseQuery, reset ? null : communityBrowseCursor, COMMUNITY_BROWSE_PAGE);
		if (token !== communityBrowseToken) return;
		const seen = new Set(communityBrowseItems.map(c => c.slug));
		communityBrowseItems = communityBrowseItems.concat(page.communities.filter(c => !seen.has(c.slug)));
		communityBrowseCursor = page.next_cursor;
		if (!communityBrowseItems.length) {
			const q = communityBrowseQuery;
			document.getElementById('community-browse-empty-title').textContent = q ? 'No matching communities' : 'No communities yet';
			document.getElementById('community-browse-empty-detail').textContent = q ? `Nothing found for "${q}".` : 'Be the first to start one.';
			communityBrowseSetState('empty');
		} else {
			communityBrowseSetState('list');
		}
		communityBrowseRender();
	} catch (e) {
		if (token !== communityBrowseToken) return;
		if (reset || !communityBrowseItems.length) {
			communityBrowseSetState('error', e.message);
		} else {
			showToast(e.message || "Couldn't load more communities.");
			communityBrowseRender();
		}
	} finally {
		if (token === communityBrowseToken) {
			communityBrowseLoading = false;
			more.disabled = false;
			more.textContent = 'Show more';
		}
	}
}

// Replace a cached row with fresh server data (e.g. after join/leave elsewhere).
function communityBrowseSyncItem(community) {
	const i = communityBrowseItems.findIndex(c => c.slug === community.slug);
	if (i === -1) return;
	communityBrowseItems[i] = community;
	communityBrowseRender();
}

async function communityBrowseJoin(slug) {
	if (communityBrowseJoining.has(slug)) return;
	communityBrowseJoining.add(slug);
	communityBrowseRender();
	try {
		const community = await communityApi.setMembership(slug, true);
		communityBrowseJoining.delete(slug);
		communityBrowseSyncItem(community);
		showToast(`Joined ${community.name}`);
		refreshSideNavCommunities();
	} catch (e) {
		communityBrowseJoining.delete(slug);
		communityBrowseRender();
		showToast(e.message || 'Could not join community.');
	}
}

document.getElementById('community-browse-list').addEventListener('click', function(e) {
	const joinBtn = e.target.closest('.community-browse-join');
	if (joinBtn) { communityBrowseJoin(joinBtn.dataset.slug); return; }
	const row = e.target.closest('.community-row-open');
	if (row) openCommunityView(row.dataset.slug);
});

// ---- Side nav wiring ----
// The side nav's "Your Communities" rows come from GET /api/communities/mine
// (templates/partials/side_nav.html holds only the container). Rows are
// re-fetched whenever the drawer opens and after create/join/leave.

const sideNavFavoriteSlugs = new Set(); // in-memory only, survives re-renders
let sideNavCommunitiesToken = 0;

function communitySideNavOpen(slug) {
	closeSideNav();
	openCommunityView(slug);
}

function sideNavCommunityRowHtml(c) {
	const slug = escapeHtml(c.slug);
	const label = escapeHtml(c.name);
	const fav = sideNavFavoriteSlugs.has(c.slug);
	return `<div class="w-full flex items-center gap-1 pl-3 pr-2 py-1 rounded-xl">
		<button type="button" class="flex-1 min-w-0 flex items-center gap-3 py-2 text-left" data-community-slug="${slug}" onclick="communitySideNavOpen(this.dataset.communitySlug)">
			<span class="w-7 h-7 rounded-full ${escapeHtml(c.icon_bg || 'bg-gray-100')} flex items-center justify-center text-sm shrink-0">${escapeHtml(c.icon_emoji || '👥')}</span>
			<span class="flex-1 min-w-0 text-[15px] font-medium text-gray-700 truncate">${label}</span>
		</button>
		<button type="button" class="side-nav-star-btn shrink-0 p-2 ${fav ? 'text-yellow-400' : 'text-gray-300'}" data-community-slug="${slug}" onclick="toggleSideNavStar(this)" aria-pressed="${fav}" aria-label="Favorite ${label}">
			<svg class="w-4 h-4" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
				<path d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.98 21.539a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" stroke-linecap="round" stroke-linejoin="round"></path>
			</svg>
		</button>
	</div>`;
}

async function refreshSideNavCommunities() {
	const container = document.getElementById('side-nav-communities-rows');
	if (!container) return;
	const token = ++sideNavCommunitiesToken;
	const note = (text) => `<p class="px-3 py-2 text-[13px] text-gray-400">${escapeHtml(text)}</p>`;
	try {
		const communities = await communityApi.listMine();
		if (token !== sideNavCommunitiesToken) return;
		container.innerHTML = communities.length
			? communities.map(sideNavCommunityRowHtml).join('')
			: note("You haven't joined any communities");
	} catch (e) {
		if (token !== sideNavCommunitiesToken) return;
		container.innerHTML = e.status === 401
			? note('Log in to see your communities')
			: note("Couldn't load your communities");
	}
}
