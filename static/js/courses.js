// ---- Courses tab ----
// DEUS intro: a one-time welcome modal shown the first time an account opens
// the Courses tab. "Seen" is recorded the moment the modal is displayed, so it
// never reappears, whether the user taps Get Started, the X, the backdrop, or
// just navigates away.
//
// Persistence is per account in localStorage (keyed by session.user.id) so
// switching accounts on one device behaves correctly. It is a client-side
// placeholder: a different browser or a cleared WebView shows it again. Move
// the flag to the user record on the server when the Courses backend exists.
const DEUS_INTRO_KEY_PREFIX = 'beebo_deus_intro_seen_v1:';

function deusIntroKey() {
    if (typeof session === 'undefined' || !session || !session.user) return null;
    return DEUS_INTRO_KEY_PREFIX + String(session.user.id);
}

function hasSeenDeusIntro(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
}

function markDeusIntroSeen(key) {
    try { localStorage.setItem(key, '1'); } catch (e) {}
}

// Shows the modal. Used by the first-visit auto-open and by the header
// upload button, which brings the same modal out on every tap.
function openDeusIntro() {
    const modal = document.getElementById('deus-intro');
    if (!modal || !modal.classList.contains('hidden')) return;
    modal.classList.remove('hidden');
    // Next frame so the open transition runs from its initial state.
    requestAnimationFrame(function() { modal.classList.add('deus-intro-open'); });
}

// Called by showView() every time the Courses view becomes active.
function maybeShowDeusIntro() {
    const key = deusIntroKey();
    if (!key) return; // not signed in: nothing to key the flag to
    if (hasSeenDeusIntro(key)) return;
    markDeusIntroSeen(key);
    openDeusIntro();
}

function closeDeusIntro() {
    const modal = document.getElementById('deus-intro');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.remove('deus-intro-open');
    setTimeout(function() {
        if (!modal.classList.contains('deus-intro-open')) modal.classList.add('hidden');
    }, 220);
}

function deusGetStarted() {
    closeDeusIntro();
    // Consent comes first. Once the user has accepted the current version
    // they go straight on to the upload flow.
    requestCourseUpload();
}

// Single entry point for "start uploading a course" (header upload button and
// the intro's Get Started): DEUS needs the user's AI consent first.
function requestCourseUpload() {
    if (hasDeusConsent()) startCourseUpload();
    else openDeusConsent();
}

// Hide instantly when leaving the Courses tab (e.g. a nav tap under the modal).
function resetDeusIntro() {
    closeCoursesMenu();
    const modal = document.getElementById('deus-intro');
    if (!modal) return;
    modal.classList.remove('deus-intro-open');
    modal.classList.add('hidden');
}

// Upload flow is not built yet. Everything that starts an upload goes through
// requestCourseUpload() and lands here, so the flow is wired in one place.
// (The DEUS FAB just opens the intro modal via openDeusIntro().)
function startCourseUpload() {
    // TODO: open the course upload flow.
}

// ---- Category tabs + category data ----
// "all" is built in: always first, never stored, never editable or deletable.
// User categories are {id, name}, kept in order.
//
// Persistence is a per-account localStorage placeholder (same caveat as the
// DEUS intro flag): move it to the server with the Courses backend.
const COURSE_CATEGORIES_KEY_PREFIX = 'beebo_course_categories_v1:';
const COURSE_CATEGORY_MAX_LENGTH = 30;
let courseCategories = [];
let coursesActiveCategory = 'all';
let courseCategoryEditingId = null; // null = adding

function courseCategoriesKey() {
    if (typeof session === 'undefined' || !session || !session.user) return null;
    return COURSE_CATEGORIES_KEY_PREFIX + String(session.user.id);
}

function loadCourseCategories() {
    courseCategories = [];
    const key = courseCategoriesKey();
    if (!key) return;
    try {
        const raw = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(raw)) {
            courseCategories = raw.filter(function(c) {
                return c && typeof c.id === 'string' && typeof c.name === 'string' && c.name.trim();
            });
        }
    } catch (e) { courseCategories = []; }
}

function saveCourseCategories() {
    const key = courseCategoriesKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(courseCategories)); } catch (e) {}
}

function newCourseCategoryId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function renderCourseCategoryTabs() {
    const row = document.getElementById('courses-category-row');
    if (!row) return;
    if (coursesActiveCategory !== 'all' && !courseCategories.some(function(c) { return c.id === coursesActiveCategory; })) {
        coursesActiveCategory = 'all'; // selected category was deleted
    }
    const items = [{ id: 'all', name: 'All' }].concat(courseCategories);
    row.replaceChildren();
    items.forEach(function(cat) {
        const on = cat.id === coursesActiveCategory;
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(on));
        tab.dataset.category = cat.id;
        tab.className = 'course-tab shrink-0 h-9 px-5 rounded-full text-[14px] font-semibold active:scale-95 transition-transform duration-100' + (on ? ' is-active' : '');
        tab.textContent = cat.name;
        tab.addEventListener('click', function() { selectCourseCategory(cat.id); });
        row.appendChild(tab);
    });
}

function selectCourseCategory(category) {
    coursesActiveCategory = category;
    renderCourseCategoryTabs();
    const row = document.getElementById('courses-category-row');
    const active = row && row.querySelector('.course-tab.is-active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    // TODO: re-render / filter #courses-list for coursesActiveCategory.
}

// ---- Edit categories view ----
function openCourseCategories() {
    loadCourseCategories();
    renderCourseCategoryList();
    document.getElementById('course-categories-view').classList.remove('hidden');
}

function closeCourseCategories() {
    closeCourseCategoryDialog();
    const view = document.getElementById('course-categories-view');
    if (view) view.classList.add('hidden');
}

function renderCourseCategoryList() {
    const list = document.getElementById('course-categories-list');
    const empty = document.getElementById('course-categories-empty');
    if (!list) return;
    list.replaceChildren();
    empty.classList.toggle('hidden', courseCategories.length > 0);

    courseCategories.forEach(function(cat) {
        const li = document.createElement('li');
        li.dataset.id = cat.id;
        li.className = 'course-category-row flex items-center gap-4 h-[72px] pl-5 pr-3 rounded-2xl bg-white border border-gray-100';

        const handle = document.createElement('span');
        handle.className = 'course-category-handle w-8 h-10 flex items-center justify-center text-gray-500 cursor-grab';
        handle.setAttribute('aria-label', 'Drag to reorder');
        handle.innerHTML = '<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 9h14M5 15h14"></path></svg>';
        handle.addEventListener('pointerdown', function(e) { startCourseCategoryDrag(e, li); });

        const name = document.createElement('span');
        name.className = 'flex-1 min-w-0 truncate text-[16px] text-gray-900';
        name.textContent = cat.name;

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'w-11 h-11 rounded-full flex items-center justify-center text-gray-700 active:bg-gray-100 transition-colors';
        edit.setAttribute('aria-label', 'Rename ' + cat.name);
        edit.innerHTML = '<i class="fa-solid fa-pencil text-[17px]"></i>';
        edit.addEventListener('click', function() { openCourseCategoryDialog(cat.id); });

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'w-11 h-11 rounded-full flex items-center justify-center text-gray-700 active:bg-gray-100 transition-colors';
        del.setAttribute('aria-label', 'Delete ' + cat.name);
        del.innerHTML = '<i class="fa-regular fa-trash-can text-[18px]"></i>';
        del.addEventListener('click', function() { deleteCourseCategory(cat.id); });

        li.append(handle, name, edit, del);
        list.appendChild(li);
    });
}

function deleteCourseCategory(id) {
    // TODO: when courses carry a category, confirm first and move them to All.
    courseCategories = courseCategories.filter(function(c) { return c.id !== id; });
    saveCourseCategories();
    renderCourseCategoryList();
    renderCourseCategoryTabs();
    showToast('Category deleted');
}

// ---- Drag to reorder ----
// Transform-based sortable (the approach dnd-kit / Framer Motion Reorder use):
//  - The DOM is NOT reordered while dragging, so there is no layout thrash.
//    The held row follows the finger with translate3d (GPU-composited, no
//    transition, so it tracks 1:1).
//  - The other rows slide one slot up or down with a short eased transform
//    transition to open a gap where the row would land.
//  - On release the held row glides into its slot, and only then is the DOM
//    and data reordered, with transitions suppressed so nothing flashes.
//  - Dragging near the top/bottom edge auto-scrolls the list.
// Positions are measured once at pickup, in scroll-content coordinates, so
// auto-scroll and finger movement combine without re-measuring each frame.
const COURSE_DRAG_SETTLE_MS = 200;
const COURSE_DRAG_EDGE_PX = 72;      // auto-scroll hot zone height
const COURSE_DRAG_MAX_SCROLL = 14;   // px per frame at the very edge

function startCourseCategoryDrag(e, row) {
    e.preventDefault();
    const list = row.parentNode;
    const scroller = list.closest('.overflow-y-auto') || document.scrollingElement;
    const rows = Array.prototype.slice.call(list.children);
    const from = rows.indexOf(row);
    if (from < 0 || rows.length < 2) return;
    const pointerId = e.pointerId;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Slot geometry in scroll-content coordinates.
    const scrollerTop = scroller.getBoundingClientRect().top;
    const tops = rows.map(function(r) { return r.getBoundingClientRect().top - scrollerTop + scroller.scrollTop; });
    const heights = rows.map(function(r) { return r.offsetHeight; });
    const step = rows.length > 1 ? tops[1] - tops[0] : heights[0]; // row height + gap
    const startScroll = scroller.scrollTop;
    const startY = e.clientY;
    const minDy = tops[0] - tops[from];
    const maxDy = tops[rows.length - 1] - tops[from];

    let pointerY = startY;
    let lastDy = 0;
    let target = from;
    let raf = 0;
    let ended = false;

    list.classList.add('is-sorting');
    row.classList.add('is-dragging');
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }

    function currentDy() {
        const dy = (pointerY - startY) + (scroller.scrollTop - startScroll);
        return Math.max(minDy, Math.min(maxDy, dy));
    }

    function layout() {
        const dy = currentDy();
        row.style.transform = 'translate3d(0,' + dy + 'px,0)';
        lastDy = dy;
        // Target slot = the one whose center is nearest the held row's center.
        const center = tops[from] + dy + heights[from] / 2;
        let t = from;
        let best = Infinity;
        for (let i = 0; i < rows.length; i++) {
            const d = Math.abs(center - (tops[i] + heights[i] / 2));
            if (d < best) { best = d; t = i; }
        }
        target = t;
        rows.forEach(function(r, i) {
            if (r === row) return;
            let shift = 0;
            if (from < i && i <= target) shift = -step;
            else if (target <= i && i < from) shift = step;
            r.style.transform = shift ? 'translate3d(0,' + shift + 'px,0)' : '';
        });
    }

    function tick() {
        if (ended) return;
        const rect = scroller.getBoundingClientRect();
        let speed = 0;
        if (pointerY < rect.top + COURSE_DRAG_EDGE_PX) {
            speed = -COURSE_DRAG_MAX_SCROLL * Math.min(1, (rect.top + COURSE_DRAG_EDGE_PX - pointerY) / COURSE_DRAG_EDGE_PX);
        } else if (pointerY > rect.bottom - COURSE_DRAG_EDGE_PX) {
            speed = COURSE_DRAG_MAX_SCROLL * Math.min(1, (pointerY - (rect.bottom - COURSE_DRAG_EDGE_PX)) / COURSE_DRAG_EDGE_PX);
        }
        if (speed) {
            scroller.scrollTop += speed;
            layout();
        }
        raf = requestAnimationFrame(tick);
    }

    function onMove(ev) {
        if (ev.pointerId !== pointerId) return;
        pointerY = ev.clientY;
        layout();
    }

    function commit() {
        // Reorder data + DOM with transitions off so the swap is invisible.
        // Drop the classes that carry transitions first, so clearing the
        // transforms and reordering below can't animate.
        row.classList.remove('is-dragging', 'is-settling');
        list.classList.remove('is-sorting');
        const order = rows.slice();
        order.splice(from, 1);
        order.splice(target, 0, row);
        rows.forEach(function(r) { r.style.transform = ''; });
        order.forEach(function(r) { list.appendChild(r); });
        const byId = {};
        courseCategories.forEach(function(c) { byId[c.id] = c; });
        courseCategories = order.map(function(r) { return byId[r.dataset.id]; }).filter(Boolean);
        saveCourseCategories();
        renderCourseCategoryTabs();
    }

    function onEnd(ev) {
        if (ev && ev.pointerId !== pointerId) return;
        if (ended) return;
        ended = true;
        cancelAnimationFrame(raf);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onEnd);
        document.removeEventListener('pointercancel', onEnd);

        // Glide the held row into its slot, then commit.
        const settleDy = tops[target] - tops[from];
        row.classList.add('is-settling');
        row.style.transform = 'translate3d(0,' + settleDy + 'px,0)';
        if (reduceMotion || Math.abs(settleDy - lastDy) < 0.5) { commit(); return; }
        let done = false;
        function finish() { if (done) return; done = true; commit(); }
        row.addEventListener('transitionend', function te(t) {
            if (t.propertyName !== 'transform') return;
            row.removeEventListener('transitionend', te);
            finish();
        });
        setTimeout(finish, COURSE_DRAG_SETTLE_MS + 80); // safety net
    }

    layout();
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
    raf = requestAnimationFrame(tick);
}

// ---- Add / rename dialog ----
function openCourseCategoryDialog(id) {
    courseCategoryEditingId = id;
    const cat = id ? courseCategories.find(function(c) { return c.id === id; }) : null;
    document.getElementById('course-category-dialog-title').textContent = cat ? 'Rename category' : 'Add category';
    document.getElementById('course-category-submit').textContent = cat ? 'Save' : 'Add';
    const input = document.getElementById('course-category-input');
    input.value = cat ? cat.name : '';
    onCourseCategoryInput();
    document.getElementById('course-category-dialog').classList.remove('hidden');
    setTimeout(function() { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 50);
}

function closeCourseCategoryDialog() {
    const dialog = document.getElementById('course-category-dialog');
    if (dialog) dialog.classList.add('hidden');
    courseCategoryEditingId = null;
}

// Returns an error message, or '' when the name is acceptable.
function courseCategoryNameError(raw) {
    const name = raw.trim();
    if (!name) return '';
    const lower = name.toLowerCase();
    if (lower === 'all') return '\u201cAll\u201d is built in';
    const clash = courseCategories.some(function(c) {
        return c.id !== courseCategoryEditingId && c.name.trim().toLowerCase() === lower;
    });
    return clash ? 'A category with this name already exists' : '';
}

function onCourseCategoryInput() {
    const input = document.getElementById('course-category-input');
    const helper = document.getElementById('course-category-helper');
    const submit = document.getElementById('course-category-submit');
    const error = courseCategoryNameError(input.value);
    helper.textContent = error || '*required';
    helper.classList.toggle('text-red-600', !!error);
    helper.classList.toggle('text-gray-500', !error);
    submit.disabled = !input.value.trim() || !!error;
}

function submitCourseCategory() {
    const input = document.getElementById('course-category-input');
    const name = input.value.trim().slice(0, COURSE_CATEGORY_MAX_LENGTH);
    if (!name || courseCategoryNameError(name)) return;
    if (courseCategoryEditingId) {
        const cat = courseCategories.find(function(c) { return c.id === courseCategoryEditingId; });
        if (cat) cat.name = name;
    } else {
        courseCategories.push({ id: newCourseCategoryId(), name: name });
    }
    saveCourseCategories();
    closeCourseCategoryDialog();
    renderCourseCategoryList();
    renderCourseCategoryTabs();
}

// showView() hooks (see core.js)
function onCoursesViewShown() {
    loadCourseCategories();
    renderCourseCategoryTabs();
    loadCourseFolders();
    renderCourseFolders();
    maybeShowDeusIntro();
}

function onCoursesViewHidden() {
    closeCourseFolder();
    closeCourseFolderDialog();
    closeCourseCategories();
    closeDeusConsent();
    resetDeusIntro();
}

// ---- Courses options menu (header 3-dot button) ----
// Bottom sheet, same pattern as the Library file menu.
function openCoursesMenu() {
    document.getElementById('courses-menu-sheet').classList.remove('hidden');
    document.getElementById('courses-menu-backdrop').classList.remove('hidden');
}

function closeCoursesMenu() {
    const sheet = document.getElementById('courses-menu-sheet');
    const backdrop = document.getElementById('courses-menu-backdrop');
    if (sheet) sheet.classList.add('hidden');
    if (backdrop) backdrop.classList.add('hidden');
}

function coursesMenuAction(action) {
    closeCoursesMenu();
    if (action === 'categories') openCourseCategories();
    else if (action === 'gpa') showView('gpa-calculator');
}

// ---- DEUS AI Study Buddy consent ----
// Shown after "Get Started" until the user has accepted the current
// DEUS_CONSENT_VERSION. Bump the version when the terms or the way data is
// processed change materially (section 12 promises users are told and asked
// again); everyone is then shown the screen once more.
//
// The acceptance record is stored per account in localStorage as a
// placeholder. A consent record that has to stand up as evidence (who
// accepted which version, and when) must be written server-side with the
// Courses backend: do not rely on this client copy for that.
const DEUS_CONSENT_VERSION = 1;
const DEUS_CONSENT_KEY_PREFIX = 'beebo_deus_consent:';

// Facts the copy depends on. Anything in [square brackets] is an unfilled
// placeholder: it is highlighted on screen so it cannot ship unnoticed. Fill
// each one in with the real, verified answer before launch.
const DEUS_CONSENT_FACTS = {
    provider: '[AI provider name]',
    storageLocation: '[where conversations are stored]',
    retention: '[retention period]',
    otherUses: '[State any other use of this content, or that there is none.]',
    training: '[State whether your content is used to train AI models.]',
    providerRetention: '[how long the provider keeps copies]',
    minAge: '[minimum age]',
    youngerSafeguards: '[safeguards for younger students]',
    contact: '[support email]'
};

// Each section: [heading, [paragraphs]]. A paragraph is an array of strings
// and {fact: key} markers, so placeholders can be highlighted.
function deusConsentCopy() {
    const f = function(key) { return { fact: key }; };
    return [
        ['Third-party AI processing', [
            ['DEUS is powered by AI models run by an outside provider, not by Beebo itself. When you chat with DEUS or upload course files, your messages and the content of your uploads are sent to ', f('provider'), ' so that it can write replies, summaries and cards for you.']
        ]],
        ['Personal information', [
            ['Do not share passwords, ID numbers, bank or card details, health information, or private details about other people in your messages or uploads. Where you can, remove names and personal details from files before you upload them.']
        ]],
        ['Conversation storage', [
            ['Your conversations with DEUS and the course content you upload are stored so you can come back to them. They are kept in ', f('storageLocation'), ' for ', f('retention'), ', or until you delete them, whichever comes first.']
        ]],
        ['How your data is used', [
            ['We use your messages and uploads to run DEUS: to read your files, write summaries, organise them into cards and answer your questions. ', f('training')],
            [f('otherUses')]
        ]],
        ['Who receives your information', [
            ['Your messages and uploads are shared with ', f('provider'), ' only as needed to run DEUS. We do not sell your personal information. We may also disclose information where the law requires us to.']
        ]],
        ['Deleting your data', [
            ['You can delete your conversations and uploaded files from within the AI Study Buddy at any time. Deleting them removes them from Beebo\u2019s storage. Copies held by our AI provider are handled under the provider\u2019s own retention rules: ', f('providerRetention'), '. If you need help, contact ', f('contact'), '.']
        ]],
        ['AI can be wrong', [
            ['DEUS can make mistakes. Its answers, summaries and cards may be inaccurate, incomplete, out of date or misleading. Check anything important against your lecturer\u2019s materials, your textbooks and official course sources before you rely on it.']
        ]],
        ['Your academic responsibility', [
            ['You are responsible for how you use what DEUS produces. Using it to help you study is fine. Handing in AI-generated work as your own where your institution does not allow it is not. Follow your institution\u2019s academic integrity rules and any AI policy set for your course.']
        ]],
        ['What you must not do', [
            ['Do not use DEUS to harass or harm others, to ask for harmful or illegal content, to break the law, or to cheat, for example by completing graded work or exams in breach of your institution\u2019s rules. We may limit or remove your access to DEUS if it is misused.']
        ]],
        ['Age requirements', [
            ['You must be at least ', f('minAge'), ' to use DEUS. If you are under 18, you need the permission of a parent or guardian, and we apply extra safeguards: ', f('youngerSafeguards'), '.']
        ]],
        ['Withdrawing your consent', [
            ['You can withdraw your consent at any time by contacting ', f('contact'), '. Withdrawing does not affect processing that took place before you withdrew. We cannot offer DEUS without your consent, so you will no longer be able to use it. The rest of Beebo is not affected.']
        ]],
        ['Changes to these terms', [
            ['If we make a significant change to how DEUS processes your data, or to these terms, we will tell you in the app before it takes effect, and we will ask you to review and accept again where the law requires it.']
        ]]
    ];
}

function renderDeusConsentSections() {
    const list = document.getElementById('deus-consent-sections');
    if (!list || list.childElementCount) return;
    deusConsentCopy().forEach(function(section, index) {
        const li = document.createElement('li');
        li.className = 'rounded-2xl bg-white border border-gray-100 px-4 py-4';

        const head = document.createElement('div');
        head.className = 'flex items-center gap-3';
        const num = document.createElement('span');
        num.className = 'deus-consent-num shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-semibold';
        num.textContent = String(index + 1);
        const title = document.createElement('h2');
        title.className = 'text-[16px] leading-5 font-semibold text-gray-900';
        title.textContent = section[0];
        head.append(num, title);
        li.appendChild(head);

        section[1].forEach(function(parts) {
            const p = document.createElement('p');
            p.className = 'text-[14px] leading-[22px] text-gray-600 mt-2.5';
            parts.forEach(function(part) {
                if (typeof part === 'string') {
                    p.appendChild(document.createTextNode(part));
                    return;
                }
                const value = DEUS_CONSENT_FACTS[part.fact];
                if (/^\[.*\]$/.test(value)) {
                    const mark = document.createElement('span');
                    mark.className = 'deus-consent-todo';
                    mark.textContent = value;
                    p.appendChild(mark);
                } else {
                    p.appendChild(document.createTextNode(value));
                }
            });
            li.appendChild(p);
        });
        list.appendChild(li);
    });
}

function deusConsentKey() {
    if (typeof session === 'undefined' || !session || !session.user) return null;
    return DEUS_CONSENT_KEY_PREFIX + String(session.user.id);
}

function hasDeusConsent() {
    const key = deusConsentKey();
    if (!key) return false;
    try {
        const rec = JSON.parse(localStorage.getItem(key) || 'null');
        return !!rec && rec.version === DEUS_CONSENT_VERSION && rec.terms === true && rec.notice === true;
    } catch (e) { return false; }
}

function openDeusConsent() {
    renderDeusConsentSections();
    document.getElementById('deus-consent-terms').checked = false;
    document.getElementById('deus-consent-notice').checked = false;
    onDeusConsentChange();
    document.getElementById('deus-consent-scroll').scrollTop = 0;
    document.getElementById('deus-consent-view').classList.remove('hidden');
}

function closeDeusConsent() {
    const view = document.getElementById('deus-consent-view');
    if (view) view.classList.add('hidden');
}

// The two acknowledgements are separate and both required. They are not
// pre-ticked, and the informational third line is not a checkbox.
function onDeusConsentChange() {
    const ok = document.getElementById('deus-consent-terms').checked &&
               document.getElementById('deus-consent-notice').checked;
    document.getElementById('deus-consent-accept').disabled = !ok;
}

function acceptDeusConsent() {
    const terms = document.getElementById('deus-consent-terms').checked;
    const notice = document.getElementById('deus-consent-notice').checked;
    if (!terms || !notice) return;
    const key = deusConsentKey();
    if (key) {
        try {
            localStorage.setItem(key, JSON.stringify({
                version: DEUS_CONSENT_VERSION,
                acceptedAt: new Date().toISOString(),
                terms: true,
                notice: true
            }));
        } catch (e) {}
    }
    closeDeusConsent();
    startCourseUpload();
}

// ---- Folders ----
// A folder is {id, name, createdAt}. Stored per account in localStorage as a
// placeholder (same caveat as categories); folders cannot hold courses yet.
const COURSE_FOLDERS_KEY_PREFIX = 'beebo_course_folders_v1:';
const COURSE_FOLDER_MAX_LENGTH = 30;
let courseFolders = [];
let openCourseFolderId = null;

function courseFoldersKey() {
    if (typeof session === 'undefined' || !session || !session.user) return null;
    return COURSE_FOLDERS_KEY_PREFIX + String(session.user.id);
}

function loadCourseFolders() {
    courseFolders = [];
    const key = courseFoldersKey();
    if (!key) return;
    try {
        const raw = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(raw)) {
            courseFolders = raw.filter(function(f) {
                return f && typeof f.id === 'string' && typeof f.name === 'string' && f.name.trim();
            });
        }
    } catch (e) { courseFolders = []; }
}

function saveCourseFolders() {
    const key = courseFoldersKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(courseFolders)); } catch (e) {}
}

// "Empty" for a folder with nothing in it, otherwise "1 Item" / "N Items".
// An item is anything inside, whether another folder or a file. Folders can't
// hold anything yet, so folder.items does not exist and the count is 0.
function courseFolderSubtitle(folder) {
    const count = folder && Array.isArray(folder.items) ? folder.items.length : 0;
    if (count === 0) return 'Empty';
    return count + (count === 1 ? ' Item' : ' Items');
}

// Renders the folder cards into #courses-list (newest first). The "No courses
// yet" empty state only shows while there are no folders either.
function renderCourseFolders(newId) {
    const list = document.getElementById('courses-list');
    const empty = document.getElementById('courses-empty');
    if (!list) return;
    list.replaceChildren();
    if (empty) empty.classList.toggle('hidden', courseFolders.length > 0);

    courseFolders.forEach(function(folder) {
        const card = document.createElement('button');
        card.type = 'button';
        card.dataset.id = folder.id;
        card.className = 'course-folder-card course-card-shadow w-full flex items-center gap-4 p-3.5 rounded-2xl bg-white border border-gray-100 text-left active:scale-[0.98] transition-transform duration-100' +
            (folder.id === newId ? ' course-folder-new' : '');
        card.addEventListener('click', function() { openCourseFolder(folder.id); });

        const tile = document.createElement('span');
        tile.className = 'course-folder-tile shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center';
        tile.innerHTML = '<i class="fa-solid fa-folder text-[22px]"></i>';

        const text = document.createElement('span');
        text.className = 'flex-1 min-w-0';
        const name = document.createElement('span');
        name.className = 'block truncate text-[16px] font-semibold text-gray-900';
        name.textContent = folder.name;
        const sub = document.createElement('span');
        sub.className = 'block text-[13px] text-gray-500 mt-0.5';
        sub.textContent = courseFolderSubtitle(folder);
        text.append(name, sub);

        const chevron = document.createElement('i');
        chevron.className = 'fa-solid fa-chevron-right text-[14px] text-gray-400 pr-1';

        card.append(tile, text, chevron);
        list.appendChild(card);
    });
}

// ---- Folder screen ----
function openCourseFolder(id) {
    const folder = courseFolders.find(function(f) { return f.id === id; });
    if (!folder) return;
    openCourseFolderId = id;
    document.getElementById('course-folder-title').textContent = folder.name;
    document.getElementById('course-folder-subtitle').textContent = courseFolderSubtitle(folder);
    document.getElementById('course-folder-view').classList.remove('hidden');
}

function closeCourseFolder() {
    openCourseFolderId = null;
    const view = document.getElementById('course-folder-view');
    if (view) view.classList.add('hidden');
}

// ---- Add folder dialog ----
function openCourseFolderDialog() {
    const input = document.getElementById('course-folder-input');
    input.value = '';
    onCourseFolderInput();
    document.getElementById('course-folder-dialog').classList.remove('hidden');
    setTimeout(function() { input.focus(); }, 50);
}

function closeCourseFolderDialog() {
    const dialog = document.getElementById('course-folder-dialog');
    if (dialog) dialog.classList.add('hidden');
}

function courseFolderNameError(raw) {
    const lower = raw.trim().toLowerCase();
    if (!lower) return '';
    return courseFolders.some(function(f) { return f.name.trim().toLowerCase() === lower; })
        ? 'A folder with this name already exists' : '';
}

function onCourseFolderInput() {
    const input = document.getElementById('course-folder-input');
    const helper = document.getElementById('course-folder-helper');
    const error = courseFolderNameError(input.value);
    helper.textContent = error || '*required';
    helper.classList.toggle('text-red-600', !!error);
    helper.classList.toggle('text-gray-500', !error);
    document.getElementById('course-folder-submit').disabled = !input.value.trim() || !!error;
}

function submitCourseFolder() {
    if (document.getElementById('course-folder-submit').disabled) return;
    const name = document.getElementById('course-folder-input').value.trim().slice(0, COURSE_FOLDER_MAX_LENGTH);
    if (!name || courseFolderNameError(name)) return;
    const folder = { id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name, createdAt: new Date().toISOString() };
    courseFolders.unshift(folder);
    saveCourseFolders();
    closeCourseFolderDialog();
    renderCourseFolders(folder.id);
}
