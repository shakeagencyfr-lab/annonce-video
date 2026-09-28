import type { VideoProps } from '../../lib/render/props';
import { COLORS, useLayout } from './layout';

type DpeClass = NonNullable<VideoProps['dpe']>;

/** Colors of the energy classes on the French DPE label (2021). */
const DPE_SCALE: { letter: DpeClass; background: string; text: string }[] = [
  { letter: 'A', background: '#009C6D', text: '#FFFFFF' },
  { letter: 'B', background: '#52B153', text: '#FFFFFF' },
  { letter: 'C', background: '#78BD76', text: '#FFFFFF' },
  { letter: 'D', background: '#F4E70F', text: '#101114' },
  { letter: 'E', background: '#F0B50F', text: '#101114' },
  { letter: 'F', background: '#EB8235', text: '#FFFFFF' },
  { letter: 'G', background: '#D7221F', text: '#FFFFFF' },
];

/**
 * DPE class read from the listing (CLAUDE.md, rule 5), on every frame: the A to G
 * scale with the class of the property enlarged, in the top-right corner of the photo
 * in 9:16 and at the bottom of the side panel in 16:9, then in the end card (`inline`).
 */
export function DpeBadge({ dpe, inline = false }: { dpe: DpeClass; inline?: boolean }) {
  const layout = useLayout();
  const { cell, ...corner } = layout.dpe;
  const position = inline ? { position: 'relative' as const } : { position: 'absolute' as const, ...corner };
  const active = Math.round(cell * 1.6);
  return (
    <div
      style={{
        ...position,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '10px 14px',
        borderRadius: 18,
        backgroundColor: COLORS.panel,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      }}
    >
      <div style={{ fontSize: Math.round(cell * 0.62), fontWeight: 800, marginRight: 8, letterSpacing: '0.04em' }}>
        DPE
      </div>
      {DPE_SCALE.map(({ letter, background, text }) => {
        const current = letter === dpe;
        const size = current ? active : cell;
        return (
          <div
            key={letter}
            style={{
              width: size,
              height: size,
              borderRadius: current ? 10 : 6,
              backgroundColor: background,
              color: text,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: Math.round(size * 0.6),
              fontWeight: 800,
              opacity: current ? 1 : 0.8,
              border: current ? '3px solid #FFFFFF' : 'none',
              boxSizing: 'border-box',
            }}
          >
            {letter}
          </div>
        );
      })}
    </div>
  );
}
