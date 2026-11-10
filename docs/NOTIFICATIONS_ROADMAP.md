# Notifications — Phased Roadmap and Backend Requirements (Parts 3 and 4)

Status key: **BUILT** = in the repo now. **EXISTS** = backend event/data already exists, only notification work missing. **NEW** = requires new backend work.

## Status today
| Piece | Status |
|---|---|
| Notification screen (loading / empty / error / list, read vs unread, mark-all-read, pagination UI, type registry) — `templates/partials/notifications.html`, `static/js/notifications.js`, CSS block, `showView` wiring, feed bell + conditional badge | **BUILT** |
| `GET /api/notifications`, `POST /api/notifications/read`, `notifications` table, Phase 1 and Phase 2 event generation and read-time like aggregation | **BUILT** |

## Phase 1 — Core (**BUILT**)
| Type | Trigger | Recipient | Payload | Backend hook | Depends on | Priority |
|---|---|---|---|---|---|---|
| `follow` | `toggle_follow` inserts a follow | followee | actor | after INSERT in `user_service.toggle_follow` (only when `following` becomes true) | `follows` | P0 |
| `post_comment` | `create_comment`, no parent | post author (not self) | actor, post id, comment snippet, post snapshot | after INSERT in `post_service.create_comment` | `comments`, `posts` | P0 |
| `comment_reply` | `create_comment` with parent | parent comment author (not self) | actor, post id, comment id, snippet, snapshot | same | `parent_comment_id` | P0 |
| `post_like` | like inserted in `_toggle_like` (target_type `post`) | post author (not self) | actor, post id, post snippet, snapshot | after the successful INSERT branch | `likes` | P0 |

Frontend: nothing further (types already registered in `NOTIFICATION_TYPES`).

## Phase 2 — Additional social interactions (**BUILT**)
| Type / behavior | Trigger | Recipient | Payload | Backend status | Priority |
|---|---|---|---|---|---|
| `comment_like` | like on a comment | comment author (not self) | actor, comment snippet, parent post snapshot | **BUILT** in `_toggle_like` for `comment` | P1 |
| `post_quote` | `create_post` with `quoted_post_id` | original author (not self) | actor, new quote post id and snapshot | **BUILT** in `create_post` | P1 |
| Like aggregation | multiple likes on one target | target author | newest actor plus `others_count` | **BUILT** at read time for `post_like` and `comment_like` | P1 |
| `community_join` | member joins | community creator and moderators (not self) | actor, community `{slug, name}` | **BUILT** on first successful join | P2 |

## Phase 3 — Advanced
| Type | Notes | Backend work | Priority |
|---|---|---|---|
| `mention` | **BUILT**: posts and comments parse up to ten distinct `@handle` mentions case-insensitively; mention delivery takes precedence over quote/comment/community events | Write-time parser and batched username resolution | P2 |
| `repost` | Repost is not built | NEW feature first | P3 |
| `community_post` | **BUILT**: `all` members are notified on creation; `popular` members are notified when the post reaches five likes; `off` and `muted` are excluded | Batched fan-out with per-post dedupe and precedence suppression | P3 |
| `monthly_credits` | **BUILT**: lazily materialized on notification reads when claimable, with a nullable actor and stable last-claim dedupe key; successful claims clear pending rows | Read-time persistence and claim cleanup | P3 |
| Push / email / realtime | Out of scope until in-app is proven. Prefer polling `unread_count`; SSE/long-poll only if needed (long-poll infra exists in `chat_service`, single-process) | NEW | P3 |
| Per-type user preferences | Settings → Notifications is a stub | NEW table + settings UI | P3 |
| Retention purge | No automatic deletion policy is implemented | NOT BUILT | P3 |

### Phase 3 decisions
1. Notification types in scope are `mention`, `community_post`, and system `monthly_credits`; repost, push/email/realtime delivery, per-type preferences, and retention purge remain not built.
2. Mention matching uses `(?<![A-Za-z0-9_.@])@([A-Za-z0-9_.]{1,30})`; trailing periods are stripped, handles are lowercased, encounter order is preserved, duplicates are removed, and resolution is capped at ten handles.
3. Mention handles resolve at create time only against `users.username`, case-insensitively via `LOWER(username) = ANY(...)`; posts and comments have no edit endpoints.
4. There is one row per recipient and content item. Post precedence is mention, then `post_quote`, then `community_post`; comment precedence is mention, then `post_comment` or `comment_reply`. Self mentions and unknown handles are ignored.
5. `community_post` respects `community_members.notification_level`: `all` is generated at post creation, `popular` is generated exactly when the post's like count first reaches `POPULAR_LIKE_THRESHOLD = 5`, and `off`/`muted` never generate this type. `muted` affects only `community_post`.
6. Monthly-credit rows are computed on notification reads and persisted lazily, with no scheduler. They use `monthly_credits:<UTC-last-claim-ISO-or-never>`, have no actor or target, and are removed in the successful wallet claim transaction. Unlike keeps existing rows.

### Phase 3 frontend follow-ups: DONE
Registered `mention`, `community_post`, `monthly_credits`; actor-less rows render as a coloured tile with a title; `community_post` shows the community name; `monthly_credits` opens the wallet.

## Backend requirements (foundation for implementation prompts)

### Data model (`migrations/pg/006_notifications.sql`, next number after 005)
```
notifications
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
  recipient_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  actor_id      BIGINT REFERENCES users(id) ON DELETE CASCADE   -- NULL for system types
  type          TEXT NOT NULL                                     -- no CHECK: new types need no migration
  target_type   TEXT                                              -- 'post' | 'comment' | 'user' | 'community' | NULL
  target_id     BIGINT                                            -- polymorphic, no FK (same convention as likes)
  post_id       BIGINT                                            -- context for opening the post; no FK, resolved at read
  read_at       TIMESTAMPTZ                                       -- NULL = unread
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  dedupe_key    TEXT NOT NULL
  UNIQUE (recipient_id, dedupe_key)
INDEX (recipient_id, id DESC)                 -- keyset list
INDEX (recipient_id) WHERE read_at IS NULL    -- unread count
```
Store IDs, not rendered text or snippets: snippets and the post snapshot are produced at read time from live rows, so edits, deletions and privacy changes are honored. `read_at` instead of a boolean keeps history. Like aggregation retains one notification row per actor; it is computed from those rows at read time, so it needs no `actor_count` column or schema migration.

### Event generation
- Single Flask-free function `notification_service.create(cursor, recipient_id, actor_id, type, target_type, target_id, post_id)` called **inside the triggering transaction, before `conn.commit()`**, so rollbacks leave nothing.
- Always skip `recipient_id == actor_id`.
- Insert with `ON CONFLICT (recipient_id, dedupe_key) DO NOTHING`.
- Notification failure must not fail the like/comment/follow: wrap in a savepoint and log.

### Duplicate prevention
- `dedupe_key` = `type:actor:target_type:target_id`. Re-like after unlike, or re-follow, hits the conflict and creates nothing. Comments/replies are unique per comment id, so each is notified once.
- Unlike/unfollow: leave the notification. The dedupe key prevents a later relike or refollow from creating another row.
- Reply to a comment on your own post: one notification (`comment_reply`), not two.

### Read / unread
- `POST /api/notifications/read` body `{ids:[...]}` or `{all:true}`: `UPDATE … SET read_at = now() WHERE recipient_id = session user AND read_at IS NULL [AND id = ANY(...)]`. Idempotent. Returns `{unread_count}`. Ownership is enforced by the `recipient_id` predicate, so foreign ids are silently ignored.
- `unread_count` computed with `COUNT(*)` at read time (same no-drift rule as `member_count` and the wallet ledger). No counter column.

### Retrieval and pagination
- `GET /api/notifications?limit=&cursor=` — login required, `Cache-Control: no-store`, limit clamped to [1, 50] (default 20), keyset `id < cursor ORDER BY id DESC`, response `{notifications, next_cursor, unread_count}` — matches `/api/wallet/transactions` and `/api/posts`.
- Hydration in batched queries (no N+1): actors via `serialize_user_public`-style fields (`id, full_name, handle, profile_picture`), post snapshots via the existing batched post pipeline, comment snippets by id.
- Drop rows whose target no longer exists or is no longer visible to the recipient (deleted post, left private community) at read time. Add `ON DELETE` cleanup in `delete_post` / `delete_comment` for tidiness.
- Item shape is the one documented at the top of `static/js/notifications.js`. Phase 2 adds `others_count` (integer, defaults to `0`) and `community` (`{slug, name}` for community notifications, otherwise `null`).
- Like aggregation is applied after visibility filtering and before pagination. The keyset cursor and limit apply to grouped representative rows; `unread_count` counts visible display groups. Marking an aggregate representative read marks all rows in that recipient's matching group.
- The visibility predicate uses `IS DISTINCT FROM` for nullable target types and checks current community membership for community-targeted notifications. Private-community post notifications are also visible only while the recipient remains a member.

### Ownership and security
- Every query is scoped by `session['user_id']`; there is no endpoint that accepts a recipient id.
- Mutating route goes through the existing CSRF middleware (the screen uses `apiFetch`).
- Re-run `can_view` against the snapshot post for the recipient on read.

### Extensibility
- New type = one `type` string + one hook call + one entry in `NOTIFICATION_TYPES` (frontend). Unknown types already render as a generic row.
- Keep the generator (`notification_service`) separate from delivery. Push/email/realtime attach later as consumers of the same inserts; they are not part of Phase 1.
- Tests: add `tests/test_notifications.sh` following `tests/test_follows.sh` conventions (self-notify suppressed, dedupe on re-like, ownership isolation, pagination, mark-read idempotency, deleted-post filtering).

### Phase 2 decisions
1. Aggregation is computed at read time from per-actor notification rows; no actor-count column or write-time collapse is used.
2. Only `post_like` and `comment_like` aggregate. They remain separate by type and target.
3. Unlike keeps notification rows, so `others_count` can include people who later unliked.
4. `community_join` notifies the community creator and moderators, regardless of `notification_level`; the joining actor is skipped as a self-notification.
5. `post_quote` targets the newly created quote post and includes that post's snapshot.
6. Visibility uses `IS DISTINCT FROM` for nullable target types and a community membership clause so notifications for community targets are hidden when the recipient is no longer a member.
7. Notification items add `others_count` (integer, default `0`) and `community` (`{slug, name}` for community notifications; otherwise `null`).

### Frontend follow-ups: DONE
Registered `comment_like`, `post_quote`, `community_join`; aggregated likes render as "A and N others"; `community_join` opens the community by `community.slug`; the bell dot is refreshed from `unread_count` (`refreshNotificationBadge`) whenever the feed is shown, after an account switch, and when the app returns to the foreground (30 s throttle).

### Frontend screen (static/js/notifications.js)
- Rows are grouped under Today / This week / Earlier by the viewer's local calendar day (`notifGroupItems`). A header summarises unread ("You have 3 unread notifications" / "You're all caught up").
- Row layout: unread dot + tint, avatar with a small type badge, headline `Name [and N others] verb <accent object>`, optional one-line preview, relative time, optional right-hand thumbnail (first image of the post snapshot).
- Back from a community or wallet opened from a notification returns to the list (`'notifications'` is in `COMMUNITY_RETURN_VIEWS` and `WALLET_RETURN_VIEWS`).
- Checks: `tests/test_notifications_ui.sh` (Node; skips when Node is missing).
- Known gap: the bell refresh calls `GET /api/notifications?limit=1`, which also runs the list query. A dedicated count-only endpoint would be cheaper if polling is added.

### Phase 1 decisions
1. Post snapshots are embedded in notification responses. No `GET /api/posts/<id>` endpoint was added.
2. Unlike and unfollow keep existing notifications. The dedupe key prevents re-notification after relike or refollow.
3. Replies notify only the parent comment author as `comment_reply`. Top-level comments notify only the post author as `post_comment`.
4. Every event skips notification when recipient and actor are the same user.
5. Retention purge is outside Phase 1.
