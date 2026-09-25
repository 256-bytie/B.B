// ---- Comment Overlay Functionality ----

let currentPostId = null;
let currentPostAuthorId = null;

// Feed card three-dot ("more options") bottom sheet tracks its own
// post/author context separately from the comment overlay's currentPostId,
// since the sheet is a singleton opened from any card in the feed.
let activeSheetPostId = null;
let activeSheetPostAuthorId = null;

// Returns true only when the logged-in session user is the author of the
// given post. Used to gate the Delete option in both the feed card's
// bottom sheet and the comment overlay's popover, and never trusted alone —
// the actual delete request is re-checked for ownership server-side.
function isCurrentUserPostOwner(authorId) {
	return !!(session && session.user && authorId != null && String(session.user.id) === String(authorId));
}

// Post card interactions (read more, three-dot menu, comment, like) are
// delegated per-container rather than globally, so any view that renders
// post cards built with buildPostCardHtml needs its container id listed
// here. Currently: the main feed, the Profile screen's Posts tab,
// another user's profile Posts tab (user-profile-posts-container), and
// the Posts facet of global search (search-posts-container) — so a post
// found via search gets real like/comment/menu/profile-nav behavior
// instead of a read-only preview.
const postCardContainerIds = ['feed-posts-container', 'profile-posts-container', 'user-profile-posts-container', 'search-posts-container'];

// Delegated click listener for "See more" / "See less" toggling. The
// feed only ever renders a truncated preview for long posts (see
// buildPostCardHtml in feed.js); expanding swaps in the full text from
// the post card's data-post-content, and collapsing swaps back to the
// preview stashed on the button's data-preview-text (so it doesn't need
// to be recomputed client-side). Assigning to .textContent (not
// .innerHTML) is what keeps this safe - the browser escapes it, so no
// re-escaping of the already-unescaped dataset values is needed.
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', function(e) {
		const readMoreBtn = e.target.closest('.read-more-btn');
		if (!readMoreBtn) return;
		const postCard = readMoreBtn.closest('article[data-post-id]');
		const textEl = readMoreBtn.closest('.post-content') ? readMoreBtn.closest('.post-content').querySelector('.post-content-text') : null;
		if (!postCard || !textEl) return;

		const isExpanded = readMoreBtn.dataset.expanded === 'true';
		if (isExpanded) {
			textEl.textContent = readMoreBtn.dataset.previewText;
			readMoreBtn.textContent = 'See more\u2026';
			readMoreBtn.dataset.expanded = 'false';
		} else {
			textEl.textContent = postCard.dataset.postContent;
			// "See less" only labels the collapse for posts over 100
			// words (see showSeeLess in buildPostCardHtml) - shorter
			// long posts still collapse on tap, just via an unlabeled button.
			readMoreBtn.textContent = readMoreBtn.dataset.showSeeLess === 'true' ? 'See less' : '';
			readMoreBtn.dataset.expanded = 'true';
		}
	});
});

// Delegated click listener for the post three-dot ("more options") button
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', function(e) {
		const menuBtn = e.target.closest('.post-menu-btn');
		if (!menuBtn) return;

		const postCard = menuBtn.closest('article[data-post-id]');
		activeSheetPostId = postCard ? postCard.dataset.postId : null;
		activeSheetPostAuthorId = postCard ? postCard.dataset.postUserId : null;

		openPostMenu();
	});
});

// Reads a post card's data-* attributes back into the plain object shape
// openCommentOverlay expects. Shared by every entry point into the detail
// screen (comment button, tapping the post's image) so they all open the
// exact same view with the exact same data, rather than each building its
// own slightly-different payload.
function getPostDataFromCard(postCard) {
	let images = [];
	try {
		images = JSON.parse(postCard.dataset.postImages || '[]');
	} catch (e) {
		images = [];
	}
	return {
		id: postCard.dataset.postId,
		user_id: postCard.dataset.postUserId,
		author_name: postCard.dataset.postAuthorName,
		author_handle: postCard.dataset.postAuthorHandle,
		author_avatar: postCard.dataset.postAuthorAvatar || null,
		content: postCard.dataset.postContent,
		created_at: postCard.dataset.postCreatedAt,
		like_count: postCard.dataset.postLikeCount,
		comment_count: postCard.dataset.postCommentCount,
		liked_by_user: postCard.dataset.postLiked === 'true',
		images: images
	};
}

// Delegated click listener for comment buttons
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', function(e) {
		const commentBtn = e.target.closest('.comment-btn');
		if (!commentBtn) return;

		const postCard = commentBtn.closest('article[data-post-id]');
		if (!postCard) return;

		openCommentOverlay(getPostDataFromCard(postCard));
	});
});

// Delegated click listener for tapping a post's image(s): opens the
// dedicated image-only viewer (see openImageViewer in feed.js), not the
// Post/comments overlay - the Comment button below is the only entry point
// into that screen now.
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', function(e) {
		const tappedImg = e.target.closest('.post-card-images img');
		if (!tappedImg) return;

		const postCard = tappedImg.closest('article[data-post-id]');
		if (!postCard) return;

		let images = [];
		try {
			images = JSON.parse(postCard.dataset.postImages || '[]');
		} catch (err) {
			images = [];
		}
		if (images.length === 0) return;

		const startIndex = parseInt(tappedImg.dataset.imageIndex, 10) || 0;
		openImageViewer(images, startIndex);
	});
});

// Same tap-to-open-viewer behavior for the comment overlay's own post image
// block (#overlay-post-images, populated via buildPostImagesHtml in
// openCommentOverlay - same markup/classes as a feed card's images, just
// not one of the postCardContainerIds list above since it's a single fixed
// element rather than a list of post cards). Attached once here rather than
// inside openCommentOverlay so it doesn't get re-bound (and stack up
// duplicate handlers) every time the overlay opens.
(function() {
	const overlayImages = document.getElementById('overlay-post-images');
	if (!overlayImages) return;
	overlayImages.addEventListener('click', function(e) {
		const tappedImg = e.target.closest('img');
		if (!tappedImg) return;

		const images = Array.from(overlayImages.querySelectorAll('img')).map(img => img.src);
		if (images.length === 0) return;

		const startIndex = parseInt(tappedImg.dataset.imageIndex, 10) || 0;
		openImageViewer(images, startIndex);
	});
})();

// Delegated click listener for post like buttons
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', async function(e) {
	const likeBtn = e.target.closest('.like-btn');
	if (!likeBtn) return;

	e.preventDefault();
	e.stopPropagation();

	const postId = likeBtn.dataset.postId;
	const isLiked = likeBtn.dataset.liked === 'true';
	const likeCountSpan = likeBtn.querySelector('.like-count');
	const iconWrapper = likeBtn.querySelector('.like-icon-wrapper');
	const heartOutline = likeBtn.querySelector('.heart-outline');
	const heartFilled = likeBtn.querySelector('.heart-filled');

	// Store original state for rollback
	const originalCount = parseInt(likeCountSpan.textContent);
	const originalLiked = isLiked;

	// Optimistic update
	const newLiked = !isLiked;
	const newCount = newLiked ? originalCount + 1 : originalCount - 1;

	likeBtn.dataset.liked = newLiked;

	// Add count change animation
	likeCountSpan.classList.add('count-changing');
	setPostCountSpan(likeCountSpan, newCount);
	setTimeout(() => likeCountSpan.classList.remove('count-changing'), 140);

	if (newLiked) {
		// Liking animation
		likeBtn.classList.add('is-liking');
		heartOutline.classList.remove('text-gray-500');
		heartOutline.classList.add('text-brand-red');
		likeCountSpan.classList.remove('text-gray-500');
		likeCountSpan.classList.add('text-brand-red');

		// Remove animation class after it completes
		setTimeout(() => likeBtn.classList.remove('is-liking'), 550);
	} else {
		// Unliking animation
		likeBtn.classList.add('is-unliking');
		heartOutline.classList.remove('text-brand-red');
		heartOutline.classList.add('text-gray-500');
		likeCountSpan.classList.remove('text-brand-red');
		likeCountSpan.classList.add('text-gray-500');

		// Remove animation class after it completes
		setTimeout(() => likeBtn.classList.remove('is-unliking'), 180);
	}

	// Update data attributes on the article
	const postCard = likeBtn.closest('article[data-post-id]');
	if (postCard) {
		postCard.dataset.postLiked = newLiked;
		postCard.dataset.postLikeCount = newCount;
	}

	try {
		const response = await apiFetch(`/api/posts/${postId}/like`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error('Failed to like post');
		}

		const data = await response.json();

		// Reconcile with server response
		likeBtn.dataset.liked = data.liked;
		setPostCountSpan(likeCountSpan, data.like_count);

		if (postCard) {
			postCard.dataset.postLiked = data.liked;
			postCard.dataset.postLikeCount = data.like_count;
		}

		// Update overlay if it's open for this post
		if (currentPostId == postId) {
			const overlayLikeBtn = document.getElementById('overlay-post-like-btn');
			const overlayLikeCount = document.getElementById('overlay-post-likes');
			if (overlayLikeBtn && overlayLikeCount) {
				overlayLikeBtn.dataset.liked = data.liked;
				setPostCountSpan(overlayLikeCount, data.like_count);

				const overlayIconWrapper = overlayLikeBtn.querySelector('.like-icon-wrapper');
				const overlayHeartOutline = overlayLikeBtn.querySelector('.heart-outline');
				const overlayHeartFilled = overlayLikeBtn.querySelector('.heart-filled');
				const overlayCountSpan = overlayLikeCount;

				if (data.liked) {
					overlayHeartOutline.classList.remove('text-gray-700');
					overlayHeartOutline.classList.add('text-brand-red');
					overlayCountSpan.classList.remove('text-gray-700');
					overlayCountSpan.classList.add('text-brand-red');
				} else {
					overlayHeartOutline.classList.remove('text-brand-red');
					overlayHeartOutline.classList.add('text-gray-700');
					overlayCountSpan.classList.remove('text-brand-red');
					overlayCountSpan.classList.add('text-gray-700');
				}
			}
		}

	} catch (error) {
		console.error('Error liking post:', error);

		// Revert optimistic update
		likeBtn.dataset.liked = originalLiked;
		setPostCountSpan(likeCountSpan, originalCount);

		if (originalLiked) {
			heartOutline.classList.remove('text-gray-500');
			heartOutline.classList.add('text-brand-red');
			likeCountSpan.classList.remove('text-gray-500');
			likeCountSpan.classList.add('text-brand-red');
		} else {
			heartOutline.classList.remove('text-brand-red');
			heartOutline.classList.add('text-gray-500');
			likeCountSpan.classList.remove('text-brand-red');
			likeCountSpan.classList.add('text-gray-500');
		}

		if (postCard) {
			postCard.dataset.postLiked = originalLiked;
			postCard.dataset.postLikeCount = originalCount;
		}
	}
	});
});

function openCommentOverlay(postData) {
	currentPostId = postData.id;
	currentPostAuthorId = postData.user_id;
	updateReplyComposerAvatar();

	// Populate post header
	const avatarUrl = postData.author_avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(postData.author_handle)}`;
	document.getElementById('overlay-post-avatar').src = avatarUrl;
	document.getElementById('overlay-post-author').textContent = postData.author_name;
	document.getElementById('overlay-post-handle').textContent = `@${postData.author_handle}`;
	loadOverlayPostFollowState(postData.user_id);

	const overlayImages = document.getElementById('overlay-post-images');
	const imagesHtml = buildPostImagesHtml(postData.images);
	if (imagesHtml) {
		overlayImages.innerHTML = imagesHtml;
		overlayImages.classList.remove('hidden');
	} else {
		overlayImages.innerHTML = '';
		overlayImages.classList.add('hidden');
	}

	document.getElementById('overlay-post-content').textContent = postData.content;
	document.getElementById('overlay-post-time').textContent = formatPostTime(postData.created_at);
	setPostCountSpan(document.getElementById('overlay-post-comments'), postData.comment_count);

	// Convert like stat block into a clickable button and set initial state
	const likesParent = document.getElementById('overlay-post-likes').parentElement;
	const isLiked = postData.liked_by_user;
	const likedTextClass = isLiked ? 'text-brand-red' : 'text-gray-700';

	likesParent.id = 'overlay-post-like-btn';
	likesParent.className = `flex items-center gap-2 transition-colors cursor-pointer`;
	likesParent.dataset.liked = isLiked;

	const likeIconWrapper = likesParent.querySelector('.like-icon-wrapper');
	const heartOutline = likesParent.querySelector('.heart-outline');
	const likeCount = document.getElementById('overlay-post-likes');
	heartOutline.classList.remove('text-gray-700', 'text-brand-red');
	heartOutline.classList.add(likedTextClass);
	likeCount.classList.remove('text-gray-700', 'text-brand-red');
	likeCount.classList.add(likedTextClass);
	setPostCountSpan(likeCount, postData.like_count);

	// Show overlay
	const overlay = document.getElementById('comment-overlay');
	overlay.classList.remove('hidden');
	document.body.classList.add('overlay-open');

	// Reset scroll position: post + comments now share one scroll region
	// (see .overlay-replies-section), so a previous post's scroll offset
	// would otherwise carry over and open this post already scrolled down.
	const scrollArea = document.querySelector('#comment-overlay .overlay-replies-section');
	if (scrollArea) scrollArea.scrollTop = 0;

	// Show loading state
	document.getElementById('overlay-loading').classList.remove('hidden');
	document.getElementById('overlay-empty').classList.add('hidden');
	document.getElementById('overlay-error').classList.add('hidden');
	document.getElementById('overlay-comments-container').innerHTML = '';

	// Reset composer: clears any reply-to chip and disabled-send state left
	// over from a previous post's overlay.
	cancelReplyContext();
	updateReplyComposerState();

	// Reset collapsed-thread state so a thread left collapsed on a
	// previously-viewed post doesn't render collapsed here too.
	collapsedCommentIds.clear();

	// Fetch comments
	fetchComments(postData.id);
}

// Own posts never show a follow button - mirrors the self-check in
// openProfileFromPostCard, which routes taps on your own author info to
// the own-profile screen instead of the other-user one.
//
// For everyone else: the button only ever appears in the "not following"
// state. Once the viewer follows an author, every post of theirs -
// including ones opened after this one, with no refresh - shows no follow
// control at all, matching the common feed pattern of the control
// disappearing once it's no longer actionable. The one exception is the
// post the viewer just tapped Follow on, which stays visible as
// "Following" for that overlay session as a one-off tap confirmation -
// see toggleOverlayPostFollow.
function loadOverlayPostFollowState(authorId) {
	const btn = document.getElementById('overlay-post-follow-btn');
	if (!btn) return;

	btn.classList.add('hidden');

	if (!authorId || (session && session.user && String(authorId) === String(session.user.id))) {
		return;
	}

	// Reuses the same per-user relationship cache profile-user.js populates,
	// so a follow/unfollow made on the profile screen or a previous post's
	// overlay is already reflected here with no extra fetch.
	const cached = getCachedRelationship(authorId);
	if (cached) {
		if (!cached.following) {
			updateOverlayPostFollowButton(false);
			btn.classList.remove('hidden');
		}
		return;
	}

	// Uncached: stays hidden until the authoritative fetch resolves, rather
	// than optimistically flashing "Follow" and then disappearing - a
	// visible-then-hidden flicker would misrepresent an already-followed
	// author as followable for a moment.
	fetch(`/api/users/${authorId}`)
		.then(response => response.ok ? response.json() : null)
		.then(profile => {
			if (!profile) return;
			// Stale guard: don't paint onto a different post's overlay if
			// the user has already navigated on before this resolves.
			if (String(currentPostAuthorId) !== String(authorId)) return;
			setCachedRelationship(authorId, {
				following: !!profile.is_following,
				followerCount: profile.follower_count,
				followingCount: profile.following_count
			});
			if (!profile.is_following) {
				updateOverlayPostFollowButton(false);
				btn.classList.remove('hidden');
			}
		})
		.catch(error => console.error('Error loading overlay follow state:', error));
}

async function toggleOverlayPostFollow() {
	const authorId = currentPostAuthorId;
	if (!authorId) return;

	const btn = document.getElementById('overlay-post-follow-btn');
	if (btn) btn.disabled = true;

	try {
		const response = await apiFetch(`/api/users/${authorId}/follow`, { method: 'POST' });
		const data = await response.json().catch(() => null);

		if (!response.ok) {
			throw new Error((data && data.error) || 'Follow request failed');
		}

		setCachedRelationship(authorId, {
			following: data.following,
			followerCount: data.follower_count
		});

		if (String(currentPostAuthorId) === String(authorId)) {
			// Follow -> visible "Following" confirmation on this post's
			// overlay only; a later post from this author reads the cache
			// entry just set above via loadOverlayPostFollowState and stays
			// hidden instead. Unfollow -> visible "Follow" again, since it's
			// actionable once more.
			updateOverlayPostFollowButton(data.following);
			btn.classList.remove('hidden');
		}
	} catch (error) {
		console.error('Error toggling follow:', error);
		showToast(error.message || "Couldn't update follow status. Try again.");
	} finally {
		if (btn) btn.disabled = false;
	}
}

function updateOverlayPostFollowButton(following) {
	const btn = document.getElementById('overlay-post-follow-btn');
	const label = document.getElementById('overlay-post-follow-label');
	const icon = btn ? btn.querySelector('i') : null;
	if (!btn || !label) return;

	btn.dataset.following = String(following);
	if (following) {
		label.textContent = 'Following';
		if (icon) icon.className = 'fa-solid fa-check text-[11px]';
		btn.classList.remove('bg-gray-900', 'border-gray-900', 'text-white', 'hover:bg-gray-800');
		btn.classList.add('bg-white', 'border-gray-300', 'text-gray-900', 'hover:bg-gray-50');
	} else {
		label.textContent = 'Follow';
		if (icon) icon.className = 'fa-solid fa-plus text-[11px]';
		btn.classList.remove('bg-white', 'border-gray-300', 'text-gray-900', 'hover:bg-gray-50');
		btn.classList.add('bg-gray-900', 'border-gray-900', 'text-white', 'hover:bg-gray-800');
	}
}

function closeCommentOverlay() {
	const overlay = document.getElementById('comment-overlay');
	overlay.classList.add('hidden');
	document.body.classList.remove('overlay-open');
	currentPostId = null;
	currentPostAuthorId = null;
	closeOverlayPostMenu();

	// Clear state
	document.getElementById('overlay-reply-input').value = '';
	document.getElementById('overlay-reply-error').classList.add('hidden');
	document.getElementById('overlay-comments-container').innerHTML = '';
	cancelReplyContext();
	setReplyComposerExpanded(false);
	document.getElementById('overlay-reply-input').blur();
	updateReplyComposerState();
}

// ---- Post Action Menu (three-dot) ----
// All actions in this sheet are intentionally non-functional (visual only,
// tap feedback via CSS active: variants) — no handlers wired for
// data-action buttons yet. Delete lives only in the comment overlay's
// popover menu, not here.
function openPostMenu() {
	document.getElementById('post-menu-sheet').classList.remove('hidden');
	document.getElementById('post-menu-backdrop').classList.remove('hidden');
	document.body.classList.add('overlay-open');
}

function closePostMenu() {
	document.getElementById('post-menu-sheet').classList.add('hidden');
	document.getElementById('post-menu-backdrop').classList.add('hidden');
	document.body.classList.remove('overlay-open');
}

document.getElementById('post-menu-cancel-btn').addEventListener('click', closePostMenu);

// ---- Post & Comments overlay header menu (three-dot popover) ----
// Same non-functional convention as the feed card's post-menu-sheet for
// actions other than Delete. Delete is ownership-gated against
// currentPostAuthorId (set when the overlay opens) and re-checked
// server-side on the actual delete request.
function toggleOverlayPostMenu() {
	const popover = document.getElementById('overlay-menu-popover');
	const opening = popover.classList.contains('hidden');
	if (opening) {
		openOverlayPostMenu();
	} else {
		closeOverlayPostMenu();
	}
}

function openOverlayPostMenu() {
	const isOwner = isCurrentUserPostOwner(currentPostAuthorId);
	document.getElementById('overlay-menu-delete-btn').classList.toggle('hidden', !isOwner);
	document.getElementById('overlay-menu-delete-divider').classList.toggle('hidden', !isOwner);

	document.getElementById('overlay-menu-popover').classList.remove('hidden');
	document.getElementById('overlay-menu-backdrop').classList.remove('hidden');
	document.getElementById('overlay-menu-btn').setAttribute('aria-expanded', 'true');
}

function closeOverlayPostMenu() {
	document.getElementById('overlay-menu-popover').classList.add('hidden');
	document.getElementById('overlay-menu-backdrop').classList.add('hidden');
	document.getElementById('overlay-menu-btn').setAttribute('aria-expanded', 'false');
}

document.getElementById('overlay-menu-delete-btn').addEventListener('click', function() {
	const postId = currentPostId;
	closeOverlayPostMenu();
	openDeletePostDialog(postId);
});

// ---- Delete Post ----
let pendingDeletePostId = null;

function openDeletePostDialog(postId) {
	if (!postId) return;
	pendingDeletePostId = postId;
	document.getElementById('delete-post-backdrop').classList.remove('hidden');
	document.getElementById('delete-post-dialog').classList.remove('hidden');
}

function closeDeletePostDialog() {
	document.getElementById('delete-post-backdrop').classList.add('hidden');
	document.getElementById('delete-post-dialog').classList.add('hidden');
	pendingDeletePostId = null;
}

// Removes a post card from the DOM (feed + any place it's rendered) and
// restores each container's empty state if that was its last post. Only
// called after a confirmed successful server-side deletion.
function removePostFromDom(postId) {
	document.querySelectorAll(`article[data-post-id="${postId}"]`).forEach(card => card.remove());

	const feedContainer = document.getElementById('feed-posts-container');
	if (feedContainer && !feedContainer.querySelector('article[data-post-id]')) {
		feedContainer.innerHTML = `
<div class="flex items-center justify-center h-full min-h-[50vh] text-gray-400 text-sm">
No posts yet
</div>`;
	}

	const profileContainer = document.getElementById('profile-posts-container');
	if (profileContainer) {
		if (!profileContainer.querySelector('article[data-post-id]')) {
			profileContainer.innerHTML = `
<div class="flex flex-col items-center justify-center py-16 text-gray-400 text-sm gap-2">
<i class="fa-regular fa-note-sticky text-3xl text-gray-300"></i>
No posts yet
</div>`;
		}
		const countEl = document.getElementById('profile-posts-count');
		if (countEl) {
			const remaining = profileContainer.querySelectorAll('article[data-post-id]').length;
			countEl.textContent = remaining;
		}
	}
}

async function confirmDeletePost() {
	const postId = pendingDeletePostId;
	if (!postId) return;

	const confirmBtn = document.getElementById('delete-post-confirm-btn');
	const originalLabel = confirmBtn.textContent;
	confirmBtn.disabled = true;
	confirmBtn.textContent = 'Deleting…';

	try {
		const response = await apiFetch(`/api/posts/${postId}`, {
			method: 'DELETE',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			let message = 'Failed to delete post. Please try again.';
			try {
				const data = await response.json();
				if (data && data.error) message = data.error;
			} catch (parseError) {
				// Non-JSON error body; fall back to the generic message.
			}
			throw new Error(message);
		}

		// Success: drop the post from the feed and close anything referencing it.
		removePostFromDom(postId);

		if (currentPostId == postId) {
			closeCommentOverlay();
		}

		closeDeletePostDialog();
		showToast('Post deleted');
	} catch (error) {
		console.error('Error deleting post:', error);
		// Leave the post in the feed untouched — nothing was removed from the
		// DOM until the request succeeded, so there's no inconsistent state
		// to roll back. Just close the confirm dialog and surface the error.
		closeDeletePostDialog();
		showToast(error.message || 'Failed to delete post. Please try again.');
	} finally {
		confirmBtn.disabled = false;
		confirmBtn.textContent = originalLabel;
	}
}

document.getElementById('delete-post-confirm-btn').addEventListener('click', confirmDeletePost);

// Defensive-only: interactive-widget=resizes-content (meta tag) + the
// #comment-overlay dvh rule are what actually keep the reply bar above the
// keyboard now. This just nudges the input fully into view on focus, to
// cover slow keyboard-open animations or engines that honor dvh but are
// still mid-transition when focus lands. Doesn't resize or reposition
// anything itself — safe no-op once the layout is already correct.
document.getElementById('overlay-reply-input').addEventListener('focus', function() {
	const input = this;
	setTimeout(() => input.scrollIntoView({ block: 'nearest' }), 300);
});

// Raw comments for the currently-open post, kept around so switching sort
// order (Relevant/Oldest/Newest) is a client-side re-render instead of a
// refetch — the backend returns every comment for a post in one response,
// so we already have everything we need locally.
let currentPostComments = [];
let currentCommentSort = 'relevant';

// Which comment threads currently have their replies collapsed, keyed by
// comment id (string). Survives sort switches and comment inserts/deletes
// within the same post (those re-render or patch the DOM, and this set is
// what renderCommentNode/insertNewCommentIntoDom check to decide whether a
// given thread's .comment-children should render open or closed) - cleared
// per-post in openCommentOverlay so a collapsed thread on one post doesn't
// carry over into the next post opened.
let collapsedCommentIds = new Set();

async function fetchComments(postId) {
	try {
		const response = await fetch(`/api/posts/${postId}/comments`);

		if (!response.ok) {
			throw new Error('Failed to load comments');
		}

		const comments = await response.json();
		currentPostComments = comments;

		// Hide loading
		document.getElementById('overlay-loading').classList.add('hidden');

		// Update count badge
		document.getElementById('overlay-comments-count-badge').textContent = comments.length;

		if (comments.length === 0) {
			document.getElementById('overlay-empty').classList.remove('hidden');
		} else {
			applyCommentSort(currentCommentSort);
		}

	} catch (error) {
		console.error('Error loading comments:', error);
		document.getElementById('overlay-loading').classList.add('hidden');
		const errorDiv = document.getElementById('overlay-error');
		errorDiv.textContent = 'Failed to load comments. Please try again.';
		errorDiv.classList.remove('hidden');
	}
}

// Single source of truth for a comment row's markup — used on initial load
// (renderComments) and when a newly-posted comment is inserted
// (handleSendReply / insertNewCommentIntoDom), so the two paths can't drift
// out of sync.
//
// data-comment-user-id carries the author's user id (added by the backend
// alongside the existing comment fields) so the per-comment "..." menu can
// gate Delete to the comment's own author, checked again against `session`
// in isCurrentUserCommentOwner(). If the field is absent from the API
// response, ownership just evaluates false and only Report shows — no crash.
//
// Renders one comment node plus (recursively) its own replies nested inside
// a .comment-children wrapper - true depth-based nesting rather than a
// flattened, single-indent-level list, so a reply-to-a-reply visually
// stair-steps further right under its actual parent instead of collapsing
// back to one level. The connecting line is drawn in two pieces (see
// style.css): a straight "spine" (.thread-connector / .comment-children's
// left border) that runs for as long as a thread has descendants, and one
// "elbow" per parent→children transition (.comment-children::before) that
// bends the spine rightward into the first child's avatar - mirroring the
// "spine + elbow" connector pattern used by open-source nested-comment
// implementations (e.g. TryGhost/Ghost's comments-ui and the
// react-native-nested-comments-with-lines project) rather than a flat
// "Replying to @handle" label, which nesting makes redundant.
// Markup for a thread's collapse/expand row - only rendered when the
// comment actually has children. Renders as its own row below
// .comment-actions: a short dash line, a "View N replies"/"Hide replies"
// text label (gray, matching the like/dislike icon color - never the
// brand/gold accent), and a chevron. data-total-count is stashed on the
// button so the click handler (comment-actions.js) can rebuild the label
// text without recomputing the count itself. Shared between the initial
// recursive render (renderCommentNode) and the incremental insert path
// (insertNewCommentIntoDom / setReplyToggleCount) so the two can't drift
// out of sync.
function repliesToggleLabel(childCount, isCollapsed) {
	const noun = childCount === 1 ? 'reply' : 'replies';
	return isCollapsed ? `View ${childCount} ${noun}` : `Hide ${noun}`;
}

function buildRepliesToggleHtml(comment, childCount, isCollapsed) {
	if (childCount <= 0) return '';
	return `<div class="replies-toggle-row mt-2.5">
			<span class="replies-toggle-line"></span>
			<button type="button" class="comment-replies-toggle comment-action-btn text-gray-500 hover:text-gray-700 focus:outline-none${isCollapsed ? ' is-collapsed' : ''}" data-comment-id="${comment.id}" data-total-count="${childCount}" aria-expanded="${isCollapsed ? 'false' : 'true'}" aria-label="${isCollapsed ? 'Expand replies' : 'Collapse replies'}">
				<span class="text-[13px] font-semibold replies-toggle-label">${repliesToggleLabel(childCount, isCollapsed)}</span>
				<i class="fa-solid fa-chevron-down text-[11px] replies-toggle-chevron"></i>
			</button>
		</div>`;
}

// Total reply count for a comment's own subtree, counting every descendant
// (replies to replies, arbitrarily deep) rather than just direct children -
// this is what the "N replies" toggle displays, so replying several levels
// deep is reflected in every ancestor's count, not only its immediate
// parent's.
function countAllReplies(node) {
	return node.children.reduce(function(sum, child) {
		return sum + 1 + countAllReplies(child);
	}, 0);
}

function renderCommentNode(node, depth) {
	const comment = node.comment;
	const hasChildren = node.children.length > 0;
	const isCollapsed = hasChildren && collapsedCommentIds.has(String(comment.id));
	const avatarUrl = comment.author_avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(comment.author_handle)}`;
	const timeAgo = formatTimeAgo(comment.created_at);
	const likedClass = comment.liked_by_user ? 'text-brand-red' : 'text-gray-500';
	const dislikedClass = comment.disliked_by_user ? 'text-gray-900' : 'text-gray-500';
	const authorUserId = comment.user_id !== undefined && comment.user_id !== null ? String(comment.user_id) : '';
	const parentCommentId = comment.parent_comment_id !== undefined && comment.parent_comment_id !== null ? String(comment.parent_comment_id) : '';

	const connectorBar = hasChildren ? '<div class="thread-connector"></div>' : '';
	const totalReplies = countAllReplies(node);
	const repliesToggleHtml = buildRepliesToggleHtml(comment, totalReplies, isCollapsed);
	const childrenHtml = hasChildren
		? `<div class="comment-children${isCollapsed ? ' collapsed' : ''}">${node.children.map(function(child) { return renderCommentNode(child, depth + 1); }).join('')}</div>`
		: '';

	return `
	<article class="comment-thread" data-depth="${depth}">
		<div class="comment-row" data-comment-id="${comment.id}" data-comment-user-id="${escapeHtml(authorUserId)}" data-comment-author-handle="${escapeHtml(comment.author_handle)}" data-parent-comment-id="${escapeHtml(parentCommentId)}">
			<div class="thread-avatar-col shrink-0">
				<img alt="${escapeHtml(comment.author_name)}" class="comment-avatar rounded-full object-cover shrink-0" src="${avatarUrl}"/>
				${connectorBar}
			</div>
			<div class="flex-1 min-w-0">
				<div class="flex items-start justify-between gap-2">
					<div class="flex items-baseline gap-1.5 mb-0.5 flex-wrap">
						<span class="font-bold text-[13px] text-gray-900">${escapeHtml(comment.author_name)}</span>
						<span class="text-[13px] text-gray-500">@${escapeHtml(comment.author_handle)} · ${escapeHtml(timeAgo)}</span>
					</div>
					<button type="button" class="comment-menu-btn p-1 -mr-1 -mt-1 text-gray-400 hover:text-gray-600 focus:outline-none shrink-0" aria-label="Comment options">
						<i class="fa-solid fa-ellipsis-vertical text-[14px]"></i>
					</button>
				</div>
				<p class="text-[15px] leading-[1.4] text-gray-800 mb-2.5 whitespace-pre-wrap break-words">${escapeHtml(comment.content)}</p>
				<div class="comment-actions">
					<button type="button" class="comment-reply-btn comment-action-btn text-gray-500 hover:text-gray-700 focus:outline-none" aria-label="Reply" data-total-count="${totalReplies}">
						<span class="text-[13px] font-semibold">Reply</span>
					</button>
					<div class="comment-actions-right">
						<button class="like-btn-comment comment-action-btn focus:outline-none group transition-colors" data-comment-id="${comment.id}" data-liked="${comment.liked_by_user}">
							<span class="like-icon-wrapper">
								<svg class="w-[18px] h-[18px] ${likedClass} heart-outline" fill="none" stroke="currentColor" stroke-width="1.75" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
									<path d="M7 22h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14V5a3 3 0 0 0-3-3l-4 9v11z" stroke-linecap="round" stroke-linejoin="round"></path>
									<path d="M7 11H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" stroke-linecap="round" stroke-linejoin="round"></path>
								</svg>
								<svg class="w-[18px] h-[18px] text-brand-red heart-filled absolute inset-0" fill="currentColor" stroke="none" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
									<path d="M7 22h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14V5a3 3 0 0 0-3-3l-4 9v11z"></path>
									<path d="M7 11H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path>
								</svg>
							</span>
							<span class="text-[13px] like-count ${likedClass}">${comment.like_count}</span>
						</button>
						<button class="dislike-btn-comment comment-action-btn focus:outline-none group transition-colors" data-comment-id="${comment.id}" data-disliked="${comment.disliked_by_user ? true : false}">
							<span class="dislike-icon-wrapper">
								<svg class="w-[18px] h-[18px] ${dislikedClass} thumb-down-outline" fill="none" stroke="currentColor" stroke-width="1.75" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
									<path d="M17 2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10v5a3 3 0 0 0 3 3l4-9V2z" stroke-linecap="round" stroke-linejoin="round"></path>
									<path d="M17 13h3a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-3" stroke-linecap="round" stroke-linejoin="round"></path>
								</svg>
								<svg class="w-[18px] h-[18px] text-gray-900 thumb-down-filled absolute inset-0" fill="currentColor" stroke="none" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
									<path d="M17 2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10v5a3 3 0 0 0 3 3l4-9V2z"></path>
									<path d="M17 13h3a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-3"></path>
								</svg>
							</span>
						</button>
					</div>
				</div>
				${repliesToggleHtml}
			</div>
		</div>
		${childrenHtml}
	</article>`;
}

// Builds a real parent/children tree out of the flat comments array
// (parent_comment_id can point arbitrarily deep - a reply to a reply is
// valid data). Root order follows the order roots appear in `comments`
// (so callers can pre-sort top-level comments before calling this - see
// renderComments/sortTopLevelComments); each parent's children stay in
// their original chronological order regardless of that top-level sort.
function buildCommentTree(comments) {
	const childrenByParent = {};
	comments.forEach(function(c) {
		const key = c.parent_comment_id != null ? String(c.parent_comment_id) : 'root';
		if (!childrenByParent[key]) childrenByParent[key] = [];
		childrenByParent[key].push(c);
	});

	function buildNode(comment) {
		const kids = childrenByParent[String(comment.id)] || [];
		return { comment: comment, children: kids.map(buildNode) };
	}

	return (childrenByParent['root'] || []).map(buildNode);
}

function renderComments(comments) {
	const container = document.getElementById('overlay-comments-container');
	container.innerHTML = buildCommentTree(comments)
		.map(function(node) { return renderCommentNode(node, 0); })
		.join('');
}


// ---- Comment sort (Relevant / Newest) ----
// Client-side only: every comment for a post is already fetched in one
// request (see fetchComments), so switching sort order just reorders the
// cached array and re-renders — no network round trip needed.
//
// Only top-level comments are reordered by the chosen strategy; each
// comment's own replies stay attached to it and in chronological order,
// same as before sorting existed. "Relevant" has no real relevance signal
// on the backend yet, so it's approximated as most-liked-first (ties
// broken oldest-first) — a reasonable stand-in until/unless a real
// relevance ranking exists server-side.
function sortTopLevelComments(comments, sortKey) {
	const topLevel = comments.filter(function(c) { return c.parent_comment_id == null; });
	const replies = comments.filter(function(c) { return c.parent_comment_id != null; });

	let sortedTop;
	if (sortKey === 'newest') {
		sortedTop = topLevel.slice().sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });
	} else {
		sortedTop = topLevel.slice().sort(function(a, b) {
			return (b.like_count - a.like_count) || (new Date(a.created_at) - new Date(b.created_at));
		});
	}

	// buildCommentTree only cares about each root comment's position
	// relative to other roots (replies are grouped by parent_comment_id
	// regardless of array order), so appending replies after is enough to
	// preserve their existing grouping/order under the newly-ordered roots.
	return sortedTop.concat(replies);
}

function applyCommentSort(sortKey) {
	currentCommentSort = sortKey;
	updateCommentSortMenuUI();
	renderComments(sortTopLevelComments(currentPostComments, sortKey));
}

const COMMENT_SORT_LABELS = { relevant: 'Relevant', newest: 'Newest' };

function updateCommentSortMenuUI() {
	document.querySelectorAll('.comment-sort-option').forEach(function(btn) {
		const isSelected = btn.dataset.sort === currentCommentSort;
		btn.querySelector('.comment-sort-check').classList.toggle('hidden', !isSelected);
		btn.classList.toggle('bg-gray-50', isSelected);
	});
	const label = document.getElementById('comments-sort-label');
	if (label) label.textContent = COMMENT_SORT_LABELS[currentCommentSort] || 'Relevant';
}

function toggleCommentSortMenu() {
	const menu = document.getElementById('comments-sort-menu');
	if (menu.classList.contains('hidden')) {
		openCommentSortMenu();
	} else {
		closeCommentSortMenu();
	}
}

function openCommentSortMenu() {
	document.getElementById('comments-sort-menu').classList.remove('hidden');
	document.getElementById('comments-sort-backdrop').classList.remove('hidden');
	document.getElementById('comments-sort-chevron').classList.add('rotate-180');
	document.getElementById('comments-sort-trigger').setAttribute('aria-expanded', 'true');
}

function closeCommentSortMenu() {
	document.getElementById('comments-sort-menu').classList.add('hidden');
	document.getElementById('comments-sort-backdrop').classList.add('hidden');
	document.getElementById('comments-sort-chevron').classList.remove('rotate-180');
	document.getElementById('comments-sort-trigger').setAttribute('aria-expanded', 'false');
}

document.addEventListener('DOMContentLoaded', function() {
	document.querySelectorAll('.comment-sort-option').forEach(function(btn) {
		btn.addEventListener('click', function() {
			applyCommentSort(btn.dataset.sort);
			closeCommentSortMenu();
		});
	});
});

// Inserts a freshly-posted comment/reply into the already-rendered tree
// without a full refetch. Top-level comments append as a new root thread.
// Replies are appended into their parent's .comment-children wrapper,
// creating that wrapper (and the parent's connector bar) if this is the
// parent's first reply.
function insertNewCommentIntoDom(comment, parentCommentId) {
	const container = document.getElementById('overlay-comments-container');
	const node = { comment: comment, children: [] };

	if (!parentCommentId) {
		container.insertAdjacentHTML('beforeend', renderCommentNode(node, 0));
		return;
	}

	const parentRow = container.querySelector(`.comment-row[data-comment-id="${parentCommentId}"]`);
	const parentThread = parentRow ? parentRow.closest('.comment-thread') : null;

	if (!parentThread) {
		// Parent thread not found (shouldn't happen — its Reply button is
		// what set parentCommentId). Fall back to a new root so the comment
		// isn't lost.
		container.insertAdjacentHTML('beforeend', renderCommentNode(node, 0));
		return;
	}

	const parentDepth = parseInt(parentThread.dataset.depth || '0', 10);
	const html = renderCommentNode(node, parentDepth + 1);

	let childrenWrap = parentThread.querySelector(':scope > .comment-children');
	if (!childrenWrap) {
		parentThread.insertAdjacentHTML('beforeend', '<div class="comment-children"></div>');
		childrenWrap = parentThread.querySelector(':scope > .comment-children');
		const avatarCol = parentRow.querySelector('.thread-avatar-col');
		if (avatarCol && !avatarCol.querySelector('.thread-connector')) {
			avatarCol.insertAdjacentHTML('beforeend', '<div class="thread-connector"></div>');
		}
	}
	childrenWrap.insertAdjacentHTML('beforeend', html);

	// Un-collapse the immediate parent's thread so the just-posted reply is
	// visible right away, rather than landing inside a collapsed subtree.
	// (Ancestors further up are left as-is - only the thread actually
	// replied into force-expands.)
	childrenWrap.classList.remove('collapsed');
	collapsedCommentIds.delete(String(parentCommentId));
	const parentToggleBtn = parentRow.querySelector('.comment-replies-toggle');
	if (parentToggleBtn) {
		parentToggleBtn.classList.remove('is-collapsed');
		parentToggleBtn.setAttribute('aria-expanded', 'true');
	}

	updateReplyCountsUpChain(parentThread);
}

// Updates a single comment row's "View N replies" row to reflect a new
// total count, rebuilding it from scratch (rather than patching a number
// in place) since the label text itself ("View 3 replies" vs "Hide
// replies") depends on the count. Preserves whatever collapsed/expanded
// state the row was already in; removes the row entirely if totalCount
// drops to zero (shouldn't happen in practice - counts only grow via
// insertNewCommentIntoDom - but keeps this function correct either way).
function setReplyToggleCount(row, commentId, totalCount) {
	const existingRow = row.querySelector('.replies-toggle-row');
	const existingBtn = existingRow ? existingRow.querySelector('.comment-replies-toggle') : null;
	const isCollapsed = existingBtn
		? existingBtn.classList.contains('is-collapsed')
		: collapsedCommentIds.has(String(commentId));

	if (existingRow) existingRow.remove();
	if (totalCount <= 0) return;

	const actionsRow = row.querySelector('.comment-actions');
	if (!actionsRow) return;
	actionsRow.insertAdjacentHTML('afterend', buildRepliesToggleHtml({ id: commentId }, totalCount, isCollapsed));
}

// Walks from the directly-replied-to comment's thread up through every
// ancestor thread, recomputing each one's total (recursive) reply count
// straight from the live DOM and syncing its toggle. A reply nested several
// levels deep raises the total shown on every comment above it, not just
// its immediate parent, so a single-level increment isn't enough here.
function updateReplyCountsUpChain(startThread) {
	let thread = startThread;
	while (thread) {
		const row = thread.querySelector(':scope > .comment-row');
		const childrenWrap = thread.querySelector(':scope > .comment-children');
		const commentId = row ? row.dataset.commentId : null;
		if (row && childrenWrap && commentId) {
			const totalCount = childrenWrap.querySelectorAll('.comment-thread').length;
			setReplyToggleCount(row, commentId, totalCount);
		}
		const wrap = thread.parentElement;
		thread = (wrap && wrap.classList && wrap.classList.contains('comment-children'))
			? wrap.closest('.comment-thread')
			: null;
	}
}


// GPA calculator iframe back button -> return to Courses
window.addEventListener('message', (e) => {
	if (e.data === 'gpa-back') { showView('courses'); }
});

// Close overlay handlers
document.getElementById('close-overlay-btn').addEventListener('click', closeCommentOverlay);
document.getElementById('comment-overlay').addEventListener('click', function(e) {
	if (e.target === this) {
		closeCommentOverlay();
	}
});

// Reply input handlers
document.getElementById('overlay-reply-send-btn').addEventListener('click', handleSendReply);
// Enter behaviour: on desktop (fine pointer) Enter sends and Shift+Enter
// adds a line break; on touch devices Enter always adds a line break and
// the send button posts. Cmd/Ctrl+Enter sends everywhere.
document.getElementById('overlay-reply-input').addEventListener('keydown', function(e) {
	if (e.key !== 'Enter' || e.isComposing) return;
	const isFinePointer = window.matchMedia('(pointer: fine)').matches;
	const sendCombo = e.metaKey || e.ctrlKey;
	if (sendCombo || (isFinePointer && !e.shiftKey)) {
		e.preventDefault();
		if (!document.getElementById('overlay-reply-send-btn').disabled) handleSendReply();
	}
});

// Char counter + send-button enabled state, kept in sync on every keystroke.
// Mirrors the compose screen's submit-post-btn convention (disabled until
// there's content, swapped for a spinner while a request is in flight).
document.getElementById('overlay-reply-input').addEventListener('input', updateReplyComposerState);

function updateReplyComposerState() {
	const input = document.getElementById('overlay-reply-input');
	const counter = document.getElementById('overlay-reply-counter');
	const sendBtn = document.getElementById('overlay-reply-send-btn');
	const length = input.value.length;

	// Counter only appears as the limit gets close, to keep the bar quiet.
	if (length >= 800) {
		counter.textContent = `${length}/1000`;
		counter.classList.remove('hidden');
		counter.classList.toggle('text-red-500', length >= 980);
		counter.classList.toggle('text-gray-400', length < 980);
	} else {
		counter.classList.add('hidden');
	}

	sendBtn.disabled = input.value.trim().length === 0 || length > 1000 || isSubmittingComment;
	sendBtn.setAttribute('aria-disabled', String(sendBtn.disabled));

	syncReplyComposer();
}

// ---- Reply composer presentation (auto-grow, active/expanded state) ----
const replyComposerEl = document.getElementById('overlay-composer');
const replyInputEl = document.getElementById('overlay-reply-input');
const replyExpandBtn = document.getElementById('overlay-reply-expand-btn');
const REPLY_INPUT_MAX_PX = 132; // keep in sync with .reply-composer-input max-height

function isReplyComposerExpanded() {
	return replyComposerEl.dataset.expanded === 'true';
}

function syncReplyComposer() {
	const hasDraft = replyInputEl.value.length > 0;
	const hasFocus = replyComposerEl.contains(document.activeElement);
	const active = hasFocus || hasDraft || isReplyComposerExpanded();
	replyComposerEl.dataset.active = String(active);

	// Auto-grow: collapse to measure, then fit content up to the max.
	// Expanded mode uses a fixed CSS height instead.
	if (isReplyComposerExpanded()) {
		replyInputEl.style.height = '';
	} else {
		replyInputEl.style.height = 'auto';
		const next = Math.min(replyInputEl.scrollHeight, REPLY_INPUT_MAX_PX);
		replyInputEl.style.height = Math.max(next, 34) + 'px';
	}

	// Offer the expand control only once the draft is multi-line/overflowing
	// (or while already expanded, so it can be collapsed again).
	const overflowing = replyInputEl.scrollHeight > 34 + 22;
	replyExpandBtn.classList.toggle('hidden', !(active && (overflowing || isReplyComposerExpanded())));
}

function setReplyComposerExpanded(expanded) {
	replyComposerEl.dataset.expanded = String(expanded);
	replyExpandBtn.setAttribute('aria-pressed', String(expanded));
	replyExpandBtn.setAttribute('aria-label', expanded ? 'Collapse editor' : 'Expand editor');
	document.getElementById('overlay-reply-expand-icon').className = expanded
		? 'fa-solid fa-down-left-and-up-right-to-center text-[14px]'
		: 'fa-solid fa-up-right-and-down-left-from-center text-[14px]';
	syncReplyComposer();
}

replyExpandBtn.addEventListener('click', function() {
	setReplyComposerExpanded(!isReplyComposerExpanded());
	replyInputEl.focus();
});

replyComposerEl.addEventListener('focusin', syncReplyComposer);
replyComposerEl.addEventListener('focusout', function() {
	// Wait a tick so document.activeElement reflects where focus landed.
	setTimeout(syncReplyComposer, 0);
});

// Tapping a tool/send button must not steal focus from the input, or the
// keyboard would collapse and the composer would flicker back to idle.
replyComposerEl.addEventListener('mousedown', function(e) {
	if (e.target.closest('button')) e.preventDefault();
});

// Media attachments: the comments API is text-only today, so these are
// visible-but-inert entry points (same convention as the post menu's
// placeholder actions) until the backend accepts attachments.
replyComposerEl.addEventListener('click', function(e) {
	const tool = e.target.closest('[data-composer-tool]');
	if (!tool) return;
	showToast(tool.dataset.composerTool === 'gif' ? 'GIF replies are coming soon' : 'Image replies are coming soon');
});

// Paint the current user's avatar (same source/fallback as compose.js).
function updateReplyComposerAvatar() {
	const img = document.getElementById('overlay-composer-avatar');
	if (typeof session === 'undefined' || !session || !session.user) return;
	const user = session.user;
	const handle = user.username || (user.email ? user.email.split('@')[0] : '');
	const src = user.profile_picture || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
	if (img.getAttribute('src') !== src) img.src = src;
}

function setReplySendLoading(isLoading) {
	const sendBtn = document.getElementById('overlay-reply-send-btn');
	const spinner = document.getElementById('overlay-reply-send-spinner');
	const icon = document.getElementById('overlay-reply-send-icon');

	sendBtn.setAttribute('aria-busy', String(isLoading));
	spinner.classList.toggle('hidden', !isLoading);
	icon.classList.toggle('hidden', isLoading);

	if (isLoading) {
		sendBtn.disabled = true;
	} else {
		updateReplyComposerState();
	}
}

