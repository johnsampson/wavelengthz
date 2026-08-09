# Idea: Invite-to-Unlock

**Status:** Future idea — not yet scoped for implementation. Captured so it doesn't get lost, not a build plan.

## Concept

Separate from the signup gate in `docs/superpowers/specs/2026-08-09-gender-balanced-invite-gate-design.md` (which controls *who can join the app at all*), this is a referral incentive for people who are already members: invite N friends, unlock something real for a limited time — unlimited swipes for a week, or seeing who's already liked you.

## The Hook

The classic Dropbox referral loop (invite friends, get more storage), adapted to a free app by unlocking *features* instead of *paid capacity* — the app stays free with no monetization, so the unlock has to be time-boxed access to something that already exists, never a purchase path. Existing members become recruiters because it benefits them directly, which is a different motivation than the invite-gate design's structural gender-balancing — this is about incentive, that one is about admission.

## Rough Shape

- Needs to reuse whatever invite-tracking mechanism the gender-balanced gate design introduces (`invite_codes`, `redeemed_by_user_id`) — this idea is a second thing that can happen when a code gets redeemed (grant the inviter a temporary unlock), not a separate invite system.
- "Unlimited swipes for a week" implies today's swipe flow has some limit already, or would need one introduced for this to be meaningful — worth checking whether a daily swipe cap exists anywhere before this is scoped further.
- "See who's liked you" implies today's flow doesn't show that by default — also needs confirming against the actual swipe/candidate code before this is scoped further.

## Open Questions

- This idea assumes the invite-gate design (or something like it) ships first, since it piggybacks on the same redemption event — sequencing matters here more than for the other four ideas in this batch.
- Whether time-boxed unlocks expire cleanly needs a real mechanism (a stored expiry timestamp, checked wherever the unlocked feature is gated) — not fleshed out here.
