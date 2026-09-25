// ---- Account switcher (down-arrow in the own-profile top bar) ----
// The account switcher is only ever reachable through profile-topbar-menu-btn,
// which - like the rest of the top bar it lives in - is only shown on the
// authenticated user's own profile (see renderProfileView). Every account
// offered here comes from session.accounts, itself sourced from the
// server-backed /api/session response, so this never trusts a client-side
// guess about which accounts are actually signed in.
function renderAccountSwitcherList() {
    const list = document.getElementById('account-switcher-list');
    if (!list) return;

    const accounts = (session && session.accounts) || [];
    const activeId = session && session.user ? String(session.user.id) : null;

    list.innerHTML = accounts.map(function(acc) {
        const isActive = String(acc.id) === activeId;
        const avatarUrl = acc.profile_picture || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(acc.handle)}`;
        return `
<button type="button" class="account-switcher-row group w-full flex items-center gap-3 px-5 py-3 text-left transition-colors duration-100 active:bg-gray-50 ${isActive ? 'bg-gray-50/80' : ''}" data-account-id="${acc.id}">
	<img src="${avatarUrl}" alt="" class="w-10 h-10 rounded-full object-cover bg-gray-100 shrink-0"/>
	<span class="flex-1 min-w-0">
		<span class="block text-[15px] font-semibold text-gray-900 truncate">${escapeHtml(acc.full_name)}</span>
		<span class="block text-[13px] text-gray-400 truncate">@${escapeHtml(acc.handle)}</span>
	</span>
	<i class="fa-solid fa-check text-brand-red ${isActive ? '' : 'hidden'}"></i>
</button>`;
    }).join('');
}

async function openAccountSwitcher() {
    if (!session || !session.user) return;

    // Re-sync before opening so a just-added account (or a display-name/
    // avatar change on another tab) is reflected immediately.
    await updateSessionInfo();
    if (!session || !session.user) return;

    renderAccountSwitcherList();

    const sheet = document.getElementById('account-switcher-sheet');
    const backdrop = document.getElementById('account-switcher-backdrop');
    if (!sheet || !backdrop) return;

    sheet.style.transform = '';
    sheet.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    document.body.classList.add('overlay-open');

    const trigger = document.getElementById('profile-topbar-menu-btn');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
}

function closeAccountSwitcher() {
    const sheet = document.getElementById('account-switcher-sheet');
    const backdrop = document.getElementById('account-switcher-backdrop');
    if (sheet) {
        sheet.classList.add('hidden');
        sheet.style.transform = '';
    }
    if (backdrop) backdrop.classList.add('hidden');
    document.body.classList.remove('overlay-open');

    const trigger = document.getElementById('profile-topbar-menu-btn');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function toggleAccountSwitcher() {
    const sheet = document.getElementById('account-switcher-sheet');
    if (!sheet) return;
    if (sheet.classList.contains('hidden')) {
        openAccountSwitcher();
    } else {
        closeAccountSwitcher();
    }
}

// Switches the active session to an account already authenticated in this
// browser session. Never prompts for or transmits a password - the backend
// rejects any id that isn't already in this session's authenticated
// account list (see /api/session/switch).
async function switchAccount(userId) {
    if (!session || !session.user) return;

    if (String(userId) === String(session.user.id)) {
        closeAccountSwitcher();
        return;
    }

    try {
        const response = await apiFetch('/api/session/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId })
        });
        const data = await response.json();

        if (!response.ok) {
            showToast(data.error || 'Could not switch accounts');
            return;
        }

        setCsrfTokenFromResponseData(data);
        await updateSessionInfo();
        closeAccountSwitcher();
        showToast(`Switched to ${data.user.full_name}`);

        // Repaint whichever screen is currently active for the newly
        // active account rather than assuming it's the profile tab.
        const activeEl = document.querySelector('.view-section.active');
        const activeView = activeEl ? activeEl.id.replace('-view', '') : null;
        if (activeView === 'profile') {
            renderProfileView();
        } else if (activeView === 'feed') {
            fetchAndRenderPosts();
            updateFeedHeaderAvatar();
        }
    } catch (error) {
        console.error('Error switching accounts:', error);
        showToast('Network error. Please try again.');
    }
}

document.getElementById('account-switcher-list').addEventListener('click', function(e) {
    const row = e.target.closest('.account-switcher-row');
    if (!row) return;
    switchAccount(row.dataset.accountId);
});

document.getElementById('account-switcher-cancel-btn').addEventListener('click', closeAccountSwitcher);

// "Add Account" hands off to the existing login screen (which already
// links through to signup) without logging the current account out, so
// the account(s) already signed into this session stay signed in.
function openAddAccountFlow() {
    closeAccountSwitcher();
    const closeBtn = document.getElementById('login-close-btn');
    if (closeBtn) closeBtn.classList.remove('hidden');
    showView('login');
}

function cancelAddAccount() {
    const closeBtn = document.getElementById('login-close-btn');
    if (closeBtn) closeBtn.classList.add('hidden');
    showView('profile');
}

document.getElementById('account-switcher-add-btn').addEventListener('click', openAddAccountFlow);

document.getElementById('profile-topbar-menu-btn').addEventListener('click', toggleAccountSwitcher);

// Drag-to-dismiss for the account switcher sheet (touch only - mouse/
// pointer users get the same backdrop-tap and Cancel-button dismissal
// already wired above).
(function setupAccountSwitcherSwipe() {
    const sheet = document.getElementById('account-switcher-sheet');
    if (!sheet) return;

    let startY = 0;
    let currentY = 0;
    let dragging = false;

    sheet.addEventListener('touchstart', function(e) {
        if (e.touches.length !== 1) return;
        startY = e.touches[0].clientY;
        currentY = startY;
        dragging = true;
        sheet.style.transition = 'none';
    }, { passive: true });

    sheet.addEventListener('touchmove', function(e) {
        if (!dragging) return;
        currentY = e.touches[0].clientY;
        const delta = Math.max(0, currentY - startY);
        sheet.style.transform = `translateY(${delta}px)`;
    }, { passive: true });

    sheet.addEventListener('touchend', function() {
        if (!dragging) return;
        dragging = false;
        sheet.style.transition = '';
        const delta = Math.max(0, currentY - startY);
        sheet.style.transform = '';
        if (delta > 80) {
            closeAccountSwitcher();
        }
    });

    sheet.addEventListener('touchcancel', function() {
        dragging = false;
        sheet.style.transition = '';
        sheet.style.transform = '';
    });
})();

