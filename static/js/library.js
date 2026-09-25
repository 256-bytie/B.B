// ---- Library: file-type + department visual lookups ----
// Small, local to this file since nothing else in the app needs a
// file-type-keyed icon/color mapping (post_images/highlights are always
// images). Keyed by lowercased extension without the dot.
const LIBRARY_FILE_TYPE_STYLES = {
    pdf: { bg: 'bg-red-500', icon: 'fa-file-pdf' },
    doc: { bg: 'bg-blue-500', icon: 'fa-file-word' },
    docx: { bg: 'bg-blue-500', icon: 'fa-file-word' },
    ppt: { bg: 'bg-orange-500', icon: 'fa-file-powerpoint' },
    pptx: { bg: 'bg-orange-500', icon: 'fa-file-powerpoint' },
    zip: { bg: 'bg-purple-500', icon: 'fa-file-zipper' }
};
const LIBRARY_DEFAULT_FILE_STYLE = { bg: 'bg-gray-400', icon: 'fa-file' };

function libraryFileTypeStyle(fileType) {
    const key = (fileType || '').toLowerCase().replace(/^\./, '');
    return LIBRARY_FILE_TYPE_STYLES[key] || LIBRARY_DEFAULT_FILE_STYLE;
}

// Department -> icon/color, matching the icon choices already used for
// these same subjects on the Courses view, for visual consistency.
const LIBRARY_DEPARTMENT_META = {
    'Radiography': { icon: 'fa-stethoscope', color: 'text-red-500', bg: 'bg-red-50' },
    'Computer Science': { icon: 'fa-laptop', color: 'text-blue-500', bg: 'bg-blue-50' },
    'Biochemistry': { icon: 'fa-flask', color: 'text-green-500', bg: 'bg-green-50' },
    'Mathematics': { icon: 'fa-calculator', color: 'text-purple-500', bg: 'bg-purple-50' },
    'Physics': { icon: 'fa-atom', color: 'text-orange-500', bg: 'bg-orange-50' },
    'Forensic Science': { icon: 'fa-fingerprint', color: 'text-indigo-500', bg: 'bg-indigo-50' }
};
const LIBRARY_DEFAULT_DEPARTMENT_META = { icon: 'fa-graduation-cap', color: 'text-gray-500', bg: 'bg-gray-50' };

function libraryFormatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Library: list state ----
let libraryState = {
    search: '',
    category: '',   // '' = All
    department: '', // '' = any
    files: [],
    loading: false
};
let librarySearchDebounceTimer = null;

// Called by showView('library')'s per-view hook each time the view opens.
function initLibraryView() {
    document.getElementById('library-search-input').value = libraryState.search;
    fetchLibraryDepartments();
    fetchLibraryFiles();
}

async function fetchLibraryFiles() {
    libraryState.loading = true;
    renderLibraryFiles();

    const params = new URLSearchParams();
    if (libraryState.search) params.set('search', libraryState.search);
    if (libraryState.category) params.set('category', libraryState.category);
    if (libraryState.department) params.set('department', libraryState.department);

    try {
        const response = await fetch(`/api/library/files?${params.toString()}`);
        if (!response.ok) throw new Error('request failed');
        const data = await response.json();
        libraryState.files = data.files || [];
    } catch (err) {
        libraryState.files = null; // signals an error state to the renderer
    }
    libraryState.loading = false;
    renderLibraryFiles();
}

async function fetchLibraryDepartments() {
    const container = document.getElementById('library-department-row');
    try {
        const response = await fetch('/api/library/departments');
        if (!response.ok) throw new Error('request failed');
        const data = await response.json();
        renderLibraryDepartments(data.departments || []);
    } catch (err) {
        container.innerHTML = '<div class="text-[13px] text-gray-400 py-6 px-1">Couldn\'t load departments.</div>';
    }
}

function renderLibraryDepartments(departments) {
    const container = document.getElementById('library-department-row');
    if (!departments.length) {
        container.innerHTML = '<div class="text-[13px] text-gray-400 py-6 px-1">No departments yet.</div>';
        return;
    }
    container.innerHTML = departments.map(dept => {
        const meta = LIBRARY_DEPARTMENT_META[dept.name] || LIBRARY_DEFAULT_DEPARTMENT_META;
        const name = escapeHtml(dept.name);
        const isActive = libraryState.department === dept.name;
        return `
            <button type="button" onclick="setLibraryDepartmentFilter('${name}')" class="shrink-0 w-[126px] bg-white rounded-2xl border ${isActive ? 'border-red-300 ring-1 ring-red-100' : 'border-gray-100'} p-3.5 text-left course-card-shadow">
                <span class="w-11 h-11 rounded-full ${meta.bg} ${meta.color} flex items-center justify-center mb-2.5">
                    <i class="fa-solid ${meta.icon} text-[16px]"></i>
                </span>
                <p class="text-[13.5px] font-semibold text-gray-900 leading-tight truncate">${name}</p>
                <p class="text-[12px] text-gray-500 mt-0.5">${dept.count} doc${dept.count === 1 ? '' : 's'}</p>
            </button>
        `;
    }).join('');
}

function setLibraryDepartmentFilter(name) {
    libraryState.department = (libraryState.department === name) ? '' : name;
    fetchLibraryDepartments();
    fetchLibraryFiles();
}

function setLibraryCategoryFilter(category) {
    libraryState.category = category;
    document.querySelectorAll('.library-category-btn').forEach(btn => {
        const isActive = btn.dataset.category === category;
        const circle = btn.querySelector('.category-icon-circle');
        const label = btn.querySelector('.category-label');
        if (isActive) {
            circle.className = 'category-icon-circle w-14 h-14 rounded-full flex items-center justify-center bg-red-50 text-brand-red ring-2 ring-red-100';
            label.className = 'category-label text-[12.5px] font-medium text-gray-900';
        } else {
            circle.className = 'category-icon-circle w-14 h-14 rounded-full flex items-center justify-center bg-gray-50 text-gray-500 ring-1 ring-gray-200';
            label.className = 'category-label text-[12.5px] font-medium text-gray-500';
        }
    });
    fetchLibraryFiles();
}

function renderLibraryFiles() {
    const container = document.getElementById('library-file-list');

    if (libraryState.loading) {
        container.innerHTML = '<div class="text-center text-[13.5px] text-gray-400 py-10">Loading documents…</div>';
        return;
    }
    if (libraryState.files === null) {
        container.innerHTML = `
            <div class="text-center py-10">
                <p class="text-[13.5px] text-gray-400 mb-3">Couldn't load the library right now.</p>
                <button type="button" onclick="fetchLibraryFiles()" class="text-[13.5px] font-semibold text-red-600">Try again</button>
            </div>`;
        return;
    }
    if (!libraryState.files.length) {
        container.innerHTML = '<div class="text-center text-[13.5px] text-gray-400 py-10">No documents found.</div>';
        return;
    }

    container.innerHTML = libraryState.files.map(file => buildLibraryFileRowHtml(file)).join('');
}

function buildLibraryFileRowHtml(file) {
    const style = libraryFileTypeStyle(file.file_type);
    const title = escapeHtml(file.title);
    const meta = [file.department, file.level].filter(Boolean).map(escapeHtml).join(' • ');
    const uploader = file.uploader_name ? `Uploaded by ${escapeHtml(file.uploader_name)}` : '';
    const timeAgo = file.created_at ? formatTimeAgo(file.created_at) : '';
    const pendingBadge = (file.status === 'pending')
        ? '<span class="ml-2 inline-block text-[10.5px] font-semibold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full align-middle">Pending review</span>'
        : '';

    return `
        <article class="bg-white rounded-2xl border border-gray-100 course-card-shadow p-3.5 flex items-center gap-3.5" data-file-id="${file.id}">
            <div class="w-11 h-11 rounded-xl ${style.bg} text-white flex items-center justify-center shrink-0">
                <i class="fa-solid ${style.icon} text-[17px]"></i>
            </div>
            <div class="flex-1 min-w-0" onclick="handleLibraryFileAction('open', ${file.id})">
                <p class="text-[14.5px] font-semibold text-gray-900 truncate">${title}${pendingBadge}</p>
                ${meta ? `<p class="text-[12.5px] text-gray-500 truncate">${meta}</p>` : ''}
                <p class="text-[12px] text-gray-400 truncate">${uploader}${uploader && timeAgo ? ' • ' : ''}${timeAgo}</p>
            </div>
            <button type="button" aria-label="Document options" class="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100" onclick="openLibraryFileMenu(${file.id})">
                <i class="fa-solid fa-ellipsis-vertical text-[15px]"></i>
            </button>
        </article>
    `;
}

// ---- Search (debounced) ----
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('library-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            clearTimeout(librarySearchDebounceTimer);
            const value = e.target.value;
            librarySearchDebounceTimer = setTimeout(() => {
                libraryState.search = value.trim();
                fetchLibraryFiles();
            }, 350);
        });
    }
    document.querySelectorAll('.library-category-btn').forEach(btn => {
        btn.addEventListener('click', () => setLibraryCategoryFilter(btn.dataset.category));
    });
});

// ---- Per-file kebab menu ----
let libraryActiveFileId = null;

function openLibraryFileMenu(fileId) {
    libraryActiveFileId = fileId;
    document.getElementById('library-file-menu-sheet').classList.remove('hidden');
    document.getElementById('library-file-menu-backdrop').classList.remove('hidden');
    document.body.classList.add('overlay-open');
}

function closeLibraryFileMenu() {
    document.getElementById('library-file-menu-sheet').classList.add('hidden');
    document.getElementById('library-file-menu-backdrop').classList.add('hidden');
    document.body.classList.remove('overlay-open');
    libraryActiveFileId = null;
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.library-file-menu-action').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            const fileId = libraryActiveFileId;
            closeLibraryFileMenu();
            handleLibraryFileAction(action, fileId);
        });
    });
});

function handleLibraryFileAction(action, fileId) {
    if (action === 'download' || action === 'open') {
        downloadLibraryFile(fileId);
        return;
    }
    showToast('Coming soon');
}

function downloadLibraryFile(fileId) {
    // A real file download, not a JSON API call — navigating the browser
    // to the endpoint lets it stream the response as an attachment.
    window.location.href = `/api/library/files/${fileId}/download`;
}

// ---- Contribute wizard ----
let libraryContributeState = {
    step: 1,
    file: null
};

function resetLibraryContributeWizard() {
    libraryContributeState = { step: 1, file: null };
    document.getElementById('library-file-input').value = '';
    document.getElementById('library-input-title').value = '';
    document.getElementById('library-input-category').value = '';
    document.getElementById('library-input-department').value = '';
    document.getElementById('library-input-course').value = '';
    document.getElementById('library-input-level').value = '';
    document.getElementById('library-step1-error').classList.add('hidden');
    document.getElementById('library-step2-error').classList.add('hidden');
    clearLibrarySelectedFile();
    renderLibraryContributeStep();
}

function clearLibrarySelectedFile() {
    libraryContributeState.file = null;
    document.getElementById('library-file-input').value = '';
    document.getElementById('library-dropzone-empty').classList.remove('hidden');
    document.getElementById('library-dropzone-filled').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('library-file-input');
    if (!fileInput) return;

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;

        const maxBytes = 50 * 1024 * 1024;
        if (file.size > maxBytes) {
            showToast('File must be under 50MB.');
            fileInput.value = '';
            return;
        }
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['pdf', 'doc', 'docx', 'ppt', 'pptx', 'zip'].includes(ext)) {
            showToast('Unsupported file type.');
            fileInput.value = '';
            return;
        }

        libraryContributeState.file = file;
        const style = libraryFileTypeStyle(ext);
        document.getElementById('library-dropzone-empty').classList.add('hidden');
        const filled = document.getElementById('library-dropzone-filled');
        filled.classList.remove('hidden');
        filled.classList.add('flex');
        const iconEl = document.getElementById('library-selected-file-icon');
        iconEl.className = `w-11 h-11 rounded-xl flex items-center justify-center text-white shrink-0 ${style.bg}`;
        iconEl.innerHTML = `<i class="fa-solid ${style.icon} text-[17px]"></i>`;
        document.getElementById('library-selected-file-name').textContent = file.name;
        document.getElementById('library-selected-file-size').textContent = libraryFormatBytes(file.size);
    });

    // Drag & drop onto the dropzone mirrors the Choose File input.
    const dropzone = document.getElementById('library-dropzone');
    ['dragover', 'dragenter'].forEach(evt => dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add('border-red-300', 'bg-red-50/40');
    }));
    ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove('border-red-300', 'bg-red-50/40');
    }));
    dropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files[0];
        if (!file) return;
        fileInput.files = e.dataTransfer.files;
        fileInput.dispatchEvent(new Event('change'));
    });
});

function renderLibraryContributeStep() {
    const step = libraryContributeState.step;
    [1, 2, 3].forEach(n => {
        document.getElementById(`library-contribute-step-${n}`).classList.toggle('hidden', n !== step);
    });

    document.querySelectorAll('[data-step-indicator]').forEach(el => {
        const n = parseInt(el.dataset.stepIndicator, 10);
        const dot = el.querySelector('.step-dot');
        const label = el.querySelector('.step-label');
        if (n < step || step === 3) {
            dot.className = 'step-dot w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold bg-brand-red text-white';
            label.className = 'step-label text-[12px] font-medium text-brand-red';
        } else if (n === step) {
            dot.className = 'step-dot w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold bg-red-50 text-brand-red ring-2 ring-red-200';
            label.className = 'step-label text-[12px] font-medium text-brand-red';
        } else {
            dot.className = 'step-dot w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold bg-gray-100 text-gray-400';
            label.className = 'step-label text-[12px] font-medium text-gray-400';
        }
    });

    const footer = document.getElementById('library-contribute-footer');
    const primaryLabel = document.getElementById('library-contribute-primary-label');
    const secondaryBtn = document.getElementById('library-contribute-secondary-btn');
    const stepsIndicator = document.getElementById('library-contribute-steps');

    if (step === 1) {
        primaryLabel.textContent = 'Next';
        secondaryBtn.classList.add('hidden');
        footer.classList.remove('hidden');
        stepsIndicator.classList.remove('hidden');
    } else if (step === 2) {
        primaryLabel.textContent = 'Submit';
        secondaryBtn.classList.remove('hidden');
        footer.classList.remove('hidden');
        stepsIndicator.classList.remove('hidden');
        renderLibraryContributePreview();
    } else {
        footer.classList.add('hidden');
        stepsIndicator.classList.add('hidden');
    }
}

function renderLibraryContributePreview() {
    const file = libraryContributeState.file;
    const style = libraryFileTypeStyle(file ? file.name.split('.').pop() : '');
    const iconEl = document.getElementById('library-preview-file-icon');
    iconEl.className = `w-12 h-12 rounded-xl flex items-center justify-center text-white shrink-0 ${style.bg}`;
    iconEl.innerHTML = `<i class="fa-solid ${style.icon} text-[19px]"></i>`;
    document.getElementById('library-preview-file-name').textContent = file ? file.name : '';
    document.getElementById('library-preview-file-size').textContent = file ? libraryFormatBytes(file.size) : '';

    document.getElementById('library-preview-title').textContent = document.getElementById('library-input-title').value.trim();
    document.getElementById('library-preview-category').textContent = document.getElementById('library-input-category').value;
    document.getElementById('library-preview-department').textContent = document.getElementById('library-input-department').value || '—';
    document.getElementById('library-preview-course').textContent = document.getElementById('library-input-course').value.trim() || '—';
    document.getElementById('library-preview-level').textContent = document.getElementById('library-input-level').value || '—';
}

function validateLibraryContributeStep1() {
    const errorEl = document.getElementById('library-step1-error');
    if (!libraryContributeState.file) {
        errorEl.textContent = 'Please choose a file to upload.';
        errorEl.classList.remove('hidden');
        return false;
    }
    if (!document.getElementById('library-input-title').value.trim()) {
        errorEl.textContent = 'Please enter a document title.';
        errorEl.classList.remove('hidden');
        return false;
    }
    if (!document.getElementById('library-input-category').value) {
        errorEl.textContent = 'Please select a category.';
        errorEl.classList.remove('hidden');
        return false;
    }
    errorEl.classList.add('hidden');
    return true;
}

function handleLibraryContributePrimaryClick() {
    if (libraryContributeState.step === 1) {
        if (!validateLibraryContributeStep1()) return;
        libraryContributeState.step = 2;
        renderLibraryContributeStep();
    } else if (libraryContributeState.step === 2) {
        submitLibraryContribution();
    }
}

function handleLibraryContributeSecondaryClick() {
    if (libraryContributeState.step === 2) {
        libraryContributeState.step = 1;
        renderLibraryContributeStep();
    }
}

async function submitLibraryContribution() {
    const errorEl = document.getElementById('library-step2-error');
    errorEl.classList.add('hidden');
    setLibraryContributeSubmitting(true);

    const formData = new FormData();
    formData.append('file', libraryContributeState.file);
    formData.append('title', document.getElementById('library-input-title').value.trim());
    formData.append('category', document.getElementById('library-input-category').value);
    formData.append('department', document.getElementById('library-input-department').value);
    formData.append('course', document.getElementById('library-input-course').value.trim());
    formData.append('level', document.getElementById('library-input-level').value);

    try {
        const response = await apiFetch('/api/library/files', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (response.ok) {
            libraryContributeState.step = 3;
            renderLibraryContributeStep();
        } else {
            errorEl.textContent = data.error || 'Something went wrong. Please try again.';
            errorEl.classList.remove('hidden');
        }
    } catch (err) {
        errorEl.textContent = 'Network error. Please try again.';
        errorEl.classList.remove('hidden');
    }
    setLibraryContributeSubmitting(false);
}

function setLibraryContributeSubmitting(isSubmitting) {
    const btn = document.getElementById('library-contribute-primary-btn');
    const spinner = document.getElementById('library-contribute-primary-spinner');
    const label = document.getElementById('library-contribute-primary-label');
    btn.disabled = isSubmitting;
    document.getElementById('library-contribute-secondary-btn').disabled = isSubmitting;
    if (isSubmitting) {
        spinner.classList.remove('hidden');
        label.textContent = 'Submitting…';
    } else {
        spinner.classList.add('hidden');
        label.textContent = 'Submit';
    }
}

function closeLibraryContributeView() {
    showView('library');
}

// "Go to Library" on the success screen
function goToLibraryFromContribute() {
    showView('library');
}

// "Upload Another Document" on the success screen
function uploadAnotherLibraryDocument() {
    resetLibraryContributeWizard();
}
