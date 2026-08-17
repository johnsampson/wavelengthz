// Detects a live-recording track by its NAME. Spotify's Web API has no
// boolean "is this a live recording" field on a track object -- the only
// signal available anywhere in this codebase is the title itself, which for
// a live recording conventionally carries a "Live" marker set off by
// punctuation: "Song - Live", "Song (Live)", "Song (Live at Wembley 1985)",
// "Song [Live From Glastonbury]".
//
// Issue #108: "Let's emphasize, or even hide 'live' songs. I'm seeing a lot
// of that with the limited number of bands we have. It prevents getting to
// the main songs by an artist." With a thin catalog, an artist with a dozen
// live re-recordings of the same handful of songs can visually crowd out
// their studio catalog entirely on an artist page, in the radio queue, and
// in deck candidates -- this is applied at all three.
//
// Deliberately requires the "Live" marker to be set off by a dash/parens/
// brackets, NOT a bare word-boundary match anywhere in the title. A plain
// `\blive\b` would misfire on real song titles that happen to be *about*
// being alive or living -- "Live Forever" (Oasis), "Live and Let Die" (Wings/
// Guns N' Roses), "Stayin' Alive" -- none of which are live recordings. The
// punctuation requirement is what tells a genuine "this is the live version"
// suffix apart from the word "live" simply appearing in an ordinary title.
const LIVE_MARKER_RE = /(?:[-–—]\s*live\b)|(?:\(\s*live\b[^)]*\))|(?:\[\s*live\b[^\]]*\])/i;

export function isLiveTrackName(name: string | null | undefined): boolean {
  if (!name) return false;
  return LIVE_MARKER_RE.test(name);
}
