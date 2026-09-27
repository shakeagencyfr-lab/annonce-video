# Étape 0 — Test de lecture depuis Vercel

## Ce que fait la route

`GET /api/probe` lit **une annonce par plateforme** avec un `fetch` simple (User-Agent de
Chrome, `Accept-Language: fr-FR`) et renvoie pour chacune : statut HTTP, taille, durée,
présence des données de l'annonce, du prix, nombre de photos, DPE (immo), `bad_traffic`
(AutoScout24), signaux anti-robot, et un verdict :

| Verdict | Sens |
|---|---|
| **lisible** | les données de l'annonce sont dans le HTML, avec un prix et au moins une photo |
| **partiel** | la page est servie mais il manque le prix, les photos ou les données attendues |
| **bloqué** | page de captcha ou de défi (DataDome, Cloudflare, Akamai, CloudFront), HTTP 401/403/429, ou petite page vide |
| **expirée** | 404/410, annonce retirée ou redirection hors d'une page d'annonce : prendre une annonce plus récente |
| **erreur** | réseau, délai dépassé, statut inattendu |

Respect des règles du projet :

- une annonce à la fois, jamais de page de recherche : seules les URL d'annonce individuelle
  des domaines prévus sont acceptées (`lib/probe/platforms.ts`), les redirections ne sont
  suivies que vers une autre page d'annonce de la même plateforme ;
- jusqu'à trois annonces candidates par plateforme, lues l'une après l'autre, la suivante
  seulement si la précédente a expiré ;
- le HTML n'est ni conservé, ni journalisé, ni renvoyé ; le titre de l'annonce non plus
  (il peut contenir un téléphone), ni la valeur des cookies ;
- aucune tentative de contournement : pas d'imitation d'empreinte TLS, pas de proxy, pas
  de cookie renvoyé.

## Lancer le test

1. Créer le projet Vercel à partir du dépôt `shakeagencyfr-lab/annonce-video`, avec la
   variable `PROBE_ENABLED=1`. La route répond 404 sans elle. `vercel.json` fixe la région
   des fonctions à `cdg1` (Paris).
2. Ouvrir, connecté à Vercel (les déploiements sont protégés par Vercel Authentication) :
   - `https://<déploiement>/api/probe?format=md` : tableau Markdown ;
   - `https://<déploiement>/api/probe` : JSON détaillé.
3. Paramètres :
   - `platform=leboncoin-auto,seloger` : limiter aux plateformes voulues ;
   - `url=<annonce>` (répétable, 3 par plateforme au plus) : remplace les annonces de départ
     de sa plateforme ;
   - un appel toutes les 30 s au plus par instance.
4. Si `PROBE_TOKEN` est défini, l'appel doit envoyer l'en-tête `x-probe-token`.

Le rapport signale si la fonction ne tourne pas en `cdg1`. Il indique aussi les en-têtes
envoyés, y compris ceux que Node ajoute d'office (`sec-fetch-mode: cors`,
`accept-encoding: br, gzip, deflate`).

## Ce que la recherche laisse prévoir

Recherche du 27/09/2026 à partir de sources publiques (dépôts open source, retours
d'expérience, moteurs de recherche). Aucune page des plateformes n'a été lue depuis ce
conteneur : leur accès y est bloqué par le proxy.

| Plateforme | Protection | Où sont les données | Pronostic depuis Vercel |
|---|---|---|---|
| Leboncoin (auto, immo) | DataDome | `__NEXT_DATA__`, route `/ad/[cat]/[id]`, `props.pageProps.ad` (prix `price: [n]`, `images.urls_large`, `attributes` dont `energy_rate`) | bloqué probable (403 ~1 Ko, `t: 'bv'`, IP de datacenter) |
| AutoScout24.fr | incertaine (CloudFront ; Akamai ou DataDome selon les sources) + `bad_traffic` | `__NEXT_DATA__`, `props.pageProps.listingDetails` (`prices.public.priceRaw`, `images`) | lisible possible, avec `bad_traffic=datacenter` |
| SeLoger | DataDome (plus strict que Leboncoin) | `window["__UFRN_LIFECYCLE_SERVERREQUEST__"] = JSON.parse("…")`, `app_cldp.data.classified` (galerie complète, `energy_letter`) | bloqué très probable |
| La Centrale | DataDome derrière CloudFront | `var CLASSIFIED_MAIN_INFOS`, `CLASSIFIED_GALLERY` ; photos `{lettre}{id}_STANDARD_{n}.jpg`, où la lettre vient des 2 premiers chiffres de l'id (69 → E) | bloqué très probable |
| PAP | Cloudflare | JSON-LD `Product` (prix, images), `span.item-price`, `energy-indice` | incertain : défi Cloudflare possible depuis un datacenter |

## Si une plateforme de la V1 est bloquée

CLAUDE.md demande de s'arrêter et de proposer une alternative avant l'étape 1. Pistes, de
la plus sûre à la moins sûre :

1. **Extension Chrome (ou favori JavaScript)** : le vendeur, sur la page de sa propre
   annonce, clique sur le bouton ; l'extension lit la page déjà affichée dans son
   navigateur et envoie la fiche à notre API. Aucun contournement, une annonce à la fois, à
   la demande du vendeur : c'est l'option la plus proche des règles 1 et 3. Coût : une
   étape de plus pour l'utilisateur, publication sur le Chrome Web Store, pas de mobile.
2. **Formulaire de secours** (déjà prévu) : texte collé et photos téléversées. Il marche
   partout, mais c'est plus de friction et la fidélité de la fiche dépend de l'utilisateur.
3. **Sources des pros** : le site du garage ou de l'agence, le flux de leur logiciel
   (multidiffusion), AutoScout24 si la lecture passe. Adapté à la prospection B2B et aux
   pros.
4. **Service de récupération de pages** (proxy résidentiel, navigateur géré) : payant,
   donc à valider avant tout ajout (Conventions). Surtout, face à DataDome, il sert à
   contourner une protection technique ; le risque juridique est à évaluer avec la
   jurisprudence Entreparticuliers en tête. Déconseillé sans avis juridique.

## Résultats du 27/09/2026 (21:50 UTC, Vercel `cdg1`, Node 22.23.2)

Un seul appel, une annonce lue par plateforme. Les détails viennent des journaux du déploiement.

| Plateforme | Version | HTTP | Taille | Durée | Ce qui a répondu | Verdict |
|---|---|---|---|---|---|---|
| Leboncoin auto | V1 | 403 | 1 Ko | 55 ms | DataDome, captcha demandé (`t: 'fe'`), cookie `datadome` | **bloqué** |
| Leboncoin immo | V1 | 403 | 1 Ko | 19 ms | idem | **bloqué** |
| AutoScout24.fr | V1 | 200 | 461 Ko | 141 ms | nginx ; `__NEXT_DATA__` avec `listingDetails`, prix structuré, 20 photos ; `bad_traffic: "badasn"` | **lisible** |
| SeLoger | V1 | 403 | 0,8 Ko | 67 ms | DataDome derrière CloudFront, captcha (`t: 'fe'`) | **bloqué** |
| La Centrale | V1.1 | 403 | 0,8 Ko | 43 ms | DataDome derrière CloudFront, captcha (`t: 'fe'`) | **bloqué** |
| PAP | V1.1 | 403 | 6 Ko | 28 ms | Cloudflare, défi anti-robot (cookie `__cf_bm`) | **bloqué** |

Remarques :

- Les refus arrivent en moins de 70 ms : la décision est prise sur l'adresse IP (datacenter AWS)
  et l'empreinte de la requête, avant tout contenu. Réessayer ou ralentir n'y changera rien.
- DataDome répond `t: 'fe'` (captcha à résoudre) et non `t: 'bv'` (IP bannie). Pour un serveur,
  c'est un blocage dans les deux cas.
- AutoScout24 : les deux premières annonces de départ renvoyaient une redirection 301 hors d'une
  page d'annonce (annonces retirées, redirection non suivie) ; la troisième a été lue en entier.
  `bad_traffic` y vaut `badasn`, une valeur que la recherche n'avait pas relevée (on
  attendait `ok` ou `datacenter`) : le site reconnaît un réseau d'hébergeur mais sert la page.
  Cela peut changer sans prévenir.

## Conclusion

Critère de fin atteint. Trois plateformes de la V1 sur quatre sont **bloquées** depuis Vercel
(Leboncoin auto, Leboncoin immo, SeLoger), de même que les deux de la V1.1. Seul AutoScout24.fr
est lisible. Conformément à CLAUDE.md, on s'arrête ici : la lecture par le serveur, telle que
prévue, ne marche pas pour la source principale (Leboncoin).

Proposition, à valider avant l'étape 1 :

1. **AutoScout24.fr lu par le serveur**, comme prévu (étape 3), en surveillant `bad_traffic`
   et le taux d'échec dans `read_failures`.
2. **Leboncoin et SeLoger via une extension Chrome** : le vendeur ouvre son annonce et clique ;
   l'extension lit la page affichée dans son navigateur et envoie la fiche. C'est la seule voie
   testée ici qui respecte les règles 1 et 3 sans contourner de protection. Surtout pour les
   pros, qui travaillent sur ordinateur.
3. **Formulaire de secours** pour le mobile et les particuliers : description collée et photos
   téléversées depuis le téléphone, où elles se trouvent déjà.
4. **Pas de service de contournement** (proxy résidentiel, navigateur géré) sans avis juridique.

Question à trancher avant de choisir entre 2 et 3 : les **serveurs d'images**
(`img.leboncoin.fr`, `mms.seloger.com`…) acceptent-ils Vercel ? Si oui, l'extension n'envoie
que la fiche et les URL des photos ; si non, elle doit aussi téléverser les photos. Un test
d'une image par plateforme depuis Vercel suffit pour le savoir.
