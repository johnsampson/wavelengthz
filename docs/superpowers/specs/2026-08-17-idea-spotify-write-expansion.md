# Idea: Expanding what Wavelengthz writes back to Spotify

**Status:** Future ideas — not yet scoped for implementation. Captured so they don't get lost, not a build plan.

## Where this picks up

PR #97 shipped the first write path: opt-in sync of liked songs into a private **Wavelengthz** playlist, behind `playlist-modify-private` and a separate consent trip (`/login/spotify?intent=sync`). See `src/lib/playlistSync.ts` and `migrations/0023`.

That PR deliberately shipped **one** destination. This spec holds the rest.

## The rule that governs all of these

**Opt in per destination, not one global "sync to Spotify" switch.**

The reason is intent mismatch, and it's the thing most likely to make someone revoke access:

- A deck right-swipe is fast, high-volume, low-commitment — it means *"match me on this."*
- A Spotify like is curatorial. A follow is **public** — it appears on the user's profile and feeds their Release Radar.

Piping every swipe into Liked Songs would flood someone's most personal list and skew their Spotify recommendations. That's the *"this app wrecked my library"* moment.

Ranked by invasiveness — build order should follow it:

| Destination | Scope | Status | Notes |
|---|---|---|---|
| Wavelengthz playlist | `playlist-modify-private` | **Shipped** (#97) | Safest: additive, self-contained, trivially deletable, barely touches recommendations. |
| Follow artists | `user-follow-modify` | **Shipped** (#106) | Outward-facing, so its own scope, consent trip and toggle. Artist right-swipes only. |
| Liked Songs | `user-library-modify` | Not built | Most invasive — directly shapes their algorithm. Off by default, and better wired to an **explicit tap** (the player-bar heart) than to deck swipes at all. |
| Export a match mixtape | `playlist-modify-private` | Not built | See below. |

## Export a match's mixtape

Per-thread playlists are already derived from track messages (PR #93, `migrations/0021`). Exporting one to Spotify needs **no new scope** beyond what #97 already established — the machinery in `playlistSync.ts` (batching, ledger, revocation handling) largely generalizes.

The interesting question is not technical. It's what a shared artifact means once it leaves the app:

- Whose playlist is it, if two people made it?
- What happens on unmatch? The current answer for the in-app version is that it dies with the match, same as messages. An exported copy wouldn't.

The sentimental version — export as a keepsake when a match ends — is lovely, and worth resisting until someone actually asks for it.

## Group crates

`group_messages` already carries `track_id`, and group playlists are already derived. A group crate is *"a local scene's collective crate"* rather than a relationship artifact — low emotional weight, high social utility, and the only version of shared playlists that **works before a user has any matches.** That makes it the real cold-start answer.

The counter is that it only helps if groups aren't empty, and they largely are. Worth revisiting once groups have usage.

## Constraints any new write path must keep

Inherited from #97 and non-negotiable:

- **Batch at Spotify's 100-uri ceiling.** One call per swipe is the burst shape behind this codebase's Development Mode penalties.
- **A ledger, not a mirror.** The user may delete things out of their own library; without a record of what was already sent, every run re-adds what they removed. That's the app fighting the user.
- **Separate `can` from `wants to`.** `granted_scope` says what's permitted; a per-destination flag says what's desired. Both are checked before any write.
- **Turning it off never deletes anything** already written, and never revokes the grant.
- **Handle 401/403 as re-consent, not retry.** Access can be pulled from Spotify's side at any time.
- **No silent backfill on enable.** Show the count, let the user trigger it.

## Open questions

- Does following an artist belong on artist right-swipes only, or also on the artist page's Like button? (They're the same underlying swipe today.)
- Is there a "sync everything" affordance that's honest, or does bundling always mislead?
- Extended Quota review: write scopes get scrutiny. Worth confirming the story before applying — see `docs/spotify-extended-quota.md`.
