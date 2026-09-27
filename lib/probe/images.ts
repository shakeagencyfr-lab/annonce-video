import { detectSignals, normalizeBody, type Signal } from './analyze';
import { ACCEPT_IMAGE, fetchListing, type FetchOutcome } from './fetch';
import { getPlatform, matchPlatform, type PlatformId } from './platforms';
import type { ProbeConfig } from './run';

export type ImageGroupId = 'leboncoin' | 'autoscout24' | 'seloger' | 'lacentrale' | 'pap';

export type ImageGroup = {
  id: ImageGroupId;
  label: string;
  /** Photo hosts of the platform; only these are fetched. */
  hosts: readonly string[];
  /** Real listing photos found in public sources, tried in order until one is found. */
  seedImages: readonly string[];
  /** A well-formed URL of an object that cannot exist: shows who answers on this host. */
  missingImage: string;
  /** When the listing page is readable, its first photo is taken from it. */
  listing?: { platform: PlatformId; photoUrl: RegExp };
};

export const IMAGE_GROUPS: readonly ImageGroup[] = [
  {
    id: 'leboncoin',
    label: 'Leboncoin',
    hosts: ['img.leboncoin.fr'],
    // Public fixtures of listings published 2026-09-25 and 2026-08-26 (no signature on this host).
    seedImages: [
      'https://img.leboncoin.fr/api/v1/lbcpb1/images/d4/fc/28/d4fc283c7c587e60076c735422df513c5492dd73.jpg?rule=ad-large',
      'https://img.leboncoin.fr/api/v1/lbcpb1/images/14/98/50/14985046a39d69ae8688d3b6a485d65fa3b051da.jpg?rule=ad-large',
      'https://img.leboncoin.fr/api/v1/lbcpb1/images/d4/64/ab/d464ab5481809e22aa77582a0a8ce10775aee4d1.jpg?rule=ad-large',
    ],
    missingImage:
      'https://img.leboncoin.fr/api/v1/lbcpb1/images/00/00/00/0000000000000000000000000000000000000000.jpg?rule=ad-large',
  },
  {
    id: 'autoscout24',
    label: 'AutoScout24.fr',
    hosts: ['prod.pictures.autoscout24.net'],
    seedImages: [],
    missingImage:
      'https://prod.pictures.autoscout24.net/listing-images/00000000-0000-0000-0000-000000000000_00000000-0000-0000-0000-000000000000.jpg/1280x960.webp',
    listing: {
      platform: 'autoscout24-fr',
      photoUrl:
        /https:\/\/prod\.pictures\.autoscout24\.net\/listing-images\/[0-9a-f-]{36}_[0-9a-f-]{8,}\.jpe?g\/\d+x\d+\.(?:webp|jpe?g)/i,
    },
  },
  {
    id: 'seloger',
    label: 'SeLoger',
    hosts: ['mms.seloger.com'],
    // Public fixtures of listings created 2026-09-25. ci_seal is a Cloudimage signature:
    // the URL must be used as served, it cannot be rebuilt or resized.
    seedImages: [
      'https://mms.seloger.com/a/b/a/6/aba690f4-93db-44bb-8d4c-0fc0c5f3ca79.jpg?ci_seal=2a18f5c437177ab206bbe1254cb8d02279094778',
      'https://mms.seloger.com/a/7/b/5/a7b5d58f-48c4-470e-b312-c7873a76629e.jpg?ci_seal=5917bc1ace3f390256dac4dcb1b917b3182a79e9',
      'https://mms.seloger.com/3/7/d/6/37d6cc74-693f-49c7-a5a0-047d5c5d1b62.jpg?ci_seal=c70471a8884861d6490501eabd163401b2590942',
    ],
    missingImage: 'https://mms.seloger.com/0/0/0/0/00000000-0000-0000-0000-000000000000.jpg',
  },
  {
    id: 'lacentrale',
    label: 'La Centrale',
    hosts: ['image-annonce.lacentrale.fr', 'pictures.lacentrale.fr'],
    // Legacy host format from CLAUDE.md, applied to the step 0 seed listing (69119858725).
    seedImages: ['https://image-annonce.lacentrale.fr/1096x829/E119858725_STANDARD_0.jpg'],
    missingImage: 'https://image-annonce.lacentrale.fr/1096x829/E000000000_STANDARD_0.jpg',
  },
  {
    id: 'pap',
    label: 'PAP',
    hosts: ['cdn.pap.fr'],
    // Public fixtures from April-May 2026; no signature on this host.
    seedImages: [
      'https://cdn.pap.fr/photos/pap/af/2c/af2c19c7b92e0f3d327d0504129ff9e4/a-p2.webp',
      'https://cdn.pap.fr/photos/pap/ac/9c/ac9c2650a2c893fb5480e3b425511929/a-p2.webp',
      'https://cdn.pap.fr/photos/pap/f6/ee/f6eeee0144a2793f4bc4255507d3a25e/f-p2.webp',
    ],
    missingImage: 'https://cdn.pap.fr/photos/pap/00/00/00000000000000000000000000000000/0-p2.webp',
  },
];

export type ImageVerdict = 'accessible' | 'bloqué' | 'introuvable' | 'erreur';

export type ImageSource = 'annonce' | 'recherche' | 'fournie' | 'objet absent (témoin)';

export type ImageProbe = {
  url: string;
  source: ImageSource;
  status: number | null;
  contentType: string | null;
  format: string | null;
  bytes: number | null;
  durationMs: number | null;
  server: string | null;
  cache: string | null;
  signals: Signal[];
  verdict: ImageVerdict;
  reasons: string[];
};

export type ImageGroupResult = {
  group: ImageGroupId;
  label: string;
  /** Best candidate: an accessible image, else the most telling failure. */
  image: ImageProbe | null;
  attempts: ImageProbe[];
  /** The missing-object control: what the host answers for a photo that does not exist. */
  control: ImageProbe | null;
  verdict: ImageVerdict | 'non testé';
  reasons: string[];
};

export function imageGroupFor(url: URL): ImageGroup | undefined {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return undefined;
  const host = url.hostname.toLowerCase();
  return IMAGE_GROUPS.find((g) => g.hosts.includes(host));
}

/** Image format from its first bytes (magic numbers), whatever the Content-Type says. */
export function sniffImage(head: Uint8Array | undefined): string | null {
  if (!head || head.length < 4) return null;
  const at = (i: number) => head[i] ?? -1;
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
  if (at(0) === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand === 'heic' || brand === 'mif1') return 'heic';
  }
  return null;
}

/** S3 / CloudFront style XML error: the object is missing or its signature refused. */
const STORAGE_ERROR = /<Error>\s*<Code>(NoSuchKey|AccessDenied|SignatureDoesNotMatch|InvalidSignature|NoSuchBucket)<\/Code>/i;

function emptyProbe(url: string, source: ImageSource): ImageProbe {
  return {
    url,
    source,
    status: null,
    contentType: null,
    format: null,
    bytes: null,
    durationMs: null,
    server: null,
    cache: null,
    signals: [],
    verdict: 'erreur',
    reasons: [],
  };
}

export function classifyImage(outcome: FetchOutcome, probe: ImageProbe): ImageProbe {
  probe.durationMs = outcome.durationMs;
  if (outcome.kind !== 'response') {
    const hop = outcome.hop;
    if (hop) {
      probe.status = hop.status;
      probe.server = hop.headers['server'] ?? null;
      probe.signals = detectSignals({ ...hop, body: '', bytes: 0, truncated: false }, 0).filter((s) => s.id !== 'captcha-word');
    }
    const strong = probe.signals.filter((s) => s.strength === 'strong');
    probe.verdict = strong.length > 0 ? 'bloqué' : 'erreur';
    probe.reasons.push(
      ...strong.map((s) => s.detail),
      outcome.kind === 'error' ? outcome.error : `redirection vers ${outcome.location}, hors des hôtes d’images : non suivie`,
    );
    return probe;
  }

  const raw = outcome.raw;
  probe.status = raw.status;
  probe.contentType = raw.headers['content-type'] ?? null;
  probe.bytes = raw.bytes;
  probe.server = raw.headers['server'] ?? null;
  probe.cache = raw.headers['x-cache'] ?? raw.headers['cf-cache-status'] ?? null;
  probe.format = sniffImage(raw.head);
  const body = normalizeBody(raw.body);
  probe.signals = detectSignals({ ...raw, body }, body.length);
  const strong = probe.signals.filter((s) => s.strength === 'strong' && s.id !== 'http-status');
  const ok = raw.status >= 200 && raw.status < 300;
  const storageError = STORAGE_ERROR.exec(body)?.[1];

  if (ok && probe.format) {
    probe.verdict = 'accessible';
    probe.reasons.push(`image ${probe.format} de ${Math.round(raw.bytes / 1024)} Ko reçue`);
    if (raw.truncated) probe.reasons.push('téléchargement arrêté à la taille maximale');
  } else if (strong.length > 0) {
    probe.verdict = 'bloqué';
    probe.reasons.push(...strong.map((s) => s.detail));
  } else if (raw.status === 404 || raw.status === 410) {
    probe.verdict = 'introuvable';
    probe.reasons.push(`HTTP ${raw.status} : image absente`);
  } else if (storageError) {
    probe.verdict = 'introuvable';
    probe.reasons.push(`HTTP ${raw.status} ${storageError} : objet absent ou signature refusée, réponse du stockage et non d’un anti-robot`);
  } else if ([401, 403, 407, 429, 451].includes(raw.status)) {
    probe.verdict = 'bloqué';
    probe.reasons.push(`HTTP ${raw.status}${probe.contentType ? ` (${probe.contentType})` : ''}`);
  } else {
    probe.verdict = 'erreur';
    probe.reasons.push(ok ? `HTTP ${raw.status} mais pas une image (${probe.contentType ?? 'type inconnu'})` : `HTTP ${raw.status} inattendu`);
  }
  for (const s of probe.signals) if (s.strength === 'weak') probe.reasons.push(`⚠ ${s.detail}`);
  return probe;
}

export async function probeImage(url: URL, source: ImageSource, config: ProbeConfig): Promise<ImageProbe> {
  const outcome = await fetchListing(url, {
    ...config,
    accept: ACCEPT_IMAGE,
    followRedirect: (next) => imageGroupFor(next)?.id === imageGroupFor(url)?.id,
  });
  return classifyImage(outcome, emptyProbe(url.href, source));
}

/** First photo of the group's listing, when the listing page is readable. One listing read at most. */
export async function photoFromListing(group: ImageGroup, config: ProbeConfig): Promise<URL | null> {
  if (!group.listing) return null;
  const platform = getPlatform(group.listing.platform);
  if (!platform) return null;
  for (const seed of platform.seedUrls) {
    const url = new URL(seed);
    const outcome = await fetchListing(url, { ...config, followRedirect: (next) => matchPlatform(next)?.id === platform.id });
    if (outcome.kind !== 'response') continue; // expired listing (redirect) or error: try the next one
    const body = normalizeBody(outcome.raw.body);
    if (!platform.listingData.test(body)) return null; // served but not a listing: do not insist
    const found = group.listing.photoUrl.exec(body)?.[0];
    return found ? new URL(found) : null;
  }
  return null;
}

export type ImageTarget = { group: ImageGroup; candidates: { url: URL; source: ImageSource }[] };

/**
 * Candidates per group: images passed in (on the group's hosts only, three at most),
 * otherwise the seed images. The listing photo is added at run time.
 */
export function resolveImageTargets(
  inputs: readonly string[],
  groupFilter: readonly string[],
): { targets: ImageTarget[]; rejected: { input: string; reason: string }[] } {
  const rejected: { input: string; reason: string }[] = [];
  const given = new Map<ImageGroupId, URL[]>();
  for (const input of inputs.slice(0, IMAGE_GROUPS.length * 3)) {
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      rejected.push({ input, reason: 'URL invalide' });
      continue;
    }
    url.hash = '';
    const group = imageGroupFor(url);
    if (!group) {
      rejected.push({ input, reason: 'pas un hôte de photos d’une plateforme prise en charge' });
      continue;
    }
    const list = given.get(group.id) ?? [];
    if (list.length >= 3) {
      rejected.push({ input, reason: 'au plus 3 images par plateforme' });
      continue;
    }
    list.push(url);
    given.set(group.id, list);
  }
  const filter = new Set(groupFilter);
  const targets = IMAGE_GROUPS.filter((g) => filter.size === 0 || filter.has(g.id)).map((group) => ({
    group,
    candidates:
      given.get(group.id)?.map((url) => ({ url, source: 'fournie' as const })) ??
      group.seedImages.slice(0, 3).map((u) => ({ url: new URL(u), source: 'recherche' as const })),
  }));
  return { targets, rejected };
}

function groupVerdict(result: ImageGroupResult): void {
  const { attempts, control } = result;
  const accessible = attempts.find((a) => a.verdict === 'accessible');
  const blocked = attempts.find((a) => a.verdict === 'bloqué') ?? (control?.verdict === 'bloqué' ? control : undefined);
  if (accessible) {
    result.image = accessible;
    result.verdict = 'accessible';
    result.reasons.push(`photo téléchargée depuis ${new URL(accessible.url).hostname}`);
  } else if (blocked) {
    result.image = blocked;
    result.verdict = 'bloqué';
    result.reasons.push(...blocked.reasons);
  } else if (attempts.length > 0 && attempts.every((a) => a.verdict === 'introuvable')) {
    result.image = attempts[0] ?? null;
    result.verdict = 'introuvable';
    result.reasons.push('aucune des images connues n’existe plus : fournir ?img=<URL d’une photo récente>');
  } else if (attempts.length === 0) {
    result.verdict = control?.verdict === 'bloqué' ? 'bloqué' : 'non testé';
    result.reasons.push('aucune URL d’image : fournir ?img=<URL d’une photo récente>');
  } else {
    result.image = attempts[0] ?? null;
    result.verdict = 'erreur';
    result.reasons.push(...(attempts[0]?.reasons ?? []));
  }
  if (control && result.verdict !== 'bloqué') {
    const front =
      control.verdict === 'bloqué'
        ? `l’objet témoin est bloqué (${control.reasons[0] ?? 'anti-robot'})`
        : `l’objet témoin répond HTTP ${control.status ?? '—'} sans protection anti-robot`;
    result.reasons.push(front);
  }
}

/** Sequential: one image at a time, the next candidate only if the previous one is missing. */
export async function probeImages(
  targets: readonly ImageTarget[],
  config: ProbeConfig,
  budgetMs: number,
  onResult: (result: ImageGroupResult) => void = () => {},
): Promise<ImageGroupResult[]> {
  const started = performance.now();
  const hasTime = () => performance.now() - started + config.timeoutMs <= budgetMs;
  const results: ImageGroupResult[] = [];
  for (const { group, candidates } of targets) {
    const result: ImageGroupResult = {
      group: group.id,
      label: group.label,
      image: null,
      attempts: [],
      control: null,
      verdict: 'non testé',
      reasons: [],
    };
    try {
      const list = [...candidates];
      if (hasTime() && !list.some((c) => c.source === 'fournie')) {
        const fromListing = await photoFromListing(group, config);
        if (fromListing) list.unshift({ url: fromListing, source: 'annonce' });
      }
      for (const { url, source } of list) {
        if (!hasTime()) break;
        const probe = await probeImage(url, source, config);
        result.attempts.push(probe);
        if (probe.verdict !== 'introuvable') break;
      }
      if (hasTime()) result.control = await probeImage(new URL(group.missingImage), 'objet absent (témoin)', config);
      groupVerdict(result);
    } catch (err) {
      result.verdict = 'erreur';
      result.reasons.push(`erreur interne : ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!hasTime() && result.verdict === 'non testé') result.reasons.push('temps imparti dépassé');
    onResult(result);
    results.push(result);
  }
  return results;
}

export function imagesToMarkdown(
  results: readonly ImageGroupResult[],
  meta: { probedAt: string; region: string; node: string; warnings: readonly string[]; rejected: readonly { input: string; reason: string }[] },
): string {
  const kb = (b: number | null) => (b === null ? '—' : `${Math.round(b / 1024)} Ko`);
  const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# Test des images — ${meta.probedAt} — région ${meta.region} — Node ${meta.node}`,
    '',
    ...meta.warnings.map((w) => `> ⚠ ${w}`),
    ...(meta.warnings.length ? [''] : []),
    '| Plateforme | Hôte | Source | HTTP | Format | Taille | Durée | Serveur | Témoin (objet absent) | Verdict | Raisons |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const i = r.image;
    const c = r.control;
    lines.push(
      '| ' +
        [
          r.label,
          i ? new URL(i.url).hostname : '—',
          i?.source ?? '—',
          i?.status === null || i === null ? '—' : String(i.status),
          i?.format ?? '—',
          kb(i?.bytes ?? null),
          i?.durationMs == null ? '—' : `${i.durationMs} ms`,
          i?.server ?? '—',
          c ? `HTTP ${c.status ?? '—'} ${c.verdict}` : '—',
          `**${r.verdict}**`,
          [
            ...r.reasons,
            ...(r.attempts.length > 1 ? [`essais : ${r.attempts.map((a) => `${a.status ?? '—'} ${a.verdict}`).join(', ')}`] : []),
          ].join(' ; ') || '—',
        ]
          .map(cell)
          .join(' | ') +
        ' |',
    );
  }
  if (meta.rejected.length > 0) {
    lines.push('', 'URLs refusées :', ...meta.rejected.map((r) => `- ${r.input} : ${r.reason}`));
  }
  return lines.join('\n') + '\n';
}
