// Another user's profile screen (opened from a post card) plus the
// follow/relationship-cache logic behind it. Split out of profile.js —
// see profile-own.js for the own-profile counterpart.

// ---- User Profile View (another user's profile, opened from a post card) ----
// The view is a takeover screen (like create-post), not a bottom-nav tab.
// It's populated from the data already sitting on the clicked post card's
// dataset - same convention as the comment overlay (see CLAUDE.md) - so no
// per-user GET endpoint is required.
let userProfileReturnView = 'feed';
let currentUserProfileTarget = null;

// Relationship cache: per-user follow state and follower/following counts,
// keyed by user id (string). Only this screen reads/writes it today, but
// it's keyed by id rather than held as a bare boolean so any future surface
// (search result, followers list row, comment author) can share the same
// source of truth instead of re-fetching and re-implementing this pattern.
// Only ever populated from server responses - never written speculatively.
const userRelationshipCache = new Map();

function getCachedRelationship(userId) {
    return userRelationshipCache.get(String(userId));
}

function setCachedRelationship(userId, patch) {
    const key = String(userId);
    const existing = userRelationshipCache.get(key) || {};
    userRelationshipCache.set(key, Object.assign({}, existing, patch));
}

function openUserProfileView(user) {
    if (!user || user.id === undefined || user.id === null) return;

    // Tapping your own avatar/name goes to your own profile, not this screen
    if (session && session.user && String(user.id) === String(session.user.id)) {
        showView('profile');
        return;
    }

    const activeEl = document.querySelector('.view-section.active');
    const activeViewName = activeEl ? activeEl.id.replace('-view', '') : 'feed';

    // Only capture the return view when arriving from outside this screen.
    // Post cards inside a profile's own Posts tab are authored by that same
    // profile (see renderUserProfileView), so tapping one re-enters this
    // screen while it's already active - if that were allowed to overwrite
    // userProfileReturnView, it would point back at 'user-profile' itself,
    // and Back would just re-show the same screen forever instead of
    // returning to where the user actually came from.
    if (activeViewName !== 'user-profile') {
        userProfileReturnView = activeViewName;
    }
    currentUserProfileTarget = user;
    showView('user-profile');
}

// Reads the author fields already serialized onto a post card's dataset
// (see buildPostCardHtml) and opens that author's profile screen.
function openProfileFromPostCard(el) {
    const card = el.closest('article[data-post-user-id]');
    if (!card) return;
    openUserProfileView({
        id: card.dataset.postUserId,
        name: card.dataset.postAuthorName,
        handle: card.dataset.postAuthorHandle,
        avatar: card.dataset.postAuthorAvatar
    });
}

function closeUserProfileView() {
    showView(userProfileReturnView || 'feed');
}

// Applies one user's fields (as returned by GET /api/users/<id>) to the
// screen's avatar/cover/name/handle. Used for both the fast paint (from the
// clicked post card's dataset, which has no cover_image) and the
// authoritative repaint (from the backend, which does).
function paintUserProfileHeader(user) {
    if (!user) return;

    const avatarUrl = user.avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(user.handle || user.name || '')}`;
    const avatarImg = document.getElementById('user-profile-avatar-img');
    if (avatarImg) {
        avatarImg.src = avatarUrl;
        avatarImg.alt = user.name || '';
    }

    const coverImg = document.getElementById('user-profile-cover-img');
    if (coverImg) {
        if (user.cover) {
            coverImg.src = user.cover;
            coverImg.classList.remove('hidden');
        } else {
            coverImg.removeAttribute('src');
            coverImg.classList.add('hidden');
        }
    }

    const nameEl = document.getElementById('user-profile-name');
    if (nameEl) nameEl.textContent = user.name || '';
    const handleEl = document.getElementById('user-profile-handle');
    if (handleEl) handleEl.textContent = user.handle ? `@${user.handle}` : '';

    // Fast paint (from the post card's dataset) has no bio field, so this
    // hides it until the authoritative fetch below resolves with the real
    // value - never shows a stale bio left over from a previously viewed
    // profile.
    renderUserProfileBio(user.bio || null);
}

async function renderUserProfileView() {
    const target = currentUserProfileTarget;
    if (!target) {
        closeUserProfileView();
        return;
    }

    // The id this screen was opened for - captured so a slow fetch can't
    // paint over a different profile if the user backs out and opens
    // another one before it resolves.
    const requestedUserId = target.id;

    // Fast paint from the post card's own dataset (no cover_image in it -
    // the cover stays hidden/default until the authoritative fetch below).
    paintUserProfileHeader({
        id: target.id,
        name: target.name,
        handle: target.handle,
        avatar: target.avatar,
        cover: null
    });

    // Reset to a neutral state before the authoritative fetch resolves,
    // then repainted below from the real is_following/follower_count once
    // it returns - never trusted as the final answer on its own.
    updateUserProfileFollowButton(false);
    switchUserProfileTab('posts');

    const container = document.getElementById('user-profile-posts-container');
    if (container) {
        container.innerHTML = `
<div class="flex items-center justify-center py-16 text-gray-400 text-sm">
Loading posts...
</div>`;
    }

    // Authoritative fetch: this user's real name/handle/avatar/cover_image,
    // looked up directly by id rather than assumed from whatever post card
    // was clicked, so the screen always reflects the viewed user - never
    // the current session user.
    try {
        const profileResponse = await fetch(`/api/users/${requestedUserId}`);
        if (profileResponse.ok) {
            const profile = await profileResponse.json();
            if (requestedUserId === currentUserProfileTarget?.id) {
                paintUserProfileHeader({
                    id: profile.id,
                    name: profile.full_name,
                    handle: profile.handle,
                    avatar: profile.profile_picture,
                    cover: profile.cover_image,
                    bio: profile.bio
                });
                const countEl = document.getElementById('user-profile-posts-count');
                if (countEl) countEl.textContent = profile.post_count;

                // Follow state and follower/following counts come straight
                // from the `follows` table via this response - not from any
                // leftover client-side toggle state - so a refresh always
                // shows what's actually persisted.
                const followersEl = document.getElementById('user-profile-followers-count');
                if (followersEl) followersEl.textContent = profile.follower_count;
                const followingEl = document.getElementById('user-profile-following-count');
                if (followingEl) followingEl.textContent = profile.following_count;

                setCachedRelationship(requestedUserId, {
                    following: !!profile.is_following,
                    followerCount: profile.follower_count,
                    followingCount: profile.following_count
                });
                updateUserProfileFollowButton(!!profile.is_following);
            }
        }
    } catch (error) {
        console.error('Error loading user public profile:', error);
        // Non-fatal: the fast-paint values from the post card stay on screen.
    }

    if (!container) return;

    await loadProfilePostsPage(
        requestedUserId,
        'user-profile-posts-container',
        null,
        () => currentUserProfileTarget?.id
    );
}

function switchUserProfileTab(tabName) {
    const tabs = ['posts', 'saved', 'likes'];
    tabs.forEach(function(name) {
        const tabBtn = document.getElementById(`user-profile-tab-${name}`);
        const panel = document.getElementById(`user-profile-${name}-panel`);
        const isActive = name === tabName;

        if (tabBtn) {
            tabBtn.classList.toggle('text-gray-900', isActive);
            tabBtn.classList.toggle('border-gray-900', isActive);
            tabBtn.classList.toggle('text-gray-400', !isActive);
            tabBtn.classList.toggle('border-transparent', !isActive);
        }
        if (panel) {
            panel.classList.toggle('hidden', !isActive);
        }
    });
}

document.querySelectorAll('.user-profile-tab').forEach(function(tabBtn) {
    tabBtn.addEventListener('click', function() {
        switchUserProfileTab(tabBtn.dataset.tab);
    });
});

// Persists the follow relationship server-side (POST /api/users/<id>/follow,
// same toggle-and-return-truth pattern as the existing like_post endpoint)
// so it and the follower count survive a refresh instead of living only in
// this tab's in-memory state.
//
// Not optimistic: the button stays disabled and unchanged until the server
// responds, then repaints from that response only. This means there's no
// rollback path to maintain (nothing is applied before confirmation) at
// the cost of the button feeling latency-bound. If optimistic updates are
// wanted later, this is the function to change - apply the flip immediately
// on tap, keep the pre-toggle state to revert to, and only then wire a
// rollback branch into the catch block below.
async function toggleUserProfileFollow() {
    const target = currentUserProfileTarget;
    if (!target || !target.id) return;

    // Captured now, not re-read after the await: if the user backs out of
    // this screen and opens a different profile before the request
    // resolves, the response below must not get painted onto whichever
    // profile happens to be on screen when it lands.
    const requestedUserId = target.id;

    const btn = document.getElementById('user-profile-follow-btn');
    if (btn) btn.disabled = true;

    try {
        const response = await apiFetch(`/api/users/${requestedUserId}/follow`, { method: 'POST' });
        const data = await response.json().catch(() => null);

        if (!response.ok) {
            // Surface the backend's actual reason (rate limited, user gone,
            // etc.) instead of a generic message, when the response body
            // has one.
            throw new Error((data && data.error) || 'Follow request failed');
        }

        setCachedRelationship(requestedUserId, {
            following: data.following,
            followerCount: data.follower_count
        });

        // Only repaint the screen if it's still showing the profile this
        // request was for - otherwise this response is stale relative to
        // whatever the user has navigated to since.
        if (currentUserProfileTarget?.id === requestedUserId) {
            updateUserProfileFollowButton(data.following);
            const countEl = document.getElementById('user-profile-followers-count');
            if (countEl) countEl.textContent = data.follower_count;
        }
    } catch (error) {
        console.error('Error toggling follow:', error);
        showToast(error.message || "Couldn't update follow status. Try again.");
    } finally {
        if (btn) btn.disabled = false;
    }
}

function updateUserProfileFollowButton(following) {
    const btn = document.getElementById('user-profile-follow-btn');
    const label = document.getElementById('user-profile-follow-label');
    const icon = btn ? btn.querySelector('i') : null;
    if (!btn || !label) return;

    btn.dataset.following = String(following);
    if (following) {
        label.textContent = 'FOLLOWING';
        if (icon) icon.className = 'fa-solid fa-check text-[12px]';
        btn.classList.remove('bg-brand-red', 'border-brand-red', 'text-white', 'hover:bg-red-700');
        btn.classList.add('border-gray-200', 'text-gray-800', 'hover:bg-gray-50');
    } else {
        label.textContent = 'FOLLOW';
        if (icon) icon.className = 'fa-solid fa-plus text-[12px]';
        btn.classList.remove('border-gray-200', 'text-gray-800', 'hover:bg-gray-50');
        btn.classList.add('bg-brand-red', 'border-brand-red', 'text-white', 'hover:bg-red-700');
    }
}

// Re-syncs follow state and counts for whichever profile is currently on
// screen when the tab regains visibility - covers the case where the
// relationship changed elsewhere (another tab, another device) while this
// tab was backgrounded. No-ops if the user-profile screen isn't the one
// currently active.
document.addEventListener('visibilitychange', async function() {
    if (document.visibilityState !== 'visible') return;
    const activeEl = document.querySelector('.view-section.active');
    if (!activeEl || activeEl.id !== 'user-profile-view') return;
    const target = currentUserProfileTarget;
    if (!target || !target.id) return;

    const requestedUserId = target.id;
    try {
        const response = await fetch(`/api/users/${requestedUserId}`);
        if (!response.ok) return;
        const profile = await response.json();
        if (currentUserProfileTarget?.id !== requestedUserId) return;

        setCachedRelationship(requestedUserId, {
            following: !!profile.is_following,
            followerCount: profile.follower_count,
            followingCount: profile.following_count
        });
        updateUserProfileFollowButton(!!profile.is_following);
        const followersEl = document.getElementById('user-profile-followers-count');
        if (followersEl) followersEl.textContent = profile.follower_count;
        const followingEl = document.getElementById('user-profile-following-count');
        if (followingEl) followingEl.textContent = profile.following_count;
    } catch (error) {
        console.error('Error re-syncing follow state on tab focus:', error);
    }
});

document.getElementById('user-profile-menu-btn').addEventListener('click', function() {
    showToast('Coming soon');
});

document.getElementById('profile-notifications-btn').addEventListener('click', function() {
    showToast('Coming soon');
});

// profile-topbar-menu-btn (the down-arrow) opens the account switcher -
// see toggleAccountSwitcher, wired further up alongside the rest of that
// feature's code.

