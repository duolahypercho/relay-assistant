import { useEffect, useRef, useState } from 'react';
import { UploadSimple, Sparkle } from '@phosphor-icons/react';
import AvatarGenerator from './AvatarGenerator';
import { CharacterSprite, type Appearance, type CharacterPose } from './CharacterLook';
import { cropAvatarPicture, readAvatarPicture, type PictureSource } from '../avatar-image';
import { Field } from './ui';
const choices: { label: string; look: Appearance }[] = [
  { label: 'Sprout', look: { kind: 'sprout' } },
  { label: 'Pebble', look: { kind: 'shape', shape: 'pebble' } },
  { label: 'Puff', look: { kind: 'shape', shape: 'puff' } },
  { label: 'Star', look: { kind: 'shape', shape: 'star' } },
];
export default function AppearanceEditor({
  value = { kind: 'sprout' },
  color,
  onChange,
  onColor,
  onBusy,
}: {
  value?: Appearance;
  color: string;
  onChange: (value: Appearance) => void;
  onColor: (value: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const source = useRef<PictureSource | null>(null),
    generation = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [crop, setCrop] = useState({ zoom: 1, x: 0.5, y: 0.5 }),
    [hasSource, setHasSource] = useState(false),
    [error, setError] = useState(''),
    [generatorOpen, setGeneratorOpen] = useState(false),
    [pose, setPose] = useState<CharacterPose>('idle');
  useEffect(
    () => () => {
      generation.current++;
      if (source.current) URL.revokeObjectURL(source.current.url);
      clearTimeout(timer.current);
    },
    [],
  );
  function move(next: typeof crop) {
    if (!source.current) return;
    try {
      onChange({
        kind: 'image',
        data: cropAvatarPicture(source.current, next.zoom, next.x, next.y),
      });
      setCrop(next);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function choosePicture(file: File) {
    const request = ++generation.current;
    setGeneratorOpen(false);
    onBusy?.(true);
    setError('');
    let next: PictureSource | null = null;
    try {
      next = await readAvatarPicture(file);
      if (request !== generation.current) {
        URL.revokeObjectURL(next.url);
        return;
      }
      const data = cropAvatarPicture(next, 1, 0.5, 0.5);
      if (source.current) URL.revokeObjectURL(source.current.url);
      source.current = next;
      next = null;
      setHasSource(true);
      setCrop({ zoom: 1, x: 0.5, y: 0.5 });
      onChange({ kind: 'image', data });
    } catch (err) {
      if (next) URL.revokeObjectURL(next.url);
      if (request === generation.current) setError((err as Error).message);
    } finally {
      if (request === generation.current) onBusy?.(false);
    }
  }
  return (
    <section className="appearance-editor" aria-label="Assistant appearance">
      <div className="appearance-preview-row">
        <button
          type="button"
          className="appearance-preview"
          aria-label="Preview character greeting"
          onClick={() => {
            setPose('wave');
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setPose('idle'), 1800);
          }}
        >
          <CharacterSprite appearance={value} color={color} pose={pose} animated />
        </button>
        <div>
          <h3>A face of their own</h3>
          <p>Pick a friend, or give one your own look.</p>
        </div>
      </div>
      <div className="appearance-choices" role="group" aria-label="Character choices">
        {choices.map(({ label, look }) => (
          <button
            type="button"
            key={label}
            aria-label={`${label} character`}
            aria-pressed={JSON.stringify(value) === JSON.stringify(look)}
            onClick={() => {
              onChange(look);
              setGeneratorOpen(false);
              setError('');
            }}
          >
            <span>
              <CharacterSprite appearance={look} color={color} />
            </span>
            {label}
          </button>
        ))}
      </div>
      <div className="appearance-tools">
        <label className="picture-upload">
          <UploadSimple size={18} />
          <span>Choose picture</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Choose assistant picture"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              await choosePicture(file);
            }}
          />
        </label>
        <button
          type="button"
          className="text-button"
          aria-expanded={generatorOpen}
          onClick={() => setGeneratorOpen(!generatorOpen)}
        >
          <Sparkle size={18} />
          Create with AI
        </button>
        <Field label="Assistant color">
          <input type="color" value={color} onChange={(e) => onColor(e.target.value)} />
        </Field>
      </div>
      {generatorOpen && (
        <AvatarGenerator onUse={choosePicture} onClose={() => setGeneratorOpen(false)} />
      )}
      {hasSource && value.kind === 'image' && (
        <details className="picture-crop">
          <summary>Adjust picture</summary>
          <Field label="Picture zoom">
            <input
              type="range"
              min="1"
              max="3"
              step=".05"
              value={crop.zoom}
              onChange={(e) => move({ ...crop, zoom: Number(e.target.value) })}
            />
          </Field>
          <Field label="Picture horizontal position">
            <input
              type="range"
              min="0"
              max="1"
              step=".01"
              value={crop.x}
              onChange={(e) => move({ ...crop, x: Number(e.target.value) })}
            />
          </Field>
          <Field label="Picture vertical position">
            <input
              type="range"
              min="0"
              max="1"
              step=".01"
              value={crop.y}
              onChange={(e) => move({ ...crop, y: Number(e.target.value) })}
            />
          </Field>
        </details>
      )}
      {value.kind === 'image' && (
        <p className="form-note">
          Your cropped picture appears wherever this assistant does. Pictures move with the
          companion; they do not gain facial animation.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
