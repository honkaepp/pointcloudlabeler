// PointCloudLabeler — Point-cloud tree labelling, forest inventory and biomass from terrestrial and mobile laser scans
// Copyright (C) 2026 Eppu Honkanen
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { setupDesktopBridge } from './persistence/desktopBridge';
import { installRendererErrorLog, type CrashSink } from './persistence/rendererErrorLog';
import { hydrateSettings } from './persistence/settingsStore';
import { applyTheme, readTheme } from './ui/theme';
import { clearRemovedFeatureData } from './persistence/removedFeatureCleanup';

// Install the Tauri ↔ window.desktop bridge and hydrate persisted settings
// before React mounts so the very first render finds the desktop API
// populated and useState(() => localStorage.getItem(...)) initialisers
// see values restored from the on-disk settings file (see
// src-tauri/src/app_id.rs for where it lives).
// Drop what a removed feature left in the browser store — see
// persistence/removedFeatureCleanup.ts. Before hydration, so nothing
// reads a value on its way out.
clearRemovedFeatureData();

// Uncaught errors and unhandled rejections go to the crash log on the
// Rust side (see persistence/rendererErrorLog.ts). Installed before the
// bridge exists: the sink is looked up when an error happens, not now.
installRendererErrorLog(window, () => (window as unknown as { desktop?: CrashSink }).desktop);

Promise.allSettled([setupDesktopBridge(), hydrateSettings()]).then(() => {
  // After hydration, so a theme restored from settings.json is the one
  // applied, and before the first render, so nothing flashes dark on
  // its way to white.
  applyTheme(readTheme());
  // The boundary around the whole tree is what stands between a render
  // error anywhere above the module boundaries — the tabs, the welcome
  // screen, App itself — and a blank window with no way back.
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary label="PointCloudLabeler">
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
});
