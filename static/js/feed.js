// ---- Dynamic Feed Posts ----

// Escape user content before inserting into innerHTML or into a
// double-quoted HTML attribute. div.textContent/innerHTML only escapes
// &, <, > — it leaves " and ' untouched, which corrupts any attribute
// value containing them (e.g. data-post-images="${JSON.stringify(...)}"
// is full of double quotes and gets truncated at the first one).
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Post-level like/comment counters (feed card actions row + the comment
// overlay's matching post header row) show only the icon when a post has
// no interactions yet, and the icon+number once there's at least one -
// used both for the initial render (see the ' hidden' class check inline
// in renderPost's template below) and every live update afterward (a
// like/unlike, a comment posted or deleted) so the two paths can never
// disagree about when the number should be visible. textContent is
// always kept up to date regardless of visibility, since existing code
// elsewhere (rollback-on-error, optimistic-count math) reads it back via
// parseInt - only the 'post-count-empty' class toggles. That class hides
// via visibility (not display), so the span's width stays reserved in
// the layout at 0 - see .post-count-empty in style.css for why.
function setPostCountSpan(span, count) {
    if (!span) return;
    const n = Number(count) || 0;
    span.textContent = n;
    span.classList.toggle('post-count-empty', n < 1);
}

// Truncate a post's raw (unescaped) text to `limit` characters for the
// feed's "See more" preview, backing off to the nearest word boundary so
// words aren't sliced mid-way. Falls back to a hard cut if the nearest
// space is too far back (e.g. one long unbroken token) so the preview
// doesn't shrink to almost nothing.
function truncatePostContent(text, limit) {
    if (text.length <= limit) return text;
    let truncated = text.slice(0, limit);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > limit * 0.6) {
        truncated = truncated.slice(0, lastSpace);
    }
    return truncated.trimEnd();
}

// Compute a human friendly "X ago" string from a SQLite timestamp
// (format: "YYYY-MM-DD HH:MM:SS", assumed UTC since it's CURRENT_TIMESTAMP)
function formatTimeAgo(createdAt) {
    if (!createdAt) return '';
    const isoLike = createdAt.replace(' ', 'T') + 'Z';
    const then = new Date(isoLike);
    if (isNaN(then.getTime())) return '';

    const diffMs = Date.now() - then.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

// Post timestamp formatter: compact relative time ("2h", "8h", "23h") for
// posts under 24h old, "Nd" for posts from 1 to 20 days old, and exact
// "YYYY.MM.DD" date (post's own creation date) beyond that. Used
// everywhere a post's own timestamp is shown (feed card + Post & Comments
// overlay header) — distinct from formatTimeAgo, which still drives
// comment timestamps.
function formatPostTime(createdAt) {
    if (!createdAt) return '';
    const isoLike = createdAt.replace(' ', 'T') + 'Z';
    const then = new Date(isoLike);
    if (isNaN(then.getTime())) return '';

    const diffMs = Date.now() - then.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays <= 20) return `${diffDays}d`;

    const year = then.getFullYear();
    const month = String(then.getMonth() + 1).padStart(2, '0');
    const day = String(then.getDate()).padStart(2, '0');
    return `${year}.${month}.${day}`;
}

// If a post image fails to load (e.g. it was requested a moment before
// the upload fully settled on disk), retry a few times with backoff and
// a cache-busting param instead of leaving the broken-image icon up
// forever. Stops retrying after 3 attempts.
function handlePostImageError(imgEl) {
    const attempts = parseInt(imgEl.dataset.retryCount || '0', 10);
    if (attempts >= 3) return;
    imgEl.dataset.retryCount = String(attempts + 1);
    const baseSrc = imgEl.dataset.baseSrc || imgEl.getAttribute('src');
    imgEl.dataset.baseSrc = baseSrc;
    setTimeout(() => {
        imgEl.src = `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}retry=${Date.now()}`;
    }, 500 * (attempts + 1));
}

// Build image grid markup for a post's attached images (0-4), matching the
// reference card's large rounded media block, placed between the header and
// the post text.
function buildPostImagesHtml(images) {
    if (!images || images.length === 0) return '';

    const count = images.length;
    let gridClass = 'grid-cols-1';
    if (count === 2) gridClass = 'grid-cols-2';
    if (count === 3) gridClass = 'grid-cols-2 grid-rows-2';
    if (count >= 4) gridClass = 'grid-cols-2 grid-rows-2';

    const imgEls = images.map((url, i) => {
        const spanClass = (count === 3 && i === 0) ? 'row-span-2' : '';
        const heightClass = count === 1 ? 'max-h-[420px]' : 'h-full';
        return `<img src="${escapeHtml(url)}" alt="Post attachment" loading="lazy" onerror="handlePostImageError(this)" data-image-index="${i}" class="w-full ${heightClass} object-cover ${spanClass}"/>`;
    }).join('');

    return `<div class="post-card-images grid ${gridClass} gap-0.5 rounded-2xl overflow-hidden mb-3 bg-gray-100 cursor-pointer">${imgEls}</div>`;
}

// Build the markup for a single post row in the flat, full-width timeline
// (border-b divider between rows, no per-post rounding/shadow/background
// card treatment) - shared by the main feed, own-profile Posts tab, and
// another user's profile Posts tab (see postCardContainerIds in
// comments.js). No badge/tag element for untagged posts.
//
// Layout: a fixed-width avatar rail on the left (.feed-card-avatar-rail)
// with name/time/menu, body, images, and actions all in one right-hand
// column - rather than avatar+name+time bunched into a header row above
// full-width content. Same idea as the reference's card structure: the
// avatar anchors to the first line, everything else reads as a single
// aligned column beside it. All existing classes/data-attributes/onclick
// handlers are preserved as-is (see openProfileFromPostCard,
// closest('article[...]') lookups in comments.js/profile-user.js) -
// only the arrangement changed.
function buildPostCardHtml(post) {
    const avatarUrl = post.author_avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(post.author_handle)}`;
    const authorName = escapeHtml(post.author_name);
    const authorHandle = escapeHtml(post.author_handle);
    const content = escapeHtml(post.content);
    const timeAgo = escapeHtml(formatPostTime(post.created_at));
    const likedTextColor = post.liked_by_user ? 'text-brand-red' : 'text-gray-500';

    // Feed preview: long posts are truncated to plain text (rather than
    // CSS line-clamped) so the "See more" button is always part of the
    // rendered content instead of risking being clipped off along with
    // the rest of the overflowing box. Full text lives in
    // data-post-content on the <article> (see below); the truncated
    // preview is stashed on the button itself (data-preview-text) so
    // the toggle in comments.js can flip back and forth between the
    // two without recomputing the truncation client-side.
    const isLong = post.content.length > 220;
    const previewRaw = isLong ? truncatePostContent(post.content, 220) : post.content;
    const previewText = isLong ? escapeHtml(previewRaw) : content;
    // Collapsing back down is always possible for a truncated post, but
    // the "See less" label only shows for posts over 100 words - shorter
    // long posts still collapse on tap, just without the label.
    const wordCount = isLong ? post.content.trim().split(/\s+/).filter(Boolean).length : 0;
    const showSeeLess = wordCount > 100;
    const imagesHtml = buildPostImagesHtml(post.images);

    return `
<article class="feed-card" data-post-id="${post.id}" data-post-user-id="${escapeHtml(String(post.user_id))}" data-post-author-name="${authorName}" data-post-author-handle="${authorHandle}" data-post-author-avatar="${escapeHtml(post.author_avatar || '')}" data-post-content="${content}" data-post-created-at="${escapeHtml(post.created_at)}" data-post-like-count="${post.like_count}" data-post-comment-count="${post.comment_count}" data-post-liked="${post.liked_by_user}" data-post-images="${escapeHtml(JSON.stringify(post.images || []))}">
<div class="flex gap-3">
<div class="feed-card-avatar-rail shrink-0 cursor-pointer" onclick="openProfileFromPostCard(this)">
<img alt="${authorName}" class="w-11 h-11 rounded-full bg-gray-200 border border-gray-100 object-cover" src="${avatarUrl}"/>
</div>
<div class="flex-1 min-w-0">
<div class="flex items-start justify-between gap-2 mb-0.5">
<div class="flex items-baseline gap-1.5 min-w-0 cursor-pointer" onclick="openProfileFromPostCard(this)">
<h2 class="font-bold text-gray-900 text-[15px] leading-tight truncate">${authorName}</h2>
<span class="text-gray-400 text-[13px] leading-tight shrink-0">· ${timeAgo}</span>
</div>
<button class="post-menu-btn text-gray-400 hover:text-gray-600 p-1 -mr-1 shrink-0" aria-label="More options">
<svg class="w-4 h-4" fill="currentColor" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<path d="M12 6a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4z"></path>
</svg>
</button>
</div>
<p class="text-gray-800 text-[15px] mb-3 leading-relaxed post-content"><span class="post-content-text">${previewText}</span>${isLong ? ` <button class="read-more-btn text-gray-400 font-medium" data-preview-text="${escapeHtml(previewRaw)}" data-expanded="false" data-show-see-less="${showSeeLess}">See more&hellip;</button>` : ''}</p>
${imagesHtml}
<div class="flex items-center justify-between text-gray-500 post-actions-row px-5">
<button class="share-btn flex items-center space-x-1.5 hover:text-gray-700 transition-colors" aria-label="Share" aria-haspopup="dialog">
<svg class="w-[19px] h-[19px]" fill="none" stroke="currentColor" stroke-width="1.75" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" stroke-linecap="round" stroke-linejoin="round"></path>
<polyline points="15 3 21 3 21 9" stroke-linecap="round" stroke-linejoin="round"></polyline>
<line x1="10" x2="21" y1="14" y2="3" stroke-linecap="round" stroke-linejoin="round"></line>
</svg>
</button>
<button class="comment-btn flex items-center space-x-1.5 hover:text-gray-700 transition-colors">
  <svg class="w-[19px] h-[19px]" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
   <path d="M20.5 4.75A2.75 2.75 0 0 0 17.75 2h-11.5A2.75 2.75 0 0 0 3.5 4.75v8.5A2.75 2.75 0 0 0 6.25 16h3.95l2.45 2.35a.5.5 0 0 0 .7 0L15.8 16h1.95a2.75 2.75 0 0 0 2.75-2.75v-8.5Z"/>
   <circle cx="8" cy="9" r="1" fill="currentColor" stroke="none"/>
   <circle cx="12" cy="9" r="1" fill="currentColor" stroke="none"/>
   <circle cx="16" cy="9" r="1" fill="currentColor" stroke="none"/>
  </svg>
  <span class="text-sm comment-count${post.comment_count < 1 ? ' post-count-empty' : ''}">${post.comment_count}</span>
</button>
<button class="like-btn flex items-center space-x-1.5 hover:text-gray-700 transition-colors" data-post-id="${post.id}" data-liked="${post.liked_by_user}">
<span class="like-icon-wrapper">
	<svg class="w-[19px] h-[19px] ${likedTextColor} heart-outline" fill="none" stroke="currentColor" stroke-width="1.75" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
	<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" stroke-linecap="round" stroke-linejoin="round"></path>
	</svg>
	<svg class="w-[19px] h-[19px] text-brand-red heart-filled absolute inset-0" fill="currentColor" stroke="none" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
	<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
	</svg>
</span>
<span class="text-sm like-count ${likedTextColor}${post.like_count < 1 ? ' post-count-empty' : ''}">${post.like_count}</span>
</button>
</div>
</div>
</div>
</article>`;
}

// Lightweight shimmer placeholder rows shown only while the very first
// page of the feed is loading (renderFeedPosts already handles the
// "no posts" empty state and loadMoreFeedPosts has its own text-only
// "Loading more..." row for pagination - this is just for the initial
// blank-screen moment, so the feed's shape is visible immediately
// instead of a flash of empty white).
function buildFeedSkeletonHtml(count) {
    const row = `
<div class="feed-card">
<div class="flex gap-3">
<div class="feed-card-avatar-rail shrink-0">
<div class="w-11 h-11 rounded-full skeleton-shimmer"></div>
</div>
<div class="flex-1 min-w-0">
<div class="h-3.5 w-32 rounded skeleton-shimmer mb-2"></div>
<div class="h-3.5 w-full rounded skeleton-shimmer mb-1.5"></div>
<div class="h-3.5 w-4/5 rounded skeleton-shimmer mb-3"></div>
<div class="flex items-center gap-6">
<div class="h-4 w-10 rounded skeleton-shimmer"></div>
<div class="h-4 w-10 rounded skeleton-shimmer"></div>
</div>
</div>
</div>
</div>`;
    return row.repeat(count);
}

// Render an array of posts into the feed container, or an empty state
function renderFeedPosts(posts) {
    const container = document.getElementById('feed-posts-container');
    if (!container) return;

    if (!posts || posts.length === 0) {
        container.innerHTML = `
<div class="flex items-center justify-center h-full min-h-[50vh] text-gray-400 text-sm">
No posts yet
</div>`;
        return;
    }

    container.innerHTML = posts.map(buildPostCardHtml).join('');
}

// Feed pagination state. Reset on every fresh load (see fetchAndRenderPosts).
// GET /api/posts now returns {posts, next_cursor} instead of a bare array -
// next_cursor is the id to pass back to fetch the next page, or null when
// there are no more posts.
let feedNextCursor = null;
let feedIsLoadingMore = false;
let feedExhausted = false;
const FEED_PAGE_SIZE = 20;
const FEED_SCROLL_THRESHOLD_PX = 300;

// Which feed tab is active: 'for-you' (default, unfiltered) or 'following'
// (server-side filtered to posts from users the session follows - see the
// feed=following param on GET /api/posts). Set by switchFeedTab(), read by
// both fetchAndRenderPosts() and loadMoreFeedPosts() so pagination stays on
// whichever tab is currently open instead of drifting back to "For You".
let activeFeedTab = 'for-you';

// Fetch the first page of posts from the backend and render them into the
// feed, resetting pagination state. Call this whenever the feed is
// (re)opened, not when appending more posts (see loadMoreFeedPosts).
async function fetchAndRenderPosts() {
    feedNextCursor = null;
    feedIsLoadingMore = false;
    feedExhausted = false;
    resetFeedHeaderBar();

    const container = document.getElementById('feed-posts-container');
    if (container) {
        container.innerHTML = buildFeedSkeletonHtml(4);
    }

    try {
        const feedParam = activeFeedTab === 'following' ? '&feed=following' : '';
        const response = await fetch(`/api/posts?limit=${FEED_PAGE_SIZE}${feedParam}`);
        if (!response.ok) {
            throw new Error('Failed to load posts');
        }
        const data = await response.json();
        renderFeedPosts(data.posts);
        feedNextCursor = data.next_cursor;
        feedExhausted = data.next_cursor === null;

        if (data.posts.length === 0 && activeFeedTab === 'following' && container) {
            container.innerHTML = `
<div class="flex items-center justify-center h-full min-h-[50vh] text-gray-400 text-sm text-center px-8">
Posts from people you follow will show up here.
</div>`;
        }
    } catch (error) {
        if (container) {
            container.innerHTML = `
<div class="flex items-center justify-center h-full min-h-[50vh] text-gray-400 text-sm">
No posts yet
</div>`;
        }
        console.error('Error loading posts:', error);
    }
}

// Switches the active feed tab (see the #feed-tab-for-you/#feed-tab-following
// buttons in feed.html): swaps the active/inactive Tailwind classes between
// the two tabs' inner <span> labels - rather than toggling a shared CSS
// class - because "active" here isn't just one style, it's a whole cluster
// (color, weight, underline) that has to move from one tab to the other
// together, and the two tabs need opposite states in the same click.
// Classes live on the inner span rather than the outer <a> (flex-1,
// centers the label in its half of the nav) because the border-bottom used
// as the underline needs to size to the text, not stretch across that
// whole half-width flex item. border-b-2 and pb-2.5 themselves are never
// toggled - both tabs keep them permanently and only the border's color
// swaps between transparent and gray-900 - so an inactive tab reserves the
// same space its underline will occupy once active instead of the layout
// shifting by 2px when it does.
function switchFeedTab(tab) {
    if (tab === activeFeedTab) return;
    activeFeedTab = tab;

    const forYouTab = document.getElementById('feed-tab-for-you');
    const followingTab = document.getElementById('feed-tab-following');
    if (!forYouTab || !followingTab) return;
    const forYouLabel = forYouTab.querySelector('span');
    const followingLabel = followingTab.querySelector('span');
    if (!forYouLabel || !followingLabel) return;

    const activeClasses = ['text-gray-900', 'font-bold', 'border-gray-900'];
    const inactiveClasses = ['text-gray-500', 'font-medium', 'border-transparent', 'hover:text-gray-700'];

    const activeLabel = tab === 'following' ? followingLabel : forYouLabel;
    const inactiveLabel = tab === 'following' ? forYouLabel : followingLabel;

    inactiveLabel.classList.remove(...activeClasses);
    inactiveLabel.classList.add(...inactiveClasses);
    activeLabel.classList.remove(...inactiveClasses);
    activeLabel.classList.add(...activeClasses);

    fetchAndRenderPosts();
}

// Append the next page of posts to the bottom of the feed. Guarded against
// overlapping calls (feedIsLoadingMore) and re-fetching past the end
// (feedExhausted). Failures are silent and retried on the next scroll
// event - a spinner/toast here would be noisier than useful for a
// background pagination fetch.
async function loadMoreFeedPosts() {
    if (feedIsLoadingMore || feedExhausted || feedNextCursor == null) return;
    feedIsLoadingMore = true;

    const container = document.getElementById('feed-posts-container');
    // Inserted fresh each call and always removed in `finally` below, rather
    // than a static hidden element - renderFeedPosts replaces the whole
    // container's innerHTML on every fresh load, which would wipe a
    // pre-existing static sentinel anyway.
    const loadingRow = document.createElement('div');
    loadingRow.id = 'feed-loading-more';
    loadingRow.className = 'flex items-center justify-center py-4 text-gray-400 text-sm';
    loadingRow.textContent = 'Loading more...';
    if (container) container.appendChild(loadingRow);

    try {
        const feedParam = activeFeedTab === 'following' ? '&feed=following' : '';
        const response = await fetch(`/api/posts?limit=${FEED_PAGE_SIZE}&cursor=${feedNextCursor}${feedParam}`);
        if (!response.ok) {
            throw new Error('Failed to load more posts');
        }
        const data = await response.json();

        if (container && data.posts.length > 0) {
            container.insertAdjacentHTML('beforeend', data.posts.map(buildPostCardHtml).join(''));
        }

        feedNextCursor = data.next_cursor;
        feedExhausted = data.next_cursor === null;
    } catch (error) {
        console.error('Error loading more posts:', error);
        // Leave feedNextCursor as-is so the next scroll event retries.
    } finally {
        feedIsLoadingMore = false;
        loadingRow.remove();
    }
}

// feed-posts-container is itself the scrollable element (overflow-y-auto),
// so infinite scroll listens on it directly rather than the window.
(function initFeedInfiniteScroll() {
    const container = document.getElementById('feed-posts-container');
    if (!container) return;
    container.addEventListener('scroll', () => {
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceFromBottom < FEED_SCROLL_THRESHOLD_PX) {
            loadMoreFeedPosts();
        }
    });
})();

// ---- Image Viewer (full-screen, image-only) ----
//
// Opened by tapping a post's image (see the .post-card-images delegate in
// comments.js). Deliberately separate from the comment/Post-detail overlay
// in comment_overlay.html/comments.js - the Comment button is the only
// entry point into that screen; this just shows the tapped image, swipeable
// to the post's other images if it has more, with no comments/reply/
// follow/action-row chrome.

// Keeps the counter (e.g. "2 / 4") in sync while swiping - stored so it can
// be detached in closeImageViewer() instead of accumulating a new scroll
// listener (and firing on a stale track) every time the viewer reopens.
let imageViewerScrollHandler = null;

function openImageViewer(images, startIndex) {
    const overlay = document.getElementById('image-viewer-overlay');
    const track = document.getElementById('image-viewer-track');
    const counter = document.getElementById('image-viewer-counter');
    if (!overlay || !track || !counter || !Array.isArray(images) || images.length === 0) return;

    track.innerHTML = images.map(url => `
<div class="w-full h-full shrink-0 snap-center flex items-center justify-center">
<img src="${escapeHtml(url)}" alt="Post attachment" class="max-w-full max-h-full object-contain"/>
</div>`).join('');

    if (images.length > 1) {
        counter.textContent = `${startIndex + 1} / ${images.length}`;
        counter.classList.remove('hidden');
        imageViewerScrollHandler = function() {
            const idx = Math.round(track.scrollLeft / track.clientWidth);
            counter.textContent = `${Math.min(idx, images.length - 1) + 1} / ${images.length}`;
        };
        track.addEventListener('scroll', imageViewerScrollHandler, { passive: true });
    } else {
        counter.classList.add('hidden');
    }

    overlay.classList.remove('hidden');
    document.body.classList.add('overlay-open');

    // Jump straight to the tapped image - no animated scroll fighting the
    // overlay's own appearance.
    track.scrollLeft = startIndex * track.clientWidth;
}

function closeImageViewer() {
    const overlay = document.getElementById('image-viewer-overlay');
    const track = document.getElementById('image-viewer-track');
    if (!overlay || !track) return;

    overlay.classList.add('hidden');
    closeImageViewerMenu();

    // The viewer can be opened from on top of the already-open comment
    // overlay (see the #overlay-post-images listener in comments.js), which
    // holds this same lock itself - only release it here if that overlay
    // isn't also still open, or closing the viewer would unlock background
    // scroll while the comment overlay is still visible underneath it.
    const commentOverlay = document.getElementById('comment-overlay');
    const commentOverlayOpen = commentOverlay && !commentOverlay.classList.contains('hidden');
    if (!commentOverlayOpen) {
        document.body.classList.remove('overlay-open');
    }

    if (imageViewerScrollHandler) {
        track.removeEventListener('scroll', imageViewerScrollHandler);
        imageViewerScrollHandler = null;
    }
    track.innerHTML = '';
}

// "..." menu on the image viewer (Save). A separate small dropdown rather
// than reusing post-menu-sheet - that one is a full-width bottom sheet for
// post-level actions (Share/Hide/Report/etc), this is just the single
// image-level Save action anchored under the button that opened it.
function openImageViewerMenu() {
    const popover = document.getElementById('image-viewer-menu-popover');
    if (popover) popover.classList.remove('hidden');
}

function closeImageViewerMenu() {
    const popover = document.getElementById('image-viewer-menu-popover');
    if (popover) popover.classList.add('hidden');
}

document.getElementById('image-viewer-menu-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    const popover = document.getElementById('image-viewer-menu-popover');
    if (!popover) return;
    popover.classList.contains('hidden') ? openImageViewerMenu() : closeImageViewerMenu();
});

// Tap anywhere else in the viewer closes the popover without closing the
// whole viewer (that's handled separately by the overlay's own
// click-on-backdrop listener below).
document.getElementById('image-viewer-overlay').addEventListener('click', function(e) {
    if (!e.target.closest('#image-viewer-menu-popover') && !e.target.closest('#image-viewer-menu-btn')) {
        closeImageViewerMenu();
    }
});

// Downloads whichever image is currently in view (tracked the same way the
// swipe counter is - by scroll position - rather than always the first
// image in a multi-image post).
function handleImageViewerSave() {
    const track = document.getElementById('image-viewer-track');
    if (!track) return;

    const slides = track.querySelectorAll('img');
    if (slides.length === 0) return;
    const activeIndex = Math.min(
        Math.round(track.scrollLeft / track.clientWidth),
        slides.length - 1
    );
    const activeImg = slides[activeIndex];

    const link = document.createElement('a');
    link.href = activeImg.src;
    link.download = 'beebo-image.jpg';
    document.body.appendChild(link);
    link.click();
    link.remove();

    closeImageViewerMenu();
    showToast('Image saved');
}

document.getElementById('image-viewer-save-btn').addEventListener('click', handleImageViewerSave);

document.getElementById('close-image-viewer-btn').addEventListener('click', closeImageViewer);
document.getElementById('image-viewer-overlay').addEventListener('click', function(e) {
    if (e.target === this) closeImageViewer();
});

// Feed-header "push and cover" scroll effect (#feed-header: the
// avatar/logo/notifications bar plus the category tabs): as the person
// scrolls down, the header is progressively covered - its max-height
// shrinks and its opacity fades in exact lockstep with scroll distance,
// so it reads as the feed content physically sliding up and over it
// rather than the header just vanishing. It's a continuous 1:1 mapping
// (feedHeaderProgress, 0 = fully shown, 1 = fully covered) driven straight
// off scrollTop deltas every frame - no easing curve fighting the
// person's own scroll input, so it tracks a finger/trackpad exactly,
// forward or backward, the same way pushing a physical panel would.
// Scrolling back up runs the same mapping in reverse, progressively
// uncovering the header again.
//
// The one exception is landing back at the very top of the feed
// (scrollTop <= FEED_HEADER_TOP_REVEAL_PX): that still forces a full,
// guaranteed reveal via the header's own CSS transition (600ms
// ease-out, see .feed-header-bar in style.css) rather than the
// continuous per-pixel mapping - the same safety net this always had,
// so an overscroll bounce or a quick flick back to the top can't leave
// the header stuck partway covered.
//
// #feed-view is a flex column with #feed-posts-container as its flex-1
// scrolling child (see #feed-view.active in style.css), so shrinking the
// header's max-height is what actually reflows the column and lets the
// posts container grow to fill the freed space - a transform on the
// header alone would just move its pixels without the feed ever
// reclaiming that space beneath it.
const FEED_HEADER_TOP_REVEAL_PX = 4;

let feedHeaderScrollTop = 0;
let feedHeaderProgress = 0; // 0 = fully shown, 1 = fully covered
let feedHeaderFullHeightPx = 0; // raw px, cached alongside the CSS var below
let feedHeaderHidden = false; // true once feedHeaderProgress reaches 1

// The header's natural height depends on the avatar/logo/notification icon
// sizing (all tweakable independently above) rather than being a fixed
// constant, so it's measured off the real element instead of hardcoded.
// Skipped while the header is fully covered so it can't read its own
// collapsed max-height back as the "full" height, and skipped when
// scrollHeight is 0 (element exists but its view isn't the active one yet
// - display:none ancestors report 0 - see .view-section in style.css) so
// an out-of-view measurement can't pin --feed-header-full-height to 0px.
// That property is set inline once written, so a stale 0 would
// permanently beat the CSS fallback (max-height: var(--feed-header-full-
// height, 220px)) even after the view becomes visible - this is what
// caused the header to render collapsed right after login (script
// parses/runs while #login-view, not #feed-view, is active).
function measureFeedHeaderHeight() {
    if (feedHeaderHidden) return;
    const header = document.getElementById('feed-header');
    if (!header || header.scrollHeight === 0) return;
    feedHeaderFullHeightPx = header.scrollHeight;
    header.style.setProperty('--feed-header-full-height', `${header.scrollHeight}px`);
}

// Called on every fresh feed load (see fetchAndRenderPosts) so a re-open
// or pull-to-refresh always starts with the header fully shown and the
// tracked scroll position/coverage doesn't carry over stale from the
// previous load. Also re-measures the header height here (not just at
// script-load time, which can happen before #feed-view is ever visible)
// - showView('feed') has already added the 'active' class by the time
// fetchAndRenderPosts() (and thus this) runs, so the header is
// guaranteed laid out and measurable at this point.
function resetFeedHeaderBar() {
    feedHeaderScrollTop = 0;
    feedHeaderProgress = 0;
    feedHeaderHidden = false;
    const header = document.getElementById('feed-header');
    if (header) {
        header.classList.remove('header-hidden');
        header.style.transition = '';
        header.style.maxHeight = '';
        header.style.opacity = '';
    }
    const fab = document.getElementById('compose-fab');
    if (fab) fab.classList.remove('fab-hidden');
    measureFeedHeaderHeight();
}

(function initFeedHeaderAutoHide() {
    const container = document.getElementById('feed-posts-container');
    const header = document.getElementById('feed-header');
    if (!container || !header) return;

    // The compose FAB stays synced to the header's fully-shown/fully-
    // covered boundary (not the continuous drag in between) - it hides
    // once the header is completely covered and reappears as soon as
    // any reveal starts, same coupling this always had, just keyed off
    // feedHeaderHidden instead of a discrete threshold crossing.
    const fab = document.getElementById('compose-fab');

    let ticking = false;

    measureFeedHeaderHeight();
    window.addEventListener('resize', measureFeedHeaderHeight);

    // instant: true for the normal per-frame scroll-driven update (no
    // transition, so it tracks the scroll 1:1 - the "physical push"
    // feel); false for the discrete top-of-feed reveal, which clears any
    // drag-time inline overrides and lets the header's own CSS
    // transition animate the change instead.
    function setHeaderCoverage(progress, instant) {
        feedHeaderProgress = progress;

        if (instant) {
            header.style.transition = 'none';
            header.style.maxHeight = `${feedHeaderFullHeightPx * (1 - progress)}px`;
            header.style.opacity = String(1 - progress);
        } else {
            header.style.transition = '';
            header.style.maxHeight = '';
            header.style.opacity = '';
        }
        // Only controls pointer-events at full coverage - inline styles
        // above always win over this class's own max-height/opacity, so
        // toggling it here can't fight the per-frame drag values.
        header.classList.toggle('header-hidden', progress >= 1);

        const nowHidden = progress >= 1;
        if (nowHidden !== feedHeaderHidden) {
            feedHeaderHidden = nowHidden;
            if (fab) fab.classList.toggle('fab-hidden', nowHidden);
        }
        if (progress === 0) measureFeedHeaderHeight();
    }

    function applyScroll() {
        const scrollTop = container.scrollTop;
        const delta = scrollTop - feedHeaderScrollTop;
        feedHeaderScrollTop = scrollTop;

        // Near the very top, always fully show - an overscroll bounce
        // here reads as a big downward delta otherwise and would start
        // covering the header right as the person lands back at the top
        // of their feed. This is the one spot that still snaps (via the
        // header's own CSS transition) instead of tracking scroll 1:1.
        if (scrollTop <= FEED_HEADER_TOP_REVEAL_PX) {
            if (feedHeaderProgress !== 0) setHeaderCoverage(0, false);
            return;
        }

        if (delta === 0 || !feedHeaderFullHeightPx) return;

        const nextProgress = Math.min(1, Math.max(0, feedHeaderProgress + delta / feedHeaderFullHeightPx));
        if (nextProgress !== feedHeaderProgress) setHeaderCoverage(nextProgress, true);
    }

    // rAF-batched: caps this to once per animation frame no matter how many
    // scroll events fire, so it can't compete with the browser's own
    // scroll/momentum handling. Passive, and never calls preventDefault,
    // so normal feed scrolling and every other in-feed interaction (likes,
    // opening the comment overlay, pull-to-refresh, infinite scroll above)
    // is untouched.
    container.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            applyScroll();
            ticking = false;
        });
    }, { passive: true });
})();

