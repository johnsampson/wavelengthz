# Idea: Rethinking the friends/dating intent model

**Status:** Future idea — not yet scoped for implementation. Captured so it doesn't get lost, not a build plan.

## The concern that prompted this

Raised directly by the project owner: Wavelengthz has arguably tried to combine two apps — a friend-finding app and a dating app — and *"this may come back to bite us."* Alongside that, the founding tenet stands: **aligned music taste makes good relationships.**

This spec captures the analysis, not a decision. Nothing here has been agreed or scheduled.

## The diagnosis

The problem is narrower than "two apps in one."

Today, intent is implemented as a **filter at the door**. `seeking='friends'` creates a disjoint pool; users must declare before they've experienced anything; and then the app behaves *identically* for both. So the friends cohort inherits all of dating's baggage — performance, rejection, transaction — and both pools end up half-empty. That's the worst of both.

## The reframe

> **Shared surfaces are intent-agnostic. Only 1:1 approach is intent-specific.**

The daily drop, listening presence, and groups don't need to know why you're there — you're just reacting to a song. Put the intent filter at the **moment of connection**, not the moment of entry.

Two things follow:

- **One pool, one feed**, which directly helps the cold-start density problem — currently the single biggest constraint on the app feeling alive.
- Intent stops being a wall a new user hits before they've seen anything worth staying for.

## Worth naming plainly

*"Aligned music taste makes good relationships"* is a **stronger claim for friendship than for romance.** Musical affinity predicts platonic connection quite reliably; romantic attraction has many other inputs.

That isn't an argument against the thesis — it's an argument that the thesis may point somewhere slightly different from where the product currently aims. Worth sitting with before committing to a direction.

## What this would touch

Not scoped, but the surface area is real and worth knowing before anyone starts:

- `users.seeking` / `users.gender` and the preferences UI (`public/settings/preferences.html`)
- `src/routes/peopleSwipes.ts`'s candidate query, which filters on the declared pool
- `src/lib/matching.ts` / `src/lib/scoring.ts`
- Onboarding (`public/onboarding.html`), where the declaration currently happens

A change here is a product-direction change with a schema tail, not a UI tweak. It should not be started without an explicit decision.

## Open questions

- Does "intent at the moment of connection" mean the *approach* carries the intent (like-as-friend vs. like-as-date), or that intent is simply never declared and inferred from behavior?
- What happens to existing users who have already declared, if the model changes?
- Does a single pool create safety obligations that the split pool currently sidesteps? Cross-reference issue #36 (Trust & Safety) before going further.
