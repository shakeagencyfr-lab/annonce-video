import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCues, SUBTITLE_MAX_CHARS, SUBTITLE_MAX_SEC } from '@/lib/pipeline/subtitles';
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

describe('buildCues', () => {
  it.each<Format>(['9x16', '16x9'])('keeps every line within the width of %s', (format) => {
    const cues = buildCues(timed(LONG), format);
    for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(SUBTITLE_MAX_CHARS[format]);
    // Nothing lost, nothing added.
    expect(cues.map((c) => c.text).join(' ')).toBe(LONG);
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
    const cues = buildCues(timed('Peugeot 308 de 2019 diesel'), '16x9', { maxChars: 12 });
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
        expect(cue.text.length).toBeLessThanOrEqual(SUBTITLE_MAX_CHARS[format]);
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
