import { AbsoluteFill, Html5Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import type { VideoProps } from '../lib/render/props';
import { endCardFrom, musicVolume, screenTexts } from '../lib/render/timeline';
import { Captions } from './components/Captions';
import { DpeBadge } from './components/DpeBadge';
import { EndCard } from './components/EndCard';
import { Footer, PRICE_DELAY_FRAMES } from './components/Footer';
import { Header, SidePanel } from './components/Header';
import { COLORS, FONT_FAMILY, useFontsReady, useLayout } from './components/layout';
import { Backdrop, PhotoFrame } from './components/Photos';
import { Watermark } from './components/Watermark';

/**
 * A listing video, 9:16 (social variant) or 16:9 (listing variant): the photos in a
 * frame with the title, key facts and, in the social variant, price and seller around
 * them; subtitles on the voice-over, word by word; a closing card. Texts come from the
 * props only.
 */
export function ListingVideo(props: VideoProps) {
  useFontsReady();
  const { fps, durationInFrames } = useVideoConfig();
  const layout = useLayout();
  const endFrom = endCardFrom(durationInFrames, fps);
  const { title, price, contact, dpe } = screenTexts(props);
  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.background,
        color: COLORS.text,
        fontFamily: FONT_FAMILY,
      }}
    >
      {layout.vertical ? <Backdrop photos={props.photos} /> : null}
      <PhotoFrame photos={props.photos} />
      {layout.vertical ? (
        <Header title={title} specs={props.specs} />
      ) : (
        <SidePanel title={title} contact={contact} price={price} specs={props.specs} />
      )}
      {layout.vertical && (price || contact) && endFrom > PRICE_DELAY_FRAMES ? (
        <Sequence durationInFrames={endFrom} name="Prix et vendeur">
          <Footer price={price} contact={contact} durationInFrames={endFrom} />
        </Sequence>
      ) : null}
      {dpe ? <DpeBadge dpe={dpe} /> : null}
      {endFrom < durationInFrames ? (
        <Sequence from={endFrom} name="Fin">
          <EndCard
            title={title}
            specs={props.specs}
            price={price}
            contact={contact}
            dpe={dpe}
            backdropSrc={props.photos[0]?.src}
          />
        </Sequence>
      ) : null}
      <Captions cues={props.subtitles} endFrom={endFrom} />
      {props.voiceSrc ? <Html5Audio src={staticFile(props.voiceSrc)} /> : null}
      {props.musicSrc ? (
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
