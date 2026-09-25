# Like Button Animation - Twitter/X Style Implementation

## Summary
Reworked the like button tap animation across all three contexts (feed posts, overlay post header, comment likes) to match Twitter/X's feel using CSS-only techniques with pseudo-element particle burst and scale overshoot animations.

## Changes Made

### 1. CSS Animations (Added to `<style>` section)

#### Heart Icon Structure
- Added `.like-icon-wrapper` container with `overflow: visible` to allow particle burst
- Implemented dual-heart system:
  - `.heart-outline` (stroke, no fill) - shown when unliked
  - `.heart-filled` (fill, no stroke) - shown when liked
- Hearts toggle visibility based on `data-liked` attribute

#### Animation States
- `.is-liking` class triggers:
  - `heartPop` keyframe: scale 0.8 → 1.15 → 1.0 with cubic-bezier(.17,.89,.32,1.49) over 400ms
  - `particleBurst` keyframe: 8 circular dots (box-shadow) burst outward and fade over 550ms
- `.is-unliking` class triggers:
  - `heartShrink` keyframe: simple scale down to 0.9 with opacity fade over 180ms

#### Count Animation
- `.like-count.count-changing` triggers `countChange` keyframe
- Subtle opacity + translateY(-2px) transition over 140ms

#### Particle Burst (::after pseudo-element)
- 8 red dots positioned via box-shadow
- Burst pattern: cardinal + diagonal directions (0°, 45°, 90°, 135°, 180°, 225°, 270°, 315°)
- Radius grows from 0 to 30px, opacity 1 to 0

#### Accessibility
- `@media (prefers-reduced-motion: reduce)` disables all animations
- Hearts still toggle, but instantly without animation

### 2. HTML Structure Updates

#### Feed Post Like Button
```html
<button class="like-btn ...">
  <span class="like-icon-wrapper">
    <svg class="heart-outline">...</svg>
    <svg class="heart-filled absolute inset-0">...</svg>
  </span>
  <span class="like-count">...</span>
</button>
```

#### Overlay Post Like Section
Same structure applied to the stats section (converted to clickable button at runtime)

#### Comment Like Button
Same structure applied to `.like-btn-comment`

### 3. JavaScript Updates

#### Feed Post Like Handler (line ~1280-1350)
- Get `iconWrapper`, `heartOutline`, `heartFilled` elements
- On like: add `.is-liking`, toggle colors, remove class after 550ms
- On unlike: add `.is-unliking`, toggle colors, remove class after 180ms
- Add/remove `.count-changing` on like count span with 140ms timeout

#### Overlay Post Like Handler (line ~1704-1830)
- Same animation logic as feed handler
- Syncs with feed card when updating

#### Comment Like Handler (line ~1831-1930)
- Same animation logic applied to comment likes
- Handles optimistic update + rollback on error

#### New Comment Rendering (line ~1648-1658)
- Updated `handleSendReply` to include new heart structure in dynamically added comments

### 4. Key Implementation Details

**Animation Timing:**
- Like burst: 550ms total (400ms scale + 550ms particle burst overlap)
- Unlike: 180ms simple fade/scale
- Count change: 140ms fade/translate

**State Management:**
- `.is-liking` / `.is-unliking` classes added on click
- Removed via setTimeout after animation duration
- Already-liked posts on page load show filled heart with no animation (no class)

**Particle Burst:**
- Single-color (#DA292E brand red) per requirements
- 8 particles in circular pattern
- box-shadow technique (Ana Tudor method) - no sprite, no SVG animation
- Only plays on like, not unlike

**Count Transition:**
- Applied to all three contexts via shared `.count-changing` class
- Prevents layout jump with inline-block display
- Subtle upward motion matches Twitter's feel

**Error Handling:**
- Rollback logic updated to handle outline/filled heart elements
- Animation classes removed on error to prevent stuck states

**Overflow:**
- `.like-icon-wrapper` has `overflow: visible` to prevent particle clipping
- Tested: no parent containers have conflicting `overflow: hidden`

## Testing Checklist

- [x] Feed post like: animation plays on like, not on unlike
- [x] Overlay post like: animation plays, syncs with feed card
- [x] Comment like: animation plays independently
- [x] Rapid double-tap: no stuck animation states
- [x] Already-liked posts: show filled heart, no animation on page load
- [x] Count transition: smooth fade/translate on all contexts
- [x] Particle burst: no clipping, proper radial spread
- [x] Scale overshoot: single bounce, settles at scale(1)
- [x] prefers-reduced-motion: animations disabled, instant toggle
- [x] Optimistic update + backend reconciliation: still works
- [ ] Mobile/desktop widths: visual confirmation needed
- [ ] Backend failure: rollback restores correct state

## Browser Compatibility
- CSS animations: all modern browsers
- box-shadow animation: all modern browsers
- cubic-bezier easing: all modern browsers
- prefers-reduced-motion: all modern browsers + graceful degradation
