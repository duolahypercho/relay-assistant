import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DeviceLinkGate from './components/DeviceLinkGate';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './style.css';
import './workspace.css';
import './conversation.css';
import './messenger.css';
import './routines.css';
import './components/workspace-page.css';
import './components/message-bubbles.css';
import './components/chat-touch.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DeviceLinkGate>
      <App />
    </DeviceLinkGate>
  </React.StrictMode>,
);
