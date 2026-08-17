# Idea: The Daily Drop

**Status:** Future idea — not yet scoped for implementation. Captured so it doesn't get lost, not a build plan.

## The problem it exists to solve

The uncomfortable test: **if matching were deleted from Wavelengthz tomorrow, would anyone open it?** Today, no. That means music is decoration on a dating app rather than the product — the Spotify data is fuel for the ranking algorithm, doing its job invisibly at candidate-selection time and giving the user nothing to come back for.

That matters because dating apps are structurally anti-retentive. If they work, you leave. Their real retention comes from *failure*, which is why they all feel faintly hostile. A daily habit should not be built on that foundation.

The fix isn't more matching mechanics. It's making the music layer **independently worth opening**, so matching becomes a byproduct of a habit rather than the sole reason for one.

## Concept

One prompt a day, answered with a song. You pick a track, you see everyone else's, you can play any of them from the persistent player bar.

- A ~20-second creative act with **no rejection risk**.
- Produces a genuinely new matching surface — people who answered the *same* prompt compatibly, which is far more interesting than genre overlap.
- Hands people a non-desperate opener: *"your answer to Tuesday's prompt was perfect."*
- **Completely intent-agnostic** — works identically for friends and dating (see `2026-08-17-idea-intent-model.md`).

Letterboxd, BeReal, and NYT Games all live on exactly this loop.

## The unfair advantage it exploits

Wavelengthz has a live, involuntary, self-updating, honest signal about who someone is. Nobody has to write a bio. Hinge has to *beg* people to answer prompts; these users generate identity data by doing something they already do daily.

Everything sticky should exploit the fact that **this data refreshes on its own.** A profile is static and goes stale. A listening history is a heartbeat.

## Prompt quality is the whole feature

This was the sharpest point of the original discussion, and it came out of a rejected example. *"The song you'd play someone to explain your hometown"* fails — it's a **travel-writing prompt wearing a music costume.** It makes you do biography homework, then translate the result into a song. Two steps, and most people stall on the first.

**The governing test: the answer has to already be in your head.** If you have to go *searching* for it, you close the app. Good prompts trigger instant recall — *"oh, that song"* — not a research project.

Three more filters:

- **No expertise required.** Anything rewarding obscure knowledge silences casual listeners, who are most of the user base.
- **No correct answer.** "Best X" invites debate and makes people defensive.
- **Slight confession beats cleverness.** Mild embarrassment or honesty is what makes a stranger feel like a person.

**Keep out of the bank:** anything starting with "best" or "most underrated"; anything needing a backstory to make sense; anything too abstract (*"a song that sounds like the color blue"*) — those read as clever, and then people freeze.

## The first 10, as a launch sequence

Sequencing matters as much as content: open at near-zero friction to establish the habit, escalate intimacy once people are comfortable posting.

| # | Prompt | Why it's placed here |
|---|---|---|
| 1 | **What's on repeat right now?** | Zero effort, everyone has an answer this second. The launch prompt, and the one to recycle most often since the answer changes on its own. |
| 2 | **The song you'd never skip, no matter what you're doing.** | Instant recall, no wrong answer, genuinely strong taste signal. |
| 3 | **The song that puts you in a good mood, every time.** | Universal, warm, nobody freezes. |
| 4 | **A song you loved at 15 that you'd still defend.** | Everyone was 15. "Defend" gives permission to be uncool — that permission is what makes people post. |
| 5 | **The most embarrassing song you genuinely love.** | Highest expected participation on the list. Disarming, funny, instantly humanizing. |
| 6 | **What you put on when you need to disappear for a while.** | Reveals how someone self-soothes. Quietly one of the most intimate things you can learn about a person. |
| 7 | **The song you send someone when you want them to get you.** | Directly on the founding thesis. The answer is a self-portrait and doubles as a ready-made opener. |
| 8 | **Last thing you played driving alone at night.** | What the hometown prompt should have been — same evocative territory, but the situation is universal and the memory is actually retrievable. |
| 9 | **The artist you'd drop everything to go see live.** | Aspirational rather than confessional, for variety — and feeds a local-shows feature later. |
| 10 | **A song that reminds you of someone you don't talk to anymore.** | The heaviest, and the one producing the most real connection. Save it until people trust the space; use sparingly, maybe once a quarter. |

## Authoring burden

Yes, this needs a prompt for every day it runs. Two things make that tractable:

- **Recycling is fine, and prompt 1 is designed for it** — "what's on repeat right now" has a different answer every time it's asked.
- The bank only has to stay ahead of the calendar, not be infinite. A quarter's worth written in one sitting is roughly 90 prompts, and the filters above make triage fast.

## Dependencies

- **One-step track search — now shipped.** `GET /api/tracks/search` no longer requires an `artist_id` (see `src/routes/catalog.ts`). This was the blocking dependency and it's cleared.
- The persistent player bar (`public/playerBar.js`) already handles playing an arbitrary track from anywhere, so answers are playable with no new player work.

## Open questions

- **The catalog pressure-test never ran.** The plan was to pull genre and artist distribution out of D1 and check which of these prompts the current user base could realistically answer versus which assume a listening history nobody there has. It was blocked on Cloudflare credentials in that session and local D1 being an empty scratch DB. Worth doing before committing to the launch order above.
- Where the answer surface lives — its own route, or folded into the deck?
- Does a prompt's answer set become a matching input, or only a browsing surface, in v1?
- How many answers make the surface feel alive rather than empty? (This is the cold-start risk, and it's the same one groups have.)
