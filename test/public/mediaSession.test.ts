import { describe, it, expect } from 'vitest';
import { coverCropRect, buildMetadataInit } from '../../public/mediaSession.js';

describe('coverCropRect', () => {
  it('crops a square source down to a portrait destination, centered horizontally', () => {
    // 512x512 source into a 256x512 (half-width) destination -- object-fit:
    // cover means scaling to cover height (scale 1), then cropping the
    // width down to 256, centered (128px off each side).
    const rect = coverCropRect(512, 512, 256, 512);
    expect(rect).toEqual({ sx: 128, sy: 0, sWidth: 256, sHeight: 512 });
  });

  it('crops a tall source down to a square destination, centered vertically', () => {
    // 400x800 (portrait) source into a 400x400 destination -- cover means
    // scaling to cover width (scale 1), leaving a 400-tall source strip to
    // crop from, centered (200px off top and bottom).
    const rect = coverCropRect(400, 800, 400, 400);
    expect(rect).toEqual({ sx: 0, sy: 200, sWidth: 400, sHeight: 400 });
  });

  it('returns the whole source unchanged when its aspect ratio already matches the destination', () => {
    const rect = coverCropRect(300, 300, 150, 150);
    expect(rect).toEqual({ sx: 0, sy: 0, sWidth: 300, sHeight: 300 });
  });
});

describe('buildMetadataInit', () => {
  it('maps a track to a MediaMetadata init with one artwork entry', () => {
    const init = buildMetadataInit(
      { name: 'Valborg', artistName: 'Vintersorg', imageUrl: 'https://img.example/a.jpg' },
      'https://img.example/composed.png'
    );
    expect(init.title).toBe('Valborg');
    expect(init.artist).toBe('Vintersorg');
    expect(init.album).toBe('Wavelengthz');
    expect(init.artwork).toEqual([{ src: 'https://img.example/composed.png', sizes: '512x512', type: 'image/png' }]);
  });

  it('falls back to empty strings for a track missing name/artistName', () => {
    const init = buildMetadataInit({}, null);
    expect(init.title).toBe('');
    expect(init.artist).toBe('');
  });

  it('omits artwork entirely when no artwork src is given', () => {
    const init = buildMetadataInit({ name: 'Valborg', artistName: 'Vintersorg' }, null);
    expect(init.artwork).toEqual([]);
  });
});
