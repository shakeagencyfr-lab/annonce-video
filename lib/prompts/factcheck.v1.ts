import type { Language } from '../pipeline/types';
import { LANGUAGE_NAMES } from './script.v1';

/** Stored with each check so a verdict can be traced back to its prompt. */
export const FACTCHECK_PROMPT_VERSION = 'factcheck.v1';

/**
 * Instructions for the judge (Haiku) that reads both scripts against the sheet and
 * lists every claim the sheet does not support (rule 3). It complements the
 * deterministic checks, which cannot judge paraphrases.
 */
export function factcheckSystemPrompt(): string {
  return `Tu vérifies les textes de deux courtes vidéos écrites à partir de la fiche d’une annonce (voiture d’occasion ou bien immobilier). Ta seule tâche : relever chaque affirmation qui n’est pas justifiée par la fiche JSON fournie. La fiche est la seule référence : n’utilise pas tes connaissances sur la marque, le modèle, la ville ou le quartier.

Une affirmation est justifiée quand la fiche contient la même information, éventuellement reformulée ou traduite, avec les mêmes valeurs : « 68 000 km » correspond à "mileageKm": 68000, « boîte manuelle » à "gearbox": "Manuelle", « 15 990 € » à "price": 15990.

Relève :
- une valeur différente de la fiche (kilométrage, année, prix, puissance, surface, nombre de pièces, durée de garantie…) ;
- un équipement, une caractéristique, un état, un historique (entretien, propriétaires, accidents, contrôle technique), une qualité ou un usage (« idéal pour la famille », « économique », « spacieux », « fiable », « lumineux », « calme ») que la fiche ne mentionne pas ;
- une déduction tirée de la marque, du modèle ou de la ville, même plausible (« 5 places », « faible consommation », « quartier recherché ») ;
- un nom, une ville, un numéro de téléphone, une adresse web ou e-mail absents de la fiche.

Ne relève pas :
- les formules sans information : « Contactez-nous », « Tous les détails sont dans l’annonce », « À découvrir » ;
- la mise en forme, le style ou l’ordre des informations.

Pour chaque affirmation relevée, donne : variant ("social" ou "listing"), text (le passage exact, recopié tel quel), claim (l’affirmation en quelques mots), reason (en français : ce que dit la fiche, ou qu’elle n’en parle pas). Si tout est justifié, renvoie une liste vide : n’invente pas de problème.`;
}

export function factcheckUserPrompt(input: { sheetJson: string; scriptsJson: string; language: Language }): string {
  return `Fiche de l’annonce :
\`\`\`json
${input.sheetJson}
\`\`\`

Textes des deux vidéos, en ${LANGUAGE_NAMES[input.language]} : voix off (segments) et textes à l’écran (overlays) :
\`\`\`json
${input.scriptsJson}
\`\`\`

Relève les affirmations non justifiées par la fiche.`;
}

/** Sent once after an answer that breaks the format (CLAUDE.md, Conventions: one retry). */
export function factcheckRetryPrompt(problems: readonly string[]): string {
  return `Ta réponse ne respecte pas le format attendu :
${problems.map((p) => `- ${p}`).join('\n')}
Renvoie la liste complète corrigée, au même format.`;
}
