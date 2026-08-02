# Wavelengthz — Project Plan (v3)

Music-taste matching app. Users log in with Spotify, then swipe in two modes —
on **people** (photos/profiles) and on **songs/artists** (taste-building) — with
matching driven by shared music taste and geography. Includes a growing,
searchable artist/track catalog, messaging, and the trust & safety, legal, and
operational groundwork a real dating product needs. Built mobile-first on
Cloudflare Workers + D1, with a path to a native app later.

---

## 1. Goal (expanded scope)

- Real Spotify OAuth login (Authorization Code flow)
- Pull each user's top artists/tracks/genres after login
- **Two swipe modes:**
  - **People mode** — swipe on other users' photos/profiles
  - **Music mode** — swipe on artists/songs to build a richer taste graph
    (like/dislike, independent of what Spotify already knows about you)
- **Artist/track catalog:**
  - Seeded with ~50 top artists across a spread of genres at launch
  - Searchable (via Spotify's catalog search) so users can find any artist
  - Users can **add** artists/tracks not yet in the system, growing the catalog
    organically over time
- Match scoring blends: Spotify listening data + explicit swipe signal from
  Music mode + mutual right-swipes in People mode + geographic proximity
- Like-priority queue: people who've already liked you surface first (§7.1)
- History page: view past swipes (both modes), undo/change any decision
- Basic **messaging** between matches (§7.3)
- **Trust & safety**: block, report, unmatch, account/data deletion (§9)
- Transactional-only notifications via email — matches and messages, never
  engagement bait (§10)
- Mobile-first responsive web app (works great in mobile browser), structured
  so a React Native / Capacitor wrapper is a light lift later, not a rewrite
- All data in Cloudflare D1 (SQL), cleanly queryable

Out of scope for v1 build: payments, native app binaries, automated photo
content moderation (flag manually for v1, automate later), push notifications
(email only until a native app exists to hold push permissions).

---

## 2. Architecture

```
┌───────────────────────┐      ┌──────────────────────┐      ┌───────────────┐
│  Browser (mobile-first │◄────►│  Cloudflare Worker    │◄────►│  Cloudflare   │
│  responsive SPA)       │      │  (API + OAuth + auth) │      │  D1 (SQLite)  │
└───────────────────────┘      └──────────┬───────────┘      └───────┬───────┘
                                           │                          │
                                           ▼                          ▼
                                ┌──────────────────────┐   ┌───────────────────┐
                                │   Spotify Web API     │   │  Cloudflare R2     │
                                │ (OAuth, top artists,   │   │  (user photos)     │
                                │  search catalog)       │   └───────────────────┘
                                └──────────────────────┘
```

New pieces vs. v1: **Cloudflare R2** for photo storage, since D1 shouldn't
hold binary blobs — Worker issues signed upload URLs directly to R2 and
stores the resulting object key in D1. Also add an error-tracking service
(e.g. Sentry) wired into the Worker for operational visibility (§11).

---

## 3. Data model (D1 / SQLite)

```sql
-- Core user record
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  spotify_id        TEXT UNIQUE NOT NULL,
  display_name      TEXT,
  bio               TEXT,
  date_of_birth     TEXT,             -- ISO date; source of truth for age gating
  age_verified_at   INTEGER,          -- null until 18+ confirmed at onboarding
  location_label    TEXT,             -- city/region, human readable
  lat               REAL,
  lng               REAL,
  max_distance_km   INTEGER DEFAULT 80,  -- candidate search radius, user-adjustable
  email             TEXT,
  access_token      TEXT NOT NULL,    -- encrypted at rest
  refresh_token     TEXT NOT NULL,    -- encrypted at rest
  token_expires_at  INTEGER NOT NULL,
  onboarded_at      INTEGER,          -- null until profile setup complete
  deleted_at        INTEGER,          -- soft-delete marker; hard-delete job purges after grace period
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- People-mode profile photos, ordered
CREATE TABLE user_photos (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  r2_key      TEXT NOT NULL,
  position    INTEGER NOT NULL,     -- display order, 0 = primary
  created_at  INTEGER NOT NULL
);

-- Cached Spotify-derived music profile
CREATE TABLE music_profiles (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  top_artists     TEXT NOT NULL,   -- JSON [{artist_id, rank}, ...]
  top_tracks      TEXT NOT NULL,   -- JSON [{track_id, rank}, ...]
  top_genres      TEXT NOT NULL,   -- JSON ranked genre strings
  time_range      TEXT NOT NULL,   -- short_term | medium_term | long_term
  refreshed_at    INTEGER NOT NULL
);

-- The growing artist catalog (seeded + user-added)
CREATE TABLE artists (
  id              TEXT PRIMARY KEY,     -- Spotify artist ID when known
  name            TEXT NOT NULL,
  genres          TEXT NOT NULL,        -- JSON array of genre strings
  image_url       TEXT,
  popularity      INTEGER,              -- Spotify popularity 0-100, if known
  source          TEXT NOT NULL,        -- 'seed' | 'spotify_search' | 'user_added'
  added_by_user_id TEXT REFERENCES users(id),  -- null if seeded
  approved        INTEGER NOT NULL DEFAULT 1,  -- 0 = pending review
  created_at      INTEGER NOT NULL
);

-- Track catalog, same pattern as artists
CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,     -- Spotify track ID when known
  name            TEXT NOT NULL,
  artist_id       TEXT NOT NULL REFERENCES artists(id),
  album_image_url TEXT,
  preview_url     TEXT,                 -- 30s preview, if Spotify provides one
  source          TEXT NOT NULL,
  added_by_user_id TEXT REFERENCES users(id),
  approved        INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

-- Session cookie -> user mapping
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- People-mode swipes (user on user)
CREATE TABLE people_swipes (
  id            TEXT PRIMARY KEY,
  swiper_id     TEXT NOT NULL REFERENCES users(id),
  target_id     TEXT NOT NULL REFERENCES users(id),
  direction     TEXT NOT NULL CHECK (direction IN ('left','right')),
  match_score   REAL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(swiper_id, target_id)
);

-- Music-mode swipes (user on artist OR track)
CREATE TABLE music_swipes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  item_type     TEXT NOT NULL CHECK (item_type IN ('artist','track')),
  item_id       TEXT NOT NULL,          -- artists.id or tracks.id
  direction     TEXT NOT NULL CHECK (direction IN ('left','right')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, item_type, item_id)
);

-- Mutual right-swipes in people mode
CREATE TABLE matches (
  id            TEXT PRIMARY KEY,
  user_a_id     TEXT NOT NULL REFERENCES users(id),
  user_b_id     TEXT NOT NULL REFERENCES users(id),
  unmatched_at  INTEGER,           -- null while active; set on unmatch, never hard-deleted
  unmatched_by  TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  UNIQUE(user_a_id, user_b_id)
);

-- Messages within an active match
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id),
  sender_id   TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);

-- One-directional blocks; a block always also ends any existing match
CREATE TABLE blocks (
  id          TEXT PRIMARY KEY,
  blocker_id  TEXT NOT NULL REFERENCES users(id),
  blocked_id  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE(blocker_id, blocked_id)
);

-- User reports for moderation review
CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT NOT NULL REFERENCES users(id),
  reported_id   TEXT NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,      -- fixed set of reasons in the UI, not freeform-only
  details       TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','actioned','dismissed')),
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);

-- Transactional notifications only (matches, messages) -- see §10
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),   -- recipient
  type          TEXT NOT NULL CHECK (type IN ('match','message')),
  related_id     TEXT NOT NULL,      -- matches.id or messages.id
  email_sent_at  INTEGER,            -- null until the email actually goes out
  read_at        INTEGER,            -- null until seen in-app
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_people_swipes_swiper ON people_swipes(swiper_id, created_at DESC);
CREATE INDEX idx_people_swipes_target ON people_swipes(target_id, direction, created_at DESC);
CREATE INDEX idx_music_swipes_user ON music_swipes(user_id, created_at DESC);
CREATE INDEX idx_artists_name ON artists(name);
CREATE INDEX idx_tracks_artist ON tracks(artist_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_messages_match ON messages(match_id, created_at);
CREATE INDEX idx_blocks_blocker ON blocks(blocker_id);
CREATE INDEX idx_reports_status ON reports(status, created_at);
CREATE INDEX idx_users_location ON users(lat, lng);
```

Design notes:
- Splitting `people_swipes` and `music_swipes` into separate tables (rather than
  one polymorphic table) keeps queries simple and indexes tight — you'll query
  each far more often than you'll query "all swipes of any kind."
- `artists`/`tracks` `source` + `approved` fields let you seed confidently,
  accept Spotify-search adds automatically (since they're verified real
  artists), and optionally hold fully custom/unverifiable entries for review.
- `UNIQUE` constraints on swipe tables mean "changing a swipe" is an `UPDATE`,
  keeping history clean and history edits trivial.
- `idx_people_swipes_target` is the index the like-priority queue (§7.1) leans
  on — it needs to quickly answer "who has already swiped right on *me* that
  I haven't swiped on yet."
- `matches.unmatched_at` is a soft-end, not a delete — keeps the message
  history intact for moderation/report review, but the app treats an
  unmatched pair as inactive everywhere (no more messaging, drops out of
  candidate pools permanently).
- `blocks` is checked in candidate queries in both directions — a blocked user
  never sees the blocker again, and vice versa, regardless of who blocked whom.
- `users.deleted_at` is a soft-delete marker used to immediately stop showing
  a user anywhere in the app; a scheduled job then hard-deletes the row
  (including encrypted tokens) after a short grace period, satisfying
  Spotify's data-deletion requirement (§8) without an accidental-deletion
  footgun.
- `notifications` intentionally has no "type" values beyond `match` and
  `message` — see §10 for why that's a hard constraint, not just a v1 gap.

---

## 4. Catalog seeding & growth strategy

**Seed set (~50 artists):** pull a spread across genres (pop, hip-hop, indie,
r&b, country, electronic, latin, rock, k-pop, classical/jazz crossover, etc.)
using Spotify's `/search` endpoint at build time, store into `artists`. Include
a handful of top tracks per artist into `tracks`.

**Growth via search-and-add:**
- User searches for an artist not yet in the catalog
- Worker calls Spotify `/v1/search?type=artist` live
- If found: insert into `artists` with `source = 'spotify_search'`, `approved = 1`
  (auto-approved since it's a verified real Spotify entity)
- Track-level: same pattern via `/v1/search?type=track`, scoped to a chosen artist
- This means the catalog self-expands with zero manual curation, since every
  addition is validated against Spotify's real catalog — no risk of junk data
  unless you later open up fully freeform entries

**Growth via periodic refresh:** a scheduled Worker (Cron Trigger) periodically
re-pulls each user's `/me/top/artists` and folds any new artists into the shared
catalog automatically, so the pool grows passively just from people using the app.

---

## 5. Spotify OAuth flow

Same as prior plan — Authorization Code flow, `user-top-read` scope minimum.
Add scope `user-read-email` if you want email captured directly from Spotify
rather than asking during onboarding.

---

## 6. API routes

| Route                          | Method | Purpose                                          |
|----------------------------------|--------|----------------------------------------------------|
| `/login`                         | GET    | Kick off Spotify OAuth                             |
| `/callback`                       | GET    | OAuth redirect target                              |
| `/logout`                         | POST   | Clear session                                      |
| `/api/me`                         | GET    | Current user + music profile                       |
| `/api/onboarding`                  | POST   | Save bio/DOB/location/photos after first login     |
| `/api/photos`                      | POST   | Get signed R2 upload URL, save photo record        |
| `/api/photos/:id`                  | DELETE | Remove a photo                                     |
| `/api/candidates/people`           | GET    | Next batch of people to swipe on, pre-scored       |
| `/api/candidates/music`            | GET    | Next batch of artists/tracks to swipe on           |
| `/api/swipe/people`                | POST   | `{target_id, direction}`                            |
| `/api/swipe/music`                 | POST   | `{item_type, item_id, direction}`                   |
| `/api/swipes/people`               | GET    | People-swipe history                               |
| `/api/swipes/people/:id`            | PATCH  | Change a past people-swipe                          |
| `/api/swipes/music`                | GET    | Music-swipe history                                |
| `/api/swipes/music/:id`             | PATCH  | Change a past music-swipe                           |
| `/api/matches`                     | GET    | Mutual matches                                      |
| `/api/matches/:id/unmatch`          | POST   | End a match                                        |
| `/api/matches/:id/messages`         | GET    | Message history for a match                        |
| `/api/matches/:id/messages`         | POST   | Send a message `{body}`                             |
| `/api/artists/search?q=`            | GET    | Search catalog; falls through to live Spotify search |
| `/api/artists`                     | POST   | Add artist to catalog (validated against Spotify)   |
| `/api/tracks/search?q=&artist_id=`   | GET    | Search tracks, scoped to an artist                  |
| `/api/tracks`                      | POST   | Add track to catalog                                |
| `/api/notifications`                | GET    | Current user's notifications (match/message only)   |
| `/api/notifications/:id/read`        | POST   | Mark a notification as read                          |
| `/api/block`                       | POST   | `{user_id}` — block a user, ends any active match   |
| `/api/report`                      | POST   | `{user_id, reason, details}`                        |
| `/api/account`                      | DELETE | Soft-delete current account (§9)                     |

---

## 7. Match scoring (v3)

Blend signals rather than relying on one:

```
final_score =
    0.35 * spotify_overlap(userA, userB)     -- shared real listening data
  + 0.30 * music_swipe_overlap(userA, userB) -- shared right-swipes in Music mode
  + 0.15 * mutual_interest_boost             -- +boost if both already swiped
                                                 right on each other's photos
  + 0.20 * proximity_score(userA, userB)     -- closer = higher, within radius
```

`spotify_overlap` and `music_swipe_overlap` use a weighted-Jaccard style
formula applied to two different signal sets. Music-mode swipes are valuable
because they capture *current* taste and intentional signal, not just
historical listening — someone might listen to a lot of one genre passively
but actively swipe right on artists they're more excited about.

### 7.1 Like-priority queue

`/api/candidates/people` doesn't just return candidates in taste-score order —
it also boosts anyone who has **already swiped right on the current user** to
the top of the queue. Mechanically:

1. Query `people_swipes` for rows where `target_id = current_user` AND
   `direction = 'right'` AND there's no existing row where
   `swiper_id = current_user AND target_id = <that person>` (i.e., the current
   user hasn't decided on them yet). This is what `idx_people_swipes_target`
   (§3) is built for.
2. That set is injected at the **front** of the candidate queue, ranked by
   `match_score` among themselves (not just recency), then the normal
   taste-scored pool continues after.
3. This directly raises match likelihood for whoever sent the like, since
   they're surfaced sooner rather than sitting buried in a chronological or
   random feed.
4. Blocked users (§9) and unmatched pairs (§3) are excluded from this query
   entirely, at the SQL level, not filtered client-side.

No UI change required beyond the queue ordering itself — whether to *also*
visually flag "this person liked you" in the card is a separate, optional
decision for later (and one with its own tradeoffs, since it nudges behavior
rather than just surfacing it neutrally).

### 7.2 Geolocation & distance matching

- `users.lat`/`users.lng` store the user's location; `max_distance_km`
  (default 80km) is user-adjustable and controls candidate radius.
- Distance is computed with the haversine formula in `lib/scoring.ts` —
  cheap enough to run per-candidate at query time for a catalog this size;
  a geospatial index isn't needed until the user base is much larger.
- `/api/candidates/people` filters to users within `max_distance_km` **before**
  scoring, not after — no point taste-scoring someone who's out of range.
- **Privacy:** never expose precise coordinates to other users, in the API
  response or the UI. Show a rounded, bucketed distance instead ("3 miles
  away," "12 miles away") — this is standard practice across dating apps
  specifically because exact coordinates make a person's home/workplace
  triangulatable from a few sessions.
- Location is captured via browser geolocation at onboarding (with a manual
  city-entry fallback for anyone who declines the permission prompt), stored
  as `location_label` for display and `lat`/`lng` for scoring.

### 7.3 Messaging

- Scoped strictly to **active matches** — no messaging path exists between
  users who haven't matched, and it's cut off automatically the moment a
  match is unmatched or either party blocks the other.
- `POST /api/matches/:id/messages` validates the match is active
  (`unmatched_at IS NULL`) and that the sender is one of the two match
  participants before inserting.
- Triggers a `notifications` row of `type = 'message'` for the recipient,
  which follows the same transactional-only email rule as everything else
  (§10) — no "someone sent you a message, but you need to open the app to
  see who" bait, the email can simply say a new message arrived.
- v1 is text-only, no read receipts beyond the existing `read_at` timestamp
  (which drives in-app unread state, not a "seen" indicator visible to the
  sender — that's a deliberate product choice you can revisit later, not an
  oversight).

---

## 8. Legal & compliance

These gate a real launch; they don't block a Claude Code prototype build, but
should be resolved before real users' data flows through the app.

- **Privacy policy + Terms of Service.** Required — Spotify's Developer Terms
  make a privacy policy a condition of API access (§8 in the earlier policy
  review), separate from any dating-specific legal requirement.
- **Age verification / 18+ gate.** `users.date_of_birth` + `age_verified_at`
  (§3) back a hard block at onboarding: computed age under 18 prevents
  account creation entirely, not just a warning.
- **Spotify data deletion compliance.** Spotify's Developer Policy requires
  deleting a user's personal data when they disconnect their account or
  otherwise revoke access — the `deleted_at` soft-delete + scheduled
  hard-delete job (§3) is what satisfies this, and it needs to actually purge
  the encrypted `access_token`/`refresh_token` values, not just flag the row.
- **GDPR/CCPA exposure.** Applies the moment any EU or California user signs
  up, not just if you intend an international launch. The deletion flow above
  covers "right to be forgotten"; a data-export endpoint is a reasonable
  follow-up if you expect EU users early.
- **App store dating-category requirements**, relevant once a native wrapper
  exists: Apple specifically requires block/report functionality and a way to
  handle harassment complaints for any app in the dating category — the
  `blocks`/`reports` tables (§3) are built with this in mind now, not
  retrofitted later.

---

## 9. Trust & safety

- **Block.** One-directional (`blocks` table, §3), but enforced bidirectionally
  in every candidate/message query — a block always also ends any existing
  match between the two users.
- **Report.** Fixed reason categories in the UI (not a freeform box alone),
  routed to a `reports` table with a review status. v1 doesn't need a full
  admin dashboard — even a simple authenticated query against `reports WHERE
  status = 'open'` is enough to start, with a proper review UI as a fast
  follow.
- **Unmatch.** Distinct from block: ends the match and messaging, but doesn't
  prevent the other person from reappearing in future candidate pools (unlike
  a block, which is permanent). `matches.unmatched_at`/`unmatched_by` (§3)
  preserve the record rather than deleting it, primarily so a subsequent
  report on the same person has context to review.
- **Fake-profile / bot mitigation.** Given the pattern you flagged early on
  with competitor apps: rate-limit account creation per IP/device at the Worker
  level, rate-limit swipes per session (already in the performance plan, §12
  in the prior version), and consider a lightweight photo-liveness or manual
  review step before a profile is visible to others at real scale. Not
  necessary for a Claude Code prototype, but worth designing the `users` table
  (it already has `onboarded_at`) so a future `verified_at` column is a small
  addition, not a restructure.
- **Account & data deletion.** `DELETE /api/account` sets `users.deleted_at`
  immediately (user disappears from all candidate pools, matches, and search
  right away), with a scheduled Worker job hard-deleting the row and all
  associated photos (R2 objects), swipes, and messages after a short grace
  period — long enough to let someone recover from an accidental deletion,
  short enough to stay compliant with Spotify's and GDPR's deletion timelines.

---

## 10. Notifications: transactional only, no engagement bait

Hard product constraint, not just a v1 scope cut: notifications exist to tell
someone something **actually happened**, never to pull them back into the app
for its own sake.

**In scope:**
- A **match** (mutual right-swipe in People mode)
- A **new message** (§7.3)

**Explicitly out of scope, permanently, not just for v1:**
- "Someone's active now" / online-status nudges
- "You have unopened likes" teasers that withhold the actual content
- Re-engagement pings ("it's been a while!", "3 new people near you")
- Streaks, daily-open incentives, or any mechanic designed to maximize time-
  in-app rather than reflect something real that occurred

**Delivery:** email only for v1 (via a transactional email API — Resend or
Postmark both fit a Workers-based stack cleanly), not push. In-app read state
is tracked via `notifications.read_at`, but the email is the primary channel
since there's no native app yet to hold push permissions.

**Why this belongs in the plan doc, not just as a stated intention:** the
`notifications.type` column has a `CHECK` constraint limiting it to `'match'`
and `'message'` (§3) specifically so that adding a growth-hacky notification
type later requires a deliberate schema change and a conscious decision to
revisit this section — not a quiet, one-line addition to a notification
service that nobody has to reconcile against a stated principle.

---

## 11. Performance budget (non-negotiable)

Design serves function here, not the reverse. Concrete targets and the
decisions that follow from them:

- **Target: sub-1s Time to Interactive on mid-tier mobile / 4G.** Cloudflare
  Workers serving static assets from the edge gets most of this for free —
  don't undercut it with a heavy JS payload.
- **No React/Vue/heavy framework for v1.** Preact (~3KB) if you want
  component structure, or plain JS with Alpine.js (~15KB) if you want
  declarative bindings without a build step. Both are near-zero overhead
  compared to a full framework's runtime + hydration cost.
- **No animation library.** CSS transitions/transforms (`transform`,
  `opacity`) are GPU-accelerated and free — a swipe card's drag/fling/snap
  can be done with native pointer events + CSS, no Framer Motion needed.
  Reserve JS animation libraries only if a specific interaction proves
  impossible in CSS.
- **Fonts: system font stack by default, one custom display face maximum
  (variable font, subset to used characters, `font-display: swap`).** Every
  additional font file is a render-blocking or layout-shift risk on mobile.
- **Images:** all photos served via Cloudflare Images or R2 + Worker resizing
  — serve WebP/AVIF, correctly sized per breakpoint, lazy-loaded below the
  fold. Album art and artist images from Spotify's CDN already come
  pre-sized; use their smallest sufficient variant, don't upscale client-side.
- **Tailwind: use the CLI/JIT build with unused classes purged.** Never load
  the Tailwind CDN script in production.
- **Swipe deck data:** paginate candidates (e.g. 10 at a time), don't fetch
  and render the whole catalog. Prefetch the next page while the user is
  still swiping through the current one.
- **General rate limiting:** beyond the swipe-specific limit already noted,
  apply Cloudflare's Workers rate-limiting bindings across all `/api/*`
  routes — protects both performance and the fake-profile/bot mitigation
  goal in §9 with one mechanism.
- **Measure it:** run Lighthouse mobile scores as part of the build checklist
  before calling any screen "done," not just at the end.

---

## 12. Mobile-first frontend approach

- Build as a responsive single-page app — CSS with mobile breakpoints as the
  default, desktop as the enhancement (not the other way around)
- Swipe gestures: use a lightweight touch/gesture library (e.g. a small custom
  pointer-events handler, or a minimal library like Hammer.js) rather than a
  heavy framework
- Structure the frontend as **components with clear API boundaries** (even in
  plain JS) so that porting to React Native or wrapping in Capacitor later
  reuses the business logic and API client, not just the visuals
- PWA basics from day one: manifest.json + service worker for "Add to Home
  Screen" — gets you 80% of "feels like an app" for near-zero extra cost
- Two swipe decks live behind a mode toggle (People / Music) rather than as
  separate pages — keeps the swipe interaction consistent across both modes
- **Accessibility pass, not an afterthought:** screen-reader support and alt
  text on photos, keyboard-operable swipe actions (buttons alongside the
  gesture, not gesture-only), sufficient color contrast in the Tailwind
  palette. Matters for App Store review as well as for actually being usable.

---

## 13. Security notes

Encrypt Spotify tokens at rest, HttpOnly/Secure/SameSite cookies, `state`
param CSRF protection, Client Secret only in Worker Secrets. **Signed,
short-lived R2 upload URLs** for photos rather than routing photo bytes
through the Worker directly; validate file type/size server-side before
issuing the signed URL.

---

## 14. Operational readiness

- **Error tracking/monitoring:** wire Sentry (or a comparable service) into
  the Worker from the start — dating-app bugs (a broken match notification, a
  swipe that silently fails to save) are the kind of thing you want to know
  about before a user reports it.
- **D1 backups:** confirm Cloudflare D1's point-in-time recovery is enabled
  for the production database — don't assume it by default; verify it in the
  dashboard as part of setup.
- **Accessibility:** covered in §12, but worth calling out here too as an
  operational checklist item — run an automated accessibility audit (axe or
  Lighthouse's accessibility score) alongside the performance Lighthouse pass
  before calling a screen done.

---

## 15. Project structure

```
wavelengthz/
├── wrangler.toml
├── package.json
├── src/
│   ├── index.ts
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── onboarding.ts
│   │   ├── photos.ts
│   │   ├── candidates.ts
│   │   ├── swipes.ts
│   │   ├── matches.ts
│   │   ├── messages.ts        # send/read messages within a match
│   │   ├── safety.ts          # block, report, unmatch
│   │   ├── account.ts         # account deletion
│   │   ├── notifications.ts   # match/message notifications only
│   │   └── catalog.ts         # artist/track search + add
│   ├── lib/
│   │   ├── spotify.ts
│   │   ├── session.ts
│   │   ├── crypto.ts
│   │   ├── scoring.ts         # includes like-priority queue + geo distance
│   │   ├── email.ts           # Resend/Postmark client, match+message only
│   │   └── r2.ts              # signed upload URL helpers
│   └── db/
│       ├── schema.sql
│       └── seed.ts            # pulls ~50 seed artists from Spotify at setup
├── public/
│   ├── index.html             # swipe UI (people/music toggle)
│   ├── onboarding.html
│   ├── history.html
│   ├── matches.html
│   ├── messages.html
│   ├── settings.html          # block list, report, delete account
│   ├── manifest.json          # PWA manifest
│   ├── sw.js                  # service worker
│   └── app.js
├── legal/
│   ├── privacy-policy.md
│   └── terms-of-service.md
└── README.md
```

---

## 16. What you need before build starts

- [ ] Spotify Developer app (Client ID + Secret), redirect URI configured
- [ ] Cloudflare account with Workers + D1 + **R2** enabled
- [ ] Decide redirect URI (workers.dev subdomain for now, or real domain)
- [ ] `wrangler` CLI installed locally
- [ ] Transactional email provider account (Resend or Postmark) for match/
      message notifications (§10)
- [ ] Error-tracking account (Sentry or similar) (§14)
- [ ] Confirm the `wavelengthz` domain is actually available at a registrar —
      still open from earlier, worth resolving before deep into build
- [ ] Draft privacy policy + ToS (or confirm plan to draft before real users
      sign up) (§8)

---

## 17. Suggested build order

1. D1 schema + `wrangler d1 create wavelengthz-db`
2. OAuth flow end-to-end
3. Pull + store music profile on login
4. Seed script: pull ~50 artists across genres into `artists`/`tracks`
5. Onboarding flow: bio, DOB/age gate, photos (R2 upload), location capture
6. Music-mode swipe UI + `/api/candidates/music` + `/api/swipe/music`
7. Catalog search-and-add (`/api/artists/search`, `/api/artists`)
8. People-mode swipe UI + `/api/candidates/people` (with geo radius filter)
   + `/api/swipe/people`
9. Blended match scoring (§7) + like-priority queue (§7.1)
10. History pages for both swipe types, with edit/undo
11. Matches view + messaging (§7.3) + transactional email on match/message (§10)
12. Block/report/unmatch flows (§9) + account deletion (§9)
13. PWA manifest + service worker, mobile QA + accessibility pass (§12)
14. Wire up Sentry + confirm D1 backups (§14)
15. Deploy, end-to-end test with real Spotify login on a real device

---

## 18. Why Claude Code from here

This is now a genuinely multi-surface build — OAuth, file storage, two swipe
decks, a growing searchable catalog, messaging, trust & safety flows, and
mobile-first UI — with a real CLI toolchain (`wrangler`), local dev server,
secrets, and iterative deploys. That loop fits Claude Code, where I can
scaffold the repo, run `wrangler dev`, iterate on real files across sessions,
and deploy directly, rather than this chat interface's single-shot artifact
model.

