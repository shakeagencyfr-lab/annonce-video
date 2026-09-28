import type { CSSProperties } from 'react';
import { AbsoluteFill, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoProps } from '../../lib/render/props';
import {
  CROSSFADE_SEC,
  containedBox,
  fadeInOpacity,
  kenBurns,
  kenBurnsScale,
  photoFit,
  photoSchedule,
  pushOffset,
  secToFrames,
  type Box,
} from '../../lib/render/timeline';
import { BACKDROP_SHADE, COLORS, clamp, useLayout } from './layout';

type Photo = VideoProps['photos'][number];

/** Frames of the wipe that opens the photo frame at the start of the video. */
const REVEAL_FRAMES = 14;

/**
 * The photos one after the other in their frame, each with a slow zoom, the next one
 * pushing the current one out to the left. The frame opens with a wipe.
 */
export function PhotoFrame({ photos }: { photos: Photo[] }) {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const layout = useLayout();
  const box = layout.photo;
  const slots = photoSchedule(photos.length, durationInFrames, fps);
  const transition = secToFrames(CROSSFADE_SEC, fps);
  const reveal = interpolate(frame, [0, REVEAL_FRAMES], [0, 100], { ...clamp, easing: Easing.out(Easing.cubic) });
  return (
    <div
      style={{
        position: 'absolute',
        ...box,
        overflow: 'hidden',
        backgroundColor: '#000',
        clipPath: `inset(0 ${100 - reveal}% 0 0)`,
      }}
    >
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
            <PhotoLayer
              photo={photo}
              index={i}
              box={box}
              slotFrames={slot.durationInFrames}
              transition={transition}
              enters={i > 0}
              exits={i < slots.length - 1}
            />
          </Sequence>
        );
      })}
      {/* Shade under the subtitles, which sit on the lower part of the photo. */}
      <AbsoluteFill style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0) 36%)' }} />
    </div>
  );
}

/**
 * 9:16 background around the frame: the photo on screen, blurred and shaded, fading
 * from one photo to the next.
 */
export function Backdrop({ photos }: { photos: Photo[] }) {
  const { durationInFrames, fps } = useVideoConfig();
  const slots = photoSchedule(photos.length, durationInFrames, fps);
  const fade = secToFrames(CROSSFADE_SEC, fps);
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.background }}>
      {slots.map((slot, i) => {
        const photo = photos[i];
        if (!photo) return null;
        return (
          <Sequence key={`${i}-${photo.src}`} from={slot.from} durationInFrames={slot.durationInFrames} premountFor={fps}>
            <FadingBlur src={photo.src} fadeFrames={i === 0 ? 0 : fade} />
          </Sequence>
        );
      })}
      <AbsoluteFill style={{ background: BACKDROP_SHADE }} />
    </AbsoluteFill>
  );
}

function FadingBlur({ src, fadeFrames }: { src: string; fadeFrames: number }) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: fadeInOpacity(frame, fadeFrames) }}>
      <BlurredPhoto src={src} />
    </AbsoluteFill>
  );
}

/** A photo blurred and darkened to fill the frame, as a background. */
export function BlurredPhoto({ src }: { src: string }) {
  return (
    // Own compositing layer: the blur is drawn once, not on every frame.
    <AbsoluteFill style={{ willChange: 'transform', overflow: 'hidden' }}>
      <Img
        src={staticFile(src)}
        style={{ ...fill, objectFit: 'cover', filter: 'blur(48px) brightness(0.55) saturate(1.15)', transform: 'scale(1.2)' }}
      />
    </AbsoluteFill>
  );
}

const fill: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

function PhotoLayer({
  photo,
  index,
  box,
  slotFrames,
  transition,
  enters,
  exits,
}: {
  photo: Photo;
  index: number;
  box: Box;
  slotFrames: number;
  transition: number;
  enters: boolean;
  exits: boolean;
}) {
  const frame = useCurrentFrame();
  const move = kenBurns(index);
  const scale = kenBurnsScale(move, frame / Math.max(1, slotFrames - 1));
  const shift = pushOffset(frame, slotFrames, transition, { enters, exits });
  const motion: CSSProperties = {
    transform: `scale(${scale})`,
    transformOrigin: `${move.originX}% ${move.originY}%`,
  };
  const src = staticFile(photo.src);
  const frameSize = { width: box.width, height: box.height };

  return (
    <AbsoluteFill style={{ overflow: 'hidden', transform: `translateX(${shift * 100}%)` }}>
      {photoFit(photo, frameSize) === 'cover' ? (
        <Img src={src} style={{ ...fill, objectFit: 'cover', ...motion }} />
      ) : (
        // A photo too tall for the frame (portrait) is shown whole over a blurred copy.
        <>
          {/* Own compositing layer: the blur is drawn once, not on every frame. */}
          <AbsoluteFill style={{ willChange: 'transform' }}>
            <Img
              src={src}
              style={{ ...fill, objectFit: 'cover', filter: 'blur(32px) brightness(0.45)', transform: 'scale(1.15)' }}
            />
          </AbsoluteFill>
          <Img
            src={src}
            style={{ position: 'absolute', ...containedBox(photo, frameSize, move), objectFit: 'cover', ...motion }}
          />
        </>
      )}
    </AbsoluteFill>
  );
}
