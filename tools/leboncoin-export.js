/*
 * Leboncoin listing export (bookmarklet source, printed by `npm run bookmarklet`).
 *
 * On the page of one Leboncoin ad already displayed in the seller's browser, it reads
 * the page's own data (script#__NEXT_DATA__, props.pageProps.ad) and downloads it as
 * leboncoin-<list_id>.json, to pass to `npm run make-video`. It reads only this page,
 * on the seller's click, and sends nothing over the network (rule 1).
 *
 * Plain ES5 with explicit semicolons: the bookmarklet is this file on a single line.
 * Only full-line comments, never after code on the same line.
 */
(function () {
  var AD_PATH = /^\/ad\/[a-z_]+\/(\d+)\/?$/;
  var match = AD_PATH.exec(location.pathname);
  if (location.protocol !== 'https:' || !/^(www\.)?leboncoin\.fr$/.test(location.hostname) || !match) {
    alert('Export Leboncoin : ouvrez d’abord la page de votre annonce sur leboncoin.fr (adresse en /ad/…), puis cliquez de nouveau sur ce favori.');
    return;
  }
  var ad = null;
  try {
    var node = document.getElementById('__NEXT_DATA__');
    ad = JSON.parse(node.textContent).props.pageProps.ad;
  } catch (e) {
    ad = null;
  }
  if (!ad || String(ad.list_id) !== match[1]) {
    alert('Export Leboncoin : les données de cette annonce sont introuvables dans la page. Rechargez la page puis réessayez.');
    return;
  }
  var data = {
    source: 'leboncoin',
    version: 1,
    url: location.origin + location.pathname,
    exportedAt: new Date().toISOString(),
    ad: ad
  };
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var href = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = href;
  link.download = 'leboncoin-' + match[1] + '.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function () {
    URL.revokeObjectURL(href);
  }, 1000);
})();
