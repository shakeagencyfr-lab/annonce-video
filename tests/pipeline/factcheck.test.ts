import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  checkScripts,
  describeProblem,
  factSource,
  findNumbers,
  type Problem,
  unsupportedProblem,
  verifyWithClaude,
} from '@/lib/pipeline/factcheck';
import type { Variant, VideoScript } from '@/lib/pipeline/types';
import { FACTCHECK_PROMPT_VERSION } from '@/lib/prompts/factcheck.v1';
import { parseSheet, type PropertySheet, type Sheet } from '@/lib/sheet';
import { auto, cleanAnswer, cleanScripts, fakeClaude, type ParseParams, recordingFetch, toScripts } from './script-helpers';

const HAIKU = 'claude-haiku-4-5-20251001';

type Scripts = Record<Variant, VideoScript>;

/** Clean scripts with one change. */
function edit(change: (s: Scripts) => void): Scripts {
  const scripts = cleanScripts();
  change(scripts);
  return scripts;
}

const setText = (s: Scripts, variant: Variant, index: number, text: string) => {
  (s[variant].segments[index] as VideoScript['segments'][number]).text = text;
};

const brief = (problems: Problem[]) => problems.map(({ variant, where, kind }) => `${variant} ${where} ${kind}`);

describe('checkScripts', () => {
  it('passes scripts that only state what the sheet says', () => {
    expect(checkScripts(cleanScripts(), auto)).toEqual([]);
  });

  it('flags a number that is not in the sheet, in the voice-over and on screen', () => {
    const scripts = edit((s) => {
      setText(s, 'social', 1, 'Elle affiche 70 000 kilomètres et 5 places.');
      s.listing.overlays.subtitle = '2019 · 70 000 km · Essence';
    });
    expect(checkScripts(scripts, auto)).toEqual([
      { variant: 'social', where: 'segments[1].text', kind: 'number', message: '« 70 000 » ne figure pas dans la fiche' },
      { variant: 'social', where: 'segments[1].text', kind: 'number', message: '« 5 » ne figure pas dans la fiche' },
      { variant: 'listing', where: 'overlays.subtitle', kind: 'number', message: '« 70 000 » ne figure pas dans la fiche' },
    ]);
  });

  it('accepts the usual ways of writing the same number', () => {
    for (const km of ['68 000', '68\u202f000', '68\u00a0000', '68\u2009000', '68.000', '68000']) {
      const scripts = edit((s) => {
        setText(s, 'listing', 1, `Elle affiche ${km} kilomètres.`);
        s.social.overlays.subtitle = `2019 · ${km} km · Essence`;
      });
      expect(checkScripts(scripts, auto), km).toEqual([]);
    }
    for (const price of ['15 990 €', '15\u202f990\u00a0€', '15.990 €', '15990 EUR', '15 990,00 €']) {
      const scripts = edit((s) => {
        s.social.overlays.price = price;
        setText(s, 'social', 6, `Son prix : ${price.replace('€', 'euros')}.`);
      });
      expect(checkScripts(scripts, auto), price).toEqual([]);
    }
    expect(checkScripts(edit((s) => setText(s, 'social', 0, 'Peugeot 308, 130 ch, de 2019.')), auto)).toEqual([]);
    expect(findNumbers('64,7 m², 1.2 PureTech, 15.990 €').map((n) => n.value)).toEqual([64.7, 1.2, 15990]);
  });

  it('reads side-by-side numbers as the one number the viewer hears', () => {
    const messages = (text: string, sheet: Sheet = auto) =>
      checkScripts(edit((s) => setText(s, 'social', 1, text)), sheet)
        .filter((p) => p.variant === 'social' && p.where === 'segments[1].text')
        .map((p) => p.message);
    // 17 (the rims) and 130 (the power) are in the sheet, but "17 130 km" is an invented mileage.
    expect(messages('Elle affiche 17 130 kilomètres.')).toEqual([
      '« 17 130 » se lit comme un seul nombre : sépare les nombres par un mot ou une virgule',
    ]);
    expect(messages('Peugeot 308 130 ch.')).toEqual(['« 308 130 » se lit comme un seul nombre : sépare les nombres par un mot ou une virgule']);
    // A digit glued to letters belongs to a name: "A3 150 ch" is the A3 and 150 ch.
    const a3 = parseSheet({ ...auto, make: 'Audi', model: 'A3', title: 'Audi A3 Sportback', version: undefined, powerHp: 150 });
    expect(messages('Audi A3 150 ch, en essence.', a3)).toEqual([]);
    expect(findNumbers('A3 150 ch').map((n) => n.raw)).toEqual(['3', '150']);
  });

  it('reads decimal surfaces of a property sheet', () => {
    const immo: PropertySheet = {
      vertical: 'immo',
      platform: 'seloger',
      sourceUrl: 'https://www.seloger.com/annonce/achat/x/y/z/26ZCAGW19827',
      transaction: 'vente',
      propertyType: 'Appartement',
      currency: 'EUR',
      price: 263200,
      city: 'Marseille',
      postalCode: '13013',
      surfaceM2: 64.7,
      rooms: 3,
      bedrooms: 2,
      features: ['Balcon', 'Cave'],
      description: 'Appartement lumineux au 2e étage.',
      agencyName: 'Agence du Port',
      photos: [],
    };
    const segments = (extra: VideoScript['segments']): VideoScript['segments'] => [
      { kind: 'hook', text: 'Appartement à Marseille.', facts: ['propertyType', 'city'] },
      { kind: 'point', text: '64,7 m², 3 pièces dont 2 chambres, au 2e étage, lumineux.', facts: ['surfaceM2', 'rooms', 'bedrooms', 'description'] },
      { kind: 'point', text: 'Avec balcon et cave.', facts: ['features[0]', 'features[1]'] },
      ...extra,
    ];
    const scripts: Scripts = {
      social: {
        variant: 'social',
        language: 'fr',
        segments: segments([
          { kind: 'point', text: 'Prix : 263\u202f200 €.', facts: ['price'] },
          { kind: 'cta', text: 'Contactez Agence du Port.', facts: ['agencyName'] },
        ]),
        overlays: { title: 'Appartement à Marseille', subtitle: '64,7 m² · 3 pièces · 2 chambres', price: '263 200 €', contact: 'Agence du Port · 13013 Marseille' },
      },
      listing: {
        variant: 'listing',
        language: 'fr',
        segments: segments([{ kind: 'cta', text: 'Tous les détails sont dans l’annonce.', facts: [] }]),
        overlays: { title: 'Appartement à Marseille', subtitle: '64.7 m² · 3 pièces' },
      },
    };
    expect(checkScripts(scripts, immo)).toEqual([]);

    const invented = structuredClone(scripts);
    setText(invented, 'listing', 1, '65 m², 3 pièces, calme et sans vis-à-vis.');
    expect(checkScripts(invented, immo).map((p) => p.message)).toEqual([
      '« 65 » ne figure pas dans la fiche',
      '« calme » (calme) : la fiche ne le dit pas',
      '« sans vis-à-vis » (sans vis-à-vis) : la fiche ne le dit pas',
    ]);
  });

  it('flags claims the sheet does not support, and accepts those it states', () => {
    const scripts = edit((s) => {
      setText(s, 'social', 0, 'Peugeot 308 en état impeccable, idéale pour la famille.');
      setText(s, 'listing', 3, 'Faible consommation et entretien suivi.');
      setText(s, 'listing', 4, 'Un seul propriétaire, peu de kilomètres, toutes options.');
    });
    expect(checkScripts(scripts, auto)).toEqual([
      { variant: 'social', where: 'segments[0].text', kind: 'claim', message: '« impeccable » (état impeccable) : la fiche ne le dit pas' },
      { variant: 'social', where: 'segments[0].text', kind: 'claim', message: '« idéale » (idéal pour…) : la fiche ne le dit pas' },
      { variant: 'social', where: 'segments[0].text', kind: 'claim', message: '« famille » (usage familial) : la fiche ne le dit pas' },
      // "entretien" and "seul propriétaire" are fine: the description says "Première main, carnet d'entretien à jour".
      { variant: 'listing', where: 'segments[3].text', kind: 'claim', message: '« Faible consommation » (faible consommation) : la fiche ne le dit pas' },
      { variant: 'listing', where: 'segments[4].text', kind: 'claim', message: '« peu de kilomètres » (faible kilométrage) : la fiche ne le dit pas' },
      { variant: 'listing', where: 'segments[4].text', kind: 'claim', message: '« toutes options » (toutes options) : la fiche ne le dit pas' },
    ]);

    // Without description nor warranty, the clean script's claims lose their evidence.
    const bare = parseSheet({ ...auto, description: undefined, warranty: undefined });
    const claims = checkScripts(cleanScripts(), bare).filter((p) => p.kind === 'claim' && p.variant === 'social');
    expect(claims.map((p) => p.message)).toEqual([
      '« Première main » (première main) : la fiche ne le dit pas',
      '« carnet » (entretien) : la fiche ne le dit pas',
      '« non fumeur » (non-fumeur) : la fiche ne le dit pas',
      '« contrôle technique » (contrôle technique) : la fiche ne le dit pas',
      '« garantie » (garantie) : la fiche ne le dit pas',
    ]);

    // "Très bon état" in the listing supports "bon état", not "impeccable"; overlapping matches are reported once.
    const good = parseSheet({ ...auto, description: 'Très bon état général.' });
    const state = (text: string) =>
      checkScripts(edit((s) => setText(s, 'listing', 4, text)), good)
        .filter((p) => p.kind === 'claim' && p.variant === 'listing')
        .map((p) => p.message);
    expect(state('Très bon état général.')).toEqual([]);
    expect(state('En bon état.')).toEqual([]);
    expect(state('En excellent état, comme neuve.')).toEqual([
      '« excellent état » (excellent état) : la fiche ne le dit pas',
      '« comme neuve » (comme neuf) : la fiche ne le dit pas',
    ]);
  });

  it('reads decomposed accents like composed ones', () => {
    const nfd = edit((s) => setText(s, 'listing', 4, 'Très bon état, révisée.'.normalize('NFD')));
    expect(checkScripts(nfd, auto).map((p) => p.message)).toEqual([
      '« Très bon état » (très bon état) : la fiche ne le dit pas',
      '« révisée » (révisé) : la fiche ne le dit pas',
    ]);
    const nfdSheet = parseSheet({ ...auto, description: `${auto.description} Très bon état, révisée.`.normalize('NFD') });
    expect(checkScripts(edit((s) => setText(s, 'listing', 4, 'Très bon état, révisée.')), nfdSheet)).toEqual([]);
  });

  it('lets names be said as they are, and still checks the rest of the sentence', () => {
    const named = parseSheet({ ...auto, sellerName: 'Garage Idéal', city: 'Six-Fours-les-Plages' });
    const social = (text: string) =>
      checkScripts(
        edit((s) => {
          setText(s, 'social', 7, text);
          s.social.overlays.contact = 'Garage Idéal · Six-Fours-les-Plages';
        }),
        named,
      ).map((p) => p.message);
    expect(social('Contactez Garage Idéal, à Six-Fours-les-Plages.')).toEqual([]);
    expect(social('Idéale pour six personnes : contactez Garage Idéal.')).toEqual([
      '« six » : écris les nombres en chiffres pour qu’ils soient vérifiables',
      '« Idéale » (idéal pour…) : la fiche ne le dit pas',
    ]);
  });

  it('only accepts web or e-mail addresses written in the sheet', () => {
    const cta = (text: string, sheet: Sheet = auto) =>
      checkScripts(edit((s) => setText(s, 'social', 7, text)), sheet).map((p) => `${p.kind} ${p.message}`);
    expect(cta('Rendez-vous sur www.garage-des-tests.fr.')).toEqual(['contact adresse « www.garage-des-tests.fr » absente de la fiche']);
    expect(cta('Écrivez à contact@garage.fr ou voyez garage.com')).toEqual([
      'contact adresse « contact@garage.fr » absente de la fiche',
      'contact adresse « garage.com » absente de la fiche',
    ]);
    const withSite = parseSheet({ ...auto, description: `${auto.description} Plus de photos sur www.garage-des-tests.fr.` });
    expect(cta('Rendez-vous sur www.garage-des-tests.fr.', withSite)).toEqual([]);
  });

  it('keeps the price, the currency and any phone out of the listing variant', () => {
    const withPhone = parseSheet({ ...auto, phone: '06 12 34 56 78' });
    const scripts = edit((s) => {
      setText(s, 'listing', 5, 'Son prix : 15 990 euros, garantie 12 mois.');
      s.listing.segments[5]?.facts.push('price');
      setText(s, 'listing', 6, 'Appelez le 06 12 34 56 78 ou le 0798765432.');
      s.listing.overlays.price = '15 990 €';
      s.listing.overlays.contact = 'Garage des Tests · Lyon';
    });
    expect(brief(checkScripts(scripts, withPhone))).toEqual([
      'listing segments[5].facts price',
      'listing segments[5].text price', // 15 990
      'listing segments[5].text price', // "prix"
      'listing segments[6].text phone',
      'listing segments[6].text phone',
      'listing overlays.price price',
      'listing overlays.contact contact',
    ]);
    expect(checkScripts(edit((s) => setText(s, 'listing', 6, 'Plus d’infos : 0612345678.')), withPhone)[0]?.kind).toBe('phone');
    expect(checkScripts(edit((s) => setText(s, 'listing', 6, 'Tarif en €.')), auto).map((p) => p.message)).toEqual([
      '« Tarif » : ni prix ni devise dans la variante annonce',
    ]);
    for (const text of ['Voir nos tarifs.', 'Payable en francs suisses.', 'Moins de 1 euro par jour.']) {
      expect(checkScripts(edit((s) => setText(s, 'listing', 6, text)), auto).map((p) => p.kind), text).toContain('price');
    }
    // The emission standard is not money.
    const euro6 = parseSheet({ ...auto, description: `${auto.description} Norme Euro 6.` });
    expect(checkScripts(edit((s) => setText(s, 'listing', 6, 'Norme Euro 6.')), euro6)).toEqual([]);
  });

  it('only lets the social variant give the sheet’s phone and price', () => {
    const withPhone = parseSheet({ ...auto, phone: '06 12 34 56 78' });
    const call = (text: string, sheet: Sheet = withPhone) => checkScripts(edit((s) => setText(s, 'social', 7, text)), sheet);
    expect(call('Appelez Garage des Tests au 06 12 34 56 78.')).toEqual([]);
    expect(call('Appelez le +33 6 12 34 56 78.')).toEqual([]);
    expect(call('Appelez le 07 98 76 54 32.')).toEqual([
      { variant: 'social', where: 'segments[7].text', kind: 'phone', message: 'numéro « 07 98 76 54 32 » absent de la fiche' },
    ]);
    expect(call('Appelez le 06 12 34 56 78.', auto)[0]?.message).toBe('numéro « 06 12 34 56 78 » absent de la fiche');

    const price = (value: string, sheet: Sheet = auto) =>
      checkScripts(edit((s) => (s.social.overlays.price = value)), sheet).map((p) => `${p.where} ${p.message}`);
    expect(price('14 990 €')).toEqual(['overlays.price « 14 990 € » ne correspond pas au prix de la fiche : 15\u202f990 (EUR)']);
    expect(price('CHF 15 990')).toEqual(['overlays.price devise de « CHF 15 990 » différente de la fiche : 15\u202f990 (EUR)']);
    const noPrice = parseSheet({ ...auto, price: undefined });
    expect(price('15 990 €', noPrice)).toContain('overlays.price la fiche n’indique pas de prix');

    // The price overlay is the amount and the currency: no sales pitch rides along.
    expect(price('Prix : 15 990 €')).toEqual([]);
    expect(price('15 990 € à saisir, négociable')).toEqual([
      'overlays.price « a saisir negociable » : le prix à l’écran ne contient que le montant et la devise (15\u202f990 (EUR))',
    ]);
    expect(price('15 990 € CHF')).toEqual(['overlays.price devise de « 15 990 € CHF » différente de la fiche : 15\u202f990 (EUR)']);

    // A sheet in Swiss francs: the voice-over may not say euros.
    const chf = parseSheet({ ...auto, currency: 'CHF' });
    const chfScripts = edit((s) => (s.social.overlays.price = 'CHF 15 990'));
    expect(checkScripts(chfScripts, chf).map((p) => `${p.where} ${p.message}`)).toEqual([
      'segments[6].text « euros » : la fiche donne le prix en CHF',
    ]);
    setText(chfScripts, 'social', 6, 'Son prix : 15 990 francs.');
    expect(checkScripts(chfScripts, chf)).toEqual([]);
  });

  it('only lets an amount of money be the sheet’s price', () => {
    const amount = (text: string, sheet: Sheet = auto) =>
      checkScripts(edit((s) => setText(s, 'social', 6, text)), sheet)
        .filter((p) => p.where === 'segments[6].text')
        .map((p) => `${p.kind} ${p.message}`);
    // 2019 is in the sheet, but as the year.
    expect(amount('Son prix : 2019 €.')).toEqual(['price montant « 2019 » différent du prix de la fiche']);
    expect(amount('Seulement 130 euros par mois.')).toEqual(['price montant « 130 » différent du prix de la fiche']);
    expect(amount('Son prix : CHF 15 990.', parseSheet({ ...auto, currency: 'CHF' }))).toEqual([]);
    expect(amount('Son prix : 15 990 €, garantie 12 mois.')).toEqual([]);
    expect(amount('Norme Euro 6, 130 ch.')).toEqual([]);
    const noPrice = parseSheet({ ...auto, price: undefined });
    expect(amount('Son prix : 2019 €.', noPrice)).toContain('price montant « 2019 » différent du prix de la fiche, qui n’en indique pas');
  });

  it('checks that the contact overlay is made of the sheet’s name, city and phone', () => {
    const withPhone = parseSheet({ ...auto, phone: '06 12 34 56 78' });
    const contact = (value: string, sheet: Sheet = withPhone) => checkScripts(edit((s) => (s.social.overlays.contact = value)), sheet);
    expect(contact('Garage des Tests · Lyon · 06 12 34 56 78')).toEqual([]);
    // Sheet values are removed as whole words only: a short city does not eat other words.
    const ay = parseSheet({ ...auto, city: 'Ay' });
    expect(contact('Garage des Tests · Ay · Payant', ay).map((p) => p.message)).toEqual([
      '« payant » ne vient pas de la fiche (nom, ville, téléphone)',
    ]);
    expect(contact('Garage des Tests à Lyon (69003) – Tél. 06 12 34 56 78')).toEqual([]);
    expect(contact('Garage des Tests · Villeurbanne · www.garage.fr')).toEqual([
      {
        variant: 'social',
        where: 'overlays.contact',
        kind: 'contact',
        message: '« villeurbanne www.garage.fr » ne vient pas de la fiche (nom, ville, téléphone)',
      },
    ]);
  });

  it('checks that every facts path points to a value of the sheet', () => {
    const bare = parseSheet({ ...auto, warranty: undefined });
    const scripts = edit((s) => {
      s.social.segments[2]?.facts.push('equipment[9]', 'equipment[', 'sourceUrl', 'equipment.length', 'make[0]');
      s.social.segments[3]?.facts.splice(0);
    });
    expect(checkScripts(scripts, bare).filter((p) => p.variant === 'social').map((p) => `${p.where} ${p.message}`)).toEqual([
      'segments[2].facts « equipment[9] » absent de la fiche',
      'segments[2].facts chemin « equipment[ » illisible (attendu : « mileageKm », « equipment[1] »)',
      'segments[2].facts « sourceUrl » n’est pas une information pour la vidéo',
      'segments[2].facts « equipment.length » absent de la fiche',
      'segments[2].facts « make[0] » absent de la fiche',
      'segments[3].facts atout sans champ de la fiche : cite les champs utilisés',
      'segments[5].facts « warranty » absent de la fiche',
      'segments[5].text « 12 » ne figure pas dans la fiche', // it came from the warranty
      'segments[5].text « garantie » (garantie) : la fiche ne le dit pas',
    ]);
  });

  it('asks for numbers in digits, and refuses a language without rules', () => {
    expect(checkScripts(edit((s) => setText(s, 'social', 3, 'Cinq places et soixante-huit mille km.')), auto).map((p) => p.message)).toEqual([
      '« Cinq » : écris les nombres en chiffres pour qu’ils soient vérifiables',
    ]);
    expect(() => checkScripts(toScripts(cleanAnswer(), 'de'), auto)).toThrow(/Vérification des faits indisponible en « de »/);
  });

  it('never gives the model the photos, the source URL or the SIREN', () => {
    const source = factSource(auto);
    for (const key of ['photos', 'sourceUrl', 'platform', 'sellerSiren']) expect(source).not.toHaveProperty(key);
    expect(source).toMatchObject({ mileageKm: 68000, sellerName: 'Garage des Tests', equipment: expect.arrayContaining(['Caméra de recul']) });
  });
});

describe('verifyWithClaude', () => {
  const FINDING = { variant: 'social', text: 'Elle a aussi des jantes alliage 17 pouces', claim: '5 places', reason: 'la fiche ne parle pas du nombre de places' };

  it('asks Haiku, without effort nor thinking, for the claims the sheet does not support', async () => {
    const { client, calls } = fakeClaude({ [HAIKU]: [{ json: { unsupported: [FINDING] } }] });
    const { unsupported, usage } = await verifyWithClaude(cleanScripts(), auto, { client });

    expect(unsupported).toEqual([FINDING]);
    expect(usage).toEqual({ step: 'script', model: HAIKU, inputTokens: 1000, outputTokens: 100, costUsd: 0.0015 });
    expect(calls).toHaveLength(1);
    const params = calls[0] as ParseParams;
    expect(params.model).toBe(HAIKU);
    expect(params.output_config).not.toHaveProperty('effort');
    expect(Object.keys(params.output_config)).toEqual(['format']);
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('temperature');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.system).toContain('n’invente pas de problème');
    const prompt = String(params.messages[0]?.content);
    expect(prompt).toContain('"mileageKm": 68000');
    expect(prompt).toContain('Elle affiche 68 000 kilomètres');
    expect(prompt).toContain('en français');
    expect(prompt).not.toContain('"facts"');
    expect(prompt).not.toContain('sourceUrl');
    expect(prompt).not.toContain('img.leboncoin.fr');
    expect(FACTCHECK_PROMPT_VERSION).toBe('factcheck.v1');
  });

  it('sends no effort field on the wire either (real SDK)', async () => {
    const { fetch, bodies } = recordingFetch([JSON.stringify({ unsupported: [] })]);
    const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch });
    const { unsupported } = await verifyWithClaude(cleanScripts(), auto, { client });
    expect(unsupported).toEqual([]);
    const body = bodies[0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(body.model).toBe(HAIKU);
    expect(Object.keys(body.output_config as object)).toEqual(['format']);
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
  });

  it('retries once on an invalid answer, then throws a French error', async () => {
    const retried = fakeClaude({ [HAIKU]: [{ text: 'pas du JSON' }, { json: { unsupported: [] } }] });
    const ok = await verifyWithClaude(cleanScripts(), auto, { client: retried.client });
    expect(ok.unsupported).toEqual([]);
    expect(ok.usage.inputTokens).toBe(2000);
    expect(retried.calls[1]?.messages).toHaveLength(3);
    expect(retried.calls[1]?.messages[1]).toEqual({ role: 'assistant', content: 'pas du JSON' });
    expect(String(retried.calls[1]?.messages[2]?.content)).toContain('la réponse n’est pas un JSON valide');

    const failing = fakeClaude({ [HAIKU]: [{ json: { unsupported: [{ variant: 'autre' }] } }, { json: {} }] });
    await expect(verifyWithClaude(cleanScripts(), auto, { client: failing.client })).rejects.toThrow(
      /Vérification du script invalide après une relance : unsupported/,
    );

    const refusal = fakeClaude({ [HAIKU]: [{ text: '', stop_reason: 'refusal' }] });
    await expect(verifyWithClaude(cleanScripts(), auto, { client: refusal.client })).rejects.toThrow(/refusé/);
  });

  it('locates a finding in the script to report it', () => {
    const scripts = cleanScripts();
    const problem = unsupportedProblem({ ...FINDING, variant: 'social' }, scripts);
    expect(problem).toEqual({
      variant: 'social',
      where: 'segments[3].text',
      kind: 'unsupported',
      message: '« Elle a aussi des jantes alliage 17 pouces » : 5 places, la fiche ne parle pas du nombre de places',
    });
    expect(describeProblem(problem)).toMatch(/^\[social\] segments\[3\]\.text : « Elle a aussi/);
    expect(unsupportedProblem({ ...FINDING, variant: 'listing', text: 'introuvable' }, scripts).where).toBe('texte');
  });
});
