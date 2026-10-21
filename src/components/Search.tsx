import { tr } from '../i18n';
import { assistantForThread } from '../../shared/assistant-scope.mjs';
import { useEffect, useRef, useState } from 'react';
import { pageDestinations, settingsSections } from '../navigation';
import './search.css';
import {
  ChatCircle,
  FileText,
  Target,
  Stack,
  MagnifyingGlass,
  ArrowRight,
  UsersThree,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { Modal } from './ui';

type SearchScope = 'workspace' | 'chat' | 'chats';
export default function Search({
  onClose,
  scope = 'workspace',
  onScope,
}: {
  onClose: (restoreFocus?: boolean) => void;
  scope?: SearchScope;
  onScope?: (scope: SearchScope) => void;
}) {
  const { s, threadId, selectThread, go, openFile, openTask } = useWorkspace();
  const title =
    scope === 'chat'
      ? 'Find in this chat'
      : scope === 'chats'
        ? 'Find a chat'
        : 'Find in your space';
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, [scope]);
  const q = query.trim().toLowerCase();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const matches = (text: string) => text.toLowerCase().includes(q);
  const threadMap = new Map(s.threads.map((t) => [t.id, t]));
  const threadTitle = (id: string) =>
    id === 'main' ? 'Main chat' : threadMap.get(id)?.title || 'Chat';
  const cardText = (card: any) => {
    if (card.kind === 'voice') return card.transcript || '';
    if (card.kind === 'question') {
      const question = s.questions?.find((q) => q.id === card.id);
      return question
        ? [
            question.prompt,
            ...question.options.map((o: any) => o.label),
            question.answer || '',
          ].join(' ')
        : '';
    }
    return '';
  };
  const destinations = [
    {
      key: 'keyboard-help',
      title: tr('Keyboard shortcuts'),
      keywords: 'hotkeys keys help navigation',
      detail: 'More',
      Icon: ChatCircle,
      open: () => go('more'),
    },
    ...pageDestinations.map(({ page, title, keywords, Icon }) => ({
      key: `page:${page}`,
      title: tr(title),
      keywords: `${title} ${keywords}`,
      detail: tr('Open page'),
      Icon,
      open: () => go(page),
    })),
    ...settingsSections.map(({ id, title, hint, keywords, Icon }) => ({
      key: `settings:${id}`,
      title: tr(title),
      keywords: `${title} ${hint} ${tr(hint)} ${keywords}`,
      detail: tr('Settings'),
      Icon,
      open: () => go('settings', id),
    })),
  ];
  const navigation =
    scope !== 'workspace'
      ? []
      : q
        ? destinations
            .filter((item) =>
              q
                .split(/\s+/)
                .every((word) => `${item.title} ${item.keywords}`.toLowerCase().includes(word)),
            )
            .slice(0, 8)
        : destinations.filter((item) =>
            ['page:files', 'page:activity', 'page:calendar', 'page:apps', 'page:settings'].includes(
              item.key,
            ),
          );
  const results =
    q || scope === 'chats'
      ? [
          ...(s.assistants || [])
            .filter(
              (a) =>
                scope !== 'chat' &&
                !a.hidden &&
                a.id !== 'relay' &&
                matches(`${a.name} ${a.description || ''}`),
            )
            .map((a) => ({
              key: `assistant:${a.id}`,
              title: a.name,
              detail: 'Assistant',
              Icon: UsersThree,
              open: () => selectThread(a.threadId),
            })),
          ...s.threads
            .filter(
              (t) =>
                scope !== 'chat' &&
                !t.archived &&
                !t.replyTo &&
                !t.assistantHome &&
                matches(`${threadTitle(t.id)} ${t.title}`),
            )
            .map((t) => ({
              key: t.id,
              title: t.title,
              detail: t.participantIds ? 'Group chat' : 'Conversation',
              Icon: ChatCircle,
              open: () => selectThread(t.id),
            })),
          ...s.messages
            .filter(
              (m) =>
                scope !== 'chats' &&
                (scope !== 'chat' || m.threadId === threadId) &&
                m.id !== 'welcome' &&
                !threadMap.get(m.threadId)?.archived &&
                (matches(m.text) ||
                  m.sharedTexts?.some((text: string) => matches(text)) ||
                  m.cards?.some((c: any) => matches(cardText(c)))),
            )
            .map((m) => ({
              key: m.id,
              title: (matches(m.text)
                ? m.text
                : m.sharedTexts?.find((text: string) => matches(text)) ||
                  cardText(m.cards?.find((c: any) => matches(cardText(c))) || {}) ||
                  m.text
              ).slice(0, 180),
              detail: `${threadMap.get(m.threadId)?.replyTo ? 'Thread · ' : ''}${threadTitle(m.threadId)} · ${m.role === 'user' ? 'You' : m.assistantName || assistantForThread(s, m.threadId).name}`,
              Icon: ChatCircle,
              open: () => selectThread(m.threadId, m.id),
            })),
          ...s.files
            .filter((f) => scope === 'workspace' && matches(f.name + ' ' + (f.text || '')))
            .map((f) => ({
              key: f.id,
              title: f.name,
              detail: 'File',
              Icon: FileText,
              open: () => openFile(f.id),
            })),
          ...s.tasks
            .filter((t) => scope === 'workspace' && matches(t.title + ' ' + t.description))
            .map((t) => ({
              key: t.id,
              title: t.title,
              detail: `Task · ${t.status.replaceAll('_', ' ')}`,
              Icon: Stack,
              open: () => openTask(t.id),
            })),
          ...(s.routines || [])
            .filter(
              (r) =>
                scope === 'workspace' && !r.archived && matches(r.title + ' ' + r.instructions),
            )
            .map((r) => ({
              key: r.id,
              title: r.title,
              detail: 'Routine',
              Icon: Stack,
              open: () => go('routines'),
            })),
          ...(s.skills || [])
            .filter(
              (skill) =>
                scope === 'workspace' &&
                !skill.archived &&
                matches(`${skill.title} ${skill.slug} ${skill.description} ${skill.instructions}`),
            )
            .map((skill) => ({
              key: skill.id,
              title: skill.title,
              detail: `Skill · /${skill.slug}`,
              Icon: Stack,
              open: () => go('skills'),
            })),
          ...s.goals
            .filter(
              (g) => scope === 'workspace' && !g.archived && matches(g.title + ' ' + g.description),
            )
            .map((g) => ({
              key: g.id,
              title: g.title,
              detail: 'Goal',
              Icon: Target,
              open: () => go('goals'),
            })),
        ].slice(0, 30)
      : [];
  const allResults = [...navigation, ...results];
  function open(result: (typeof allResults)[number]) {
    onClose(false);
    result.open();
  }
  function resultRow(r: (typeof allResults)[number], index: number) {
    return (
      <button
        key={r.key}
        ref={(node) => {
          buttons.current[index] = node;
        }}
        className="search-result"
        onClick={() => open(r)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            buttons.current[
              (index + (e.key === 'ArrowDown' ? 1 : -1) + allResults.length) % allResults.length
            ]?.focus();
          }
        }}
      >
        <r.Icon size={21} aria-hidden="true" />
        <span>
          <strong>{r.title}</strong>
          <small>{r.detail}</small>
        </span>
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    );
  }
  return (
    <Modal title={tr(title)} onClose={onClose}>
      {onScope && (
        <div className="search-scopes" role="group" aria-label={tr('Search scope')}>
          {(
            [
              ['workspace', tr('Everything')],
              ['chat', tr('This chat')],
              ['chats', tr('Chats')],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className="text-button"
              aria-pressed={scope === value}
              onClick={() => onScope(value)}
            >
              {tr(label)}
            </button>
          ))}
        </div>
      )}
      <label className="search-input workspace-search">
        <MagnifyingGlass size={20} />
        <input
          ref={input}
          aria-label={
            scope === 'chat'
              ? tr('Search this chat')
              : scope === 'chats'
                ? tr('Search chats')
                : tr('Search your workspace')
          }
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            scope === 'chat'
              ? tr('Find a message…')
              : scope === 'chats'
                ? tr('Chat or assistant name…')
                : tr('Find anything, or a setting…')
          }
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && allResults.length) {
              e.preventDefault();
              buttons.current[0]?.focus();
            }
            if (e.key === 'Enter' && allResults.length) {
              e.preventDefault();
              open(allResults[0]);
            }
          }}
        />
      </label>
      <div className="search-results">
        {navigation.length > 0 && (
          <section aria-label={q ? tr('Pages and settings') : tr('Quick links')}>
            <h3 className="search-group-title">{q ? tr('Pages & settings') : tr('Jump to')}</h3>
            {navigation.map((result, index) => resultRow(result, index))}
          </section>
        )}
        {results.length > 0 && (
          <section aria-label={tr('Your workspace results')}>
            <h3 className="search-group-title">
              {scope === 'chat'
                ? tr('Messages in this chat')
                : scope === 'chats'
                  ? tr('Chats & assistants')
                  : tr('Your workspace')}
            </h3>
            {results.map((result, index) => resultRow(result, index + navigation.length))}
          </section>
        )}
        {q && !allResults.length && (
          <p role="status">
            No matches for “{query}”{scope === 'chat' ? ' in this chat.' : '.'}
          </p>
        )}
      </div>
      <p className="form-note">
        {scope === 'chat'
          ? `Searching ${threadTitle(threadId)}.`
          : tr('Search stays inside your workspace.')}
      </p>
    </Modal>
  );
}
