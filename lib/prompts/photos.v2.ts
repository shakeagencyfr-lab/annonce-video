import { PHOTO_COUNT, PHOTO_ROLES } from '../pipeline/types';
import type { Sheet } from '../sheet';

/** To log with each selection (PhotoSelection has no field for it) so a result can be traced back to its prompt. */
export const PHOTOS_PROMPT_VERSION = 'photos.v2';

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

/**
 * What must not get a photo rejected. A real listing's photos all carry the platform's
 * watermark, and a dealer shoots its cars in front of its own sign: only a visual that
 * is mostly a logo, a banner or an advert is rejected. A wide dashboard shot often shows
 * the centre screen in phone mode (CarPlay…): only a close-up of such a screen is rejected.
 */
const NOT_REASONS: Record<Vertical, string> = {
  auto: [
    '- un filigrane ou un petit logo dans un coin : celui de la plateforme (« leboncoin », par exemple) ou celui du vendeur ;',
    '- l’enseigne ou le logo du garage à l’arrière-plan d’une vraie photo de la voiture prise devant ses locaux : c’est une photo de la voiture, pas un logo ;',
    '- un écran qui affiche un téléphone connecté, vu en petit dans une vue d’ensemble du tableau de bord : c’est une photo du tableau de bord.',
  ].join('\n'),
  immo: '- un filigrane ou un petit logo dans un coin : celui de la plateforme (« leboncoin », par exemple) ou celui de l’agence.',
};

/** Where a phone number or a price shows up in the photos themselves. */
const PHONE_PRICE_PLACES: Record<Vertical, string> = {
  auto: 'enseigne, affichette, pare-brise',
  immo: 'panneau « à vendre », affichette, vitrine',
};

/** Instructions for the photo sort. The model only picks and orders: it never describes the listing. */
export function photosSystemPrompt(vertical: Vertical): string {
  const { min, max } = PHOTO_COUNT[vertical];
  const roles = PHOTO_ROLES[vertical];
  return `Tu tries les photos de l’annonce ${SUBJECT[vertical]} pour en faire une courte vidéo en 1080p (formats 9:16 et 16:9). Tu choisis et tu ordonnes les photos : tu ne décris ni le bien ni son état.

Écarte :
- les doublons et quasi-doublons (même vue, même cadrage, ou le même écran photographié sur plusieurs menus) : garde la meilleure et écarte les autres ;
- les photos floues, trop sombres, surexposées, pixelisées ou trop petites ;
- les visuels faits surtout d’un logo, d’une bannière, d’une publicité ou de texte (garage, agence, offre de financement), les montages et les captures d’écran ;
- les gros plans d’un écran qui affiche un téléphone connecté (applications, notifications, messages) ;
- les photos de documents (carte grise, factures, carnet d’entretien…)${vertical === 'immo' ? ', sauf les plans du logement' : ''}.

Ne sont pas des raisons d’écarter une photo :
${NOT_REASONS[vertical]}

Garde entre ${min} et ${max} photos. S’il y a plus de ${max} photos utilisables, garde les plus nettes et les plus variées. S’il y a moins de ${min} photos utilisables, garde-les toutes : n’ajoute jamais une photo inutilisable pour atteindre ${min}.

À cadrage égal, préfère une photo où aucun numéro de téléphone ni aucun prix n’est lisible (${PHONE_PRICE_PLACES[vertical]}) : la vidéo destinée à l’annonce ne doit montrer ni l’un ni l’autre.

Donne à chaque photo gardée un seul rôle parmi : ${roles.map((r) => `« ${r} »`).join(', ')}.
${ROLE_HINTS[vertical]}
Range les photos gardées dans cet ordre de rôles : ${roles.join(' → ')}.

Donne à chaque photo écartée une raison courte en français, par exemple « doublon de la photo 3 », « floue », « trop sombre », « logo seul », « visuel publicitaire », « écran de téléphone connecté ».

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
