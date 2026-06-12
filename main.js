const { app, BrowserWindow, shell, dialog, Tray, Menu, Notification, nativeImage, ipcMain } = require('electron');
const path   = require('path');
const net    = require('net');
const { spawn } = require('child_process');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

// ── Debug log ──────────────────────────────────────────────────────────────────
const logFile = path.join(os.homedir(), 'mailmind-debug.log');
function log(msg) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}
process.on('uncaughtException',  e => log('CRASH: '  + (e.stack || e.message || String(e))));
process.on('unhandledRejection', e => log('REJECT: ' + (e && (e.stack || e.message) ? (e.stack || e.message) : String(e))));

// ── Wait for port with timeout ──────────────────────────────────────────────────
function waitForPort(port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (Date.now() > deadline) { reject(new Error('timeout')); return; }
      const c = net.createConnection(port, '127.0.0.1');
      c.once('connect', () => { c.destroy(); resolve(); });
      c.once('error',   () => setTimeout(check, 200));
    };
    check();
  });
}

// ── Sync settings (background tray polling) ───────────────────────────────────
const DEFAULT_SYNC = { background: true, intervalMin: 15, notifications: true, tone: 'builtin:mixkit-magic-notification-ring-2344.wav' };

function loadSyncSettings(userData) {
  try {
    const p = path.join(userData, 'sync-settings.json');
    if (fs.existsSync(p)) return { ...DEFAULT_SYNC, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {}
  return { ...DEFAULT_SYNC };
}

function saveSyncSettings(userData, s) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'sync-settings.json'), JSON.stringify(s));
  } catch {}
}

let serverProcess = null;
let win           = null;
let tray          = null;
let syncTimer     = null;
let lastTopId     = null;
let trayHintShown = false;
let userData      = '';
let syncSettings  = { ...DEFAULT_SYNC };

// ── Background poll (runs from main process, unaffected by window visibility) ──
async function doBackgroundPoll() {
  if (!win || win.isDestroyed()) return;
  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const r = await fetch('/api/emails?q=in:inbox&maxResults=5', { credentials: 'include' });
          if (!r.ok) return '[]';
          const d = await r.json();
          return JSON.stringify(d.emails || []);
        } catch { return '[]'; }
      })()
    `);
    const emails = JSON.parse(result);
    if (!emails.length) return;
    const topId = emails[0].id;
    if (lastTopId === null) { lastTopId = topId; return; } // first run — baseline only
    if (topId === lastTopId) return;
    lastTopId = topId;
    const newest = emails[0];
    tray?.setToolTip('Mailmind — new mail arrived');
    const tone = syncSettings.tone || 'builtin:mixkit-magic-notification-ring-2344.wav';
    if (tone !== 'none') {
      let soundUrl;
      if (tone.startsWith('builtin:')) {
        soundUrl = '/sounds/' + tone.slice(8);
      } else if (tone.startsWith('custom:')) {
        soundUrl = 'file:///' + tone.slice(7).replace(/\\/g, '/');
      }
      if (soundUrl) {
        win.webContents.executeJavaScript(
          `new Audio(${JSON.stringify(soundUrl)}).play().catch(()=>{})`
        ).catch(() => {});
      }
    }
    if (syncSettings.notifications && Notification.isSupported()) {
      const n = new Notification({
        title: '📬 New mail — Mailmind',
        body: (newest.sender ? newest.sender + ' · ' : '') + (newest.subject || '(no subject)'),
      });
      n.on('click', () => { win.show(); win.focus(); });
      n.show();
    }
  } catch (e) {
    log('background poll error: ' + e.message);
  }
}

function startSyncTimer() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (!syncSettings.background) return;
  const ms = (syncSettings.intervalMin || 15) * 60 * 1000;
  syncTimer = setInterval(doBackgroundPoll, ms);
  log('background sync: every ' + syncSettings.intervalMin + ' min');
}

// ── IPC: renderer ↔ main ──────────────────────────────────────────────────────
ipcMain.on('set-sync-settings', (_, s) => {
  syncSettings = { ...DEFAULT_SYNC, ...s };
  saveSyncSettings(userData, syncSettings);
  startSyncTimer();
  updateTrayMenu();
  log('sync settings updated: ' + JSON.stringify(syncSettings));
});

ipcMain.handle('get-sync-settings', () => syncSettings);

ipcMain.handle('pick-tone-file', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose notification tone',
    filters: [{ name: 'Audio files', extensions: ['wav', 'mp3', 'ogg', 'm4a'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── Tray menu ─────────────────────────────────────────────────────────────────
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Mailmind',
      click: () => { win.show(); win.focus(); },
    },
    {
      label: 'Check Now',
      click: () => doBackgroundPoll(),
    },
    { type: 'separator' },
    {
      label: syncSettings.background ? 'Background sync: ON' : 'Background sync: OFF',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit Mailmind',
      click: () => {
        tray.destroy();
        if (serverProcess) serverProcess.kill();
        app.exit(0);
      },
    },
  ]));
}

app.whenReady().then(async () => {
  log('app ready, isPackaged=' + app.isPackaged + ', version=' + app.getVersion());

  const appDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : __dirname;

  const nodeBin = app.isPackaged
    ? path.join(process.resourcesPath, 'node.exe')
    : 'node';

  const envPath = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '.env');

  userData = app.getPath('userData');
  const dbPath = path.join(userData, 'data.db');

  // Load sync settings early so tray/window-close behaviour is correct from start
  syncSettings = loadSyncSettings(userData);

  // ── Per-machine encryption secret ────────────────────────────────────────────
  const secretPath = path.join(userData, 'secret.key');
  let machineSecret;
  try {
    if (fs.existsSync(secretPath)) {
      machineSecret = fs.readFileSync(secretPath, 'utf8').trim();
      log('loaded existing machine secret');
    } else {
      fs.mkdirSync(userData, { recursive: true });
      machineSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(secretPath, machineSecret, { mode: 0o600 });
      log('generated new machine secret');
    }
  } catch (e) {
    log('Secret file error: ' + e.message + ' — using ephemeral secret');
    machineSecret = crypto.randomBytes(32).toString('hex');
  }

  require('dotenv').config({ path: envPath });

  const serverScript = path.join(appDir, 'server', 'index.js');
  log('spawning: ' + nodeBin + ' ' + serverScript);

  serverProcess = spawn(nodeBin, [serverScript], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      MAILMIND_SECRET: machineSecret,
      SESSION_SECRET: machineSecret,
    },
    cwd: appDir,
  });

  serverProcess.stdout?.on('data', d => log('srv: '     + d.toString().trim()));
  serverProcess.stderr?.on('data', d => log('srv ERR: ' + d.toString().trim()));
  serverProcess.on('exit', code => log('server exited: ' + code));

  // ── Window ────────────────────────────────────────────────────────────────────
  win = new BrowserWindow({
    width: 1400, height: 900,
    minWidth: 900, minHeight: 600,
    title: 'Mailmind',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(appDir, 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);

  // Hide to tray instead of quitting (when background sync is enabled)
  win.on('close', e => {
    if (syncSettings.background) {
      e.preventDefault();
      win.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        // Windows balloon tip
        tray?.displayBalloon?.({
          iconType: 'info',
          title: 'Mailmind is still running',
          content: 'Checking for new emails in the background. Right-click the tray icon to quit.',
        });
      }
    }
  });

  // ── Tray icon ─────────────────────────────────────────────────────────────────
  try {
    const iconPath = path.join(appDir, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Mailmind');
    tray.on('double-click', () => { win.show(); win.focus(); });
    updateTrayMenu();
    log('tray created');
  } catch (e) {
    log('tray error: ' + e.message);
  }

  // Show the loading splash immediately
  win.loadFile(path.join(appDir, 'public', 'loading.html'));

  // ── Wait for server, then navigate ───────────────────────────────────────────
  try {
    await waitForPort(3000, 20000);
    win.loadURL('http://localhost:3000');
    log('navigated to app');
  } catch (e) {
    log('Port 3000 not available: ' + e.message);
    dialog.showErrorBox(
      'Mailmind failed to start',
      'The server did not respond within 20 seconds.\n\n' +
      'Possible cause: port 3000 is already in use by another application.\n\n' +
      'Debug log: ' + logFile
    );
    app.quit();
    return;
  }

  // Start background polling after app loads
  win.webContents.once('did-finish-load', () => {
    startSyncTimer();
  });

  // ── Auto-updater (packaged builds only) ───────────────────────────────────────
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.logger = { info: m => log('updater: ' + m), warn: m => log('updater WARN: ' + m), error: m => log('updater ERR: ' + m) };
      autoUpdater.checkForUpdatesAndNotify();
    } catch (e) {
      log('Auto-updater error: ' + e.message);
    }
  }

  // Open all target="_blank" links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // Do nothing — tray keeps the app alive.
  // Quit only via tray menu → "Quit Mailmind".
});
