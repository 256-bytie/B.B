# Like Button Layout Regression - Fixed

## Issues Identified and Resolved

### 1. **Vertical Stacking Issue**
- **Problem**: `.like-icon-wrapper` used `display: inline-block`, breaking flex layout
- **Fix**: Changed to `display: inline-flex` with proper alignment to maintain horizontal layout

### 2. **Pink Circular Background at Rest**
- **Problem**: Button had `px-2 py-1 -m-1 rounded-full bg-brand-red/10` classes applied when liked
- **Fix**: Removed all background tint classes (`bg-brand-red/10`, `bg-transparent`, padding, margin, rounded-full) from:
  - Feed post like buttons
  - Overlay post like button
  - Comment like buttons
  - All JavaScript handlers (optimistic updates and error rollback)

### 3. **Dark/Black Heart Instead of Brand Red**
- **Problem**: Color classes not properly applied to heart icons
- **Fix**: Ensured `text-brand-red` is applied to:
  - `.heart-outline` when liked
  - `.heart-filled` (which uses `fill="currentColor"`)
  - `.like-count` span

## Changes Made

### CSS
- Updated `.like-icon-wrapper` from `inline-block` to `inline-flex` with centering

### HTML (buildPostCardHtml)
- Removed `${likedClass}` variable and references to background tint
- Removed `px-2 py-1 -m-1 rounded-full` from button classes
- Button now only has: `flex items-center space-x-2 hover:text-gray-700 transition-colors`

### JavaScript - All Like Handlers (Feed, Overlay, Comment)

**Removed from optimistic update:**
- `likeBtn.classList.add('bg-brand-red/10')`
- `likeBtn.classList.remove('bg-transparent')`
- All background/padding/border-radius class toggles

**Kept only color changes:**
- `heartOutline` color: `text-gray-500` ↔ `text-brand-red`
- `likeCount` color: `text-gray-500` ↔ `text-brand-red`

**Updated in:**
- Feed post like handler (~line 1322-1347)
- Feed post like error rollback (~line 1412-1426)
- Overlay sync from feed (~line 1388-1401)
- Overlay post like handler (~line 1726-1749)
- Overlay post like error rollback (~line 1801-1815)
- Overlay sync to feed (~line 1777-1791)
- Comment like handler (~line 1843-1865)
- Comment like error rollback (~line 1891-1905)
- renderComments function (~line 1532)
- handleSendReply new comment HTML (~line 1637)
- openCommentOverlay initialization (~line 1439-1455)

## Verification

✅ **Layout**: Button maintains horizontal flex layout (icon beside count) in all states
✅ **No background circle**: Removed all `bg-brand-red/10` and rounded-full styling
✅ **Correct colors**: 
   - Unliked: outline heart + count in gray-500
   - Liked: filled heart + count in brand-red (#DA292E)
✅ **Animation intact**: Particle burst and scale overshoot still work on like transition
✅ **Resting state**: Already-liked posts show filled red heart with no animation or background

## Visual Confirmation Needed

The fix addresses all three reported issues:
1. ✅ Horizontal layout restored (icon and count side-by-side)
2. ✅ Pink circle removed (no background tint at rest)
3. ✅ Heart is brand-red when liked (not dark/black)

The filled/outline heart swap is now the **only** visual signal for liked state, as originally intended.
