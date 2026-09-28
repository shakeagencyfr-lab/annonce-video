import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { MODELS } from '../config';
import { claudeUsageLine } from '../costs';
import { factcheckRetryPrompt, factcheckSystemPrompt, factcheckUserPrompt } from '../prompts/factcheck.v2';
import type { Sheet, VehicleSheet } from '../sheet';
import { formatNumber } from './template-script';
import type { ClaudeClient, Language, UsageLine, Variant, VideoScript } from './types';

/**
 * Rule 3 (no invention): every number (with its unit), contact and claim of a script
 * must come from the sheet, and a segment says the equipment it cites. checkScripts
 * runs deterministic checks; verifyWithClaude asks a judge (Haiku) for what they
 * cannot see, such as a paraphrased quality.
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

/** Blanks phones out, keeping the length: positions in the text stay valid. */
const stripPhones = (text: string) => text.replace(PHONE, (m) => ' '.repeat(m.length));

/** +33 6 12 34 56 78 and 06.12.34.56.78 are the same number. */
const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-9);

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** The sheet's texts where numbers are read: every string field but the phone and what is not a fact. */
function numberTexts(sheet: Sheet): string[] {
  return Object.entries(sheet).flatMap(([key, value]) => {
    if (NOT_FACTS.has(key) || key === 'phone') return [];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  });
}

/** Every number the sheet states (phones apart), to which a script's numbers must belong. */
export function sheetNumbers(sheet: Sheet): number[] {
  const out = Object.values(sheet).filter((v): v is number => typeof v === 'number');
  for (const text of numberTexts(sheet)) {
    for (const n of findNumbers(stripPhones(text))) out.push(n.value, ...(n.parts ?? []));
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

const globalOf = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

/** Blanks out every match of a pattern, keeping the length. */
function blankMatches(folded: string, pattern: RegExp): string {
  return folded.replace(globalOf(pattern), (m) => ' '.repeat(m.length));
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
 * Where a claim's evidence is looked for:
 * - "sheet": the sheet's texts (EVIDENCE_FIELDS);
 * - "items": the listed items and the seller's text (ITEM_FIELDS), for options and services;
 * - "free": the seller's own words (see freeText), for qualities: an equipment label
 *   names a device, not a quality ("Capteur de luminosité" does not make a car bright).
 *   The script may still say a label as it is: labels are blanked out before these rules.
 */
export type EvidenceSource = 'sheet' | 'items' | 'free';

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
  source: EvidenceSource;
  /**
   * Phrases that look like the claim but are another one ("kilométrage garanti" is not
   * a warranty): blanked out of the script and of the sheet before this rule is tested.
   */
  ignore?: RegExp;
};

/** A unit a number may carry, in folded text. Values compare in the canonical unit: "1 an" is 12 months. */
export type UnitRule = {
  /** Folded words right after the number, as a pattern source ("ans?|annees?"). */
  words: string;
  /** Canonical key, shared by the languages ("month", "km"…). */
  unit: string;
  /** Value of one of these words in the canonical unit. */
  factor: number;
  /** Counted things: one word may come between ("3 grandes chambres"). */
  counted?: boolean;
  /** Written in lowercase only: "4,21 m", not the M of "Série 1 M Sport". */
  lowercase?: boolean;
};

export type LanguageRules = {
  /** Words and symbols that give a price away (forbidden in the "listing" variant). */
  priceWords: RegExp;
  /** How each currency is written: the "social" variant may only name the sheet's. */
  currencies: Record<VehicleSheet['currency'], RegExp>;
  /** "HT", "TTC"… in a text that says the price: the sheet never says which the price is. */
  priceQualifier: RegExp;
  /** Numbers written in words, which the digit check cannot verify. */
  spelledNumbers: RegExp;
  /**
   * Units of the numbers: a number followed by one of them must be in the sheet with
   * the same unit ("60 mois" is not "60 000 km"). Longest words first.
   */
  units: readonly UnitRule[];
  /** Text between the two ends of a range, which take the unit written after the second ("12 à 60 mois"). */
  rangeJoin: RegExp;
  /** Same for a range opened by a word before its first end ("entre 12 et 24 mois"). */
  rangeOpen: { before: RegExp; join: RegExp };
  /** Words allowed in the contact overlay besides the sheet's values. */
  contactWords: readonly string[];
  /**
   * The car's own warranty: `claim` (one of `claims`) says there is one; a duration said
   * in the same clause must be one the sheet gives as included: the warranty field's,
   * or one of `included` in the sheet's text (after claim.ignore).
   */
  warranty: { claim: ClaimRule; included: RegExp };
  claims: readonly ClaimRule[];
  /**
   * Words that do not tie a cited equipment or feature to the segment's text (a segment
   * citing "equipment[3]" must say one of its other words). Without this list, cited
   * items are not compared with the text: a translated script shares no word with the sheet.
   */
  citedItemStopWords?: ReadonlySet<string>;
};

const claim = (
  label: string,
  pattern: RegExp,
  evidence: RegExp = pattern,
  fields: readonly string[] = [],
  options: { source?: EvidenceSource; ignore?: RegExp } = {},
): ClaimRule => ({ label, pattern, evidence, fields, source: options.source ?? 'sheet', ...(options.ignore ? { ignore: options.ignore } : {}) });

/** One rule per alternative, each its own evidence: "dynamique" in the sheet does not make a car "confortable". */
const each = (label: string, source: EvidenceSource, ...alternatives: RegExp[]): ClaimRule[] =>
  alternatives.map((pattern) => claim(label, pattern, pattern, [], { source }));

/** A quality: only the seller's own sentences are evidence. */
const quality = (label: string, ...alternatives: RegExp[]) => each(label, 'free', ...alternatives);

/** An option or a service that is easy to invent: only the listed items and the seller's text are evidence (ITEM_FIELDS). */
const option = (label: string, ...alternatives: RegExp[]) => each(label, 'items', ...alternatives);

/** A building's legal warranties: not a warranty the seller gives, each its own claim. */
const BUILDING_WARRANTIES = [/\bgarantie decennale\b/, /\bgarantie biennale\b/, /\b(?:garantie|assurance) dommages?[ -]ouvrages?\b/];

/**
 * A warranty and its duration as a seller writes it: "garantie 12 mois", "garantie : 1 an",
 * "garantie mécanique 12 mois" (a closed list of kinds: any word could be "jusqu'à").
 */
const WARRANTY_DURATION = String.raw`\bgaranti(?:e|es|s)?(?: (?:mecanique|moteur|totale|vo|occasion|constructeur|contractuelle|commerciale|pieces et main[ -]d'(?:oeuvre|œuvre)))? ?(?:: ?|de )?\d+ ?(?:mois|ans?)\b`;

/**
 * "Garanti…" that is not the car's warranty: the mileage, the paid extension with the
 * durations it offers ("extension de garantie de 12 à 60 mois"), a warranty sold as an
 * option ("garantie 12 mois en option"), a building's legal warranties.
 */
const NOT_THE_WARRANTY = new RegExp(
  [
    String.raw`\b(?:kilometrage|km) garanti\b`,
    String.raw`\bextensions? de (?:la )?garantie\b(?: (?:de \d+ ?(?:a|au|-) ?\d+|(?:de|jusqu'a|sur|a) \d+) ?(?:mois|ans?)\b)?`,
    String.raw`(?:${WARRANTY_DURATION}|\b\d+ ?(?:mois|ans?) de garantie) (?:en option|optionnelle|payante|supplementaire|additionnelle|complementaire)s?\b`,
    ...BUILDING_WARRANTIES.map((pattern) => pattern.source),
  ].join('|'),
);

/**
 * A warranty the sheet gives with its duration (WARRANTY_DURATION), or "12 mois de
 * garantie" when nothing before makes it the end of a range or an extension ("jusqu'à 60
 * mois de garantie"). Read once NOT_THE_WARRANTY is blanked out.
 */
const INCLUDED_WARRANTY = new RegExp(String.raw`${WARRANTY_DURATION}|(?:^|[\n,.;:(!?–-]|\bavec) ?\d+ ?(?:mois|ans?) de garantie\b`, 'm');

const FRENCH_WARRANTY = claim(
  'garantie',
  /\bgaranti(?:e|es|s)?\b/,
  new RegExp(String.raw`${INCLUDED_WARRANTY.source}|\bgarantie (?:du )?constructeur\b`, 'm'),
  ['warranty'],
  { ignore: NOT_THE_WARRANTY },
);

/** Words between a seller's offer and "inclus": numbers and units count, a new item ("et …") does not. */
const OFFER_GAP = String.raw`(?: (?!(?:et|ou|avec|mais)\b)[\p{L}\p{N}'-]+){0,4}`;

/** Leather that is not the upholstery: a leather steering wheel or gear knob, imitation leather. */
const NOT_UPHOLSTERY =
  /\b(?:volant|pommeau|levier)(?: (?:sport|multifonctions?|chauffant|de|du|levier|vitesses?|boite|gaine|habille|garni|en))* cuir\b|\bsimili[ -]?cuir\b/;

const FRENCH: LanguageRules = {
  // "Euro 6" is an emission standard, not money.
  priceWords: /€|\b(?:euros|eur|chf|francs?|prix|tarifs?)\b|\beuro\b(?! ?\d)/,
  currencies: { EUR: /€|\b(?:euros|eur)\b|\beuro\b(?! ?\d)/, CHF: /\b(?:chf|francs?)\b/ },
  priceQualifier: /\b(?:ht|h\.t\.?|ttc|t\.t\.c\.?|hors taxes?|toutes taxes comprises|tva (?:incluse|comprise))(?![\p{L}\p{N}])/u,
  // "un an" is a duration the digit check cannot read ("Garantie d'un an").
  spelledNumbers:
    /\b(?:deux|trois|quatre|cinq|six|sept|huit|dix|onze|douze|quinze|vingt|trente|quarante|cinquante|soixante|cents?|mille|millions?)\b|\bun (?:an|mois)\b|\bune annee\b/,
  units: [
    { words: 'mois', unit: 'month', factor: 1 },
    { words: 'ans?|annees?', unit: 'month', factor: 12 },
    { words: 'kms?|kilometres?', unit: 'km', factor: 1 },
    { words: 'chevaux fiscaux|cv', unit: 'fiscal-hp', factor: 1 },
    { words: 'ch|chevaux', unit: 'hp', factor: 1 },
    // A property's consumption: "201 kWh/m²/an".
    { words: 'kwh(?:/m[²2](?:/an)?)?', unit: 'kwh', factor: 1 },
    { words: 'm²|m2|metres? carres?', unit: 'm2', factor: 1 },
    { words: 'metres?', unit: 'm', factor: 1 },
    { words: 'm', unit: 'm', factor: 1, lowercase: true },
    { words: `pouces?|''|"|″`, unit: 'inch', factor: 1 },
    { words: 'places?', unit: 'seat', factor: 1, counted: true },
    { words: 'portes?', unit: 'door', factor: 1, counted: true },
    { words: 'pieces?', unit: 'room', factor: 1, counted: true },
    { words: 'chambres?', unit: 'bedroom', factor: 1, counted: true },
  ],
  // A dash with spaces around separates ("2022 - 43 500 km"), without it joins ("12-60 mois").
  rangeJoin: /^(?: (?:a|au|ou) |-|–)$/,
  rangeOpen: { before: /\bentre $/, join: /^ et $/ },
  contactWords: ['tel', 'telephone', 'a', 'au'],
  warranty: { claim: FRENCH_WARRANTY, included: INCLUDED_WARRANTY },
  claims: [
    FRENCH_WARRANTY,
    claim('kilométrage garanti', /\b(?:kilometrage|km) garanti\b/),
    claim('extension de garantie', /\bextensions? de (?:la )?garantie\b/),
    ...each('garantie du bâtiment', 'sheet', ...BUILDING_WARRANTIES),
    claim('première main', /\b(?:premiere|1re|1ere) main\b|\b(?:premier|seul|unique) proprietaire\b/),
    // An age is not in the sheet (only the year), and a duration of the seller's
    // boilerplate ("financement … 72 mois") would otherwise vouch for "moins de 6 ans".
    claim(
      'âge',
      /\b(?:moins d'(?:un|une|\d+)|moins de \d+|a peine \d+|agee? (?:de )?(?:seulement |a peine )?\d+|seulement \d+) ?(?:ans?|annees?|mois)\b|\b(?:\d+|un) ?ans? d'age\b/,
    ),
    claim('faible kilométrage', /\b(?:faible|petit|bas) kilometrage\b|\bpeu (?:de )?kilometres\b|\bpeu roulee?\b/),
    claim('entretien', /\bentretien\b|\bentretenue?s?\b|\bcarnet\b/),
    claim('factures', /\bfactures?\b/),
    claim('historique', /\bhistorique\b/),
    claim('non-fumeur', /\bnon[ -]?fumeurs?\b/),
    ...quality('état impeccable', /\bimpeccable(?:s|ment)?\b/),
    ...quality('parfait état', /\bparfait etat\b|\betat parfait\b/),
    ...quality('excellent état', /\bexcellent etat\b|\betat excellent\b/),
    ...quality('très bon état', /\btres bon etat\b/),
    ...quality('bon état', /\bbon etat\b/),
    ...quality('comme neuf', /\bcomme neu(?:f|ve)s?\b|\betat neuf\b|\bquasi[ -]neu(?:f|ve)\b/),
    ...quality('irréprochable', /\birreprochables?\b/),
    claim('révisé', /\brevisee?s?\b|\brevision\b/, /\brevis/),
    ...quality('faible consommation', /\b(?:faible|petite|basse) consommation\b|\beconome\b|\bsobre\b|\bpeu gourmande?\b|\beconomique\b/),
    claim('jamais accidenté', /\b(?:jamais|non|aucun|sans|zero) accident/),
    claim('contrôle technique', /\bcontrole technique\b|\bct\b/),
    ...quality('fiabilité', /\bfiab(?:le|les|ilite)\b|\brobustes?\b/),
    ...quality('idéal pour…', /\bideale?s?\b|\bparfaite? pour\b/),
    ...quality('usage familial', /\bfamille\b|\bfamilia(?:l|le|les|ux)\b/),
    ...quality('spacieux', /\bspacieu(?:x|se|ses)\b/),
    claim('toutes options', /\b(?:toutes|full) options?\b|\bsurequipee?\b/),
    ...quality(
      'qualités de conduite',
      /\bconfortable\b/,
      /\bagreable a conduire\b|\bplaisir de conduite\b/,
      /\bsportive?\b/,
      /\bdynamique\b/,
      /\bnerveuse?\b/,
    ),
    ...quality('rare ou exceptionnel', /\brares?\b/, /\bexceptionnel(?:le)?s?\b/, /\bunique\b/),
    ...quality('bonne affaire', /\baffaire\b/, /\ba saisir\b/, /\bimbattable\b/),
    ...quality('lumineux', /\blumine(?:ux|use|uses)\b|\bluminosite\b/, /\bensoleillee?s?\b/),
    ...quality('calme', /\bcalmes?\b|\bpaisible/),
    // Options and services often invented, or read into the seller's boilerplate.
    ...option('toit ouvrant ou panoramique', /\btoit ouvrant\b/, /\b(?:toit|pavillon) (?:ouvrant )?(?:panoramique|pano|vitre)\b/),
    ...option('navigation', /\bgps\b|\bnavigation\b|\bnavigateur\b/),
    ...option('CarPlay ou Android Auto', /\b(?:apple )?car ?play\b/, /\bandroid auto\b/),
    ...option('caméra', /\bcameras?\b/),
    claim('sellerie cuir', /\bcuir\b/, /\bcuir\b/, [], { source: 'items', ignore: NOT_UPHOLSTERY }),
    ...option(
      '4 roues motrices',
      /\b(?:transmission|traction) integrale\b|\bquattro\b|\b4 ?x ?4\b|\b4 roues motrices\b|\b4motion\b|\b4matic\b|\bxdrive\b|\ball4\b|\b(?:4wd|awd)\b/,
    ),
    ...option('attelage', /\battelage\b/),
    ...option('hayon électrique', /\bhayon (?:electrique|motorise|automatique|mains libres)\b/),
    ...option('garantie constructeur', /\bgarantie (?:du )?constructeur\b/),
    ...option('offert', /\bofferte?s?\b|\bgratuite?s?\b|\bcadeau\b/),
    ...option(
      'offre incluse',
      new RegExp(
        String.raw`\b(?:financements?|credits?|loa|lld|extensions? de (?:la )?garantie|reprise|preparation|livraison|carte grise|frais|mise a la route|entretien|revisions?|controle technique|assurance)${OFFER_GAP} (?:inclus|incluses?|compris|comprises?)\b`,
        'u',
      ),
    ),
    // Financing in general, then leasing products, which are not paraphrases of it.
    ...option('financement', /\bfinancements?\b|\bfinancable\b|\bcredit\b|\bmensualites?\b/, /\bloa\b/, /\blld\b/, /\bleasing\b/),
    ...option('reprise', /\breprises?\b|\breprenons\b/),
    ...option('sans apport', /\bsans apport\b/),
    ...option('TVA récupérable', /\btva (?:recuperable|deductible)\b/),
    ...option('cote', /\bargus\b|\b(?:sous|dessous de|inferieure? a|moins chere? que) (?:la |l')?cote\b|\bcote (?:argus|lacentrale|la centrale)\b/),
    ...option(
      'livraison',
      /\blivraison (?:possible|partout|a domicile|dans toute|en france|gratuite|offerte|incluse)\b|\blivr(?:ee?s?|ons|able) (?:partout|a domicile|dans toute|chez vous)\b|\bnous livrons\b/,
    ),
    claim('sans vis-à-vis', /\bsans vis[ -]a[ -]vis\b/),
    claim('rénové', /\brenovee?s?\b|\brenovation\b|\brefaite?s? a neuf\b/, /\brenov|\brefait/),
    claim('vue', /\bvue (?:sur (?:la )?mer|mer|degagee|imprenable|panoramique)\b/),
    claim(
      'proximité',
      /\bproche (?:de |des |du )?(?:commerces|ecoles|transports|centre|gare|plage|metro|tram)|\bproximite\b|\ba deux pas\b/,
      /\bproche\b|\bproximite\b|\ba deux pas\b|\ba \d+ ?(?:min|minutes|m)\b/,
    ),
    ...quality('quartier recherché', /\b(?:quartier|secteur|emplacement) (?:recherche|prise|ideal|privilegie|de choix)\b/),
  ],
  // Folded words of 4 letters or more: shorter ones never tie an item to a text.
  citedItemStopWords: new Set(
    [
      'avec sans pour dans sous vers chez entre apres avant arriere depuis selon',
      'aussi ainsi dont mais comme plus moins tres bien tout tous toute toutes',
      'cette votre notre leur leurs elle elles systeme fonction equipement equipements option options pack',
    ].flatMap((line) => line.split(' ')),
  ),
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

/**
 * Sheet text where options and services must be found: the listed items and the
 * seller's text, with the title and the version ("2.0 TDI 190 quattro", "Toit pano").
 */
const ITEM_FIELDS = ['title', 'version', 'equipment', 'features', 'description', 'warranty'];

/** A description line that lists an item ("- Capteur de luminosité"), as the readers see one. */
const BULLET_LINE = /^\s*[-•*–]\s+/;

/**
 * The seller's own words: for a car, the title, the version (a trim such as
 * "Dynamique" is the seller's) and the description without the lines that list
 * equipment, whose labels name devices ("Commande du comportement dynamique"), not
 * qualities. For a property, the description and the features, which the seller
 * ticked or wrote ("Calme", "Lumineux").
 */
function freeText(sheet: Sheet): string {
  const description = sheet.description ?? '';
  if (sheet.vertical !== 'auto') return [description, ...sheet.features].join('\n');
  const items = new Set(sheet.equipment.map((item) => fold(composed(item)).trim()));
  const lines = description.split(/\r?\n/).filter((line) => !BULLET_LINE.test(line) && !items.has(fold(composed(line)).trim()));
  return [sheet.title, sheet.version ?? '', ...lines].join('\n');
}

function evidenceTexts(sheet: Sheet): Record<EvidenceSource, string> {
  const folded = (text: string) => fold(composed(text));
  return {
    sheet: folded(strings(sheet, EVIDENCE_FIELDS).join('\n')),
    items: folded(strings(sheet, ITEM_FIELDS).join('\n')),
    free: folded(freeText(sheet)),
  };
}

// ---------------------------------------------------------------------------
// Quantities: a number and its unit
// ---------------------------------------------------------------------------

type Quantity = { value: number; unit: string };

/** The canonical unit of durations (see UnitRule). */
const MONTH = 'month';

/** Structured fields and the unit of their value. */
const FIELD_UNITS: Record<string, string> = { mileageKm: 'km', powerHp: 'hp', surfaceM2: 'm2', landM2: 'm2', rooms: 'room', bedrooms: 'bedroom' };

/** A number of a text, with the unit written after it. */
type Reading = {
  n: FoundNumber;
  unit: UnitRule | null;
  /** The unit as written ("ans"), '' without one. */
  unitText: string;
  /** Where the number, and its own unit if any, end in the text. */
  end: number;
  /**
   * The unit is the one written after the other end of a range ("12 à 60 mois"). A
   * guess: "une 2022 à 43 500 km" is a year and a mileage.
   */
  ranged: boolean;
};

const unitPatterns = new WeakMap<UnitRule, RegExp>();

/** Measures follow the number ("150ch", "43 500 km"); counted things may have one word between ("3 grandes chambres"). */
function unitPattern(rule: UnitRule): RegExp {
  let pattern = unitPatterns.get(rule);
  if (!pattern) {
    const gap = rule.counted ? "(?:[ \\t]+[\\p{L}'-]+)?[ \\t]+" : '[ \\t]*';
    pattern = new RegExp(`^${gap}(${rule.words})(?![\\p{L}\\p{N}/])`, 'u');
    unitPatterns.set(rule, pattern);
  }
  return pattern;
}

function unitAfter(text: string, folded: string, n: FoundNumber, rules: LanguageRules): Omit<Reading, 'n' | 'ranged'> | null {
  const from = n.index + n.raw.length;
  for (const rule of rules.units) {
    const m = unitPattern(rule).exec(folded.slice(from));
    const word = m?.[1];
    if (!m || word === undefined) continue;
    const end = from + m[0].length;
    const unitText = text.slice(end - word.length, end);
    if (rule.lowercase && unitText !== word) continue;
    return { unit: rule, unitText, end };
  }
  return null;
}

/**
 * The numbers of a text (phones blanked out) and their units. A range takes the unit
 * written after its second end: "de 12 à 60 mois" is 12 months to 60 months.
 */
function readNumbers(text: string, rules: LanguageRules): Reading[] {
  const folded = fold(text);
  const readings: Reading[] = findNumbers(text).map((n) => ({
    n,
    ...(unitAfter(text, folded, n, rules) ?? { unit: null, unitText: '', end: n.index + n.raw.length }),
    ranged: false,
  }));
  for (let i = readings.length - 2; i >= 0; i--) {
    const [a, b] = [readings[i], readings[i + 1]];
    if (!a || !b || a.unit || !b.unit) continue;
    const between = folded.slice(a.end, b.n.index);
    const opened = rules.rangeOpen.before.test(folded.slice(0, a.n.index)) && rules.rangeOpen.join.test(between);
    if (rules.rangeJoin.test(between) || opened) readings[i] = { ...a, unit: b.unit, unitText: b.unitText, ranged: true };
  }
  return readings;
}

const quantityOf = (r: Reading, value = r.n.value): Quantity | null => (r.unit ? { value: value * r.unit.factor, unit: r.unit.unit } : null);

/** A reading as quoted in a message: "2 ans", or "12 mois" for the first end of "12 à 60 mois". */
function quoted(r: Reading, text: string): string {
  if (!r.unit) return r.n.raw;
  return r.end > r.n.index + r.n.raw.length ? text.slice(r.n.index, r.end) : `${r.n.raw} ${r.unitText}`;
}

/** Every (value, unit) the sheet states: its measured fields, and the numbers of its texts written with a unit. */
function sheetQuantities(sheet: Sheet, rules: LanguageRules): Quantity[] {
  const out: Quantity[] = [];
  for (const [key, unit] of Object.entries(FIELD_UNITS)) {
    const value = field(sheet, key);
    if (typeof value === 'number') out.push({ value, unit });
  }
  for (const text of numberTexts(sheet)) {
    for (const r of readNumbers(stripPhones(composed(text)), rules)) {
      // "Peugeot 308 130 ch": the unit belongs to the last group too.
      const last = r.n.parts?.at(-1);
      for (const q of [quantityOf(r), last === undefined ? null : quantityOf(r, last)]) if (q) out.push(q);
    }
  }
  return out;
}

/**
 * Warranty durations, in months, that the sheet gives as included: those of the
 * warranty field, and of the `included` phrases of the evidence text ("garantie 12
 * mois"), read once the look-alikes are blanked out ("extension de garantie de 12 à 60 mois").
 */
function includedWarrantyMonths(sheet: Sheet, rules: LanguageRules, evidence: string): number[] {
  const { claim: rule, included } = rules.warranty;
  const text = rule.ignore ? blankMatches(evidence, rule.ignore) : evidence;
  const phrases = [...strings(sheet, ['warranty']).map(composed), ...[...text.matchAll(globalOf(included))].map((m) => m[0])];
  const months = phrases.flatMap((phrase) => readNumbers(phrase, rules).map((r) => quantityOf(r)));
  return [...new Set(months.flatMap((q) => (q?.unit === MONTH ? [q.value] : [])))];
}

/** Where a clause ends: a warranty's duration is the one said in the same clause as the warranty. */
const CLAUSE_BREAK = /[;!?()·•|\n]|[.,](?!\d)|\s[-–—]\s/g;

function clauses(text: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    out.push([start, m.index]);
    start = m.index + m[0].length;
  }
  out.push([start, text.length]);
  return out;
}

// ---------------------------------------------------------------------------
// Cited items: a segment says the equipment or feature it cites
// ---------------------------------------------------------------------------

const CITED_ITEM = /^(?:equipment|features)\[\d+\]$/;
const LETTERS = /\p{L}+/gu;

/** "sièges" and "siège" are the same word. */
const stem = (word: string) => (word.length > 4 ? word.replace(/[sx]$/, '') : word);

/**
 * The words that tie an item to a text: those of 4 letters or more and the acronyms
 * ("Navigation GPS"), apart from the ignored ones (stop words, make and model); for an
 * item of short words ("Clim"), those.
 */
function itemWords(item: string, ignored: ReadonlySet<string>): string[] {
  const original = composed(item);
  // In an item written in capitals, every word looks like an acronym.
  const capitals = original === original.toUpperCase();
  const words = (original.match(LETTERS) ?? [])
    .map((w) => ({ folded: fold(w), acronym: !capitals && /^\p{Lu}{2,}$/u.test(w) }))
    .filter((w) => !ignored.has(w.folded));
  const tying = words.filter((w) => w.folded.length >= 4 || w.acronym);
  return (tying.length > 0 ? tying : words.filter((w) => w.folded.length >= 2)).map((w) => stem(w.folded));
}

/**
 * Whether the text says one of the item's words, a word it abbreviates or one that
 * abbreviates it ("Clim auto" for "Climatisation automatique", and back).
 */
function saysItem(text: string, item: string, ignored: ReadonlySet<string>): boolean {
  const wanted = itemWords(item, ignored);
  if (wanted.length === 0) return true;
  const said = (fold(composed(text)).match(LETTERS) ?? []).map(stem);
  const abbreviates = (short: string, long: string) => short.length >= 4 && !ignored.has(short) && long.startsWith(short);
  return wanted.some((w) => said.some((s) => s === w || abbreviates(w, s) || abbreviates(s, w)));
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
  const quantities = sheetQuantities(sheet, rules);
  const hasQuantity = (q: Quantity) => quantities.some((s) => s.unit === q.unit && same(s.value, q.value));
  const sheetPhone = sheet.phone ? phoneKey(sheet.phone) : undefined;
  const evidence = evidenceTexts(sheet);
  const names = foldedValues(sheet, NAME_FIELDS);
  // Labels of several words, which name a device ("Capteur de luminosité"); a label of one
  // quality word ("Dynamique") would blank that word out of every sentence.
  const itemLabels = foldedValues(sheet, ['equipment', 'features']).filter((label) => /\s/.test(label));
  const addresses = sheetText(sheet);

  /** Whether the sheet supports a claim: it does not depend on the script's text. */
  const support = new Map<ClaimRule, boolean>();
  const supported = (rule: ClaimRule): boolean => {
    let ok = support.get(rule);
    if (ok === undefined) {
      const text = rule.ignore ? blankMatches(evidence[rule.source], rule.ignore) : evidence[rule.source];
      ok = rule.evidence.test(text) || rule.fields.some((f) => isPresent(field(sheet, f)));
      support.set(rule, ok);
    }
    return ok;
  };
  const warranty = rules.warranty.claim;
  let warrantyMonths: number[] | undefined;
  const includedMonths = () => (warrantyMonths ??= includedWarrantyMonths(sheet, rules, evidence[warranty.source]));

  // (a) facts paths resolve to present values, and a cited equipment or feature is the one
  // the segment says (French: a translated script shares no word with the sheet).
  const stopWords = rules.citedItemStopWords;
  const ignoredItemWords = stopWords && new Set([...stopWords, ...foldedValues(sheet, ['make', 'model']).flatMap((v) => v.match(LETTERS) ?? [])]);
  script.segments.forEach((segment, i) => {
    for (const path of segment.facts) {
      const problem = factPathProblem(sheet, path, variant);
      if (problem) {
        add(`segments[${i}].facts`, problem.kind, problem.message);
        continue;
      }
      const item = ignoredItemWords && CITED_ITEM.test(path) ? resolvePath(sheet, path) : undefined;
      if (typeof item === 'string' && ignoredItemWords && !saysItem(segment.text, item, ignoredItemWords)) {
        add(`segments[${i}].facts`, 'fact-path', `« ${path} » (« ${item} ») : le segment n’en reprend aucun mot, cite l’élément qu’il énonce`);
      }
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

    // (b) numbers belong to the sheet, with their unit when one is written ("60 mois" is
    // not "60 000 km"); (c) the price never appears in the listing variant; (d) an amount
    // of money in the social variant is the sheet's price as it is, not another number.
    const withoutPhones = stripPhones(text);
    const readings = readNumbers(withoutPhones, rules);
    /** Numbers already reported, which the warranty check does not report again. */
    const reportedNumbers = new Set<FoundNumber>();
    const report = (r: Reading, kind: ProblemKind, message: string) => {
      reportedNumbers.add(r.n);
      add(where, kind, message);
    };
    let saysPrice = false;
    for (const r of readings) {
      const { n } = r;
      const isPrice = sheet.price !== undefined && same(n.value, sheet.price);
      if (isPrice) saysPrice = true;
      if (variant === 'listing' && isPrice) {
        report(r, 'price', `prix « ${n.raw} » : pas de prix dans la variante annonce`);
      } else if (variant === 'social' && isAmount(withoutPhones, n, rules)) {
        if (!isPrice) report(r, 'price', `montant « ${n.raw} » différent du prix de la fiche${sheet.price === undefined ? ', qui n’en indique pas' : ''}`);
      } else {
        const quantity = quantityOf(r);
        if (quantity ? hasQuantity(quantity) : isAllowed(n.value)) continue;
        // A range's unit is a guess ("une 2022 à 43 500 km"): the number alone may do.
        if (r.ranged && isAllowed(n.value)) continue;
        if (quantity && isAllowed(n.value)) report(r, 'number', `« ${quoted(r, withoutPhones)} » ne figure pas dans la fiche`);
        else if (n.parts?.every(isAllowed)) report(r, 'number', `« ${n.raw} » se lit comme un seul nombre : sépare les nombres par un mot ou une virgule`);
        else report(r, 'number', `« ${n.raw} » ne figure pas dans la fiche`);
      }
    }

    // Names ("Six-Fours-les-Plages", "Garage Idéal", "Euro Motors") are said as they are:
    // blanked out before looking for number words, money words and claims.
    const folded = fold(text);
    const unnamed = blankOut(folded, names);
    const at = (m: RegExpExecArray) => text.slice(m.index, m.index + m[0].length);
    const spelled = rules.spelledNumbers.exec(unnamed);
    if (spelled) add(where, 'number', `« ${at(spelled)} » : écris les nombres en chiffres pour qu’ils soient vérifiables`);
    // Anywhere in a text that says the price: "22 490 € HT", "Prix hors taxes de 22 490 €".
    const qualifier = variant === 'social' && saysPrice ? rules.priceQualifier.exec(unnamed) : null;
    if (qualifier) add(where, 'price', `« ${at(qualifier)} » : la fiche ne dit pas si le prix est HT ou TTC`);
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
    // An equipment or feature said as listed is not a quality: "Capteur de luminosité".
    const unlisted = blankOut(unnamed, itemLabels);
    const reported: [number, number][] = [];
    for (const rule of rules.claims) {
      const read = rule.source === 'free' ? unlisted : unnamed;
      const m = rule.pattern.exec(rule.ignore ? blankMatches(read, rule.ignore) : read);
      if (!m || supported(rule)) continue;
      const [start, end] = [m.index, m.index + m[0].length];
      if (reported.some(([s, e]) => start < e && s < end)) continue;
      reported.push([start, end]);
      add(where, 'claim', `« ${at(m)} » (${rule.label}) : la fiche ne le dit pas`);
    }

    // (f) a warranty's duration is one the sheet gives as included, not the longest
    // extension or loan of the seller's boilerplate.
    const said = warranty.ignore ? blankMatches(unnamed, warranty.ignore) : unnamed;
    if (!warranty.pattern.test(said) || !supported(warranty)) continue;
    const months = includedMonths();
    for (const [start, end] of clauses(said)) {
      if (!warranty.pattern.test(said.slice(start, end))) continue;
      for (const r of readings) {
        const quantity = quantityOf(r);
        if (quantity?.unit !== MONTH || r.n.index < start || r.n.index >= end || reportedNumbers.has(r.n)) continue;
        // Blanked out with a look-alike: an extension's duration, checked as a number only.
        if (!said.slice(r.n.index, r.n.index + r.n.raw.length).trim()) continue;
        if (months.some((m) => same(m, quantity.value))) continue;
        const included = months.map((m) => `${formatNumber(m)} mois`).join(' ou ');
        add(
          where,
          'claim',
          months.length > 0
            ? `« ${quoted(r, withoutPhones)} » : la garantie incluse selon la fiche est de ${included}`
            : `« ${quoted(r, withoutPhones)} » : la fiche ne donne pas de durée de garantie incluse`,
        );
      }
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
