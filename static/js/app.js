// ---- App bootstrap ----
// Runs after all other modules are loaded: kicks off session check
// (which drives the initial view).
//
// NOTE: the compose FAB's show/hide behavior used to be driven by its own
// independent scroll listener here, with its own direction/threshold/idle
// logic. That ran completely disconnected from the feed header's own
// accumulated-delta show/hide logic (see initFeedHeaderAutoHide in
// feed.js), so the two would trigger at different scroll positions and
// drift out of sync. The FAB is now toggled directly alongside
// `header-hidden` inside feed.js itself - same trigger, same instant -
// so there's nothing left to wire up here.

// Initialize
checkSession();
