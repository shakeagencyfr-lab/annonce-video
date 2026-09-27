import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MODELS } from '../config';
import { claudeUsageLine } from '../costs';
import {
  HOOK_MAX_WORDS,
  scriptFactsRetryPrompt,
  scriptFormatRetryPrompt,
  scriptSystemPrompt,
  scriptUserPrompt,
  spokenWordTarget,
} from '../prompts/script.v1';
import type { Sheet } from '../sheet';
import {
  answerText,
  checkScripts,
  describeProblem,
  factSource,
  languageRules,
  safeZodFormat,
  ScriptError,
  SPACES,
  unsupportedProblem,
  VARIANTS,
  verifyWithClaude,
  type Problem,
} from './factcheck';
import type { ClaudeClient, Language, PhotoSelection, UsageLine, Variant, VideoScript } from './types';

export { ScriptError } from './factcheck';

// ---------------------------------------------------------------------------
// Answer format
// ---------------------------------------------------------------------------

/** facts before text: the model picks the sheet fields, then writes from them. */
const SegmentSchema = z.object({
  kind: z.enum(['hook', 'point', 'cta']),
  facts: z.array(z.string()),
  text: z.string().min(1),
});

const DraftSchema = z.object({
  segments: z.array(SegmentSchema).min(1),
  overlays: z.object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    price: z.string().optional(),
    contact: z.string().optional(),
  }),
});

/** Both variants in one answer, so they tell the same facts. */
const AnswerSchema = z.object({ social: DraftSchema, listing: DraftSchema });

type Answer = z.infer<typeof AnswerSchema>;
type Draft = z.infer<typeof DraftSchema>;

const THOUSANDS = new RegExp(`(\\d)[${SPACES}.](?=\\d{3}(?!\\d))`, 'g');

/** Words as spoken: "68 000" counts as one. */
export function countWords(text: string): number {
  const joined = text.replace(THOUSANDS, '$1');
  return joined.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

type Problems = {
  /** The answer cannot be used. */
  hard: string[];
  /** Length off target: asked once more, then accepted (the fact check is what matters). */
  soft: string[];
};

function answerProblems(answer: Answer, vertical: Sheet['vertical'], language: Language): Problems {
  const hard: string[] = [];
  const soft: string[] = [];
  const target = spokenWordTarget(vertical, language);
  for (const variant of VARIANTS) {
    const segments = answer[variant].segments;
    const kinds = segments.map((s) => s.kind);
    const count = (kind: string) => kinds.filter((k) => k === kind).length;
    if (kinds[0] !== 'hook' || count('hook') !== 1) hard.push(`${variant} : une seule accroche (kind "hook"), en premier segment`);
    if (kinds.at(-1) !== 'cta' || count('cta') !== 1) hard.push(`${variant} : un seul appel à l’action (kind "cta"), en dernier segment`);
    if (count('point') === 0) hard.push(`${variant} : au moins un atout (kind "point")`);
    if (segments.some((s) => !s.text.trim())) hard.push(`${variant} : un segment sans texte`);
    if (!answer[variant].overlays.title.trim()) hard.push(`${variant} : overlays.title vide`);

    // A little tolerance on counts: a retry costs more than a slightly long hook.
    const hook = segments[0];
    const hookWords = hook?.kind === 'hook' ? countWords(hook.text) : 0;
    if (hookWords > HOOK_MAX_WORDS + 2) soft.push(`${variant} : accroche de ${hookWords} mots, ${HOOK_MAX_WORDS} au plus`);
    const words = countWords(segments.map((s) => s.text).join(' '));
    if (words < Math.floor(target.min * 0.8) || words > Math.ceil(target.max * 1.2)) {
      soft.push(`${variant} : voix off de ${words} mots, vise ${target.min} à ${target.max} mots`);
    }
  }
  return { hard, soft };
}

function toScript(draft: Draft, variant: Variant, language: Language): VideoScript {
  const overlays: VideoScript['overlays'] = { title: draft.overlays.title.trim() };
  for (const key of ['subtitle', 'price', 'contact'] as const) {
    const value = draft.overlays[key]?.trim();
    if (value) overlays[key] = value;
  }
  const segments = draft.segments.map((s) => ({ kind: s.kind, text: s.text.trim(), facts: s.facts.map((f) => f.trim()) }));
  return { variant, language, segments, overlays };
}

/** A script back in the answer format, to show Claude its previous answer. */
function toDraft(script: VideoScript): Draft {
  return {
    segments: script.segments.map((s) => ({ kind: s.kind, facts: s.facts, text: s.text })),
    overlays: script.overlays,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type ScriptDeps = { client: ClaudeClient; language: Language; model?: string };

/** A second draft: the previous scripts and what the fact check found in them. */
export type ScriptRevision = { previous: Record<Variant, VideoScript>; problems: readonly string[] };

/**
 * Writes both variants in one Claude call (CLAUDE.md, "Pipeline vidéo", step 2), from
 * the sheet only. The answer is validated; one retry with the problems listed, then a
 * French ScriptError that carries the cost of the calls made. A draft that is only off
 * length is asked once more, and kept if the retry comes back unusable. With a
 * revision, the conversation goes on from the previous draft.
 */
export async function writeScripts(
  sheet: Sheet,
  selection: PhotoSelection,
  deps: ScriptDeps & { revision?: ScriptRevision },
): Promise<{ scripts: Record<Variant, VideoScript>; usage: UsageLine[] }> {
  const model = deps.model ?? MODELS.script;
  const { language, revision } = deps;
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: scriptUserPrompt({
        sheetJson: JSON.stringify(factSource(sheet), null, 2),
        photoRoles: selection.selected.map((p) => p.role),
        language,
      }),
    },
  ];
  if (revision) {
    const previous = { social: toDraft(revision.previous.social), listing: toDraft(revision.previous.listing) };
    messages.push(
      { role: 'assistant', content: JSON.stringify(previous) },
      { role: 'user', content: scriptFactsRetryPrompt(revision.problems) },
    );
  }
  const format = safeZodFormat(AnswerSchema);
  const usage: UsageLine[] = [];
  const done = (answer: Answer) => ({
    scripts: { social: toScript(answer.social, 'social', language), listing: toScript(answer.listing, 'listing', language) },
    usage,
  });
  /** A first answer whose only fault is its length: kept if the retry comes back worse. */
  let usable: Answer | undefined;

  for (let attempt = 1; ; attempt++) {
    const res = await deps.client.messages.parse({
      model,
      max_tokens: 16000,
      system: scriptSystemPrompt({ vertical: sheet.vertical, language }),
      messages,
      output_config: { format, effort: 'medium' },
    });
    usage.push(claudeUsageLine('script', model, res.usage));
    const stopped =
      res.stop_reason === 'refusal'
        ? 'Claude a refusé d’écrire le script de cette annonce.'
        : res.stop_reason === 'max_tokens'
          ? 'Script interrompu : réponse de Claude trop longue (max_tokens).'
          : null;
    if (stopped && usable) return done(usable);
    if (stopped) throw new ScriptError(stopped, usage);

    const parsed = res.parsed_output ?? { ok: false, problems: ['aucune réponse JSON'] };
    const problems = parsed.ok ? answerProblems(parsed.value, sheet.vertical, language) : { hard: parsed.problems, soft: [] };
    const acceptable = problems.hard.length === 0 && (problems.soft.length === 0 || attempt > 1);
    if (parsed.ok && acceptable) return done(parsed.value);
    if (attempt > 1) {
      if (usable) return done(usable);
      throw new ScriptError(`Script invalide après une relance : ${[...problems.hard, ...problems.soft].join(' ; ')}`, usage);
    }
    if (parsed.ok && problems.hard.length === 0) usable = parsed.value;
    messages.push(
      { role: 'assistant', content: answerText(res) },
      { role: 'user', content: scriptFormatRetryPrompt([...problems.hard, ...problems.soft]) },
    );
  }
}

// ---------------------------------------------------------------------------
// Writing + fact check
// ---------------------------------------------------------------------------

/** Thrown when the scripts still hold unsupported information after the retry: no video is made. */
export class ScriptCheckError extends ScriptError {
  constructor(
    readonly problems: Problem[],
    /** Every Claude call made, so the failed attempt's cost is still logged. */
    usage: UsageLine[],
  ) {
    super(
      `Script refusé : informations non justifiées par la fiche, même après une relance.\n- ${problems.map(describeProblem).join('\n- ')}`,
      usage,
    );
    this.name = 'ScriptCheckError';
  }
}

export type CheckedScriptDeps = ScriptDeps & { judgeModel?: string };

/**
 * Writes the scripts, then checks them against the sheet (deterministic checks and a
 * Haiku judge). When something is not supported, Claude gets one retry with the list;
 * if problems remain, throws a ScriptCheckError: a video is never made with invented
 * information (rule 3). `problems` lists what the first draft had and the retry fixed.
 */
export async function produceCheckedScripts(
  sheet: Sheet,
  selection: PhotoSelection,
  deps: CheckedScriptDeps,
): Promise<{ scripts: Record<Variant, VideoScript>; usage: UsageLine[]; problems: Problem[] }> {
  languageRules(deps.language); // no call to Claude for a language the check cannot read
  const usage: UsageLine[] = [];
  /** A failed step's error carries its own calls: add those made before it. */
  const step = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      throw err instanceof ScriptError ? new ScriptError(err.message, [...usage, ...err.usage]) : err;
    }
  };
  const review = async (scripts: Record<Variant, VideoScript>): Promise<Problem[]> => {
    const found = checkScripts(scripts, sheet);
    const judge = await step(() => verifyWithClaude(scripts, sheet, { client: deps.client, model: deps.judgeModel }));
    usage.push(judge.usage);
    return [...found, ...judge.unsupported.map((u) => unsupportedProblem(u, scripts))];
  };

  const first = await step(() => writeScripts(sheet, selection, deps));
  usage.push(...first.usage);
  const problems = await review(first.scripts);
  if (problems.length === 0) return { scripts: first.scripts, usage, problems };

  const revision = { previous: first.scripts, problems: problems.map(describeProblem) };
  const second = await step(() => writeScripts(sheet, selection, { ...deps, revision }));
  usage.push(...second.usage);
  const remaining = await review(second.scripts);
  if (remaining.length > 0) throw new ScriptCheckError(remaining, usage);
  return { scripts: second.scripts, usage, problems };
}
