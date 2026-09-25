// Own-profile screens: viewing your own profile, editing it, and the
// avatar/cover upload flow shared by both. Split out of profile.js
// (formerly ~890 lines covering own profile + another user's profile) —
// see profile-user.js for the other-user-profile counterpart.

// ---- Profile View ----
// Populates the profile header from the session user and loads that
// user's own posts (newest first) into the Posts tab. There's no
// per-user filter on the backend yet, so this reuses the same GET
// /api/posts the feed uses (already sorted newest-first) and filters
// client-side to posts authored by the current session user.
async function renderProfileView() {
    if (!session || !session.user) {
        await updateSessionInfo();
    }
    if (!session || !session.user) {
        // Not authenticated as anyone - keep the own-profile-only top bar
        // (notifications/menu) hidden rather than trusting whatever state
        // it was already in.
        const topbar = document.getElementById('profile-topbar');
        if (topbar) topbar.classList.add('hidden');
        return;
    }

    // This screen only ever renders the logged-in user's own profile (see
    // showView/openUserProfileView), and session.user comes from the
    // server-backed /api/session check above - not a client-side guess -
    // so it's safe to reveal the own-profile-only controls here.
    const topbar = document.getElementById('profile-topbar');
    if (topbar) {
        topbar.classList.remove('hidden');
        topbar.classList.add('flex');
    }
    const topbarTitle = document.getElementById('profile-topbar-title');
    if (topbarTitle) topbarTitle.textContent = session.user.full_name;

    const handle = session.user.username || session.user.email.split('@')[0];
    const dicebearUrl = `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;

    const avatarImg = document.getElementById('profile-avatar-img');
    if (avatarImg) {
        avatarImg.src = session.user.profile_picture || dicebearUrl;
        avatarImg.alt = session.user.full_name;
    }

    const coverImg = document.getElementById('profile-cover-img');
    if (coverImg) {
        if (session.user.cover_image) {
            coverImg.src = session.user.cover_image;
            coverImg.classList.remove('hidden');
        } else {
            coverImg.removeAttribute('src');
            coverImg.classList.add('hidden');
        }
    }

    const nameEl = document.getElementById('profile-name');
    if (nameEl) nameEl.textContent = session.user.full_name;
    const handleEl = document.getElementById('profile-handle');
    if (handleEl) handleEl.textContent = `@${handle}`;
    renderProfileBio(session.user.bio);

    // Default back to the Posts tab each time the screen is opened
    switchProfileTab('posts');

    // Highlights row: rendered from this user's own stored highlight data
    // (see loadUserHighlights) - empty vs. populated is never guessed here.
    renderProfileHighlights(loadUserHighlights());

    // Follower/following counts: not present anywhere in `session`, so
    // pulled from the same per-user endpoint the other-user profile screen
    // uses, pointed at our own id. Always re-fetched on open rather than
    // cached, so it reflects whatever's actually in the `follows` table -
    // e.g. someone followed you since the last time this screen was open.
    (async () => {
        try {
            const res = await fetch(`/api/users/${session.user.id}`);
            if (!res.ok) return;
            const data = await res.json();
            const followersEl = document.getElementById('profile-followers-count');
            if (followersEl) followersEl.textContent = data.follower_count;
            const followingEl = document.getElementById('profile-following-count');
            if (followingEl) followingEl.textContent = data.following_count;
        } catch (error) {
            console.error('Error loading own follower/following counts:', error);
            // Non-fatal: counts just stay at whatever they last showed.
        }
    })();

    const container = document.getElementById('profile-posts-container');
    if (!container) return;

    container.innerHTML = `
<div class="flex items-center justify-center py-16 text-gray-400 text-sm">
Loading posts...
</div>`;

    await loadProfilePostsPage(session.user.id, 'profile-posts-container', 'profile-posts-count', null);
}

// Shared paginated post loader for a single user's posts, used by both the
// own-profile screen and the other-user profile screen. Filters server-side
// via ?user_id= rather than fetching the global feed and filtering
// client-side - the old approach only ever saw whichever users happened to
// appear on page one of the feed once /api/posts was paginated.
// `expectedUserId` is checked after the await (when passed) to guard
// against the user having navigated to a different profile before this
// request resolved; pass null to skip that check (own profile can't change
// mid-request).
async function loadProfilePostsPage(userId, containerId, countElId, expectedUserIdGetter) {
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        const response = await fetch(`/api/posts?user_id=${encodeURIComponent(userId)}&limit=${FEED_PAGE_SIZE}`);
        if (!response.ok) {
            throw new Error('Failed to load posts');
        }
        if (expectedUserIdGetter && String(expectedUserIdGetter()) !== String(userId)) return;

        const data = await response.json();

        const countEl = countElId ? document.getElementById(countElId) : null;

        if (data.posts.length === 0) {
            if (countEl) countEl.textContent = 0;
            container.innerHTML = `
<div class="flex flex-col items-center justify-center py-16 text-gray-400 text-sm gap-2">
<i class="fa-regular fa-note-sticky text-3xl text-gray-300"></i>
No posts yet
</div>`;
            return;
        }

        container.innerHTML = data.posts.map(buildPostCardHtml).join('');
        // profile_posts_count reflects only what's loaded so far, not a
        // separate total from the backend - it updates again as more pages
        // load via the "Load more" button below.
        if (countEl) countEl.textContent = data.posts.length;

        if (data.next_cursor !== null) {
            appendLoadMoreButton(container, () =>
                loadMoreProfilePosts(userId, containerId, countElId, data.next_cursor, expectedUserIdGetter)
            );
        }
    } catch (error) {
        console.error('Error loading profile posts:', error);
        container.innerHTML = `
<div class="flex items-center justify-center py-16 text-gray-400 text-sm text-center px-8">
Couldn't load posts. Pull to refresh or try again later.
</div>`;
    }
}

async function loadMoreProfilePosts(userId, containerId, countElId, cursor, expectedUserIdGetter) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const btn = document.getElementById(`${containerId}-load-more-btn`);
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

    try {
        const response = await fetch(`/api/posts?user_id=${encodeURIComponent(userId)}&limit=${FEED_PAGE_SIZE}&cursor=${cursor}`);
        if (!response.ok) {
            throw new Error('Failed to load more posts');
        }
        if (expectedUserIdGetter && String(expectedUserIdGetter()) !== String(userId)) return;

        const data = await response.json();
        if (btn) btn.remove();

        if (data.posts.length > 0) {
            container.insertAdjacentHTML('beforeend', data.posts.map(buildPostCardHtml).join(''));
        }

        const countEl = countElId ? document.getElementById(countElId) : null;
        if (countEl) {
            countEl.textContent = container.querySelectorAll('article[data-post-id]').length;
        }

        if (data.next_cursor !== null) {
            appendLoadMoreButton(container, () =>
                loadMoreProfilePosts(userId, containerId, countElId, data.next_cursor, expectedUserIdGetter)
            );
        }
    } catch (error) {
        console.error('Error loading more profile posts:', error);
        if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
    }
}

function appendLoadMoreButton(container, onClick) {
    const existing = document.getElementById(`${container.id}-load-more-btn`);
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = `${container.id}-load-more-btn`;
    btn.type = 'button';
    btn.className = 'w-full py-3 text-sm text-gray-500 hover:text-gray-700';
    btn.textContent = 'Load more';
    btn.addEventListener('click', onClick);
    container.appendChild(btn);
}

// ---- Edit Profile View ----
// Pre-fills from the in-memory session (already populated by
// updateSessionInfo/login) rather than re-fetching - session.user is the
// single source of truth for the signed-in user's own fields elsewhere in
// this file (see renderProfileView above), so this stays consistent with
// that pattern. Username has no dedicated column yet (see
// handleSaveProfileChanges), so it falls back to the same email-derived
// handle the Profile screen already displays.
function renderEditProfileView() {
    if (!session || !session.user) return;

    const handle = session.user.username || session.user.email.split('@')[0];
    const dicebearUrl = `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;

    const avatarImg = document.getElementById('edit-profile-avatar-img');
    if (avatarImg) {
        avatarImg.src = session.user.profile_picture || dicebearUrl;
        avatarImg.alt = session.user.full_name;
    }

    const coverImg = document.getElementById('edit-profile-cover-img');
    if (coverImg) {
        if (session.user.cover_image) {
            coverImg.src = session.user.cover_image;
            coverImg.classList.remove('hidden');
        } else {
            coverImg.removeAttribute('src');
            coverImg.classList.add('hidden');
        }
    }

    const nameInput = document.getElementById('edit-profile-name-input');
    if (nameInput) nameInput.value = session.user.full_name || '';

    const usernameInput = document.getElementById('edit-profile-username-input');
    if (usernameInput) usernameInput.value = `@${handle}`;

    const bioInput = document.getElementById('edit-profile-bio-input');
    if (bioInput) bioInput.value = session.user.bio || '';
    updateEditProfileBioCounter();

    const errorEl = document.getElementById('edit-profile-error');
    if (errorEl) errorEl.classList.add('hidden');
    const usernameErrorEl = document.getElementById('edit-profile-username-error');
    if (usernameErrorEl) usernameErrorEl.classList.add('hidden');
}

// Shows/hides #profile-bio based on whether the user has a bio set. When
// empty, the element stays hidden (no placeholder text) and #profile-handle
// keeps its own mb-5 so the no-bio layout is unchanged; when present,
// #profile-handle's margin shrinks so bio sits snug beneath the handle and
// #profile-bio's own mb-5 provides the gap before the stats row.
function renderProfileBio(bio) {
    const bioEl = document.getElementById('profile-bio');
    const handleEl = document.getElementById('profile-handle');
    if (!bioEl || !handleEl) return;

    if (bio) {
        bioEl.textContent = bio;
        bioEl.classList.remove('hidden');
        handleEl.classList.remove('mb-5');
        handleEl.classList.add('mb-1');
    } else {
        bioEl.textContent = '';
        bioEl.classList.add('hidden');
        handleEl.classList.remove('mb-1');
        handleEl.classList.add('mb-5');
    }
}

// Same as renderProfileBio() above, but for the other-user profile screen's
// own #user-profile-bio/#user-profile-handle elements.
function renderUserProfileBio(bio) {
    const bioEl = document.getElementById('user-profile-bio');
    const handleEl = document.getElementById('user-profile-handle');
    if (!bioEl || !handleEl) return;

    if (bio) {
        bioEl.textContent = bio;
        bioEl.classList.remove('hidden');
        handleEl.classList.remove('mb-5');
        handleEl.classList.add('mb-1');
    } else {
        bioEl.textContent = '';
        bioEl.classList.add('hidden');
        handleEl.classList.remove('mb-1');
        handleEl.classList.add('mb-5');
    }
}

function updateEditProfileBioCounter() {
    const bioInput = document.getElementById('edit-profile-bio-input');
    const counter = document.getElementById('edit-profile-bio-counter');
    if (!bioInput || !counter) return;
    counter.textContent = `${bioInput.value.length}/150`;
}

function closeEditProfileView() {
    showView('profile');
}

// Persists Display Name / Username / Bio. Avatar and cover are saved
// separately and immediately on selection (see handleProfileImageSelected)
// so they're intentionally not part of this request.
//
// Backend note: this calls PATCH /api/profile, which does not exist yet -
// see the Claude Code prompt provided alongside this change for the
// `username`/`bio` columns and endpoint this depends on.
async function handleSaveProfileChanges() {
    if (!session || !session.user) return;

    const saveBtn = document.getElementById('edit-profile-save-btn');
    const spinner = document.getElementById('edit-profile-save-spinner');
    const label = document.getElementById('edit-profile-save-label');
    const errorEl = document.getElementById('edit-profile-error');
    const usernameErrorEl = document.getElementById('edit-profile-username-error');

    const fullName = document.getElementById('edit-profile-name-input').value.trim();
    const usernameRaw = document.getElementById('edit-profile-username-input').value.trim();
    const username = usernameRaw.replace(/^@/, '');
    const bio = document.getElementById('edit-profile-bio-input').value.trim();

    if (errorEl) errorEl.classList.add('hidden');
    if (usernameErrorEl) usernameErrorEl.classList.add('hidden');

    if (!fullName) {
        if (errorEl) {
            errorEl.textContent = 'Display name cannot be empty.';
            errorEl.classList.remove('hidden');
        }
        return;
    }
    if (!username) {
        if (usernameErrorEl) {
            usernameErrorEl.textContent = 'Username cannot be empty.';
            usernameErrorEl.classList.remove('hidden');
        }
        return;
    }

    saveBtn.disabled = true;
    if (spinner) spinner.classList.remove('hidden');
    if (label) label.textContent = 'Saving...';

    try {
        const response = await apiFetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ full_name: fullName, username: username, bio: bio })
        });
        const data = await response.json();

        if (!response.ok) {
            if (response.status === 409 && usernameErrorEl) {
                usernameErrorEl.textContent = data.error || 'That username is already taken.';
                usernameErrorEl.classList.remove('hidden');
            } else if (errorEl) {
                errorEl.textContent = data.error || 'Failed to save changes. Please try again.';
                errorEl.classList.remove('hidden');
            }
            return;
        }

        // Keep the in-memory session in sync, same convention as the
        // avatar/cover upload flow above.
        session.user.full_name = data.full_name ?? fullName;
        session.user.username = data.username ?? username;
        session.user.bio = data.bio ?? bio;

        const topbarTitle = document.getElementById('profile-topbar-title');
        if (topbarTitle) topbarTitle.textContent = session.user.full_name;
        const nameEl = document.getElementById('profile-name');
        if (nameEl) nameEl.textContent = session.user.full_name;
        const handleEl = document.getElementById('profile-handle');
        if (handleEl) handleEl.textContent = `@${session.user.username}`;
        renderProfileBio(session.user.bio);

        showToast('Profile updated');
        showView('profile');
    } catch (error) {
        console.error('Error saving profile changes:', error);
        if (errorEl) {
            errorEl.textContent = 'Failed to save changes. Please check your connection and try again.';
            errorEl.classList.remove('hidden');
        }
    } finally {
        saveBtn.disabled = false;
        if (spinner) spinner.classList.add('hidden');
        if (label) label.textContent = 'Save Changes';
    }
}

document.getElementById('edit-profile-bio-input').addEventListener('input', updateEditProfileBioCounter);


// ---- Profile picture / cover image upload ----
const PROFILE_IMAGE_MAX_SIZE = 5 * 1024 * 1024; // 5MB, matches backend limit

async function handleProfileImageSelected(event, kind) {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // allow re-selecting the same file later

    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Please choose an image file.');
        return;
    }
    if (file.size > PROFILE_IMAGE_MAX_SIZE) {
        showToast('Image must be under 5MB.');
        return;
    }

    // Both the Profile screen and the Edit Profile screen render the same
    // avatar/cover, so whichever one this upload started from, every
    // matching element on either screen is kept in sync below.
    const imgIds = kind === 'avatar'
        ? ['profile-avatar-img', 'edit-profile-avatar-img', 'bottom-nav-avatar-img']
        : ['profile-cover-img', 'edit-profile-cover-img'];
    const overlayIds = kind === 'avatar'
        ? ['profile-avatar-upload-overlay', 'edit-profile-avatar-upload-overlay']
        : ['profile-cover-upload-overlay', 'edit-profile-cover-upload-overlay'];

    const imgEls = imgIds.map(id => document.getElementById(id)).filter(Boolean);
    const overlayEls = overlayIds.map(id => document.getElementById(id)).filter(Boolean);
    if (imgEls.length === 0) return;

    const previousSrc = imgEls[0].src;
    const coverWasHidden = kind === 'cover' ? imgEls[0].classList.contains('hidden') : false;

    // Optimistic local preview while the upload is in flight
    const objectUrl = URL.createObjectURL(file);
    imgEls.forEach(el => {
        el.src = objectUrl;
        if (kind === 'cover') el.classList.remove('hidden');
    });
    overlayEls.forEach(el => { el.style.display = 'flex'; });

    try {
        const formData = new FormData();
        formData.append('image', file);
        const endpoint = kind === 'avatar' ? '/api/profile/picture' : '/api/profile/cover';

        const response = await apiFetch(endpoint, { method: 'POST', body: formData });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to update photo. Please try again.');
        }

        const serverUrl = kind === 'avatar' ? data.profile_picture : data.cover_image;
        imgEls.forEach(el => { el.src = serverUrl; });
        URL.revokeObjectURL(objectUrl);

        // Keep the in-memory session in sync so re-rendering the profile
        // view (or reading session.user elsewhere) reflects the change
        // immediately, without a page reload or an extra /api/session call.
        if (session && session.user) {
            if (kind === 'avatar') {
                session.user.profile_picture = serverUrl;
                syncAvatarAcrossRenderedPosts(session.user.id, serverUrl);
            } else {
                session.user.cover_image = serverUrl;
            }
        }

        showToast(kind === 'avatar' ? 'Profile photo updated' : 'Cover photo updated');
    } catch (error) {
        URL.revokeObjectURL(objectUrl);
        imgEls.forEach(el => {
            el.src = previousSrc;
            if (kind === 'cover' && coverWasHidden) el.classList.add('hidden');
        });
        showToast(error.message || 'Failed to update photo. Please try again.');
    } finally {
        overlayEls.forEach(el => { el.style.display = 'none'; });
    }
}

// After a successful avatar upload, patch every already-rendered post card
// authored by this user (feed and/or profile "Posts" tab, whichever is
// currently in the DOM) so the new avatar shows immediately without
// waiting for the next fetch. The dataset attribute is updated too, so if
// the comment overlay is opened for one of these posts afterward it reads
// the fresh avatar instead of the stale one baked into the original render.
function syncAvatarAcrossRenderedPosts(userId, newAvatarUrl) {
    if (userId == null) return;
    document.querySelectorAll(`article[data-post-id][data-post-user-id="${userId}"]`).forEach(article => {
        article.dataset.postAuthorAvatar = newAvatarUrl;
        const avatarImg = article.querySelector('img');
        if (avatarImg) avatarImg.src = newAvatarUrl;
    });
}

(function initProfileImageUploadListeners() {
    const pairs = [
        ['profile-avatar-camera-btn', 'profile-avatar-input', 'avatar'],
        ['profile-cover-camera-btn', 'profile-cover-input', 'cover'],
        ['edit-profile-avatar-camera-btn', 'edit-profile-avatar-input', 'avatar'],
        ['edit-profile-cover-camera-btn', 'edit-profile-cover-input', 'cover']
    ];
    pairs.forEach(function([btnId, inputId, kind]) {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (btn && input) {
            btn.addEventListener('click', () => input.click());
            input.addEventListener('change', (e) => handleProfileImageSelected(e, kind));
        }
    });
})();

// Switches the visible panel under the Profile tab bar. Only "posts" is
// backed by real data right now; "saved" and "likes" have no backing
// feature yet, so they just show a placeholder state.
function switchProfileTab(tabName) {
    const tabs = ['posts', 'saved', 'likes'];
    tabs.forEach(function(name) {
        const tabBtn = document.getElementById(`profile-tab-${name}`);
        const panel = document.getElementById(`profile-${name}-panel`);
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

document.querySelectorAll('.profile-tab').forEach(function(tabBtn) {
    tabBtn.addEventListener('click', function() {
        switchProfileTab(tabBtn.dataset.tab);
    });
});

document.getElementById('profile-edit-btn').addEventListener('click', function() {
    showView('edit-profile');
});

// Cosmetic-only controls with no backing feature yet
['profile-settings-btn'].forEach(function(id) {
    const btn = document.getElementById(id);
    if (btn) {
        btn.addEventListener('click', function() {
            showToast('Coming soon');
        });
    }
});

