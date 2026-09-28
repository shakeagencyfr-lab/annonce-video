import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { describeProblem } from '@/lib/pipeline/factcheck';
import { countWords, produceCheckedScripts, ScriptCheckError, ScriptError, writeScripts } from '@/lib/pipeline/script';
import type { PhotoRole, PhotoSelection, SelectedPhoto } from '@/lib/pipeline/types';
import { SCRIPT_PROMPT_VERSION, scriptSystemPrompt, spokenWordTarget } from '@/lib/prompts/script.v2';
import { parseSheet } from '@/lib/sheet';
import { type Answer, auto, cleanAnswer, dealer, dealerAnswer, fakeClaude, type ParseParams, recordingFetch, toScripts } from './script-helpers';

const SONNET = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5-20251001';

const ROLES: PhotoRole[] = ['trois-quarts avant', 'profil', 'arrière', 'intérieur', 'tableau de bord', 'détail', 'détail', 'autre'];
const selection: PhotoSelection = {
  selected: ROLES.map(
    (role, index): SelectedPhoto => ({
      index,
      role,
      sourceUrl: `https://img.leboncoin.fr/api/v1/lbcpb1/images/aa/${index}.jpg?rule=ad-large`,
      path: `/tmp/photo-${index}.jpg`,
      width: 1600,
      height: 1200,
      bytes: 1000,
      format: 'jpeg',
    }),
  ),
  rejected: [],
};

/** The clean answer with one change. */
function answerWith(change: (a: Answer) => void): Answer {
  const answer = cleanAnswer();
  change(answer);
  return answer;
}

const setText = (a: Answer, variant: keyof Answer, index: number, text: string) => {
  const segment = a[variant].segments[index];
  if (!segment) throw new Error(`pas de segment ${index}`);
  segment.text = text;
};

const NO_FINDING = { json: { unsupported: [] } };

describe('writeScripts', () => {
  it('writes both variants in one Sonnet call, from the sheet only', async () => {
    const { client, calls } = fakeClaude({ [SONNET]: [{ json: cleanAnswer() }] });
    const { scripts, usage } = await writeScripts(auto, selection, { client, language: 'fr' });

    expect(scripts).toEqual(toScripts(cleanAnswer()));
    expect(scripts.social).toMatchObject({ variant: 'social', language: 'fr' });
    expect(scripts.listing.overlays).toEqual({ title: 'Peugeot 308', subtitle: '2019 · 68 000 km · Essence' });
    expect(usage).toEqual([{ step: 'script', model: SONNET, inputTokens: 1000, outputTokens: 100, costUsd: 0.003 }]);

    expect(calls).toHaveLength(1);
    const params = calls[0] as ParseParams;
    expect(params.model).toBe(SONNET);
    expect(params.max_tokens).toBe(16000);
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(Object.keys(params.output_config.format.schema.properties as object)).toEqual(['social', 'listing']);
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('thinking');
    expect(JSON.stringify(params)).not.toContain('budget_tokens');

    // Rule 3 is spelled out, with the forbidden inventions.
    expect(params.system).toContain('Règle absolue : aucune invention.');
    for (const invented of ['« état impeccable »', '« entretien suivi »', '« faible consommation »', '« idéal pour la famille »']) {
      expect(params.system).toContain(invented);
    }
    expect(params.system).toContain('en français');
    expect(params.system).toContain('60 à 80 mots (30 à 40 secondes à environ 2 mots par seconde)');
    expect(params.system).toContain('8 mots au plus');
    expect(params.system).toContain('« 68 000 km »');
    expect(params.system).toContain('« 308 de 130 ch », pas « 308 130 ch »');
    expect(params.system).toContain('JAMAIS de prix');
    expect(params.system).toContain('JAMAIS de numéro de téléphone');
    expect(params.system).toContain('sellerName, city, phone');

    // The sheet is the only source, without what is not a fact.
    expect(params.messages).toHaveLength(1);
    const prompt = String(params.messages[0]?.content);
    expect(prompt).toContain('"mileageKm": 68000');
    expect(prompt).toContain('"warranty": "Garantie 12 mois"');
    expect(prompt).not.toContain('sourceUrl');
    expect(prompt).not.toContain('img.leboncoin.fr');
    expect(prompt).not.toContain('123456789');
    expect(prompt).toContain('1. trois-quarts avant ; 2. profil ; 3. arrière ; 4. intérieur');
    expect(SCRIPT_PROMPT_VERSION).toBe('script.v2');
  });

  it('tells Sonnet the seller’s offers are not the car’s, and which equipment makes a strong point', async () => {
    const { client, calls } = fakeClaude({ [SONNET]: [{ json: dealerAnswer() }] });
    const { scripts } = await writeScripts(dealer, selection, { client, language: 'fr' });
    expect(scripts).toEqual(toScripts(dealerAnswer()));

    const system = String(calls[0]?.system);
    expect(system).toContain(
      'Les offres commerciales du vendeur (financement, extension de garantie, vente HT à l’export, livraison, reprise, préparation) ne sont pas des caractéristiques du véhicule : ne les présente jamais comme incluses ou offertes.',
    );
    expect(system).toContain('jamais la durée maximale d’une extension de garantie ni celle d’un financement');
    expect(system).toContain('la garantie incluse si la fiche en indique une');
    expect(system).toContain('pas parmi les équipements de base ou obligatoires (ABS, airbags, appel d’urgence, compte-tours)');
    expect(system).toContain('Un nom d’équipement ne dit rien d’une qualité');
    expect(system).toContain('Si une information ne figure que dans la description, cite « description ».');
    expect(system).toContain('(« equipment[3] ») est celui que le segment énonce, avec au moins un de ses mots.');
    expect(system).toContain('sans « HT » ni « TTC »');
    // The boilerplate reaches Sonnet as it is: the prompt says how to read it.
    expect(String(calls[0]?.messages[0]?.content)).toContain('Extension de garantie de 12 à 60 mois en option');

    // A property has neither the car's offers nor its equipment; another language, no word to share with the sheet.
    const immo = scriptSystemPrompt({ vertical: 'immo', language: 'fr' });
    expect(immo).not.toContain('offres commerciales');
    expect(immo).not.toContain('Un nom d’équipement');
    expect(immo).not.toContain('équipements de base');
    expect(immo).toContain('(« features[3] »)');
    expect(scriptSystemPrompt({ vertical: 'auto', language: 'de' })).toContain('est celui que le segment énonce. Un atout');
  });

  it('takes the language and the vertical as parameters', async () => {
    const { client, calls } = fakeClaude({ [SONNET]: [{ json: cleanAnswer() }] });
    const { scripts } = await writeScripts(auto, selection, { client, language: 'de' });
    expect(scripts.social.language).toBe('de');
    expect(calls[0]?.system).toContain('écris tous les textes (voix off et écran) en allemand');
    expect(String(calls[0]?.messages[0]?.content)).toContain('en allemand.');
    expect(spokenWordTarget('auto', 'fr')).toEqual({ min: 60, max: 80 });
    expect(spokenWordTarget('immo', 'fr')).toEqual({ min: 90, max: 120 });
  });

  it('trims texts and drops blank overlays', async () => {
    const answer = answerWith((a) => {
      a.listing.overlays = { title: ' Peugeot 308 ', subtitle: '  ', price: '' };
      setText(a, 'listing', 0, '  Peugeot 308 Allure de 2019.  ');
    });
    const { client } = fakeClaude({ [SONNET]: [{ json: answer }] });
    const { scripts } = await writeScripts(auto, selection, { client, language: 'fr' });
    expect(scripts.listing.overlays).toEqual({ title: 'Peugeot 308' });
    expect(scripts.listing.segments[0]?.text).toBe('Peugeot 308 Allure de 2019.');
  });

  it('retries once, in the same conversation, when the answer breaks the schema', async () => {
    const partial = { social: cleanAnswer().social };
    const { client, calls } = fakeClaude({ [SONNET]: [{ json: partial }, { json: cleanAnswer() }] });
    const { usage } = await writeScripts(auto, selection, { client, language: 'fr' });

    expect(usage).toHaveLength(2);
    const retry = calls[1]?.messages ?? [];
    expect(retry).toHaveLength(3);
    expect(retry[0]).toBe(calls[0]?.messages[0]);
    expect(retry[1]).toEqual({ role: 'assistant', content: JSON.stringify(partial) });
    expect(retry[2]?.role).toBe('user'); // no prefill: the conversation ends on the user
    expect(retry[2]?.content).toContain('- listing : ');
  });

  it('retries once when the segments are not hook, points, call to action', async () => {
    const noHook = answerWith((a) => {
      const hook = a.social.segments[0];
      if (hook) hook.kind = 'point';
      a.listing.segments = a.listing.segments.filter((s) => s.kind !== 'point');
    });
    const { client, calls } = fakeClaude({ [SONNET]: [{ json: noHook }, { json: cleanAnswer() }] });
    await writeScripts(auto, selection, { client, language: 'fr' });
    const retry = String(calls[1]?.messages[2]?.content);
    expect(retry).toContain('social : une seule accroche (kind "hook"), en premier segment');
    expect(retry).toContain('listing : au moins un atout (kind "point")');

    // Blank texts pass the schema's min(1) but would give a silent segment or no title.
    const blank = answerWith((a) => {
      setText(a, 'social', 2, '   ');
      a.listing.overlays.title = ' ';
    });
    const second = fakeClaude({ [SONNET]: [{ json: blank }, { json: cleanAnswer() }] });
    await writeScripts(auto, selection, { client: second.client, language: 'fr' });
    const blankRetry = String(second.calls[1]?.messages[2]?.content);
    expect(blankRetry).toContain('social : un segment sans texte');
    expect(blankRetry).toContain('listing : overlays.title vide');
  });

  it('asks once more when the voice-over is off length, then accepts it', async () => {
    const short = answerWith((a) => {
      a.listing.segments = [
        { kind: 'hook', facts: ['make', 'model'], text: 'Peugeot 308 de 2019, à découvrir sans attendre aujourd’hui même chez nous.' },
        { kind: 'point', facts: ['mileageKm'], text: '68 000 km.' },
        { kind: 'cta', facts: [], text: 'Tous les détails sont dans l’annonce.' },
      ];
    });
    const { client, calls } = fakeClaude({ [SONNET]: [{ json: short }, { json: short }] });
    const { scripts } = await writeScripts(auto, selection, { client, language: 'fr' });
    expect(scripts.listing.segments).toHaveLength(3);
    const retry = String(calls[1]?.messages[2]?.content);
    expect(retry).toContain('listing : accroche de 12 mots, 8 au plus');
    expect(retry).toMatch(/listing : voix off de \d+ mots, vise 60 à 80 mots/);
    expect(countWords('Elle affiche 68 000 km, 68\u202f000 km.')).toBe(6);
  });

  it('keeps the first answer when the length retry comes back unusable', async () => {
    const short = answerWith((a) => {
      a.listing.segments = [
        { kind: 'hook', facts: ['make', 'model'], text: 'Peugeot 308 de 2019.' },
        { kind: 'point', facts: ['mileageKm'], text: '68 000 km.' },
        { kind: 'cta', facts: [], text: 'Tous les détails sont dans l’annonce.' },
      ];
    });
    for (const retry of [{ text: 'pas du JSON' }, { json: { social: 1 } }, { text: '{"social":', stop_reason: 'max_tokens' as const }]) {
      const { client, calls } = fakeClaude({ [SONNET]: [{ json: short }, retry] });
      const { scripts, usage } = await writeScripts(auto, selection, { client, language: 'fr' });
      expect(calls).toHaveLength(2);
      expect(scripts).toEqual(toScripts(short));
      expect(usage).toHaveLength(2); // both calls are paid for
    }
  });

  it('throws a French error when the retry is invalid too, and stops on a refusal or a truncation', async () => {
    const invalid = fakeClaude({ [SONNET]: [{ text: 'pas du JSON' }, { json: { social: 1 } }] });
    const error = await writeScripts(auto, selection, { client: invalid.client, language: 'fr' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScriptError);
    expect((error as ScriptError).message).toMatch(/Script invalide après une relance : social/);
    expect((error as ScriptError).usage).toHaveLength(2); // both calls are billed
    expect(invalid.calls).toHaveLength(2);

    const refusal = fakeClaude({ [SONNET]: [{ text: '', stop_reason: 'refusal' }] });
    await expect(writeScripts(auto, selection, { client: refusal.client, language: 'fr' })).rejects.toThrow(/refusé/);
    const truncated = fakeClaude({ [SONNET]: [{ text: '{"social":', stop_reason: 'max_tokens' }] });
    await expect(writeScripts(auto, selection, { client: truncated.client, language: 'fr' })).rejects.toThrow(/max_tokens/);
    expect(refusal.calls).toHaveLength(1);
    expect(truncated.calls).toHaveLength(1);
  });

  it('goes through the real SDK: effort and JSON schema, no sampling settings', async () => {
    const { fetch, bodies } = recordingFetch([JSON.stringify(cleanAnswer())]);
    const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch });
    const { scripts } = await writeScripts(auto, selection, { client, language: 'fr' });
    expect(scripts.social.segments).toHaveLength(8);
    const body = bodies[0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(body.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    expect((body.output_config as { format: object }).format).not.toHaveProperty('parse');
  });
});

describe('produceCheckedScripts', () => {
  it('returns the scripts after one draft and one judge call when nothing is invented', async () => {
    const { client, calls } = fakeClaude({ [SONNET]: [{ json: cleanAnswer() }], 'claude-haiku-4-5': [NO_FINDING] });
    const result = await produceCheckedScripts(auto, selection, { client, language: 'fr', judgeModel: 'claude-haiku-4-5' });

    expect(result.scripts).toEqual(toScripts(cleanAnswer()));
    expect(result.problems).toEqual([]);
    expect(calls.map((c) => c.model)).toEqual([SONNET, 'claude-haiku-4-5']);
    expect(result.usage).toEqual([
      { step: 'script', model: SONNET, inputTokens: 1000, outputTokens: 100, costUsd: 0.003 },
      { step: 'script', model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 100, costUsd: 0.0015 },
    ]);
  });

  it('sends the problems back once and keeps the corrected draft', async () => {
    const invented = answerWith((a) => setText(a, 'social', 1, 'Elle affiche 70 000 kilomètres, avec un moteur essence de 130 chevaux.'));
    const { client, calls } = fakeClaude({
      [SONNET]: [{ json: invented }, { json: cleanAnswer() }],
      [HAIKU]: [NO_FINDING, NO_FINDING],
    });
    const result = await produceCheckedScripts(auto, selection, { client, language: 'fr' });

    expect(result.scripts).toEqual(toScripts(cleanAnswer()));
    expect(result.problems).toEqual([
      { variant: 'social', where: 'segments[1].text', kind: 'number', message: '« 70 000 » ne figure pas dans la fiche' },
    ]);
    expect(calls.map((c) => c.model)).toEqual([SONNET, HAIKU, SONNET, HAIKU]);
    expect(result.usage.map((u) => u.model)).toEqual([SONNET, HAIKU, SONNET, HAIKU]);

    const retry = calls[2]?.messages ?? [];
    expect(retry).toHaveLength(3);
    expect(retry[0]).toEqual(calls[0]?.messages[0]);
    expect(retry[1]?.role).toBe('assistant');
    expect(JSON.parse(String(retry[1]?.content))).toEqual(invented);
    expect(retry[2]?.role).toBe('user');
    expect(retry[2]?.content).toContain('- [social] segments[1].text : « 70 000 » ne figure pas dans la fiche');
    expect(retry[2]?.content).toContain('sans rien inventer d’autre');
    // The judge reads the corrected draft.
    expect(String(calls[3]?.messages[0]?.content)).toContain('Elle affiche 68 000 kilomètres');
  });

  it('retries on the judge’s findings too', async () => {
    // The segment still says both items it cites (equipment[3] and [4]): only the judge finds the colour.
    const colour = answerWith((a) => setText(a, 'social', 3, 'Elle est rouge, avec des jantes alliage 17 pouces et la climatisation bizone.'));
    const finding = { variant: 'social', text: 'Elle est rouge', claim: 'couleur rouge', reason: 'la fiche ne donne pas la couleur' };
    const { client, calls } = fakeClaude({
      [SONNET]: [{ json: colour }, { json: cleanAnswer() }],
      [HAIKU]: [{ json: { unsupported: [finding] } }, NO_FINDING],
    });
    const result = await produceCheckedScripts(auto, selection, { client, language: 'fr' });
    expect(result.problems).toEqual([
      {
        variant: 'social',
        where: 'segments[3].text',
        kind: 'unsupported',
        message: '« Elle est rouge » : couleur rouge, la fiche ne donne pas la couleur',
      },
    ]);
    expect(calls[2]?.messages[2]?.content).toContain('[social] segments[3].text : « Elle est rouge » : couleur rouge');
  });

  it('refuses to make a video when the retry still holds unsupported information', async () => {
    const impeccable = answerWith((a) => setText(a, 'listing', 0, 'Peugeot 308 en état impeccable.'));
    const { client, calls } = fakeClaude({
      [SONNET]: [{ json: impeccable }, { json: impeccable }],
      [HAIKU]: [NO_FINDING, NO_FINDING],
    });
    const error = await produceCheckedScripts(auto, selection, { client, language: 'fr' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScriptCheckError);
    const failure = error as ScriptCheckError;
    expect(failure.message).toBe(
      'Script refusé : informations non justifiées par la fiche, même après une relance.\n' +
        '- [listing] segments[0].text : « impeccable » (état impeccable) : la fiche ne le dit pas',
    );
    expect(failure.problems.map((p) => p.kind)).toEqual(['claim']);
    expect(failure.usage).toHaveLength(4);
    expect(calls).toHaveLength(4);
  });

  it('sends back a dealer’s offers said as the car’s, and keeps the corrected draft', async () => {
    const offers = dealerAnswer();
    setText(offers, 'social', 5, 'Garantie jusqu’à 60 mois, extension de garantie offerte.');
    setText(offers, 'listing', 5, 'Garantie 5 ans, livraison partout en France.');
    const { client, calls } = fakeClaude({
      [SONNET]: [{ json: offers }, { json: dealerAnswer() }],
      [HAIKU]: [NO_FINDING, NO_FINDING],
    });
    const result = await produceCheckedScripts(dealer, selection, { client, language: 'fr' });

    expect(result.scripts).toEqual(toScripts(dealerAnswer()));
    expect(result.problems.map(describeProblem)).toEqual([
      '[social] segments[5].text : « offerte » (offert) : la fiche ne le dit pas',
      '[social] segments[5].text : « 60 mois » : la garantie incluse selon la fiche est de 12 mois',
      '[listing] segments[5].text : « livraison partout » (livraison) : la fiche ne le dit pas',
      '[listing] segments[5].text : « 5 ans » : la garantie incluse selon la fiche est de 12 mois',
    ]);
    expect(calls.map((c) => c.model)).toEqual([SONNET, HAIKU, SONNET, HAIKU]);
    expect(calls[2]?.messages[2]?.content).toContain('- [social] segments[5].text : « 60 mois » : la garantie incluse selon la fiche est de 12 mois');
  });

  it('checks the listing variant for prices and phones before accepting', async () => {
    const withPhone = parseSheet({ ...auto, phone: '06 12 34 56 78' });
    const leaky = answerWith((a) => {
      setText(a, 'listing', 6, 'Appelez le 06 12 34 56 78.');
      a.listing.overlays.price = '15 990 €';
    });
    const { client } = fakeClaude({ [SONNET]: [{ json: leaky }, { json: leaky }], [HAIKU]: [NO_FINDING, NO_FINDING] });
    const error = (await produceCheckedScripts(withPhone, selection, { client, language: 'fr' }).catch((e: unknown) => e)) as ScriptCheckError;
    expect(error.problems.map((p) => `${p.variant} ${p.where} ${p.kind}`)).toEqual([
      'listing segments[6].text phone',
      'listing overlays.price price',
    ]);
  });

  it('keeps the cost of the calls already made when a later step fails', async () => {
    const { client } = fakeClaude({
      [SONNET]: [{ json: cleanAnswer() }],
      [HAIKU]: [{ text: 'pas du JSON' }, { text: 'toujours pas' }],
    });
    const error = await produceCheckedScripts(auto, selection, { client, language: 'fr' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScriptError);
    expect(error).not.toBeInstanceOf(ScriptCheckError);
    expect((error as ScriptError).message).toMatch(/^Vérification du script invalide après une relance/);
    expect((error as ScriptError).usage.map((u) => [u.model, u.inputTokens])).toEqual([
      [SONNET, 1000],
      [HAIKU, 2000],
    ]);
  });

  it('does not call Claude for a language the fact check cannot read', async () => {
    const { client, calls } = fakeClaude({});
    await expect(produceCheckedScripts(auto, selection, { client, language: 'nl' })).rejects.toThrow(/indisponible en « nl »/);
    expect(calls).toHaveLength(0);
  });
});
