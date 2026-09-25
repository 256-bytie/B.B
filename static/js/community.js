// ---- Communities ----
//
// Frontend contract this file is written against (not yet implemented on
// the server - see COMMUNITY_BACKEND_PROMPT.md for the exact spec to hand
// to Claude Code):
//   GET    /api/communities/mine
//   POST   /api/communities                body: {name, description, topic, type}
//   GET    /api/communities/<slug>
//   POST   /api/communities/<slug>/join
//   POST   /api/communities/<slug>/leave
//   GET    /api/communities/<slug>/posts?cursor=&limit=
//   POST   /api/communities/<slug>/posts   body: {content}
//
// None of those routes exist yet. `communityApi` below tries the real
// endpoint first and falls back to an in-memory mock (COMMUNITY_MOCK_DB)
// only on a network error or a 404, so this screen is usable today and
// silently starts using live data the moment the backend ships - no
// frontend change needed at that point. This mirrors the reference
// screenshots: b/campus rendered once as a member (Joined) and once as
// the creator (Manage) is the same mock community: `campus`.

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

const COMMUNITY_TYPES = [
	{ value: 'public', label: 'Public', desc: 'Anyone can search for, view, and contribute to this community.', icon: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0zM3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 000 18M12.5 3a17 17 0 010 18' },
	{ value: 'restricted', label: 'Restricted', desc: 'Anyone can view, but only approved members can contribute.', icon: 'M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178zM15 12a3 3 0 11-6 0 3 3 0 016 0z' },
	{ value: 'private', label: 'Private', desc: 'Only approved members can view and contribute.', icon: 'M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z' }
];

// ---- Mock data (used only until the real endpoints exist - see header) ----

const COMMUNITY_MOCK_DB = {
	campus: {
		id: 'campus', slug: 'campus', name: 'campus', topic: 'student-life', type: 'public',
		icon_emoji: '🏛️', icon_bg: 'bg-red-100',
		description: 'University life, events, discussions and anything campus related.',
		member_count: 12400, created_at: '2025-11-02T00:00:00Z',
		membership: { is_member: true, role: 'creator' },
		posts: [
			{ id: 'p1', author: 'Jide_23', avatar_seed: 'Jide_23', content: "Anyone know where I can get past question papers for RAD 352? Preferably for the last 3 years.", created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }
		]
	},
	housing: {
		id: 'housing', slug: 'housing', name: 'housing', topic: 'discussion', type: 'public',
		icon_emoji: '🌱', icon_bg: 'bg-teal-50',
		description: 'Off-campus housing leads, roommate matching, and landlord warnings.',
		member_count: 3820, created_at: '2025-09-14T00:00:00Z',
		membership: { is_member: true, role: 'member' },
		posts: []
	},
	oldschoolcool: {
		id: 'oldschoolcool', slug: 'oldschoolcool', name: 'oldschoolcool', topic: 'discussion', type: 'public',
		icon_emoji: '🎓', icon_bg: 'bg-gray-100',
		description: 'Throwback photos and stories from campus, decades back.',
		member_count: 967, created_at: '2025-06-01T00:00:00Z',
		membership: { is_member: true, role: 'member' },
		posts: []
	}
};

// ---- Data layer: real endpoint first, mock fallback on network error / 404 ----

const communityApi = {
	async _tryReal(fn) {
		try {
			return await fn();
		} catch (e) {
			return { __unavailable: true };
		}
	},

	async get(slug) {
		const real = await this._tryReal(async () => {
			const res = await fetch(`/api/communities/${encodeURIComponent(slug)}`);
			if (res.status === 404) return { __unavailable: true };
			if (!res.ok) throw new Error('request failed');
			return await res.json();
		});
		if (!real.__unavailable) return real;
		const mock = COMMUNITY_MOCK_DB[slug];
		return mock ? { ...mock } : null;
	},

	async listMine() {
		const real = await this._tryReal(async () => {
			const res = await fetch('/api/communities/mine');
			if (!res.ok) throw new Error('request failed');
			return await res.json();
		});
		if (!real.__unavailable) return real.communities || [];
		return Object.values(COMMUNITY_MOCK_DB).filter(c => c.membership && c.membership.is_member);
	},

	async create(payload) {
		const res = await apiFetch('/api/communities', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (res.ok) return await res.json();
		if (res.status === 404) {
			// Backend not built yet - create it locally so the rest of the
			// app (side nav, the detail screen) has somewhere to land.
			const slug = payload.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || `community${Date.now()}`;
			const topic = COMMUNITY_TOPICS.find(t => t.key === payload.topic);
			const community = {
				id: slug, slug, name: payload.name, topic: payload.topic || 'discussion', type: payload.type,
				icon_emoji: '🆕', icon_bg: 'bg-gray-100',
				description: payload.description, member_count: 1, created_at: new Date().toISOString(),
				membership: { is_member: true, role: 'creator' }, posts: []
			};
			COMMUNITY_MOCK_DB[slug] = community;
			return { ...community };
		}
		let message = 'Could not create community.';
		try { const data = await res.json(); if (data && data.error) message = data.error; } catch (e) {}
		throw new Error(message);
	},

	async setMembership(slug, join) {
		const path = join ? 'join' : 'leave';
		const res = await this._tryReal(async () => {
			const r = await apiFetch(`/api/communities/${encodeURIComponent(slug)}/${path}`, { method: 'POST' });
			if (!r.ok) throw new Error('request failed');
			return await r.json();
		});
		const mock = COMMUNITY_MOCK_DB[slug];
		if (mock) {
			const wasMember = mock.membership.is_member;
			mock.membership.is_member = join;
			if (mock.membership.role === null && join) mock.membership.role = 'member';
			mock.member_count += (join && !wasMember) ? 1 : (!join && wasMember ? -1 : 0);
		}
		return real => real;
	},

	async listPosts(slug) {
		const real = await this._tryReal(async () => {
			const res = await fetch(`/api/communities/${encodeURIComponent(slug)}/posts`);
			if (!res.ok) throw new Error('request failed');
			return await res.json();
		});
		if (!real.__unavailable) return real.posts || [];
		const mock = COMMUNITY_MOCK_DB[slug];
		return mock ? mock.posts : [];
	},

	async createPost(slug, content) {
		const res = await this._tryReal(async () => {
			const r = await apiFetch(`/api/communities/${encodeURIComponent(slug)}/posts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content })
			});
			if (!r.ok) throw new Error('request failed');
			return await r.json();
		});
		if (!real.__unavailable) return real;
		const mock = COMMUNITY_MOCK_DB[slug];
		const handle = (typeof session !== 'undefined' && session && session.user) ? (session.user.username || session.user.email.split('@')[0]) : 'you';
		const post = { id: `local-${Date.now()}`, author: handle, avatar_seed: handle, content, created_at: new Date().toISOString() };
		if (mock) mock.posts.unshift(post);
		return post;
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
	list.innerHTML = COMMUNITY_TYPES.map(t => {
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

const COMMUNITY_RETURN_VIEWS = ['feed', 'courses', 'library', 'businesses', 'search', 'chat', 'profile', 'user-profile', 'wallet'];
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
	showView(communityReturnView || 'feed');
}

async function loadCommunityView() {
	if (!communityCurrentSlug) return;
	const token = ++communityLoadToken;
	document.getElementById('community-error').classList.add('hidden');
	document.getElementById('community-content').classList.add('hidden');
	try {
		const community = await communityApi.get(communityCurrentSlug);
		if (token !== communityLoadToken) return;
		if (!community) throw new Error('not found');
		communityCurrentData = community;
		renderCommunityHeader(community);
		document.getElementById('community-content').classList.remove('hidden');
		switchCommunityTab('posts');
	} catch (e) {
		if (token !== communityLoadToken) return;
		document.getElementById('community-error').classList.remove('hidden');
	}
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
	document.getElementById('community-topbar-title').textContent = `b/${community.name}`;
	document.getElementById('community-name').textContent = `b/${community.name}`;
	document.getElementById('community-description').textContent = community.description || '';
	document.getElementById('community-member-count').querySelector('span').textContent = `${communityFormatCount(community.member_count || 0)} members`;

	const typeMeta = COMMUNITY_TYPES.find(t => t.value === community.type);
	document.getElementById('community-meta').textContent = typeMeta ? typeMeta.label : 'Public';

	const iconEl = document.getElementById('community-icon');
	iconEl.className = `w-16 h-16 -mt-11 rounded-2xl border-[3px] border-white shadow-sm flex items-center justify-center text-2xl shrink-0 ${community.icon_bg || 'bg-gray-100'}`;
	iconEl.textContent = community.icon_emoji || '👥';

	document.getElementById('community-banner-icon').innerHTML = `<path d="${communityTopicIcon(community.topic)}" stroke-linecap="round" stroke-linejoin="round"></path>`;

	const role = community.membership ? community.membership.role : null;
	const isMember = community.membership ? community.membership.is_member : false;
	const actionBtn = document.getElementById('community-action-btn');
	if (role === 'creator' || role === 'moderator') {
		actionBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.375.185.72.415 1.035.68l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.43l-1.004.828a6.9 6.9 0 010 1.226l1.004.828c.424.35.534.954.26 1.43l-1.297 2.247a1.125 1.125 0 01-1.369.49l-1.217-.456c-.315.265-.66.495-1.035.68l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281a5.85 5.85 0 01-1.035-.68l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.43l1.004-.828a6.9 6.9 0 010-1.226l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.49l1.216.456c.315-.265.66-.495 1.035-.68l.214-1.28z" stroke-linecap="round" stroke-linejoin="round"></path><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke-linecap="round" stroke-linejoin="round"></path></svg> Manage`;
		actionBtn.dataset.mode = 'manage';
	} else if (isMember) {
		actionBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"></path></svg> Joined`;
		actionBtn.dataset.mode = 'leave';
	} else {
		actionBtn.innerHTML = 'Join';
		actionBtn.dataset.mode = 'join';
	}

	document.getElementById('community-about-description').textContent = community.description || '';
	document.getElementById('community-about-type').textContent = typeMeta ? `${typeMeta.label} — ${typeMeta.desc}` : '';
	document.getElementById('community-about-created').textContent = community.created_at ? new Date(community.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';

	if (typeof session !== 'undefined' && session && session.user) {
		const handle = session.user.username || (session.user.email ? session.user.email.split('@')[0] : '');
		document.getElementById('community-composer-avatar').src = session.user.profile_picture || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
	}
	document.getElementById('community-composer-input').value = '';
	document.getElementById('community-composer-post-btn').disabled = true;
}

async function communityHandleActionBtn() {
	if (!communityCurrentData) return;
	const mode = document.getElementById('community-action-btn').dataset.mode;
	if (mode === 'manage') {
		showToast('Coming soon');
		return;
	}
	const join = mode === 'join';
	await communityApi.setMembership(communityCurrentSlug, join);
	communityCurrentData.membership.is_member = join;
	if (join && !communityCurrentData.membership.role) communityCurrentData.membership.role = 'member';
	communityCurrentData.member_count += join ? 1 : -1;
	renderCommunityHeader(communityCurrentData);
	showToast(join ? `Joined b/${communityCurrentData.name}` : `Left b/${communityCurrentData.name}`);
}

function switchCommunityTab(tab) {
	document.querySelectorAll('.community-tab').forEach(btn => {
		const active = btn.dataset.tab === tab;
		btn.classList.toggle('border-red-500', active);
		btn.classList.toggle('text-red-500', active);
		btn.classList.toggle('font-semibold', active);
		btn.classList.toggle('border-transparent', !active);
		btn.classList.toggle('text-gray-500', !active);
		btn.classList.toggle('font-medium', !active);
	});
	document.querySelectorAll('.community-panel').forEach(panel => panel.classList.add('hidden'));
	document.getElementById(`community-panel-${tab}`).classList.remove('hidden');
	if (tab === 'posts') loadCommunityPosts();
}

async function loadCommunityPosts() {
	const list = document.getElementById('community-posts-list');
	const loading = document.getElementById('community-posts-loading');
	const empty = document.getElementById('community-posts-empty');
	loading.classList.remove('hidden');
	empty.classList.add('hidden');
	list.innerHTML = '';
	const posts = await communityApi.listPosts(communityCurrentSlug);
	loading.classList.add('hidden');
	if (!posts.length) {
		empty.classList.remove('hidden');
		empty.classList.add('flex');
		return;
	}
	list.innerHTML = posts.map(communityBuildPostRowHtml).join('');
}

function communityBuildPostRowHtml(post) {
	const avatarUrl = `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(post.avatar_seed || post.author)}`;
	return `<li class="flex gap-3 px-4 py-3.5">
		<img src="${escapeHtml(avatarUrl)}" alt="" class="w-9 h-9 rounded-full object-cover bg-gray-100 shrink-0">
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-2">
				<span class="text-[14px] font-semibold text-gray-900 truncate">${escapeHtml(post.author)}</span>
				<span class="text-[13px] text-gray-400 shrink-0">${escapeHtml(communityRelativeTime(post.created_at))}</span>
			</div>
			<p class="text-[14px] text-gray-800 leading-relaxed mt-0.5 whitespace-pre-line">${escapeHtml(post.content)}</p>
		</div>
	</li>`;
}

function communityRelativeTime(iso) {
	const diffMs = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diffMs / 60000);
	if (mins < 1) return 'now';
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function communityComposerAutoGrow(el) {
	el.style.height = '40px';
	el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	document.getElementById('community-composer-post-btn').disabled = el.value.trim().length === 0;
}

async function submitCommunityPost() {
	const input = document.getElementById('community-composer-input');
	const content = input.value.trim();
	if (!content || !communityCurrentSlug) return;
	const btn = document.getElementById('community-composer-post-btn');
	btn.disabled = true;
	try {
		await communityApi.createPost(communityCurrentSlug, content);
		input.value = '';
		input.style.height = '40px';
		loadCommunityPosts();
	} catch (e) {
		showToast('Could not post. Try again.');
		btn.disabled = false;
	}
}

// ---- Side nav wiring ----
// Replaces the "Coming soon" stubs on the side nav's Communities section
// (templates/partials/side_nav.html) with real navigation. The row markup
// itself stays static for now (three seeded mock communities); only the
// click targets change here so this stays a minimal, isolated diff.

function communitySideNavOpen(slug) {
	closeSideNav();
	openCommunityView(slug);
}
