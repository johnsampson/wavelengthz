import { describe, it, expect } from 'vitest';
import { genresToObject, genresFromRow } from '../../src/lib/genres';

describe('genresToObject', () => {
  it('converts an array of genre strings into an object map', () => {
    expect(genresToObject(['indie', 'rock'])).toEqual({ indie: true, rock: true });
  });

  it('returns an empty object for an empty or missing array', () => {
    expect(genresToObject([])).toEqual({});
    expect(genresToObject(undefined)).toEqual({});
  });

  it('de-duplicates repeated genres', () => {
    expect(genresToObject(['pop', 'pop'])).toEqual({ pop: true });
  });
});

describe('genresFromRow', () => {
  it('reads back the genre list from a stored object', () => {
    expect(genresFromRow(JSON.stringify({ indie: true, rock: true })).sort()).toEqual(['indie', 'rock']);
  });

  it('returns an empty array for an empty object', () => {
    expect(genresFromRow('{}')).toEqual([]);
  });
});
