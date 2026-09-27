import { DURATION_SEC, type Language, type PhotoRole } from '../pipeline/types';
import type { Sheet } from '../sheet';

/** Stored with each script so a result can be traced back to its prompt. */
export const SCRIPT_PROMPT_VERSION = 'script.v1';

type Vertical = Sheet['vertical'];

/** Output languages, named as in the (French) prompt. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  fr: 'français',
  de: 'allemand',
  it: 'italien',
  nl: 'néerlandais',
};

/**
 * Voice-over pace in words per second. French reads at about 2.5; the other values
 * are placeholders to measure with each language's voice before enabling it.
 */
export const WORDS_PER_SECOND: Record<Language, number> = { fr: 2.5, de: 2.5, it: 2.5, nl: 2.5 };

/** The hook must be read in about 2 seconds. */
export const HOOK_MAX_WORDS = 8;

/** Spoken words that fill DURATION_SEC at the language's pace. */
export function spokenWordTarget(vertical: Vertical, language: Language): { min: number; max: number } {
  const { min, max } = DURATION_SEC[vertical];
  const pace = WORDS_PER_SECOND[language];
  return { min: Math.round(min * pace), max: Math.round(max * pace) };
}

const SUBJECT: Record<Vertical, string> = {
  auto: 'd’une voiture d’occasion',
  immo: 'd’un bien immobilier',
};

const VOICE: Record<Vertical, string> = {
  auto: 'le modèle, l’année, le kilométrage, 3 équipements forts de la fiche et la garantie si la fiche en indique une',
  immo: 'le quartier ou la ville, la surface, le nombre de pièces et 3 atouts de la fiche (caractéristiques, description)',
};

const FORBIDDEN: Record<Vertical, string> = {
  auto: '« état impeccable », « entretien suivi », « faible consommation », « idéal pour la famille », « jamais accidentée », « première main », « fiable », « spacieuse », « rare », « à saisir »',
  immo: '« lumineux », « calme », « sans vis-à-vis », « refait à neuf », « proche des commerces », « quartier recherché », « idéal pour la famille », « rare », « à saisir »',
};

const TITLE: Record<Vertical, string> = {
  auto: 'marque et modèle, par exemple « Peugeot 308 »',
  immo: 'type de bien et ville ou quartier, par exemple « Appartement à Marseille »',
};

const SUBTITLE: Record<Vertical, string> = {
  auto: '« année · kilométrage · énergie », par exemple « 2019 · 68 000 km · Essence »',
  immo: '« surface · pièces · chambres », par exemple « 64,7 m² · 3 pièces · 2 chambres »',
};

const CONTACT_NAME: Record<Vertical, string> = { auto: 'sellerName', immo: 'agencyName' };

/**
 * Instructions for the script. The prompt is in French; the output language is a
 * parameter, so German, Italian and Dutch plug in without touching the templates.
 * Rule 3 (no invention) comes first: the sheet is the only source.
 */
export function scriptSystemPrompt(input: { vertical: Vertical; language: Language }): string {
  const { vertical, language } = input;
  const languageName = LANGUAGE_NAMES[language];
  const duration = DURATION_SEC[vertical];
  const words = spokenWordTarget(vertical, language);
  return `Tu écris les textes de deux courtes vidéos (${duration.min} à ${duration.max} secondes) pour l’annonce ${SUBJECT[vertical]} décrite par la fiche JSON fournie : la voix off, découpée en segments, et les textes affichés à l’écran.

Langue : écris tous les textes (voix off et écran) en ${languageName}, même si la fiche est rédigée dans une autre langue.

Règle absolue : aucune invention.
- La fiche est ta seule source. Chaque information dite ou affichée doit y figurer : tu peux la reformuler ou la traduire, jamais l’enrichir.
- N’ajoute aucun équipement, aucune caractéristique, aucun état, aucun historique, aucune qualité ni aucun usage que la fiche ne mentionne pas, même s’ils semblent évidents pour ce modèle ou ce type de bien.
- Exemples interdits, sauf si la fiche le dit : ${FORBIDDEN[vertical]}.
- N’utilise ni tes connaissances sur la marque, le modèle, la ville ou le quartier, ni les photos : tu ne les vois pas, seul leur ordre t’est donné.
- Si une information manque (kilométrage, garantie, prix, contact…), n’en parle pas.

Chaque variante :
- segments, dans cet ordre : une accroche (kind "hook"), puis les atouts (kind "point"), puis un appel à l’action (kind "cta").
- L’accroche se lit en 2 secondes : ${HOOK_MAX_WORDS} mots au plus.
- La voix off présente ${VOICE[vertical]}. Choisis les 3 atouts les plus forts de la fiche ; si elle en donne moins, fais-en moins.
- Longueur de la voix off, tous segments compris : ${words.min} à ${words.max} mots (${duration.min} à ${duration.max} secondes à environ ${String(WORDS_PER_SECOND[language]).replace('.', ',')} mots par seconde).
- Suis l’ordre des photos de la vidéo quand c’est naturel.
- Écris les nombres en chiffres, comme dans la fiche, pour qu’ils soient vérifiables : « 68 000 km », « 2019 », « 130 ch », « 12 mois ». Jamais en lettres. Ne colle pas deux nombres, qui se liraient comme un seul : « 308 de 130 ch », pas « 308 130 ch ».
- facts : pour chaque segment, les champs de la fiche qu’il utilise, en chemins JSON : « make », « mileageKm », « equipment[1] » (indices à partir de 0), « warranty », « description ». Un atout cite au moins un champ. Un appel à l’action sans information a une liste vide.

Les deux variantes :
- "social" (vidéo verticale pour les réseaux sociaux) : peut dire le prix et donner le contact, seulement s’ils figurent dans la fiche (champs price, ${CONTACT_NAME[vertical]}, city, phone).
- "listing" (vidéo horizontale collée dans l’annonce elle-même) : JAMAIS de prix ni de montant, ni les mots « prix » ou « euros », ni symbole de devise ; JAMAIS de numéro de téléphone. Appel à l’action neutre, par exemple « Tous les détails sont dans l’annonce. », dans la langue demandée.

Textes à l’écran (overlays) :
- title : ${TITLE[vertical]}.
- subtitle : ${SUBTITLE[vertical]}, avec seulement les éléments présents dans la fiche.
- price : variante "social" seulement, si la fiche a un prix, au format « 15 990 € » (« CHF 15 990 » en francs suisses). Sinon, omets ce champ.
- contact : variante "social" seulement, « Nom · Ville · Téléphone » avec uniquement les éléments présents dans la fiche, sans autre mot. Sinon, omets ce champ.
- La variante "listing" n’a ni price ni contact.`;
}

/** The sheet (already stripped of what is not a fact) and the photo order. */
export function scriptUserPrompt(input: { sheetJson: string; photoRoles: readonly PhotoRole[]; language: Language }): string {
  const photos = input.photoRoles.length
    ? input.photoRoles.map((role, i) => `${i + 1}. ${role}`).join(' ; ')
    : 'non fourni';
  return `Fiche de l’annonce (seule source d’informations) :
\`\`\`json
${input.sheetJson}
\`\`\`

Ordre des photos dans la vidéo : ${photos}.

Écris les variantes "social" et "listing" en ${LANGUAGE_NAMES[input.language]}.`;
}

/** Sent once after an answer that breaks the format (CLAUDE.md, Conventions: one retry). */
export function scriptFormatRetryPrompt(problems: readonly string[]): string {
  return `Ta réponse ne respecte pas les consignes :
${problems.map((p) => `- ${p}`).join('\n')}
Renvoie les deux variantes complètes corrigées, au même format.`;
}

/** Sent once after the fact check found information the sheet does not support (rule 3). */
export function scriptFactsRetryPrompt(problems: readonly string[]): string {
  return `La vérification contre la fiche a trouvé des passages non justifiés :
${problems.map((p) => `- ${p}`).join('\n')}
Corrige les deux variantes : retire chaque passage signalé ou remplace-le par une information présente dans la fiche, sans rien inventer d’autre. Garde le reste tel quel. Renvoie les deux variantes complètes, au même format.`;
}
