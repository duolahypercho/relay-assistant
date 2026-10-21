import { lazy } from 'react';
export const workspaceViews: Record<string, any> = {
  more: lazy(() => import('../views/More')),
  apps: lazy(() => import('../views/Apps')),
  assistants: lazy(() => import('../views/Assistants')),
  skills: lazy(() => import('../views/Skills')),
  routines: lazy(() => import('../views/Routines')),
  activity: lazy(() => import('../views/Activity')),
  ideas: lazy(() => import('../views/Ideas')),
  goals: lazy(() => import('../views/Goals')),
  files: lazy(() => import('../views/Files')),
  finance: lazy(() => import('../views/Finance')),
  inbox: lazy(() => import('../views/Inbox')),
  calendar: lazy(() => import('../views/Calendar')),
  computer: lazy(() => import('../views/Computer')),
};
