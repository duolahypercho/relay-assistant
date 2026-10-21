import ComputerPause, { type ComputerPauseControl } from '../components/ComputerPause';
import RetryReply from '../components/RetryReply';
import '../components/chat-setup.css';
import ConversationActions from '../components/ConversationActions';
import ComposerActions from '../components/ComposerActions';
import { tr, uiLocale } from '../i18n';
import { availableChatApps, mentionAtCursor } from '../../shared/app-mentions.mjs';
import { chatNavigation } from '../../shared/chat-navigation.mjs';
import { pageDestinations, settingsSections, type SettingsSection } from '../navigation';
import { useChatApps, type AppReference } from '../useChatApps';
import '../components/app-mentions.css';
import { sharedDrafts } from '../../shared/incoming-shares.mjs';
import GroupEditor from '../components/GroupEditor';
import { useGroupRecipients } from '../useGroupRecipients';
import { defaultReplyRecipient } from '../../shared/reply-threads.mjs';
import { ThreadOriginal, ThreadReplies } from '../components/ReplyThread';
import { copyText } from '../copy-text';
import {
  assistantForThread,
  assistantSkills,
  assistantProfile,
} from '../../shared/assistant-scope.mjs';
import { Fragment, useState, useEffect, useLayoutEffect, useRef } from 'react';
import {
  capturePosition,
  readPosition,
  restorePosition,
  savePosition,
} from '../chat-reading-position';
import {
  Paperclip,
  Folder,
  Stack,
  ArrowUp,
  ArrowRight,
  ArrowLeft,
  Square,
  ChartDonut,
  Envelope,
  CalendarBlank,
  ClockCounterClockwise,
  Lightning,
  X,
  Plus,
  DotsThree,
  ArrowDown,
  Copy,
  ArrowBendUpLeft,
  Target,
  Globe,
  Lightbulb,
  BookBookmark,
  Microphone,
  Waveform,
  At,
  ChatCircle,
  Plug,
} from '@phosphor-icons/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkspace } from '../context';
import { api } from '../api';
import { useChatDraft } from '../useChatDraft';
import { useChatAttachments } from '../useChatAttachments';
import { fileDraftEvent, type FileDraftRequest } from '../chat-file-draft';
import { Field, Modal } from '../components/ui';
import { MessageCards } from '../components/RichCard';
import WorkspaceDock from '../components/WorkspaceDock';
import { fileToPayload } from './Files';
import { AssistantAvatar } from '../components/Assistant';
import SkillEditor from '../components/SkillEditor';
import VoiceInput from '../components/VoiceInput';
import VoiceCall from '../components/VoiceCall';
import { VoiceMemoAction } from '../components/VoiceMemo';
import type { Entity, Page } from '../types';
import AttachmentList from '../components/AttachmentList';
import MessageBubble from '../components/MessageBubble';
import FileDrop, { useFileDrop, validateFileBatch } from '../components/FileDrop';

// Stable component identities preserve code scroll positions during workspace refreshes.
const messageMarkdown: Components = {
  img: ({ alt }) => <span>Image: {alt}</span>,
  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: ({ children }) => (
    <pre tabIndex={0} role="region" aria-label="Code block">
      {children}
    </pre>
  ),
};

export default function Chat() {
  const {
    s,
    page,
    threadId,
    focusMessageId,
    focusSerial,
    clearFocus,
    go,
    act,
    run,
    toast,
    openFile,
    selectThread,
    openConnections,
    connectAI,
  } = useWorkspace();
  const thread = s.threads.find((t) => t.id === threadId) || s.threads[0];
  const original = thread.replyTo;
  const shared = sharedDrafts(s, thread);
  const originalThread = original && s.threads.find((t) => t.id === original.threadId);
  const identity = assistantForThread(s, thread.id);
  const group = !!thread.participantIds;
  const participants: Entity[] = (thread.participantIds || []).map((id: string) =>
    assistantProfile(s, id),
  );
  const [recipients, setRecipients] = useGroupRecipients(thread);
  const [editGroup, setEditGroup] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const speaker = (m: Entity) =>
    m.assistantName || participants.find((a) => a.id === m.assistantId)?.name || identity.name;
  const [draft, setDraft] = useChatDraft(thread);
  const [attachments, setAttachments] = useChatAttachments(thread);
  const [selectedApps, setSelectedApps] = useChatApps(thread);
  const [cursor, setCursor] = useState(draft.length);
  const [editTitle, setEditTitle] = useState(false);
  const originalMessages = useRef(new Set(s.messages.map((m) => m.id)));
  const [replyingTo, setReplyingTo] = useState<Entity | null>(null);
  const [messageMenu, setMessageMenu] = useState('');
  const [title, setTitle] = useState('');
  const [inputBusy, setInputBusy] = useState(false);
  const computerPause = useRef<ComputerPauseControl>(null);
  const [canContinueWithSend, setCanContinueWithSend] = useState(false);
  const sendingAndContinuing = useRef(false);
  const uploadChain = useRef<Promise<void>>(Promise.resolve());
  const pendingUploads = useRef(0);
  const attachmentIds = useRef(attachments);
  attachmentIds.current = attachments;
  const attachSaved = useRef<(request: FileDraftRequest) => void>(() => {});
  attachSaved.current = (request) => {
    if (request.threadId !== thread.id) return;
    if (thread.archived) {
      request.error = 'Restore this chat before adding a file.';
      return;
    }
    if (pendingUploads.current) {
      request.error = 'Your files are still uploading. Try again in a moment.';
      return;
    }
    if (!s.files.some((file) => file.id === request.fileId)) {
      request.error = 'This file is no longer in your workspace.';
      return;
    }
    const sharedIds = shared.flatMap((item: Entity) => item.fileIds || []);
    const existing = new Set([...attachmentIds.current, ...sharedIds]);
    if (!existing.has(request.fileId)) {
      if (existing.size >= 8) {
        request.error = 'Your draft already has 8 files. Remove an attachment and try again.';
        return;
      }
      const next = [...attachmentIds.current, request.fileId];
      attachmentIds.current = next;
      setAttachments(next);
    }
    request.accepted = true;
  };
  useEffect(() => {
    const attach = (event: Event) =>
      attachSaved.current((event as CustomEvent<FileDraftRequest>).detail);
    window.addEventListener(fileDraftEvent, attach);
    return () => window.removeEventListener(fileDraftEvent, attach);
  }, []);
  const [saveSkill, setSaveSkill] = useState<Entity | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [voiceThread, setVoiceThread] = useState<string | null>(null);
  const [callThread, setCallThread] = useState<string | null>(null);
  const callAudio = useRef<AudioContext | null>(null);
  function startDictation(toggle = true) {
    if (inputBusy || callThread) return;
    if (toggle && voiceThread === thread.id) {
      setVoiceThread(null);
      return;
    }
    if (api.mode() !== 'server' || !s.connections.runtime?.transcription?.configured) {
      go('settings', 'voice');
      return;
    }
    setVoiceThread(thread.id);
  }
  function startVoiceChat() {
    if (inputBusy || voiceThread || computerPaused) return;
    const runtime = s.connections.runtime;
    if (
      api.mode() !== 'server' ||
      !runtime?.transcription?.configured ||
      !runtime?.speech?.configured
    ) {
      go('settings', 'voice');
      return;
    }
    if (!s.connections.model?.configured) {
      connectAI();
      return;
    }
    // Audio begins only from a fresh chat gesture after all setup is complete.
    if (typeof AudioContext !== 'undefined') {
      callAudio.current = new AudioContext();
      void callAudio.current.resume().catch(() => {});
    }
    setCallThread(thread.id);
  }
  const [dismissedSkillQuery, setDismissedSkillQuery] = useState<string | null>(null);
  const [skillIndex, setSkillIndex] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const readingKey = `${api.mode()}:${thread.id}:${thread.createdAt}`;
  const [initialReading] = useState(() => readPosition(readingKey));
  const reading = useRef(initialReading);
  const restoringReading = useRef(false);
  const readingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const followsLatest = useRef(focusMessageId ? false : (initialReading?.follow ?? true));
  const updateScrollPosition = (updateFollow = true) => {
    if (page !== 'chat' || restoringReading.current) return;
    const el = transcript.current;
    if (!el || !el.clientHeight) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 100;
    if (updateFollow) followsLatest.current = !away;
    setAwayFromLatest(away);
    // A late resize during navigation must not replace the reader's chosen
    // message with a different one at the same numeric scroll offset.
    if (!updateFollow && !followsLatest.current && reading.current) return;
    reading.current = capturePosition(el, followsLatest.current);
    clearTimeout(readingTimer.current);
    readingTimer.current = setTimeout(() => {
      if (reading.current) savePosition(readingKey, reading.current);
    }, 150);
  };
  useEffect(() => {
    const flush = () => {
      clearTimeout(readingTimer.current);
      if (reading.current) savePosition(readingKey, reading.current);
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, [readingKey]);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const replyTo = (message: Entity) => {
    if (thread.archived || page !== 'chat' || callThread || voiceThread) return;
    setReplyingTo(message);
    if (group)
      setRecipients(
        message.role === 'assistant' && thread.participantIds.includes(message.assistantId)
          ? [message.assistantId]
          : [],
      );
    setMessageMenu('');
    prompt.current?.focus();
  };
  const skillPicker = useRef<HTMLDivElement>(null);
  const mentionPicker = useRef<HTMLDivElement>(null);
  const mention =
    mentionAtCursor(draft, Math.min(cursor, draft.length)) ||
    (mentionOpen ? { query: '', start: cursor, end: cursor } : null);
  const replyRecipient =
    replyingTo?.role === 'assistant' ? replyingTo : defaultReplyRecipient(thread);
  const eligibleIds = group
    ? recipients.length
      ? recipients
      : replyRecipient?.assistantId
        ? [replyRecipient.assistantId]
        : thread.participantIds
    : [identity.id];
  const availableApps: Entity[] = availableChatApps(s.connections.apps || [], eligibleIds);
  type MentionChoice = {
    id: string;
    key: string;
    name: string;
    kind: 'app' | 'assistant';
    app?: AppReference;
  };
  const mentionChoices: MentionChoice[] = [
    ...(group
      ? [{ id: 'everyone', name: 'Everyone' }, ...participants].map((a) => ({
          id: a.id,
          key: `assistant-${a.id}`,
          name: a.name,
          kind: 'assistant' as const,
        }))
      : []),
    ...availableApps
      .filter(
        (a) =>
          !selectedApps.some(
            (selected) => selected.id === a.id && selected.revision === a.revision,
          ),
      )
      .map((a) => ({
        id: a.id,
        key: `app-${a.id}`,
        name: a.name,
        kind: 'app' as const,
        app: { id: a.id, revision: a.revision, name: a.name },
      })),
  ].filter((a) => a.name.toLowerCase().includes((mention?.query || '').toLowerCase()));
  const showMentions = !!mention && mentionDismissed !== `${draft}:${cursor}`;
  const mentionChoice = Math.min(mentionIndex, Math.max(0, mentionChoices.length - 1));
  useEffect(() => {
    if (showMentions)
      document
        .getElementById(`mention-${mentionChoices[mentionChoice]?.key}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [showMentions, mentionChoice, mention?.query]);
  const chooseMention = (choice: MentionChoice) => {
    if (!mention) return;
    if (choice.kind === 'app' && choice.app) {
      if (selectedApps.length >= 8 && !selectedApps.some((a) => a.id === choice.id)) {
        toast('Choose up to eight apps for one message.');
        return;
      }
      setSelectedApps((current) => [...current.filter((a) => a.id !== choice.id), choice.app!]);
    } else {
      const next =
        choice.id === 'everyone'
          ? participants.map((a) => a.id)
          : [...new Set([...recipients, choice.id])];
      setRecipients(next);
    }
    const next = draft.slice(0, mention.start) + draft.slice(mention.end);
    setDraft(next);
    setCursor(mention.start);
    setMentionOpen(false);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      prompt.current?.focus();
      prompt.current?.setSelectionRange(mention.start, mention.start);
    });
  };
  const openMentions = () => {
    const position = prompt.current?.selectionStart ?? draft.length;
    setCursor(position);
    setMentionOpen(true);
    setMentionDismissed('');
    prompt.current?.focus();
  };
  const slash = draft.match(/^\/([a-z0-9-]*)$/i);
  const enabledSkills = ((s.skills || []) as Entity[]).filter((skill) =>
    eligibleIds.every((id: string) =>
      assistantSkills(s, id).some((x: Entity) => x.id === skill.id),
    ),
  );
  const skillChoices = enabledSkills
    .filter(
      (skill) =>
        !skill.archived &&
        (!slash?.[1] ||
          `${skill.slug} ${skill.title}`.toLowerCase().includes(slash[1].toLowerCase())),
    )
    .slice(0, 8);
  const showSkillPicker = !!slash && dismissedSkillQuery !== draft;
  const choiceIndex = Math.min(skillIndex, Math.max(0, skillChoices.length - 1));
  const chooseSkill = (skill: Entity) => {
    setDraft(`/${skill.slug} `);
    setDismissedSkillQuery(prompt.current?.value || draft);
    prompt.current?.focus();
  };
  useEffect(() => {
    setSkillIndex(0);
    setDismissedSkillQuery(null);
  }, [thread.id]);
  const active = s.runs.find((r) => r.threadId === thread.id && r.status === 'running');
  const navigation = chatNavigation(draft, {
    hasContext: !!(
      attachments.length ||
      selectedApps.length ||
      shared.length ||
      replyingTo ||
      original ||
      group
    ),
    busy: !!(active || inputBusy || callThread || voiceThread),
  });
  const navigationDestination = navigation?.section
    ? settingsSections.find((item) => item.id === navigation.section)
    : pageDestinations.find((item) => item.page === navigation?.page);
  const navigationLabel = navigationDestination
    ? tr('Open {page}', { page: tr(navigationDestination.title) })
    : '';
  const needsModel = api.mode() === 'server' && !s.connections.model.configured;
  const startingPoints = (
    <div className="starting-points">
      {[
        {
          text: 'Review my spending and help me save',
          title: tr('Look at my spending'),
          Icon: ChartDonut,
        },
        {
          text: 'Complete the Field Lab permission form',
          title: tr('Take care of a form'),
          Icon: Envelope,
        },
        {
          text: 'Plan a design review this week',
          title: tr('Find time this week'),
          Icon: CalendarBlank,
        },
      ].map(({ text, title, Icon }) => (
        <button key={title} className="prompt-chip" onClick={() => void send(text)}>
          <Icon size={18} />
          {tr(title)}
        </button>
      ))}
    </div>
  );
  const computerPaused = !!s.connections.runtime?.assistantPaused;
  const queued = s.runs.filter((r) => r.threadId === thread.id && r.status === 'queued');
  const messages = s.messages.filter((m) => m.threadId === thread.id && m.id !== 'welcome');
  // Depend on meaningful message changes, not refreshed copies of workspace arrays.
  const latest = messages.at(-1);
  const needsAttention = latest?.cards?.some(
    (card: any) =>
      card.kind === 'workspace' ||
      (card.kind === 'review' &&
        s.approvals.some((a) => a.id === card.id && a.status === 'pending')) ||
      (['task', 'task-detail'].includes(card.kind) &&
        s.tasks.some(
          (t) => t.id === card.id && ['needs_input', 'needs_approval'].includes(t.status),
        )),
  );
  useLayoutEffect(() => {
    if (
      page === 'chat' &&
      !focusMessageId &&
      !followsLatest.current &&
      reading.current &&
      !reading.current.follow &&
      transcript.current
    ) {
      const element = transcript.current;
      const saved = reading.current;
      let active = true;
      restoringReading.current = true;
      restorePosition(element, saved);
      const finish = () => {
        if (!active) return;
        restorePosition(element, saved);
        restoringReading.current = false;
        updateScrollPosition(false);
        active = false;
      };
      // On a cold reload, font metrics can change after the first layout.
      // Hold the message anchor through that layout, unless the reader moves first.
      const frame = requestAnimationFrame(() => void document.fonts.ready.then(finish));
      const interrupt = () => {
        if (!active) return;
        active = false;
        restoringReading.current = false;
        updateScrollPosition();
      };
      element.addEventListener('wheel', interrupt, { passive: true });
      element.addEventListener('touchstart', interrupt, { passive: true });
      element.addEventListener('pointerdown', interrupt, { passive: true });
      window.addEventListener('keydown', interrupt);
      return () => {
        active = false;
        restoringReading.current = false;
        cancelAnimationFrame(frame);
        element.removeEventListener('wheel', interrupt);
        element.removeEventListener('touchstart', interrupt);
        element.removeEventListener('pointerdown', interrupt);
        window.removeEventListener('keydown', interrupt);
      };
    }
  }, [page, focusMessageId]);
  useLayoutEffect(() => {
    if (page === 'chat' && focusMessageId) {
      followsLatest.current = false;
      document.getElementById(`message-${focusMessageId}`)?.scrollIntoView({ block: 'start' });
    }
  }, [focusMessageId, focusSerial, thread.id, page]);
  useLayoutEffect(() => {
    if (page !== 'chat' || !followsLatest.current || !transcript.current) return;
    if (needsAttention && latest)
      document.getElementById(`message-${latest.id}`)?.scrollIntoView({ block: 'start' });
    else transcript.current.scrollTop = transcript.current.scrollHeight;
    updateScrollPosition();
  }, [messages.length, active?.partial, needsAttention, page]);
  useEffect(() => {
    if (!transcript.current || !bottom.current) return;
    const observer = new ResizeObserver(() => {
      if (page === 'chat' && followsLatest.current && !needsAttention && transcript.current)
        transcript.current.scrollTop = transcript.current.scrollHeight;
      updateScrollPosition(false);
    });
    observer.observe(transcript.current);
    for (const child of transcript.current.children) observer.observe(child);
    return () => observer.disconnect();
  }, [thread.id, messages.length, page, needsAttention]);
  useEffect(() => {
    setVoiceThread(null);
    setCallThread(null);
    setReplyingTo(null);
    setMessageMenu('');
  }, [thread.id]);
  useEffect(() => {
    const closeMessageActions = (event: MouseEvent) => {
      // Let the tapped control finish before collapsing a row and moving the transcript.
      // A voice action can replace its button during the click; retain the original path.
      if (
        !event
          .composedPath()
          .some(
            (node) =>
              node instanceof Element && node.matches('.message.actions-open, .message-more'),
          )
      )
        setMessageMenu('');
    };
    const close = (event: PointerEvent) => {
      if (event.target !== prompt.current && !skillPicker.current?.contains(event.target as Node))
        setDismissedSkillQuery(prompt.current?.value || draft);
      if (
        event.target !== prompt.current &&
        !mentionPicker.current?.contains(event.target as Node)
      ) {
        setMentionOpen(false);
        setMentionDismissed(
          `${prompt.current?.value || ''}:${prompt.current?.selectionStart || 0}`,
        );
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMessageMenu('');
      }
    };
    document.addEventListener('click', closeMessageActions);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('click', closeMessageActions);
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, []);
  useEffect(() => {
    if (prompt.current) {
      prompt.current.style.height = 'auto';
      prompt.current.style.height = `${Math.min(prompt.current.scrollHeight, 160)}px`;
    }
  }, [draft]);
  useEffect(() => {
    if (page !== 'chat') {
      setVoiceThread(null);
      setCallThread(null);

      setEditTitle(false);
      setSaveSkill(null);
      setMessageMenu('');
    }
  }, [page]);
  const send = async (text = draft, asMessage = false, delivery = 'now') => {
    if (callThread || inputBusy || sendingAndContinuing.current) return;
    if (!text.trim() && !shared.length && !attachments.length) return;
    if (!asMessage && text === draft && navigation && navigationDestination) {
      setDraft('');
      setCursor(0);
      clearFocus();
      go(navigation.page as Page, navigation.section as SettingsSection | undefined);
      return;
    }
    // The visible send action explicitly includes continuation only after the
    // engine reports a confirmed sleeping local VM. The server rechecks it.
    const continueChat =
      computerPaused && canContinueWithSend && delivery === 'now'
        ? computerPause.current?.continueChat
        : undefined;
    sendingAndContinuing.current = !!continueChat;
    clearFocus();
    followsLatest.current = true;
    const submittedFiles = attachments;
    const submittedApps = selectedApps;
    if (text === draft) {
      setDraft('');
      setAttachments([]);
      setSelectedApps([]);
    }
    try {
      const result = await act('chat.send', {
        delivery: group ? 'queue' : delivery,
        threadId: thread.id,
        text: text.trim() || (submittedFiles.length ? 'Shared with you.' : text),
        fileIds: submittedFiles,
        apps: submittedApps,
        shareIds: shared.map((x: Entity) => x.id),
        replyToMessageId: replyingTo?.id,
        ...(group ? { recipientIds: recipients } : {}),
      });
      if (result) {
        setReplyingTo(null);
        setRecipients([]);
        await continueChat?.();
      }
      if (!result) {
        setDraft((old) => old || text);
        setAttachments((old) => (old.length ? old : submittedFiles));
        setSelectedApps((old) => (old.length ? old : submittedApps));
      }
    } finally {
      sendingAndContinuing.current = false;
    }
  };
  const sendDraft = useRef(send);
  sendDraft.current = send;
  useEffect(() => {
    const submit = () => {
      if (page === 'chat') void sendDraft.current();
    };
    window.addEventListener('relay:send-draft', submit);
    return () => window.removeEventListener('relay:send-draft', submit);
  }, [page]);
  async function upload(list: FileList | File[] | null) {
    const files = Array.from(list || []);
    if (!files?.length) return;
    pendingUploads.current++;
    setInputBusy(true);
    const uploading = uploadChain.current
      .catch(() => {})
      .then(async () => {
        try {
          await run(async () => {
            validateFileBatch(files, 8 - attachmentIds.current.length);
            for (const file of files) {
              const result = await api.act('file.add', await fileToPayload(file));
              setAttachments((old) => {
                const next = [...old, result.id];
                attachmentIds.current = next;
                return next;
              });
            }
          });
        } finally {
          pendingUploads.current--;
          if (!pendingUploads.current) setInputBusy(false);
          if (fileInput.current) fileInput.current.value = '';
        }
      });
    uploadChain.current = uploading;
    await uploading;
  }
  const drop = useFileDrop(
    upload,
    (message) =>
      void run(async () => {
        throw Error(message);
      }),
    !inputBusy,
  );
  return (
    <>
      <section
        className={`chat-workspace file-drop-target ${group ? 'group-conversation' : ''} ${original ? 'reply-conversation' : ''} ${messages.length || original ? 'has-conversation' : 'fresh-conversation'}`}
        {...drop.dropProps}
      >
        {drop.dragging && (
          <FileDrop
            title={inputBusy ? 'Adding your files…' : 'Drop files to attach'}
            hint="They stay in your draft until you press Send."
          />
        )}
        {
          <div className="conversation-heading">
            <div className="chat-title">
              {thread.id !== 'main' && !thread.assistantHome && (
                <button
                  className="icon-button"
                  aria-label={original ? tr('Back to conversation') : tr('Back to main chat')}
                  title={original ? tr('Back to conversation') : tr('Back to main chat')}
                  onClick={() =>
                    original
                      ? selectThread(original.threadId, original.message.id)
                      : selectThread('main')
                  }
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <h1>
                {original ? tr('Thread') : thread.id === 'main' ? tr('Main chat') : thread.title}
              </h1>
              {thread.id !== 'main' && (
                <span className="side-chat-label">
                  {original
                    ? originalThread?.title || 'Conversation'
                    : group
                      ? tr('Group chat')
                      : thread.assistantHome
                        ? tr('Your assistant')
                        : tr('Side chat')}
                </span>
              )}
            </div>
            {group && (
              <button
                className="group-members"
                aria-label="Group participants"
                onClick={() => setEditGroup(true)}
              >
                {participants.slice(0, 3).map((a) => (
                  <AssistantAvatar key={a.id} assistantId={a.id} animated={false} />
                ))}
                <span>{participants.length} assistants</span>
              </button>
            )}
            {!original && (
              <ConversationActions
                thread={thread}
                onRename={
                  thread.id !== 'main' && !thread.assistantHome
                    ? () => {
                        setTitle(thread.title);
                        setEditTitle(true);
                      }
                    : undefined
                }
              />
            )}
          </div>
        }
        {callThread === thread.id && page === 'chat' && (
          <VoiceCall
            key={thread.id}
            threadId={thread.id}
            fileIds={attachments}
            apps={selectedApps}
            initialAudio={callAudio.current}
            onClose={() => {
              callAudio.current = null;
              setCallThread(null);
            }}
          />
        )}
        <div
          className="messages"
          ref={transcript}
          onScroll={() => updateScrollPosition()}
          aria-live="polite"
          aria-relevant="additions text"
        >
          {original && <ThreadOriginal thread={thread} />}
          {original && !messages.length && (
            <p className="thread-empty">{tr('A little room to follow up on this message.')}</p>
          )}
          {!messages.length && !original && (
            <div className="chat-intro">
              {group ? (
                <div className="group-intro-avatars">
                  {participants.map((a) => (
                    <AssistantAvatar key={a.id} assistantId={a.id} />
                  ))}
                </div>
              ) : needsModel ? null : (
                <AssistantAvatar />
              )}
              {!needsModel && (
                <p className="hello-line">
                  {group
                    ? participants.map((a) => a.name).join(' · ')
                    : s.profile.name
                      ? tr('Hi, {name}.', { name: s.profile.name })
                      : tr('Hi, I’m {name}.', { name: identity.name })}
                </p>
              )}
              <h2>
                {needsModel && !group
                  ? tr('Let’s get you connected.')
                  : group
                    ? tr('A little team, on your side.')
                    : thread.id === 'main'
                      ? tr('What’s on your mind?')
                      : thread.assistantHome
                        ? tr('What shall we work on?')
                        : tr('A little space for another thought.')}
              </h2>
              <p>
                {needsModel && !group
                  ? tr('Choose an AI provider or a model on your computer to start.')
                  : group
                    ? tr('Ask everyone together, or type @ to choose who answers.')
                    : thread.id === 'main'
                      ? tr('Big plans, little things, or just a thought. I’m here.')
                      : thread.assistantHome
                        ? tr('Our conversation, with a little room to think.')
                        : tr('We can explore this topic here. Your main chat is just a tap away.')}
              </p>
              {needsModel && (
                <button className="primary-button chat-connect-ai" onClick={connectAI}>
                  {tr('Connect AI')} <ArrowRight size={18} aria-hidden="true" />
                </button>
              )}
              {thread.id === 'main' &&
                (needsModel ? (
                  <details className="chat-sample-examples">
                    <summary>{tr('Try a sample first')}</summary>
                    <p>{tr('These examples use fictional data and sample responses.')}</p>
                    {startingPoints}
                  </details>
                ) : (
                  startingPoints
                ))}
              {!s.profile.name && !needsModel && (
                <button className="text-button" onClick={() => go('settings', 'personal')}>
                  {tr('Make this assistant yours')} <ArrowRight size={15} />
                </button>
              )}
            </div>
          )}
          {messages.map((m, index) => {
            const waitingRun = computerPaused ? queued.find((r) => r.messageId === m.id) : null;
            const hasMessageActions = !m.cards?.some(
              (c: any) => c.kind === 'voice-call' || (c.kind === 'handoff' && !m.text),
            );
            const previous = messages[index - 1];
            const next = messages[index + 1];
            const gap =
              !previous || Date.parse(m.createdAt) - Date.parse(previous.createdAt) > 300000;
            const groupEnd =
              !next ||
              next.role !== m.role ||
              next.assistantId !== m.assistantId ||
              Date.parse(next.createdAt) - Date.parse(m.createdAt) > 120000;
            return (
              <Fragment key={m.id}>
                {gap && (
                  <div className="message-time-divider">
                    <time dateTime={m.createdAt}>
                      {new Date(m.createdAt).toLocaleDateString(uiLocale(), {
                        month: 'short',
                        day: 'numeric',
                      })}{' '}
                      ·{' '}
                      {new Date(m.createdAt).toLocaleTimeString(uiLocale(), {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                )}
                <div
                  data-group-end={groupEnd}
                  data-has-reaction={!!m.reaction}
                  onContextMenu={(e) => {
                    if (
                      m.text &&
                      !(e.target as HTMLElement).closest('a, input, textarea, button')
                    ) {
                      e.preventDefault();
                      setMessageMenu(m.id);
                    }
                  }}
                  id={`message-${m.id}`}
                  className={`message ${m.role} ${originalMessages.current.has(m.id) ? '' : 'is-new'} ${m.cards?.length ? 'has-cards' : ''} ${messageMenu === m.id ? 'actions-open' : ''} ${m.cards?.some((c: any) => ['workspace', 'task-detail'].includes(c.kind)) ? 'has-workspace-card' : ''} ${m.error ? 'message-error' : ''} ${focusMessageId === m.id ? 'search-match' : ''}`}
                >
                  <div className="message-content">
                    {m.routineId && (
                      <button className="routine-message-label" onClick={() => go('routines')}>
                        <ClockCounterClockwise size={14} /> {m.routineTitle}
                      </button>
                    )}
                    <span className="message-name">
                      {m.delegation
                        ? m.delegation.fromName
                        : m.role === 'user'
                          ? 'You'
                          : speaker(m)}
                    </span>
                    {m.delegation && (
                      <span className="delegation-label">
                        {m.role === 'assistant'
                          ? `${m.delegation.fromName} → ${m.delegation.targetName}`
                          : `Request from ${m.delegation.fromName}`}
                      </span>
                    )}
                    <div className="message-bubble-row">
                      <MessageBubble
                        canReply={
                          !!m.text &&
                          !thread.archived &&
                          page === 'chat' &&
                          !callThread &&
                          !voiceThread
                        }
                        onReply={() => replyTo(m)}
                        onDoubleClick={() => setMessageMenu(m.id)}
                      >
                        {m.quoted && (
                          <button
                            className="quoted-message"
                            onClick={() => selectThread(thread.id, m.quoted.id)}
                          >
                            <strong>{m.quoted.role === 'user' ? 'You' : speaker(m.quoted)}</strong>
                            <span>{m.quoted.text}</span>
                          </button>
                        )}
                        {group && m.recipientIds?.length > 0 && (
                          <span className="group-addressed">
                            To{' '}
                            {m.recipientIds
                              .map(
                                (id: string) =>
                                  participants.find((a) => a.id === id)?.name ||
                                  'Former participant',
                              )
                              .join(', ')}
                          </span>
                        )}
                        <div className="markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={messageMarkdown}>
                            {m.text}
                          </ReactMarkdown>
                        </div>
                        {m.reaction && (
                          <button
                            className="message-reaction"
                            aria-label={`Remove ${m.reaction} reaction`}
                            onClick={() => void act('message.react', { id: m.id, reaction: '' })}
                          >
                            {m.reaction}
                          </button>
                        )}
                      </MessageBubble>
                      {hasMessageActions && (
                        <button
                          className="icon-button message-more"
                          aria-label={tr('Message actions')}
                          aria-expanded={messageMenu === m.id}
                          onClick={() => setMessageMenu(messageMenu === m.id ? '' : m.id)}
                        >
                          <DotsThree size={19} />
                        </button>
                      )}
                    </div>
                    {m.interrupted && <span className="message-meta">{tr('Reply stopped')}</span>}
                    {m.error && <RetryReply message={m} />}
                    {waitingRun && (
                      <div className="message-meta message-waiting">
                        <span>{tr('Waiting for handback')}</span>
                        <button
                          className="text-button"
                          aria-label="Cancel waiting message"
                          onClick={() => void act('chat.stop', { id: waitingRun.id })}
                        >
                          {tr('Cancel')}
                        </button>
                      </div>
                    )}
                    {m.appContext?.length > 0 && (
                      <div className="message-apps" aria-label="Apps selected for this message">
                        {m.appContext.map((app: AppReference) => (
                          <span key={app.id}>
                            <Plug size={13} />
                            {app.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {m.skill && (
                      <details className="skill-method message-skill">
                        <summary>
                          {m.skill.title} · version {m.skill.version}
                        </summary>
                        <p>{m.skill.instructions}</p>
                      </details>
                    )}
                    {m.fileIds?.length > 0 && <AttachmentList ids={m.fileIds} />}
                    {m.cards?.length > 0 && <MessageCards cards={m.cards} messageId={m.id} />}
                    {m.sharedTexts?.map((text: string, i: number) => (
                      <blockquote className="shared-message-source" key={i}>
                        {text}
                      </blockquote>
                    ))}
                    {m.modelBackup && (
                      <small className="message-model-backup">
                        Answered with {m.modelBackup.name} · backup model
                      </small>
                    )}
                    {!original && <ThreadReplies messageId={m.id} />}
                    {messageMenu === m.id && (
                      <div className="message-reactions" role="group" aria-label="React to message">
                        {['❤️', '👍', '😂', '‼️', '❓'].map((reaction) => (
                          <button
                            key={reaction}
                            aria-label={`React ${reaction}`}
                            aria-pressed={m.reaction === reaction}
                            onClick={async () => {
                              if (
                                await act('message.react', {
                                  id: m.id,
                                  reaction: m.reaction === reaction ? '' : reaction,
                                })
                              )
                                setMessageMenu('');
                            }}
                          >
                            {reaction}
                          </button>
                        ))}
                      </div>
                    )}
                    {hasMessageActions && (
                      <div className="message-actions">
                        <time dateTime={m.createdAt}>
                          {new Date(m.createdAt).toLocaleTimeString(uiLocale(), {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </time>
                        <button
                          className="icon-button"
                          aria-label={tr('Copy message')}
                          onClick={() =>
                            void run(async () => {
                              await copyText(m.text);
                              toast('Message copied.');
                            })
                          }
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Reply to message"
                          disabled={!!thread.archived || !!callThread || !!voiceThread}
                          onClick={() => replyTo(m)}
                        >
                          <ArrowBendUpLeft size={15} />
                        </button>
                        {!original && (
                          <button
                            className="icon-button"
                            aria-label={tr('Reply in thread')}
                            title={tr('Reply in thread')}
                            onClick={async () => {
                              const reply = await act('reply.open', { messageId: m.id });
                              if (reply) {
                                setMessageMenu('');
                                selectThread(reply.id);
                              }
                            }}
                          >
                            <ChatCircle size={15} />
                          </button>
                        )}
                        {m.role === 'assistant' && !m.error && (
                          <button
                            className="icon-button"
                            aria-label={tr('Save as skill')}
                            title={tr('Save as skill')}
                            onClick={() => setSaveSkill(m)}
                          >
                            <BookBookmark size={15} />
                          </button>
                        )}
                        {m.role === 'assistant' &&
                          !m.interrupted &&
                          !m.error &&
                          !m.cards?.some((c: any) => c.kind === 'voice') && (
                            <VoiceMemoAction messageId={m.id} />
                          )}
                      </div>
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })}
          {active && !computerPaused && (
            <div className="message assistant">
              <div className="message-content">
                {group && (
                  <span className="message-name">
                    {active.groupRouting
                      ? 'Choosing who can help'
                      : active.assistant?.name || identity.name}
                  </span>
                )}
                {active.privateBrowserAction && (
                  <button className="secondary-button" onClick={() => go('computer')}>
                    Open browser · review & follow along
                  </button>
                )}
                {active.waitingForReply ? (
                  <span role="status">
                    {s.voiceCalls?.some((c) => c.id === active.voiceCallId && c.listening)
                      ? 'Listening before continuing'
                      : 'Waiting while I answer your message'}
                  </span>
                ) : active.partial ? (
                  <div className="markdown">
                    <ReactMarkdown components={{ img: ({ alt }) => <span>Image: {alt}</span> }}>
                      {active.partial}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <span className="thinking">
                    <span />
                    <span />
                    <span />
                    {active.modelConnection?.display
                      ? `Continuing with ${active.modelConnection.display.name}`
                      : (active.steeringMessageIds?.length || 0) > (active.steeringApplied || 0)
                        ? 'Updating your request'
                        : 'Working through it'}
                  </span>
                )}
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>
        {awayFromLatest && (
          <button
            className="latest-button"
            onClick={() => {
              clearFocus();
              followsLatest.current = true;
              transcript.current?.scrollTo({
                top: transcript.current.scrollHeight,
                behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
                  ? 'instant'
                  : 'smooth',
              });
            }}
          >
            <ArrowDown size={15} />
            {tr('Latest messages')}
          </button>
        )}
        {queued.length > 0 && !computerPaused && (
          <div className="followup-queue">
            <div>
              <strong>
                {queued.length} follow-up{queued.length === 1 ? '' : 's'}{' '}
                {thread.queuePaused ? 'paused' : 'queued'}
              </strong>
              {thread.queuePaused && (
                <button
                  className="text-button"
                  onClick={() => void act('thread.update', { id: thread.id, queuePaused: false })}
                >
                  {tr('Send queued messages')}
                </button>
              )}
            </div>
            {queued.map((q) => (
              <div key={q.id}>
                <span>
                  {group && q.assistant?.name ? `${q.assistant.name}: ` : ''}
                  {q.routineTitle || s.messages.find((m) => m.id === q.messageId)?.text}
                </span>
                <button
                  className="icon-button"
                  aria-label={tr('Remove queued message')}
                  onClick={() => void act('chat.stop', { id: q.id })}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-wrap">
          {computerPaused && (
            <ComputerPause
              ref={computerPause}
              name={identity.name}
              hasMessage={
                !!(draft.trim() || shared.length || attachments.length) && !navigationDestination
              }
              hasWaitingWork={
                s.runs.some((r) => ['queued', 'running'].includes(r.status)) ||
                s.tasks.some((t) => t.status === 'running')
              }
              onSendReady={setCanContinueWithSend}
              onOpen={() => go('computer')}
              onResumed={() => prompt.current?.focus()}
            />
          )}
          {voiceThread === thread.id && !callThread && (
            <VoiceInput
              key={thread.id}
              configured={
                api.mode() === 'server' && !!s.connections.runtime?.transcription?.configured
              }
              destination={s.connections.runtime?.transcription?.destination || ''}
              inputFormat={s.connections.runtime?.transcription?.inputFormat || ''}
              onClose={() => {
                setVoiceThread(null);
                requestAnimationFrame(() => prompt.current?.focus());
              }}
              onInsert={(text) => {
                const combined = `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}${text}`;
                if (combined.length > 12000)
                  throw new Error(
                    'Your draft would exceed 12,000 characters. Record a shorter message or close voice input and shorten your draft.',
                  );
                setDraft(combined);
                setVoiceThread(null);
                setDismissedSkillQuery(null);

                requestAnimationFrame(() => prompt.current?.focus());
              }}
            />
          )}
          {needsModel && (messages.length > 0 || original) && (
            <div className="chat-model-note" role="note">
              <span>{tr('You’re trying sample responses.')}</span>
              <button className="text-button" onClick={connectAI}>
                {tr('Connect AI')}
              </button>
            </div>
          )}
          {replyingTo && (
            <div className="reply-preview">
              <div>
                <strong>
                  Replying to {replyingTo.role === 'user' ? 'your message' : speaker(replyingTo)}
                </strong>
                <span>{replyingTo.text}</span>
              </div>
              <button
                className="icon-button"
                aria-label="Cancel reply"
                onClick={() => setReplyingTo(null)}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {group && (
            <div className="group-recipient-list" aria-label="Message recipients">
              {recipients.length ? (
                <>
                  <span>To</span>
                  {recipients.map((id) => (
                    <button
                      key={id}
                      aria-label={`Remove ${participants.find((a) => a.id === id)?.name} recipient`}
                      onClick={() => setRecipients(recipients.filter((x) => x !== id))}
                    >
                      {participants.find((a) => a.id === id)?.name}
                      <X size={12} />
                    </button>
                  ))}
                </>
              ) : (
                <span>
                  {defaultReplyRecipient(thread)
                    ? `Replies go to ${speaker(defaultReplyRecipient(thread))}`
                    : 'Let the group choose who can help'}
                </span>
              )}
              <button
                className="text-button"
                aria-label="Mention an assistant"
                onClick={openMentions}
              >
                <At size={16} />
              </button>
            </div>
          )}
          {navigation && navigationDestination && (
            <div className="composer-navigation" aria-label={tr('Go straight to a page')}>
              <button className="text-button" onClick={() => void send()}>
                <navigationDestination.Icon size={17} aria-hidden="true" />
                <span>{navigationLabel}</span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
              <button className="text-button navigation-ask" onClick={() => void send(draft, true)}>
                {tr('Ask {name} instead', { name: identity.name })}
              </button>
            </div>
          )}
          <div className="composer">
            {showMentions && (
              <div className="skill-picker" ref={mentionPicker}>
                <div
                  id="mention-options"
                  role="listbox"
                  aria-label={group ? 'Apps and group participants' : tr('Connected apps')}
                >
                  {mentionChoices.map((a, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`mention-${a.key}`}
                      key={a.key}
                      aria-selected={index === mentionChoice}
                      aria-label={a.kind === 'app' ? `${a.name} app` : a.name}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => chooseMention(a)}
                    >
                      {a.kind === 'app' ? <Plug size={17} /> : <At size={17} />}
                      <span>
                        <strong>{a.name}</strong>
                        <small>{a.kind === 'app' ? 'Connected app' : 'Group participant'}</small>
                      </span>
                    </button>
                  ))}
                  {!mentionChoices.length && (
                    <div
                      role="option"
                      aria-selected={false}
                      aria-disabled="true"
                      className="skill-picker-empty"
                    >
                      {group ? 'No matching apps or participants' : 'No matching apps'}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="skill-picker-manage"
                  onClick={() => {
                    setMentionDismissed(`${draft}:${cursor}`);
                    go('apps');
                  }}
                >
                  {tr('Connect apps')} <ArrowRight size={14} />
                </button>
              </div>
            )}
            {showSkillPicker && (
              <div className="skill-picker" ref={skillPicker}>
                <div id="skill-options" role="listbox" aria-label="Saved skills">
                  {skillChoices.map((skill, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`skill-option-${skill.id}`}
                      key={skill.id}
                      aria-selected={index === choiceIndex}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => chooseSkill(skill)}
                    >
                      <BookBookmark size={17} />
                      <span>
                        <strong>/{skill.slug}</strong>
                        <small>{skill.description || skill.title}</small>
                      </span>
                    </button>
                  ))}
                  {!skillChoices.length && (
                    <div
                      role="option"
                      aria-selected={false}
                      aria-disabled="true"
                      className="skill-picker-empty"
                    >
                      {(assistantSkills(s, identity.id) as Entity[]).some((x) => !x.archived)
                        ? 'No matching skills'
                        : 'Save a method to use it here'}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="skill-picker-manage"
                  onClick={() => {
                    setDismissedSkillQuery(prompt.current?.value || draft);
                    go('skills');
                  }}
                >
                  {tr('Manage skills')}
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
            {(shared.length > 0 || attachments.length > 0 || selectedApps.length > 0) && (
              <div className="composer-context">
                {shared.length > 0 && (
                  <div className="shared-composer-items" aria-label="Shared items">
                    {shared.map((item: Entity) => (
                      <div key={item.id}>
                        <div>
                          <small>{tr('Shared to this chat')}</small>
                          {item.text && <p>{item.text}</p>}
                          <AttachmentList ids={item.fileIds} draft />
                        </div>
                        <button
                          className="icon-button"
                          aria-label="Remove shared item"
                          onClick={() =>
                            void act('share.remove', { threadId: thread.id, id: item.id })
                          }
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <AttachmentList
                  ids={attachments}
                  draft
                  onRemove={(id) =>
                    setAttachments((current) => current.filter((value) => value !== id))
                  }
                />
                {selectedApps.length > 0 && (
                  <div className="composer-apps" aria-label="Selected apps">
                    {selectedApps.map((app) => {
                      const current = availableApps.find(
                        (a) => a.id === app.id && a.revision === app.revision,
                      );
                      return (
                        <button
                          type="button"
                          key={app.id}
                          className={current ? '' : 'app-selection-stale'}
                          aria-label={`Remove ${app.name} app`}
                          onClick={() =>
                            setSelectedApps((old) => old.filter((a) => a.id !== app.id))
                          }
                        >
                          <Plug size={15} />
                          <span>
                            {app.name}
                            {!current && <small>{tr('Choose again')}</small>}
                          </span>
                          <X size={13} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <textarea
              data-chat-composer
              ref={prompt}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (!files.length) return;
                event.preventDefault();
                void upload(files);
              }}
              rows={1}
              aria-label={
                original
                  ? tr('Reply in thread')
                  : tr('Message {name}', { name: group ? thread.title : identity.name })
              }
              aria-autocomplete="list"
              aria-controls={
                showMentions ? 'mention-options' : showSkillPicker ? 'skill-options' : undefined
              }
              aria-activedescendant={
                showMentions && mentionChoices.length
                  ? `mention-${mentionChoices[mentionChoice].key}`
                  : showSkillPicker && skillChoices.length
                    ? `skill-option-${skillChoices[choiceIndex].id}`
                    : undefined
              }
              placeholder={
                original
                  ? tr('Reply in thread…')
                  : tr('Message {name}…', { name: group ? thread.title : identity.name })
              }
              value={draft}
              onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
              onChange={(e) => {
                setDraft(e.target.value);
                setMentionOpen(false);
                setCursor(e.target.selectionStart);
                setSkillIndex(0);
                setMentionIndex(0);
                setMentionDismissed('');
                setDismissedSkillQuery(null);
              }}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  !e.altKey &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  !e.repeat &&
                  e.key.toLowerCase() === 'd'
                ) {
                  e.preventDefault();
                  startDictation(false);
                  return;
                }
                if (showMentions && !e.nativeEvent.isComposing) {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setMentionDismissed(`${draft}:${cursor}`);
                    setMentionOpen(false);
                    return;
                  }
                  if (['ArrowDown', 'ArrowUp'].includes(e.key) && mentionChoices.length) {
                    e.preventDefault();
                    setMentionIndex(
                      (mentionChoice + (e.key === 'ArrowDown' ? 1 : -1) + mentionChoices.length) %
                        mentionChoices.length,
                    );
                    return;
                  }
                  if (['Enter', 'Tab'].includes(e.key) && mentionChoices.length && !e.shiftKey) {
                    e.preventDefault();
                    chooseMention(mentionChoices[mentionChoice]);
                    return;
                  }
                }
                if (showSkillPicker && !e.nativeEvent.isComposing) {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setDismissedSkillQuery(prompt.current?.value || draft);
                    return;
                  }
                  if (['ArrowDown', 'ArrowUp'].includes(e.key) && skillChoices.length) {
                    e.preventDefault();
                    setSkillIndex(
                      (choiceIndex + (e.key === 'ArrowDown' ? 1 : -1) + skillChoices.length) %
                        skillChoices.length,
                    );
                    return;
                  }
                  if (['Enter', 'Tab'].includes(e.key) && skillChoices.length && !e.shiftKey) {
                    e.preventDefault();
                    chooseSkill(skillChoices[choiceIndex]);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!e.repeat) void send();
                }
              }}
            />
            <div className="composer-bottom">
              <button
                className="composer-voice"
                aria-label={tr('Start voice input')}
                title={tr('Dictate into your draft · ⌘/Ctrl D')}
                aria-expanded={voiceThread === thread.id}
                onClick={() => startDictation()}
                disabled={inputBusy || !!callThread}
              >
                <Microphone size={21} />
              </button>
              {!group &&
                !active &&
                !callThread &&
                !shared.length &&
                !!(draft.trim() || attachments.length) && (
                  <button
                    className="composer-voice composer-call"
                    aria-label={tr('Start voice chat')}
                    title={tr('Talk with {name}', { name: identity.name })}
                    disabled={inputBusy || !!voiceThread || computerPaused}
                    onClick={startVoiceChat}
                  >
                    <Waveform size={21} />
                  </button>
                )}
              <div className="composer-tools">
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  multiple
                  onChange={(e) => void upload(e.target.files)}
                />
                <ComposerActions
                  disabled={inputBusy}
                  teaching={!group && !callThread && api.mode() === 'server'}
                  chatId={thread.id}
                  onAttach={() => fileInput.current?.click()}
                  onTeach={() => {
                    go('computer');
                    history.replaceState(
                      null,
                      '',
                      `#computer/teaching/new?chat=${encodeURIComponent(thread.id)}`,
                    );
                  }}
                />
                {!group && availableApps.length > 0 && (
                  <button
                    type="button"
                    className="composer-plus choose-app-button"
                    aria-label={tr('Choose an app')}
                    title={tr('Choose an app · @')}
                    onClick={openMentions}
                    disabled={inputBusy || !!callThread}
                  >
                    <At size={21} />
                  </button>
                )}
                {active && (draft.trim() || shared.length > 0 || attachments.length > 0) && (
                  <div className="composer-busy-actions">
                    {!group && !callThread && (
                      <button
                        className="draft-stop-button"
                        aria-label={tr('Stop reply')}
                        title={tr('Stop reply')}
                        onClick={() => void act('chat.stop', { id: active.id })}
                      >
                        <Square size={16} weight="fill" />
                      </button>
                    )}
                    <button
                      className="queue-button"
                      onClick={() => void send(draft, true, 'queue')}
                    >
                      <Plus size={17} />
                      {tr('Queue follow-up')}{' '}
                    </button>
                  </div>
                )}
              </div>
              {!group &&
              !active &&
              !draft.trim() &&
              !attachments.length &&
              !shared.length &&
              !callThread ? (
                <button
                  className="send-button"
                  aria-label={tr('Start voice chat')}
                  title={tr('Talk with {name}', { name: identity.name })}
                  disabled={inputBusy || !!voiceThread || computerPaused}
                  onClick={startVoiceChat}
                >
                  <Waveform size={22} />
                </button>
              ) : active &&
                !callThread &&
                (group || !(draft.trim() || shared.length || attachments.length)) ? (
                <button
                  className="send-button stop-button"
                  aria-label={tr('Stop reply')}
                  onClick={() => void act('chat.stop', { id: active.id })}
                >
                  <Square size={16} weight="fill" />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label={
                    navigationDestination
                      ? tr('Go to {page}', { page: tr(navigationDestination.title) })
                      : computerPaused && canContinueWithSend
                        ? tr('Send message and continue chatting')
                        : tr('Send message')
                  }
                  title={
                    computerPaused && canContinueWithSend && !navigationDestination
                      ? tr('Send message and continue chatting')
                      : undefined
                  }
                  disabled={
                    (!draft.trim() && !shared.length && !attachments.length) ||
                    inputBusy ||
                    !!callThread
                  }
                  onClick={() => void send()}
                >
                  {navigationLabel ? (
                    <ArrowRight size={21} weight="bold" />
                  ) : (
                    <ArrowUp size={21} weight="bold" />
                  )}
                </button>
              )}
            </div>
          </div>
          <div className="composer-caption">
            <span>
              <span className="status-dot" />
              {computerPaused
                ? tr('Chat paused')
                : active
                  ? 'Working on your request'
                  : s.connections.model.configured
                    ? 'Connected to your model'
                    : 'Sample assistant · Ready when you are'}
            </span>
          </div>
          <WorkspaceDock />
        </div>
      </section>
      {editGroup && (
        <GroupEditor thread={originalThread || thread} onClose={() => setEditGroup(false)} />
      )}
      {saveSkill && <SkillEditor sourceMessage={saveSkill} onClose={() => setSaveSkill(null)} />}
      {editTitle && (
        <Modal title={tr('Rename conversation')} onClose={() => setEditTitle(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act('thread.update', { id: thread.id, title })) setEditTitle(false);
            }}
          >
            <Field label={tr('Conversation title')}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                required
              />
            </Field>
            <button className="primary-button" type="submit">
              {tr('Save title')}{' '}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
