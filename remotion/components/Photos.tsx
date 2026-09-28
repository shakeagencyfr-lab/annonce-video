import type { CSSProperties } from 'react';
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoProps } from '../../lib/render/props';
import {
  CROSSFADE_SEC,
  containedBox,
  fadeInOpacity,
  kenBurns,
  kenBurnsScale,
  photoBaseScale,
  photoFit,
  photoTrackSchedule,
  secToFrames,
  zoomPeak,
} from '../../lib/render/timeline';
import { COLORS } from './layout';

type Photo = VideoProps['photos'][number];

/**
 * The photos one after the other, each with a slow zoom, crossfading into the next.
 * All of them are shown before the end card; the last one holds under it.
 */
export function PhotoTrack({ photos }: { photos: Photo[] }) {
  const { durationInFrames, fps } = useVideoConfig();
  const slots = photoTrackSchedule(photos.length, durationInFrames, fps);
  const fade = secToFrames(CROSSFADE_SEC, fps);
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.background }}>
      {slots.map((slot, i) => {
        const photo = photos[i];
        if (!photo) return null;
        return (
          <Sequence
            key={`${i}-${photo.src}`}
            from={slot.from}
            durationInFrames={slot.durationInFrames}
            premountFor={fps}
            name={`Photo ${i + 1} (${photo.role})`}
          >
            <PhotoLayer photo={photo} index={i} slotFrames={slot.durationInFrames} fadeFrames={i === 0 ? 0 : fade} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

const fill: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

function PhotoLayer({
  photo,
  index,
  slotFrames,
  fadeFrames,
}: {
  photo: Photo;
  index: number;
  slotFrames: number;
  fadeFrames: number;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // Less zoom on a small photo, already enlarged a lot to fill the frame.
  const move = kenBurns(index, zoomPeak(photoBaseScale(photo, { width, height })));
  const scale = kenBurnsScale(move, frame / Math.max(1, slotFrames - 1));
  const motion: CSSProperties = {
    transform: `scale(${scale})`,
    transformOrigin: `${move.originX}% ${move.originY}%`,
  };
  const src = staticFile(photo.src);

  if (photoFit(photo, { width, height }) === 'cover') {
    return (
      <AbsoluteFill style={{ opacity: fadeInOpacity(frame, fadeFrames), overflow: 'hidden' }}>
        <Img src={src} style={{ ...fill, objectFit: 'cover', ...motion }} />
      </AbsoluteFill>
    );
  }

  // Whole photo over a blurred, darkened copy of itself that fills the frame. The zoom
  // is clipped to the photo's box, so the box can take the full width of the frame.
  const box = containedBox(photo, { width, height });
  return (
    <AbsoluteFill style={{ opacity: fadeInOpacity(frame, fadeFrames), overflow: 'hidden' }}>
      {/* Own compositing layer: the blur is drawn once, not on every frame. */}
      <AbsoluteFill style={{ willChange: 'transform' }}>
        <Img
          src={src}
          style={{ ...fill, objectFit: 'cover', filter: 'blur(40px) brightness(0.5) saturate(1.2)', transform: 'scale(1.15)' }}
        />
      </AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          ...box,
          overflow: 'hidden',
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)',
        }}
      >
        <Img src={src} style={{ ...fill, objectFit: 'cover', ...motion }} />
      </div>
    </AbsoluteFill>
  );
}
