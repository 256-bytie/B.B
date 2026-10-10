# Beebo — Chats Screen & Flow Documentation

Source of truth for the Chats frontend. Read fully before editing any chat code.

**Legend**
- **[CURRENT]** exists in code now.
- **[INTENDED]** how it should work (only where confirmed by code/UI/CLAUDE.md).
- **[MOCK]** hard-coded for frontend development; not final.
- **[FUTURE]** to become dynamic (API/auth/backend).
- **[CLARIFY]** intent unknown. Do NOT invent; ask the owner.

---

## 1. Overview

- Chats = 1:1 messaging between campus users, plus message requests from people who messaged first (their own screen, reached from the list's ⋮ menu).
- **[CURRENT]** Frontend only, mock data, in-memory state. No backend, no persistence. A page reload resets everything.
- Screen header title: **"Chats"** (view id `chat`).
- Five screens: **Chats list** (`#chat-view`), **Conversation** (`#chat-conversation-view`), **Message requests** (`#chat-requests-view`, view id `chat-requests`), **New message** (`#chat-new-message-view`) and **New group** (`#chat-new-group-view`). The list no longer has a Messages/Requests tab bar.

## 2. File map

| Concern | File |
|---|---|
| List screen markup | `templates/partials/chat.html` |
| Conversation markup | `templates/partials/chat_conversation.html` |
| Message requests screen markup | `templates/partials/chat_requests.html` (included after `chat_conversation.html` in `templates/index.html`) |
| All chat logic + mock data | `static/js/chat.js` |
| Message action sheet markup (actions, forward picker, delete confirm) | `templates/partials/chat_message_sheet.html` |
| Message action logic (long-press, sheet drag/dismiss, react/copy/reply/forward/delete) | `static/js/chat-message-actions.js` (loaded after `chat.js` in `_trailer.html`) |
| Chats list row menu markup (long-press a conversation: Mark as unread / Mute / Pin / Delete) | `templates/partials/chat_row_menu.html` (included after `chat_message_sheet.html` in `templates/index.html`) |
| Chats list row menu logic (long-press, positioning, dismiss) | `static/js/chat-row-menu.js` (loaded after `chat-message-actions.js` in `_trailer.html`); `closeChatRowMenu()` is also called from `showView` in `core.js` |
| View switching, init hooks, bottom-nav state | `static/js/core.js` (`showView` — view list + `initChatView` / `initChatRequestsView` hooks, `updateBottomNav`, `BOTTOM_NAV_ACTIVE_ITEM`) |
| Bottom nav button | `templates/partials/bottom_nav.html` (`#bottom-nav-chat`) |
| Conversation layout CSS | `static/css/style.css` (`#chat-conversation-view.active`, `#chat-conv-scroll`, `#chat-view.active`) |
| Message sheet CSS | `static/css/style.css` (`.chat-sheet*` share the share-sheet animation rules via grouped selectors; `.chat-msg-bubble`, `.chat-sheet-react*`, `.chat-sheet-scroll`) |
| Chats FAB | `templates/partials/chat.html` (`#chat-fab`, end of `#chat-view`; `onclick="openChatNewMessage()"`), bottom-clearance rule `#chat-view.active` in `static/css/style.css` |
| New message + New group screens markup | `templates/partials/chat_new_message.html` (both views; included after `chat_requests.html` in `templates/index.html`) |
| New message + New group logic (user directory, live search, open-or-create DM, group creation) | `static/js/chat-new-message.js` (loaded after `chat-row-menu.js` in `_trailer.html`); view ids `chat-new-message` / `chat-new-group` are in `showView`'s list + init hooks in `core.js` |
| Row menu CSS | `static/css/style.css`, block "Chats list row menu" at the end of the file (`.chat-row`, `.chat-row.is-menu-target`, `.chat-row-menu` entry animation) |
| Toast helper | `showToast()` in `static/js/compose.js`; element `#app-toast` in `comment_overlay.html` |
| HTML escaping | `escapeHtml()` in `static/js/feed.js` |

Note: `chat.js` header comment references `HANDOVER.md`; that file is not in the repo.

## 3. User flow

1. Tap **Chat** icon in bottom nav → `showView('chat')` → `initChatView()`.
2. Chats list opens with filter **All**, search closed.
3. Optional: switch filter (All / Unread / Groups), open search, or open **⋮ → Requests**.
4. ⋮ → Requests → `openChatRequests()` → **Message requests** screen (bottom nav hidden). Accept (→ added to Messages) or decline (→ removed). Back arrow → `closeChatRequests()` → `showView('chat')`.
3a. A single FAB (new chat icon) sits bottom-right on the list, identical on every filter tab (§4.9); tapping it opens **New message** (§4.10): search people, tap a person → their conversation (existing or new), or **Create a group** (§4.11). **Cancel** returns to the list exactly as it was left.
4a. Long-press a Messages row → row menu (§4.8): Mark as unread / Mute / Pin / Delete (UI only, no action yet). Tap outside or pick an item to dismiss.
5. Tap a Messages row → `openChatConversation(id)` → conversation screen (bottom nav hidden); unread count set to 0.
6. Type + send (Enter or send button) → bubble appended, list preview/time updated.
6a. Long-press a bubble → message action sheet (§5.5): react, copy, reply, forward, delete.
7. Back arrow → `closeChatConversation()` → `showView('chat')` → list re-initialised (see §4.1 reset behavior).

## 4. Chats list screen (`#chat-view`)

### 4.1 Init / reset — `initChatView()` (runs every time view opens via `showView('chat')`)
- Hides search row, clears search input.
- Resets filter to `all`.
- Re-renders Messages only (requests render on their own screen, see §4.7).
- **Consequence:** returning from a conversation or from the Message requests screen also resets filter/search. **[CURRENT]**; whether to preserve them on return is **[CLARIFY]**.
- **Exception — Cancel from New message [CURRENT]:** `closeChatNewMessage()` sets `chatListRestoreOnce = true` before `showView('chat')`; `initChatView()` then skips the reset above and only re-renders with the still-intact filter + search field. `openChatNewMessage()` records `window.scrollY` in `chatListScrollY` and Cancel scrolls back to it. The flag is one-shot (cleared on use), so every other way back to the list still resets.

### 4.2 Header (sticky, `top-0`, `z-10`)

| Element | Action |
|---|---|
| Title "Chats" (`<h1>`, no id) | Static text |
| Search icon (`#chat-search-toggle`) | `toggleChatSearch()`: shows/hides search row. Show → focuses input. Hide → clears input, re-renders list. |
| ⋮ More options (`#chat-menu-btn`) | `toggleChatMenu()`: opens a popover (`#chat-menu-popover`, caret, tap-outside backdrop) under the button with a single item **Requests** (people icon). Tapping it closes the menu and calls `openChatRequests()` → the Message requests screen (§4.7). This is now the **only** entry point to requests (the Requests tab was removed). Closed by: tap outside, Escape, selecting the item, or any `showView()` call. **[CLARIFY]** further menu items (mute, etc.). |

**Compact sizing scale (Chats list screen, bottom nav excluded)** — applied in `chat.html` and `renderChatMessages()` in `chat.js` (the Message requests header reuses the `text-base` title / 36px back-button sizing):

| Element | Size |
|---|---|
| "Chats" heading | `text-base` (16px) bold; header `py-2.5` |
| Search / ⋮ icons | 20px icons (`w-5 h-5`) in 36px tap targets (`w-9 h-9`), no extra gap |
| ⋮ popover | `w-40`, `py-1`, `rounded-xl`; item `px-3.5 py-2 gap-2.5`, 18px icon, 14px medium label; caret `right-[12px]` |
| Filter pill bar | container `p-0.5`, buttons `py-1.5` 13px; row `pt-2 pb-2` |
| Row | `py-3`, avatar 48px, avatar→text gap `ml-3` |
| Name | 15px bold, `leading-tight` |
| Preview | 13px, `text-gray-500`, `mt-0.5`; status ticks 16px |
| Time | 11px |
| Unread badge | min 18×18px, 11px semibold |

### 4.3 Messages / Requests tabs — **[REMOVED]**
- The Messages / Requests tab bar (`#chat-tab-messages`, `#chat-tab-requests`) and `switchChatTab()` no longer exist. The list screen shows only the Messages list (`#chat-messages-view` / `#chat-messages-list`); requests live on their own screen (§4.7).
- **[CURRENT]** No count badge on the ⋮ menu's Requests item. **[CLARIFY]** whether one is wanted.

### 4.4 Filter row — All / Unread / Groups (`#chat-filter-row`)
- Pill-segmented control directly below the header; always visible on the list screen.
- `setChatFilter(f)` → updates UI (`updateChatFilterUi`) + re-renders with current search text.
- **All:** every conversation. **Unread:** `unread > 0`. **Groups:** `isGroup === true`.
- Filter + search combine (AND).
- State: `chatActiveFilter`. Resets to `all` on `initChatView`.
- Empty texts: "No unread messages." / "No group chats yet." / "No messages found." (any active search, or All).
- **[CURRENT]** Opening a conversation zeroes its unread, so it leaves the Unread list on return.
- Filter does not apply to Message requests (separate screen).

### 4.5 Search row (`#chat-search-row`, hidden by default)
- Input `#chat-search-input`, placeholder "Search messages", `oninput` → `filterChatMessages` → `renderChatMessages(query)`.
- Case-insensitive match on **name** and **preview** only.
- **[CURRENT]** Searches Messages list only (not requests, not message bodies). Opening the requests screen and coming back re-inits the list, which closes/clears it.
- **[CLARIFY]** whether search should cover message content / requests.

### 4.6 Messages list (`#chat-messages-list`)
Row (`#chat-row-<conversationId>`; tap anywhere, also Enter key) → `openChatConversation(id)`. Long-press → row menu (§4.8). Each row carries class `chat-row` and `data-chat-row-id="<conversationId>"` (the long-press handler depends on both; `.chat-row` also disables text selection / iOS callout).

| Part | Behavior |
|---|---|
| Avatar | 48px circle (`w-12 h-12`). `chatAvatarUrl(handle, avatar)`: uses `avatar`, else DiceBear avataaars seeded by `handle` (**[MOCK]** external URL). |
| Online dot | **[REMOVED]** The green presence dot on the list avatar no longer renders (no `bg-green-500` span in `renderChatMessages`). The `online` flag still drives the conversation header presence (§5.2). |
| Name | Bold, 16px, truncated, escaped. |
| Status ticks | Shown before the preview only when the last message is outgoing (`from: 'me'`). Single grey = `sent`, double grey = `delivered`, double green = `read`. Hidden for incoming last messages. |
| Preview | Last message text, truncated, escaped. |
| Time | Right-aligned, grey. **[CURRENT]** Not escaped; raw `HH:MM` string (24h). |
| Unread badge | Red pill with count, shown only if `unread > 0`. No 99+ cap. |

- **Ordering [CURRENT]:** array order only. Not sorted by recency. Sending a message does NOT move the conversation to top. Accepted requests are `unshift`ed to top.
- **[INTENDED]** Sort by last-message time, newest first **[CLARIFY: confirm]**.
- Empty state: "No messages found." (centered grey text). **[CLARIFY]** a dedicated empty-inbox design (no conversations at all).
- Row padding is `py-3` (compact; row ≈ 72px). **[CHANGED]** was `py-4`/56px avatar.
- Not present: swipe actions, working delete/archive/mute/pin (the long-press menu in §4.8 is UI only), pinned section / muted icon / unread-dot states, last-seen text, attachments icon. **[CLARIFY]** whether any are planned beyond the menu.

### 4.7 Message requests screen (`#chat-requests-view`, view id `chat-requests`)

Separate full-screen view (`templates/partials/chat_requests.html`), **not** a tab. Hidden bottom nav (not in `BOTTOM_NAV_ACTIVE_ITEM`); side nav not available (not in `SIDE_NAV_ELIGIBLE_VIEWS`).

- **Open:** list ⋮ → **Requests** → `openChatRequestsFromMenu()` → `openChatRequests()` → `showView('chat-requests')` → `initChatRequestsView()` (renders the lists, scrolls to top). Runs on every open.
- **Header:** sticky; back arrow (`#chat-requests-back-btn`, `closeChatRequests()` → `showView('chat')`, which re-inits the Chats list so accepted requests appear) + title **"Message requests"** (`text-base` bold).
- Sections: **"New requests"** and **"Earlier"** (uppercase small label); empty sections omitted.
- Row: avatar, name, preview (2-line clamp), time (`'22:30'`, `'Yesterday'`, `'2d ago'`), Decline (✕, `#chat-request-decline-<requestId>`) and Accept (✓, `#chat-request-accept-<requestId>`) buttons. Row id: `#chat-request-<requestId>`.
- **Accept** → `acceptChatRequest(id)`: adds conversation to top of Messages (`id: 'm-<requestId>'`, `unread: 0`, preview/time copied), removes request, re-renders the requests list. **Stays on the requests screen** (no navigation); the Messages list refreshes when the user goes back.
- **Decline** → `declineChatRequest(id)`: removes request. No confirmation, no undo, no toast.
- Row itself is not tappable (no request preview/detail screen).
- Empty state (`#chat-requests-empty`): person icon + red chat badge, title "No new requests", text "When someone messages you for the first time, their request will appear here." Shown when both lists are empty (e.g. after handling every request); the header/back arrow stay.
- **[CURRENT]** Request rows now `escapeHtml` name, preview, time and avatar URL (previously unescaped).
- Request data is the same hardcoded mock arrays as before (`chatMockRequestsNew`, `chatMockRequestsEarlier`); in-memory, resets on reload. Not deep-linked.
- **[CLARIFY]** block/report, "request sent" outgoing state, what the sender sees on decline, whether decline hides sender permanently, whether to add a request-count badge on the ⋮ menu item / Chat nav icon.

### 4.8 Conversation row menu (long-press) **[CURRENT, UI only]**

Contextual popup for one conversation in the Chats list. It targets list rows only (`.chat-row[data-chat-row-id]` inside `#chat-messages-list`), never a bubble inside an open conversation (that is the message sheet, §5.5).

**Open**
- Press-and-hold a row for 450 ms (cancelled by >10 px movement, release, pointer leave, or scroll, so scrolling the list never opens it). Also: right-click / Android long-press `contextmenu` (native menu suppressed) and the keyboard context-menu key / Shift+F10 on a focused row.
- On open: search keyboard is blurred, 10 ms haptic where supported, pressed row gets `.is-menu-target` (subtle highlight), popup scales in (140 ms, none under `prefers-reduced-motion`) from the corner nearest the row, menu takes focus.
- The finger that opened the menu releasing does **not** open the conversation (click on the row is swallowed for 400 ms after a long-press release) and does **not** dismiss the menu (backdrop ignores clicks for 300 ms after open and while the opening press is still down).
- One menu at a time. Pressing a different row while open is blocked by the backdrop.

**Position:** `position: fixed`, 272 px wide (capped to viewport − 24 px), left-aligned with the row content (`list.left + 16 px`, clamped 12 px from the viewport edge). Placed 4 px **below** the row; if it would overflow the bottom it flips **above** the row; if neither fits it is pinned inside the viewport. Recomputed on `resize` (keyboard hide, rotation).

**Appearance:** light background (`bg-gray-100`), `rounded-[20px]`, shadow `0 8px 24px rgba(0,0,0,.16)`, `py-2`. Each item: left-aligned 24 px icon + 16 px label, `gap-4`, `px-5 py-3.5` (even spacing), `active:bg-gray-200`, icon scales down on press. Standard items use `text-gray-900`; **Delete conversation** uses `text-brand-red` for icon and label (destructive). Dark mode uses the existing `html.dark` swaps for `bg-gray-100` / `text-gray-900` / `bg-gray-200`. **[CLARIFY]** dark-mode visual check not performed.

**Items (top to bottom)**

| Item | ID | Intended behavior | Now |
|---|---|---|---|
| Mark as unread | `#chat-row-menu-unread-btn` (`data-action="unread"`) | Flags the conversation as unread for later attention. | Dismisses only |
| Mute conversation | `#chat-row-menu-mute-btn` (`data-action="mute"`) | Silences notifications for the conversation. | Dismisses only |
| Pin conversation | `#chat-row-menu-pin-btn` (`data-action="pin"`) | Pins it to the top of the Chats list. | Dismisses only |
| Delete conversation | `#chat-row-menu-delete-btn` (`data-action="delete"`) | Deletes the conversation (destructive). | Dismisses only |

**Dismiss:** tap outside (`#chat-row-menu-backdrop`), pick any item, Escape, Tab, page scroll (ignored for 300 ms after open), browser Back (`popstate`), leaving the Chats screen (`showView` calls `closeChatRowMenu()`). Closing from the keyboard returns focus to the row.

**Implementation notes**
- Everything lives in `chat-row-menu.js` (IIFE; only global is `window.closeChatRowMenu`). Listeners are delegated on `#chat-messages-list`, which survives `renderChatMessages()` re-renders (only its `innerHTML` is replaced).
- The pressed conversation is held as `target = { conv, rowEl }`, where `conv` is the live object from `chatMockMessages` (not an index). The item click handler is the single place to wire behavior; it currently only calls `close()`. Wire against `target.conv` so the action always applies to the pressed conversation.
- No toast, no state change, no persistence. Unread count, preview, order and mute/pin state are untouched.
- Items are `role="menuitem"` inside `role="menu"`; ArrowUp/ArrowDown move focus between items.
- **[CLARIFY]** when wired: Mark as unread vs. an already-unread conversation (label flip to "Mark as read"?), Mute duration/choices and muted indicator on the row, Pin limit + pinned ordering/indicator, Delete confirmation dialog (reuse `#chat-delete-dialog` style) and whether delete is for-me only. Groups currently get the same four items. Menu labels are static.

### 4.9 Chats FAB (`#chat-fab`) **[CURRENT]**

One floating action button on the Chats list, bottom-right.

- **Single instance:** markup lives once at the end of `#chat-view` (`chat.html`), outside `#chat-messages-list`. Switching All / Unread / Groups, searching, or any re-render only replaces the list's `innerHTML`, so the FAB is never recreated and cannot move. Visibility comes from the view itself (`.view-section` is `display:none` unless active); no JS show/hide and no entry in `updateBottomNav`.
- **Position:** `position: fixed; right: 20px; bottom: calc(var(--bottom-nav-h) + 32px + env(safe-area-inset-bottom, 0px))`: the same anchor as the feed compose FAB. Because it keys off `--bottom-nav-h` and the safe-area inset it always clears the bottom nav (32 px gap) at any screen size. Size 56 px (`w-14 h-14`), `rounded-full`, `bg-brand-red`, `text-white`, `card-shadow`, `z-9` (below the bottom nav `z-10`, the ⋮ popover and the row menu `z-40/50`).
- **Icon:** the provided `chats-circle.svg` (Phosphor "regular" chats-circle), inlined at its native 32 px with the original `viewBox="0 0 256 256"` and path data unchanged. Only the fill is `currentColor` instead of `#000000` (same convention as the bottom-nav icons) so it renders white on the red button and follows dark mode.
- **List clearance:** `#chat-view.active` bottom padding is `--bottom-nav-h + 104px + safe-area` (nav + 32 px gap + 56 px FAB + 16 px air) so the last row can scroll fully clear of the FAB.
- **Action:** `openChatNewMessage()` (in `chat-new-message.js`) → saves the list scroll offset, then `showView('chat-new-message')` (§4.10). Accessible name "New chat".
- **[CLARIFY]** whether the FAB should hide on scroll like the feed FAB, and whether it should hide while the search field has the keyboard open.

### 4.10 New message screen (`#chat-new-message-view`, view id `chat-new-message`) **[CURRENT, client-side conversations]**

Full-screen (bottom nav hidden; not in `BOTTOM_NAV_ACTIVE_ITEM`). Opened only from the Chats FAB, which exists on the list regardless of filter tab, so All / Unread / Groups all lead here.

- **Header:** sticky; bold centred title **"New message"**; **Cancel** (`#chat-new-message-cancel-btn`) top-left → `closeChatNewMessage()`: back to the Chats list with filter tab, search text/row and scroll position preserved (§4.1 exception).
- **Search** (`#chat-new-message-search`): rounded pill (`rounded-full`, grey fill), search icon, placeholder "Search". Filters as you type, no submit. A leading `@` is ignored; matching is case-insensitive on **name or username**.
- **Create a group** (`#chat-new-message-group-btn`): 44 px grey circle with a group icon, bold label, right chevron → `openChatNewGroup()` (§4.11).
- **User list** (`#chat-new-message-list`): rendered by JS, never hardcoded. Row = button with 44 px circular avatar (`chatAvatarUrl`, DiceBear fallback), bold display name, `@username` in lighter grey. Rows carry `data-user-key` (lowercase handle). Empty states: "Search for people by name or username." (nothing typed and no contacts), "Searching…", "No users found.", "Couldn't search right now. Try again." (request failed; local matches still show).
- **Tap a person** → `openDirectConversation(user)`: finds an existing non-group conversation with the same handle in `chatMockMessages` and opens it; otherwise creates `{ id: 'u-<userId|handle>', name, handle, avatar, preview: '', time: '', unread: 0 }`, sets `chatMockThreads[id] = []` (empty thread, so no phantom incoming message), `unshift`s it to the top of the list, then `openChatConversation(id)`. The conversation therefore appears in the Chats list (blank preview/time) even before a message is sent. Tapping the same person again reuses it.
- **User directory** (single swap point, `chat-new-message.js`):
  - *Typed query:* local contacts match instantly, then `GET /api/search?type=people&limit=30&q=…` (existing endpoint) is merged in (debounced 250 ms; responses for superseded queries are dropped; de-duplicated by handle). The server also matches `bio`; those hits are filtered out client-side so only name/username matches show. The server already excludes the signed-in user.
  - *Empty query:* **[CURRENT]** people from existing direct conversations (`chatDirectoryLocal`). No "list all users" endpoint exists. **[FUTURE]** replace with a directory/suggestions endpoint (backend prompt: `BACKEND_PROMPT_chat_user_directory.md`).
  - Contacts from the mock conversations (`persistence-tester`, …) are not real accounts; only the search endpoint returns real users.
- **State:** the screen resets (empty search, top of page) on each open from the FAB. Returning from New group restores the search text (`nmRestoreOnce`).
- **[CLARIFY]** follow-gating (can you DM anyone, or only followers/mutuals → Requests flow), blocked users, whether a conversation should only join the list after the first message, pagination of the directory, verified badges (not in user data today).

### 4.11 New group screen (`#chat-new-group-view`, view id `chat-new-group`) **[CURRENT, client-side]**

The group creation flow behind "Create a group". Full-screen, bottom nav hidden.

- **Header:** **Cancel** (`#chat-new-group-cancel-btn`) → `closeChatNewGroup()` back to New message (search text kept); title **"New group"**; **Create** (`#chat-new-group-create-btn`, red, disabled until valid).
- **Group name** (`#chat-new-group-name`, optional, max 50). Empty → **system-generated name** from the members' display names (`chatGeneratedGroupName`): "A", "A and B", or "A, B and N others" ("1 other" when N = 1). A typed name is stored as `customName` and always kept. `chatSetGroupMembers(conv, members)` is the single entry point for membership changes and re-derives `name` when `customName` is empty (no UI changes membership yet). The same `conv.name` feeds the Chats list, conversation header and forward picker.
- **Participants:** search (`#chat-new-group-search`, same live search + directory as §4.10) and a checkbox list (`#chat-new-group-list`; row `role="checkbox"`, red check when selected). Selected people appear as removable chips (`#chat-new-group-chips`, tap to remove) and stay selected across searches. Hint line (`#chat-new-group-hint`) shows the count.
- **Validation:** at least **2** participants (`MIN_GROUP_MEMBERS`, plus you). Create is disabled below that.
- **Create** → `createChatGroup()`: adds `{ id: 'g-<timestamp>', name, handle: <id>, avatar: null, preview: '', time: '', unread: 0, isGroup: true, customName, members: [{ id, name, handle }] }` to the top of `chatMockMessages`, empty thread, then opens it. Appears under the Groups filter. The conversation screen is still the 1:1 UI (header "Group", no member list, §7).
- State resets (selection, name, search) every time the screen opens. **[CLARIFY]** group avatar/photo, member management after creation, admin roles, member limit, whether participants must follow you.

## 5. Conversation screen (`#chat-conversation-view`)

Full-screen flex column (`100dvh`): fixed header, scrolling thread (`#chat-conv-scroll`), fixed composer. Bottom nav hidden (view is not in `BOTTOM_NAV_ACTIVE_ITEM`). Side nav not available here.

### 5.1 Open — `openChatConversation(id)`
- Finds conversation in `chatMockMessages`; returns silently if not found.
- Sets `chatActiveConversationId`, `unread = 0`, fills avatar/name, status text "Online", clears input, renders thread, `showView('chat-conversation')`, scrolls to bottom.

### 5.2 Header

| Element | Action |
|---|---|
| Back arrow (`#chat-conv-back-btn`) | `closeChatConversation()` → clears active id, `showView('chat')`. |
| Avatar (`#chat-conv-avatar`, 48px) | **[CURRENT]** Not tappable. **[CLARIFY]** whether it opens the user's profile. |
| Name (`#chat-conv-name`) | Truncated. |
| Presence (`#chat-conv-status`: dot `#chat-conv-dot` + text `#chat-conv-status-text`) | Driven by mock `online` flag: online → green dot + "Online"; offline → grey dot + "Offline"; group → dot hidden + "Group". **[MOCK]** flag. **[FUTURE]** real presence. **[CLARIFY]** last-seen wording, group header content. |
| Search icon (`#chat-conv-search-btn`) | Toast "Coming soon". |
| ⋮ More options (`#chat-conv-menu-btn`) | Toast "Coming soon". **[CLARIFY]** intended menu (mute, delete, block, etc.). |

### 5.3 Thread
- Static "Today" pill at top. **[MOCK]** Not computed from message dates. **[FUTURE]** date separators per day.
- Bubbles, `space-y-5`:
  - **Incoming (`from: 'them'`):** left, 40px avatar, grey bubble, time below.
  - **Outgoing (`from: 'me'`):** right, red bubble (`brand-red`), time + check icon below.
- Outgoing bubbles show a status icon via `chatStatusIconHtml(status)`: `sent` (single grey), `delivered` (double grey), `read` (double green). Missing status defaults to `sent`. New messages sent in-app get `sent` and never advance (**[MOCK]**; no server). **[FUTURE]** real transitions. **[CLARIFY]** failed/sending state and icons.
- Text only. All message text, time, reply text and reaction emoji are `escapeHtml`'d. Max bubble width 78%.
- Thread source: `chatMockThreads[id]`; if none, `chatThreadFor()` creates one incoming message from the list preview.
- Bubbles may carry a **Forwarded** tag, a quoted **reply block**, and a **reaction chip** (see §5.5). Each bubble has `data-chat-msg-index` (position in its thread), `tabindex="0"`, class `chat-msg-bubble` (no text selection / iOS callout).
- No pagination/infinite scroll, typing indicator, edit, sent attachments/images/GIFs (composer buttons exist, inert), voice, read receipts.

### 5.4 Composer
- Pill input `#chat-conv-input` ("Type a message...", `enterkeyhint="send"`).
- GIF button (`#chat-conv-gif-btn`, left inside input; replaced the former emoji/smiley button, `#chat-conv-emoji-btn` no longer exists): toast "Coming soon".
- Trailing actions (right inside the pill, after the input), in this order: add file / paperclip (`#chat-conv-attach-btn`), camera (`#chat-conv-camera-btn`). Both: toast "Coming soon" **[MOCK]**; no picker, upload, capture, or message type behind them (GIF button above is equally inert). Always visible (not hidden while typing). Icons `text-gray-500`; GIF is a 28x24 rounded-rect "GIF" glyph, the others 24x24 outline.
- Pill row order: GIF | input | file | camera, then the red Send button outside the pill.
- Send button (`#chat-conv-send-btn`, red circle, paper-plane): `sendChatMessage()`.
- Enter key: `preventDefault` + `sendChatMessage()`.
- `sendChatMessage()`: trims; ignores empty; time = local `HH:MM`; pushes `{from:'me', text, time}` into in-memory thread; sets conversation `preview`/`time`; clears input; re-renders; scrolls to bottom; refocuses input.
- Sent message gets `status: 'sent'`.
- **[CURRENT]** No auto-reply, no max length, no disabled state on empty, no sending/failed state, no draft retention.
- Attachment (file), camera, and GIF buttons exist as UI only (see above); no voice button. **[CLARIFY]** behavior when implemented: file types/size limits, camera capture vs gallery, GIF provider, whether the three hide while text is typed, and whether the Send button should swap with a voice control on empty input.
- **[CONSTRAINT]** Narrow screens (~360px): the pill holds 3 icons plus the input; the input is ~130px wide at that size and the "Type a message..." placeholder may truncate. Do not add more pill icons without moving the existing ones.

### 5.5 Message actions sheet (long-press) **[CURRENT, mock]**

Contextual bottom sheet for one message. Not a generic modal: it exists only in the conversation screen and acts on the pressed bubble.

**Open**
- Press-and-hold a bubble (450 ms; cancelled by >10 px movement, release, or scroll, so scrolling the thread never opens it). Also: right-click / Android long-press `contextmenu` (native menu suppressed), and Enter/Space on a focused bubble.
- On open: composer is blurred (keyboard hides), 10 ms haptic where supported, background dims (`bg-black/30`), sheet slides up. The thread gets temporary bottom padding equal to the sheet height and scrolls so the pressed bubble stays visible above the sheet (works for the last message too); padding animates away on close.
- Only one sheet at a time; opening is ignored while any chat sheet is open.

**Structure (top to bottom)**
1. Drag handle.
2. Preview of the pressed message (grey rounded box, max 3 lines).
3. **React** header + horizontally scrollable emoji row: 🔥 🙌 😭 🙈 🙏 😖, then 😂 ❤️ 👍 😮 🎉 (scroll for more). The viewer's current reaction is highlighted (`aria-pressed`).
4. Rows, label left / icon right: **Copy**, **Reply**, **Forward**, **Delete**.

**Dismiss:** tap dimmed area (ignored for 300 ms after open so the opening finger can't close it), drag down (>30 % of height or flick), Escape, browser Back (`popstate`). Drag does not start from the emoji row or forward list (`data-sheet-no-drag`); they scroll instead. Leaving the conversation (`closeChatConversation`) closes any open sheet.

**Actions**

| Action | Behavior |
|---|---|
| React (`#chat-react-<name>-btn`, see §14) | Sets `msg.reactions.me = emoji`; tapping your current emoji removes it. Sheet closes, thread re-renders, chip appears under the bubble (own = right, incoming = left; distinct emojis; count shown if both sides used the same). One reaction per side per message. |
| Copy (`#chat-message-copy-btn`) | `navigator.clipboard.writeText` (secure contexts), `execCommand('copy')` fallback. Toast "Message copied" / "Could not copy message". |
| Reply (`#chat-message-reply-btn`) | Closes sheet, sets `chatReplyTarget = { from, text }` (snapshot), shows `#chat-reply-bar` above the composer (✕ = `#chat-reply-cancel-btn`) (name: "You" or the other person; text truncated; ✕ cancels), focuses input. Next sent message carries `replyTo` and renders the quote block inside its bubble; bar clears on send, cancel, opening or leaving a conversation. Quote is not tappable (no jump-to-original). |
| Forward (`#chat-message-forward-btn`) | Closes the action sheet, opens the **Forward to** sheet listing every conversation (incl. groups and the current one). **Send** per row appends `{ from:'me', text, time, status:'sent', forwarded:true }` to that thread, updates its list preview/time, button becomes disabled **Sent**, toast "Forwarded to <name>". Multiple recipients allowed per open; sheet stays open until dismissed. Forwarded bubbles show an italic "Forwarded" tag. Text only. |
| Delete (`#chat-message-delete-btn`; confirm `#chat-delete-confirm-btn`, cancel `#chat-delete-cancel-btn`) | Closes sheet, opens confirm dialog "Delete message?" (same style as delete-comment). Confirm removes the message object from its thread (local only), re-derives the list row preview/time from the new last message (`chatSyncListRowToThread`; emptied thread → blank preview/time), toast "Message deleted". Available for incoming and outgoing messages. |

**Implementation notes**
- `chat-message-actions.js` contains its own `createSheet()` (open/close/drag-dismiss) instead of editing `share-sheet.js`; behavior mirrors it. Reused CSS rules: `.chat-sheet*` are grouped with `.share-sheet*` in `style.css` (z-40 backdrop, z-50 sheet, `max-w-[430px]`).
- The pressed message is held as the live object from `chatMockThreads[id]` (not an index), so later re-renders cannot misdirect an action.
- Reply state and `chatSyncListRowToThread` live in `chat.js`; `chat-message-actions.js` calls them. Keep `chat-message-actions.js` after `chat.js` and `compose.js` in `_trailer.html`.
- Dark mode uses the existing `html.dark` utility overrides; only `.chat-sheet-react.is-selected` has its own dark rule. **[CLARIFY]** visual check in dark mode not performed.
- Not covered: edit, pin, info/seen-by, select-multiple, report, "delete for everyone", reacting from the bubble (tap), emoji picker beyond the 11 listed.

## 6. Navigation

| From | To | Trigger |
|---|---|---|
| Any bottom-nav screen | Chats list | Bottom nav Chat icon (`showView('chat')`) |
| Chats list | Conversation | Tap Messages row |
| Conversation | Chats list | Back arrow (list re-inits) |
| Chats list | Message requests | ⋮ → Requests (`openChatRequests()`) |
| Message requests | Chats list | Back arrow (`closeChatRequests()`; list re-inits) |
| Chats list | Other bottom-nav screens | Bottom nav (Home/Search/Compose/Profile) |
| Chats list | Businesses / Wallet / Community | Side nav drawer or edge swipe; their back arrows return to `chat` (`BUSINESSES_RETURN_VIEWS`, `WALLET_RETURN_VIEWS`, `COMMUNITY_RETURN_VIEWS` include `'chat'`) |

- Bottom nav: visible on Chats list (Chat item active), hidden in conversation and on Message requests. `#chat-view.active` adds bottom padding for the nav (`--bottom-nav-h`).
- Side nav: `chat-view` is eligible and maps to nav key `chat`, but the drawer has **no Chat row** (Home, Courses, Library, Businesses, Wallet only). `chat-conversation-view` and `chat-requests-view` are not eligible.
- **URL:** chat views are NOT deep-linked (`showView` only syncs `/`, `/profile`, `/u/:id`). Reload lands on feed/login. **[CLARIFY]** whether `/chats` or `/chats/:id` is wanted.
- Bottom-nav label in markup is "Chat" (aria-label); header title is "Chats".
- No entry point exists from profiles (e.g. a "Message" button on another user's profile) or from share sheet. **[CLARIFY]** / **[FUTURE]**.

## 7. State and edge-case matrix

| State | Status |
|---|---|
| Loading (list or thread) | **[CURRENT]** None. **[FUTURE]** needed once API-backed. |
| Error (fetch/send failure) | **[CURRENT]** None. **[FUTURE]** needed (retry on send, list error). |
| Empty inbox (no conversations) | Falls into "No messages found." **[CLARIFY]** dedicated design. |
| Empty Unread / Groups | Implemented (§4.4). |
| Empty Message requests | Implemented (§4.7). |
| Search no match | "No messages found." |
| Unavailable/deleted user, blocked, offline, rate-limited | **[CLARIFY]** not designed or implemented. |
| Conversation id not found on open | Silent no-op. |
| Deleted last message in a thread | List row preview/time become blank. **[CLARIFY]** placeholder text / hide row. |
| New message: no matching users | "No users found." |
| New message: search request fails | Local contact matches still shown; "Couldn't search right now. Try again." when none |
| New group with fewer than 2 people | Create disabled |
| Long-press a list row (any conversation, incl. groups) | Row menu (§4.8); same four items for all. Release does not open the conversation. |
| Long-press on a message in a group | Same sheet; reply label uses the group name (no per-sender names exist yet). |
| Group conversation opened | **[CURRENT]** Uses the same 1:1 UI: header shows "Group" with no dot, no member count, no sender names on incoming bubbles, single avatar. **[CLARIFY]** group conversation design. |
| Unread update while viewing list | Not applicable (no live updates). **[FUTURE]** realtime/polling. |

## 8. Mock data (all in `static/js/chat.js`) — **[MOCK]**

- `chatMockMessages`: m1 Persistence Tester (2 unread, online), m2 Test User (1, offline), m3 Not Lvke (0, online), m4 "Design Hackathon 2026" (`isGroup: true`, 3 unread; added for the Groups filter, no thread so preview becomes its only message).
- `chatMockRequestsNew`: r1–r3. `chatMockRequestsEarlier`: r4–r5. (Shown on the Message requests screen.)
- `chatMockThreads`: threads for m1–m3. After seeding, list preview/time are overwritten from each thread's last message.
- Avatars: DiceBear URL by handle. Presence: mock `online` flag. Message `status`: hard-coded (m1 last outgoing = `read`, m2 = `delivered`, m3 last outgoing = `read`). "Today" label: hard-coded.
- Conversation shape: `{ id, name, handle, avatar, preview, time, unread, online?, isGroup?, members? }` (`members` and `customName` only on groups created via §4.11 (`customName` empty = generated name); conversations created via New message have `id: 'u-…'`, an empty thread and blank preview/time). Message shape: `{ from: 'me'|'them', text, time, status?: 'sent'|'delivered'|'read', replyTo?: { from, text }, forwarded?: true, reactions?: { me?: emoji, them?: emoji } }`. No message ids; messages are addressed by object identity / thread index. No mock data seeds `reactions.them`, `replyTo` or `forwarded`. List ticks derive from the thread's last message (`chatLastMessage`); conversations with no thread (accepted requests) show none. Request shape: `{ id, name, handle, avatar, preview, time }`.

## 9. Backend / API relationship

- **[CURRENT]** None. No chat routes in `app/routes/*`, no chat tables in `app/db.py` / migrations.
- **[FUTURE]** Needed (shapes not defined): list conversations (with unread count, last message, group flag), list requests, accept/decline, fetch thread (paginated), send message, mark read, presence, group data.
- Rules from `CLAUDE.md`:
  - Backend is written by Claude Code in terminal; frontend work must hand over a self-contained backend prompt rather than editing `app/routes/*.py`.
  - Every mutating call (`POST/PATCH/PUT/DELETE`) requires `X-CSRF-Token`; use the existing fetch wrapper in `core.js`, not raw `fetch()` (raw → 403).
  - Real avatars come from users' `profile_picture`; fallback DiceBear by username.
  - Sessions via Flask server-side session; identity from `session.user`.
- **[CLARIFY]** realtime transport (polling vs websockets/SSE), message retention, who can message whom (follow-gating decides Messages vs Requests?).

## 10. Constraints to preserve

- Vanilla JS SPA; views switched only by `showView(name)` with element id `<name>-view` and class `view-section`. Keep `'chat'`, `'chat-conversation'` and `'chat-requests'` in `showView`'s list.
- `initChatView()` must stay hooked in `showView('chat')`; `initChatRequestsView()` in `showView('chat-requests')`.
- Keep requests out of `BOTTOM_NAV_ACTIVE_ITEM` (full-screen, no bottom nav) — the requests screen has no bottom padding for the nav.
- Conversation view needs `#chat-conversation-view.active { display:flex !important; height:100dvh }` so the composer rides above the keyboard; `#chat-conv-scroll` needs `min-height:0`. Do not move scrolling to the document.
- Chats list scrolls the document; keep `#chat-view.active` bottom padding for the fixed bottom nav.
- Escape all dynamic text with `escapeHtml()` before `innerHTML` (includes reply text, reaction emoji, forward-list names).
- New message / New group: keep view ids `'chat-new-message'` and `'chat-new-group'` in `showView`'s list with their init hooks (`initChatNewMessageView`, `initChatNewGroupView`); keep `chat-new-message.js` after `chat.js` (uses `chatMockMessages`, `chatMockThreads`, `chatAvatarUrl`, `openChatConversation`, `chatListRestoreOnce`, `chatListScrollY`). Cancel-to-list must go through `closeChatNewMessage()` so state is restored; do not call `showView('chat')` directly from these screens.
- Keep `#chat-fab` as a single element outside `#chat-messages-list` (never render it inside the list or per filter) and keep its bottom offset on `--bottom-nav-h`; keep the `#chat-view.active` bottom padding in step with the FAB size.
- List rows must keep class `chat-row` and `data-chat-row-id`; the row-menu handler depends on both. Keep `chat-row-menu.js` after `chat.js` in `_trailer.html` (uses `chatMockMessages`). Do not add click handlers to rows that would fire after a long-press (the menu swallows the release click in the capture phase on `#chat-messages-list`).
- Bubbles must keep class `chat-msg-bubble` and `data-chat-msg-index`; the long-press handler depends on both. Do not add click handlers to bubbles that would fire after a long-press.
- The message sheets use `touch-action: none` (drag-to-dismiss); scrollable regions inside must keep `data-sheet-no-drag` + their own `touch-action`.
- Use `showToast()` for "Coming soon" placeholders.
- Tailwind utility classes; brand colour is `brand-red` (`bg-brand-red`).
- Inline `onclick` handler style is the project convention.
- Indentation in chat files is tabs.
- Dark mode uses `html.dark` CSS swap. **[CLARIFY]** chat dark-mode appearance was not verified.

## 11. Do not change (existing behavior)

- Row tap opens conversation; opening marks it read.
- Enter sends; empty/whitespace messages are ignored.
- Accept moves request to top of Messages; decline just removes. Both happen on the Message requests screen and keep the user there.
- Conversation and Message requests hide the bottom nav; list shows it.
- Long-press (not tap) opens the message sheet; scrolling must never open it.
- Thread/preview consistency also holds after delete and forward.
- Status ticks and unread badge semantics described in §4.6 (the list online dot is removed; do not re-add).
- Exactly one FAB on the list, same position on All / Unread / Groups, opening New message.
- Cancel on New message returns to the list with filter, search text and scroll intact (`chatListRestoreOnce` is one-shot; every other return still resets).
- Long-press (not tap) opens the row menu; a plain tap still opens the conversation; scrolling the list must never open the menu.
- Thread/preview consistency: list preview/time always reflect last thread message.
- Back from conversation re-renders the list (so previews/unread are fresh).

## 12. Temporary (frontend still in design)

All of §8 (mock data), message actions being local-only (reactions, forwards, deletes lost on reload; no "them" reactions), static "Today" divider, mock presence flag and message status values, "Coming soon" toasts (conversation search, ⋮, GIF, add file, camera), list ⋮ menu having only the Requests item, row-menu items (§4.8) being inert (they only dismiss), New message / New group conversations being in-memory only and the empty-query user list being existing contacts (§4.10), group conversations reusing the 1:1 UI, unsorted list, state reset on every list open.

## 13. Open items (requires owner decision or implementation)

1. List ⋮ menu contents (only Requests today); conversation ⋮ menu contents.
2. Manage actions: the row menu (§4.8) shows Mark as unread / Mute / Pin / Delete as UI only; wire them (state, persistence, indicators, delete confirm). Archive, block, report do not exist.
3. Start a new conversation: FAB → New message (§4.10) and group creation (§4.11) are done client-side. Remaining: user directory endpoint, real conversation/group persistence, profile "Message" button, group member management.
4. Group chats: creation, members, sender names, header info, presence replacement.
5. Message features: working attachments/images/GIFs/camera (composer buttons are inert), full emoji picker (composer emoji button removed), edit, failed/sending state, jump-to-original for replies, delete-for-everyone vs delete-for-me, message-sheet extras (pin, report, info, multi-select), status advancement, date separators, in-conversation search.
6. Sorting by recency; preserve filter/search on return from a conversation or the requests screen.
7. Loading, error, offline, blocked, deleted-user states.
8. Realtime updates, unread badge on bottom-nav Chat icon and a request-count badge on the ⋮ Requests item.
9. Deep links (`/chats`, `/chats/:id`), side-nav Chat entry.
10. Backend tables, endpoints (incl. user directory + create-conversation/create-group; directory prompt in `BACKEND_PROMPT_chat_user_directory.md`), and CSRF-compliant frontend wiring. Message actions will need: add/remove reaction, delete message, forward (create message in target thread), reply reference (message id) — all mutating, all via the CSRF fetch wrapper.
11. Message ids: messages currently have none; reply/forward/reaction persistence needs stable ids.
12. Reaction palette: confirm the final emoji set/order (11 used now) and whether there should be a "+" full picker.

## 14. Element ID reference

Exact `id` of every control and container. `<…>` = dynamic part. "Selector" = no static id exists (repeated or generated elements).

**Chats list (`chat.html`)**

| ID | Element | Handler |
|---|---|---|
| `#chat-view` | Screen root | `showView('chat')` |
| `#chat-search-toggle` | Header search icon | `toggleChatSearch()` |
| `#chat-menu-btn` | Header ⋮ button | `toggleChatMenu()` |
| `#chat-menu-backdrop` | Tap-outside layer for the ⋮ menu | `closeChatMenu()` |
| `#chat-menu-popover` | ⋮ menu popover | — |
| `#chat-menu-requests-btn` | "Requests" menu item | `openChatRequestsFromMenu()` → `openChatRequests()` |
| `#chat-filter-row` | Filter container | — |
| `#chat-filter-all` / `#chat-filter-unread` / `#chat-filter-groups` | Filter pills | `setChatFilter('all' / 'unread' / 'groups')` |
| `#chat-search-row` | Search row container | — |
| `#chat-search-input` | Search field | `filterChatMessages(value)` |
| `#chat-messages-view` / `#chat-messages-list` | Messages content / list | — |
| `#chat-fab` | Floating action button (new chat icon), single instance | `openChatNewMessage()` |
| `#chat-row-<conversationId>` | Conversation row (class `chat-row`, `data-chat-row-id`) | tap → `openChatConversation(id)`; long-press → row menu |

**Chats list row menu (`chat_row_menu.html`)**

| ID | Element | Handler |
|---|---|---|
| `#chat-row-menu-backdrop` | Tap-outside layer | closes menu |
| `#chat-row-menu` | Popup (`role="menu"`) | positioned by `chat-row-menu.js` |
| `#chat-row-menu-unread-btn` | Mark as unread (`data-action="unread"`) | dismiss only |
| `#chat-row-menu-mute-btn` | Mute conversation (`data-action="mute"`) | dismiss only |
| `#chat-row-menu-pin-btn` | Pin conversation (`data-action="pin"`) | dismiss only |
| `#chat-row-menu-delete-btn` | Delete conversation (`data-action="delete"`, red) | dismiss only |

**New message / New group (`chat_new_message.html`)**

| ID | Element | Handler |
|---|---|---|
| `#chat-new-message-view` | New message screen root | `showView('chat-new-message')` → `initChatNewMessageView()` |
| `#chat-new-message-cancel-btn` | Cancel | `closeChatNewMessage()` |
| `#chat-new-message-search` | Search field | live filter (`input` event) |
| `#chat-new-message-group-btn` | "Create a group" row | `openChatNewGroup()` |
| `#chat-new-message-list` | User list | click on `[data-user-key]` → `openDirectConversation` |
| `#chat-new-group-view` | New group screen root | `showView('chat-new-group')` → `initChatNewGroupView()` |
| `#chat-new-group-cancel-btn` | Cancel | `closeChatNewGroup()` |
| `#chat-new-group-create-btn` | Create | `createChatGroup()` |
| `#chat-new-group-name` | Group name field | — |
| `#chat-new-group-chips` | Selected participant chips | click on `[data-chip-key]` removes |
| `#chat-new-group-search` | Participant search | live filter |
| `#chat-new-group-hint` | Selection hint | — |
| `#chat-new-group-list` | Selectable user list | click on `[data-user-key]` toggles |

**Message requests (`chat_requests.html`)**

| ID | Element | Handler |
|---|---|---|
| `#chat-requests-view` | Screen root | `showView('chat-requests')` |
| `#chat-requests-back-btn` | Back arrow | `closeChatRequests()` |
| `#chat-requests-body` | Content container | — |
| `#chat-requests-list` / `#chat-requests-empty` | Populated list / empty state | — |
| `#chat-request-<requestId>` | Request row | — |
| `#chat-request-decline-<requestId>` | Decline ✕ | `declineChatRequest(id)` |
| `#chat-request-accept-<requestId>` | Accept ✓ | `acceptChatRequest(id)` |

**Conversation (`chat_conversation.html`)**

| ID | Element | Handler |
|---|---|---|
| `#chat-conversation-view` | Screen root | `showView('chat-conversation')` |
| `#chat-conv-back-btn` | Back arrow | `closeChatConversation()` |
| `#chat-conv-avatar` / `#chat-conv-name` | Header avatar / name | — |
| `#chat-conv-status` / `#chat-conv-dot` / `#chat-conv-status-text` | Presence container / dot / text | — |
| `#chat-conv-search-btn` | Header search icon | Toast "Coming soon" |
| `#chat-conv-menu-btn` | Header ⋮ | Toast "Coming soon" |
| `#chat-conv-scroll` / `#chat-conv-thread` | Scroll container / bubble list | — |
| Selector `.chat-msg-bubble[data-chat-msg-index="<n>"]` | Message bubble | Long-press → message sheet |
| `#chat-reply-bar` / `#chat-reply-bar-name` / `#chat-reply-bar-text` | Reply preview bar / name / text | — |
| `#chat-reply-cancel-btn` | Reply bar ✕ | `clearChatReplyTarget()` |
| `#chat-conv-gif-btn` | Composer GIF button (left of input; replaced emoji button) | Toast "Coming soon" |
| `#chat-conv-attach-btn` | Composer add-file button (right of input, 1st) | Toast "Coming soon" |
| `#chat-conv-camera-btn` | Composer camera button (right of input, 2nd) | Toast "Coming soon" |
| `#chat-conv-input` | Composer input | Enter → `sendChatMessage()` |
| `#chat-conv-send-btn` | Send button | `sendChatMessage()` |

**Message sheets (`chat_message_sheet.html`)**

| ID | Element | Handler |
|---|---|---|
| `#chat-message-sheet-backdrop` / `#chat-message-sheet` | Action sheet dim layer / sheet | tap outside closes |
| `#chat-message-sheet-preview` | Pressed-message preview text | — |
| `#chat-message-sheet-reactions` | Emoji row (horizontal scroll) | — |
| `#chat-react-fire-btn` 🔥, `#chat-react-raised-hands-btn` 🙌, `#chat-react-crying-btn` 😭, `#chat-react-see-no-evil-btn` 🙈, `#chat-react-folded-hands-btn` 🙏, `#chat-react-confounded-btn` 😖, `#chat-react-joy-btn` 😂, `#chat-react-heart-btn` ❤️, `#chat-react-thumbs-up-btn` 👍, `#chat-react-surprised-btn` 😮, `#chat-react-party-btn` 🎉 | Reaction buttons | `reactTo(emoji)` via `data-emoji` |
| `#chat-message-copy-btn` / `#chat-message-reply-btn` / `#chat-message-forward-btn` / `#chat-message-delete-btn` | Action rows | click routed by `data-action` |
| `#chat-forward-sheet-backdrop` / `#chat-forward-sheet` | Forward sheet dim layer / sheet | — |
| `#chat-forward-list` | Forward recipient list | — |
| Selector `.chat-forward-send[data-conv-id="<conversationId>"]` | Per-row Send button (generated) | `forwardTo(id, btn)` |
| `#chat-delete-backdrop` / `#chat-delete-dialog` / `#chat-delete-dialog-title` | Delete confirm layer / dialog / title | — |
| `#chat-delete-confirm-btn` / `#chat-delete-cancel-btn` | Confirm / cancel | `confirmDelete()` / `closeDeleteDialog()` |
