export type Entity = { id: string; [key: string]: any };
export interface Workspace {
  schema: number;
  revision: number;
  profile: {
    name: string;
    tone: string;
    initials: string;
    notifications: boolean;
    theme: string;
    [key: string]: any;
  };
  assistants?: Entity[];
  handoffs?: Entity[];
  shareImports?: Entity[];
  templateImports?: Entity[];
  threads: Entity[];
  messages: Entity[];
  questions?: Entity[];
  runs: Entity[];
  tasks: Entity[];
  approvals: Entity[];
  goals: Entity[];
  watches: Entity[];
  routines: Entity[];
  skills: Entity[];
  files: Entity[];
  artifacts?: Entity[];
  ideas?: any;
  voiceCalls?: Entity[];
  mail: Entity[];
  events: Entity[];
  memories: Entity[];
  notifications: Entity[];
  attentionReadIds?: string[];
  attentionReadThrough?: Record<string, string>;
  receipts: Entity[];
  transactions: Entity[];
  financeName: string;
  fixture: { available: boolean; price: number; text: string };
  connections: Record<string, any>;
}
export type Page =
  | 'chat'
  | 'activity'
  | 'ideas'
  | 'goals'
  | 'files'
  | 'finance'
  | 'inbox'
  | 'calendar'
  | 'computer'
  | 'settings'
  | 'routines'
  | 'skills'
  | 'assistants'
  | 'apps'
  | 'more';
