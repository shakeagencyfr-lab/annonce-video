import { CLAUDE_PRICES_USD_PER_MTOK, ELEVENLABS_DEFAULT_USD_PER_1K_CHARS, numberEnv } from './config';
import type { UsageLine } from './pipeline/types';

type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** Cost of one Claude response from its usage block. Cache writes cost 1.25x, reads 0.1x. */
export function claudeUsageLine(step: UsageLine['step'], model: string, usage: ClaudeUsage): UsageLine {
  const price = CLAUDE_PRICES_USD_PER_MTOK[model];
  if (!price) throw new Error(`Prix inconnu pour le modèle ${model} : l'ajouter dans lib/config.ts`);
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cacheWrite + cacheRead;
  const costUsd =
    (usage.input_tokens * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.input * 0.1 + usage.output_tokens * price.output) /
    1_000_000;
  return { step, model, inputTokens, outputTokens: usage.output_tokens, costUsd };
}

export function ttsUsageLine(characters: number, model: string): UsageLine {
  const per1k = numberEnv('ELEVENLABS_USD_PER_1K_CHARS', ELEVENLABS_DEFAULT_USD_PER_1K_CHARS);
  return { step: 'voix', model, ttsCharacters: characters, costUsd: (characters / 1000) * per1k };
}

export type CostSummary = {
  lines: UsageLine[];
  claudeInputTokens: number;
  claudeOutputTokens: number;
  claudeCostUsd: number;
  ttsCharacters: number;
  ttsCostUsd: number;
  renderCostUsd: number;
  totalUsd: number;
};

/** Totals shaped like the video_costs table. */
export function summarizeCosts(lines: readonly UsageLine[]): CostSummary {
  const sum = (f: (l: UsageLine) => number) => lines.reduce((acc, l) => acc + f(l), 0);
  const isClaude = (l: UsageLine) => l.step !== 'voix' && l.step !== 'rendu';
  const claudeCostUsd = sum((l) => (isClaude(l) ? l.costUsd : 0));
  const ttsCostUsd = sum((l) => (l.step === 'voix' ? l.costUsd : 0));
  const renderCostUsd = sum((l) => (l.step === 'rendu' ? l.costUsd : 0));
  return {
    lines: [...lines],
    claudeInputTokens: sum((l) => (isClaude(l) ? l.inputTokens ?? 0 : 0)),
    claudeOutputTokens: sum((l) => (isClaude(l) ? l.outputTokens ?? 0 : 0)),
    claudeCostUsd,
    ttsCharacters: sum((l) => l.ttsCharacters ?? 0),
    ttsCostUsd,
    renderCostUsd,
    totalUsd: claudeCostUsd + ttsCostUsd + renderCostUsd,
  };
}

export function formatUsd(value: number): string {
  return `${value < 0.01 ? value.toFixed(4) : value.toFixed(3)} $`;
}
