import { PHOTO_COUNT, PHOTO_ROLES } from '../pipeline/types';
import type { Sheet } from '../sheet';

/** To log with each selection (PhotoSelection has no field for it) so a result can be traced back to its prompt. */
export const PHOTOS_PROMPT_VERSION = 'photos.v1';

type Vertical = Sheet['vertical'];

const SUBJECT: Record<Vertical, string> = {
  auto: 'd’une voiture d’occasion',
  immo: 'd’un bien immobilier',
};

const ROLE_HINTS: Record<Vertical, string> = {
  auto: [
    '- « trois-quarts avant » : la voiture vue de l’avant et d’un côté à la fois ;',
    '- « profil » : vue de côté ; « arrière » : vue de l’arrière ou trois-quarts arrière ;',
    '- « intérieur » : sièges, habitacle ; « tableau de bord » : volant, compteurs, écran ;',
    '- « détail » : jantes, coffre, moteur, équipement précis ;',
    '- « autre » : photo utile qui n’entre dans aucun rôle.',
  ].join('\n'),
  immo: [
    '- « façade ou vue » : extérieur du bâtiment ou vue depuis le bien ;',
    '- « séjour », « cuisine », « chambre », « salle de bain » : les pièces (salle d’eau et WC comptent comme salle de bain) ;',
    '- « extérieur » : jardin, terrasse, balcon, piscine, parking ;',
    '- « plan » : plan du logement ;',
    '- « autre » : photo utile qui n’entre dans aucun rôle (entrée, bureau, cave…).',
  ].join('\n'),
};

/** Instructions for the photo sort. The model only picks and orders: it never describes the listing. */
export function photosSystemPrompt(vertical: Vertical): string {
  const { min, max } = PHOTO_COUNT[vertical];
  const roles = PHOTO_ROLES[vertical];
  return `Tu tries les photos de l’annonce ${SUBJECT[vertical]} pour en faire une courte vidéo en 1080p (formats 9:16 et 16:9). Tu choisis et tu ordonnes les photos : tu ne décris ni le bien ni son état.

Écarte :
- les doublons et quasi-doublons (même vue, même cadrage) : garde la meilleure et écarte les autres ;
- les photos floues, trop sombres, surexposées, pixelisées ou trop petites ;
- les logos, bannières de garage ou d’agence, visuels publicitaires chargés de texte, montages, captures d’écran ;
- les photos de documents (carte grise, factures, carnet d’entretien…)${vertical === 'immo' ? ', sauf les plans du logement' : ''}.

Garde entre ${min} et ${max} photos. S’il y a plus de ${max} photos utilisables, garde les plus nettes et les plus variées. S’il y a moins de ${min} photos utilisables, garde-les toutes : n’ajoute jamais une photo inutilisable pour atteindre ${min}.

Donne à chaque photo gardée un seul rôle parmi : ${roles.map((r) => `« ${r} »`).join(', ')}.
${ROLE_HINTS[vertical]}
Range les photos gardées dans cet ordre de rôles : ${roles.join(' → ')}.

Donne à chaque photo écartée une raison courte en français, par exemple « doublon de la photo 3 », « floue », « trop sombre », « logo du garage », « visuel publicitaire ».

Chaque photo reçue doit figurer exactement une fois : soit dans selected, soit dans rejected. Utilise exactement les numéros indiqués avant chaque photo.`;
}

/** Text placed before the photos: what the listing is, and the photo numbers to use. */
export function photosUserPrompt(input: { listing: string; indexes: readonly number[] }): string {
  return `Annonce : ${input.listing}
${input.indexes.length} photos suivent, chacune précédée de son numéro (« Photo 3 »). Numéros à utiliser : ${input.indexes.join(', ')}.`;
}

/** Text placed after the photos. */
export function photosFinalPrompt(count: number): string {
  return `Trie ces ${count} photos.`;
}

/** Sent once after an answer that breaks the rules (CLAUDE.md, Conventions: one retry). */
export function photosRetryPrompt(problems: readonly string[]): string {
  return `Ta réponse ne respecte pas les consignes :
${problems.map((p) => `- ${p}`).join('\n')}
Renvoie la sélection complète corrigée, au même format.`;
}
