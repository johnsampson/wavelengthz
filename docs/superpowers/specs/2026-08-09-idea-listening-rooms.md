# Idea: Listening Rooms

**Status:** Future idea — not yet scoped for implementation. Captured so it doesn't get lost, not a build plan.

## Concept

Turn the existing group-chat feature (`src/routes/groups.ts` — create/join/leave/messages, capped at `MAX_GROUP_MEMBERS = 8`, already built and working) into genre- or artist-scoped "Listening Rooms": a group chat seeded around something specific, like "Cirez D fans" or "vinyl collectors in Austin," rather than a generic open group.

## The Hook

This app already has more social infrastructure than the swipe deck alone suggests — group chat is real and shipped, just not used for this. Scoping groups around a shared artist or scene gives people a reason to open the app that has nothing to do with romantic matching at all, which is stickier and lower-pressure than swiping (no rejection risk, no matching mechanics), and it's mostly a discovery/UI layer on top of infrastructure that's already built and tested, not a new subsystem.

## Rough Shape

- `groups.ts` already has everything structural (membership, messages, recall) — the net-new part is *how a room gets its identity and how people find it*: seeded by genre (reusing the existing `genres` catalog table), by a specific artist, or by locality (reusing existing `lat`/`lng` fields already on `users`).
- Discovery surface is the real open question — does this get its own tab, or does it live as a suggestion off an artist's profile page ("14 other people here like Cirez D — join the room")?
- `MAX_GROUP_MEMBERS = 8` was presumably sized for a different use case (worth checking what groups are used for today before assuming 8 is the right cap for a topic-based room, which might reasonably want to be much larger).

## Open Questions

- What are groups actually used for today, and by whom — this idea was spotted by grepping the schema/routes, not by understanding the existing feature's actual current purpose. Worth a real look before scoping further.
- Room discovery/seeding mechanism is entirely undecided — the biggest open piece of this idea.
