import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCues, SUBTITLE_MAX_EM, SUBTITLE_MAX_SEC, textWidthEm } from '@/lib/pipeline/subtitles';
import { templateScripts } from '@/lib/pipeline/template-script';
import type { Format, SubtitleCue, VideoScript, WordTiming } from '@/lib/pipeline/types';
import { estimateVoiceover } from '@/lib/pipeline/voice';
import { parseSheet } from '@/lib/sheet';

const auto = parseSheet(JSON.parse(readFileSync(join(__dirname, '../fixtures/sheets/auto-308.json'), 'utf8')));

/** Words split on plain spaces, each lasting wordSec minus a short gap. */
function timed(text: string, wordSec = 0.3, gapSec = 0.05): WordTiming[] {
  return text.split(' ').map((word, i) => ({ word, start: i * wordSec, end: (i + 1) * wordSec - gapSec }));
}

const LONG =
  'Peugeot 308 de 2019. 68 000 kilomètres au compteur. Diesel, manuelle, 130 chevaux. ' +
  'Équipée : Caméra de recul, GPS, Régulateur de vitesse. Garantie 12 mois. Prix : 15 990 €. Contactez Garage des Tests.';

function expectWellTimed(cues: SubtitleCue[]) {
  cues.forEach((cue, i) => {
    expect(cue.end).toBeGreaterThanOrEqual(cue.start);
    const next = cues[i + 1];
    if (next) expect(next.start).toBeGreaterThanOrEqual(cue.end);
  });
}

describe('textWidthEm', () => {
  it('counts capitals and digits wider than lower case, and narrow glyphs narrower', () => {
    expect(textWidthEm('AUTOMOBILES')).toBeGreaterThan(textWidthEm('automobiles') * 1.15);
    expect(textWidthEm('2023')).toBeGreaterThan(textWidthEm('abcd'));
    expect(textWidthEm('ill')).toBeLessThan(textWidthEm('ann') * 0.6);
    expect(textWidthEm('')).toBe(0);
  });

  it('gives accented letters the width of their base letter', () => {
    expect(textWidthEm('Équipée')).toBe(textWidthEm('Equipee'));
    expect(textWidthEm('Ç')).toBe(textWidthEm('C'));
  });

  it('counts every kind of space the same', () => {
    expect(textWidthEm('68\u202F000')).toBe(textWidthEm('68 000'));
    expect(textWidthEm('68\u00A0000')).toBe(textWidthEm('68 000'));
  });

  it('is within a few percent of Inter ExtraBold', () => {
    // Sums of the advance widths of the font (@fontsource/inter, 800, latin), without kerning.
    const measured: [string, number][] = [
      ['Appelez MARTIN AUTOMOBILES.', 16.45],
      ['Équipée : Caméra de recul,', 13.23],
      ['68\u00A0000 kilomètres au compteur', 15.6],
      ['Tous les détails sont dans l’annonce.', 18.32],
    ];
    for (const [text, em] of measured) expect(Math.abs(textWidthEm(text) - em) / em).toBeLessThan(0.03);
  });
});

describe('buildCues', () => {
  it.each<Format>(['9x16', '16x9'])('keeps every line within the width of %s', (format) => {
    const cues = buildCues(timed(LONG), format);
    for (const cue of cues) expect(textWidthEm(cue.text)).toBeLessThanOrEqual(SUBTITLE_MAX_EM[format]);
    // Nothing lost, nothing added.
    expect(cues.map((c) => c.text).join(' ')).toBe(LONG);
  });

  it('cuts a line in capitals that the same length in lower case keeps whole (9:16)', () => {
    // 24 characters each: 12.8 em in lower case, 14.3 em with the shop name in capitals.
    const lower = 'Contactez Garage Martin.';
    const caps = 'Contactez GARAGE MARTIN.';
    expect(buildCues(timed(lower), '9x16').map((c) => c.text)).toEqual([lower]);
    expect(buildCues(timed(caps), '9x16').map((c) => c.text)).toEqual(['Contactez GARAGE', 'MARTIN.']);
    // 27 characters, within the former 28-character limit, but 16.5 em: two lines on screen.
    const cues = buildCues(timed('Appelez MARTIN AUTOMOBILES.'), '9x16');
    expect(cues.map((c) => c.text)).toEqual(['Appelez MARTIN', 'AUTOMOBILES.']);
    for (const cue of cues) expect(textWidthEm(cue.text)).toBeLessThanOrEqual(SUBTITLE_MAX_EM['9x16']);
    expect(buildCues(timed('Appelez MARTIN AUTOMOBILES.'), '16x9')).toHaveLength(1);
  });

  it('uses wider lines in 16:9 than in 9:16', () => {
    expect(buildCues(timed(LONG), '16x9').length).toBeLessThan(buildCues(timed(LONG), '9x16').length);
  });

  it('ends a cue at the end of each sentence', () => {
    const cues = buildCues(timed('Peugeot 308 de 2019. 68 000 kilomètres au compteur.'), '16x9');
    expect(cues.map((c) => c.text)).toEqual(['Peugeot 308 de 2019.', '68 000 kilomètres au compteur.']);
  });

  it('cuts a long line after a comma rather than before the last word', () => {
    expect(buildCues(timed('Diesel, manuelle, 130 chevaux.'), '9x16').map((c) => c.text)).toEqual([
      'Diesel, manuelle,',
      '130 chevaux.',
    ]);
    expect(buildCues(timed('Équipée : Caméra de recul, GPS, Régulateur de vitesse.'), '9x16').map((c) => c.text)).toEqual([
      'Équipée : Caméra de recul,',
      'GPS, Régulateur de vitesse.',
    ]);
    // Without a comma, the last word of a sentence is not left alone.
    expect(buildCues(timed('68 000 kilomètres au compteur.'), '9x16').map((c) => c.text)).toEqual([
      '68 000 kilomètres',
      'au compteur.',
    ]);
    // Not after a comma that would leave a fragment too short.
    expect(buildCues(timed('Oui, une voiture vraiment très économique au quotidien'), '9x16')[0]?.text).toBe(
      'Oui, une voiture vraiment',
    );
  });

  it('never keeps a cue longer than the maximum duration', () => {
    const slow = buildCues(timed('un deux trois quatre cinq six sept huit neuf dix', 1, 0), '16x9');
    expect(slow.map((c) => c.text)).toEqual(['un deux trois', 'quatre cinq six', 'sept huit neuf', 'dix']);
    for (const cues of [slow, buildCues(timed(LONG, 0.45), '16x9')]) {
      for (const cue of cues) expect(cue.end - cue.start).toBeLessThanOrEqual(SUBTITLE_MAX_SEC + 1e-9);
    }
  });

  it('times a cue from its first word to its last and closes short gaps', () => {
    const words: WordTiming[] = [
      { word: 'Peugeot', start: 0.1, end: 0.5 },
      { word: '308.', start: 0.55, end: 1 },
      { word: 'Diesel.', start: 1.1, end: 1.6 },
      { word: 'Garantie.', start: 2.4, end: 3 },
    ];
    expect(buildCues(words, '9x16')).toEqual([
      { text: 'Peugeot 308.', start: 0.1, end: 1.1 },
      { text: 'Diesel.', start: 1.1, end: 1.6 },
      { text: 'Garantie.', start: 2.4, end: 3 },
    ]);
  });

  it('never overlaps, even on overlapping word timings', () => {
    const words: WordTiming[] = [
      { word: 'Première', start: 0, end: 0.6 },
      { word: 'main.', start: 0.5, end: 1.2 },
      { word: 'Carnet', start: 1, end: 1.5 },
      { word: 'complet.', start: 1.4, end: 2 },
    ];
    const cues = buildCues(words, '9x16');
    expect(cues.map((c) => c.text)).toEqual(['Première main.', 'Carnet complet.']);
    expect(cues[0]).toMatchObject({ start: 0, end: 1 });
    expectWellTimed(cues);
  });

  it('trims words, skips empty ones and keeps an overlong word on its own line', () => {
    const words: WordTiming[] = [
      { word: '  Anticonstitutionnellement-garanti ', start: 0, end: 1 },
      { word: ' ', start: 1, end: 1.1 },
      { word: 'oui ', start: 1.1, end: 1.4 },
    ];
    expect(buildCues(words, '9x16').map((c) => c.text)).toEqual(['Anticonstitutionnellement-garanti', 'oui']);
    expect(buildCues([], '9x16')).toEqual([]);
  });

  it('accepts other limits', () => {
    const cues = buildCues(timed('Peugeot 308 de 2019 diesel'), '16x9', { maxEm: 7 });
    expect(cues.map((c) => c.text)).toEqual(['Peugeot 308', 'de 2019', 'diesel']);
  });

  it('subtitles the offline voice-over of the template script', () => {
    for (const [variant, format] of [
      ['social', '9x16'],
      ['listing', '16x9'],
    ] as const) {
      const voiceover = estimateVoiceover(templateScripts(auto, 'fr')[variant]);
      const cues = buildCues(voiceover.words, format);
      const again = buildCues(voiceover.words, format);
      expect(again).toEqual(cues);
      expectWellTimed(cues);
      expect(cues[0]?.start).toBe(0);
      expect(cues.at(-1)?.end).toBeLessThanOrEqual(voiceover.durationSec);
      for (const cue of cues) {
        expect(cue.text).toBe(cue.text.trim());
        expect(textWidthEm(cue.text)).toBeLessThanOrEqual(SUBTITLE_MAX_EM[format]);
        expect(cue.end - cue.start).toBeLessThanOrEqual(SUBTITLE_MAX_SEC + 1e-9);
      }
    }
  });

  it('never splits a number written with plain spaces across two cues', () => {
    // Split on plain spaces, the 9:16 line would end with "68" (27 characters) and the next start with "000".
    const script: VideoScript = {
      variant: 'social',
      language: 'fr',
      segments: [{ kind: 'point', text: 'La Peugeot 308 de 2019 a 68 000 km.', facts: ['year', 'mileageKm'] }],
      overlays: { title: 'Peugeot 308' },
    };
    const cues = buildCues(estimateVoiceover(script).words, '9x16');
    expect(cues.map((c) => c.text)).toEqual(['La Peugeot 308 de 2019 a', '68\u00A0000 km.']);
  });
});
