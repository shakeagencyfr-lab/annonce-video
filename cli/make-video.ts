import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatUsd } from '../lib/costs';
import { makeVideo } from '../lib/pipeline/make-video';
import type { Language, Variant } from '../lib/pipeline/types';

const USAGE = `Usage : npm run make-video -- <source> [options]

<source> :
  - le lien d'une annonce AutoScout24.fr (lue par le serveur) ;
  - le fichier .json exporté depuis une annonce Leboncoin avec le favori (npm run bookmarklet) ;
  - une fiche standard au format JSON.

Options :
  --lang fr            langue du script, de la voix et des sous-titres (fr, de, it, nl)
  --out out            dossier de sortie
  --only 9x16|16x9     un seul format
  --offline            sans Claude ni ElevenLabs : script tiré de la fiche, vidéo muette
  --photos <dossier>   photos locales à la place de celles de l'annonce
  --music <fichier>    musique libre de droits avec licence commerciale (règle 6)
  --preview            aperçu filigrané
`;

const LANGUAGES: readonly Language[] = ['fr', 'de', 'it', 'nl'];

async function main() {
  // Keys stay in the environment (rule 8); .env.local is read if present.
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lang: { type: 'string', default: 'fr' },
      out: { type: 'string', default: 'out' },
      only: { type: 'string' },
      offline: { type: 'boolean', default: false },
      photos: { type: 'string' },
      music: { type: 'string' },
      preview: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const source = positionals[0];
  if (values.help || !source) {
    console.log(USAGE);
    process.exit(source ? 0 : 1);
  }
  const language = values.lang as Language;
  if (!LANGUAGES.includes(language)) throw new Error(`Langue inconnue : ${values.lang} (${LANGUAGES.join(', ')})`);
  const variants: Variant[] =
    values.only === '9x16' ? ['social'] : values.only === '16x9' ? ['listing'] : values.only ? [] : ['social', 'listing'];
  if (variants.length === 0) throw new Error(`--only attend 9x16 ou 16x9, reçu ${values.only}`);

  const started = Date.now();
  const result = await makeVideo({
    source,
    language,
    outRoot: values.out ?? 'out',
    offline: values.offline ?? false,
    photosDir: values.photos,
    musicPath: values.music,
    preview: values.preview ?? false,
    variants,
    log: (line) => console.log(line),
  });

  console.log('');
  for (const v of result.videos) console.log(`Vidéo ${v.variant === 'social' ? '9:16' : '16:9'} : ${v.path}`);
  for (const w of result.warnings) console.log(`⚠ ${w}`);
  const c = result.costs;
  console.log('');
  console.log('Coût réel');
  for (const l of c.lines) {
    const detail =
      l.ttsCharacters !== undefined
        ? `${l.ttsCharacters} caractères`
        : l.inputTokens !== undefined
          ? `${l.inputTokens} + ${l.outputTokens ?? 0} jetons`
          : '';
    console.log(`  ${l.step.padEnd(8)} ${(l.model ?? '').padEnd(28)} ${detail.padEnd(22)} ${formatUsd(l.costUsd)}`);
  }
  console.log(`  total${' '.repeat(54)} ${formatUsd(c.totalUsd)}`);
  console.log(`\nTerminé en ${Math.round((Date.now() - started) / 1000)} s. Dossier : ${result.workDir}`);
}

main().catch((err: unknown) => {
  console.error(`\nÉchec : ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
