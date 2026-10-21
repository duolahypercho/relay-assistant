import {
  Archive,
  Bell,
  Brain,
  CalendarBlank,
  ChartDonut,
  ChatCircle,
  Desktop,
  FileText,
  GearSix,
  Lightbulb,
  Microphone,
  Plug,
  Robot,
  ShieldCheck,
  SlidersHorizontal,
  Stack,
  Target,
  UsersThree,
  BookBookmark,
  ClockCounterClockwise,
  Envelope,
} from '@phosphor-icons/react';
import type { Page } from './types';

// One catalog for settings and search, so help links always land on the actual control.
export const settingsSections = [
  {
    id: 'personal',
    title: 'Appearance & personality',
    hint: 'Name, character, theme and response style',
    keywords:
      'dark mode light color colour timezone time zone nickname preferences language locale translation 语言 語言 中文 English 深色模式 淺色模式 浅色模式',
    Icon: SlidersHorizontal,
  },
  {
    id: 'memory',
    title: 'Memory',
    hint: 'See and edit what your assistant remembers',
    keywords: 'remember forget context learning facts',
    Icon: Brain,
  },
  {
    id: 'models',
    title: 'AI models',
    hint: 'Choose what powers your assistant',
    keywords: 'provider api key openai anthropic gemini grok ollama local endpoint connection',
    Icon: Robot,
  },
  {
    id: 'voice',
    title: 'Voice',
    hint: 'Listening, speaking and voice calls',
    keywords: 'audio microphone dictation transcription speech sound',
    Icon: Microphone,
  },
  {
    id: 'usage',
    title: 'Usage',
    hint: 'See your model requests and reported tokens',
    keywords: 'tokens consumption limits quota billing cost weekly activity',
    Icon: ChartDonut,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    hint: 'Choose when and where to hear from Relay',
    keywords: 'alerts quiet push device previews',
    Icon: Bell,
  },
  {
    id: 'connections',
    title: 'Connected apps',
    hint: 'Your apps, mail and calendar accounts',
    keywords: 'google gmail sign in oauth permissions',
    Icon: Plug,
  },
  {
    id: 'archive',
    title: 'Archived chats',
    hint: 'Bring back a conversation you put away',
    keywords: 'restore hidden old conversations',
    Icon: Archive,
  },
  {
    id: 'data',
    title: 'Data & devices',
    hint: 'Export your workspace or connect another device',
    keywords: 'privacy backup download export server sign out logout reset storage mobile phone',
    Icon: ShieldCheck,
  },
] as const;
export type SettingsSection = (typeof settingsSections)[number]['id'];
export function settingsRoute(): SettingsSection | undefined {
  const id = new URLSearchParams(location.hash.split('?')[1]).get('section');
  return settingsSections.find((item) => item.id === id)?.id;
}

export const pageDestinations: {
  page: Page;
  title: string;
  keywords: string;
  Icon: typeof GearSix;
}[] = [
  { page: 'chat', title: 'Chat', keywords: 'conversation message main', Icon: ChatCircle },
  {
    page: 'files',
    title: 'Files',
    keywords: 'documents results library attachments',
    Icon: FileText,
  },
  { page: 'activity', title: 'Tasks', keywords: 'work activity reviews approvals', Icon: Stack },
  { page: 'ideas', title: 'Ideas', keywords: 'suggestions inspiration', Icon: Lightbulb },
  {
    page: 'calendar',
    title: 'Calendar',
    keywords: 'events appointments plans schedule',
    Icon: CalendarBlank,
  },
  { page: 'inbox', title: 'Mail', keywords: 'inbox email gmail', Icon: Envelope },
  {
    page: 'routines',
    title: 'Routines',
    keywords: 'reminders scheduled automations repeat',
    Icon: ClockCounterClockwise,
  },
  {
    page: 'skills',
    title: 'Skills',
    keywords: 'saved instructions reusable workflows',
    Icon: BookBookmark,
  },
  {
    page: 'computer',
    title: 'Computer',
    keywords: 'virtual desktop browser terminal',
    Icon: Desktop,
  },
  {
    page: 'apps',
    title: 'Connect apps',
    keywords: 'integrations connectors mcp permissions',
    Icon: Plug,
  },
  {
    page: 'assistants',
    title: 'Assistants',
    keywords: 'bots roles characters companions',
    Icon: UsersThree,
  },
  { page: 'goals', title: 'Goals', keywords: 'tracking watches', Icon: Target },
  { page: 'finance', title: 'Spending', keywords: 'finance budget transactions', Icon: ChartDonut },
  {
    page: 'settings',
    title: 'Settings',
    keywords: 'preferences configuration profile',
    Icon: GearSix,
  },
];
