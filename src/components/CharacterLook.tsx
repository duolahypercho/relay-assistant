import type { CSSProperties } from 'react';
import mascot from '../assets/relay-sprout-anime.png';
import { shapePaths } from '../../shared/appearance.mjs';
import './appearance.css';
export type Appearance =
  | { kind: 'sprout' }
  | { kind: 'shape'; shape: 'pebble' | 'puff' | 'star' }
  | { kind: 'image'; data: string };
export type CharacterPose = 'idle' | 'walk' | 'wave' | 'think';
export function CharacterSprite({
  appearance,
  color = '#e7b281',
  pose = 'idle',
  animated = false,
}: {
  appearance?: Appearance;
  color?: string;
  pose?: CharacterPose;
  animated?: boolean;
}) {
  if (appearance?.kind === 'image')
    return (
      <span
        className={`picture-character ${animated ? 'look-moving' : ''}`}
        data-look="image"
        data-pose={pose}
        aria-hidden="true"
      >
        <img src={appearance.data} alt="" draggable={false} />
      </span>
    );
  if (appearance?.kind === 'shape')
    return (
      <span
        className={`shape-character ${animated ? 'look-moving' : ''}`}
        data-look={appearance.shape}
        data-pose={pose}
        style={{ '--character-color': color } as CSSProperties}
        aria-hidden="true"
      >
        <svg viewBox="0 0 100 100" focusable="false">
          <path className="character-body" d={shapePaths[appearance.shape]} />
          <g className="character-face">
            <ellipse cx="32" cy="59" rx="7" ry="4" fill="#e88986" opacity=".55" />
            <ellipse cx="69" cy="59" rx="7" ry="4" fill="#e88986" opacity=".55" />
            <g className="character-eyes" fill="#28352d">
              <ellipse cx="37" cy="48" rx="4.5" ry="6" />
              <ellipse cx="64" cy="48" rx="4.5" ry="6" />
              <circle cx="38" cy="46" r="1.5" fill="white" />
              <circle cx="65" cy="46" r="1.5" fill="white" />
            </g>
            <path
              d="M44 60Q50 66 57 59"
              fill="none"
              stroke="#28352d"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </g>
        </svg>
      </span>
    );
  return (
    <span
      className={`sprout-character ${animated ? 'has-frames' : ''}`}
      data-look="sprout"
      data-pose={pose}
      style={{ backgroundImage: `url(${mascot})` }}
      aria-hidden="true"
    />
  );
}
