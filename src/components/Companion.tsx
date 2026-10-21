import { tr } from '../i18n';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Heart, Pause, Play } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { assistantForThread } from '../../shared/assistant-scope.mjs';
import { CharacterSprite, useAssistantMotion } from './Assistant';

const size = 44;
const preference = 'relay-companion-quiet';
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));

/** The header character can roam and greet without taking space from the conversation. */
export default function Companion() {
  const { s, threadId } = useWorkspace();
  const state = useAssistantMotion();
  const identity = assistantForThread(s, threadId);
  const name = identity.name;
  const lane = useRef<HTMLDivElement>(null);
  const point = useRef({ x: 38, y: 0 });
  const bounds = useRef({ x: 0, y: 0 });
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const walkingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const greetingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const greeting = useRef(false);
  const [position, setPosition] = useState(point.current);
  const [duration, setDuration] = useState(0);
  const [walking, setWalking] = useState(false);
  const [petting, setPetting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [quiet, setQuiet] = useState(() => localStorage.getItem(preference) === 'true');
  const [reduced, setReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [visible, setVisible] = useState(!document.hidden);
  const automatic = !quiet && !reduced && visible;

  function place(x: number, y: number, seconds = 0) {
    point.current = { x: clamp(x, bounds.current.x), y: clamp(y, bounds.current.y) };
    setDuration(seconds);
    setPosition(point.current);
  }

  function stopWalking() {
    clearTimeout(walkingTimer.current);
    setWalking(false);
    const button = lane.current?.querySelector<HTMLButtonElement>('.companion-character');
    if (button && lane.current) {
      const character = button.getBoundingClientRect();
      const area = lane.current.getBoundingClientRect();
      place(character.x - area.x, character.y - area.y);
    }
  }

  function hello() {
    stopWalking();
    greeting.current = true;
    setPetting(true);
    clearTimeout(greetingTimer.current);
    greetingTimer.current = setTimeout(() => {
      greeting.current = false;
      setPetting(false);
    }, 2200);
  }

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const visibility = () => setVisible(!document.hidden);
    const stored = () => setQuiet(localStorage.getItem(preference) === 'true');
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', stored);
    return () => {
      media.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', stored);
      clearTimeout(walkingTimer.current);
      clearTimeout(greetingTimer.current);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.companionQuiet = String(quiet);
  }, [quiet]);

  useEffect(() => {
    if (!lane.current) return;
    const resize = new ResizeObserver(() => {
      bounds.current = {
        x: Math.max(0, (lane.current?.clientWidth || size) - size),
        y: Math.max(0, (lane.current?.clientHeight || size) - size),
      };
      place(point.current.x, point.current.y);
    });
    resize.observe(lane.current);
    return () => resize.disconnect();
  }, []);

  useEffect(() => {
    stopWalking();
    if (!automatic) {
      return;
    }
    const roam = () => {
      if (drag.current || greeting.current || ['waiting', 'blocked'].includes(state)) return;
      const current = point.current.x;
      const distance = Math.min(bounds.current.x, 28 + Math.random() * 28);
      const direction =
        current < distance
          ? 1
          : current > bounds.current.x - distance
            ? -1
            : Math.random() > 0.5
              ? 1
              : -1;
      const next = clamp(current + distance * direction, bounds.current.x);
      const seconds = Math.max(0.7, Math.abs(next - current) / 55);
      setWalking(true);
      place(next, point.current.y, seconds);
      clearTimeout(walkingTimer.current);
      walkingTimer.current = setTimeout(() => setWalking(false), seconds * 1000);
    };
    const first = setTimeout(roam, 2600);
    const timer = setInterval(roam, 8000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      clearTimeout(walkingTimer.current);
    };
  }, [automatic, state]);

  const start = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    stopWalking();
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: point.current.x,
      originY: point.current.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    if (Math.hypot(dx, dy) > 5) drag.current.moved = true;
    place(drag.current.originX + dx, drag.current.originY + dy);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  // A drag suppresses its synthetic click; keyboard and tap activations greet normally.
  const suppressClick = useRef(false);
  const pose = petting
    ? 'wave'
    : walking || dragging || state === 'working'
      ? 'walk'
      : state === 'thinking' || state === 'blocked'
        ? 'think'
        : state === 'done'
          ? 'wave'
          : 'idle';

  return (
    <div
      className="companion-rail"
      role="group"
      aria-label={tr('Your companion')}
      data-motion={automatic ? 'active' : 'quiet'}
    >
      <p className="sr-only" id="companion-help">
        {tr(
          'Tap to say hello. Drag or use the arrow keys to move your companion. Pause stops automatic movement.',
        )}
      </p>
      <div className="companion-lane" ref={lane}>
        <button
          type="button"
          className={`companion-character ${dragging ? 'is-dragging' : ''}`}
          aria-label={tr('Say hello to {name}', { name })}
          aria-describedby="companion-help"
          title={`Say hello to ${name} · drag to move`}
          data-state={state}
          data-pose={pose}
          style={{
            transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
            transitionDuration: `${duration}s`,
          }}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={(event) => {
            suppressClick.current = !!drag.current?.moved;
            finish(event);
          }}
          onPointerCancel={(event) => {
            suppressClick.current = true;
            finish(event);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onClick={() => {
            if (!suppressClick.current) hello();
            suppressClick.current = false;
          }}
          onKeyDown={(event) => {
            const direction = {
              ArrowLeft: [-20, 0],
              ArrowRight: [20, 0],
              ArrowUp: [0, -5],
              ArrowDown: [0, 5],
            }[event.key];
            if (direction) {
              event.preventDefault();
              stopWalking();
              place(point.current.x + direction[0], point.current.y + direction[1]);
            }
          }}
        >
          <CharacterSprite
            appearance={identity.appearance}
            color={identity.avatarColor}
            pose={pose}
            animated={!reduced && (!quiet || petting)}
          />
          {identity.id !== 'relay' &&
            (!identity.appearance || identity.appearance.kind === 'sprout') && (
              <span
                className="companion-initial"
                style={{
                  backgroundColor: `color-mix(in srgb, ${identity.avatarColor} 25%, white)`,
                }}
              >
                {name.slice(0, 1).toUpperCase()}
              </span>
            )}
          {petting && (
            <span className="companion-heart" aria-hidden="true">
              <Heart size={17} weight="fill" />
            </span>
          )}
        </button>
      </div>
      <button
        className="companion-toggle"
        type="button"
        aria-label={quiet ? 'Wake companion' : tr('Pause companion')}
        title={quiet ? 'Wake companion' : tr('Pause companion')}
        onClick={() => {
          const next = !quiet;
          localStorage.setItem(preference, String(next));
          setQuiet(next);
        }}
      >
        {quiet ? <Play size={15} /> : <Pause size={15} />}
      </button>
    </div>
  );
}
