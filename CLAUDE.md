# CLAUDE.md — Vidéos d'annonces auto & immo

## Le projet en bref

Service 100 % self-service. L'utilisateur colle le lien d'une annonce (voiture d'occasion ou bien immobilier) et reçoit en 2 à 3 minutes deux vidéos prêtes à publier :

- **9:16** pour les réseaux sociaux ;
- **16:9** pour l'annonce elle-même, via un lien YouTube que le vendeur colle dans son annonce.

Paiement unique ou packs de crédits (Stripe), jamais d'abonnement. Aucune intervention humaine dans le parcours client.

- Propriétaire : Sébastien (Shake Agency).
- Nom de marque : à définir. Nom de code du dépôt : `annonce-video`.
- Plan complet (business, prix, risques, feuille de route) : https://claude.ai/code/artifact/c9b895b7-f58c-457f-b575-6a910fe0e3e8

## Règles non négociables

1. **Une annonce lue à la fois**, uniquement à la demande de l'utilisateur. Jamais de crawl, de parcours de pages de résultats ni de lecture en masse. Leboncoin est protégé comme producteur de base de données (jurisprudence Entreparticuliers.com confirmée en Cassation) : l'extraction systématique est interdite quel que soit le but.
2. **Ne stocker que ce qui sert à la commande.** Le HTML brut n'est jamais conservé. La fiche standard est gardée le temps des régénérations, puis purgée (30 jours).
3. **Aucune invention.** Le script n'utilise que les informations présentes dans la fiche : pas d'équipement, d'état ou de qualité supposés.
4. **Case obligatoire au paiement** : « Je suis le vendeur de ce bien ou mandaté par lui ».
5. **Vidéos immo** : afficher la classe DPE lue dans l'annonce. Si elle est absente, ne rien afficher et le signaler dans les logs.
6. **Musique** : uniquement une bibliothèque libre de droits avec licence commerciale. Sinon YouTube peut bloquer la vidéo.
7. **Prospection par email** : B2B uniquement, lien de désinscription dans chaque email. Démos générées depuis le site du pro ou AutoScout24, jamais en balayant Leboncoin.
8. **Secrets** uniquement dans les variables d'environnement, jamais dans le code ni les logs.

## Stack

- **Next.js 14** (App Router, TypeScript strict), déployé sur **Vercel**.
- **Supabase** : Postgres, Auth par lien magique email, Storage pour les vidéos.
- **Stripe Checkout** pour l'unité et les packs, avec facture automatique.
- **Claude API** :
  - `claude-haiku-4-5-20251001` pour la lecture d'annonce (1 $ / 5 $ par million de tokens) ;
  - `claude-sonnet-5` pour le choix des photos (vision) et le script (2 $ / 10 $ par million de tokens).
- **ElevenLabs** : voix off. Utiliser l'endpoint avec timestamps pour caler les sous-titres.
- **Remotion** : rendu vidéo via `@remotion/lambda` sur AWS. Évaluer aussi `@remotion/vercel`, qui permettrait de tout garder sur Vercel. La licence est gratuite jusqu'à 3 personnes dans l'entreprise ; vérifier la doc « licensing » à l'installation.
- **YouTube Data API v3** pour la publication.
- **Resend** pour les emails transactionnels et de démo.
- Validation de toutes les sorties de Claude avec **zod**.

## Architecture

```
Lien collé ─┐
Démo prospection ─┼─> Détection plateforme ─> Module de lecture ─> Fiche standard ─> Supabase
Formulaire secours ─┘ (texte + photos si lecture impossible)          │
                                                                        v
                        Claude (tri photos + script) ─> ElevenLabs (voix + timestamps) ─> Remotion (9:16 + 16:9)
                                                                        │
                                                                        v
                        Aperçu filigrané ─> Stripe Checkout ─> Livraison HD (2 MP4 + lien YouTube) ─> crédits
```

Le rendu est long (1 à 3 min) : il passe par une **file de tâches** (table `jobs` dans Supabase + worker), jamais dans la requête HTTP de l'utilisateur.

## Plateformes

Tests faits à la main le 27/09/2026 avec un outil de lecture externe, **pas encore depuis Vercel** (c'est l'étape 0).

| Plateforme | Vertical | Format d'URL | Ce que la page contient | Vidéo dans l'annonce | Version |
|---|---|---|---|---|---|
| Leboncoin | auto | `leboncoin.fr/ad/voitures/{id}` | Jusqu'à 30 photos `img.leboncoin.fr/api/v1/lbcpb1/images/...jpg?rule=ad-large` ; marque, modèle, année, km, énergie, boîte, puissance DIN, finition, 1re mise en circulation, couleur, Crit'Air ; description ; nom du pro + SIREN. Site Next.js : chercher un JSON embarqué (`__NEXT_DATA__`) avant le HTML. | Pros : lien YouTube | V1 |
| Leboncoin | immo | `leboncoin.fr/ad/ventes_immobilieres/{id}` | Même gabarit que l'auto (à confirmer). Certaines annonces ont déjà une vidéo. | Oui | V1 |
| AutoScout24.fr | auto | `autoscout24.fr/offres/{slug}-{uuid}` | Plateforme AutoScout24 GmbH, testée sur la version .lu. Photos `prod.pictures.autoscout24.net/listing-images/{uuid}_{photoId}.jpg/1920x1080.webp`. Bloc JSON de tracking : `stmak`, `stmod`, `cost`, `stmil`, `styea`, `stkw`, `sthp`, `fuel`, `zip`, `city`. Sections données de base, historique, technique, équipements, description. Champ `bad_traffic` (`ok` / `datacenter`) = détection des serveurs. | Lien YouTube (formules pro) | V1 |
| SeLoger | immo | `seloger.com/annonce/achat/{region}/{dept}/{ville}/{ID}` | Prix, pièces, chambres, surface, étage, description complète, caractéristiques, DPE/GES, charges, agence + SIRET, plans, visite 3D. Photos `mms.seloger.com/...jpg?ci_seal=...` : seule l'image principale et les plans apparaissaient dans le texte, galerie complète à confirmer (peut-être en JSON embarqué). | Via le logiciel de l'agence, souvent lien YouTube | V1 |
| La Centrale | auto | `lacentrale.fr/auto-occasion-annonce-{id}.html` | Caractéristiques (20), équipements (27), vendeur, ville. Image principale `image-annonce.lacentrale.fr/1096x829/E{id sans les 2 premiers chiffres}_STANDARD_0.jpg` (ex. 69119858725 → E119858725) ; les suivantes probablement `_1`, `_2`… à confirmer. | Non : réseaux uniquement | V1.1 |
| PAP | immo, particuliers | `pap.fr/annonces/{type}-{ville}-r{id}` | Photos `cdn.pap.fr/photos/pap/.../{x}-p2.webp`, prix, surface, pièces, description. | Visites virtuelles acceptées | V1.1 |
| Bien'ici | immo | — | Page vide sans JavaScript : navigateur automatisé nécessaire. | À vérifier | V2 |
| AutoScout24.ch | auto | `autoscout24.ch/fr/d/{slug}-{id}` | Plateforme différente (SMG). Photos `listing-images.autoscout24.ch/listing/.../{id}/{n}.jpg?w=1920`. Vidéo par lien YouTube uniquement, publique. | Oui | V2 |

**Stratégie de lecture**, dans cet ordre :
1. Données structurées (JSON embarqué, JSON-LD, balises `og:`).
2. Claude (Haiku) sur le HTML nettoyé pour compléter.
3. Formulaire de secours si les étapes 1 et 2 échouent.

Chaque échec est journalisé dans `read_failures` avec la plateforme et la cause (HTTP, captcha, champ manquant).

## Fiche standard

```ts
type Photo = { url: string; width?: number; height?: number };

type VehicleSheet = {
  vertical: 'auto';
  platform: string; sourceUrl: string;
  title: string; make: string; model: string; version?: string;
  year?: number; mileageKm?: number; fuel?: string; gearbox?: string; powerHp?: number;
  price?: number; currency: 'EUR' | 'CHF';
  city?: string; postalCode?: string;
  sellerType: 'pro' | 'particulier'; sellerName?: string; sellerSiren?: string;
  warranty?: string; equipment: string[]; description?: string;
  photos: Photo[];
};

type PropertySheet = {
  vertical: 'immo';
  platform: string; sourceUrl: string;
  transaction: 'vente' | 'location'; propertyType: string;
  price?: number; currency: 'EUR';
  surfaceM2?: number; landM2?: number; rooms?: number; bedrooms?: number; floor?: string;
  city?: string; district?: string; postalCode?: string;
  dpe?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'; ges?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  features: string[]; description?: string;
  agencyName?: string; agencySiret?: string;
  photos: Photo[];
};

type Sheet = VehicleSheet | PropertySheet;
```

## Pipeline vidéo

1. **Tri des photos** (Sonnet 5, vision) : écarter les doublons, flous, logos et visuels publicitaires. Ordonner selon le modèle du vertical. Garder 8 à 10 photos en auto, 10 à 14 en immo.
2. **Script** (Sonnet 5) : accroche en 2 secondes, 3 atouts tirés de la fiche, appel à l'action. Deux variantes :
   - réseaux : avec prix et contact ;
   - annonce : sans prix ni téléphone.
3. **Voix off** (ElevenLabs, avec timestamps) : sous-titres incrustés calés sur les timestamps.
4. **Rendu Remotion** : 1080×1920 et 1920×1080, 30 fps, mouvement lent sur les photos, textes animés, musique en fond. Filigrane sur l'aperçu uniquement.
5. **Journalisation du coût réel** de chaque étape dans `video_costs`.

## Modèles vidéo

| | Auto | Immo |
|---|---|---|
| Durée | 30 à 40 s | 45 à 60 s |
| Ordre des photos | 3/4 avant, profil, arrière, intérieur, tableau de bord, détails | Façade ou vue, séjour, cuisine, chambres, salle de bain, extérieur, plan |
| Voix off | Modèle, année, km, 3 équipements forts, garantie | Quartier, surface, pièces, 3 atouts |
| Version 9:16 | Accroche, prix, contact du garage, sous-titres | Accroche, prix, contact de l'agence, sous-titres, DPE |
| Version 16:9 | Sans prix ni téléphone, sous-titres | Sans prix ni téléphone, sous-titres, DPE |

V1 en français. Allemand, italien et néerlandais doivent pouvoir s'ajouter sans toucher aux modèles : langue en paramètre du script, de la voix et des sous-titres.

## Données (Supabase)

- `accounts` : id, email, created_at
- `credit_ledger` : account_id, delta, reason (`purchase` | `video` | `refund`), stripe_session_id, expires_at (achat + 12 mois)
- `orders` : id, account_id?, email, source_url, platform, vertical, status, stripe_session_id, seller_confirmed (bool), created_at
- `sheets` : order_id, data (jsonb), created_at, purge_at
- `jobs` : id, order_id, step, status, attempts, error, timestamps
- `videos` : id, order_id, format (`9x16` | `16x9`), preview_url, hd_url, youtube_id, regenerations_used
- `video_costs` : video_id, claude_input_tokens, claude_output_tokens, claude_cost, tts_chars, tts_cost, render_cost, total_cost
- `read_failures` : platform, url, reason, created_at

RLS activée partout. Le client ne voit que ses commandes et ses vidéos.

## Paiement et crédits

- Prix de départ, à tester :
  - particulier : 19 € TTC (auto), 39 € TTC (immo) ;
  - pro : 29 € HT (auto), 39 € HT (immo) ;
  - pack 10 : 250 € HT (auto), 350 € HT (immo).
- Un crédit = une annonce, auto ou immo, avec ses deux formats et son lien YouTube.
- Webhook Stripe `checkout.session.completed` → crédite le compte → génère la version HD.
- Une régénération gratuite par vidéo (voix, musique, ton). Remboursement automatique si la vidéo ne peut pas être produite.

## YouTube

- Les vidéos envoyées par un projet API non audité restent **privées**. Demande d'audit à déposer dès le démarrage.
- Avant l'audit : livrer le MP4 avec un mini-tutoriel pour que le client le mette en ligne lui-même.
- Toujours fournir le lien au format `https://www.youtube.com/watch?v={id}`, jamais `/shorts/`.
- Quota par défaut : 100 mises en ligne par jour.

## Variables d'environnement

```
ANTHROPIC_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID_FR=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
REMOTION_AWS_ACCESS_KEY_ID=
REMOTION_AWS_SECRET_ACCESS_KEY=
REMOTION_FUNCTION_NAME=
REMOTION_SERVE_URL=
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=
RESEND_API_KEY=
```

## Ordre de travail

Chaque étape se termine par son critère de fin. Ne pas passer à la suivante sans lui.

### Étape 0 — Test de lecture depuis Vercel (en premier)

- Route `app/api/probe/route.ts` déployée en preview sur Vercel.
- Pour une liste d'URLs (une par plateforme), elle fait un `fetch` avec un User-Agent de navigateur courant et renvoie :
  - statut HTTP, taille, durée ;
  - présence des marqueurs attendus (prix, nombre d'URLs de photos) ;
  - présence de marqueurs de blocage (`captcha`, `datadome`, `cf-chl`, `Access denied`, page vide) ;
  - pour AutoScout24, la valeur de `bad_traffic`.
- URLs de départ (les annonces expirent : en prendre de fraîches si 404) :
  - `https://www.leboncoin.fr/ad/voitures/3209507340`
  - une annonce `leboncoin.fr/ad/ventes_immobilieres/...` récente
  - une annonce `autoscout24.fr/offres/...` récente
  - `https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille-13000/26ZCAGW19827`
  - `https://www.lacentrale.fr/auto-occasion-annonce-69119858725.html`
  - `https://www.pap.fr/annonces/appartement-marseille-13e-13013-r463901049`
- **Critère de fin** : un tableau plateforme → lisible / bloqué / partiel. Si une plateforme de la V1 est bloquée, s'arrêter et proposer une alternative (service de récupération de pages ou extension Chrome) avant de continuer.

### Étape 1 — Prototype en ligne de commande, auto

- `npm run make-video -- <url-leboncoin-auto>` : lecture → fiche → tri des photos → script → voix → rendu local Remotion des deux formats → coût total affiché.
- **Critère de fin** : deux MP4 lisibles, sous-titres calés, aucune information inventée (vérifiée contre la fiche).

### Étape 2 — Modèle immo

- Même commande avec une annonce SeLoger puis Leboncoin immo. DPE affiché.
- **Critère de fin** : deux MP4 immo, avec le même critère de fidélité à la fiche.

### Étape 3 — Module AutoScout24.fr

- Lecture prioritaire du bloc JSON structuré.
- **Critère de fin** : trois annonces AutoScout24.fr converties sans erreur.

### Étape 4 — Site self-service

- Page d'accueil avec champ « Collez le lien de votre annonce ».
- Détection de la plateforme, file de tâches, page d'attente, aperçu filigrané.
- Stripe Checkout, webhook, livraison HD, espace crédits par lien magique.
- Formulaire de secours (texte + photos).
- **Critère de fin** : parcours complet en mode test Stripe, de l'URL collée au téléchargement, sans intervention.

### Étape 5 — Publication YouTube

- Publication automatique si l'audit est validé, sinon livraison du MP4 avec tutoriel.
- **Critère de fin** : lien `watch?v=` fonctionnel collé dans une annonce de test.

### Étape 6 — Tableau de bord admin

- Ventes, vidéos générées, coût moyen réel par vidéo, taux d'échec de lecture par plateforme.

### V1.1 (après 10 ventes et une lecture fiable)

- Modules La Centrale et PAP.
- Démos de prospection envoyées par email.

## Conventions

- Code, noms de variables et commits en anglais ; textes de l'interface et des vidéos en français.
- Un module de lecture par plateforme dans `lib/readers/{platform}.ts`, exportant `canHandle(url: string): boolean` et `read(url: string): Promise<Sheet>`.
- Tests de chaque module sur une page HTML sauvegardée dans `tests/fixtures/`. Ces fixtures servent aux tests et ne sont jamais servies en production.
- Prompts Claude dans `lib/prompts/`, versionnés. Sorties toujours en JSON validé par zod ; une seule relance en cas d'échec de validation.
- Toute dépendance payante ou tout nouveau service externe : demander avant de l'ajouter.
