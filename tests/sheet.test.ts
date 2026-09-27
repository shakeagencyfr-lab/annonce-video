import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSheet } from '@/lib/sheet';
import { claudeUsageLine, summarizeCosts, ttsUsageLine } from '@/lib/costs';

describe('parseSheet', () => {
  it('accepts the shared auto fixture', () => {
    const sheet = parseSheet(JSON.parse(readFileSync(join(__dirname, 'fixtures/sheets/auto-308.json'), 'utf8')));
    expect(sheet.vertical).toBe('auto');
  });

  it('lists every invalid field', () => {
    expect(() => parseSheet({ vertical: 'auto', platform: 'x' })).toThrow(/sourceUrl[\s\S]*title/);
  });
});

describe('costs', () => {
  it('prices Claude and TTS usage and sums them like video_costs', () => {
    const script = claudeUsageLine('script', 'claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 100_000 });
    expect(script.costUsd).toBeCloseTo(2 + 1);
    const cached = claudeUsageLine('photos', 'claude-sonnet-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cached.costUsd).toBeCloseTo(2 * 1.25 + 2 * 0.1);
    const voice = ttsUsageLine(2000, 'eleven_multilingual_v2');
    expect(voice.costUsd).toBeCloseTo(0.44);
    const total = summarizeCosts([script, voice, { step: 'rendu', costUsd: 0 }]);
    expect(total.claudeCostUsd).toBeCloseTo(3);
    expect(total.ttsCharacters).toBe(2000);
    expect(total.totalUsd).toBeCloseTo(3.44);
  });

  it('refuses a model without a price', () => {
    expect(() => claudeUsageLine('script', 'claude-unknown', { input_tokens: 1, output_tokens: 1 })).toThrow(/Prix inconnu/);
  });
});
