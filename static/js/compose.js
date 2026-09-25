// ---- Compose Post: state & config ----
// composeState.images and composeState.audience are now sent to the server:
// handlePostSubmit() uses multipart/form-data (content + audience + images[])
// when images are attached, matching POST /api/posts on the backend.
const COMPOSE_MAX_CHARS = 2000;
const COMPOSE_MAX_IMAGES = 4;
const COMPOSE_DRAFT_KEY = 'beebo_draft_v1';

let composeState = {
    images: [],       // [{ dataUrl, name }]
    audience: 'Public'
};
let composeAutosaveTimer = null;

// Paints the logged-in user's current profile picture into the composer's
// avatar. Same source and fallback as the feed header, side nav and profile
// screens: session.user.profile_picture (served live from users.profile_picture
// by /api/session, so it survives reloads, and patched in place by the
// profile-photo upload flow and by account switching), falling back to the
// handle-seeded generated avatar only when no custom picture is set.
function updateComposeAvatar() {
    const img = document.getElementById('compose-avatar-img');
    const nameEl = document.getElementById('compose-user-name');
    if (typeof session === 'undefined' || !session || !session.user) return;

    const user = session.user;
    const handle = user.username || (user.email ? user.email.split('@')[0] : '');

    if (img) {
        const src = user.profile_picture || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handle)}`;
        // Only touch src when it actually changed, so re-opening the composer
        // doesn't re-request/flicker an unchanged image.
        if (img.getAttribute('src') !== src) img.src = src;
        img.alt = user.full_name || '';
    }

    if (nameEl) nameEl.textContent = user.full_name || handle || '';
}

// Called every time the create-post view is shown
function initComposeView() {
    const textarea = document.getElementById('create-post-textarea');
    const errorDiv = document.getElementById('create-post-error');

    updateComposeAvatar();

    errorDiv.classList.add('hidden');
    closeAudiencePicker();
    closeDiscardDialog();
    resetSubmitButtonState();

    const draft = loadDraft();
    if (draft) {
        textarea.value = draft.content || '';
        composeState.images = draft.images || [];
        composeState.audience = draft.audience || 'Public';
    } else {
        textarea.value = '';
        composeState.images = [];
        composeState.audience = 'Public';
    }

    document.getElementById('audience-label').textContent = composeState.audience;
    renderMediaGrid();
    updateCharCounter();
    updatePostButtonState();

    // Clear any leftover shift from a previous session before (re)measuring.
    stopComposeViewportPoll();
    updateComposeFooterPosition();

    // Autofocus only when starting a fresh post; leave cursor alone when
    // there's nothing typed yet vs. restoring a draft the user may just want to review.
    if (!draft) {
        textarea.focus();
    }
}

// ---- Keyboard-aware bottom toolbar (mobile) ----
// The footer sits at the bottom of #create-post-view (a bounded 100dvh flex
// column - see style.css). When the keyboard opens, two things can happen
// depending on browser/version: the layout viewport shrinks with it (the
// view, and so the footer, moves up natively), or only the visual viewport
// shrinks (the footer stays put, under the keyboard). Rather than guess
// which, measure: how far does the view's bottom edge hang below the bottom
// of the visual viewport? That is exactly how far the footer must be
// shifted, and it reads 0 when the layout already moved, so the two
// mechanisms can never double-shift.
function updateComposeFooterPosition() {
    const view = document.getElementById('create-post-view');
    const footer = document.getElementById('compose-footer');
    const scrollArea = document.getElementById('compose-scroll-area');
    const vv = window.visualViewport;
    if (!view || !footer || !scrollArea || !vv || !view.classList.contains('active')) {
        return;
    }

    // The view itself is never transformed, so its rect is the footer's
    // natural (un-shifted) bottom edge.
    const visualBottom = vv.offsetTop + vv.height;
    const overhang = Math.max(0, Math.round(view.getBoundingClientRect().bottom - visualBottom));

    footer.style.transform = overhang > 0 ? `translateY(-${overhang}px)` : '';
    scrollArea.style.paddingBottom = overhang > 0 ? `calc(1rem + ${overhang}px)` : '';
}

// Trigger paths. No single one is reliable on every engine/version, so all
// of them feed the same idempotent function:
//   1. visualViewport resize/scroll - the standard signal.
//   2. window resize - catches builds where only this one fires.
//   3. focus/blur polling on the textarea (below) - does not depend on any
//      resize event firing at all.
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateComposeFooterPosition);
    window.visualViewport.addEventListener('scroll', updateComposeFooterPosition);
}
window.addEventListener('resize', updateComposeFooterPosition);

// Poll visualViewport for ~800ms after the textarea gains or loses focus,
// covering the keyboard open/close animation. Idempotent: a new poll cancels
// the previous one.
let composeViewportPollTimer = null;
const COMPOSE_POLL_INTERVAL_MS = 100;
const COMPOSE_POLL_DURATION_MS = 800;

function stopComposeViewportPoll() {
    if (composeViewportPollTimer !== null) {
        clearInterval(composeViewportPollTimer);
        composeViewportPollTimer = null;
    }
}

function startComposeViewportPoll() {
    stopComposeViewportPoll();
    const startedAt = Date.now();
    composeViewportPollTimer = setInterval(() => {
        updateComposeFooterPosition();
        if (Date.now() - startedAt >= COMPOSE_POLL_DURATION_MS) {
            stopComposeViewportPoll();
        }
    }, COMPOSE_POLL_INTERVAL_MS);
}

// ---- Character counter ----
function updateCharCounter() {
    const textarea = document.getElementById('create-post-textarea');
    const counter = document.getElementById('char-counter');
    const len = textarea.value.length;

    // Only surface the counter once the user is close to the limit —
    // keeps the composer uncluttered for the common short post.
    if (len >= COMPOSE_MAX_CHARS - 100) {
        counter.classList.remove('hidden');
        counter.textContent = `${len}/${COMPOSE_MAX_CHARS}`;
        counter.classList.toggle('text-red-500', len > COMPOSE_MAX_CHARS);
        counter.classList.toggle('text-gray-400', len <= COMPOSE_MAX_CHARS);
    } else {
        counter.classList.add('hidden');
    }
}

function updatePostButtonState() {
    const textarea = document.getElementById('create-post-textarea');
    const submitBtn = document.getElementById('submit-post-btn');
    const len = textarea.value.trim().length;
    const overLimit = textarea.value.length > COMPOSE_MAX_CHARS;
    submitBtn.disabled = len === 0 || overLimit;
    submitBtn.setAttribute('aria-disabled', String(submitBtn.disabled));
}

// ---- Media attach / preview / remove ----
function triggerMediaPicker() {
    document.getElementById('media-file-input').click();
}

function handleMediaFilesSelected(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // allow re-selecting the same file later

    if (!files.length) return;

    const errorDiv = document.getElementById('create-post-error');
    const remainingSlots = COMPOSE_MAX_IMAGES - composeState.images.length;

    if (remainingSlots <= 0) {
        errorDiv.textContent = `You can attach up to ${COMPOSE_MAX_IMAGES} photos per post.`;
        errorDiv.classList.remove('hidden');
        return;
    }

    const filesToAdd = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
        errorDiv.textContent = `Only ${remainingSlots} more photo${remainingSlots === 1 ? '' : 's'} could be added (max ${COMPOSE_MAX_IMAGES}).`;
        errorDiv.classList.remove('hidden');
    } else {
        errorDiv.classList.add('hidden');
    }

    filesToAdd.forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = e => {
            composeState.images.push({ dataUrl: e.target.result, name: file.name });
            renderMediaGrid();
            scheduleAutosave();
        };
        reader.readAsDataURL(file);
    });
}

function removeMediaImage(index) {
    composeState.images.splice(index, 1);
    renderMediaGrid();
    scheduleAutosave();
}

function renderMediaGrid() {
    const grid = document.getElementById('media-preview-grid');
    if (!composeState.images.length) {
        grid.classList.add('hidden');
        grid.innerHTML = '';
        return;
    }

    grid.classList.remove('hidden');
    grid.innerHTML = composeState.images.map((img, i) => `
<div class="relative aspect-square rounded-xl overflow-hidden bg-gray-100">
<img src="${img.dataUrl}" alt="Attached photo ${i + 1}" class="w-full h-full object-cover"/>
<button type="button" aria-label="Remove photo" class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors" onclick="removeMediaImage(${i})">
<i class="fa-solid fa-xmark text-xs"></i>
</button>
</div>`).join('');
}

// ---- Audience / category picker ----
function toggleAudiencePicker() {
    const sheet = document.getElementById('audience-sheet');
    const opening = sheet.classList.contains('hidden');
    if (opening) {
        openAudiencePicker();
    } else {
        closeAudiencePicker();
    }
}

function openAudiencePicker() {
    document.getElementById('audience-sheet').classList.remove('hidden');
    document.getElementById('audience-backdrop').classList.remove('hidden');
    document.getElementById('audience-picker-btn').setAttribute('aria-expanded', 'true');
    document.querySelectorAll('.audience-option').forEach(btn => {
        const isSelected = btn.dataset.value === composeState.audience;
        // Only the trailing checkmark reflects selection (matches the
        // reference sheet) - the row's own text stays the same weight/
        // color whether selected or not.
        btn.querySelector('i.fa-check').classList.toggle('hidden', !isSelected);
    });
}

function closeAudiencePicker() {
    document.getElementById('audience-sheet').classList.add('hidden');
    document.getElementById('audience-backdrop').classList.add('hidden');
    document.getElementById('audience-picker-btn').setAttribute('aria-expanded', 'false');
}

function selectAudience(value) {
    composeState.audience = value;
    document.getElementById('audience-label').textContent = value;
    closeAudiencePicker();
    scheduleAutosave();
}

// ---- Autosave / draft persistence (localStorage placeholder;
// see backend prompt for a real /api/drafts endpoint) ----
function scheduleAutosave() {
    clearTimeout(composeAutosaveTimer);
    composeAutosaveTimer = setTimeout(saveDraft, 400);
}

function saveDraft() {
    const textarea = document.getElementById('create-post-textarea');
    const content = textarea.value;

    if (!content.trim() && composeState.images.length === 0) {
        localStorage.removeItem(COMPOSE_DRAFT_KEY);
        return;
    }

    const draft = {
        content,
        images: composeState.images,
        audience: composeState.audience,
        savedAt: Date.now()
    };

    try {
        localStorage.setItem(COMPOSE_DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {
        // Storage quota exceeded (large images) — fail silently, draft simply
        // won't persist. Real media should go to the server, not localStorage.
    }
}

function loadDraft() {
    try {
        const raw = localStorage.getItem(COMPOSE_DRAFT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function clearDraft() {
    localStorage.removeItem(COMPOSE_DRAFT_KEY);
}

function hasUnsavedComposeContent() {
    const textarea = document.getElementById('create-post-textarea');
    return textarea.value.trim().length > 0 || composeState.images.length > 0;
}

// ---- Close / discard flow ----
function attemptCloseCompose() {
    if (hasUnsavedComposeContent()) {
        openDiscardDialog();
    } else {
        clearDraft();
        showView('feed');
    }
}

function openDiscardDialog() {
    document.getElementById('discard-backdrop').classList.remove('hidden');
    document.getElementById('discard-dialog').classList.remove('hidden');
}

function closeDiscardDialog() {
    document.getElementById('discard-backdrop').classList.add('hidden');
    document.getElementById('discard-dialog').classList.add('hidden');
}

function confirmDiscardPost() {
    clearDraft();
    composeState.images = [];
    composeState.audience = 'Public';
    closeDiscardDialog();
    showView('feed');
}

function saveDraftAndClose() {
    saveDraft();
    closeDiscardDialog();
    showToast('Draft saved');
    showView('feed');
}

// ---- Toast ----
let toastTimer = null;
function showToast(message) {
    const toast = document.getElementById('app-toast');
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

// ---- Submit button loading state ----
function setSubmitButtonLoading(isLoading) {
    const submitBtn = document.getElementById('submit-post-btn');
    const spinner = document.getElementById('submit-post-spinner');
    const label = document.getElementById('submit-post-label');

    submitBtn.disabled = isLoading;
    submitBtn.setAttribute('aria-busy', String(isLoading));
    spinner.classList.toggle('hidden', !isLoading);
    label.textContent = isLoading ? 'Posting…' : 'Post';
}

function resetSubmitButtonState() {
    setSubmitButtonLoading(false);
}

// Convert a data: URL (as stored in composeState.images) back into a Blob
// so it can be appended to FormData for upload.
function dataUrlToBlob(dataUrl) {
    const [header, base64] = dataUrl.split(',');
    const mimeMatch = header.match(/data:(.*?);base64/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}

// Handle the "Post" button in create-post-view
async function handlePostSubmit() {
    const textarea = document.getElementById('create-post-textarea');
    const errorDiv = document.getElementById('create-post-error');
    const content = textarea.value.trim();

    errorDiv.classList.add('hidden');

    if (!content) {
        errorDiv.textContent = 'Post cannot be empty.';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (content.length > COMPOSE_MAX_CHARS) {
        errorDiv.textContent = `Your post is over the ${COMPOSE_MAX_CHARS}-character limit.`;
        errorDiv.classList.remove('hidden');
        return;
    }

    setSubmitButtonLoading(true);

    try {
        const hasImages = composeState.images.length > 0;
        let response;

        if (hasImages) {
            // Multipart upload — backend expects `content`, `audience`, and
            // one or more `images` file fields on this path.
            const formData = new FormData();
            formData.append('content', content);
            formData.append('audience', composeState.audience);
            composeState.images.forEach((img, i) => {
                formData.append('images', dataUrlToBlob(img.dataUrl), img.name || `photo-${i}.png`);
            });

            response = await apiFetch('/api/posts', {
                method: 'POST',
                body: formData
            });
        } else {
            // No images — keep the original JSON path.
            response = await apiFetch('/api/posts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content, audience: composeState.audience })
            });
        }

        const data = await response.json();

        if (response.ok) {
            textarea.value = '';
            composeState.images = [];
            composeState.audience = 'Public';
            clearDraft();
            resetSubmitButtonState();
            showView('feed');
            showToast('Post published');
        } else {
            setSubmitButtonLoading(false);
            errorDiv.textContent = data.error || 'Failed to create post. Please try again.';
            errorDiv.classList.remove('hidden');
        }
    } catch (error) {
        setSubmitButtonLoading(false);
        errorDiv.textContent = 'Network error — check your connection and try again.';
        errorDiv.classList.remove('hidden');
    }
}

// Wire up textarea listeners once the DOM is ready
(function initComposeTextareaListeners() {
    const textarea = document.getElementById('create-post-textarea');
    if (!textarea) return;

    textarea.addEventListener('input', () => {
        updateCharCounter();
        updatePostButtonState();
        scheduleAutosave();
    });

    // Backstop for engines/builds where no viewport resize event fires.
    textarea.addEventListener('focus', startComposeViewportPoll);
    textarea.addEventListener('blur', startComposeViewportPoll);

    // Cmd/Ctrl+Enter submits, matching common composer shortcuts
    textarea.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!document.getElementById('submit-post-btn').disabled) {
                handlePostSubmit();
            }
        }
    });
})();
