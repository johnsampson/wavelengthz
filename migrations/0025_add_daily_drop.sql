-- Migration number: 0025 	 2026-08-22T04:30:00.000Z

-- The Daily Drop: one prompt a day, answered with a song. Per CLAUDE.md's
-- schema conventions -- every table its own id + created_at/updated_at,
-- table names plural snake_case.
--
-- daily_prompts is the curated bank (48 rows seeded below, first-stab list
-- reviewed and cut from 50 -> 48 by the project owner -- see
-- daily_drop_prompts.csv in that review). `sort_order` is the rotation
-- position: which prompt shows on a given day is `sort_order = (day_index
-- % 48) + 1`, a pure computation (src/lib/dailyDrop.ts) rather than stored,
-- mutable "prompt of the day" state -- no cron, no race condition on who's
-- first to view a fresh day.
--
-- Positions 1-10 are the launch sequence from
-- docs/superpowers/specs/2026-08-17-idea-daily-drop.md, kept in that exact
-- order (zero-effort opener -> escalating intimacy). Positions 11-48
-- interleave the remaining light/medium prompts roughly 3:1 (their actual
-- ratio in the bank), with the 2 remaining heavy (intensity 3) prompts
-- placed far apart from each other and from position 10's heavy prompt --
-- see test/lib/dailyDrop.test.ts for the spacing invariant. The doc's own
-- target bank size is ~90 (a real quarter); at 48, heavy prompts recur
-- every ~48 days rather than the doc's "maybe once a quarter" -- a known
-- gap that closes once the bank grows, not fixed here.
CREATE TABLE daily_prompts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  theme TEXT NOT NULL,
  intensity INTEGER NOT NULL, -- 1 (light) .. 3 (heavy)
  sort_order INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO daily_prompts (id, text, theme, intensity, sort_order, created_at, updated_at) VALUES
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What''s on repeat right now?', 'Current mood', 1, 1, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you''d never skip, no matter what you''re doing.', 'All-time favorite', 1, 2, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song that puts you in a good mood, every time.', 'Mood / uplift', 1, 3, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'A song you loved at 15 that you''d still defend.', 'Nostalgia', 2, 4, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The most embarrassing song you genuinely love.', 'Confession / guilty pleasure', 1, 5, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What you put on when you need to disappear for a while.', 'Comfort / self-soothing', 2, 6, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you send someone when you want them to get you.', 'Self-portrait / opener', 2, 7, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'Last thing you played driving alone at night.', 'Situational / memory', 1, 8, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The artist you''d drop everything to go see live.', 'Aspirational', 2, 9, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'A song that reminds you of someone you don''t talk to anymore.', 'Emotional / heavy', 3, 10, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What have you had on repeat this week?', 'Current mood', 1, 11, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What song have you played more than once today?', 'Current mood', 1, 12, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What''s the last song you added to a playlist?', 'Current mood', 1, 13, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you play when you can''t sleep.', 'Comfort / self-soothing', 2, 14, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What are you listening to right now, this second?', 'Current mood', 1, 15, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you know every word to, still.', 'All-time favorite', 1, 16, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'A song you''ve heard a thousand times and it still works.', 'All-time favorite', 1, 17, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song that feels like a weighted blanket.', 'Comfort / self-soothing', 2, 18, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you play when you need five more minutes of energy.', 'Mood / uplift', 1, 19, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'A song that''s made you cry, more than once.', 'Emotional / heavy', 3, 20, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What do you put on to feel unstoppable for three minutes?', 'Mood / uplift', 1, 21, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song that instantly makes a bad day better.', 'Mood / uplift', 1, 22, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'A song from middle or high school you''re still not over.', 'Nostalgia', 2, 23, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What do you listen to on a day you''re taking it slow?', 'Comfort / self-soothing', 1, 24, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The first song you remember loving.', 'Nostalgia', 1, 25, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'A song you''d never admit to liking out loud, until now.', 'Confession / guilty pleasure', 1, 26, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song that instantly puts you back in a specific summer.', 'Nostalgia', 2, 27, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you skip in front of people but blast alone.', 'Confession / guilty pleasure', 1, 28, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'An artist everyone gives you grief for loving.', 'Confession / guilty pleasure', 1, 29, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What''s the soundtrack to your morning routine?', 'Situational / memory', 1, 30, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song that''s basically your personality in three minutes.', 'Self-portrait / opener', 2, 31, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you play getting ready to go out.', 'Situational / memory', 1, 32, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What''s playing when you''re doing chores you hate?', 'Situational / memory', 1, 33, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song stuck in your head today, whether you like it or not.', 'Situational / memory', 1, 34, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'If someone wanted to understand you in one song, this is it.', 'Self-portrait / opener', 2, 35, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What do you play on a rainy day?', 'Situational / memory', 1, 36, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you play when you''re cooking.', 'Situational / memory', 1, 37, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you can''t sit still for.', 'Movement / energy', 1, 38, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'A concert you''d travel for, no question.', 'Aspirational', 2, 39, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'What''s on your workout playlist that has no business being that good?', 'Movement / energy', 1, 40, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song that got you through a hard year.', 'Emotional / heavy', 3, 41, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song that makes you dance in the kitchen alone.', 'Movement / energy', 1, 42, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song that gets an entire room singing.', 'Social', 1, 43, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'A song you reach for when you''re missing someone.', 'Emotional / heavy', 2, 44, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'Your go-to karaoke song, win or lose.', 'Social', 1, 45, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you always request at a party.', 'Social', 1, 46, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'An artist you''ll defend to literally anyone.', 'Taste identity', 1, 47, 1787356800000, 1787356800000),
  (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), 'The song you play when you need to feel something.', 'Emotional / heavy', 2, 48, 1787356800000, 1787356800000);

-- One answer per user per calendar day (UTC). `prompt_id` is denormalized
-- (derivable from day_index via the rotation formula) so a past answer's
-- prompt text stays correct even if the bank or rotation formula changes
-- later -- same reasoning as music_profiles storing name/imageUrl alongside
-- artist_id in migrations already in this schema. `track_id` goes through
-- src/lib/trackSharing.ts's resolveSharedTrack (DB-first catalog
-- resolution, same as messages.track_id) -- never a bare Spotify id.
CREATE TABLE daily_drop_answers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  day_index INTEGER NOT NULL,
  prompt_id TEXT NOT NULL REFERENCES daily_prompts(id),
  track_id TEXT NOT NULL REFERENCES tracks(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, day_index)
);

-- Powers both "how many people answered today" (COUNT WHERE day_index = ?)
-- and the browse list itself.
CREATE INDEX idx_daily_drop_answers_day ON daily_drop_answers(day_index);
