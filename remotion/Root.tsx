import '@fontsource/inter/400.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import type { Format } from '../lib/pipeline/types';
import { COMPOSITION_ID, DIMENSIONS, FPS, type VideoProps } from '../lib/render/props';
import { ListingVideo } from './ListingVideo';

/** Length and frame rate come from the props: the voice-over sets the video length. */
const calculateMetadata: CalculateMetadataFunction<VideoProps> = ({ props }) => {
  if (!Number.isInteger(props.durationInFrames) || props.durationInFrames <= 0) {
    throw new Error(`durationInFrames invalide : ${props.durationInFrames}`);
  }
  if (!(props.fps > 0)) throw new Error(`fps invalide : ${props.fps}`);
  // Remotion takes 1 as the recorded level and refuses 100 or more.
  if (props.voiceVolume !== undefined && !(props.voiceVolume >= 0 && props.voiceVolume < 100)) {
    throw new Error(`voiceVolume invalide : ${props.voiceVolume}`);
  }
  return { durationInFrames: props.durationInFrames, fps: props.fps };
};

const SAMPLE_SEC = 8;

/** Defaults shown in Remotion Studio: texts only, no media. */
function sampleProps(format: Format): VideoProps {
  const social = format === '9x16';
  return {
    format,
    variant: social ? 'social' : 'listing',
    vertical: 'auto',
    fps: FPS,
    durationInFrames: SAMPLE_SEC * FPS,
    photos: [],
    subtitles: [
      { text: 'Peugeot 308 Allure de 2019', start: 0.2, end: 2.4 },
      { text: '68 000 km, boîte manuelle', start: 2.4, end: 4.6 },
      { text: 'Caméra de recul, CarPlay', start: 4.6, end: 6.6 },
    ],
    overlays: {
      title: 'Peugeot 308 Allure',
      subtitle: '2019 · 68 000 km · Essence',
      ...(social ? { price: '15 990 €', contact: 'Garage des Tests · Lyon' } : {}),
    },
    watermark: true,
  };
}

export function RemotionRoot() {
  return (
    <>
      {(['9x16', '16x9'] as const).map((format) => (
        <Composition
          key={format}
          id={COMPOSITION_ID[format]}
          component={ListingVideo}
          width={DIMENSIONS[format].width}
          height={DIMENSIONS[format].height}
          fps={FPS}
          durationInFrames={SAMPLE_SEC * FPS}
          defaultProps={sampleProps(format)}
          calculateMetadata={calculateMetadata}
        />
      ))}
    </>
  );
}
