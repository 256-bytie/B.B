// ---- Highlights (Status section content) ----
// No backend endpoint exists for highlights yet, so they're persisted
// client-side, namespaced per signed-in user id, the same way this
// prototype already keeps other local-only state. Swapping in a real
// /api/highlights endpoint later only means changing load/save below -
// renderProfileHighlights() and the upload sheet stay the same.
function getHighlightsStorageKey() {
    return (session && session.user) ? `beebo_highlights_${session.user.id}` : null;
}

function loadUserHighlights() {
    const key = getHighlightsStorageKey();
    if (!key) return [];
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : [];
    } catch (error) {
        console.error('Error loading highlights:', error);
        return [];
    }
}

function saveUserHighlights(highlights) {
    const key = getHighlightsStorageKey();
    if (!key) return;
    try {
        localStorage.setItem(key, JSON.stringify(highlights));
    } catch (error) {
        console.error('Error saving highlights:', error);
    }
}

// Renders the #profile-highlights-row from actual highlight data.
// Existing highlights render first (in stored order), each as a covered
// circle + its title, followed by the "New" button so adding another
// highlight never requires touching this layout. With zero highlights,
// "New" still renders alone, plus a few plain filler circles so the row
// reads as intentional empty space rather than a gap.
function renderProfileHighlights(highlights) {
    const row = document.getElementById('profile-highlights-row');
    if (!row) return;

    const newBtnHtml = `
<button type="button" id="profile-highlight-new-btn" class="flex flex-col items-center gap-2 shrink-0" aria-label="Add highlight">
    <span class="w-16 h-16 rounded-full border border-gray-300 flex items-center justify-center text-gray-500">
        <i class="fa-solid fa-plus text-[17px]"></i>
    </span>
    <span class="text-[11px] text-gray-400 text-center leading-tight">New</span>
</button>`;

    if (!highlights || highlights.length === 0) {
        const fillerHtml = Array.from({ length: 3 }).map(function() {
            return '<span class="w-16 h-16 rounded-full bg-gray-100 shrink-0" aria-hidden="true"></span>';
        }).join('');
        row.innerHTML = newBtnHtml + fillerHtml;
    } else {
        const highlightsHtml = highlights.map(function(h) {
            const coverHtml = h.cover
                ? `<img src="${h.cover}" alt="${escapeHtml(h.title)}" class="w-full h-full object-cover"/>`
                : `<span class="w-full h-full flex items-center justify-center text-gray-400"><i class="fa-solid fa-video text-[17px]"></i></span>`;
            return `
<button type="button" class="profile-highlight-btn flex flex-col items-center gap-2 shrink-0" data-highlight-id="${h.id}">
    <span class="w-16 h-16 rounded-full border-2 border-white shadow-sm ring-1 ring-gray-200 overflow-hidden bg-gray-100">
        ${coverHtml}
    </span>
    <span class="text-[11px] text-gray-600 text-center leading-tight max-w-[64px] truncate">${escapeHtml(h.title)}</span>
</button>`;
        }).join('');
        row.innerHTML = highlightsHtml + newBtnHtml;
    }

    const newBtn = document.getElementById('profile-highlight-new-btn');
    if (newBtn) newBtn.addEventListener('click', openHighlightUploadSheet);

    row.querySelectorAll('.profile-highlight-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            showToast('Coming soon');
        });
    });
}

// ---- Highlight Upload Bottom Sheet ----
function openHighlightUploadSheet() {
    const sheet = document.getElementById('highlight-upload-sheet');
    const backdrop = document.getElementById('highlight-upload-backdrop');
    if (!sheet || !backdrop) return;

    sheet.style.transform = '';
    sheet.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    document.body.classList.add('overlay-open');
}

function closeHighlightUploadSheet() {
    const sheet = document.getElementById('highlight-upload-sheet');
    const backdrop = document.getElementById('highlight-upload-backdrop');
    if (sheet) {
        sheet.classList.add('hidden');
        sheet.style.transform = '';
    }
    if (backdrop) backdrop.classList.add('hidden');
    document.body.classList.remove('overlay-open');
}

const HIGHLIGHT_MEDIA_MAX_SIZE = 25 * 1024 * 1024; // 25MB, generous for photo or short video

async function handleHighlightMediaSelected(event, kind) {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // allow re-selecting the same file later

    if (!file) return;

    const expectedPrefix = kind === 'photo' ? 'image/' : 'video/';
    if (!file.type.startsWith(expectedPrefix)) {
        showToast(kind === 'photo' ? 'Please choose an image file.' : 'Please choose a video file.');
        return;
    }
    if (file.size > HIGHLIGHT_MEDIA_MAX_SIZE) {
        showToast('File must be under 25MB.');
        return;
    }

    closeHighlightUploadSheet();

    try {
        // Cover thumbnail: the media itself for photos, otherwise just the
        // circle background - stored as a data URL so it survives reloads
        // without a backend endpoint (see loadUserHighlights/saveUserHighlights).
        const cover = kind === 'photo' ? await readFileAsDataUrl(file) : '';
        const highlights = loadUserHighlights();
        const title = (window.prompt('Name this highlight', 'Highlights') || 'Highlights').trim().slice(0, 20) || 'Highlights';

        highlights.push({
            id: `${Date.now()}`,
            title: title,
            cover: cover,
            kind: kind
        });

        saveUserHighlights(highlights);
        renderProfileHighlights(highlights);
        showToast('Highlight added');
    } catch (error) {
        console.error('Error adding highlight:', error);
        showToast('Failed to add highlight. Please try again.');
    }
}

function readFileAsDataUrl(file) {
    return new Promise(function(resolve, reject) {
        const reader = new FileReader();
        reader.onload = function() { resolve(reader.result); };
        reader.onerror = function() { reject(reader.error); };
        reader.readAsDataURL(file);
    });
}

(function initHighlightUploadSheet() {
    const photoBtn = document.getElementById('highlight-upload-photo-btn');
    const videoBtn = document.getElementById('highlight-upload-video-btn');
    const cancelBtn = document.getElementById('highlight-upload-cancel-btn');
    const photoInput = document.getElementById('highlight-photo-input');
    const videoInput = document.getElementById('highlight-video-input');

    if (photoBtn && photoInput) {
        photoBtn.addEventListener('click', function() {
            closeHighlightUploadSheet();
            photoInput.click();
        });
        photoInput.addEventListener('change', function(e) { handleHighlightMediaSelected(e, 'photo'); });
    }
    if (videoBtn && videoInput) {
        videoBtn.addEventListener('click', function() {
            closeHighlightUploadSheet();
            videoInput.click();
        });
        videoInput.addEventListener('change', function(e) { handleHighlightMediaSelected(e, 'video'); });
    }
    if (cancelBtn) cancelBtn.addEventListener('click', closeHighlightUploadSheet);
})();

// ---- Collapsible Status/Highlight section (down-arrow beside Settings) ----
// #profile-status-section itself is left completely alone data-wise - this
// only ever touches its `height`/`opacity` inline styles and a class flag
// for state, purely client-side presentation. Content below (ProfileTabs,
// posts/saved/likes) sits in normal flow right after this section, so
// animating its height down to 0 naturally pulls everything below it up
// to exactly where the section started - no separate "move content" logic
// needed.
function toggleProfileStatusSection() {
    const section = document.getElementById('profile-status-section');
    const trigger = document.getElementById('profile-settings-row-chevron');
    if (!section || !trigger) return;

    const icon = trigger.querySelector('i');
    const isCollapsed = section.classList.contains('profile-status-collapsed');

    if (isCollapsed) {
        // Expand: animate from 0 up to the section's natural content
        // height, then release the fixed height so it stays responsive
        // (e.g. across viewport/orientation changes) once settled.
        section.classList.remove('profile-status-collapsed');
        section.style.height = section.scrollHeight + 'px';
        section.style.opacity = '1';
        trigger.setAttribute('aria-expanded', 'true');
        trigger.setAttribute('aria-label', 'Collapse status section');
        if (icon) icon.classList.remove('rotate-180');

        section.addEventListener('transitionend', function onExpandEnd(e) {
            if (e.propertyName !== 'height') return;
            section.removeEventListener('transitionend', onExpandEnd);
            if (!section.classList.contains('profile-status-collapsed')) {
                section.style.height = 'auto';
            }
        });
    } else {
        // Collapse: lock in the current pixel height first (can't
        // transition from 'auto'), force a reflow, then animate to 0.
        section.style.height = section.scrollHeight + 'px';
        // eslint-disable-next-line no-unused-expressions
        section.offsetHeight;
        section.style.height = '0px';
        section.style.opacity = '0';
        section.classList.add('profile-status-collapsed');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-label', 'Expand status section');
        if (icon) icon.classList.add('rotate-180');
    }
}

(function initProfileStatusSection() {
    const section = document.getElementById('profile-status-section');
    if (!section) return;
    // Start in 'auto' so initial layout/scroll height calculations are
    // correct before the user ever interacts with the toggle.
    section.style.height = 'auto';
})();

document.getElementById('profile-settings-row-chevron').addEventListener('click', toggleProfileStatusSection);

