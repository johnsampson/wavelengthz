// artists.genres is stored as an object map (genre -> true) rather than an
// array, for O(1) "does this artist have genre X" membership checks.
export function genresToObject(genres: string[] | undefined): Record<string, true> {
  const obj: Record<string, true> = {};
  for (const genre of genres ?? []) obj[genre] = true;
  return obj;
}

export function genresFromRow(genresJson: string): string[] {
  return Object.keys(JSON.parse(genresJson));
}
