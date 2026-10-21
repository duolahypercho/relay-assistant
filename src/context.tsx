import { createContext, useContext } from 'react';
import type { Workspace, Page } from './types';
import type { SettingsSection } from './navigation';
export interface WorkspaceContext {
  s: Workspace;
  page: Page;
  settingsSection?: SettingsSection;
  threadId: string;
  focusMessageId: string;
  focusSerial: number;
  clearFocus: () => void;
  go: (page: Page, section?: SettingsSection, targetHash?: string) => void;
  selectThread: (id: string, messageId?: string) => void;
  openMemories: () => void;
  openConnections: () => void;
  connectAI: () => void;
  openTask: (id: string) => void;
  openFile: (id: string) => void;
  composeFile: (id: string) => void;
  openArtifact: (id: string, version?: number) => void;
  act: (action: string, payload?: Record<string, any>) => Promise<any>;
  run: (fn: () => Promise<any>) => Promise<any>;
  toast: (message: string) => void;
}
export const Context = createContext<WorkspaceContext>(null!);
export const useWorkspace = () => useContext(Context);
