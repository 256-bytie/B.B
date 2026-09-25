// ---- Reply-to-a-specific-comment context ----
// Backend now has real parent_comment_id threading (see app/routes/posts.py).
// Tapping "Reply" on a comment or reply records that comment's id as the
// pending parent and shows a removable "Replying to @handle" context chip.
// The input text itself is left untouched — no more @handle text-prefix
// hack — the parent id travels out-of-band and is sent as JSON on submit.
let replyingToCommentId = null;
let replyingToHandle = null;

function startReplyTo(commentId, handle) {
	replyingToCommentId = commentId;
	replyingToHandle = handle;

	const context = document.getElementById('overlay-reply-context');
	document.getElementById('overlay-reply-context-handle').textContent = `@${handle}`;
	context.classList.remove('hidden');
	context.classList.add('flex');

	const input = document.getElementById('overlay-reply-input');
	input.focus();
}

function cancelReplyContext() {
	replyingToCommentId = null;
	replyingToHandle = null;

	const context = document.getElementById('overlay-reply-context');
	context.classList.add('hidden');
	context.classList.remove('flex');
}

document.getElementById('overlay-reply-context-cancel').addEventListener('click', cancelReplyContext);

document.addEventListener('click', function(e) {
	const replyBtn = e.target.closest('.comment-reply-btn');
	if (!replyBtn) return;
	const commentRow = replyBtn.closest('[data-comment-id]');
	if (!commentRow) return;
	startReplyTo(commentRow.dataset.commentId, commentRow.dataset.commentAuthorHandle);
});

// ---- Reply-thread collapse/expand ----
// Toggles a comment's own .comment-children subtree (its whole nested
// reply chain, since deeper replies live inside it as real DOM
// descendants - no separate grandchild handling needed). State is tracked
// in collapsedCommentIds (comments.js) so it survives sort switches and
// insert/delete re-renders within the same post's overlay.
document.addEventListener('click', function(e) {
	const toggleBtn = e.target.closest('.comment-replies-toggle');
	if (!toggleBtn) return;

	const thread = toggleBtn.closest('.comment-thread');
	const childrenWrap = thread ? thread.querySelector(':scope > .comment-children') : null;
	if (!childrenWrap) return;

	const nowCollapsed = childrenWrap.classList.toggle('collapsed');
	toggleBtn.classList.toggle('is-collapsed', nowCollapsed);
	toggleBtn.setAttribute('aria-expanded', String(!nowCollapsed));
	toggleBtn.setAttribute('aria-label', nowCollapsed ? 'Expand replies' : 'Collapse replies');

	const labelSpan = toggleBtn.querySelector('.replies-toggle-label');
	const totalCount = parseInt(toggleBtn.dataset.totalCount || '0', 10);
	if (labelSpan) labelSpan.textContent = repliesToggleLabel(totalCount, nowCollapsed);

	const commentId = toggleBtn.dataset.commentId;
	if (nowCollapsed) {
		collapsedCommentIds.add(String(commentId));
	} else {
		collapsedCommentIds.delete(String(commentId));
	}
});

// ---- Per-comment "..." menu (Reply / Copy / Report / Delete) ----
// Same bottom-sheet convention as the feed card's post-menu-sheet. Delete is
// ownership-gated against data-comment-user-id and re-checked server-side.
let activeCommentMenuId = null;
let activeCommentMenuUserId = null;
let activeCommentMenuHandle = null;

function isCurrentUserCommentOwner(authorUserId) {
	return !!(session && session.user && authorUserId && String(session.user.id) === String(authorUserId));
}

document.addEventListener('click', function(e) {
	const menuBtn = e.target.closest('.comment-menu-btn');
	if (!menuBtn) return;
	const commentRow = menuBtn.closest('[data-comment-id]');
	if (!commentRow) return;

	activeCommentMenuId = commentRow.dataset.commentId;
	activeCommentMenuUserId = commentRow.dataset.commentUserId;
	activeCommentMenuHandle = commentRow.dataset.commentAuthorHandle;

	openCommentMenu();
});

function openCommentMenu() {
	const isOwner = isCurrentUserCommentOwner(activeCommentMenuUserId);
	document.getElementById('comment-menu-delete-group').classList.toggle('hidden', !isOwner);
	document.getElementById('comment-menu-report-group').classList.toggle('hidden', isOwner);

	document.getElementById('comment-menu-sheet').classList.remove('hidden');
	document.getElementById('comment-menu-backdrop').classList.remove('hidden');
}

function closeCommentMenu() {
	document.getElementById('comment-menu-sheet').classList.add('hidden');
	document.getElementById('comment-menu-backdrop').classList.add('hidden');
}

document.getElementById('comment-menu-cancel-btn').addEventListener('click', closeCommentMenu);

document.getElementById('comment-menu-reply-btn').addEventListener('click', function() {
	const commentId = activeCommentMenuId;
	const handle = activeCommentMenuHandle;
	closeCommentMenu();
	if (commentId && handle) startReplyTo(commentId, handle);
});

document.getElementById('comment-menu-copy-btn').addEventListener('click', async function() {
	const row = document.querySelector(`[data-comment-id="${activeCommentMenuId}"]`);
	const text = row ? row.querySelector('p').textContent : '';
	closeCommentMenu();
	try {
		await navigator.clipboard.writeText(text);
		showToast('Comment copied');
	} catch (error) {
		showToast('Could not copy comment');
	}
});

document.getElementById('comment-menu-report-btn').addEventListener('click', function() {
	closeCommentMenu();
	showToast('Comment reported');
});

document.getElementById('comment-menu-delete-btn').addEventListener('click', function() {
	const commentId = activeCommentMenuId;
	closeCommentMenu();
	openDeleteCommentDialog(commentId);
});

// ---- Delete Comment ----
let pendingDeleteCommentId = null;

function openDeleteCommentDialog(commentId) {
	if (!commentId) return;
	pendingDeleteCommentId = commentId;
	document.getElementById('delete-comment-backdrop').classList.remove('hidden');
	document.getElementById('delete-comment-dialog').classList.remove('hidden');
}

function closeDeleteCommentDialog() {
	document.getElementById('delete-comment-backdrop').classList.add('hidden');
	document.getElementById('delete-comment-dialog').classList.add('hidden');
	pendingDeleteCommentId = null;
}

// Removes a comment row from the DOM and reconciles every comment-count
// display (overlay Comments badge, overlay stat, feed/profile cards) against
// the number of rows actually left — same convention as removePostFromDom.
// Removes a comment row and reconciles every comment-count display (overlay
// Comments badge, overlay stat, feed/profile cards) against the number of
// rows actually left - same convention as removePostFromDom. Re-renders
// the whole list from the updated cache rather than patching the DOM
// in place: deleting a mid-thread reply can leave a *different* row as
// the new last-in-thread (needing a connector bar added) or as the new
// only-row (needing one removed), and comment lists are small enough that
// a full re-render is simpler and safer than enumerating those cases by
// hand.
function removeCommentFromDom(commentId) {
	currentPostComments = currentPostComments.filter(function(c) { return String(c.id) !== String(commentId); });
	collapsedCommentIds.delete(String(commentId));

	const remaining = currentPostComments.length;
	renderComments(sortTopLevelComments(currentPostComments, currentCommentSort));

	if (remaining === 0) {
		document.getElementById('overlay-empty').classList.remove('hidden');
	}

	document.getElementById('overlay-comments-count-badge').textContent = remaining;
	setPostCountSpan(document.getElementById('overlay-post-comments'), remaining);

	document.querySelectorAll(`article[data-post-id="${currentPostId}"]`).forEach(function(feedCard) {
		const commentCountSpan = feedCard.querySelector('.comment-count');
		setPostCountSpan(commentCountSpan, remaining);
		feedCard.dataset.postCommentCount = remaining;
	});
}

async function confirmDeleteComment() {
	const commentId = pendingDeleteCommentId;
	if (!commentId) return;

	const confirmBtn = document.getElementById('delete-comment-confirm-btn');
	const originalLabel = confirmBtn.textContent;
	confirmBtn.disabled = true;
	confirmBtn.textContent = 'Deleting…';

	try {
		const response = await apiFetch(`/api/comments/${commentId}`, {
			method: 'DELETE',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			let message = 'Failed to delete comment. Please try again.';
			try {
				const data = await response.json();
				if (data && data.error) message = data.error;
			} catch (parseError) {
				// Non-JSON error body; fall back to the generic message.
			}
			throw new Error(message);
		}

		removeCommentFromDom(commentId);
		closeDeleteCommentDialog();
		showToast('Comment deleted');
	} catch (error) {
		console.error('Error deleting comment:', error);
		closeDeleteCommentDialog();
		showToast(error.message || 'Failed to delete comment. Please try again.');
	} finally {
		confirmBtn.disabled = false;
		confirmBtn.textContent = originalLabel;
	}
}

document.getElementById('delete-comment-confirm-btn').addEventListener('click', confirmDeleteComment);

let isSubmittingComment = false;

async function handleSendReply() {
	if (isSubmittingComment) return;

	// Check if logged in
	if (!session || !session.user || !session.user.id) {
		const errorDiv = document.getElementById('overlay-reply-error');
		errorDiv.textContent = 'Please log in to post a comment.';
		errorDiv.classList.remove('hidden');
		setTimeout(() => {
			closeCommentOverlay();
			showView('login');
		}, 1500);
		return;
	}

	const input = document.getElementById('overlay-reply-input');
	const content = input.value.trim();
	const errorDiv = document.getElementById('overlay-reply-error');

	errorDiv.classList.add('hidden');

	if (!content) {
		errorDiv.textContent = 'Comment cannot be empty.';
		errorDiv.classList.remove('hidden');
		return;
	}

	if (content.length > 1000) {
		errorDiv.textContent = 'Comment too long (max 1000 characters).';
		errorDiv.classList.remove('hidden');
		return;
	}

	isSubmittingComment = true;
	setReplySendLoading(true);

	// Capture the pending reply target before it's cleared below — needed
	// both for the request body and for placing the new row in the DOM.
	const parentCommentId = replyingToCommentId;
	const parentHandle = replyingToHandle;

	try {
		const body = { content };
		if (parentCommentId) {
			body.parent_comment_id = parentCommentId;
		}

		const response = await apiFetch(`/api/posts/${currentPostId}/comments`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		});

		const data = await response.json();

		if (!response.ok) {
			throw new Error(data.error || 'Failed to post comment');
		}

		// Clear input and any active "Replying to" context
		input.value = '';
		cancelReplyContext();

		// Add new comment to list
		const isEmpty = document.getElementById('overlay-empty').classList.contains('hidden') === false;

		if (isEmpty) {
			document.getElementById('overlay-empty').classList.add('hidden');
		}

		// Own comment: attribute it to the logged-in user even if the
		// backend response doesn't include user_id yet, so the "..." menu
		// can offer Delete on it right away.
		if (data.user_id === undefined || data.user_id === null) {
			data.user_id = session.user.id;
		}
		if (data.parent_comment_id === undefined) {
			data.parent_comment_id = parentCommentId || null;
		}

		insertNewCommentIntoDom(data, parentCommentId, parentHandle);

		// Keep the cached raw list in sync so subsequent re-sorts (Relevant/
		// Oldest/Newest) include the just-posted comment too.
		currentPostComments.push(data);

		// Update comment count (badge in the Comments pill + post header)
		const currentCount = parseInt(document.getElementById('overlay-post-comments').textContent);
		const newCount = currentCount + 1;
		document.getElementById('overlay-comments-count-badge').textContent = newCount;
		setPostCountSpan(document.getElementById('overlay-post-comments'), newCount);

		// Update comment count on every rendered instance of this card
		// (feed + profile can both have it mounted at once)
		document.querySelectorAll(`article[data-post-id="${currentPostId}"]`).forEach(function(feedCard) {
			const commentCountSpan = feedCard.querySelector('.comment-count');
			setPostCountSpan(commentCountSpan, newCount);
			feedCard.dataset.postCommentCount = newCount;
		});

	} catch (error) {
		console.error('Error posting comment:', error);
		errorDiv.textContent = error.message || 'Failed to post comment. Please try again.';
		errorDiv.classList.remove('hidden');
	} finally {
		isSubmittingComment = false;
		setReplySendLoading(false);
	}
}

// Store session info globally for easy access
let session = null;
async function updateSessionInfo() {
	try {
		const response = await fetch('/api/session');
		const data = await response.json();
		setCsrfTokenFromResponseData(data);
		if (data.logged_in) {
			session = data;
			updateFeedHeaderAvatar();
			updateBottomNavAvatar();
		} else {
			session = null;
		}
	} catch (error) {
		session = null;
	}
}

// Populate the feed header avatar (top-left, opens the side nav)
function updateFeedHeaderAvatar() {
	const avatarEl = document.getElementById('feed-header-avatar');
	if (!avatarEl) return;

	if (!session || !session.user) return;

	const handle = session.user.username || session.user.email.split('@')[0];
	avatarEl.src = session.user.profile_picture || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
}

// Populate the bottom-nav Profile tab's avatar photo (same src convention
// as updateFeedHeaderAvatar/populateSideNav above).
function updateBottomNavAvatar() {
	const avatarEl = document.getElementById('bottom-nav-avatar-img');
	if (!avatarEl) return;

	if (!session || !session.user) return;

	const handle = session.user.username || session.user.email.split('@')[0];
	avatarEl.src = session.user.profile_picture || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
}

// Update session on load and after login/signup
updateSessionInfo();

// Overlay post like button click handler
document.addEventListener('click', async function(e) {
	const overlayLikeBtn = e.target.closest('#overlay-post-like-btn');
	if (!overlayLikeBtn) return;

	e.preventDefault();
	e.stopPropagation();

	const isLiked = overlayLikeBtn.dataset.liked === 'true';
	const likeCountSpan = document.getElementById('overlay-post-likes');
	const iconWrapper = overlayLikeBtn.querySelector('.like-icon-wrapper');
	const heartOutline = overlayLikeBtn.querySelector('.heart-outline');
	const heartFilled = overlayLikeBtn.querySelector('.heart-filled');

	// Store original state for rollback
	const originalCount = parseInt(likeCountSpan.textContent);
	const originalLiked = isLiked;

	// Optimistic update
	const newLiked = !isLiked;
	const newCount = newLiked ? originalCount + 1 : originalCount - 1;

	overlayLikeBtn.dataset.liked = newLiked;

	// Add count change animation
	likeCountSpan.classList.add('count-changing');
	setPostCountSpan(likeCountSpan, newCount);
	setTimeout(() => likeCountSpan.classList.remove('count-changing'), 140);

	if (newLiked) {
		// Liking animation
		overlayLikeBtn.classList.add('is-liking');
		heartOutline.classList.remove('text-gray-700');
		heartOutline.classList.add('text-brand-red');
		likeCountSpan.classList.remove('text-gray-700');
		likeCountSpan.classList.add('text-brand-red');

		// Remove animation class after it completes
		setTimeout(() => overlayLikeBtn.classList.remove('is-liking'), 550);
	} else {
		// Unliking animation
		overlayLikeBtn.classList.add('is-unliking');
		heartOutline.classList.remove('text-brand-red');
		heartOutline.classList.add('text-gray-700');
		likeCountSpan.classList.remove('text-brand-red');
		likeCountSpan.classList.add('text-gray-700');

		// Remove animation class after it completes
		setTimeout(() => overlayLikeBtn.classList.remove('is-unliking'), 180);
	}

	try {
		const response = await apiFetch(`/api/posts/${currentPostId}/like`, {
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
		overlayLikeBtn.dataset.liked = data.liked;
		setPostCountSpan(likeCountSpan, data.like_count);

		// Sync every rendered instance of this card (feed + profile can
		// both have it mounted at once)
		document.querySelectorAll(`article[data-post-id="${currentPostId}"]`).forEach(function(feedCard) {
			const feedLikeBtn = feedCard.querySelector('.like-btn');
			const feedLikeCount = feedCard.querySelector('.like-count');
			const feedHeartOutline = feedLikeBtn.querySelector('.heart-outline');

			feedLikeBtn.dataset.liked = data.liked;
			setPostCountSpan(feedLikeCount, data.like_count);
			feedCard.dataset.postLiked = data.liked;
			feedCard.dataset.postLikeCount = data.like_count;

			if (data.liked) {
				feedHeartOutline.classList.remove('text-gray-500');
				feedHeartOutline.classList.add('text-brand-red');
				feedLikeCount.classList.remove('text-gray-500');
				feedLikeCount.classList.add('text-brand-red');
			} else {
				feedHeartOutline.classList.remove('text-brand-red');
				feedHeartOutline.classList.add('text-gray-500');
				feedLikeCount.classList.remove('text-brand-red');
				feedLikeCount.classList.add('text-gray-500');
			}
		});

	} catch (error) {
		console.error('Error liking post:', error);

		// Revert optimistic update
		overlayLikeBtn.dataset.liked = originalLiked;
		setPostCountSpan(likeCountSpan, originalCount);

		if (originalLiked) {
			heartOutline.classList.remove('text-gray-700');
			heartOutline.classList.add('text-brand-red');
			likeCountSpan.classList.remove('text-gray-700');
			likeCountSpan.classList.add('text-brand-red');
		} else {
			heartOutline.classList.remove('text-brand-red');
			heartOutline.classList.add('text-gray-700');
			likeCountSpan.classList.remove('text-brand-red');
			likeCountSpan.classList.add('text-gray-700');
		}
	}
});

// Comment like button click handler
document.addEventListener('click', async function(e) {
	const likeBtn = e.target.closest('.like-btn-comment');
	if (!likeBtn) return;

	e.preventDefault();
	e.stopPropagation();

	const commentId = likeBtn.dataset.commentId;
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
	likeCountSpan.textContent = newCount;
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

	try {
		const response = await apiFetch(`/api/comments/${commentId}/like`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error('Failed to like comment');
		}

		const data = await response.json();

		// Reconcile with server response
		likeBtn.dataset.liked = data.liked;
		likeCountSpan.textContent = data.like_count;

	} catch (error) {
		console.error('Error liking comment:', error);

		// Revert optimistic update
		likeBtn.dataset.liked = originalLiked;
		likeCountSpan.textContent = originalCount;

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
	}
});

// Comment dislike button click handler. Mutually exclusive with like:
// disliking a comment the user had liked clears the like state (and vice
// versa), matching the up/down pairing in the reference UI.
document.addEventListener('click', async function(e) {
	const dislikeBtn = e.target.closest('.dislike-btn-comment');
	if (!dislikeBtn) return;

	e.preventDefault();
	e.stopPropagation();

	const commentId = dislikeBtn.dataset.commentId;
	const isDisliked = dislikeBtn.dataset.disliked === 'true';
	const thumbOutline = dislikeBtn.querySelector('.thumb-down-outline');

	const commentRow = dislikeBtn.closest('.comment-row');
	const likeBtn = commentRow ? commentRow.querySelector('.like-btn-comment') : null;
	const likeCountSpan = likeBtn ? likeBtn.querySelector('.like-count') : null;
	const likeHeartOutline = likeBtn ? likeBtn.querySelector('.heart-outline') : null;

	const originalDisliked = isDisliked;
	const originalLikedState = likeBtn ? likeBtn.dataset.liked === 'true' : false;
	const originalLikeCount = likeCountSpan ? parseInt(likeCountSpan.textContent) : null;

	const newDisliked = !isDisliked;
	dislikeBtn.dataset.disliked = newDisliked;

	if (newDisliked) {
		dislikeBtn.classList.add('is-disliking');
		thumbOutline.classList.remove('text-gray-500');
		thumbOutline.classList.add('text-gray-900');
		setTimeout(() => dislikeBtn.classList.remove('is-disliking'), 400);

		// Clear an existing like optimistically - the backend enforces the
		// same exclusivity, this just keeps the two buttons in sync.
		if (likeBtn && originalLikedState) {
			likeBtn.dataset.liked = false;
			likeHeartOutline.classList.remove('text-brand-red');
			likeHeartOutline.classList.add('text-gray-500');
			if (likeCountSpan) {
				likeCountSpan.textContent = originalLikeCount - 1;
				likeCountSpan.classList.remove('text-brand-red');
				likeCountSpan.classList.add('text-gray-500');
			}
		}
	} else {
		dislikeBtn.classList.add('is-undisliking');
		thumbOutline.classList.remove('text-gray-900');
		thumbOutline.classList.add('text-gray-500');
		setTimeout(() => dislikeBtn.classList.remove('is-undisliking'), 180);
	}

	try {
		const response = await apiFetch(`/api/comments/${commentId}/dislike`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error('Failed to dislike comment');
		}

		const data = await response.json();

		// Reconcile with server response (server is the source of truth for
		// exclusivity between like/dislike).
		dislikeBtn.dataset.disliked = data.disliked;
		if (likeBtn) {
			likeBtn.dataset.liked = data.liked;
			if (likeCountSpan) likeCountSpan.textContent = data.like_count;
			if (data.liked) {
				likeHeartOutline.classList.remove('text-gray-500');
				likeHeartOutline.classList.add('text-brand-red');
				if (likeCountSpan) {
					likeCountSpan.classList.remove('text-gray-500');
					likeCountSpan.classList.add('text-brand-red');
				}
			} else {
				likeHeartOutline.classList.remove('text-brand-red');
				likeHeartOutline.classList.add('text-gray-500');
				if (likeCountSpan) {
					likeCountSpan.classList.remove('text-brand-red');
					likeCountSpan.classList.add('text-gray-500');
				}
			}
		}

	} catch (error) {
		console.error('Error disliking comment:', error);

		// Revert optimistic update
		dislikeBtn.dataset.disliked = originalDisliked;
		if (originalDisliked) {
			thumbOutline.classList.remove('text-gray-500');
			thumbOutline.classList.add('text-gray-900');
		} else {
			thumbOutline.classList.remove('text-gray-900');
			thumbOutline.classList.add('text-gray-500');
		}

		if (likeBtn) {
			likeBtn.dataset.liked = originalLikedState;
			if (likeCountSpan) likeCountSpan.textContent = originalLikeCount;
			if (originalLikedState) {
				likeHeartOutline.classList.remove('text-gray-500');
				likeHeartOutline.classList.add('text-brand-red');
				if (likeCountSpan) {
					likeCountSpan.classList.remove('text-gray-500');
					likeCountSpan.classList.add('text-brand-red');
				}
			}
		}
	}
});
