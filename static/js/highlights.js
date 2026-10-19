// ---- Highlights (Status section content) ----
// No backend endpoint exists for highlights yet, so they're persisted
// client-side, namespaced per signed-in user id, the same way this
// prototype already keeps other local-only state. Swapping in a real
// /api/highlights endpoint later only means changing load/save below -
// renderProfileHighlights() and the upload sheet stay the same.
//
// Record shape: { id, title, cover, kind, items: [{ id, kind, createdAt, audio? }] }
//   - cover: small thumbnail data URL (generated at upload time).
//   - items: the media in the highlight, oldest first. The media files themselves live in
//     IndexedDB (putHighlightMedia / getHighlightMedia), keyed by item id, because videos and
//     full photos do not fit localStorage. `audio` is an optional label shown in the viewer
//     header (e.g. "Black II").
//   - Highlights saved before `items` existed have none: a photo one is shown from its cover
//     (see getHighlightItems); a video one has no stored media and cannot be opened.
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
    if (!key) return false;
    try {
        localStorage.setItem(key, JSON.stringify(highlights));
        return true;
    } catch (error) {
        console.error('Error saving highlights:', error);
        return false;
    }
}

// ---- Highlight media storage (IndexedDB) ----
const HIGHLIGHT_MEDIA_DB = 'beebo-highlight-media';
const HIGHLIGHT_MEDIA_STORE = 'media';
let highlightMediaDbPromise = null;

function openHighlightMediaDb() {
    if (!highlightMediaDbPromise) {
        highlightMediaDbPromise = new Promise(function(resolve, reject) {
            if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            const req = window.indexedDB.open(HIGHLIGHT_MEDIA_DB, 1);
            req.onupgradeneeded = function() { req.result.createObjectStore(HIGHLIGHT_MEDIA_STORE); };
            req.onsuccess = function() { resolve(req.result); };
            req.onerror = function() { reject(req.error); };
        }).catch(function(error) {
            highlightMediaDbPromise = null; // allow a retry next time
            throw error;
        });
    }
    return highlightMediaDbPromise;
}

async function putHighlightMedia(id, blob) {
    const db = await openHighlightMediaDb();
    return new Promise(function(resolve, reject) {
        const tx = db.transaction(HIGHLIGHT_MEDIA_STORE, 'readwrite');
        tx.objectStore(HIGHLIGHT_MEDIA_STORE).put(blob, id);
        tx.oncomplete = function() { resolve(); };
        tx.onerror = tx.onabort = function() { reject(tx.error); };
    });
}

async function getHighlightMedia(id) {
    const db = await openHighlightMediaDb();
    return new Promise(function(resolve, reject) {
        const req = db.transaction(HIGHLIGHT_MEDIA_STORE, 'readonly').objectStore(HIGHLIGHT_MEDIA_STORE).get(id);
        req.onsuccess = function() { resolve(req.result || null); };
        req.onerror = function() { reject(req.error); };
    });
}

// The items to play for a highlight. Pre-`items` photo highlights become one legacy item
// whose picture is the stored cover; pre-`items` video highlights have nothing to play.
function getHighlightItems(h) {
    if (Array.isArray(h.items)) return h.items;
    if (h.kind === 'photo' && h.cover) {
        return [{ id: 'legacy-' + h.id, kind: 'photo', createdAt: parseInt(h.id, 10) || Date.now(), legacy: true }];
    }
    return [];
}

// Same as getHighlightItems but writes the legacy item into h.items so more can be appended.
function ensureHighlightItems(h) {
    if (!Array.isArray(h.items)) h.items = getHighlightItems(h);
    return h.items;
}

// -> { url, revoke } for the viewer, or null when the media is gone.
async function loadHighlightItemMedia(h, item) {
    if (item.legacy) return h.cover ? { url: h.cover, revoke: null } : null;
    const blob = await getHighlightMedia(item.id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url: url, revoke: function() { URL.revokeObjectURL(url); } };
}

// Small square JPEG thumbnail for the profile circle and the viewer header.
// Photos: scaled from the file. Videos: a frame near the start. '' when it can't be made
// (the circle then falls back to its video icon).
const HIGHLIGHT_COVER_PX = 192;

function drawHighlightCover(source, w, h) {
    const size = Math.min(HIGHLIGHT_COVER_PX, w, h);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const crop = Math.min(w, h);
    canvas.getContext('2d').drawImage(source, (w - crop) / 2, (h - crop) / 2, crop, crop, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.8);
}

function makeHighlightCover(file, kind) {
    return new Promise(function(resolve) {
        const url = URL.createObjectURL(file);
        let done = false;
        const finish = function(value) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            resolve(value);
        };
        const timer = setTimeout(function() { finish(''); }, 5000);
        try {
            if (kind === 'photo') {
                const img = new Image();
                img.onload = function() {
                    try { finish(drawHighlightCover(img, img.naturalWidth, img.naturalHeight)); } catch (e) { finish(''); }
                };
                img.onerror = function() { finish(''); };
                img.src = url;
            } else {
                const video = document.createElement('video');
                video.muted = true;
                video.playsInline = true;
                video.preload = 'auto';
                video.onloadeddata = function() { video.currentTime = Math.min(0.1, (video.duration || 0.2) / 2); };
                video.onseeked = function() {
                    try { finish(drawHighlightCover(video, video.videoWidth, video.videoHeight)); } catch (e) { finish(''); }
                };
                video.onerror = function() { finish(''); };
                video.src = url;
            }
        } catch (error) {
            finish('');
        }
    });
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
    if (newBtn) newBtn.addEventListener('click', function() { openHighlightUploadSheet(); });

    row.querySelectorAll('.profile-highlight-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            openHighlightViewer(btn.dataset.highlightId);
        });
    });
}

// ---- Highlight Upload Bottom Sheet ----
// Opened by the "New" circle (creates a highlight) or, with a highlight id, by the plus
// button in the viewer (appends to that highlight - "add mode"). In add mode the sheet is
// raised above the viewer and the viewer is paused until endHighlightAddMode().
let highlightAddTargetId = null;
let highlightAddBusy = false; // a picked file is being processed

function openHighlightUploadSheet(targetHighlightId) {
    const sheet = document.getElementById('highlight-upload-sheet');
    const backdrop = document.getElementById('highlight-upload-backdrop');
    if (!sheet || !backdrop) return;

    highlightAddTargetId = typeof targetHighlightId === 'string' ? targetHighlightId : null;
    // Above the viewer (z-55), below the toast (z-60).
    sheet.style.zIndex = highlightAddTargetId ? '57' : '';
    backdrop.style.zIndex = highlightAddTargetId ? '56' : '';

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
        sheet.style.zIndex = '';
    }
    if (backdrop) {
        backdrop.classList.add('hidden');
        backdrop.style.zIndex = '';
    }
    // The viewer, when open behind the sheet, keeps the page scroll-locked itself.
    const viewer = document.getElementById('highlight-viewer-overlay');
    if (!viewer || viewer.classList.contains('hidden')) document.body.classList.remove('overlay-open');
}

// Leaves add mode and lets the viewer play again.
function endHighlightAddMode() {
    highlightAddTargetId = null;
    highlightAddBusy = false;
    if (typeof hvResume === 'function') hvResume('add');
}

// Backdrop tap / Cancel: close the sheet without picking anything.
function cancelHighlightUpload() {
    closeHighlightUploadSheet();
    endHighlightAddMode();
}

const HIGHLIGHT_MEDIA_MAX_SIZE = 25 * 1024 * 1024; // 25MB, generous for photo or short video

async function handleHighlightMediaSelected(event, kind) {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // allow re-selecting the same file later

    if (!file) { endHighlightAddMode(); return; }

    const expectedPrefix = kind === 'photo' ? 'image/' : 'video/';
    if (!file.type.startsWith(expectedPrefix)) {
        showToast(kind === 'photo' ? 'Please choose an image file.' : 'Please choose a video file.');
        endHighlightAddMode();
        return;
    }
    if (file.size > HIGHLIGHT_MEDIA_MAX_SIZE) {
        showToast('File must be under 25MB.');
        endHighlightAddMode();
        return;
    }

    closeHighlightUploadSheet();
    highlightAddBusy = true;
    const targetId = highlightAddTargetId;

    try {
        const highlights = loadUserHighlights();
        const target = targetId ? highlights.find(function(h) { return h.id === targetId; }) : null;
        if (targetId && !target) throw new Error('Highlight not found');

        // The media itself goes to IndexedDB (see putHighlightMedia); the highlight keeps a
        // small item record plus a thumbnail cover.
        const itemId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        await putHighlightMedia(itemId, file);
        const item = { id: itemId, kind: kind, createdAt: Date.now() };

        if (target) {
            ensureHighlightItems(target).push(item);
            if (!target.cover) target.cover = await makeHighlightCover(file, kind);
        } else {
            const cover = await makeHighlightCover(file, kind);
            const title = (window.prompt('Name this highlight', 'Highlights') || 'Highlights').trim().slice(0, 20) || 'Highlights';
            highlights.push({
                id: `${Date.now()}`,
                title: title,
                cover: cover,
                kind: kind,
                items: [item]
            });
        }

        if (!saveUserHighlights(highlights)) throw new Error('Could not save highlights');
        renderProfileHighlights(highlights);
        if (target && typeof refreshHighlightViewer === 'function') refreshHighlightViewer(targetId);
        showToast(target ? 'Added to highlight' : 'Highlight added');
    } catch (error) {
        console.error('Error adding highlight:', error);
        showToast('Failed to add highlight. Please try again.');
    } finally {
        endHighlightAddMode();
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

    // The file picker was dismissed without a choice: leave add mode so the viewer resumes.
    // `cancel` is not fired everywhere, so the window regaining focus is a fallback.
    function watchPickerCancel() {
        window.addEventListener('focus', function onFocus() {
            window.removeEventListener('focus', onFocus);
            setTimeout(function() {
                if (highlightAddTargetId && !highlightAddBusy) endHighlightAddMode();
            }, 1200);
        });
    }
    [photoInput, videoInput].forEach(function(input) {
        if (input) input.addEventListener('cancel', function() { if (!highlightAddBusy) endHighlightAddMode(); });
    });

    if (photoBtn && photoInput) {
        photoBtn.addEventListener('click', function() {
            closeHighlightUploadSheet();
            watchPickerCancel();
            photoInput.click();
        });
        photoInput.addEventListener('change', function(e) { handleHighlightMediaSelected(e, 'photo'); });
    }
    if (videoBtn && videoInput) {
        videoBtn.addEventListener('click', function() {
            closeHighlightUploadSheet();
            watchPickerCancel();
            videoInput.click();
        });
        videoInput.addEventListener('change', function(e) { handleHighlightMediaSelected(e, 'video'); });
    }
    if (cancelBtn) cancelBtn.addEventListener('click', cancelHighlightUpload);
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

