import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { MODELS } from '../config';
import { claudeUsageLine } from '../costs';
import { factcheckRetryPrompt, factcheckSystemPrompt, factcheckUserPrompt } from '../prompts/factcheck.v1';
import type { Sheet, VehicleSheet } from '../sheet';
import { formatNumber } from './template-script';
import type { ClaudeClient, Language, UsageLine, Variant, VideoScript } from './types';

/**
 * Rule 3 (no invention): every number, contact and claim of a script must come from
 * the sheet. checkScripts runs deterministic checks; verifyWithClaude asks a judge
 * (Haiku) for what they cannot see, such as a paraphrased quality.
 */

export const VARIANTS: readonly Variant[] = ['social', 'listing'];

export type ProblemKind = 'fact-path' | 'number' | 'price' | 'phone' | 'contact' | 'claim' | 'unsupported';

export type Problem = {
  variant: Variant;
  /** Where in the script: "segments[2].text", "segments[2].facts", "overlays.price"… */
  where: string;
  kind: ProblemKind;
  /** French, readable by the user and by Claude on the retry. */
  message: string;
};

export function describeProblem(p: Problem): string {
  return `[${p.variant}] ${p.where} : ${p.message}`;
}

// ---------------------------------------------------------------------------
// The sheet as the only source of facts
// ---------------------------------------------------------------------------

/** Sheet fields that are never facts for a video: technical, or legal identifiers. */
const NOT_FACTS = new Set(['photos', 'sourceUrl', 'platform', 'sellerSiren', 'agencySiret']);

/** What Claude receives as the sheet: every field except those that are not facts. */
export function factSource(sheet: Sheet): Record<string, unknown> {
  return Object.fromEntries(Object.entries(sheet).filter(([key]) => !NOT_FACTS.has(key)));
}

const FACT_PATH = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[\d+\])*$/;

/** Arrays are read by index only, objects by key only: "equipment.length" is not a fact. */
function resolvePath(root: unknown, path: string): unknown {
  let value = root;
  for (const [, key, index] of path.matchAll(/([A-Za-z_]\w*)|\[(\d+)\]/g)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) !== (index !== undefined)) return undefined;
    const k = key ?? index ?? '';
    if (!Object.hasOwn(value, k)) return undefined;
    value = (value as Record<string, unknown>)[k];
  }
  return value;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function field(sheet: Sheet, key: string): unknown {
  return (sheet as Record<string, unknown>)[key];
}

/** String values of the given fields, arrays flattened. */
function strings(sheet: Sheet, keys: readonly string[]): string[] {
  return keys.flatMap((key) => {
    const value = field(sheet, key);
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    return [];
  });
}

// ---------------------------------------------------------------------------
// Numbers, phones, text folding
// ---------------------------------------------------------------------------

/** Spaces that may group thousands: plain, no-break, narrow no-break, thin. */
export const SPACES = ' \u00a0\u202f\u2009';

/**
 * A number as written in a script or a sheet: digits, thousands grouped by a space
 * (see SPACES) or a dot (68 000, 68\u202f000, 15.990), and an optional decimal part
 * (64,7; 1.2 when the dot is not followed by 3 digits). A grouped number starts on
 * its own: in "A3 150 ch" the 3 belongs to the model name. The same reading applies
 * to both sides.
 */
const NUMBER = new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,3}(?:[${SPACES}.]\\d{3})+(?!\\d)(?:,\\d+)?|\\d+(?:[.,]\\d+)?`, 'gu');
const GROUPED = new RegExp(`^\\d{1,3}(?:[${SPACES}.]\\d{3})+(?:,\\d+)?$`);
const GROUP_SEPARATOR = new RegExp(`[${SPACES}.]`);

type FoundNumber = {
  raw: string;
  /** Position in the text read. */
  index: number;
  value: number;
  /**
   * The groups read as separate numbers, when plain spaces may separate them ("308 130":
   * the model and the power). Only the sheet side uses them: a script must not write
   * such a sequence, which the viewer and the voice read as one number (308 130).
   */
  parts: number[] | null;
};

const decimal = (raw: string) => Number(raw.replace(',', '.'));

export function findNumbers(text: string): FoundNumber[] {
  return [...text.matchAll(NUMBER)].map(({ 0: raw, index }) => {
    if (!GROUPED.test(raw)) return { raw, index, value: decimal(raw), parts: null };
    const groups = raw.split(GROUP_SEPARATOR);
    // "70 000" is one number; "308 130" may be two. A group starting with 0 never starts
    // a number, and a no-break space or a dot always groups thousands.
    const splittable = /^[\d ]+$/.test(raw) && groups.slice(1).every((g) => !g.startsWith('0'));
    return { raw, index, value: decimal(groups.join('')), parts: splittable ? groups.map(decimal) : null };
  });
}

/** Phone-like: starts with + or 0, 9 to 15 digits with usual separators. */
const PHONE = new RegExp(`(?:\\+|\\b0)\\d(?:[${SPACES}.()-]*\\d){7,13}`, 'g');

export function findPhones(text: string): string[] {
  return [...text.matchAll(PHONE)].map(([raw]) => raw);
}

const stripPhones = (text: string) => text.replace(PHONE, ' ');

/** +33 6 12 34 56 78 and 06.12.34.56.78 are the same number. */
const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-9);

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Every number the sheet states (phones apart), to which a script's numbers must belong. */
export function sheetNumbers(sheet: Sheet): number[] {
  const out: number[] = [];
  for (const [key, value] of Object.entries(sheet)) {
    if (NOT_FACTS.has(key) || key === 'phone') continue;
    if (typeof value === 'number') out.push(value);
    const texts: string[] =
      typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    for (const text of texts) {
      for (const n of findNumbers(stripPhones(text))) out.push(n.value, ...(n.parts ?? []));
    }
  }
  return out;
}

/**
 * Lowercase without accents, curly apostrophes and special spaces made plain, one
 * character for one: a match index in the folded text is valid in the original.
 * Checks compose their texts first (see `composed`) so that "é" is one character.
 */
export function fold(text: string): string {
  return Array.from(text, (c) => {
    if (c === '’' || c === '‘') return "'";
    if (SPACES.includes(c)) return ' ';
    const plain = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    return plain.length === c.length ? plain : c;
  }).join('');
}

/** A sheet or a script may come decomposed (e + U+0301): every check reads composed text. */
const composed = (text: string) => text.normalize('NFC');

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Blanks out whole-word occurrences of the given folded values, keeping the length:
 * "lyon" goes, "lyonnais" stays. Longest first, so "garage des tests" wins over "tests".
 */
function blankOut(folded: string, values: readonly string[]): string {
  let out = folded;
  for (const value of values.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const word = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'gu');
    out = out.replace(word, (m) => ' '.repeat(m.length));
  }
  return out;
}

/** Web or e-mail addresses in folded text: like a phone, they must come from the sheet. */
const WEB = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b(?:https?:\/\/|www\.)[^\s,;]+|\b[\w-]+\.(?:fr|com|ch|net|org|eu|be|lu|de|it|nl)\b/g;

export function findWebAddresses(folded: string): string[] {
  return [...folded.matchAll(WEB)].map(([raw]) => raw.replace(/[.:!?)]+$/, ''));
}

// ---------------------------------------------------------------------------
// Language rules (data)
// ---------------------------------------------------------------------------

/**
 * A claim the script may only make when the sheet says it. Patterns run on folded
 * text (lowercase, no accents).
 */
export type ClaimRule = {
  label: string;
  pattern: RegExp;
  /** What the sheet's text must contain; defaults to pattern. */
  evidence: RegExp;
  /** Sheet fields whose presence is evidence enough (e.g. warranty). */
  fields: readonly string[];
};

export type LanguageRules = {
  /** Words and symbols that give a price away (forbidden in the "listing" variant). */
  priceWords: RegExp;
  /** How each currency is written: the "social" variant may only name the sheet's. */
  currencies: Record<VehicleSheet['currency'], RegExp>;
  /** Numbers written in words, which the digit check cannot verify. */
  spelledNumbers: RegExp;
  /** Words allowed in the contact overlay besides the sheet's values. */
  contactWords: readonly string[];
  claims: readonly ClaimRule[];
};

const claim = (label: string, pattern: RegExp, evidence: RegExp = pattern, fields: readonly string[] = []): ClaimRule => ({
  label,
  pattern,
  evidence,
  fields,
});

const FRENCH: LanguageRules = {
  // "Euro 6" is an emission standard, not money.
  priceWords: /€|\b(?:euros|eur|chf|francs?|prix|tarifs?)\b|\beuro\b(?! ?\d)/,
  currencies: { EUR: /€|\b(?:euros|eur)\b|\beuro\b(?! ?\d)/, CHF: /\b(?:chf|francs?)\b/ },
  spelledNumbers:
    /\b(?:deux|trois|quatre|cinq|six|sept|huit|dix|onze|douze|quinze|vingt|trente|quarante|cinquante|soixante|cents?|mille|millions?)\b/,
  contactWords: ['tel', 'telephone', 'a', 'au'],
  claims: [
    claim('garantie', /\bgaranti(?:e|es|s)?\b/, /\bgaranti/, ['warranty']),
    claim('première main', /\b(?:premiere|1re|1ere) main\b|\b(?:premier|seul|unique) proprietaire\b/),
    claim('faible kilométrage', /\b(?:faible|petit|bas) kilometrage\b|\bpeu (?:de )?kilometres\b|\bpeu roulee?\b/),
    claim('entretien', /\bentretien\b|\bentretenue?s?\b|\bcarnet\b/),
    claim('factures', /\bfactures?\b/),
    claim('historique', /\bhistorique\b/),
    claim('non-fumeur', /\bnon[ -]?fumeurs?\b/),
    claim('état impeccable', /\bimpeccable(?:s|ment)?\b/),
    claim('parfait état', /\bparfait etat\b|\betat parfait\b/),
    claim('excellent état', /\bexcellent etat\b|\betat excellent\b/),
    claim('très bon état', /\btres bon etat\b/),
    claim('bon état', /\bbon etat\b/),
    claim('comme neuf', /\bcomme neu(?:f|ve)s?\b|\betat neuf\b|\bquasi[ -]neu(?:f|ve)\b/),
    claim('irréprochable', /\birreprochables?\b/),
    claim('révisé', /\brevisee?s?\b|\brevision\b/, /\brevis/),
    claim('faible consommation', /\b(?:faible|petite|basse) consommation\b|\beconome\b|\bsobre\b|\bpeu gourmande?\b|\beconomique\b/),
    claim('jamais accidenté', /\b(?:jamais|non|aucun|sans|zero) accident/),
    claim('contrôle technique', /\bcontrole technique\b|\bct\b/),
    claim('fiabilité', /\bfiab(?:le|les|ilite)\b|\brobustes?\b/),
    claim('idéal pour…', /\bideale?s?\b|\bparfaite? pour\b/),
    claim('usage familial', /\bfamille\b|\bfamilia(?:l|le|les|ux)\b/),
    claim('spacieux', /\bspacieu(?:x|se|ses)\b/),
    claim('toutes options', /\b(?:toutes|full) options?\b|\bsurequipee?\b/),
    claim('qualités de conduite', /\bconfortable\b|\bagreable a conduire\b|\bplaisir de conduite\b|\bsportive?\b|\bdynamique\b|\bnerveuse?\b/),
    claim('rare ou exceptionnel', /\brares?\b|\bexceptionnel(?:le)?s?\b|\bunique\b/),
    claim('bonne affaire', /\baffaire\b|\ba saisir\b|\bimbattable\b/),
    claim('lumineux', /\blumine(?:ux|use|uses)\b|\bluminosite\b|\bensoleillee?s?\b/),
    claim('calme', /\bcalmes?\b|\bpaisible/),
    claim('sans vis-à-vis', /\bsans vis[ -]a[ -]vis\b/),
    claim('rénové', /\brenovee?s?\b|\brenovation\b|\brefaite?s? a neuf\b/, /\brenov|\brefait/),
    claim('vue', /\bvue (?:sur (?:la )?mer|mer|degagee|imprenable|panoramique)\b/),
    claim(
      'proximité',
      /\bproche (?:de |des |du )?(?:commerces|ecoles|transports|centre|gare|plage|metro|tram)|\bproximite\b|\ba deux pas\b/,
      /\bproche\b|\bproximite\b|\ba deux pas\b|\ba \d+ ?(?:min|minutes|m)\b/,
    ),
    claim('quartier recherché', /\b(?:quartier|secteur|emplacement) (?:recherche|prise|ideal|privilegie|de choix)\b/),
  ],
};

/** V1 is French. Another language needs its rules here before its videos can be checked. */
export const LANGUAGE_RULES: Partial<Record<Language, LanguageRules>> = { fr: FRENCH };

export function languageRules(language: Language): LanguageRules {
  const rules = LANGUAGE_RULES[language];
  if (!rules) {
    throw new Error(`Vérification des faits indisponible en « ${language} » : ajouter ses règles dans lib/pipeline/factcheck.ts`);
  }
  return rules;
}

/** Sheet text where a claim must be found to be allowed. */
const EVIDENCE_FIELDS = ['title', 'version', 'fuel', 'gearbox', 'warranty', 'description', 'equipment', 'propertyType', 'floor', 'features'];

/**
 * Names the script may say as they are, even when they hold a claim or a number word:
 * "Garage Idéal", "Six-Fours-les-Plages". They are blanked out before those checks.
 */
const NAME_FIELDS = ['make', 'model', 'sellerName', 'agencyName', 'city', 'district'];

const foldedValues = (sheet: Sheet, keys: readonly string[]) => strings(sheet, keys).map((v) => fold(composed(v).trim()));

/** Every text of the sheet that the model receives, folded, to look addresses up in. */
function sheetText(sheet: Sheet): string {
  const texts = Object.values(factSource(sheet)).flatMap((value) =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [],
  );
  return fold(composed(texts.join('\n')));
}

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

type Located = { where: string; text: string };

/** Texts checked for numbers and claims. The price overlay has its own check. */
function textsOf(script: VideoScript, variant: Variant): Located[] {
  const texts = script.segments.map((s, i) => ({ where: `segments[${i}].text`, text: s.text }));
  const { title, subtitle, contact } = script.overlays;
  texts.push({ where: 'overlays.title', text: title });
  if (subtitle !== undefined) texts.push({ where: 'overlays.subtitle', text: subtitle });
  if (contact !== undefined && variant === 'social') texts.push({ where: 'overlays.contact', text: contact });
  return texts;
}

function factPathProblem(sheet: Sheet, path: string, variant: Variant): Pick<Problem, 'kind' | 'message'> | null {
  if (!FACT_PATH.test(path)) {
    return { kind: 'fact-path', message: `chemin « ${path} » illisible (attendu : « mileageKm », « equipment[1] »)` };
  }
  const root = /^[A-Za-z_]\w*/.exec(path)?.[0] ?? '';
  if (NOT_FACTS.has(root)) return { kind: 'fact-path', message: `« ${path} » n’est pas une information pour la vidéo` };
  if (variant === 'listing' && root === 'price') return { kind: 'price', message: 'pas de prix dans la variante annonce' };
  if (variant === 'listing' && root === 'phone') return { kind: 'phone', message: 'pas de téléphone dans la variante annonce' };
  if (!isPresent(resolvePath(sheet, path))) return { kind: 'fact-path', message: `« ${path} » absent de la fiche` };
  return null;
}

const WORD_SEPARATORS = /[\s·•|,;:/()–—-]+/;

function contactLeftover(contact: string, sheet: Sheet, rules: LanguageRules): string {
  const values = foldedValues(sheet, ['sellerName', 'agencyName', 'city', 'district', 'postalCode']);
  return blankOut(fold(composed(stripPhones(contact))), values)
    .split(WORD_SEPARATORS)
    .filter((word) => word && !rules.contactWords.includes(word.replace(/\.$/, '')))
    .join(' ');
}

/** The price overlay holds the sheet's amount and currency, nothing else ("15 990 €"). */
function priceOverlayProblem(price: string, sheet: Sheet, rules: LanguageRules): string | null {
  if (sheet.price === undefined) return 'la fiche n’indique pas de prix';
  const text = composed(price);
  const numbers = findNumbers(text);
  const amount = numbers[0];
  const expected = `${formatNumber(sheet.price)} (${sheet.currency})`;
  if (numbers.length !== 1 || !amount || !same(amount.value, sheet.price)) {
    return `« ${price} » ne correspond pas au prix de la fiche : ${expected}`;
  }
  const folded = fold(text);
  const otherCurrency = Object.entries(rules.currencies).some(([code, pattern]) => code !== sheet.currency && pattern.test(folded));
  if (otherCurrency || !rules.currencies[sheet.currency].test(folded)) {
    return `devise de « ${price} » différente de la fiche : ${expected}`;
  }
  const rest = folded
    .replace(fold(amount.raw), ' ')
    .split(WORD_SEPARATORS)
    .filter((word) => word && !rules.priceWords.test(word.replace(/\.$/, '')));
  return rest.length > 0 ? `« ${rest.join(' ')} » : le prix à l’écran ne contient que le montant et la devise (${expected})` : null;
}

/** Currency right after a number, or right before its first digit (kept for "Euro 6"). */
const currencyAround = (rules: LanguageRules) =>
  Object.values(rules.currencies).map((pattern) => ({
    after: new RegExp(`^\\s*(?:${pattern.source})`),
    before: new RegExp(`(?:${pattern.source})\\s*\\d$`),
  }));

/** A number written with a currency next to it: "15 990 €", "15 990 euros", "CHF 15 990". */
function isAmount(text: string, n: FoundNumber, rules: LanguageRules): boolean {
  const folded = fold(text);
  const before = folded.slice(0, n.index + 1);
  const after = folded.slice(n.index + n.raw.length);
  return currencyAround(rules).some((c) => c.after.test(after) || c.before.test(before));
}

function checkScript(script: VideoScript, variant: Variant, sheet: Sheet): Problem[] {
  const rules = languageRules(script.language);
  const problems: Problem[] = [];
  const add = (where: string, kind: ProblemKind, message: string) => problems.push({ variant, where, kind, message });
  const allowed = sheetNumbers(sheet);
  const isAllowed = (value: number) => allowed.some((a) => same(a, value));
  const sheetPhone = sheet.phone ? phoneKey(sheet.phone) : undefined;
  const evidence = fold(composed(strings(sheet, EVIDENCE_FIELDS).join('\n')));
  const names = foldedValues(sheet, NAME_FIELDS);
  const addresses = sheetText(sheet);

  // (a) facts paths resolve to present values.
  script.segments.forEach((segment, i) => {
    for (const path of segment.facts) {
      const problem = factPathProblem(sheet, path, variant);
      if (problem) add(`segments[${i}].facts`, problem.kind, problem.message);
    }
    if (segment.kind === 'point' && segment.facts.length === 0) {
      add(`segments[${i}].facts`, 'fact-path', 'atout sans champ de la fiche : cite les champs utilisés');
    }
  });

  for (const located of textsOf(script, variant)) {
    const { where } = located;
    const text = composed(located.text);
    // (c, d) phones: none in the listing variant, only the sheet's in the social one.
    const phones = findPhones(text);
    for (const phone of phones) {
      if (variant === 'listing') add(where, 'phone', `numéro « ${phone} » : pas de téléphone dans la variante annonce`);
      else if (phoneKey(phone) !== sheetPhone) add(where, 'phone', `numéro « ${phone} » absent de la fiche`);
    }
    if (variant === 'listing' && sheetPhone && phones.length === 0 && text.replace(/\D/g, '').includes(sheetPhone)) {
      add(where, 'phone', 'le numéro de la fiche : pas de téléphone dans la variante annonce');
    }

    // (b) numbers belong to the sheet; (c) the price never appears in the listing variant;
    // (d) an amount of money in the social variant is the sheet's price, not another number.
    const withoutPhones = stripPhones(text);
    for (const n of findNumbers(withoutPhones)) {
      if (variant === 'listing' && sheet.price !== undefined && same(n.value, sheet.price)) {
        add(where, 'price', `prix « ${n.raw} » : pas de prix dans la variante annonce`);
      } else if (variant === 'social' && isAmount(withoutPhones, n, rules) && !(sheet.price !== undefined && same(n.value, sheet.price))) {
        add(where, 'price', `montant « ${n.raw} » différent du prix de la fiche${sheet.price === undefined ? ', qui n’en indique pas' : ''}`);
      } else if (isAllowed(n.value)) {
        continue;
      } else if (n.parts?.every(isAllowed)) {
        add(where, 'number', `« ${n.raw} » se lit comme un seul nombre : sépare les nombres par un mot ou une virgule`);
      } else {
        add(where, 'number', `« ${n.raw} » ne figure pas dans la fiche`);
      }
    }

    // Names ("Six-Fours-les-Plages", "Garage Idéal", "Euro Motors") are said as they are:
    // blanked out before looking for number words, money words and claims.
    const folded = fold(text);
    const unnamed = blankOut(folded, names);
    const at = (m: RegExpExecArray) => text.slice(m.index, m.index + m[0].length);
    const spelled = rules.spelledNumbers.exec(unnamed);
    if (spelled) add(where, 'number', `« ${at(spelled)} » : écris les nombres en chiffres pour qu’ils soient vérifiables`);
    if (variant === 'listing') {
      const money = rules.priceWords.exec(unnamed);
      if (money) add(where, 'price', `« ${at(money)} » : ni prix ni devise dans la variante annonce`);
    } else {
      for (const [code, pattern] of Object.entries(rules.currencies)) {
        const money = code === sheet.currency ? null : pattern.exec(unnamed);
        if (money) add(where, 'price', `« ${at(money)} » : la fiche donne le prix en ${sheet.currency}`);
      }
    }

    // The contact overlay has its own check (below), which covers addresses and claims.
    if (where === 'overlays.contact') continue;
    for (const address of findWebAddresses(folded)) {
      if (!addresses.includes(address)) add(where, 'contact', `adresse « ${address} » absente de la fiche`);
    }

    // (e) claims that need evidence in the sheet. Overlapping matches are reported once.
    const reported: [number, number][] = [];
    for (const rule of rules.claims) {
      const m = rule.pattern.exec(unnamed);
      if (!m) continue;
      if (rule.evidence.test(evidence) || rule.fields.some((f) => isPresent(field(sheet, f)))) continue;
      const [start, end] = [m.index, m.index + m[0].length];
      if (reported.some(([s, e]) => start < e && s < end)) continue;
      reported.push([start, end]);
      add(where, 'claim', `« ${at(m)} » (${rule.label}) : la fiche ne le dit pas`);
    }
  }

  // (c, d) overlays.
  const { price, contact } = script.overlays;
  if (variant === 'listing') {
    if (price !== undefined) add('overlays.price', 'price', 'pas de prix à l’écran dans la variante annonce');
    if (contact !== undefined) add('overlays.contact', 'contact', 'pas de contact à l’écran dans la variante annonce');
  } else {
    const priceProblem = price !== undefined ? priceOverlayProblem(price, sheet, rules) : null;
    if (priceProblem) add('overlays.price', 'price', priceProblem);
    const leftover = contact !== undefined ? contactLeftover(contact, sheet, rules) : '';
    if (leftover) add('overlays.contact', 'contact', `« ${leftover} » ne vient pas de la fiche (nom, ville, téléphone)`);
  }
  return problems;
}

/**
 * Deterministic fact check of both variants against the sheet (rule 3). Throws when
 * the scripts' language has no rules. An empty list means nothing was found.
 */
export function checkScripts(scripts: Record<Variant, VideoScript>, sheet: Sheet): Problem[] {
  return VARIANTS.flatMap((variant) => checkScript(scripts[variant], variant, sheet));
}

// ---------------------------------------------------------------------------
// Structured output helpers (shared with script.ts)
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/**
 * The SDK's zod format, whose parse reports problems instead of throwing: the SDK would
 * otherwise throw away the response, and with it the usage and the stop reason.
 */
export function safeZodFormat<S extends z.ZodType>(schema: S) {
  const { type, schema: jsonSchema } = zodOutputFormat(schema);
  return {
    type,
    schema: jsonSchema,
    parse: (text: string): Parsed<z.output<S>> => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, problems: ['la réponse n’est pas un JSON valide'] };
      }
      const result = schema.safeParse(json);
      if (result.success) return { ok: true, value: result.data };
      return { ok: false, problems: result.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`) };
    },
  };
}

export function answerText(message: Anthropic.Message): string {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return text || '(réponse vide)';
}

/**
 * A script step that failed after Claude calls, which are billed all the same: their
 * cost goes with the error so that a failed video's cost is still logged.
 */
export class ScriptError extends Error {
  constructor(
    message: string,
    readonly usage: UsageLine[],
  ) {
    super(message);
    this.name = 'ScriptError';
  }
}

type Usage = Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>;

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Judge (Claude Haiku)
// ---------------------------------------------------------------------------

const JudgeSchema = z.object({
  unsupported: z.array(
    z.object({
      variant: z.enum(['social', 'listing']),
      text: z.string(),
      claim: z.string(),
      reason: z.string(),
    }),
  ),
});

export type Unsupported = z.infer<typeof JudgeSchema>['unsupported'][number];

export type JudgeDeps = { client: ClaudeClient; model?: string };

/** What the judge reads: the spoken segments and the on-screen texts, without the facts paths. */
function judgeInput(scripts: Record<Variant, VideoScript>) {
  return Object.fromEntries(
    VARIANTS.map((variant) => [variant, { segments: scripts[variant].segments.map((s) => s.text), overlays: scripts[variant].overlays }]),
  );
}

/**
 * Asks Haiku to list every claim of the scripts that the sheet does not support. The
 * answer is validated; one retry with the problems listed, then a French error.
 */
export async function verifyWithClaude(
  scripts: Record<Variant, VideoScript>,
  sheet: Sheet,
  deps: JudgeDeps,
): Promise<{ unsupported: Unsupported[]; usage: UsageLine }> {
  const model = deps.model ?? MODELS.read;
  const format = safeZodFormat(JudgeSchema);
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: factcheckUserPrompt({
        sheetJson: JSON.stringify(factSource(sheet), null, 2),
        scriptsJson: JSON.stringify(judgeInput(scripts), null, 2),
        language: scripts.social.language,
      }),
    },
  ];
  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  for (let attempt = 1; ; attempt++) {
    // Haiku 4.5 takes neither effort nor adaptive thinking: only the output format.
    const res = await deps.client.messages.parse({
      model,
      max_tokens: 16000,
      system: factcheckSystemPrompt(),
      messages,
      output_config: { format },
    });
    usage = addUsage(usage, res.usage);
    const line = claudeUsageLine('script', model, usage);
    if (res.stop_reason === 'refusal') throw new ScriptError('Claude a refusé de vérifier le script de cette annonce.', [line]);
    if (res.stop_reason === 'max_tokens') {
      throw new ScriptError('Vérification du script interrompue : réponse de Claude trop longue (max_tokens).', [line]);
    }

    const parsed = res.parsed_output ?? { ok: false, problems: ['aucune réponse JSON'] };
    if (parsed.ok) return { unsupported: parsed.value.unsupported, usage: line };
    if (attempt > 1) throw new ScriptError(`Vérification du script invalide après une relance : ${parsed.problems.join(' ; ')}`, [line]);
    messages.push({ role: 'assistant', content: answerText(res) }, { role: 'user', content: factcheckRetryPrompt(parsed.problems) });
  }
}

/** A judge finding as a Problem, located in the script when its text is found. */
export function unsupportedProblem(u: Unsupported, scripts: Record<Variant, VideoScript>): Problem {
  const script = scripts[u.variant];
  const needle = fold(composed(u.text).trim());
  const texts = textsOf(script, u.variant);
  const found = needle ? texts.find((t) => fold(composed(t.text)).includes(needle)) : undefined;
  return {
    variant: u.variant,
    where: found?.where ?? 'texte',
    kind: 'unsupported',
    message: `« ${u.text} » : ${u.claim}, ${u.reason}`,
  };
}
