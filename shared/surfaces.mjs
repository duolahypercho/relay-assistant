// SPDX-License-Identifier: MIT
// Workspace objects are presented in the conversation; they do not change the app's page.
export const surfaces = {
  apps: {
    title: 'Your apps',
    request: 'Show my apps',
    text: 'Connect the apps you use and choose what your assistant can do.',
  },
  assistants: {
    title: 'Your assistants',
    request: 'Show my assistants',
    text: 'Give a specialist a role while keeping your main conversation together.',
  },
  skills: {
    title: 'Your skills',
    request: 'Show my skills',
    text: 'Your saved ways of doing things. Use one here, or type / in chat.',
  },
  routines: {
    title: 'Your routines',
    request: 'Show my routines',
    text: 'Things you want me to keep doing. Set a schedule, test it, and see what happened here.',
  },
  activity: {
    title: 'Your tasks',
    request: 'Show my tasks',
    text: 'Here’s your work. Follow a task, review an action, or hand me something new.',
  },
  ideas: {
    title: 'Ideas for you',
    request: 'Show my ideas',
    text: 'A few things I can help with, based on what’s in your workspace.',
  },
  goals: {
    title: 'Goals and tracking',
    request: 'Show my goals',
    text: 'Your goals and things you’re keeping an eye on are here.',
  },
  files: {
    title: 'Your files',
    request: 'Show my files',
    text: 'Here are your saved files. Open one, add a document, or start a note.',
  },
  finance: {
    title: 'Your spending',
    request: 'Show my spending',
    text: 'Here’s your spending from the transactions you’ve imported.',
  },
  inbox: {
    title: 'Your mail',
    request: 'Show my mail',
    text: 'Your mailbox is here. Read a thread or prepare a reply for review.',
  },
  calendar: {
    title: 'Your calendar',
    request: 'Show my calendar',
    text: 'Here’s your calendar. Choose a time and I’ll show the change for review.',
  },
  computer: {
    title: 'Your computer',
    request: 'Open my computer',
    text: 'You can see the workspace browser and run reviewed commands here.',
  },
};

export function requestedSurface(text) {
  const q = text
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/, '');
  if (
    /^(?:what am i working on|what needs (?:my )?review|show (?:my )?(?:work|tasks|activity))$/.test(
      q,
    )
  )
    return 'activity';
  if (/^(?:any ideas|show (?:my )?(?:ideas|suggestions))$/.test(q)) return 'ideas';
  const match = q.match(
    /^(?:show|open|view|manage|check|see)\s+(?:(?:me|my|the|your)\s+)*(files|documents|goals|tracking|mail|inbox|emails|calendar|schedule|computer|browser|terminal|spending|finance|transactions|tasks|activity|ideas|routines|automations|reminders|skills|assistants|apps|connections)(?:\s+(?:please|here))?$/,
  );
  if (!match) return null;
  return {
    files: 'files',
    documents: 'files',
    goals: 'goals',
    tracking: 'goals',
    mail: 'inbox',
    inbox: 'inbox',
    emails: 'inbox',
    calendar: 'calendar',
    schedule: 'calendar',
    computer: 'computer',
    browser: 'computer',
    terminal: 'computer',
    spending: 'finance',
    finance: 'finance',
    transactions: 'finance',
    tasks: 'activity',
    activity: 'activity',
    ideas: 'ideas',
    routines: 'routines',
    automations: 'routines',
    reminders: 'routines',
    skills: 'skills',
    assistants: 'assistants',
    apps: 'apps',
    connections: 'apps',
  }[match[1]];
}
