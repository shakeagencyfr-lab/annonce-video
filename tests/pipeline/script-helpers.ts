import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { vi } from 'vitest';
import type { ClaudeClient, Language, Variant, VideoScript } from '@/lib/pipeline/types';
import { parseSheet } from '@/lib/sheet';

/** Shared by the script and fact check tests. */

export const auto = parseSheet(JSON.parse(readFileSync(join(__dirname, '../fixtures/sheets/auto-308.json'), 'utf8')));

type Draft = { segments: { kind: VideoScript['segments'][number]['kind']; facts: string[]; text: string }[]; overlays: VideoScript['overlays'] };
export type Answer = Record<Variant, Draft>;

/** A clean Claude answer for the 308 sheet: every fact comes from the sheet. */
export const cleanAnswer = (): Answer => JSON.parse(readFileSync(join(__dirname, '../fixtures/scripts/auto-308.json'), 'utf8'));

export function toScripts(answer: Answer, language: Language = 'fr'): Record<Variant, VideoScript> {
  return {
    social: { variant: 'social', language, ...answer.social },
    listing: { variant: 'listing', language, ...answer.listing },
  };
}

export const cleanScripts = () => toScripts(cleanAnswer());

export type ParseParams = {
  model: string;
  max_tokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  output_config: { effort?: string; format: { type: string; schema: Record<string, unknown>; parse: (text: string) => unknown } };
  [key: string]: unknown;
};

export type FakeAnswer = { json?: unknown; text?: string; stop_reason?: Anthropic.StopReason };

/**
 * Stands in for messages.parse, answering from one queue per model. Like the SDK, it
 * runs the format's parse on the text block.
 */
export function fakeClaude(answers: Record<string, FakeAnswer[]>) {
  const calls: ParseParams[] = [];
  const parse = vi.fn(async (params: ParseParams) => {
    calls.push({ ...params, messages: [...params.messages] });
    const answer = answers[params.model]?.shift();
    if (!answer) throw new Error(`appel inattendu à ${params.model}`);
    const text = answer.text ?? JSON.stringify(answer.json);
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: [{ type: 'text', text }],
      stop_reason: answer.stop_reason ?? 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      parsed_output: params.output_config.format.parse(text),
    };
  });
  return { client: { messages: { parse } } as unknown as ClaudeClient, calls };
}

/** A fetch for the real SDK that records request bodies and answers with the given texts. */
export function recordingFetch(texts: string[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const message = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: texts.shift() ?? '{}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 100 },
    };
    return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}
