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

// ── Single instance lock ────────────────────────────────────────────────────────
// Without this, launching the app while it's hidden in the tray spawns a second
// instance whose server dies with EADDRINUSE — both windows then share ONE server,
// and quitting either instance kills it, leaving the other window dead/stuck.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', (_e, argv) => {
  // A redundant login relaunch may itself carry --hidden; honour it (don't pop the
  // window the user deliberately kept hidden in the tray).
  if (Array.isArray(argv) && argv.includes('--hidden')) return;
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
});

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

// ── Stale server detection ──────────────────────────────────────────────────────
// After a crash or auto-update, an orphaned server from a previous run can still
// hold port 3000. If its version matches ours, reuse it; otherwise kill it so a
// fresh server of the current version can bind.
function isPortBusy(port) {
  return new Promise(resolve => {
    const c = net.createConnection(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error',   () => resolve(false));
  });
}

function getExistingServerVersion(port) {
  return new Promise(resolve => {
    const req = require('http').get({ host: '127.0.0.1', port, path: '/api/version', timeout: 3000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).version || null); } catch { resolve(null); } });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Forcefully and SYNCHRONOUSLY terminate the spawned server (and any children it
// started) before we quit or hand off to the updater. A plain serverProcess.kill()
// on Windows often leaves the node.exe alive — which then (a) keeps holding port 3000
// so the freshly-installed app times out on launch, and (b) locks resources\node.exe
// so the NSIS installer can't overwrite it and the update fails. taskkill /T /F kills
// the whole tree forcibly; doing it synchronously guarantees it's gone before the
// installer touches the files.
function killServerProcessSync() {
  const proc = serverProcess;
  serverProcess = null;
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      require('child_process').execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' });
    } else {
      proc.kill();
    }
  } catch (e) {
    log('killServerProcessSync: ' + (e.message || e));
    try { proc.kill(); } catch {}
  }
}

function killStaleServer(port) {
  return new Promise(resolve => {
    const { exec } = require('child_process');
    exec('netstat -ano -p tcp', (err, out) => {
      if (err || !out) return resolve(false);
      const pids = new Set();
      for (const line of out.split('\n')) {
        const m = line.match(new RegExp('^\\s*TCP\\s+\\S+:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)'));
        if (m && +m[1] !== process.pid) pids.add(m[1]);
      }
      if (!pids.size) return resolve(false);
      let done = 0;
      pids.forEach(pid => exec('taskkill /PID ' + pid + ' /F', () => { if (++done === pids.size) resolve(true); }));
    });
  });
}

// ── GA4 Measurement Protocol (anonymous install analytics) ────────────────────
const GA4_URL = 'https://www.google-analytics.com/mp/collect?measurement_id=G-15L3SXHJBY&api_secret=JnvhkILxQverlaNPa7P5oA';

// ── Sync settings (background tray polling) ───────────────────────────────────
const DEFAULT_SYNC = { background: true, intervalMin: 5, notifications: true, tone: 'builtin:mixkit-magic-notification-ring-2344.wav', launchOnStartup: false, analyticsEnabled: true };

// ── Launch-on-Windows-startup ─────────────────────────────────────────────────
// Registers/unregisters the app in the Windows "Run" key via Electron. Launched
// copies get a --hidden flag so login starts straight into the tray (no window
// popping up on every boot), matching how Slack/Discord behave.
// The Run-key entry is written WITH these exact path+args. getLoginItemSettings MUST
// be queried with the SAME options or Windows reports openAtLogin:false — the stored
// command line carries --hidden and won't match a bare query. Keep them in one place
// so the set and get calls can never drift.
const LOGIN_ITEM_OPTS = { path: process.execPath, args: ['--hidden'] };

function applyLoginItemSettings(enabled) {
  // Only touch the registry for the installed app — in dev (`npm run electron`)
  // process.execPath is the electron prebuilt binary, which we must not register.
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ ...LOGIN_ITEM_OPTS, openAtLogin: !!enabled, openAsHidden: true });
  } catch (e) {
    log('setLoginItemSettings error: ' + e.message);
  }
}

// Reads the REAL Windows startup state using the same identity we registered with.
function isLaunchOnStartupEnabled() {
  if (!app.isPackaged) return false;
  try { return !!app.getLoginItemSettings({ ...LOGIN_ITEM_OPTS }).openAtLogin; }
  catch { return false; }
}

const LEGACY_DEFAULT_INTERVAL = 15;   // pre-1.1.7 default; migrate untouched installs to the new 5-min default
function loadSyncSettings(userData) {
  try {
    const p = path.join(userData, 'sync-settings.json');
    if (fs.existsSync(p)) {
      const saved = { ...DEFAULT_SYNC, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
      // One-time migration: anyone still on the old 15-min default never deliberately
      // chose it (15 was the baked-in default), so bump them to the faster new default
      // and persist a marker so this runs exactly once — a later deliberate choice of
      // 15 must survive future launches.
      if (!saved._intervalMigrated) {
        if (saved.intervalMin === LEGACY_DEFAULT_INTERVAL) saved.intervalMin = DEFAULT_SYNC.intervalMin;
        saved._intervalMigrated = true;
        saveSyncSettings(userData, saved);
      }
      return saved;
    }
  } catch {}
  return { ...DEFAULT_SYNC, _intervalMigrated: true };
}

function saveSyncSettings(userData, s) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'sync-settings.json'), JSON.stringify(s));
  } catch {}
}

// ── Anonymous usage analytics (opt-out, no PII) ────────────────────────────────
// UUID is a random 64-hex string stored in userData/telemetry.json — never linked
// to an email address, account, or any personal identifier. IP is used server-side
// only to derive country code (CF-IPCountry header) and is never stored.
function getOrCreateInstallUuid(uDir) {
  const p = path.join(uDir, 'telemetry.json');
  try {
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof d.install_uuid === 'string' && /^[0-9a-f]{64}$/.test(d.install_uuid)) return d.install_uuid;
    }
  } catch {}
  const uuid = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(p, JSON.stringify({ install_uuid: uuid }), 'utf8'); } catch {}
  return uuid;
}

function maybeSendTelemetry(uDir) {
  if (!syncSettings.analyticsEnabled) return;
  try {
    const client_id = getOrCreateInstallUuid(uDir);
    const payload   = JSON.stringify({
      client_id,
      events: [{
        name: 'app_open',
        params: {
          app_version:          app.getVersion(),
          engagement_time_msec: '1',
        },
      }],
    });
    const url = new URL(GA4_URL);
    const req = require('https').request({
      host: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 8000,
    }, res => { res.resume(); });
    req.on('error',   () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(payload);
    req.end();
    log('GA4 ping sent v' + app.getVersion());
  } catch (e) {
    log('GA4 error: ' + e.message);
  }
}

let serverProcess = null;
let win           = null;
let tray          = null;
let syncTimer     = null;
let lastTopByAcct = null;   // Map<accountId, newestEmailId> — null until first poll baselines it
let trayHintShown = false;
let isQuitting    = false;   // true once we genuinely want to exit (quit/menu/auto-update) — lets the window actually close instead of hiding to tray
let userData      = '';
let syncSettings  = { ...DEFAULT_SYNC };

// ── Background poll (runs from main process, unaffected by window visibility) ──
let pollInFlight = false;
async function doBackgroundPoll() {
  if (!win || win.isDestroyed()) return;
  if (pollInFlight) return;   // a hung poll must not stack new ones every interval
  pollInFlight = true;
  try {
    // Poll EVERY connected mailbox, not just the active one. /api/emails/all
    // aggregates inboxes across all accounts and tags each email with _accountId /
    // _accountEmail, so a new message in any mailbox can notify us — even the ones
    // not currently open in the UI.
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 30000);
          const r = await fetch('/api/emails/all', { credentials: 'include', signal: ctrl.signal });
          if (!r.ok) return '[]';
          const d = await r.json();
          return JSON.stringify(d.emails || []);
        } catch { return '[]'; }
      })()
    `);
    const emails = JSON.parse(result);
    if (!emails.length) return;

    // Newest email per account (emails are already sorted newest-first by the server,
    // so the first occurrence of each accountId is that mailbox's newest message).
    const newestByAcct = new Map();
    for (const e of emails) {
      const aid = e._accountId || 'default';
      if (!newestByAcct.has(aid)) newestByAcct.set(aid, e);
    }

    // First poll just baselines every mailbox — no notification for pre-existing mail.
    if (lastTopByAcct === null) {
      lastTopByAcct = new Map();
      for (const [aid, e] of newestByAcct) lastTopByAcct.set(aid, e.id);
      return;
    }

    // Collect mailboxes whose newest message changed since last poll.
    const fresh = [];
    for (const [aid, e] of newestByAcct) {
      const prev = lastTopByAcct.get(aid);
      lastTopByAcct.set(aid, e.id);
      if (prev !== undefined && prev !== e.id) fresh.push(e);
    }
    if (!fresh.length) return;

    // Avoid double-notifying. When the window is visible the renderer's own 60s poll
    // already shows the toast + notification + sound, so the main process stays quiet
    // and only notifies for foreground-invisible states (hidden to tray, or minimized) —
    // which is exactly when the renderer poll is paused (document.hidden). The baselines
    // above are already updated, so this mail won't re-notify when the window reopens.
    const pageVisible = win.isVisible() && !win.isMinimized();
    if (pageVisible) return;

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
      if (fresh.length === 1) {
        const newest = fresh[0];
        const acct = newest._accountEmail ? ' (' + newest._accountEmail + ')' : '';
        const n = new Notification({
          title: '📬 New mail — Mailmind' + acct,
          body: (newest.sender ? newest.sender + ' · ' : '') + (newest.subject || '(no subject)'),
        });
        n.on('click', () => { win.show(); win.focus(); });
        n.show();
      } else {
        // Multiple mailboxes got new mail this round — one summary notification.
        const boxes = [...new Set(fresh.map(e => e._accountEmail).filter(Boolean))];
        const n = new Notification({
          title: '📬 New mail in ' + fresh.length + ' messages — Mailmind',
          body: boxes.length ? boxes.join(', ') : 'New messages across your mailboxes',
        });
        n.on('click', () => { win.show(); win.focus(); });
        n.show();
      }
    }
  } catch (e) {
    log('background poll error: ' + e.message);
  } finally {
    pollInFlight = false;
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
  // Keep the one-time interval-migration marker pinned on regardless of what the
  // renderer sends, so a deliberate interval choice (incl. 15) is never re-migrated.
  syncSettings = { ...DEFAULT_SYNC, ...s, _intervalMigrated: true };
  saveSyncSettings(userData, syncSettings);
  startSyncTimer();
  applyLoginItemSettings(syncSettings.launchOnStartup);
  updateTrayMenu();
  log('sync settings updated: ' + JSON.stringify(syncSettings));
});

ipcMain.handle('get-sync-settings', () => syncSettings);

// Lets the renderer know if it's the installed app (so dev-only no-op controls,
// e.g. launch-on-startup, can be disabled honestly).
ipcMain.handle('app-is-packaged', () => app.isPackaged);

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
        isQuitting = true;
        tray.destroy();
        killServerProcessSync();
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

  // Reflect the real Windows startup state (the user may have removed it via Task
  // Manager → Startup or Settings → Apps → Startup); the in-app toggle should match
  // reality rather than blindly re-enabling it on every boot.
  if (app.isPackaged) {
    const realOpenAtLogin = isLaunchOnStartupEnabled();
    if (realOpenAtLogin !== syncSettings.launchOnStartup) {
      syncSettings.launchOnStartup = realOpenAtLogin;
      saveSyncSettings(userData, syncSettings);
    }
  }

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

  // Handle an existing listener on port 3000: reuse if it's our own version
  // (e.g. NSSM service or a same-version orphan), kill it if it's a stale orphan
  // from a crash or pre-update run.
  let needSpawn = true;
  if (await isPortBusy(3000)) {
    const v = await getExistingServerVersion(3000);
    if (v === app.getVersion()) {
      log('reusing existing server v' + v + ' on port 3000');
      needSpawn = false;
    } else {
      log('stale server (v' + v + ') on port 3000 — killing it');
      await killStaleServer(3000);
      await new Promise(r => setTimeout(r, 800));
    }
  }

  if (needSpawn) {
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
  }

  // ── Window ────────────────────────────────────────────────────────────────────
  // Window/taskbar icon — first non-empty candidate wins
  let winIcon;
  for (const c of [path.join(appDir, 'icon.png'), path.join(appDir, 'public', 'mailmind-icon.png')]) {
    const img = nativeImage.createFromPath(c);
    if (img && !img.isEmpty()) { winIcon = img; break; }
  }

  // When Windows launches us at login we pass --hidden so the app boots straight
  // into the tray (silent background sync) instead of popping a window on every boot.
  const startedHidden = process.argv.includes('--hidden');

  win = new BrowserWindow({
    width: 1400, height: 900,
    minWidth: 900, minHeight: 600,
    title: 'Mailmind',
    show: !startedHidden,
    ...(winIcon ? { icon: winIcon } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(appDir, 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  if (startedHidden) log('launched hidden at login — starting in tray');

  // Hide to tray instead of quitting while the app should keep running in the tray —
  // i.e. when background sync OR launch-on-startup is on. Otherwise let the window
  // close and quit cleanly (window-all-closed below). We must never destroy the only
  // window while the process stays alive, or the tray/menu recovery paths would call
  // show() on a dead window and the app becomes unrecoverable.
  win.on('close', e => {
    // When we're genuinely quitting (tray Quit, app.quit(), or an auto-update restart),
    // let the window close — NEVER preventDefault here, or app.quit()/quitAndInstall()
    // gets cancelled and the installer reports "Mailmind cannot be closed".
    if (isQuitting) return;
    const persist = syncSettings.background || syncSettings.launchOnStartup;
    if (persist) {
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
    // Try the root icon first, then the always-bundled public copy as a fallback.
    // If icon.png isn't packaged, createFromPath returns an EMPTY image and the tray
    // icon shows up blank/invisible — so we verify isEmpty() and fall back.
    const candidates = [
      path.join(appDir, 'icon.png'),
      path.join(appDir, 'public', 'mailmind-icon.png'),
      path.join(appDir, 'public', 'icon.png'),
    ];
    let icon = null;
    for (const c of candidates) {
      const img = nativeImage.createFromPath(c);
      if (img && !img.isEmpty()) { icon = img.resize({ width: 16, height: 16 }); break; }
    }
    if (!icon) throw new Error('no usable tray icon found in: ' + candidates.join(', '));
    tray = new Tray(icon);
    tray.setToolTip('Mailmind');
    tray.on('double-click', () => { win.show(); win.focus(); });
    tray.on('click', () => { win.show(); win.focus(); });
    updateTrayMenu();
    log('tray created');
  } catch (e) {
    log('tray error: ' + e.message);
    // If we started hidden at login and the tray also failed, we'd be a headless
    // process with no way to surface a window — fall back to showing it.
    if (startedHidden && win && !win.isDestroyed()) { win.show(); win.focus(); }
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

  // Start background polling after app loads, and fire a one-time telemetry ping
  win.webContents.once('did-finish-load', () => {
    startSyncTimer();
    setTimeout(() => maybeSendTelemetry(userData), 10000);
  });

  // ── Auto-updater ──────────────────────────────────────────────────────────────
  function sendUpdateStatus(status, message) {
    if (win && !win.isDestroyed()) win.webContents.send('update-status', { status, message });
    log('updater [' + status + ']: ' + (message || ''));
  }

  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.logger = { info: m => log('updater: ' + m), warn: m => log('updater WARN: ' + m), error: m => log('updater ERR: ' + m) };
      autoUpdater.on('checking-for-update',  ()  => sendUpdateStatus('checking',   'Checking for updates…'));
      autoUpdater.on('update-available',     (i) => sendUpdateStatus('available',  'Update v' + i.version + ' found — downloading…'));
      autoUpdater.on('update-not-available', ()  => sendUpdateStatus('latest',     'You\'re on the latest version.'));
      autoUpdater.on('download-progress',    (p) => sendUpdateStatus('progress',   'Downloading… ' + Math.round(p.percent) + '%'));
      autoUpdater.on('update-downloaded',    (i) => sendUpdateStatus('downloaded', 'Update v' + i.version + ' ready — click Restart to install.'));
      autoUpdater.on('error',               (e)  => sendUpdateStatus('error',      'Update error: ' + (e.message || String(e))));

      ipcMain.handle('check-for-updates', () => {
        autoUpdater.checkForUpdates().catch(e => sendUpdateStatus('error', e.message));
      });
      ipcMain.on('install-update', () => {
        // Mark quitting so the window-close interceptor lets go (otherwise quitAndInstall
        // is cancelled and the installer can't close the app). Kill the server FIRST so it
        // can't lock resources\node.exe or hold port 3000 while the installer swaps files in.
        isQuitting = true;
        killServerProcessSync();
        autoUpdater.quitAndInstall();
      });

      // Silent background check on launch
      autoUpdater.checkForUpdates().catch(e => log('auto-update check: ' + e.message));
    } catch (e) {
      log('Auto-updater error: ' + e.message);
      ipcMain.handle('check-for-updates', () => sendUpdateStatus('error', 'Updater unavailable.'));
    }
  } else {
    // Dev mode — manual check not available
    ipcMain.handle('check-for-updates', () => sendUpdateStatus('error', 'Auto-update only works in the installed app.'));
  }

  // Open all target="_blank" links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // If the app isn't meant to persist in the tray (background sync and launch-on-
  // startup both off), quit cleanly when the window closes. Otherwise the tray keeps
  // the app alive — quit via tray menu → "Quit Mailmind".
  const persist = syncSettings.background || syncSettings.launchOnStartup;
  if (!persist) app.quit();
});

// Fires on quitAndInstall, auto-install-on-quit, and any other quit path — make sure
// the spawned server never outlives the app (orphans hold port 3000 → EADDRINUSE /
// launch timeout, and lock node.exe → failed updates).
app.on('before-quit', () => {
  isQuitting = true;   // so win.on('close') stops intercepting and the window can actually close
  killServerProcessSync();
});
