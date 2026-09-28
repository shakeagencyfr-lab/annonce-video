import { describe, expect, it } from 'vitest';
import type { VideoProps } from '@/lib/render/props';
import {
  CROSSFADE_SEC,
  END_CARD_SEC,
  KEN_BURNS_PEAK,
  MAX_UPSCALE,
  MIN_PHOTO_SEC,
  MIN_ZOOM_PEAK,
  MUSIC_VOLUME,
  TITLE_CARD_SEC,
  containedBox,
  cueAtFrame,
  displayText,
  endCardFrom,
  fadeInOpacity,
  kenBurns,
  kenBurnsScale,
  musicVolume,
  photoBaseScale,
  photoFit,
  photoSchedule,
  photoTrackSchedule,
  screenTexts,
  secToFrames,
  type Slot,
  zoomPeak,
} from '@/lib/render/timeline';

const FPS = 30;
const OVERLAP = secToFrames(CROSSFADE_SEC, FPS);
const MIN_FRAMES = secToFrames(MIN_PHOTO_SEC, FPS);

/** How many slots are on screen at each frame. */
function visibleCounts(slots: Slot[], durationInFrames: number): number[] {
  const counts = new Array<number>(durationInFrames).fill(0);
  for (const slot of slots) {
    for (let f = slot.from; f < slot.from + slot.durationInFrames; f++) counts[f] = (counts[f] ?? 0) + 1;
  }
  return counts;
}

describe('photoSchedule', () => {
  const cases: [count: number, durationInFrames: number][] = [
    [8, 35 * FPS],
    [10, 38 * FPS + 7],
    [14, 55 * FPS],
    [9, 1001],
    [3, 12 * FPS],
    [2, 2 * MIN_FRAMES - OVERLAP],
  ];

  it.each(cases)('covers every frame with %i photos over %i frames, at most two at once', (count, duration) => {
    const slots = photoSchedule(count, duration, FPS);
    expect(slots).toHaveLength(count);
    expect(slots[0]?.from).toBe(0);
    const last = slots.at(-1)!;
    expect(last.from + last.durationInFrames).toBe(duration);
    const counts = visibleCounts(slots, duration);
    expect(counts.every((c) => c === 1 || c === 2)).toBe(true);
  });

  it.each(cases)('overlaps consecutive photos by the crossfade (%i photos, %i frames)', (count, duration) => {
    const slots = photoSchedule(count, duration, FPS);
    for (let i = 1; i < slots.length; i++) {
      const prev = slots[i - 1]!;
      const cur = slots[i]!;
      expect(cur.from).toBeGreaterThan(prev.from);
      expect(prev.from + prev.durationInFrames - cur.from).toBe(OVERLAP);
    }
  });

  it.each(cases)('keeps every photo at least MIN_PHOTO_SEC (%i photos, %i frames)', (count, duration) => {
    for (const slot of photoSchedule(count, duration, FPS)) {
      expect(slot.durationInFrames).toBeGreaterThanOrEqual(MIN_FRAMES);
    }
  });

  it('gives photos about the same length', () => {
    const lengths = photoSchedule(10, 38 * FPS + 7, FPS).map((s) => s.durationInFrames);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
  });

  it('leaves out the last photos when the video is too short for all of them', () => {
    const duration = 12 * FPS;
    const slots = photoSchedule(8, duration, FPS);
    expect(slots.length).toBe(7);
    expect(slots.every((s) => s.durationInFrames >= MIN_FRAMES)).toBe(true);
    expect(visibleCounts(slots, duration).every((c) => c >= 1)).toBe(true);
  });

  it('shows one photo for the whole video when it is shorter than two photos', () => {
    expect(photoSchedule(5, 40, FPS)).toEqual([{ from: 0, durationInFrames: 40 }]);
    const tooShort = 2 * MIN_FRAMES - OVERLAP - 1;
    expect(photoSchedule(2, tooShort, FPS)).toEqual([{ from: 0, durationInFrames: tooShort }]);
    expect(photoSchedule(1, 900, FPS)).toEqual([{ from: 0, durationInFrames: 900 }]);
  });

  it('returns nothing without photos or frames', () => {
    expect(photoSchedule(0, 900, FPS)).toEqual([]);
    expect(photoSchedule(4, 0, FPS)).toEqual([]);
  });

  it('works at another frame rate', () => {
    const slots = photoSchedule(8, 30 * 25, 25);
    expect(slots).toHaveLength(8);
    expect(slots.every((s) => s.durationInFrames >= secToFrames(MIN_PHOTO_SEC, 25))).toBe(true);
    expect(visibleCounts(slots, 30 * 25).every((c) => c >= 1)).toBe(true);
  });

  it('is deterministic', () => {
    expect(photoSchedule(9, 1001, FPS)).toEqual(photoSchedule(9, 1001, FPS));
  });
});

describe('photoTrackSchedule', () => {
  const FADE = secToFrames(CROSSFADE_SEC, FPS);
  // The two voiced runs of the audit (530 and 718 frames): photos 9 and 10 used to start
  // under the end card. 530 frames leave room for 9 photos of MIN_PHOTO_SEC before it.
  const cases: [count: number, durationInFrames: number, shown: number][] = [
    [10, 530, 9],
    [10, 718, 10],
    [8, 35 * FPS, 8],
    [14, 55 * FPS, 14],
  ];

  it.each(cases)('shows each of %i photos before the end card of a %i-frame video', (count, duration, shown) => {
    const endFrom = endCardFrom(duration, FPS);
    const slots = photoTrackSchedule(count, duration, FPS);
    expect(slots).toHaveLength(shown);
    for (const [i, slot] of slots.entries()) {
      // Fully faded in, and alone on screen, before the veil of the end card starts.
      const clearFrom = slot.from + (i === 0 ? 0 : FADE);
      const clearUntil = Math.min(slots[i + 1]?.from ?? endFrom, endFrom);
      expect(clearUntil - clearFrom).toBeGreaterThanOrEqual(MIN_FRAMES - 2 * OVERLAP);
    }
  });

  it.each(cases)('holds the last photo under the end card until the end (%i photos, %i frames)', (count, duration) => {
    const slots = photoTrackSchedule(count, duration, FPS);
    const last = slots.at(-1)!;
    expect(last.from).toBeLessThan(endCardFrom(duration, FPS));
    expect(last.from + last.durationInFrames).toBe(duration);
    const counts = visibleCounts(slots, duration);
    expect(counts.every((c) => c === 1 || c === 2)).toBe(true);
  });

  it('keeps the schedule of the photos before the last one', () => {
    const duration = 718;
    const until = endCardFrom(duration, FPS) + FADE;
    expect(photoTrackSchedule(10, duration, FPS).slice(0, -1)).toEqual(photoSchedule(10, until, FPS).slice(0, -1));
  });

  it('shows fewer photos when the time before the end card is short, and nothing without photos', () => {
    expect(photoTrackSchedule(10, 12 * FPS, FPS).length).toBeLessThan(10);
    expect(photoTrackSchedule(1, 20, FPS)).toEqual([{ from: 0, durationInFrames: 20 }]);
    expect(photoTrackSchedule(0, 900, FPS)).toEqual([]);
  });
});

describe('fadeInOpacity', () => {
  it('goes from 0 to 1 over the fade, then stays at 1', () => {
    expect(fadeInOpacity(0, 15)).toBe(0);
    expect(fadeInOpacity(7.5, 15)).toBe(0.5);
    expect(fadeInOpacity(15, 15)).toBe(1);
    expect(fadeInOpacity(200, 15)).toBe(1);
    expect(fadeInOpacity(-3, 15)).toBe(0);
    expect(fadeInOpacity(0, 0)).toBe(1);
  });
});

describe('kenBurns', () => {
  const drift = (i: number) => {
    const m = kenBurns(i);
    return Math.sign((m.originX - 50) * (m.toScale - m.fromScale));
  };

  it('is deterministic and stays between 1.0 and 1.1 around a point inside the photo', () => {
    for (let i = 0; i < 12; i++) {
      const m = kenBurns(i);
      expect(kenBurns(i)).toEqual(m);
      for (const s of [m.fromScale, m.toScale]) {
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(1.1);
      }
      expect(Math.abs(m.toScale - m.fromScale)).toBeCloseTo(0.1);
      expect(m.originX).toBeGreaterThanOrEqual(0);
      expect(m.originX).toBeLessThanOrEqual(100);
      expect(m.originY).toBeGreaterThanOrEqual(0);
      expect(m.originY).toBeLessThanOrEqual(100);
    }
  });

  it('alternates the drift direction from one photo to the next', () => {
    for (let i = 0; i < 12; i++) {
      expect(drift(i)).not.toBe(0);
      expect(drift(i + 1)).toBe(-drift(i));
    }
  });

  it('accepts any integer seed', () => {
    expect(kenBurns(-1)).toEqual(kenBurns(3));
    expect(kenBurns(4)).toEqual(kenBurns(0));
  });

  it('zooms up to a lower peak when asked, with the same focus points and drift', () => {
    for (let i = 0; i < 4; i++) {
      const full = kenBurns(i);
      const soft = kenBurns(i, 1.04);
      expect([soft.fromScale, soft.toScale].sort()).toEqual([1, 1.04]);
      expect(soft.originX).toBe(full.originX);
      expect(soft.originY).toBe(full.originY);
      expect(Math.sign(soft.toScale - soft.fromScale)).toBe(Math.sign(full.toScale - full.fromScale));
    }
    expect(kenBurns(0, KEN_BURNS_PEAK)).toEqual(kenBurns(0));
  });

  it('interpolates the scale over the slot and clamps the progress', () => {
    const zoomIn = kenBurns(0);
    expect(kenBurnsScale(zoomIn, 0)).toBe(zoomIn.fromScale);
    expect(kenBurnsScale(zoomIn, 1)).toBe(zoomIn.toScale);
    expect(kenBurnsScale(zoomIn, 0.5)).toBeCloseTo((zoomIn.fromScale + zoomIn.toScale) / 2);
    expect(kenBurnsScale(zoomIn, 2)).toBe(zoomIn.toScale);
    expect(kenBurnsScale(zoomIn, -1)).toBe(zoomIn.fromScale);
  });
});

describe('endCardFrom', () => {
  it('starts END_CARD_SEC before the end', () => {
    expect(endCardFrom(35 * FPS, FPS)).toBe(35 * FPS - END_CARD_SEC * FPS);
  });

  it('never starts before the title card is over', () => {
    expect(endCardFrom(5 * FPS, FPS)).toBe(secToFrames(TITLE_CARD_SEC, FPS));
    expect(endCardFrom(30, FPS)).toBe(30);
  });
});

describe('cueAtFrame', () => {
  const cues = [
    { text: 'Peugeot 308 de 2019', start: 0.2, end: 1.5 },
    { text: '68 000 km', start: 1.5, end: 2.4 },
    { text: 'Garantie 12 mois', start: 3, end: 4.2 },
  ];

  it('returns the cue shown at a frame, end excluded', () => {
    expect(cueAtFrame(cues, 0, FPS)).toBeUndefined();
    expect(cueAtFrame(cues, 6, FPS)?.text).toBe('Peugeot 308 de 2019');
    expect(cueAtFrame(cues, 45, FPS)?.text).toBe('68 000 km');
    expect(cueAtFrame(cues, 80, FPS)).toBeUndefined();
    expect(cueAtFrame(cues, 90, FPS)?.text).toBe('Garantie 12 mois');
    expect(cueAtFrame(cues, 126, FPS)).toBeUndefined();
    expect(cueAtFrame([], 10, FPS)).toBeUndefined();
  });
});

describe('photoFit', () => {
  const vertical = { width: 1080, height: 1920 };
  const horizontal = { width: 1920, height: 1080 };

  it('contains landscape photos in 9:16 so the car is not cropped', () => {
    expect(photoFit({ width: 1600, height: 1066 }, vertical)).toBe('contain');
    expect(photoFit({ width: 1024, height: 768 }, vertical)).toBe('contain');
  });

  it('covers 16:9 with 4:3 and 3:2 photos', () => {
    expect(photoFit({ width: 1600, height: 1066 }, horizontal)).toBe('cover');
    expect(photoFit({ width: 1024, height: 768 }, horizontal)).toBe('cover');
    expect(photoFit({ width: 1920, height: 1080 }, horizontal)).toBe('cover');
  });

  it('contains portrait photos in 16:9 and covers 9:16 with them', () => {
    expect(photoFit({ width: 1066, height: 1600 }, horizontal)).toBe('contain');
    expect(photoFit({ width: 1066, height: 1600 }, vertical)).toBe('cover');
  });

  it('covers when the size is unknown', () => {
    expect(photoFit({ width: 0, height: 0 }, vertical)).toBe('cover');
  });
});

describe('containedBox', () => {
  const frames = [
    { width: 1080, height: 1920 },
    { width: 1920, height: 1080 },
  ];
  const photos = [
    { width: 1600, height: 1066 },
    { width: 1024, height: 768 },
    { width: 800, height: 600 },
    { width: 1066, height: 1600 },
    { width: 1000, height: 1000 },
    { width: 4000, height: 1000 },
  ];

  it('fits the whole photo in the frame, touching two opposite edges', () => {
    for (const frame of frames) {
      for (const photo of photos) {
        const box = containedBox(photo, frame);
        expect(box.left).toBeGreaterThanOrEqual(-1e-6);
        expect(box.top).toBeGreaterThanOrEqual(-1e-6);
        expect(box.left + box.width).toBeLessThanOrEqual(frame.width + 1e-6);
        expect(box.top + box.height).toBeLessThanOrEqual(frame.height + 1e-6);
        const touches = Math.abs(box.width - frame.width) < 1e-6 || Math.abs(box.height - frame.height) < 1e-6;
        expect(touches).toBe(true);
      }
    }
  });

  it('keeps the aspect ratio and centers the photo', () => {
    const photo = { width: 1600, height: 1066 };
    const frame = { width: 1080, height: 1920 };
    const box = containedBox(photo, frame);
    expect(box.width / box.height).toBeCloseTo(photo.width / photo.height, 6);
    expect(box.left * 2 + box.width).toBeCloseTo(frame.width, 6);
    expect(box.top * 2 + box.height).toBeCloseTo(frame.height, 6);
  });

  it('gives a landscape photo the full width of the 9:16 frame (the zoom is clipped to the box)', () => {
    const box = containedBox({ width: 800, height: 600 }, { width: 1080, height: 1920 });
    expect(box).toEqual({ left: 0, top: 555, width: 1080, height: 810 });
    // 42 % of the height, against 37 % when the box left room for the zoom.
    expect(box.height / 1920).toBeGreaterThan(0.42);
  });

  it('fills the frame when the photo size is unknown', () => {
    expect(containedBox({ width: 0, height: 0 }, { width: 1080, height: 1920 })).toEqual({
      left: 0,
      top: 0,
      width: 1080,
      height: 1920,
    });
  });
});

describe('photoBaseScale and zoomPeak', () => {
  const vertical = { width: 1080, height: 1920 };
  const horizontal = { width: 1920, height: 1080 };
  const leboncoin = { width: 800, height: 600 };

  it('is the enlargement of a photo before its zoom, covered or contained', () => {
    // Covered in 16:9: 800x600 drawn 1920x1440.
    expect(photoBaseScale(leboncoin, horizontal)).toBeCloseTo(2.4, 6);
    // Contained in 9:16: drawn 1080x810.
    expect(photoBaseScale(leboncoin, vertical)).toBeCloseTo(1.35, 6);
    expect(photoBaseScale({ width: 0, height: 0 }, horizontal)).toBe(1);
  });

  it('keeps an 800x600 photo at most MAX_UPSCALE times its size in 16:9, zoom included', () => {
    const base = photoBaseScale(leboncoin, horizontal);
    const peak = zoomPeak(base);
    expect(peak).toBeLessThan(KEN_BURNS_PEAK);
    expect(base * peak).toBeLessThanOrEqual(MAX_UPSCALE + 1e-9);
    expect(base * peak).toBeGreaterThan(MAX_UPSCALE - 0.01);
  });

  it('keeps the full zoom on sharp photos and on the contained 9:16 photo', () => {
    expect(zoomPeak(photoBaseScale({ width: 1600, height: 1200 }, horizontal))).toBe(KEN_BURNS_PEAK);
    expect(zoomPeak(photoBaseScale({ width: 1920, height: 1080 }, horizontal))).toBe(KEN_BURNS_PEAK);
    expect(zoomPeak(photoBaseScale(leboncoin, vertical))).toBe(KEN_BURNS_PEAK);
  });

  it('never stops the zoom completely, and falls back to the full zoom on a bad scale', () => {
    expect(zoomPeak(4)).toBe(MIN_ZOOM_PEAK);
    expect(zoomPeak(0)).toBe(KEN_BURNS_PEAK);
    expect(zoomPeak(Number.NaN)).toBe(KEN_BURNS_PEAK);
  });
});

describe('musicVolume', () => {
  const duration = 35 * FPS;

  it('stays at the music level until the last second, then fades to silence', () => {
    expect(musicVolume(0, duration, FPS)).toBe(MUSIC_VOLUME);
    expect(musicVolume(duration - FPS, duration, FPS)).toBe(MUSIC_VOLUME);
    expect(musicVolume(duration - FPS / 2, duration, FPS)).toBeCloseTo(MUSIC_VOLUME / 2);
    expect(musicVolume(duration - 1, duration, FPS)).toBeLessThan(MUSIC_VOLUME / 10);
    expect(musicVolume(duration, duration, FPS)).toBe(0);
  });

  it('never rises during the fade and never leaves [0, MUSIC_VOLUME]', () => {
    let previous = Infinity;
    for (let f = 0; f <= duration + 5; f++) {
      const v = musicVolume(f, duration, FPS);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(MUSIC_VOLUME);
      expect(v).toBeLessThanOrEqual(previous);
      previous = v;
    }
  });
});

describe('screenTexts', () => {
  const overlays = {
    title: 'Peugeot 308 Allure',
    subtitle: '2019 · 68 000 km',
    price: '15 990 €',
    contact: 'Garage des Tests · 04 00 00 00 00',
  };
  const base: Pick<VideoProps, 'variant' | 'vertical' | 'overlays' | 'dpe'> = {
    variant: 'social',
    vertical: 'auto',
    overlays,
  };

  it('shows the price and the contact in the social variant', () => {
    expect(screenTexts(base)).toEqual(overlays);
  });

  it('never shows the price nor the contact in the listing variant, even when the props hold them', () => {
    const texts = screenTexts({ ...base, variant: 'listing' });
    expect(texts).toEqual({ title: overlays.title, subtitle: overlays.subtitle });
    expect(texts.price).toBeUndefined();
    expect(texts.contact).toBeUndefined();
  });

  it('shows the DPE on immo videos only', () => {
    expect(screenTexts({ ...base, vertical: 'immo', dpe: 'D' }).dpe).toBe('D');
    expect(screenTexts({ ...base, variant: 'listing', vertical: 'immo', dpe: 'F' }).dpe).toBe('F');
    expect(screenTexts({ ...base, vertical: 'auto', dpe: 'D' }).dpe).toBeUndefined();
    expect(screenTexts({ ...base, vertical: 'immo' }).dpe).toBeUndefined();
  });

  it('leaves out blank texts', () => {
    const texts = screenTexts({ ...base, overlays: { title: 'Maison', subtitle: ' ', price: '', contact: '  ' } });
    expect(texts).toEqual({ title: 'Maison' });
  });

  it('prepares every text for display', () => {
    const texts = screenTexts({
      ...base,
      overlays: {
        title: "Maison d'architecte",
        subtitle: '2019 · 68\u202F000 km',
        price: '15\u202F990 €',
        contact: "Garage de l'Étang",
      },
    });
    expect(texts).toEqual({
      title: 'Maison d’architecte',
      subtitle: '2019 · 68\u00A0000 km',
      price: '15\u00A0990 €',
      contact: 'Garage de l’Étang',
    });
  });
});

describe('displayText', () => {
  it('draws the narrow no-break space of the data as a no-break space, visible in Inter', () => {
    expect(displayText('41\u202F000 kilomètres')).toBe('41\u00A0000 kilomètres');
    expect(displayText('Prix\u202F: 1\u202F250\u202F000 €.')).toBe('Prix\u00A0: 1\u00A0250\u00A0000 €.');
  });

  it('curls an apostrophe between two letters and leaves other quotes alone', () => {
    expect(displayText("Appel d'Urgence, l'annonce, aujourd'hui")).toBe('Appel d’Urgence, l’annonce, aujourd’hui');
    expect(displayText("Tous les détails sont dans l’annonce.")).toBe('Tous les détails sont dans l’annonce.');
    expect(displayText("'Neuve' 5' 12'")).toBe("'Neuve' 5' 12'");
  });

  it('leaves plain text unchanged', () => {
    expect(displayText('Peugeot 308 · 68 000 km')).toBe('Peugeot 308 · 68 000 km');
  });
});
