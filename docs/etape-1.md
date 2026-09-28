# Étape 1 — Prototype en ligne de commande (auto)

`npm run make-video -- <source>` enchaîne : lecture → fiche → tri des photos → script
vérifié → voix → rendu Remotion des deux formats → coût réel affiché.

## Ce qui entre

- **Annonce Leboncoin exportée** (fichier `leboncoin-<numéro>.json`) : Leboncoin bloque la
  lecture par le serveur (étape 0), donc le vendeur l'exporte depuis son navigateur avec le
  favori (`npm run bookmarklet`). Le favori lit seulement la page affichée, sur son clic.
- **Lien AutoScout24.fr** : lu par le serveur (une seule requête).
- **Fiche standard JSON** (formulaire de secours, future extension) : validée par zod.

## Ce qui sort

Dans `out/<plateforme>-<id>-<date>/` (dossier ignoré par git) :

- `video-9x16.mp4` (réseaux : accroche, prix, contact, sous-titres) ;
- `video-16x9.mp4` (annonce : ni prix ni téléphone, sous-titres) ;
- `fiche.json`, `scripts.json`, `costs.json` ; les photos et la voix dans `public/`.

`--preview` ajoute le filigrane « APERÇU ». `--only 9x16|16x9` ne rend qu'un format.

## La mise en page

Les photos Leboncoin font au plus 800×600 : en plein écran vertical, elles seraient agrandies
plus de 3 fois et floues. Les deux formats gardent donc la photo entière dans un cadre 4:3.

- **9:16** : titre en grand et pastilles des caractéristiques (année, km, énergie, boîte,
  puissance ; surface, pièces… en immo) au-dessus de la photo ; photo sur toute la largeur,
  zoom lent, la suivante pousse la précédente ; sous-titres en gros, le mot prononcé en jaune ;
  prix et vendeur sous la photo ; fond : la photo floutée. Tout ce qui compte reste hors des
  barres de TikTok, Reels et Shorts.
- **16:9** : photo 1440×1080 à gauche, panneau « fiche technique » à droite, sous-titres sur
  la photo ; ni prix ni téléphone.
- **Fin** : titre, caractéristiques et, en 9:16, prix en très grand et vendeur.

Les caractéristiques affichées sont reprises telles quelles de la fiche (`lib/render/specs.ts`),
sans passer par Claude.

## Les garde-fous

- **Aucune invention (règle 3).** Le script est écrit par Claude Sonnet 5 à partir de la seule
  fiche, puis contrôlé de deux façons : un contrôle déterministe (chaque nombre dit ou affiché
  doit figurer dans la fiche, pas de prix ni de téléphone dans la version annonce, lexique
  d'affirmations qui exigent une preuve dans la fiche : « état impeccable », « première
  main », « entretien suivi »…) et une relecture par Claude Haiku. En cas de problème, une
  seule réécriture avec la liste des problèmes ; s'il en reste, **la vidéo n'est pas faite**
  et la commande affiche ce qui ne va pas.
- **Photos.** Téléchargées une à une depuis les serveurs d'images (autorisés, étape 0 bis),
  vérifiées par leurs premiers octets, puis triées par Claude (doublons, flous, logos,
  visuels publicitaires écartés ; ordre du modèle : 3/4 avant, profil, arrière, intérieur,
  tableau de bord, détails ; 8 à 10 gardées).
- **Voix.** ElevenLabs avec horodatage : les sous-titres sont calés mot à mot.
- **Musique.** Aucune tant que la bibliothèque n'est pas choisie (règle 6) ; `--music
  <fichier>` pour un morceau sous licence commerciale.
- **Secrets.** Uniquement dans l'environnement (`.env.local`), jamais affichés, même dans
  les messages d'erreur.

## Lancer le vrai test sur ta machine

Ce conteneur n'a pas de clés et son réseau bloque ElevenLabs et les photos : le test réel se
fait sur ta machine.

1. Installer [Node.js 22](https://nodejs.org) et git, puis :

   ```bash
   git clone https://github.com/shakeagencyfr-lab/annonce-video.git
   cd annonce-video
   git checkout claude/new-session-t965yn
   npm install
   ```

2. Créer `.env.local` à la racine (modèle : `.env.example`) :

   ```bash
   ANTHROPIC_API_KEY=sk-ant-...      # ou APP_ANTHROPIC_API_KEY
   ELEVENLABS_API_KEY=...
   ELEVENLABS_VOICE_ID_FR=...        # une voix française de ta bibliothèque ElevenLabs
   ELEVENLABS_USD_PER_1K_CHARS=0.22  # le prix réel de ton offre
   ```

3. Créer le favori : `npm run bookmarklet`, suivre les instructions affichées.
4. Ouvrir une annonce auto Leboncoin (la tienne ou celle d'un client d'accord), cliquer sur
   le favori : `leboncoin-<numéro>.json` se télécharge.
5. Lancer :

   ```bash
   npm run make-video -- ~/Downloads/leboncoin-<numéro>.json
   # ou : npm run make-video -- "https://www.autoscout24.fr/offres/..."
   ```

   Au premier rendu, Remotion télécharge son navigateur (une fois, environ 100 Mo).

**Critère de fin** : deux MP4 lisibles, sous-titres calés sur la voix, aucune information
inventée. Pour le vérifier, comparer `scripts.json` à `fiche.json` et regarder les vidéos.

Ordre de grandeur attendu : environ 0,05 $ de Claude (tri de 10 à 20 photos, script, relecture)
et 0,25 à 0,30 $ de voix pour les deux versions, soit **environ 0,35 $ par annonce**. La
commande affiche le coût réel, étape par étape.

## Lancer le test dans une session Claude Code cloud (sans rien installer)

Dans la session : menu du titre → **Modifier l'environnement cloud**.

- **Identifiants d'API** → **Ajouter** : site autorisé `api.elevenlabs.io`, en-tête `xi-api-key`
  sans préfixe, valeur = la clé ElevenLabs. Le proxy de l'environnement l'ajoute aux requêtes :
  la clé n'apparaît jamais dans la session. Laisser `ELEVENLABS_API_KEY` vide.
- **Variables d'environnement** (visibles par qui utilise l'environnement : n'y mettre que ce
  qui ne peut pas passer par un identifiant d'API) :

  ```
  APP_ANTHROPIC_API_KEY=...   # api.anthropic.com ne reçoit jamais d'identifiant d'API ;
                              # ANTHROPIC_API_KEY est réservé à Claude Code
  ELEVENLABS_VOICE_ID_FR=...
  ELEVENLABS_USD_PER_1K_CHARS=0.22
  REMOTION_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell
  ```

  Pour limiter le risque, fixer une limite de dépenses mensuelle sur la clé Anthropic (console).
- **Accès réseau** : Custom, domaines `img.leboncoin.fr`, `www.autoscout24.fr`,
  `prod.pictures.autoscout24.net` (+ `api.elevenlabs.io` si la clé passe en variable), case
  « gestionnaires de paquets » cochée.

Puis ouvrir une **nouvelle** session (les réglages s'appliquent au démarrage), y joindre le
fichier exporté et demander : `npm install`, puis `npm run make-video -- <fichier>`.

## Tester sans clés

```bash
npm run make-video -- tests/fixtures/sheets/auto-308.json --offline --photos <dossier de photos>
```

Script tiré de la fiche par un modèle fixe (sans Claude), vidéo muette : toute la chaîne
jusqu'au rendu, gratuitement. `npm run render-sample` rend un échantillon de 12 s.

## Ce qui est vérifié, ce qui ne l'est pas encore

- **Vérifié ici** : 326 tests (lecteurs, photos, script et contrôle anti-invention, voix,
  sous-titres, rendu, orchestration avec des faux Claude et ElevenLabs) ; deux MP4 réels
  rendus hors ligne (1080×1920 et 1920×1080, 30 i/s), images contrôlées une à une.
- **Pas encore vérifié** (pas de clés ni de réseau ici) : les vrais appels Claude et
  ElevenLabs, une vraie page AutoScout24 (structure tirée de sources publiques 2026), le
  favori sur une vraie page Leboncoin, la qualité des photos Leboncoin en HD (la plus grande
  variante connue fait environ 1200×800). C'est l'objet du test sur ta machine.

## Licence Remotion

Vérifiée à l'installation (4.0.529) : gratuite, usage commercial compris, pour une entreprise
d'au plus 3 personnes ; les conditions changent avec Remotion 5.0. Le rendu passe
`licenseKey: "free-license"` (Remotion envoie alors un décompte anonyme des rendus) ; une clé
de licence entreprise irait dans `REMOTION_LICENSE_KEY`.
