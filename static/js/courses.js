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

// Open the file picker. The upload buttons (header, folder screen) call this
// directly: storing a file needs no AI consent. Only the DEUS "Get Started"
// path goes through requestCourseUpload() (consent first) before landing here.
// The destination is whatever folder is on screen (top level when none).
function startCourseUpload() {
    const picker = document.getElementById('course-file-picker');
    if (picker) picker.click();
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
    renderCourseTop();
}

function selectCourseCategory(category) {
    coursesActiveCategory = category;
    renderCourseCategoryTabs();
    const row = document.getElementById('courses-category-row');
    const active = row && row.querySelector('.course-tab.is-active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
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
    // Documents in the deleted category simply fall back to "All" only.
    courseCategories = courseCategories.filter(function(c) { return c.id !== id; });
    saveCourseCategories();
    pruneCourseFileCategories();
    pruneCourseFolderCategories();
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
    onCourseDataShown();
    maybeShowDeusIntro();
}

function onCoursesViewHidden() {
    closeCourseReader();
    hideCourseFolderView();
    closeCourseFolderDialog();
    closeCourseFileDialog();
    closeCourseFileMenu();
    endCourseDrag(false);
    closeCourseFolderMenu();
    closeCourseFileCategorySheet();
    closeCourseConfirm();
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

// ---- Courses data: folders + files (server-backed) ----
// Folders and files live on the server (/api/courses/*), private to the user.
// The top level renders into #courses-list; a folder (and any folder inside
// it) renders on the folder screen. One folder's contents = its subfolders
// and files, folders first, newest first (the server sorts).
const COURSE_LOCAL_FOLDERS_KEY_PREFIX = 'beebo_course_folders_v1:'; // legacy, migrated once
const COURSE_FOLDER_MAX_LENGTH = 30;
const COURSE_FILE_NAME_MAX_LENGTH = 100;
const COURSE_MAX_FILE_BYTES = 50 * 1024 * 1024;
const COURSE_ALLOWED_TYPES = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'md', 'jpg', 'jpeg', 'png', 'webp'];
const COURSE_INLINE_TYPES = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
const COURSE_FILE_STYLES = {
    pdf:  { bg: 'bg-red-500',    icon: 'fa-file-pdf' },
    doc:  { bg: 'bg-blue-500',   icon: 'fa-file-word' },
    docx: { bg: 'bg-blue-500',   icon: 'fa-file-word' },
    ppt:  { bg: 'bg-orange-500', icon: 'fa-file-powerpoint' },
    pptx: { bg: 'bg-orange-500', icon: 'fa-file-powerpoint' },
    xls:  { bg: 'bg-green-500',  icon: 'fa-file-excel' },
    xlsx: { bg: 'bg-green-500',  icon: 'fa-file-excel' },
    txt:  { bg: 'bg-gray-500',   icon: 'fa-file-lines' },
    md:   { bg: 'bg-gray-500',   icon: 'fa-file-lines' },
    jpg:  { bg: 'bg-sky-500',    icon: 'fa-file-image' },
    jpeg: { bg: 'bg-sky-500',    icon: 'fa-file-image' },
    png:  { bg: 'bg-sky-500',    icon: 'fa-file-image' },
    webp: { bg: 'bg-sky-500',    icon: 'fa-file-image' }
};
const COURSE_DEFAULT_FILE_STYLE = { bg: 'bg-gray-400', icon: 'fa-file' };

let courseTopData = null;          // last top-level response
let courseFolderData = null;       // last response for the folder on screen
let openCourseFolderId = null;     // folder on the folder screen (null = none open)
let courseFolderShownId = null;    // folder whose contents are currently rendered
let courseFolderStack = [];        // parents we came from, for Back
let courseTopLoadToken = 0;
let courseFolderLoadToken = 0;
let courseDataUserId = null;

function courseItemCountText(count) {
    if (!count) return 'Empty';
    return count + (count === 1 ? ' Item' : ' Items');
}

function courseFileStyle(type) {
    return COURSE_FILE_STYLES[type] || COURSE_DEFAULT_FILE_STYLE;
}

function courseCurrentFolders() {
    const data = openCourseFolderId === null ? courseTopData : courseFolderData;
    return data ? data.folders : [];
}

async function fetchCourseItems(folderId) {
    const url = '/api/courses/items' + (folderId !== null ? '?folder_id=' + encodeURIComponent(folderId) : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error('load failed');
    return res.json();
}

async function courseErrorMessage(res, fallback) {
    try {
        const data = await res.json();
        if (data && typeof data.error === 'string' && data.error) return data.error;
    } catch (e) {}
    return fallback;
}

// ---- Cards ----
// Tap and hold a folder card to open its Rename / Delete menu.
const COURSE_LONG_PRESS_MS = 500;
const COURSE_LONG_PRESS_SLOP = 10;

function attachCourseFolderLongPress(card, folder) {
    let timer = null, startX = 0, startY = 0;
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    function fire() {
        timer = null;
        card._lpBlock = true;
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) {} }
        openCourseFolderMenu(folder);
    }
    card.addEventListener('pointerdown', function(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        card._lpBlock = false;
        startX = e.clientX;
        startY = e.clientY;
        cancel();
        timer = setTimeout(fire, COURSE_LONG_PRESS_MS);
    });
    card.addEventListener('pointermove', function(e) {
        if (timer && (Math.abs(e.clientX - startX) > COURSE_LONG_PRESS_SLOP || Math.abs(e.clientY - startY) > COURSE_LONG_PRESS_SLOP)) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(type) {
        card.addEventListener(type, cancel);
    });
    // Native long-press / right-click menu: replace it with ours.
    card.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        if (card._lpBlock) return;
        cancel();
        card._lpBlock = true;
        openCourseFolderMenu(folder);
    });
}

function buildCourseFolderCard(folder, isNew) {
    const card = document.createElement('button');
    card.type = 'button';
    card.dataset.id = folder.id;
    card.className = 'course-folder-card course-card-shadow w-full flex items-center gap-3 p-3 rounded-2xl bg-white border border-gray-100 text-left active:scale-[0.98] transition-transform duration-100' + (isNew ? ' course-folder-new' : '');
    card.style.webkitTouchCallout = 'none';
    card.style.userSelect = 'none';
    card.addEventListener('click', function() {
        if (card._lpBlock) { card._lpBlock = false; return; } // click that ends a long press
        openCourseFolder(folder.id, { name: folder.name });
    });
    attachCourseFolderLongPress(card, folder);

    const tile = document.createElement('span');
    tile.className = 'course-folder-tile shrink-0 w-[35px] h-[35px] rounded-xl flex items-center justify-center';
    tile.innerHTML = '<i class="fa-solid fa-folder text-[16px]"></i>';

    const text = document.createElement('span');
    text.className = 'flex-1 min-w-0';
    const name = document.createElement('span');
    name.className = 'block truncate text-[16px] leading-[19px] font-semibold text-gray-900';
    name.textContent = folder.name;
    const sub = document.createElement('span');
    sub.className = 'block text-[9px] leading-4 text-gray-500';
    sub.textContent = courseItemCountText(folder.item_count);
    text.append(name, sub);

    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-right text-[12px] text-gray-400 pr-1';

    card.append(tile, text, chevron);
    return card;
}

// File card: type tile, name, date uploaded, and a ⋮ menu. Department, level
// and uploader are deliberately not shown for personal files.
// ---- Drag a file into a folder (tap and hold a file card) ----
// Hold a file card ~0.45 s: it dims in place, a floating chip follows the
// finger (offset above it so the finger never covers it), every folder card
// becomes a dashed drop target, and the folder under the finger lights up and
// opens. Release over a folder to move the file there (PATCH folder_id);
// release anywhere else, or press Escape, to cancel. Near the top/bottom edge
// the list auto-scrolls.
const COURSE_DRAG_HOLD_MS = 450;
const COURSE_DRAG_SLOP = 6;        // px of movement that cancels the hold (lets the page scroll)
const COURSE_DRAG_EDGE = 80;       // px from the scroll edge where auto-scroll kicks in
const COURSE_DRAG_SCROLL_MAX = 16; // px per frame at the very edge

let courseDrag = null; // active drag state, or null

// While a drag is active, stop the browser from scrolling the page under the
// finger. Registered once, non-passive, so preventDefault works.
document.addEventListener('touchmove', function(e) {
    if (courseDrag && e.cancelable) e.preventDefault();
}, { passive: false });

document.addEventListener('keydown', function(e) {
    if (courseDrag && e.key === 'Escape') endCourseDrag(false);
});

function courseScrollParent(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement || document.documentElement;
}

function courseFolderForCard(card) {
    if (!card) return null;
    return courseCurrentFolders().find(function(f) { return String(f.id) === card.dataset.id; }) || null;
}

function buildCourseDragGhost(file) {
    const style = courseFileStyle(file.file_type);
    const outer = document.createElement('div');
    outer.className = 'course-drag-ghost';
    const inner = document.createElement('div');
    inner.className = 'course-drag-ghost-inner';
    const tile = document.createElement('span');
    tile.className = 'course-drag-ghost-tile ' + style.bg;
    tile.innerHTML = '<i class="fa-solid ' + style.icon + '"></i>';
    const name = document.createElement('span');
    name.className = 'course-drag-ghost-name';
    name.textContent = file.name;
    inner.append(tile, name);
    outer.appendChild(inner);
    return outer;
}

function positionCourseDragGhost(d) {
    const offsetY = d.pointerType === 'mouse' ? 20 : 68;
    const x = Math.min(Math.max(8, d.x - d.gw / 2), window.innerWidth - d.gw - 8);
    const y = Math.max(8, d.y - d.gh - offsetY);
    d.ghost.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
}

function setCourseDropTarget(card) {
    const d = courseDrag;
    if (!d || d.hoverCard === card) return;
    if (d.hoverCard) {
        d.hoverCard.classList.remove('course-drop-hover');
        const prevIcon = d.hoverCard.querySelector('.course-folder-tile i');
        if (prevIcon) prevIcon.className = 'fa-solid fa-folder text-[16px]';
    }
    d.hoverCard = card;
    if (card) {
        card.classList.add('course-drop-hover');
        const icon = card.querySelector('.course-folder-tile i');
        if (icon) icon.className = 'fa-solid fa-folder-open text-[16px]';
        if (navigator.vibrate) { try { navigator.vibrate(6); } catch (e) {} }
    }
    const folder = courseFolderForCard(card);
    d.hint.classList.toggle('ready', !!folder);
    if (folder) d.hint.textContent = 'Move to \u201c' + folder.name + '\u201d';
    else d.hint.textContent = d.hasFolders ? 'Drop on a folder to move' : 'No folder here to drop into';
}

function updateCourseDrag(x, y) {
    const d = courseDrag;
    if (!d) return;
    d.x = x;
    d.y = y;
    positionCourseDragGhost(d);
    const el = document.elementFromPoint(x, y);
    setCourseDropTarget(el ? el.closest('.course-folder-card') : null);
}

function courseDragTick() {
    const d = courseDrag;
    if (!d) return;
    const root = document.scrollingElement || document.documentElement;
    const rect = (d.scroller === root || d.scroller === document.documentElement)
        ? { top: 0, bottom: window.innerHeight }
        : d.scroller.getBoundingClientRect();
    let dy = 0;
    if (d.y < rect.top + COURSE_DRAG_EDGE) {
        dy = -Math.ceil(COURSE_DRAG_SCROLL_MAX * (1 - Math.max(0, d.y - rect.top) / COURSE_DRAG_EDGE));
    } else if (d.y > rect.bottom - COURSE_DRAG_EDGE) {
        dy = Math.ceil(COURSE_DRAG_SCROLL_MAX * (1 - Math.max(0, rect.bottom - d.y) / COURSE_DRAG_EDGE));
    }
    if (dy) {
        d.scroller.scrollTop += dy;
        updateCourseDrag(d.x, d.y); // the content moved under a still finger
    }
    d.raf = requestAnimationFrame(courseDragTick);
}

function startCourseDrag(card, file, pointerId, pointerType, x, y) {
    if (courseDrag) return;
    const ghost = buildCourseDragGhost(file);
    document.body.appendChild(ghost);
    const hint = document.createElement('div');
    hint.className = 'course-drag-hint';
    document.body.appendChild(hint);
    requestAnimationFrame(function() { hint.classList.add('show'); });

    courseDrag = {
        file: file, card: card, ghost: ghost, hint: hint,
        pointerId: pointerId, pointerType: pointerType,
        x: x, y: y, gw: ghost.offsetWidth, gh: ghost.offsetHeight,
        hoverCard: null, raf: 0, scroller: courseScrollParent(card),
        hasFolders: courseCurrentFolders().length > 0
    };
    card._dragBlock = true; // swallow the click that ends the gesture
    card.classList.add('course-dragging-source');
    document.body.classList.add('course-drag-active');
    try { card.setPointerCapture(pointerId); } catch (e) {}
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    hint.textContent = courseDrag.hasFolders ? 'Drop on a folder to move' : 'No folder here to drop into';
    updateCourseDrag(x, y);
    courseDrag.raf = requestAnimationFrame(courseDragTick);
}

function endCourseDrag(commit) {
    const d = courseDrag;
    if (!d) return;
    courseDrag = null;
    cancelAnimationFrame(d.raf);
    document.body.classList.remove('course-drag-active');
    d.card.classList.remove('course-dragging-source');
    try { d.card.releasePointerCapture(d.pointerId); } catch (e) {}
    setTimeout(function() { d.card._dragBlock = false; }, 400);

    const targetCard = commit ? d.hoverCard : null;
    const folder = courseFolderForCard(targetCard);
    if (d.hoverCard) d.hoverCard.classList.remove('course-drop-hover');

    d.hint.classList.remove('show');
    setTimeout(function() { d.hint.remove(); }, 160);

    if (folder) {
        // Chip shrinks into the folder it was dropped on.
        const r = targetCard.getBoundingClientRect();
        const tx = Math.round(r.left + r.width / 2 - d.gw / 2);
        const ty = Math.round(r.top + r.height / 2 - d.gh / 2);
        d.ghost.style.transition = 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease';
        d.ghost.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(0.35)';
        d.ghost.style.opacity = '0';
        setTimeout(function() { d.ghost.remove(); }, 220);
        moveCourseFile(d.file, folder, d.card);
    } else {
        d.ghost.style.transition = 'opacity 140ms ease';
        d.ghost.style.opacity = '0';
        setTimeout(function() { d.ghost.remove(); }, 160);
        if (d.hoverCard) {
            const icon = d.hoverCard.querySelector('.course-folder-tile i');
            if (icon) icon.className = 'fa-solid fa-folder text-[16px]';
        }
    }
}

async function moveCourseFile(file, folder, card) {
    card.style.display = 'none'; // leaves the list immediately; restored on failure
    try {
        const res = await apiFetch('/api/courses/files/' + encodeURIComponent(file.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_id: folder.id })
        });
        if (res.ok) {
            setCourseFileCategory(file.id, null); // no longer a top-level file
            showToast('Moved to \u201c' + folder.name + '\u201d');
            reloadCourseLevel();
        } else {
            card.style.display = '';
            showToast(await courseErrorMessage(res, 'Could not move the file.'));
        }
    } catch (e) {
        card.style.display = '';
        showToast('Could not move the file.');
    }
}

function attachCourseFileDrag(card, file) {
    let timer = null, startX = 0, startY = 0, lastX = 0, lastY = 0, pid = null, ptype = 'touch';
    function cancelHold() { if (timer) { clearTimeout(timer); timer = null; } }
    card.addEventListener('pointerdown', function(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest('button') || courseDrag) return; // the "more" button keeps its own tap
        card._dragBlock = false;
        pid = e.pointerId;
        ptype = e.pointerType;
        startX = lastX = e.clientX;
        startY = lastY = e.clientY;
        cancelHold();
        timer = setTimeout(function() {
            timer = null;
            startCourseDrag(card, file, pid, ptype, lastX, lastY);
        }, COURSE_DRAG_HOLD_MS);
    });
    card.addEventListener('pointermove', function(e) {
        if (e.pointerId !== pid) return;
        lastX = e.clientX;
        lastY = e.clientY;
        if (timer) {
            if (Math.abs(lastX - startX) > COURSE_DRAG_SLOP || Math.abs(lastY - startY) > COURSE_DRAG_SLOP) cancelHold();
        } else if (courseDrag && courseDrag.card === card) {
            updateCourseDrag(lastX, lastY);
        }
    });
    card.addEventListener('pointerup', function(e) {
        if (e.pointerId !== pid) return;
        cancelHold();
        if (courseDrag && courseDrag.card === card) endCourseDrag(true);
    });
    card.addEventListener('pointercancel', function(e) {
        if (e.pointerId !== pid) return;
        cancelHold();
        if (courseDrag && courseDrag.card === card) endCourseDrag(false);
    });
    // Replace the native long-press / right-click menu.
    card.addEventListener('contextmenu', function(e) { e.preventDefault(); });
}

function buildCourseFileCard(file, isNew) {
    const style = courseFileStyle(file.file_type);
    const card = document.createElement('div');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.dataset.id = file.id;
    card.className = 'course-file-card course-card-shadow w-full flex items-center gap-3 p-3 rounded-2xl bg-white border border-gray-100 cursor-pointer active:scale-[0.98] transition-transform duration-100' + (isNew ? ' course-folder-new' : '');
    card.style.webkitTouchCallout = 'none';
    card.style.userSelect = 'none';
    card.addEventListener('click', function() {
        if (card._dragBlock) { card._dragBlock = false; return; } // click that ends a drag
        openCourseFile(file);
    });
    card.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCourseFile(file); }
    });
    attachCourseFileDrag(card, file);

    const tile = document.createElement('span');
    tile.className = 'shrink-0 w-[35px] h-[35px] rounded-xl flex items-center justify-center text-white ' + style.bg;
    tile.innerHTML = '<i class="fa-solid ' + style.icon + ' text-[16px]"></i>';

    const text = document.createElement('span');
    text.className = 'flex-1 min-w-0';
    const name = document.createElement('span');
    name.className = 'block truncate text-[16px] leading-[19px] font-semibold text-gray-900';
    name.textContent = file.name;
    const date = document.createElement('span');
    date.className = 'block text-[13px] leading-4 text-gray-400';
    date.textContent = typeof formatTimeAgo === 'function' ? formatTimeAgo(file.created_at) : '';
    text.append(name, date);

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'shrink-0 w-10 h-10 -my-1 -mr-1 rounded-full flex items-center justify-center text-gray-400 active:bg-gray-100 transition-colors';
    more.setAttribute('aria-label', 'File options');
    more.innerHTML = '<i class="fa-solid fa-ellipsis-vertical text-[16px]"></i>';
    more.addEventListener('click', function(e) { e.stopPropagation(); openCourseFileMenu(file); });

    card.append(tile, text, more);
    return card;
}

// newKey = {type: 'folder' | 'file', id} gets the entry animation.
function renderCourseItems(listEl, data, newKey) {
    listEl.replaceChildren();
    data.folders.forEach(function(f) {
        listEl.appendChild(buildCourseFolderCard(f, !!newKey && newKey.type === 'folder' && newKey.id === f.id));
    });
    data.files.forEach(function(f) {
        listEl.appendChild(buildCourseFileCard(f, !!newKey && newKey.type === 'file' && newKey.id === f.id));
    });
}

// ---- Top level ----
async function loadCourseTop(newKey) {
    const token = ++courseTopLoadToken;
    const list = document.getElementById('courses-list');
    const empty = document.getElementById('courses-empty');
    if (!list) return;
    if (!courseTopData) { list.replaceChildren(); if (empty) empty.classList.add('hidden'); }
    try {
        const data = await fetchCourseItems(null);
        if (token !== courseTopLoadToken) return;
        courseTopData = data;
        renderCourseTop(newKey);
    } catch (e) {
        if (token !== courseTopLoadToken) return;
        showToast('Could not load your courses.');
        if (empty && !courseTopData) empty.classList.remove('hidden');
    }
}

// ---- Category filter (top level) ----
// "All" shows everything: every folder and every document. Any other category
// shows only the folders and documents assigned to it.
//
// A document's category is kept per account in localStorage as {fileId:
// categoryId}, a placeholder like the categories themselves: it needs a
// category_id column and a server-side category list to be real. Because the
// API lists one folder at a time, only top-level documents can be assigned,
// and a category tab shows those.
const COURSE_FILE_CATEGORIES_KEY_PREFIX = 'beebo_course_file_categories_v1:';

function courseFileCategoriesKey() {
    if (typeof session === 'undefined' || !session || !session.user) return null;
    return COURSE_FILE_CATEGORIES_KEY_PREFIX + String(session.user.id);
}

function loadCourseFileCategories() {
    const key = courseFileCategoriesKey();
    if (!key) return {};
    try {
        const raw = JSON.parse(localStorage.getItem(key) || '{}');
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) { return {}; }
}

function saveCourseFileCategories(map) {
    const key = courseFileCategoriesKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(map)); } catch (e) {}
}

// The file's category id, or null if it has none (or that category is gone).
function courseFileCategoryId(fileId) {
    const id = loadCourseFileCategories()[String(fileId)];
    return id && courseCategories.some(function(c) { return c.id === id; }) ? id : null;
}

function setCourseFileCategory(fileId, categoryId) {
    const map = loadCourseFileCategories();
    if (categoryId) map[String(fileId)] = categoryId;
    else delete map[String(fileId)];
    saveCourseFileCategories(map);
}

function pruneCourseFileCategories() {
    const map = loadCourseFileCategories();
    let changed = false;
    Object.keys(map).forEach(function(fileId) {
        if (!courseCategories.some(function(c) { return c.id === map[fileId]; })) { delete map[fileId]; changed = true; }
    });
    if (changed) saveCourseFileCategories(map);
}

// Top-level folders get the same treatment: {folderId: categoryId}. A folder
// created while a category tab is open is assigned to it and also appears
// under "All" (which lists everything).
const COURSE_FOLDER_CATEGORIES_KEY_PREFIX = 'beebo_course_folder_categories_v1:';

function courseFolderCategoriesKey() {
    if (typeof session === 'undefined' || !session || !session.user) return null;
    return COURSE_FOLDER_CATEGORIES_KEY_PREFIX + String(session.user.id);
}

function loadCourseFolderCategories() {
    const key = courseFolderCategoriesKey();
    if (!key) return {};
    try {
        const raw = JSON.parse(localStorage.getItem(key) || '{}');
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) { return {}; }
}

function saveCourseFolderCategories(map) {
    const key = courseFolderCategoriesKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(map)); } catch (e) {}
}

function setCourseFolderCategory(folderId, categoryId) {
    const map = loadCourseFolderCategories();
    if (categoryId) map[String(folderId)] = categoryId;
    else delete map[String(folderId)];
    saveCourseFolderCategories(map);
}

function pruneCourseFolderCategories() {
    const map = loadCourseFolderCategories();
    let changed = false;
    Object.keys(map).forEach(function(folderId) {
        if (!courseCategories.some(function(c) { return c.id === map[folderId]; })) { delete map[folderId]; changed = true; }
    });
    if (changed) saveCourseFolderCategories(map);
}

function renderCourseTop(newKey) {
    const list = document.getElementById('courses-list');
    const empty = document.getElementById('courses-empty');
    const categoryEmpty = document.getElementById('courses-category-empty');
    if (!list || !courseTopData) return;
    const isAll = coursesActiveCategory === 'all';
    let data = courseTopData;
    if (!isAll) {
        const map = loadCourseFileCategories();
        const folderMap = loadCourseFolderCategories();
        data = {
            folders: courseTopData.folders.filter(function(f) { return folderMap[String(f.id)] === coursesActiveCategory; }),
            files: courseTopData.files.filter(function(f) { return map[String(f.id)] === coursesActiveCategory; })
        };
    }
    renderCourseItems(list, data, newKey);
    const hasItems = data.folders.length + data.files.length > 0;
    if (empty) empty.classList.toggle('hidden', !isAll || hasItems);
    if (categoryEmpty) {
        const cat = courseCategories.find(function(c) { return c.id === coursesActiveCategory; });
        document.getElementById('courses-category-empty-title').textContent = cat ? 'Nothing in \u201c' + cat.name + '\u201d' : '';
        categoryEmpty.classList.toggle('hidden', isAll || hasItems);
    }
}

function reloadCourseLevel(newKey) {
    if (openCourseFolderId !== null) openCourseFolder(openCourseFolderId, { push: false, newKey: newKey });
    else loadCourseTop(newKey);
}

// Folders that existed only in this browser (the old localStorage version)
// are created on the server once, then the local copy is removed.
async function migrateLocalCourseFolders() {
    if (typeof session === 'undefined' || !session || !session.user) return;
    const key = COURSE_LOCAL_FOLDERS_KEY_PREFIX + String(session.user.id);
    let local = [];
    try { local = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return; }
    if (!Array.isArray(local) || !local.length) {
        try { localStorage.removeItem(key); } catch (e) {}
        return;
    }
    for (let i = local.length - 1; i >= 0; i--) { // stored newest first; create oldest first
        const name = local[i] && typeof local[i].name === 'string' ? local[i].name.trim().slice(0, COURSE_FOLDER_MAX_LENGTH) : '';
        if (!name) continue;
        try {
            const res = await apiFetch('/api/courses/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name })
            });
            if (!res.ok && res.status !== 409 && res.status !== 400) return; // keep local copy, retry next time
        } catch (e) { return; }
    }
    try { localStorage.removeItem(key); } catch (e) {}
}

async function onCourseDataShown() {
    const uid = (typeof session !== 'undefined' && session && session.user) ? session.user.id : null;
    if (uid !== courseDataUserId) { // another account: drop the previous user's lists
        courseDataUserId = uid;
        courseTopData = null;
        courseFolderData = null;
        const list = document.getElementById('courses-list');
        if (list) list.replaceChildren();
    }
    if (uid === null) return;
    await migrateLocalCourseFolders();
    loadCourseTop();
}

// ---- Folder screen ----
async function openCourseFolder(id, opts) {
    const o = opts || {};
    const push = o.push !== false;
    const view = document.getElementById('course-folder-view');
    const list = document.getElementById('course-folder-list');
    const empty = document.getElementById('course-folder-empty');
    const title = document.getElementById('course-folder-title');
    const subtitle = document.getElementById('course-folder-subtitle');
    const wasOpen = !view.classList.contains('hidden');

    if (push) {
        if (wasOpen && openCourseFolderId !== null && openCourseFolderId !== id) courseFolderStack.push(openCourseFolderId);
        if (!wasOpen) courseFolderStack = [];
    }
    openCourseFolderId = id;
    view.classList.remove('hidden');

    if (courseFolderShownId !== id) { // different folder: clear immediately, no stale contents
        courseFolderShownId = null;
        courseFolderData = null;
        list.replaceChildren();
        empty.classList.add('hidden');
        subtitle.textContent = '';
        title.textContent = o.name || '';
    }

    const token = ++courseFolderLoadToken;
    try {
        const data = await fetchCourseItems(id);
        if (token !== courseFolderLoadToken || openCourseFolderId !== id) return;
        courseFolderData = data;
        courseFolderShownId = id;
        title.textContent = data.folder.name;
        subtitle.textContent = courseItemCountText(data.folder.item_count);
        renderCourseItems(list, data, o.newKey);
        empty.classList.toggle('hidden', data.folders.length + data.files.length > 0);
    } catch (e) {
        if (token !== courseFolderLoadToken) return;
        showToast('Could not open this folder.');
        closeCourseFolder();
    }
}

function hideCourseFolderView() {
    openCourseFolderId = null;
    courseFolderShownId = null;
    courseFolderData = null;
    courseFolderStack = [];
    courseFolderLoadToken++;
    const view = document.getElementById('course-folder-view');
    if (view) view.classList.add('hidden');
}

// Back: one folder up if we came from one, otherwise back to the list
// (refreshed, so folder counts are current).
function closeCourseFolder() {
    if (courseFolderStack.length) {
        const parent = courseFolderStack.pop();
        openCourseFolder(parent, { push: false });
        return;
    }
    hideCourseFolderView();
    loadCourseTop();
}

// ---- Add folder dialog ----
let courseFolderEditing = null; // folder being renamed; null = adding
function openCourseFolderDialog(folder) {
    courseFolderEditing = folder || null;
    document.getElementById('course-folder-dialog-title').textContent = courseFolderEditing ? 'Rename folder' : 'Add folder';
    document.getElementById('course-folder-submit').textContent = courseFolderEditing ? 'Save' : 'Add';
    const input = document.getElementById('course-folder-input');
    input.value = courseFolderEditing ? courseFolderEditing.name : '';
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
    return courseCurrentFolders().some(function(f) {
        return (!courseFolderEditing || f.id !== courseFolderEditing.id) && f.name.trim().toLowerCase() === lower;
    }) ? 'A folder with this name already exists' : '';
}

function setCourseFolderHelper(error) {
    const helper = document.getElementById('course-folder-helper');
    helper.textContent = error || '*required';
    helper.classList.toggle('text-red-600', !!error);
    helper.classList.toggle('text-gray-500', !error);
}

function onCourseFolderInput() {
    const input = document.getElementById('course-folder-input');
    const error = courseFolderNameError(input.value);
    setCourseFolderHelper(error);
    document.getElementById('course-folder-submit').disabled = !input.value.trim() || !!error;
}

let courseFolderSaving = false;
async function submitCourseFolder() {
    const submit = document.getElementById('course-folder-submit');
    if (submit.disabled || courseFolderSaving) return;
    const name = document.getElementById('course-folder-input').value.trim().slice(0, COURSE_FOLDER_MAX_LENGTH);
    if (!name || courseFolderNameError(name)) return;
    if (courseFolderEditing && name === courseFolderEditing.name) { closeCourseFolderDialog(); return; }
    courseFolderSaving = true;
    submit.disabled = true;
    try {
        const renaming = courseFolderEditing;
        const res = renaming
            ? await apiFetch('/api/courses/folders/' + encodeURIComponent(renaming.id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name })
            })
            : await apiFetch('/api/courses/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, parent_id: openCourseFolderId })
            });
        if (res.ok && renaming) {
            closeCourseFolderDialog();
            showToast('Folder renamed');
            reloadCourseLevel();
        } else if (res.ok) {
            const data = await res.json();
            if (openCourseFolderId === null && coursesActiveCategory !== 'all') {
                setCourseFolderCategory(data.folder.id, coursesActiveCategory);
            }
            closeCourseFolderDialog();
            reloadCourseLevel({ type: 'folder', id: data.folder.id });
        } else {
            setCourseFolderHelper(await courseErrorMessage(res, courseFolderEditing ? 'Could not rename the folder.' : 'Could not create the folder.'));
            submit.disabled = false;
        }
    } catch (e) {
        setCourseFolderHelper('Network error. Please try again.');
        submit.disabled = false;
    } finally {
        courseFolderSaving = false;
    }
}

// ---- Open a file ----
function courseFileUrl(file, inline) {
    return '/api/courses/files/' + encodeURIComponent(file.id) + '/download' + (inline ? '?inline=1' : '');
}

function downloadCourseFile(file) {
    const a = document.createElement('a');
    a.href = courseFileUrl(file, false);
    a.download = file.name + '.' + file.file_type;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// PDFs and images open in a new tab; .docx opens in the in-app reader;
// everything else downloads.
function openCourseFile(file) {
    if (COURSE_INLINE_TYPES.indexOf(file.file_type) !== -1) window.open(courseFileUrl(file, true), '_blank');
    else if (file.file_type === 'docx') openCourseReader(file);
    else downloadCourseFile(file);
}

// ---- Read-only .docx reader ----
// Uses mammoth.js (github.com/mwilliamson/mammoth.js): converts the .docx to
// clean, semantic HTML in the browser, so the text reflows to the phone width
// (unlike page-faithful renderers). Loaded lazily from a pinned jsDelivr
// build the first time a .docx is opened. Legacy .doc is not supported by
// mammoth and keeps downloading.
const COURSE_MAMMOTH_SRC = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
let courseMammothPromise = null;
let courseReaderToken = 0; // bumped on every open/close so a stale load is discarded
let courseReaderFile = null;

function loadCourseMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (!courseMammothPromise) {
        courseMammothPromise = new Promise(function(resolve, reject) {
            const script = document.createElement('script');
            script.src = COURSE_MAMMOTH_SRC;
            script.async = true;
            script.onload = function() { window.mammoth ? resolve(window.mammoth) : reject(new Error('mammoth missing')); };
            script.onerror = function() { courseMammothPromise = null; script.remove(); reject(new Error('mammoth load failed')); };
            document.head.appendChild(script);
        });
    }
    return courseMammothPromise;
}

// Mammoth does not sanitise its output, so it is filtered before it touches
// the page: whitelisted tags only, no inline styles/handlers, links limited
// to http(s)/mailto/tel, images limited to embedded raster data URIs.
const COURSE_READER_TAGS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'sup', 'sub', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'a', 'img', 'blockquote', 'pre', 'code', 'span', 'div', 'hr']);
const COURSE_READER_DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'base', 'noscript', 'template', 'audio', 'video']);

function sanitizeCourseReaderHtml(html) {
    const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    (function clean(parent) {
        Array.from(parent.children).forEach(function(el) {
            const tag = el.tagName.toLowerCase();
            if (COURSE_READER_DROP.has(tag)) { el.remove(); return; }
            clean(el);
            if (!COURSE_READER_TAGS.has(tag)) { el.replaceWith.apply(el, Array.from(el.childNodes)); return; }

            const id = el.getAttribute('id');
            const href = tag === 'a' ? (el.getAttribute('href') || '').trim() : '';
            const src = tag === 'img' ? (el.getAttribute('src') || '').trim() : '';
            const alt = el.getAttribute('alt');
            const colspan = parseInt(el.getAttribute('colspan'), 10);
            const rowspan = parseInt(el.getAttribute('rowspan'), 10);
            Array.from(el.attributes).forEach(function(a) { el.removeAttribute(a.name); });

            if (id) el.id = 'cr-' + id; // prefixed so it can never collide with the app's own ids
            if (tag === 'a') {
                if (href.charAt(0) === '#') {
                    el.dataset.crTarget = 'cr-' + href.slice(1); // in-document link (footnotes etc.), handled on click
                } else if (/^(https?:|mailto:|tel:)/i.test(href)) {
                    el.setAttribute('href', href);
                    el.setAttribute('target', '_blank');
                    el.setAttribute('rel', 'noopener noreferrer nofollow');
                }
            } else if (tag === 'img') {
                if (!/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(src)) { el.remove(); return; }
                el.setAttribute('src', src);
                el.setAttribute('alt', alt || '');
                el.setAttribute('decoding', 'async');
            } else if ((tag === 'td' || tag === 'th')) {
                if (colspan > 1 && colspan <= 50) el.setAttribute('colspan', String(colspan));
                if (rowspan > 1 && rowspan <= 200) el.setAttribute('rowspan', String(rowspan));
            }
        });
    })(doc.body);
    return doc.body;
}

function setCourseReaderState(state, message) {
    document.getElementById('course-reader-loading').classList.toggle('hidden', state !== 'loading');
    document.getElementById('course-reader-error').classList.toggle('hidden', state !== 'error');
    document.getElementById('course-reader-content').classList.toggle('hidden', state !== 'ready');
    if (state === 'error') document.getElementById('course-reader-error-text').textContent = message || 'This document could not be displayed.';
}

async function openCourseReader(file) {
    const token = ++courseReaderToken;
    courseReaderFile = file;
    const view = document.getElementById('course-reader');
    document.getElementById('course-reader-title').textContent = file.name;
    document.getElementById('course-reader-content').replaceChildren();
    document.getElementById('course-reader-scroll').scrollTop = 0;
    setCourseReaderState('loading');
    view.classList.remove('hidden');

    try {
        const results = await Promise.all([loadCourseMammoth(), fetch(courseFileUrl(file, false))]);
        const mammoth = results[0], res = results[1];
        if (!res.ok) {
            if (token !== courseReaderToken) return;
            setCourseReaderState('error', res.status === 404 ? 'This file no longer exists.' : 'Could not open this document.');
            return;
        }
        const converted = await mammoth.convertToHtml({ arrayBuffer: await res.arrayBuffer() });
        if (token !== courseReaderToken) return; // closed or replaced while loading

        const body = sanitizeCourseReaderHtml(converted.value || '');
        const content = document.getElementById('course-reader-content');
        content.replaceChildren.apply(content, Array.from(body.childNodes));
        content.querySelectorAll('table').forEach(function(table) {
            const wrap = document.createElement('div');
            wrap.className = 'course-reader-table-wrap';
            table.replaceWith(wrap);
            wrap.appendChild(table);
        });
        if (!content.textContent.trim() && !content.querySelector('img')) {
            setCourseReaderState('error', 'This document is empty.');
            return;
        }
        setCourseReaderState('ready');
    } catch (e) {
        if (token !== courseReaderToken) return;
        setCourseReaderState('error', 'This document could not be displayed.');
    }
}

function closeCourseReader() {
    courseReaderToken++;
    courseReaderFile = null;
    const view = document.getElementById('course-reader');
    if (!view) return;
    view.classList.add('hidden');
    document.getElementById('course-reader-content').replaceChildren(); // free the document and its images
}

function downloadCourseReaderFile() {
    if (courseReaderFile) downloadCourseFile(courseReaderFile);
}

// In-document links (footnotes, bookmarks) scroll inside the reader.
document.getElementById('course-reader-content').addEventListener('click', function(e) {
    const link = e.target.closest('[data-cr-target]');
    if (!link) return;
    e.preventDefault();
    const target = document.getElementById(link.dataset.crTarget);
    if (target && this.contains(target)) target.scrollIntoView({ block: 'center' });
});

document.addEventListener('keydown', function(e) {
    const view = document.getElementById('course-reader');
    if (e.key === 'Escape' && view && !view.classList.contains('hidden')) closeCourseReader();
});

// ---- Save / rename file dialog ----
// mode 'upload': opened right after a file is picked. Name is prefilled
// (without extension, which is fixed), so Save with no edits = "save as is".
// mode 'rename': same dialog for an existing file.
const courseFileDialog = { mode: null, file: null, ext: '', fileId: null, originalName: '', xhr: null, busy: false };

function courseFileExt(filename) {
    const i = filename.lastIndexOf('.');
    return i > -1 ? filename.slice(i + 1).toLowerCase() : '';
}

function courseFileBaseName(filename) {
    const i = filename.lastIndexOf('.');
    return (i > 0 ? filename.slice(0, i) : filename).trim();
}

function formatCourseBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function onCourseFilePicked(input) {
    const file = input.files && input.files[0];
    input.value = ''; // so picking the same file again still fires change
    if (!file) return;
    const ext = courseFileExt(file.name);
    if (COURSE_ALLOWED_TYPES.indexOf(ext) === -1) {
        showToast('This file type is not supported.');
        return;
    }
    if (file.size > COURSE_MAX_FILE_BYTES) {
        showToast('File is too large (max ' + formatCourseBytes(COURSE_MAX_FILE_BYTES) + ').');
        return;
    }
    if (file.size === 0) {
        showToast('This file is empty.');
        return;
    }
    openCourseFileDialog('upload', { file: file, ext: ext, name: courseFileBaseName(file.name) });
}

function openCourseFileDialog(mode, o) {
    courseFileDialog.mode = mode;
    courseFileDialog.file = o.file || null;
    courseFileDialog.fileId = o.fileId || null;
    courseFileDialog.ext = o.ext;
    courseFileDialog.originalName = o.name;
    courseFileDialog.busy = false;
    document.getElementById('course-file-dialog-title').textContent = mode === 'rename' ? 'Rename file' : 'Save file';
    document.getElementById('course-file-submit').textContent = mode === 'rename' ? 'Rename' : 'Save';
    document.getElementById('course-file-ext').textContent = '.' + o.ext;
    const input = document.getElementById('course-file-name');
    input.value = o.name.slice(0, COURSE_FILE_NAME_MAX_LENGTH);
    input.disabled = false;
    document.getElementById('course-file-progress').classList.add('hidden');
    setCourseFileProgress(0);
    setCourseFileHelper('');
    onCourseFileNameInput();
    document.getElementById('course-file-dialog').classList.remove('hidden');
    setTimeout(function() { input.focus(); input.select(); }, 50);
}

function closeCourseFileDialog() {
    if (courseFileDialog.xhr) { // closing mid-upload cancels it
        try { courseFileDialog.xhr.abort(); } catch (e) {}
        courseFileDialog.xhr = null;
    }
    courseFileDialog.busy = false;
    courseFileDialog.file = null;
    const dialog = document.getElementById('course-file-dialog');
    if (dialog) dialog.classList.add('hidden');
}

function setCourseFileHelper(error) {
    const helper = document.getElementById('course-file-helper');
    if (!helper) return;
    helper.textContent = error || '*required';
    helper.classList.toggle('text-red-600', !!error);
    helper.classList.toggle('text-gray-500', !error);
}

function setCourseFileProgress(fraction) {
    const bar = document.getElementById('course-file-progress-bar');
    const wrap = document.getElementById('course-file-progress');
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    if (bar) bar.style.width = pct + '%';
    if (wrap) wrap.setAttribute('aria-valuenow', String(pct));
}

function onCourseFileNameInput() {
    if (courseFileDialog.busy) return;
    const name = document.getElementById('course-file-name').value.trim();
    setCourseFileHelper('');
    const unchanged = courseFileDialog.mode === 'rename' && name === courseFileDialog.originalName;
    document.getElementById('course-file-submit').disabled = !name || unchanged;
}

function submitCourseFileDialog() {
    const submit = document.getElementById('course-file-submit');
    if (submit.disabled || courseFileDialog.busy) return;
    const name = document.getElementById('course-file-name').value.trim().slice(0, COURSE_FILE_NAME_MAX_LENGTH);
    if (!name) return;
    if (courseFileDialog.mode === 'rename') renameCourseFile(name);
    else uploadCourseFile(name);
}

function setCourseFileBusy(busy, label) {
    courseFileDialog.busy = busy;
    const submit = document.getElementById('course-file-submit');
    document.getElementById('course-file-name').disabled = busy;
    submit.disabled = busy;
    submit.textContent = label;
}

function uploadCourseFile(name) {
    const file = courseFileDialog.file;
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('name', name); // display name without extension
    if (openCourseFolderId !== null) form.append('folder_id', String(openCourseFolderId));

    const xhr = new XMLHttpRequest(); // fetch cannot report upload progress
    courseFileDialog.xhr = xhr;
    xhr.open('POST', '/api/courses/files');
    if (typeof csrfToken === 'string' && csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);

    document.getElementById('course-file-progress').classList.remove('hidden');
    setCourseFileProgress(0);
    setCourseFileHelper('');
    setCourseFileBusy(true, 'Uploading 0%');

    function fail(message) {
        courseFileDialog.xhr = null;
        setCourseFileBusy(false, 'Save');
        document.getElementById('course-file-progress').classList.add('hidden');
        setCourseFileHelper(message);
        onCourseFileNameInput();
        setCourseFileHelper(message); // onCourseFileNameInput clears the helper
    }

    xhr.upload.onprogress = function(e) {
        if (!e.lengthComputable) return;
        const fraction = e.loaded / e.total;
        setCourseFileProgress(fraction);
        setCourseFileBusy(true, fraction >= 1 ? 'Saving…' : 'Uploading ' + Math.round(fraction * 100) + '%');
    };
    xhr.onload = function() {
        courseFileDialog.xhr = null;
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status === 201 && data.file) {
            closeCourseFileDialog();
            reloadCourseLevel({ type: 'file', id: data.file.id });
        } else if (xhr.status === 401) {
            fail('Please log in again.');
        } else {
            fail(typeof data.error === 'string' && data.error ? data.error : 'Upload failed. Please try again.');
        }
    };
    xhr.onerror = function() { fail('Network error. Please try again.'); };
    xhr.send(form);
}

async function renameCourseFile(name) {
    const id = courseFileDialog.fileId;
    setCourseFileBusy(true, 'Saving…');
    try {
        const res = await apiFetch('/api/courses/files/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        });
        if (res.ok) {
            closeCourseFileDialog();
            reloadCourseLevel();
        } else {
            const message = await courseErrorMessage(res, 'Could not rename the file.');
            setCourseFileBusy(false, 'Rename');
            onCourseFileNameInput();
            setCourseFileHelper(message);
        }
    } catch (e) {
        setCourseFileBusy(false, 'Rename');
        onCourseFileNameInput();
        setCourseFileHelper('Network error. Please try again.');
    }
}

// ---- File options sheet + delete confirm ----
let courseMenuFile = null;

function openCourseFileMenu(file) {
    courseMenuFile = file;
    document.getElementById('course-file-menu-title').textContent = file.name + '.' + file.file_type;
    // Categories apply to top-level documents only (see the category filter note).
    document.getElementById('course-file-menu-category').classList.toggle('hidden', openCourseFolderId !== null);
    document.getElementById('course-file-menu-sheet').classList.remove('hidden');
    document.getElementById('course-file-menu-backdrop').classList.remove('hidden');
}

// ---- Folder options sheet (opened by tap and hold) ----
let courseMenuFolder = null;
let courseDeleteKind = 'file'; // what the confirm dialog is about: 'file' | 'folder'

function openCourseFolderMenu(folder) {
    courseMenuFolder = folder;
    document.getElementById('course-folder-menu-title').textContent = folder.name;
    document.getElementById('course-folder-menu-sheet').classList.remove('hidden');
    document.getElementById('course-file-menu-backdrop').classList.remove('hidden');
}

function closeCourseFolderMenu() {
    const sheet = document.getElementById('course-folder-menu-sheet');
    const backdrop = document.getElementById('course-file-menu-backdrop');
    if (sheet) sheet.classList.add('hidden');
    if (backdrop) backdrop.classList.add('hidden');
}

function courseFolderMenuAction(action) {
    const folder = courseMenuFolder;
    closeCourseFolderMenu();
    if (!folder) return;
    if (action === 'rename') {
        openCourseFolderDialog(folder);
    } else if (action === 'delete') {
        courseDeleteKind = 'folder';
        document.getElementById('course-confirm-title').textContent = 'Delete folder?';
        document.getElementById('course-confirm-message').textContent = '\u201c' + folder.name + '\u201d and everything inside it will be permanently deleted.';
        document.getElementById('course-confirm-dialog').classList.remove('hidden');
    }
}

function closeCourseFileMenu() {
    const sheet = document.getElementById('course-file-menu-sheet');
    const backdrop = document.getElementById('course-file-menu-backdrop');
    if (sheet) sheet.classList.add('hidden');
    if (backdrop) backdrop.classList.add('hidden');
}

function courseFileMenuAction(action) {
    const file = courseMenuFile;
    closeCourseFileMenu();
    if (!file) return;
    if (action === 'rename') {
        openCourseFileDialog('rename', { fileId: file.id, ext: file.file_type, name: file.name });
    } else if (action === 'category') {
        openCourseFileCategorySheet(file);
    } else if (action === 'download') {
        downloadCourseFile(file);
    } else if (action === 'delete') {
        courseDeleteKind = 'file';
        document.getElementById('course-confirm-title').textContent = 'Delete file?';
        document.getElementById('course-confirm-message').textContent = '\u201c' + file.name + '.' + file.file_type + '\u201d will be permanently deleted.';
        document.getElementById('course-confirm-dialog').classList.remove('hidden');
    }
}

function closeCourseConfirm() {
    const dialog = document.getElementById('course-confirm-dialog');
    if (dialog) dialog.classList.add('hidden');
}

let courseDeleting = false;
async function confirmCourseDelete() {
    const isFolder = courseDeleteKind === 'folder';
    const target = isFolder ? courseMenuFolder : courseMenuFile;
    if (!target || courseDeleting) return;
    courseDeleting = true;
    try {
        const res = await apiFetch('/api/courses/' + (isFolder ? 'folders/' : 'files/') + encodeURIComponent(target.id), { method: 'DELETE' });
        closeCourseConfirm();
        if (res.ok) {
            if (isFolder) setCourseFolderCategory(target.id, null);
            else setCourseFileCategory(target.id, null);
            showToast(isFolder ? 'Folder deleted' : 'File deleted');
            reloadCourseLevel();
        } else {
            showToast(await courseErrorMessage(res, isFolder ? 'Could not delete the folder.' : 'Could not delete the file.'));
        }
    } catch (e) {
        closeCourseConfirm();
        showToast('Network error. Please try again.');
    } finally {
        courseDeleting = false;
    }
}

// ---- Choose a document's category ----
function openCourseFileCategorySheet(file) {
    const options = document.getElementById('course-file-category-options');
    const current = courseFileCategoryId(file.id);
    options.replaceChildren();

    function addOption(label, categoryId) {
        const selected = categoryId === current;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'w-full flex items-center gap-4 px-5 py-3.5 text-left transition-colors duration-100 active:bg-gray-50';
        const text = document.createElement('span');
        text.className = 'flex-1 min-w-0 truncate text-[15px] text-gray-900' + (selected ? ' font-semibold' : ' font-medium');
        text.textContent = label;
        const check = document.createElement('i');
        check.className = 'fa-solid fa-check text-[15px] text-sky-600' + (selected ? '' : ' invisible');
        btn.append(text, check);
        btn.addEventListener('click', function() { pickCourseFileCategory(file, categoryId); });
        options.appendChild(btn);
    }

    if (!courseCategories.length) {
        const note = document.createElement('p');
        note.className = 'px-5 py-4 text-[14px] leading-5 text-gray-500';
        note.textContent = 'You have no categories yet. Create one from the Courses menu under Categories.';
        options.appendChild(note);
    } else {
        addOption('None', null);
        courseCategories.forEach(function(c) { addOption(c.name, c.id); });
    }
    document.getElementById('course-file-category-sheet').classList.remove('hidden');
    document.getElementById('course-file-menu-backdrop').classList.remove('hidden');
}

function closeCourseFileCategorySheet() {
    const sheet = document.getElementById('course-file-category-sheet');
    if (sheet) sheet.classList.add('hidden');
    const backdrop = document.getElementById('course-file-menu-backdrop');
    if (backdrop) backdrop.classList.add('hidden');
}

function pickCourseFileCategory(file, categoryId) {
    setCourseFileCategory(file.id, categoryId);
    closeCourseFileCategorySheet();
    renderCourseTop();
}
