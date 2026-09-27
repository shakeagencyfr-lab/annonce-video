import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Prints the Leboncoin export bookmarklet (tools/leboncoin-export.js) as a
 * `javascript:` URL, with how to install and use it. Usage: npm run bookmarklet
 */

/**
 * Comments dropped, lines trimmed and joined with a space. Enough for this source,
 * written with explicit semicolons and full-line comments only.
 */
function toBookmarklet(source: string): string {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
    .join(' ');
  return `javascript:${encodeURIComponent(code)}`;
}

const source = readFileSync(join(__dirname, '..', 'tools', 'leboncoin-export.js'), 'utf8');

console.log(`Favori d’export Leboncoin

1. Affichez la barre des favoris (Ctrl+Maj+B, ou Cmd+Maj+B sur Mac).
2. Clic droit sur la barre > « Ajouter une page » (Chrome) ou « Ajouter un marque-page » (Firefox).
3. Nom : Export Leboncoin. Adresse (URL) : collez toute la ligne qui commence par javascript: ci-dessous.
4. Ouvrez la page de votre annonce sur leboncoin.fr et cliquez sur le favori :
   le fichier leboncoin-<numéro>.json se télécharge.
5. Lancez : npm run make-video -- <chemin du fichier téléchargé>

Le favori lit seulement la page affichée, sur votre clic, et n’envoie rien sur le réseau.

${toBookmarklet(source)}`);
