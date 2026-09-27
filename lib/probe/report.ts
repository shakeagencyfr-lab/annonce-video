import type { ProbeResult, Rejected } from './run';

export type ReportMeta = {
  probedAt: string;
  region: string;
  node: string;
  warnings: readonly string[];
  requestHeaders: Record<string, string>;
  addedByNode: readonly string[];
  rejected: readonly Rejected[];
};

function kb(bytes: number | null): string {
  return bytes === null ? '—' : `${Math.round(bytes / 1024)} Ko`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function toMarkdown(results: readonly ProbeResult[], meta: ReportMeta): string {
  const lines = [
    `# Test de lecture — ${meta.probedAt} — région ${meta.region} — Node ${meta.node}`,
    '',
    ...meta.warnings.map((w) => `> ⚠ ${w}`),
    ...(meta.warnings.length ? [''] : []),
    `En-têtes envoyés : ${Object.entries(meta.requestHeaders)
      .map(([k, v]) => `\`${k}: ${v}\``)
      .join(', ')} ; ajoutés par Node : ${meta.addedByNode.map((h) => `\`${h}\``).join(', ')}.`,
    '',
    '| Plateforme | Vertical | Version | HTTP | Taille | Durée | Prix | Photos | Données | DPE | bad_traffic | Verdict | Raisons |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(
      '| ' +
        [
          r.label,
          r.vertical,
          r.release,
          r.status === null ? '—' : String(r.status),
          kb(r.bytes),
          r.durationMs === null ? '—' : `${r.durationMs} ms`,
          r.price.found ? `oui (${r.price.source})` : 'non',
          r.declaredPhotoCount === null ? String(r.photoCount) : `${r.photoCount} / ${r.declaredPhotoCount}`,
          r.embeddedData.join(', ') || '—',
          r.vertical === 'immo' ? (r.dpe ?? 'absent') : '—',
          r.badTraffic ?? '—',
          `**${r.verdict}**`,
          [
            ...r.reasons,
            ...r.warnings.map((w) => `⚠ ${w}`),
            ...(r.attempts.length > 1
              ? [`essais : ${r.attempts.map((a) => `${a.status ?? '—'} ${a.verdict}`).join(', ')}`]
              : []),
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
