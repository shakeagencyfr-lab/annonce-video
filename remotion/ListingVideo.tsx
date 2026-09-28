import { AbsoluteFill, Html5Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import type { VideoProps } from '../lib/render/props';
import { endCardFrom, musicVolume, screenTexts, secToFrames, TITLE_CARD_SEC } from '../lib/render/timeline';
import { DpeBadge } from './components/DpeBadge';
import { EndCard } from './components/EndCard';
import { COLORS, FONT_FAMILY, useFontsReady } from './components/layout';
import { PhotoTrack } from './components/Photos';
import { PriceBadge } from './components/PriceBadge';
import { Subtitles } from './components/Subtitles';
import { TitleCard } from './components/TitleCard';
import { Watermark } from './components/Watermark';

/**
 * The listing video, in either format (the layout follows the composition size).
 * Layers, bottom to top: photos, title card, price badge (social), end card, DPE
 * (immo), subtitles, watermark (previews).
 */
export function ListingVideo(props: VideoProps) {
  useFontsReady();
  const { fps, durationInFrames } = useVideoConfig();
  const titleFrames = Math.min(secToFrames(TITLE_CARD_SEC, fps), durationInFrames);
  const endFrom = endCardFrom(durationInFrames, fps);
  // The listing variant never shows the price nor the contact, whatever the props hold.
  const { title, subtitle, price, contact, dpe } = screenTexts(props);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.background, color: COLORS.text, fontFamily: FONT_FAMILY }}>
      <PhotoTrack photos={props.photos} />
      {titleFrames > 0 ? (
        <Sequence durationInFrames={titleFrames} name="Titre">
          <TitleCard title={title} subtitle={subtitle} durationInFrames={titleFrames} />
        </Sequence>
      ) : null}
      {price && endFrom > titleFrames ? (
        <Sequence from={titleFrames} durationInFrames={endFrom - titleFrames} name="Prix">
          <PriceBadge price={price} durationInFrames={endFrom - titleFrames} />
        </Sequence>
      ) : null}
      {endFrom < durationInFrames ? (
        <Sequence from={endFrom} name="Fin">
          <EndCard title={title} subtitle={subtitle} price={price} contact={contact} />
        </Sequence>
      ) : null}
      {dpe ? <DpeBadge dpe={dpe} /> : null}
      <Subtitles cues={props.subtitles} />
      {props.voiceSrc ? <Html5Audio src={staticFile(props.voiceSrc)} volume={props.voiceVolume ?? 1} /> : null}
      {props.musicSrc ? (
        // "extend": the volume callback gets the frame of the video, not of the current
        // loop of the music, so the fade-out happens at the end even when the music loops.
        <Html5Audio
          src={staticFile(props.musicSrc)}
          loop
          loopVolumeCurveBehavior="extend"
          volume={(f) => musicVolume(f, durationInFrames, fps)}
        />
      ) : null}
      {props.watermark ? <Watermark /> : null}
    </AbsoluteFill>
  );
}
