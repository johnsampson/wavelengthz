# Idea: Retention surfaces — the ranked shortlist

**Status:** Future ideas — not yet scoped for implementation. Captured so they don't get lost, not a build plan.

Output of a strategy pass on "what makes people come back daily." The two highest-ranked items have their own homes:

- **#1 The daily drop** → `2026-08-17-idea-daily-drop.md`
- **#2 The thread is a mixtape** → **shipped** (PR #93: track messages + derived per-thread playlists; PR #97: opt-in Spotify playlist sync)

What follows is the rest of the ranking, plus the ideas deliberately rejected — recorded so they don't get re-proposed without the reasoning attached.

---

## 3. Ambient presence — "on your wavelength right now"

*"4 people within 20 miles are listening to this artist right now."* Live, unfakeable serendipity that no other app in this space can do.

Overlaps with the earlier `2026-08-09-idea-now-playing-presence.md`, which covers the per-profile version; this is the aggregated, area-level variant.

**Two hard caveats, both blocking:**

- **Rate limits.** This is per-user polling, and `CLAUDE.md` documents repeated production incidents from exactly that class of mistake. It must be pull-on-view with aggressive caching — **never a cron sweeping all users.**
- **Privacy.** Real-time listening is a different privacy shape from a static profile. Opt-in, aggregated and fuzzed by default.

Get both right and it's the most differentiated surface in the app.

## 4. Taste drift — your own mirror ✅ shipped (#107)

*"Your wavelength moved toward ambient this month."*

Lives at `/wavelength`, linked from Settings. One correction to the note above: **`user_genres` turned out to be the wrong source.** It holds running totals with no history, so it can say what someone likes but never what changed. `music_swipes`' own timestamps are what make a before/after comparison possible, and that's what shipped.

**Not** built: the *"here's who moved with you"* half. That needs cross-user comparison and is a genuinely different feature — worth doing once there are enough users for the answer to be interesting.

## 5. Local scene

The artist page already knows *"N likes, M in your area."* Extending that to live shows is the highest-conviction **relationship catalyst** on this list — music taste plus proximity plus a real-world reason to meet.

Needs external event data and genuine local density, so it's later than the rest. Note that daily-drop prompt #9 (*"the artist you'd drop everything to go see live"*) feeds this directly.

---

## Deliberately rejected

Recorded with reasons so they don't come back around:

| Idea | Why not |
|---|---|
| **Two-person streaks** | Manufactures obligation, then resentment. The opposite of the low-pressure tone the daily drop depends on. |
| **Points / badges** | Hollow, and doesn't compound. Note this conflicts with the "curator badges" item in issue #2 — worth resolving which view wins before either is built. |
| **Daily like limits as the primary hook** | That's monetization wearing a retention costume. |
