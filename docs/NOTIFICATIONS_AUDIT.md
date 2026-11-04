# Notifications — Feed Audit (Part 2)

Verified against the codebase (PostgreSQL, `app/`), not assumed. "Event exists" = the backend already performs a write that a notification could hang off. **No notification storage, endpoint, or delivery exists today.**

## Pre-existing notification-adjacent code
| Item | State |
|---|---|
| Feed header bell (`templates/partials/feed.html`) | Was a dead button with a hardcoded, always-visible red dot. Now opens the screen; dot is hidden unless unread > 0. |
| `community_members.notification_level` (`off/all/popular/muted`) + `PUT /api/communities/<slug>/notifications` + bell menu in `community.js` | A stored per-member preference with **no consumer**. Nothing reads it. Usable later for community-post notifications. |
| Settings → Notifications | "Coming soon" toast. |
| `chat_service.notify_updates()` | Unrelated: in-process condition variable that wakes DM long-polls. Not a notification system. |
| Bottom nav | Has 5 tabs (Home/Search/Compose/Chat/Profile). `CLAUDE.md` claimed a Notifications tab; it does not exist. Corrected in `CLAUDE.md`. |

## Interaction inventory
| Interaction | Exists? | Where | Data available at the event | Notes for notifications |
|---|---|---|---|---|
| Post like | Yes | `post_service.toggle_post_like` → `_toggle_like`, `POST /api/posts/<id>/like` | actor id, post id, `likes` row (`created_at`) | Recipient = `posts.user_id`. Unlike deletes the row, so like→unlike→like re-inserts: **needs duplicate prevention**. Skip self-likes. |
| Comment like | Yes | `toggle_comment_like`, `POST /api/comments/<id>/like` | actor, comment id (→ post id) | Recipient = `comments.user_id`. Same toggle caveat. |
| Dislike (comment) | Yes | `dislikes` table | actor, comment | Never notify. |
| Comment on post | Yes | `post_service.create_comment`, `POST /api/posts/<id>/comments` | comment id, post id, actor, content, image | Recipient = post author when `parent_comment_id IS NULL`. Skip self. |
| Reply to comment | Yes | same function, `parent_comment_id` | parent comment id → parent author | Recipient = parent comment author. If that user is also the post author, send one notification, not two. |
| Follow | Yes | `user_service.toggle_follow`, `POST /api/users/<id>/follow` | follower, followee, `follows.created_at` | Recipient = followee. Toggle re-follow needs dedupe. Rate-limited already (`_check_follow_rate_limit`). |
| Quote post | Yes | `create_post(quoted_post_id=…)` | new post id, quoted post id/author | Recipient = original author. Original may be in a community (access already checked by `_validate_quote_target`). |
| Repost (no comment) | **No** | Share sheet shows "Coming soon" | — | Cannot notify. |
| Mentions (`@handle`) | **No** | `@handle` is display-only; no parsing in compose, `post_service`, or `create_comment` | — | Needs handle extraction + resolution at write time. |
| Community join | Yes | `community_service` join, `POST /api/communities/<slug>/join` | member, community | Recipient = creator/moderators (optional, low value). |
| Community post | Yes | `POST /api/communities/<slug>/posts` | post, community | Fan-out to members gated by existing `notification_level`. Highest fan-out cost. |
| Direct message | Yes | `chat_service`, `/api/chat/*` | message, conversation, read cursors | Already has its own unread model (`conversation_reads`). Keep out of the notification list; surface via Chat tab. |
| Post/comment deleted | Yes | `delete_post`, `delete_comment` | — | Must remove or invalidate related notifications (see roadmap). |
| Highlights | Yes (own profile) | `/api/highlights` | — | No social event. |
| Wallet credits | Yes | `app/wallet.py` | monthly claim available | System notification candidate (Phase 3). |
| Blocks / mutes | **No** | — | — | No suppression mechanism exists; recipient-side filtering must be simple until one does. |

## Structural findings that constrain the design
1. **No `GET /api/posts/<id>`.** The post overlay is fed from a post object (`openCommentOverlay`). A tap on a post-type notification therefore needs either the new endpoint or a `post` snapshot (serialize_post shape) in the notification payload. The screen supports the snapshot and shows "This post is no longer available" if absent.
2. **Counters are denormalized** (`like_count`, `comment_count` on posts/comments). Notifications must not become a second source of truth for counts.
3. **`likes` is polymorphic** (`target_type`, `target_id`, no FK). Notifications should reuse that shape (`target_type`, `target_id`) rather than inventing per-type columns.
4. **Single-process assumptions.** DM long-poll signalling and rate limiters are in-process. Anything real-time for notifications would inherit this; polling avoids it.
5. **Write paths commit inside service functions** (`conn.commit()`). The notification insert must join the same transaction as the triggering write, so a rolled-back like never leaves a notification.
6. **Visibility rules** (`_check_post_access`, community types) already gate who may interact. Recipients must be re-checked at read time (a user who left a private community must not keep seeing its post snapshots).
