import { Capacitor, registerPlugin } from '@capacitor/core';

export const isNativeMobile = Capacitor.isNativePlatform();
export const mobileConnection = registerPlugin<{
  status(): Promise<{ url: string }>;
  show(options?: { locale: string }): Promise<void>;
  openAppSignIn(options: { url: string }): Promise<void>;
}>('RelayConnection');

export const mobileResults = registerPlugin<{
  preview(options: { title: string; source: string }): Promise<void>;
  beginBackup(): Promise<{ id: string }>;
  appendBackup(options: { id: string; offset: number; base64: string }): Promise<{ bytes: number }>;
  saveBackup(options: { id: string; size: number }): Promise<{ status: 'saved' | 'cancelled' }>;
  cancelBackup(options: { id: string }): Promise<{ status: 'cancelled' }>;
  save(options: {
    name: string;
    mime: string;
    base64: string;
  }): Promise<{ status: 'saved' | 'cancelled' }>;
}>('RelayResults');
export const hasNativeResults = () => isNativeMobile && Capacitor.isPluginAvailable('RelayResults');

export type IncomingShare = {
  id: string;
  scope: string;
  threadId?: string;
  text: string;
  files: { name: string; mime: string; base64: string }[];
};
export const mobileShares = registerPlugin<{
  peekTemplate(): Promise<{ item?: { id: string; url: string } }>;
  acknowledgeTemplate(options: { id: string }): Promise<void>;
  sync(options: {
    scope: string;
    label: string;
    chats: { id: string; title: string }[];
  }): Promise<void>;
  peek(options: { scope: string }): Promise<{ item?: IncomingShare }>;
  acknowledge(options: { scope: string; id: string }): Promise<void>;
}>('RelayShares');
export const hasNativeShares = () => isNativeMobile && Capacitor.isPluginAvailable('RelayShares');
