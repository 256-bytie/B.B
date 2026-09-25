// ---- CSRF token handling ----
// The backend issues a per-session CSRF token (synchronizer token pattern)
// on GET /api/session, and rotates it on POST /api/login, /api/signup, and
// /api/session/switch - each of those responses carries the current token
// in a `csrf_token` field when they succeed. This is the single place that
// tracks it; every mutating request goes through apiFetch below rather than
// reading this variable directly, so there's one place to fix if the
// header name or rotation rule ever changes.
let csrfToken = null;

function setCsrfTokenFromResponseData(data) {
    if (data && typeof data.csrf_token === 'string') {
        csrfToken = data.csrf_token;
    }
}

// Wrapper around fetch() for any request that mutates state (POST/PATCH/
// PUT/DELETE). Injects the X-CSRF-Token header automatically so call sites
// don't each have to remember to. GET requests don't need this - use plain
// fetch() for those - but calling apiFetch on a GET is harmless.
// /api/login and /api/signup are the only mutating endpoints that must NOT
// go through this: there's no session yet to hold a token before those
// succeed, so call fetch() directly for those two.
function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
        return fetch(url, options);
    }

    const headers = new Headers(options.headers || {});
    if (csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
    }
    return fetch(url, { ...options, headers });
}

// View management
// skipUrlSync is passed by the popstate handler (see below) so that
// responding to a browser Back/Forward navigation doesn't push a second,
// redundant history entry on top of the one the browser just navigated to.
function showView(viewName, { skipUrlSync = false } = {}) {
    const views = ['login', 'signup', 'feed', 'profile', 'edit-profile', 'user-profile', 'create-post', 'businesses', 'courses', 'gpa-calculator', 'chat', 'library', 'library-contribute', 'search', 'wallet', 'community', 'community-create'];
    views.forEach(v => {
        const view = document.getElementById(v + '-view');
        if (view) {
            view.classList.remove('active');
        }
    });
    const targetView = document.getElementById(viewName + '-view');
    if (targetView) {
        targetView.classList.add('active');
    }

    // Keep the URL in sync with the visible screen for the three
    // deep-linkable views - feed, the signed-in user's own profile, and
    // another user's profile - so a browser reload or a direct link lands
    // on the right screen instead of always falling back to feed/login.
    // Other views (login, signup, compose, edit-profile, businesses,
    // courses, GPA calculator, wallet) are unchanged by this: they're transient/
    // form-like screens, not content worth deep-linking to, and reload
    // continues to land on feed/login for those exactly as before.
    if (!skipUrlSync) {
        let path = null;
        if (viewName === 'feed') {
            path = '/';
        } else if (viewName === 'profile') {
            path = '/profile';
        } else if (viewName === 'user-profile' && currentUserProfileTarget && currentUserProfileTarget.id != null) {
            path = `/u/${currentUserProfileTarget.id}`;
        }
        if (path !== null && location.pathname !== path) {
            history.pushState({ view: viewName, userId: viewName === 'user-profile' ? currentUserProfileTarget.id : null }, '', path);
        }
    }

    // Lazy-load the GPA calculator iframe only while its view is open,
    // and clear it when leaving so it resets each time it's reopened.
    const gpaFrame = document.getElementById('gpa-calculator-frame');
    if (gpaFrame) {
        if (viewName === 'gpa-calculator') {
            gpaFrame.src = '/static/gpa-calculator.html';
        } else {
            gpaFrame.src = '';
        }
    }

    // Update bottom nav visibility and active states
    updateBottomNav(viewName);

    // Load fresh posts whenever the feed is shown
    if (viewName === 'feed') {
        fetchAndRenderPosts();
        updateFeedHeaderAvatar();
    }

    // Refresh the profile header and the user's own posts each time it's shown
    if (viewName === 'profile') {
        renderProfileView();
    }

    // Populate the other-user profile screen each time it's shown
    if (viewName === 'user-profile') {
        renderUserProfileView();
    }

    // Pre-fill the edit form from the current session each time it's opened
    if (viewName === 'edit-profile') {
        renderEditProfileView();
    }

    // Reset/restore the composer each time it's opened
    if (viewName === 'create-post') {
        initComposeView();
    }

    // Reset the search field and re-render the mock lists each time chat opens
    if (viewName === 'chat') {
        initChatView();
    }

    // Refresh the file list + department counts each time Library is shown
    if (viewName === 'library') {
        initLibraryView();
    }

    // Reset the upload wizard to step 1 each time Contribute is opened
    if (viewName === 'library-contribute') {
        resetLibraryContributeWizard();
    }

    // Reset the search field/state and reload history+trending each time
    // Search opens, and remember which screen to return to on Back.
    if (viewName === 'search') {
        initSearchView();
    }

    // Reload balance, monthly-claim status and history each time Wallet opens
    if (viewName === 'wallet') {
        initWalletView();
    }
}

// Update bottom navigation visibility and active states
// Shows/hides the bottom nav bar (templates/partials/bottom_nav.html) and
// the three view-specific FABs (compose on feed, GPA calculator on
// courses, Contribute on library). The bar is only shown on the views it
// links to - feed, search, chat and profile; every other screen is
// reached via the side-nav drawer, so the bar stays hidden there. Search
// used to be a bar-less full-screen takeover (own back button + keyboard)
// but now keeps the bar visible like the other three, so its own back
// button is just an alternate way out, not the only one.
const BOTTOM_NAV_ACTIVE_ITEM = {
    'feed': 'bottom-nav-home',
    'search': 'bottom-nav-search',
    'chat': 'bottom-nav-chat',
    'profile': 'bottom-nav-profile'
};

// ---- Businesses screen navigation ----
// Screens Businesses can be opened from (side nav is reachable from all of
// them); the back arrow returns to whichever one it came from. Mirrors
// WALLET_RETURN_VIEWS/openWalletView in wallet.js.
const BUSINESSES_RETURN_VIEWS = ['feed', 'courses', 'library', 'chat', 'profile', 'user-profile', 'search', 'wallet'];
let businessesReturnView = 'feed';

// Entry point used by the side nav. Records where the user came from
// (showView clears the previous screen's `active` class, so it has to be
// read before switching) so the back arrow can return there.
function openBusinessesView() {
    const activeEl = document.querySelector('.view-section.active');
    const name = activeEl ? activeEl.id.replace(/-view$/, '') : 'feed';
    if (BUSINESSES_RETURN_VIEWS.includes(name)) businessesReturnView = name;
    showView('businesses');
}

function closeBusinessesView() {
    showView(businessesReturnView || 'feed');
}

function updateBottomNav(viewName) {
    const composeFab = document.getElementById('compose-fab');
    const gpaFab = document.getElementById('gpa-fab');
    const libraryFab = document.getElementById('library-contribute-fab');

    const bottomNav = document.getElementById('bottom-nav');
    if (bottomNav) {
        const activeItemId = BOTTOM_NAV_ACTIVE_ITEM[viewName];
        bottomNav.classList.toggle('hidden', !activeItemId);
        bottomNav.querySelectorAll('.bottom-nav-item').forEach(function(item) {
            const isActive = item.id === activeItemId;
            item.classList.toggle('is-active', isActive);
            item.classList.toggle('text-gray-900', isActive);
            item.classList.toggle('text-gray-500', !isActive);
            if (isActive) {
                item.setAttribute('aria-current', 'page');
            } else {
                item.removeAttribute('aria-current');
            }
        });
    }

    // gpa-calculator is a true full-screen takeover: no FAB should render
    // behind/around it.
    if (viewName === 'gpa-calculator') {
        if (composeFab) composeFab.classList.add('hidden');
        if (gpaFab) gpaFab.classList.add('hidden');
        if (libraryFab) libraryFab.classList.add('hidden');
        return;
    }

    // Show compose FAB only on feed view
    if (composeFab) {
        if (viewName === 'feed') {
            composeFab.classList.remove('hidden');
        } else {
            composeFab.classList.add('hidden');
        }
    }

    // Show GPA calculator FAB only on courses view
    if (gpaFab) {
        if (viewName === 'courses') {
            gpaFab.classList.remove('hidden');
        } else {
            gpaFab.classList.add('hidden');
        }
    }

    // Show Contribute FAB only on the Library home view (not the
    // Contribute wizard itself, which has its own footer buttons)
    if (libraryFab) {
        if (viewName === 'library') {
            libraryFab.classList.remove('hidden');
        } else {
            libraryFab.classList.add('hidden');
        }
    }
}

// Password visibility toggle
function togglePassword(inputId, button) {
    const input = document.getElementById(inputId);
    const eyeSlash = button.querySelector('.eye-slash');
    const eyeOpen = button.querySelector('.eye-open');

    if (input.type === 'password') {
        input.type = 'text';
        eyeSlash.classList.add('hidden');
        eyeOpen.classList.remove('hidden');
    } else {
        input.type = 'password';
        eyeSlash.classList.remove('hidden');
        eyeOpen.classList.add('hidden');
    }
}

// Error display helper
function showError(formId, message) {
    const errorDiv = document.getElementById(formId + '-error');
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
}

function hideError(formId) {
    const errorDiv = document.getElementById(formId + '-error');
    errorDiv.classList.add('hidden');
}

// Login form handler
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('login');

    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok) {
            setCsrfTokenFromResponseData(data);
            document.getElementById('login-close-btn').classList.add('hidden');
            await updateSessionInfo();
            showView('feed');
        } else if (response.status === 429) {
            showError('login', data.error || 'Too many login attempts. Please wait and try again.');
        } else {
            showError('login', data.error || 'Login failed');
        }
    } catch (error) {
        showError('login', 'Network error. Please try again.');
    }
});

// Signup form handler
document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('signup');

    const fullName = document.getElementById('signup-fullname').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    const confirmPassword = document.getElementById('signup-confirm-password').value;

    // Client-side validation
    if (password !== confirmPassword) {
        showError('signup', 'Passwords do not match');
        return;
    }

    if (password.length < 6) {
        showError('signup', 'Password must be at least 6 characters');
        return;
    }

    try {
        const response = await fetch('/api/signup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                full_name: fullName,
                email,
                password
            })
        });

        const data = await response.json();

        if (response.ok) {
            setCsrfTokenFromResponseData(data);
            document.getElementById('login-close-btn').classList.add('hidden');
            await updateSessionInfo();
            showView('feed');
        } else {
            showError('signup', data.error || 'Signup failed');
        }
    } catch (error) {
        showError('signup', 'Network error. Please try again.');
    }
});

// Check session on load. Also routes the initial screen from the current
// URL (reload or a direct link to /profile or /u/<id>) instead of always
// landing on feed, so a reload of another user's profile - or your own -
// keeps you there rather than bouncing you back to the feed.
async function checkSession() {
    try {
        const response = await fetch('/api/session');
        const data = await response.json();
        setCsrfTokenFromResponseData(data);

        if (data.logged_in) {
            routeFromCurrentUrl();
        } else {
            // Not logged in: always show login, and normalize the URL back
            // to '/' with replaceState (not pushState) since this is a
            // redirect, not a navigation the user should be able to "Back"
            // out of into a half-loaded deep link.
            if (location.pathname !== '/') {
                history.replaceState({ view: 'login' }, '', '/');
            }
            showView('login');
        }
    } catch (error) {
        showView('login');
    }
}

// Shows the view matching the current URL path. Used on initial load
// (after confirming the session is logged in) and does NOT itself touch
// history - the caller decides whether that's appropriate.
function routeFromCurrentUrl() {
    const path = location.pathname;
    const userProfileMatch = path.match(/^\/u\/(\d+)$/);
    if (path === '/profile') {
        showView('profile', { skipUrlSync: true });
    } else if (userProfileMatch) {
        currentUserProfileTarget = { id: userProfileMatch[1] };
        showView('user-profile', { skipUrlSync: true });
    } else {
        // Unknown/root path - normalize to '/' and show the feed. Uses
        // replaceState so an unrecognized path doesn't leave a confusing
        // extra Back-button stop.
        if (path !== '/') {
            history.replaceState({ view: 'feed' }, '', '/');
        }
        showView('feed', { skipUrlSync: true });
    }
}

// Handle browser Back/Forward. The browser has already changed
// location.pathname by the time this fires - we just need to show the
// matching view without pushing a new history entry for it.
window.addEventListener('popstate', () => {
    if (!session || !session.user) {
        // Not authenticated - Back/Forward can't leave the login screen.
        showView('login', { skipUrlSync: true });
        return;
    }
    routeFromCurrentUrl();
});

// Handle logout
async function handleLogout() {
    try {
        const response = await apiFetch('/api/logout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            // Session is cleared server-side on logout, so the token this
            // browser was holding is dead - drop it too rather than risk
            // reusing it. checkSession()/updateSessionInfo() picks up a
            // fresh one on the next GET /api/session.
            csrfToken = null;
            document.getElementById('login-close-btn').classList.add('hidden');
            closeAccountSwitcher();
            showView('login');
        } else {
            console.error('Logout failed');
        }
    } catch (error) {
        console.error('Network error during logout:', error);
    }
}


// ---- Search overlay toggle (businesses view) ----
	function toggleSearch() {
		const overlay = document.getElementById('search-overlay');
		const backdrop = document.getElementById('search-backdrop');
		if (overlay && backdrop) {
			if (overlay.classList.contains('hidden')) {
				overlay.classList.remove('hidden');
				backdrop.classList.remove('hidden');
				const input = overlay.querySelector('input');
				if(input) input.focus();
			} else {
				overlay.classList.add('hidden');
				backdrop.classList.add('hidden');
			}
		}
	}
