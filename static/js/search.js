// ---- Global Search ----
// State machine: 'idle' (fresh open, nothing typed yet) -> 'typing'
// (input focused/edited - shows recent+trending, or live suggestions
// once there's text) -> 'results' (a query was submitted - tabs +
// result list, or the no-results state). Driven only by explicit
// events (focus, input, submit, clear, back) - no blur-based
// auto-revert, since a blur fires before a tap on a suggestion/history
// row finishes registering and would race it.

let searchReturnView = 'feed';
let searchState = 'idle';
let searchCurrentTab = 'all';
let searchLastQuery = '';
let searchDebounceTimer = null;
let searchPostsNextCursor = null;
let searchPostsLoadingMore = false;
let searchHistoryCache = [];
let searchTrendingCache = [];

// Curated fallback shown only for accounts with no search history yet -
// tied to Beebo's actual content taxonomy (library categories, feed
// audiences) so a tap is likely to surface something real rather than
// being a purely decorative placeholder.
const SEARCH_POPULAR_TERMS = ['Past questions', 'Study group', 'Assignments', 'GPA calculator', 'Announcements'];

function initSearchView() {
	const activeEl = document.querySelector('.view-section.active');
	const activeViewName = activeEl ? activeEl.id.replace('-view', '') : 'feed';
	if (activeViewName !== 'search') {
		searchReturnView = activeViewName;
	}

	const input = document.getElementById('search-input');
	if (input) input.value = '';
	const clearBtn = document.getElementById('search-clear-btn');
	if (clearBtn) clearBtn.classList.add('hidden');

	searchState = 'idle';
	searchCurrentTab = 'all';
	searchLastQuery = '';
	searchPostsNextCursor = null;
	setActiveSearchTab('all');
	const tabsRow = document.getElementById('search-tabs-row');
	if (tabsRow) tabsRow.classList.add('hidden');
	showSearchSection('empty');
	loadSearchHistoryAndTrending();

	// Slight delay so the view is actually visible/laid out before
	// stealing focus (avoids a jump on some mobile browsers when
	// focusing an element in a container that's mid-transition-in).
	setTimeout(() => { if (input) input.focus(); }, 50);
}

function closeSearchView() {
	showView(searchReturnView || 'feed');
}

function showSearchSection(name) {
	const sections = {
		empty: 'search-empty-state',
		historyPopular: 'search-history-popular',
		suggestions: 'search-suggestions-list',
		results: 'search-results',
		noResults: 'search-no-results'
	};
	Object.values(sections).forEach(function(id) {
		const el = document.getElementById(id);
		if (el) el.classList.add('hidden');
	});
	const targetId = sections[name];
	if (targetId) {
		const el = document.getElementById(targetId);
		if (el) el.classList.remove('hidden');
	}
}

function setActiveSearchTab(tab) {
	document.querySelectorAll('.search-tab-btn').forEach(function(btn) {
		const isActive = btn.dataset.tab === tab;
		btn.classList.toggle('text-red-500', isActive);
		btn.classList.toggle('font-semibold', isActive);
		btn.classList.toggle('border-red-500', isActive);
		btn.classList.toggle('text-gray-500', !isActive);
		btn.classList.toggle('font-medium', !isActive);
		btn.classList.toggle('border-transparent', !isActive);
	});
}

// ---- Recent searches + trending topics (loaded once per view-open) ----
async function loadSearchHistoryAndTrending() {
	try {
		const [histRes, trendRes] = await Promise.all([
			fetch('/api/search/history'),
			fetch('/api/search/trending')
		]);
		searchHistoryCache = histRes.ok ? (await histRes.json()).history : [];
		searchTrendingCache = trendRes.ok ? (await trendRes.json()).topics : [];
	} catch (e) {
		searchHistoryCache = [];
		searchTrendingCache = [];
	}
	renderHistoryPopular();
}

function renderHistoryPopular() {
	const recentSection = document.getElementById('search-recent-section');
	const trendingSection = document.getElementById('search-trending-section');
	const popularSection = document.getElementById('search-popular-section');
	const recentList = document.getElementById('search-recent-list');
	const trendingChips = document.getElementById('search-trending-chips');
	const popularList = document.getElementById('search-popular-list');
	if (!recentSection || !trendingSection || !popularSection) return;

	if (searchHistoryCache.length > 0) {
		recentSection.classList.remove('hidden');
		popularSection.classList.add('hidden');
		recentList.innerHTML = searchHistoryCache.map(function(h) {
			return `
<div class="flex items-center justify-between" data-history-id="${h.id}">
<button type="button" class="search-history-item flex items-center gap-3 flex-1 min-w-0 py-2.5 text-left" data-query="${escapeHtml(h.query)}">
<i class="fa-regular fa-clock text-gray-400 text-[14px] shrink-0"></i>
<span class="text-[14.5px] text-gray-800 truncate">${escapeHtml(h.query)}</span>
</button>
<button type="button" class="search-history-remove-btn p-2 text-gray-300 hover:text-gray-500 shrink-0" data-history-id="${h.id}" aria-label="Remove from history">
<i class="fa-solid fa-xmark text-[13px]"></i>
</button>
</div>`;
		}).join('');
	} else {
		recentSection.classList.add('hidden');
		popularSection.classList.remove('hidden');
		popularList.innerHTML = SEARCH_POPULAR_TERMS.map(function(term) {
			return `
<button type="button" class="search-popular-item flex items-center gap-3 w-full py-2.5 text-left" data-query="${escapeHtml(term)}">
<i class="fa-solid fa-arrow-trend-up text-gray-400 text-[13px] shrink-0"></i>
<span class="text-[14.5px] text-gray-800 truncate">${escapeHtml(term)}</span>
</button>`;
		}).join('');
	}

	if (searchTrendingCache.length > 0) {
		trendingSection.classList.remove('hidden');
		trendingChips.innerHTML = searchTrendingCache.map(function(t) {
			return `<button type="button" class="search-trending-chip bg-gray-50 text-gray-800 px-3 py-1.5 rounded-full text-[13.5px] font-medium" data-query="#${escapeHtml(t.tag)}">#${escapeHtml(t.tag)}</button>`;
		}).join('');
	} else {
		trendingSection.classList.add('hidden');
	}
}

// ---- Typeahead suggestions ----
async function fetchSearchSuggestions(q) {
	try {
		const res = await fetch(`/api/search/suggestions?q=${encodeURIComponent(q)}`);
		if (!res.ok) return;
		const data = await res.json();
		// Guard against a slow response landing after the input changed again.
		if (document.getElementById('search-input').value.trim() !== q) return;
		renderSearchSuggestions(data.suggestions || []);
	} catch (e) {
		// Silent - suggestions are best-effort; Enter still submits the raw text.
	}
}

function renderSearchSuggestions(list) {
	const container = document.getElementById('search-suggestions-list');
	if (!container) return;
	if (list.length === 0) {
		container.innerHTML = '';
		return;
	}
	container.innerHTML = list.map(function(item) {
		const label = item.type === 'person' ? (item.label || item.text) : item.text;
		const icon = item.type === 'topic' ? 'fa-hashtag' : 'fa-user';
		return `
<button type="button" class="search-suggestion-item flex items-center justify-between w-full px-4 py-3 text-left active:bg-gray-50" data-query="${escapeHtml(item.text)}">
<span class="flex items-center gap-3 min-w-0">
<i class="fa-solid ${icon} text-gray-400 text-[13px] shrink-0"></i>
<span class="text-[14.5px] text-gray-800 truncate">${escapeHtml(label)}</span>
</span>
<i class="fa-solid fa-arrow-up-left text-gray-300 text-[12px] shrink-0"></i>
</button>`;
	}).join('');
}

// ---- Submitting a search ----
async function submitSearch(rawQuery, options) {
	const opts = options || {};
	const query = (rawQuery || '').trim();
	if (!query) return;

	const input = document.getElementById('search-input');
	if (input) input.value = query;
	const clearBtn = document.getElementById('search-clear-btn');
	if (clearBtn) clearBtn.classList.remove('hidden');

	searchLastQuery = query;
	if (opts.tab) searchCurrentTab = opts.tab;
	setActiveSearchTab(searchCurrentTab);

	const tabsRow = document.getElementById('search-tabs-row');
	if (tabsRow) tabsRow.classList.remove('hidden');

	searchState = 'results';
	if (input) input.blur();

	if (opts.recordHistory !== false) {
		apiFetch('/api/search/history', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: query })
		}).catch(function() {});
	}

	await runSearch();
}

async function runSearch() {
	searchPostsNextCursor = null;
	const params = new URLSearchParams({ q: searchLastQuery, type: searchCurrentTab });
	try {
		const res = await fetch(`/api/search?${params.toString()}`);
		if (!res.ok) throw new Error('Search failed');
		const data = await res.json();
		renderSearchResults(data);
	} catch (e) {
		document.getElementById('search-no-results-text').textContent = 'Something went wrong. Please try again.';
		showSearchSection('noResults');
	}
}

function buildSearchPersonRowHtml(user) {
	const handle = user.handle || user.username || '';
	const avatarUrl = user.profile_picture || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
	const name = escapeHtml(user.full_name || '');
	const bioSuffix = user.bio ? ` · ${escapeHtml(user.bio)}` : '';
	return `
<button type="button" class="search-person-row flex items-center gap-3 w-full py-2.5 text-left" data-user-id="${user.id}" data-user-name="${name}" data-user-handle="${escapeHtml(handle)}" data-user-avatar="${escapeHtml(user.profile_picture || '')}">
<img src="${avatarUrl}" alt="${name}" class="w-11 h-11 rounded-full object-cover bg-gray-100 shrink-0">
<div class="flex-1 min-w-0">
<p class="text-[14.5px] font-bold text-gray-900 truncate">${name}</p>
<p class="text-[13px] text-gray-500 truncate">@${escapeHtml(handle)}${bioSuffix}</p>
</div>
<i class="fa-solid fa-chevron-right text-gray-300 text-[12px] shrink-0"></i>
</button>`;
}

function buildSearchTopicRowHtml(topic) {
	const tag = escapeHtml(topic.tag);
	return `
<button type="button" class="search-topic-row flex items-center gap-3 w-full py-2.5 text-left" data-tag="${tag}">
<span class="w-10 h-10 rounded-full bg-red-50 text-brand-red flex items-center justify-center shrink-0 font-bold text-[15px]">#</span>
<div class="flex-1 min-w-0">
<p class="text-[14.5px] font-bold text-gray-900 truncate">#${tag}</p>
<p class="text-[13px] text-gray-500">${topic.post_count} post${topic.post_count === 1 ? '' : 's'}</p>
</div>
<i class="fa-solid fa-chevron-right text-gray-300 text-[12px] shrink-0"></i>
</button>`;
}

function renderSearchResults(data) {
	const hasPeople = Array.isArray(data.people) && data.people.length > 0;
	const hasTopics = Array.isArray(data.topics) && data.topics.length > 0;
	const hasPosts = Array.isArray(data.posts) && data.posts.length > 0;

	if (!hasPeople && !hasTopics && !hasPosts) {
		document.getElementById('search-no-results-text').textContent =
			`We couldn't find anything for "${data.query}". Try a different keyword or check your spelling.`;
		showSearchSection('noResults');
		return;
	}

	showSearchSection('results');

	const peopleSection = document.getElementById('search-results-people');
	if (data.people !== undefined) {
		peopleSection.classList.toggle('hidden', !hasPeople);
		document.getElementById('search-people-list').innerHTML = hasPeople ? data.people.map(buildSearchPersonRowHtml).join('') : '';
		peopleSection.querySelector('.search-see-all-btn').classList.toggle('hidden', !(searchCurrentTab === 'all' && data.people.length >= 3));
	} else {
		peopleSection.classList.add('hidden');
	}

	const topicsSection = document.getElementById('search-results-topics');
	if (data.topics !== undefined) {
		topicsSection.classList.toggle('hidden', !hasTopics);
		document.getElementById('search-topics-list').innerHTML = hasTopics ? data.topics.map(buildSearchTopicRowHtml).join('') : '';
		topicsSection.querySelector('.search-see-all-btn').classList.toggle('hidden', !(searchCurrentTab === 'all' && data.topics.length >= 4));
	} else {
		topicsSection.classList.add('hidden');
	}

	const postsHeading = document.getElementById('search-posts-heading');
	const postsContainer = document.getElementById('search-posts-container');
	if (data.posts !== undefined) {
		postsContainer.innerHTML = hasPosts ? data.posts.map(buildPostCardHtml).join('') : '';
		postsHeading.classList.toggle('hidden', !(searchCurrentTab === 'all' && hasPosts));
		searchPostsNextCursor = data.next_cursor || null;
	} else {
		postsContainer.innerHTML = '';
		postsHeading.classList.add('hidden');
		searchPostsNextCursor = null;
	}
}

async function loadMoreSearchPosts() {
	if (searchPostsLoadingMore || !searchPostsNextCursor || searchCurrentTab !== 'posts') return;
	searchPostsLoadingMore = true;
	const loadingRow = document.getElementById('search-posts-loading-more');
	if (loadingRow) loadingRow.classList.remove('hidden');

	try {
		const params = new URLSearchParams({ q: searchLastQuery, type: 'posts', cursor: searchPostsNextCursor });
		const res = await fetch(`/api/search?${params.toString()}`);
		if (res.ok) {
			const data = await res.json();
			if (data.posts && data.posts.length > 0) {
				document.getElementById('search-posts-container').insertAdjacentHTML('beforeend', data.posts.map(buildPostCardHtml).join(''));
			}
			searchPostsNextCursor = data.next_cursor;
		}
	} catch (e) {
		// Leave the cursor as-is; the next scroll event retries.
	} finally {
		searchPostsLoadingMore = false;
		if (loadingRow) loadingRow.classList.add('hidden');
	}
}

// ---- Wire up interactions ----
(function initSearchInteractions() {
	const input = document.getElementById('search-input');
	const clearBtn = document.getElementById('search-clear-btn');
	const body = document.getElementById('search-body');
	const historyPopular = document.getElementById('search-history-popular');
	const suggestionsList = document.getElementById('search-suggestions-list');
	const resultsEl = document.getElementById('search-results');
	const tabsRow = document.getElementById('search-tabs-row');
	if (!input || !body) return;

	input.addEventListener('focus', function() {
		if (searchState === 'typing') return;
		searchState = 'typing';
		if (tabsRow) tabsRow.classList.add('hidden');
		const val = input.value.trim();
		if (val) {
			showSearchSection('suggestions');
			fetchSearchSuggestions(val);
		} else {
			showSearchSection('historyPopular');
		}
	});

	input.addEventListener('input', function() {
		const val = input.value;
		if (clearBtn) clearBtn.classList.toggle('hidden', val.length === 0);
		searchState = 'typing';
		if (tabsRow) tabsRow.classList.add('hidden');

		const trimmed = val.trim();
		clearTimeout(searchDebounceTimer);
		if (!trimmed) {
			showSearchSection('historyPopular');
			return;
		}
		showSearchSection('suggestions');
		searchDebounceTimer = setTimeout(function() { fetchSearchSuggestions(trimmed); }, 220);
	});

	input.addEventListener('keydown', function(e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			submitSearch(input.value, { recordHistory: true });
		}
	});

	if (clearBtn) {
		clearBtn.addEventListener('click', function() {
			input.value = '';
			clearBtn.classList.add('hidden');
			searchState = 'typing';
			if (tabsRow) tabsRow.classList.add('hidden');
			showSearchSection('historyPopular');
			input.focus();
		});
	}

	if (suggestionsList) {
		suggestionsList.addEventListener('click', function(e) {
			const item = e.target.closest('.search-suggestion-item');
			if (!item) return;
			submitSearch(item.dataset.query, { recordHistory: true });
		});
	}

	if (historyPopular) {
		historyPopular.addEventListener('click', async function(e) {
			const removeBtn = e.target.closest('.search-history-remove-btn');
			if (removeBtn) {
				e.stopPropagation();
				const id = removeBtn.dataset.historyId;
				const row = removeBtn.closest('[data-history-id]');
				if (row) row.remove();
				searchHistoryCache = searchHistoryCache.filter(function(h) { return String(h.id) !== String(id); });
				if (searchHistoryCache.length === 0) renderHistoryPopular();
				try {
					await apiFetch(`/api/search/history/${id}`, { method: 'DELETE' });
				} catch (err) {}
				return;
			}

			const clearAllBtn = e.target.closest('#search-clear-history-btn');
			if (clearAllBtn) {
				searchHistoryCache = [];
				renderHistoryPopular();
				try {
					await apiFetch('/api/search/history', { method: 'DELETE' });
				} catch (err) {}
				return;
			}

			const historyItem = e.target.closest('.search-history-item');
			if (historyItem) {
				submitSearch(historyItem.dataset.query, { recordHistory: true });
				return;
			}

			const popularItem = e.target.closest('.search-popular-item');
			if (popularItem) {
				submitSearch(popularItem.dataset.query, { recordHistory: true });
				return;
			}

			const trendingChip = e.target.closest('.search-trending-chip');
			if (trendingChip) {
				submitSearch(trendingChip.dataset.query, { recordHistory: true });
			}
		});
	}

	// Tab switching - keeps the same submitted query, just narrows the
	// facet, so it doesn't bump the term's recent-search timestamp again.
	document.querySelectorAll('.search-tab-btn').forEach(function(btn) {
		btn.addEventListener('click', function() {
			const tab = btn.dataset.tab;
			if (tab === searchCurrentTab || !searchLastQuery) return;
			submitSearch(searchLastQuery, { recordHistory: false, tab: tab });
		});
	});

	document.querySelectorAll('.search-see-all-btn').forEach(function(btn) {
		btn.addEventListener('click', function() {
			if (!searchLastQuery) return;
			submitSearch(searchLastQuery, { recordHistory: false, tab: btn.dataset.tabTarget });
		});
	});

	if (resultsEl) {
		resultsEl.addEventListener('click', function(e) {
			const personRow = e.target.closest('.search-person-row');
			if (personRow) {
				openUserProfileView({
					id: personRow.dataset.userId,
					name: personRow.dataset.userName,
					handle: personRow.dataset.userHandle,
					avatar: personRow.dataset.userAvatar || null
				});
				return;
			}

			const topicRow = e.target.closest('.search-topic-row');
			if (topicRow) {
				submitSearch(`#${topicRow.dataset.tag}`, { recordHistory: true, tab: 'posts' });
			}
		});
	}

	// Infinite scroll for the Posts tab only - #search-body is the
	// scrollable element for the whole view (see .view-section rules).
	body.addEventListener('scroll', function() {
		if (body.scrollHeight - body.scrollTop - body.clientHeight < 300) {
			loadMoreSearchPosts();
		}
	});
})();
