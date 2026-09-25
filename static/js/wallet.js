// ---- Wallet screen ----
// Balance, monthly free credits and transaction history, backed by
// /api/wallet, /api/wallet/transactions and /api/wallet/claim
// (app/routes/wallet.py). Everything shown here comes from the server on
// every open of the screen - nothing is cached client-side, so the numbers
// survive refreshes and account switches by construction.
//
// Top Up is intentionally UI-only ("Coming soon" toast): taking payment
// needs a payment provider that isn't integrated yet.

const WALLET_COLLAPSED_COUNT = 10;   // rows shown before "See all"
const WALLET_PAGE_SIZE = 20;         // rows per page once expanded
// Screens the Wallet can be opened from (side nav is reachable from all of
// them); the back arrow returns to whichever one it came from.
const WALLET_RETURN_VIEWS = ['feed', 'courses', 'library', 'businesses', 'search', 'chat', 'profile', 'user-profile'];

let walletReturnView = 'feed';
let walletLoadToken = 0;   // discards responses from superseded loads

function walletFreshState() {
	return {
		status: 'loading',      // 'loading' | 'ready' | 'error'
		balance: null,
		monthly: null,          // {amount, claimable, next_claim_at, last_claimed_at}
		transactions: [],
		nextCursor: null,       // id to page from, or null when everything is loaded
		expanded: false,
		claiming: false,
		loadingMore: false
	};
}
let walletState = walletFreshState();

// Row presentation, keyed by the ledger's `reason` (title/icon) and `kind` (badge).
const WALLET_ICON_PATHS = {
	wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" stroke-linecap="round" stroke-linejoin="round"></path><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" stroke-linecap="round" stroke-linejoin="round"></path>',
	gift: '<rect x="3" y="8" width="18" height="4" rx="1"></rect><path d="M12 8v13" stroke-linecap="round" stroke-linejoin="round"></path><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" stroke-linecap="round" stroke-linejoin="round"></path><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" stroke-linecap="round" stroke-linejoin="round"></path>',
	post: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" stroke-linecap="round" stroke-linejoin="round"></path>',
	comment: '<path d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" stroke-linecap="round" stroke-linejoin="round"></path>',
	reply: '<path d="m9 17-5-5 5-5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M20 18v-2a4 4 0 0 0-4-4H4" stroke-linecap="round" stroke-linejoin="round"></path>'
};
const WALLET_REASONS = {
	top_up:         { title: 'Top Up',         icon: 'wallet'  },
	monthly_reward: { title: 'Monthly Reward', icon: 'gift'    },
	post:           { title: 'Post',           icon: 'post'    },
	comment:        { title: 'Comment',        icon: 'comment' },
	reply:          { title: 'Reply',          icon: 'reply'   }
};
const WALLET_KIND_LABELS = { top_up: 'Top Up', usage: 'Usage', free: 'Free' };

function walletIconSvg(name, sizeClass) {
	const paths = WALLET_ICON_PATHS[name] || WALLET_ICON_PATHS.wallet;
	return `<svg class="${sizeClass}" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

function walletFormatNumber(n) {
	return Number(n).toLocaleString('en-US');
}

function walletFormatDate(iso) {
	const d = new Date(iso);
	if (isNaN(d)) return '';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function walletFormatTime(iso) {
	const d = new Date(iso);
	if (isNaN(d)) return '';
	return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ---- Navigation ----

// Entry point used by the side nav. Records where the user came from
// (showView clears the previous screen's `active` class, so it has to be
// read before switching) so the back arrow can return there.
function openWalletView() {
	const activeEl = document.querySelector('.view-section.active');
	const name = activeEl ? activeEl.id.replace(/-view$/, '') : 'feed';
	if (WALLET_RETURN_VIEWS.includes(name)) walletReturnView = name;
	showView('wallet');
}

function closeWalletView() {
	showView(walletReturnView || 'feed');
}

// Called by showView() each time the screen opens: start from a clean
// state (so nothing from a previous account/visit flashes) and reload.
function initWalletView() {
	walletState = walletFreshState();
	renderWallet();
	loadWallet();
}

// ---- Data ----

async function loadWallet() {
	const token = ++walletLoadToken;
	walletState.status = 'loading';
	renderWallet();

	try {
		const [summaryRes, txRes] = await Promise.all([
			fetch('/api/wallet'),
			fetch(`/api/wallet/transactions?limit=${WALLET_COLLAPSED_COUNT}`)
		]);
		if (!summaryRes.ok || !txRes.ok) throw new Error('request failed');
		const [summary, tx] = await Promise.all([summaryRes.json(), txRes.json()]);
		if (token !== walletLoadToken) return;

		walletState.balance = summary.balance;
		walletState.monthly = summary.monthly_reward;
		walletState.transactions = tx.transactions || [];
		walletState.nextCursor = tx.next_cursor == null ? null : tx.next_cursor;
		walletState.status = 'ready';
	} catch (err) {
		if (token !== walletLoadToken) return;
		walletState.status = 'error';
	}
	renderWallet();
}

async function loadMoreWalletHistory() {
	const s = walletState;
	if (s.loadingMore || s.nextCursor === null) return;
	s.loadingMore = true;
	renderWalletHistory();

	try {
		const response = await fetch(`/api/wallet/transactions?limit=${WALLET_PAGE_SIZE}&cursor=${s.nextCursor}`);
		if (!response.ok) throw new Error('request failed');
		const data = await response.json();
		if (walletState !== s) return;
		const known = new Set(s.transactions.map(t => t.id));
		(data.transactions || []).forEach(t => { if (!known.has(t.id)) s.transactions.push(t); });
		s.nextCursor = data.next_cursor == null ? null : data.next_cursor;
	} catch (err) {
		if (walletState === s) showToast("Couldn't load more transactions.");
	} finally {
		s.loadingMore = false;
		if (walletState === s) renderWalletHistory();
	}
}

function toggleWalletHistoryExpanded() {
	const s = walletState;
	if (s.status !== 'ready') return;
	s.expanded = !s.expanded;
	renderWalletHistory();
	if (s.expanded && s.nextCursor !== null) loadMoreWalletHistory();
}

async function claimWalletMonthlyCredits() {
	const s = walletState;
	if (s.status !== 'ready' || s.claiming || !s.monthly || !s.monthly.claimable) return;

	s.claiming = true;
	renderWalletMonthly();

	try {
		const response = await apiFetch('/api/wallet/claim', { method: 'POST' });
		const data = await response.json().catch(() => ({}));
		if (walletState !== s) return;

		if (response.status === 201 && data.transaction) {
			s.balance = data.balance;
			s.monthly = data.monthly_reward;
			s.transactions.unshift(data.transaction);
			showToast(`${walletFormatNumber(data.transaction.amount)} credits added`);
		} else if (response.status === 409 && data.monthly_reward) {
			// Claimed elsewhere (another tab/device): adopt the server's truth.
			s.balance = data.balance;
			s.monthly = data.monthly_reward;
			showToast('Already claimed this month');
			loadWallet();
		} else {
			throw new Error(data.error || 'claim failed');
		}
	} catch (err) {
		if (walletState === s) showToast("Couldn't claim credits. Please try again.");
	} finally {
		s.claiming = false;
		if (walletState === s) renderWallet();
	}
}

// ---- Rendering ----

function renderWallet() {
	const content = document.getElementById('wallet-content');
	const errorBox = document.getElementById('wallet-error');
	if (!content || !errorBox) return;

	const isError = walletState.status === 'error';
	content.classList.toggle('hidden', isError);
	errorBox.classList.toggle('hidden', !isError);
	if (isError) return;

	renderWalletBalance();
	renderWalletMonthly();
	renderWalletHistory();
}

function renderWalletBalance() {
	const el = document.getElementById('wallet-balance');
	if (!el) return;
	if (walletState.status === 'loading') {
		el.innerHTML = '<span class="skeleton-shimmer inline-block w-28 h-10 rounded-lg align-middle"></span>';
	} else {
		el.textContent = walletFormatNumber(walletState.balance);
	}
}

const WALLET_CLAIM_BASE = 'shrink-0 h-10 px-5 rounded-full text-[15px] font-semibold transition-transform duration-100 ';

function renderWalletMonthly() {
	const s = walletState;
	const subtitle = document.getElementById('wallet-monthly-subtitle');
	const note = document.getElementById('wallet-monthly-note');
	const btn = document.getElementById('wallet-claim-btn');
	if (!subtitle || !note || !btn) return;

	const amount = s.monthly ? s.monthly.amount : 50;
	subtitle.textContent = `Claim ${walletFormatNumber(amount)} credits once per month.`;

	if (s.status === 'loading' || !s.monthly) {
		btn.className = WALLET_CLAIM_BASE + 'skeleton-shimmer text-transparent';
		btn.textContent = 'Claim';
		btn.disabled = true;
		btn.setAttribute('aria-disabled', 'true');
		note.textContent = 'Checking your monthly claim…';
		return;
	}

	if (s.claiming) {
		btn.className = WALLET_CLAIM_BASE + 'wallet-primary-btn opacity-70';
		btn.textContent = 'Claiming…';
		btn.disabled = true;
		btn.setAttribute('aria-disabled', 'true');
		note.textContent = 'Adding your credits…';
	} else if (s.monthly.claimable) {
		btn.className = WALLET_CLAIM_BASE + 'wallet-primary-btn active:scale-[0.98]';
		btn.textContent = 'Claim';
		btn.disabled = false;
		btn.removeAttribute('aria-disabled');
		note.textContent = `Your ${walletFormatNumber(amount)} monthly credits are ready to claim.`;
	} else {
		btn.className = WALLET_CLAIM_BASE + 'bg-gray-100 text-gray-500 cursor-not-allowed';
		btn.textContent = 'Claimed';
		btn.disabled = true;
		btn.setAttribute('aria-disabled', 'true');
		const when = walletFormatDate(s.monthly.next_claim_at);
		note.textContent = when
			? `Your next claim will be available on ${when}.`
			: 'Your next claim will be available next month.';
	}
}

function walletRowHtml(t, isLast) {
	const meta = WALLET_REASONS[t.reason];
	const title = meta ? meta.title : String(t.reason || 'Activity').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
	const iconName = meta ? meta.icon : 'wallet';
	const kindLabel = WALLET_KIND_LABELS[t.kind] || '';
	const amount = t.amount > 0 ? `+${walletFormatNumber(t.amount)}` : `-${walletFormatNumber(Math.abs(t.amount))}`;
	const date = walletFormatDate(t.created_at);
	const time = walletFormatTime(t.created_at);

	return `<li class="flex items-center gap-4 py-4 ${isLast ? '' : 'border-b border-gray-100'}">
		<div class="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center shrink-0 text-gray-900">${walletIconSvg(iconName, 'w-6 h-6')}</div>
		<div class="flex-1 min-w-0">
			<p class="text-[17px] font-semibold text-gray-900 leading-tight truncate">${escapeHtml(title)}</p>
			<p class="text-[14px] text-gray-500 truncate">${escapeHtml(t.description)}</p>
			<p class="text-[13px] text-gray-400">${escapeHtml(date)}${date && time ? ' &bull; ' : ''}${escapeHtml(time)}</p>
		</div>
		<div class="flex flex-col items-end gap-1.5 shrink-0">
			<span class="text-[17px] font-bold text-gray-900">${amount}</span>
			${kindLabel ? `<span class="text-[12px] font-medium text-gray-500 bg-gray-100 rounded-full px-2.5 py-0.5">${kindLabel}</span>` : ''}
		</div>
	</li>`;
}

function walletSkeletonRowHtml() {
	return `<li class="flex items-center gap-4 py-4">
		<div class="w-12 h-12 rounded-full skeleton-shimmer shrink-0"></div>
		<div class="flex-1 space-y-2">
			<div class="h-4 w-1/3 rounded skeleton-shimmer"></div>
			<div class="h-3.5 w-1/2 rounded skeleton-shimmer"></div>
		</div>
		<div class="h-5 w-12 rounded skeleton-shimmer"></div>
	</li>`;
}

function renderWalletHistory() {
	const s = walletState;
	const list = document.getElementById('wallet-history-list');
	const footer = document.getElementById('wallet-history-footer');
	const seeAllWrap = document.getElementById('wallet-see-all-wrap');
	const seeAllLabel = document.getElementById('wallet-see-all-label');
	const seeAllChevron = document.getElementById('wallet-see-all-chevron');
	if (!list || !footer || !seeAllWrap) return;

	if (s.status === 'loading') {
		list.innerHTML = walletSkeletonRowHtml().repeat(3);
		footer.innerHTML = '';
		seeAllWrap.classList.add('hidden');
		return;
	}

	if (!s.transactions.length) {
		list.innerHTML = '';
		footer.innerHTML = `<div class="flex flex-col items-center text-center py-12">
			<div class="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 mb-3">${walletIconSvg('wallet', 'w-7 h-7')}</div>
			<p class="text-[16px] font-semibold text-gray-900">No transactions yet</p>
			<p class="text-[14px] text-gray-500 mt-1">Credits you receive or spend will show up here.</p>
		</div>`;
		seeAllWrap.classList.add('hidden');
		return;
	}

	const visible = s.expanded ? s.transactions : s.transactions.slice(0, WALLET_COLLAPSED_COUNT);
	list.innerHTML = visible.map((t, i) => walletRowHtml(t, i === visible.length - 1)).join('');

	const canExpand = s.nextCursor !== null || s.transactions.length > WALLET_COLLAPSED_COUNT;
	seeAllWrap.classList.toggle('hidden', !canExpand);
	if (seeAllLabel) seeAllLabel.textContent = s.expanded ? 'Show less' : 'See all';
	if (seeAllChevron) seeAllChevron.style.transform = s.expanded ? 'rotate(-90deg)' : '';

	if (s.expanded && s.nextCursor !== null) {
		footer.innerHTML = `<div class="py-4 text-center">
			<button type="button" onclick="loadMoreWalletHistory()" ${s.loadingMore ? 'disabled aria-busy="true"' : ''} class="h-10 px-5 rounded-full border border-gray-200 text-[14px] font-semibold text-gray-800 active:scale-[0.98] transition-transform duration-100 ${s.loadingMore ? 'opacity-60' : ''}">${s.loadingMore ? 'Loading…' : 'Load more'}</button>
		</div>`;
	} else {
		footer.innerHTML = '';
	}
}
