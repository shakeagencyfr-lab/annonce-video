/**
 * Models and prices (CLAUDE.md, "Stack"). Prices in USD per million tokens, to log the
 * real cost of each video in video_costs. Keys come from the environment only (rule 8).
 */
export const MODELS = {
  /** Listing reading, when structured data is not enough. */
  read: 'claude-haiku-4-5-20251001',
  /** Photo sorting (vision). */
  photos: 'claude-sonnet-5',
  /** Script writing. */
  script: 'claude-sonnet-5',
} as const;

export const CLAUDE_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
};

/**
 * ElevenLabs bills characters. The price per 1,000 characters depends on the plan:
 * set ELEVENLABS_USD_PER_1K_CHARS to the real one. The default matches the Creator
 * plan with a multilingual model (about 0.22 USD per 1,000 characters).
 */
export const ELEVENLABS_DEFAULT_USD_PER_1K_CHARS = 0.22;

/** Model with character-level timestamps and French support. */
export const ELEVENLABS_MODEL = 'eleven_multilingual_v2';

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example)`);
  return value;
}

export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} doit être un nombre positif, reçu « ${raw} »`);
  return n;
}
