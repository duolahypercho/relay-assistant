import { tr } from '../i18n';
import { shortcutHelp } from '../../shared/shortcuts.mjs';
import {
  CalendarBlank,
  ClockCounterClockwise,
  BookBookmark,
  Envelope,
  Target,
  ChartDonut,
  Desktop,
  Plug,
  UsersThree,
  GearSix,
  CaretRight,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { useWorkspace } from '../context';
import type { Page } from '../types';
import { pageDestinations, settingsSections, type SettingsSection } from '../navigation';
import './more.css';
const groups = [
  {
    title: 'Everyday',
    items: [
      {
        page: 'calendar',
        name: 'Calendar',
        hint: 'Your plans and upcoming events',
        Icon: CalendarBlank,
      },
      { page: 'inbox', name: 'Mail', hint: 'Read mail and prepare replies', Icon: Envelope },
      {
        page: 'routines',
        name: 'Routines',
        hint: 'Things you want done regularly',
        Icon: ClockCounterClockwise,
      },
      { page: 'goals', name: 'Goals', hint: 'Keep track of what matters', Icon: Target },
      {
        page: 'finance',
        name: 'Spending',
        hint: 'See the transactions you’ve added',
        Icon: ChartDonut,
      },
    ],
  },
  {
    title: 'Make it yours',
    items: [
      {
        page: 'apps',
        name: 'Connect apps',
        hint: 'Give Relay access to the apps you choose',
        Icon: Plug,
      },
      {
        page: 'computer',
        name: 'Computer',
        hint: 'See what your assistant is doing',
        Icon: Desktop,
      },
      {
        page: 'skills',
        name: 'Skills',
        hint: 'Save your favourite ways to do things',
        Icon: BookBookmark,
      },
      {
        page: 'assistants',
        name: 'Assistants',
        hint: 'Create a companion for a specific role',
        Icon: UsersThree,
      },
      {
        page: 'settings',
        name: 'Settings',
        hint: 'Appearance, notifications and connections',
        Icon: GearSix,
      },
    ],
  },
];
export default function More() {
  const { go } = useWorkspace();
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const helpMatch = terms.every((term) => 'keyboard shortcuts hotkeys keys help'.includes(term));
  const destinations: {
    page: Page;
    section?: SettingsSection;
    title: string;
    hint: string;
    keywords: string;
    Icon: typeof CaretRight;
  }[] = [
    ...pageDestinations.map((item) => ({ ...item, hint: 'Open page' })),
    ...settingsSections.map((item) => ({
      ...item,
      page: 'settings' as const,
      section: item.id,
      hint: `${tr('Settings')} · ${tr(item.hint)}`,
      keywords: `${item.keywords} ${item.hint}`,
    })),
  ];
  const matches = destinations.filter((item) =>
    terms.every((term) =>
      `${item.title} ${tr(item.title)} ${item.hint} ${tr(item.hint)} ${item.keywords}`
        .toLowerCase()
        .includes(term),
    ),
  );
  function clearSearch() {
    setQuery('');
    search.current?.focus();
  }
  return (
    <div className="more-page">
      <p className="more-intro">{tr('Everything else, when you need it.')}</p>
      <form
        className="more-search"
        role="search"
        aria-label={tr('Features and settings')}
        onSubmit={(e) => {
          e.preventDefault();
          if (terms.length && matches[0]) go(matches[0].page, matches[0].section);
        }}
      >
        <MagnifyingGlass size={20} aria-hidden="true" />
        <input
          ref={search}
          type="search"
          aria-label={tr('Find a feature or setting')}
          placeholder={tr('Find a feature or setting')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              clearSearch();
            }
          }}
        />
        {query && (
          <button
            className="icon-button"
            type="button"
            aria-label={tr('Clear feature search')}
            onClick={clearSearch}
          >
            <X size={18} />
          </button>
        )}
      </form>
      {helpMatch && (
        <details className="keyboard-help" open={terms.length > 0 ? true : undefined}>
          <summary>{tr('Keyboard shortcuts')}</summary>
          <p>
            Use ⌘ on Mac, Ctrl on Windows or Linux. Some keys are reserved by your browser; the
            desktop app supports the full list.
          </p>
          <dl>
            {shortcutHelp.map(([label, keys]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <kbd>{keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            Alt ↑ / ↓ switches chats when you’re not editing text. Computer input and open dialogs
            keep their own keys. Dictation needs the message field focused.
          </p>
        </details>
      )}
      {terms.length > 0 ? (
        <section aria-label={tr('Matching features and settings')}>
          <p className="more-result-count" role="status">
            {matches.length || helpMatch
              ? tr(matches.length + Number(helpMatch) === 1 ? '{count} match' : '{count} matches', {
                  count: matches.length + Number(helpMatch),
                })
              : tr('Nothing here yet. Try “voice”, “calendar” or “dark mode”.')}
          </p>
          <div className="more-list">
            {matches.map(({ page, section, title, hint, Icon }) => (
              <button
                key={`${page}-${section || ''}`}
                onClick={() => go(page, section)}
                aria-label={tr(title)}
              >
                <Icon size={22} aria-hidden="true" />
                <span>
                  <strong>{tr(title)}</strong>
                  <small>{tr(hint)}</small>
                </span>
                <CaretRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      ) : (
        <div className="more-sections">
          {groups.map((group) => (
            <section key={group.title} aria-label={tr(group.title)}>
              <h2>{tr(group.title)}</h2>
              <div className="more-list">
                {group.items.map(({ page, name, hint, Icon }) => (
                  <button key={page} onClick={() => go(page as Page)} aria-label={tr(name)}>
                    <Icon size={22} aria-hidden="true" />
                    <span>
                      <strong>{tr(name)}</strong>
                      <small>{tr(hint)}</small>
                    </span>
                    <CaretRight size={16} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
