import type { ProbeResult, Rejected } from './run';

function kb(bytes: number | null): string {
  return bytes === null ? '—' : `${Math.round(bytes / 1024)} Ko`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function toMarkdown(
  results: readonly ProbeResult[],
  meta: { probedAt: string; region: string; rejected: readonly Rejected[] },
): string {
  const lines = [
    `# Test de lecture — ${meta.probedAt} — région ${meta.region}`,
    '',
    '| Plateforme | Vertical | Version | HTTP | Taille | Durée | Prix | Photos | Données | bad_traffic | Verdict | Raisons |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
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
          String(r.photoCount),
          r.embeddedData.join(', ') || '—',
          r.badTraffic ?? '—',
          `**${r.verdict}**`,
          [...r.reasons, ...r.warnings.map((w) => `⚠ ${w}`)].join(' ; ') || '—',
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
