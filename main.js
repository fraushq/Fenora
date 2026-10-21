const { app, BrowserWindow, protocol, net, shell, session, ipcMain, Tray, Menu, nativeImage, dialog, globalShortcut } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true,
            allowServiceWorkers: true,
            bypassCSP: false,
        },
    },
]);

let mainWindow = null;
let tray = null;
let overlayWindow = null;
let overlayHideTimer = null;
let isQuitting = false;

const trayState = {
    track: null,
    isPlaying: false,
};

const traySettingsFile = () => path.join(app.getPath('userData'), 'mbox-settings.json');
const boundsFile = () => path.join(app.getPath('userData'), 'window-bounds.json');

function readTraySettings() {
    try {
        return JSON.parse(fs.readFileSync(traySettingsFile(), 'utf8'));
    } catch {
        return {};
    }
}

function writeTraySettings(s) {
    try {
        fs.writeFileSync(traySettingsFile(), JSON.stringify(s));
    } catch {}
}

function getSavedBounds() {
    try {
        return JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    } catch {
        return {};
    }
}

function saveBounds(bounds) {
    try {
        fs.writeFileSync(boundsFile(), JSON.stringify(bounds));
    } catch {}
}

function createWindow() {
    const savedBounds = getSavedBounds();

    mainWindow = new BrowserWindow({
        width:  savedBounds.width  || 1400,
        height: savedBounds.height || 900,
        x: savedBounds.x,
        y: savedBounds.y,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0A0A0A',
        frame: process.platform === 'darwin',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'fenora192.png'),
        show: false,
        resizable: true,
        maximizable: true,
        minimizable: true,
        fullscreenable: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            partition: 'persist:mbox',
            sandbox: false,
        },
    });

    mainWindow.loadURL('app://local/index.html');

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('close', async (e) => {
        saveBounds(mainWindow.getBounds());

        if (isQuitting) return;

        const settings = readTraySettings();
        const askClose  = settings.askOnClose !== false;
        const preferTray = settings.preferTray === true;

        if (!askClose) {
            if (preferTray) {
                e.preventDefault();
                mainWindow.hide();
            }
            return;
        }

        e.preventDefault();

        const result = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['Свернуть в трей', 'Закрыть полностью', 'Отмена'],
            defaultId: 0,
            cancelId: 2,
            title: 'Fenora',
            message: 'Закрыть Fenora?',
            detail: 'Можно свернуть в системный трей — плеер продолжит играть в фоне.',
            checkboxLabel: 'Запомнить мой выбор',
            checkboxChecked: false,
        });

        if (result.response === 2) return;

        if (result.checkboxChecked) {
            settings.askOnClose = false;
            settings.preferTray = result.response === 0;
            writeTraySettings(settings);
        }

        if (result.response === 0) {
            mainWindow.hide();
        } else {
            isQuitting = true;
            app.quit();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('app://')) {
            e.preventDefault();
            if (url.startsWith('http') || url.startsWith('mailto:')) {
                shell.openExternal(url);
            }
        }
    });

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('window:maximized', true);
    });
    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('window:maximized', false);
    });
}

function sendTrayAction(action) {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('tray:action', action);
    }
}

function updateTrayMenu() {
    if (!tray) return;

    const track = trayState.track;
    const title = track && track.title ? track.title : 'Ничего не играет';
    const artist = track && track.artist ? track.artist : '—';
    const isPlaying = trayState.isPlaying;

    const menu = Menu.buildFromTemplate([
        { label: title.slice(0, 60), enabled: false },
        { label: artist.slice(0, 60), enabled: false },
        { type: 'separator' },
        { label: isPlaying ? '⏸  Пауза' : '▶  Играть', click: () => sendTrayAction('toggle') },
        { label: '⏮  Предыдущий', click: () => sendTrayAction('prev') },
        { label: '⏭  Следующий',  click: () => sendTrayAction('next') },
        { type: 'separator' },
        { label: '📂  Открыть Fenora', click: () => {
            if (mainWindow) {
                mainWindow.show();
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
            }
        }},
        { type: 'separator' },
        { label: '✕  Выход', click: () => {
            isQuitting = true;

            if (tray) {
                try { tray.destroy(); } catch (e) {}
                tray = null;
            }
            if (overlayWindow) {
                try { overlayWindow.destroy(); } catch (e) {}
                overlayWindow = null;
            }
            if (mainWindow) {
                try { mainWindow.destroy(); } catch (e) {}
                mainWindow = null;
            }

            app.quit();

            setTimeout(() => app.exit(0), 1000);
        }},
    ]);

    tray.setContextMenu(menu);
    tray.setToolTip(track && track.title ? `${track.title} — ${artist}` : 'Fenora');
}

function createOverlay() {
    if (overlayWindow) return;

    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const { width: sw, height: sh, x: sx, y: sy } = display.workArea;

    const W = 380;
    const H = 96;
    const OFFSET = 24;

    overlayWindow = new BrowserWindow({
        width:  W,
        height: H,
        x: sx + sw - W - OFFSET,
        y: sy + sh - H - OFFSET,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: true,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            partition: 'persist:mbox',
            sandbox: false,
        },
    });

    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');

    overlayWindow.loadURL('app://local/overlay.html');

    overlayWindow.on('closed', () => { overlayWindow = null; });
}

function showOverlay(data) {
    if (!overlayWindow) createOverlay();
    if (!overlayWindow) return;

    try {
        const { screen } = require('electron');
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const { width: sw, height: sh, x: sx, y: sy } = display.workArea;
        const W = 380, H = 96, OFFSET = 24;
        overlayWindow.setBounds({
            x: sx + sw - W - OFFSET,
            y: sy + sh - H - OFFSET,
            width: W,
            height: H,
        });
    } catch (e) {}

    overlayWindow.webContents.send('overlay:data', data);
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();

    clearTimeout(overlayHideTimer);
    overlayHideTimer = setTimeout(() => {
        if (overlayWindow) overlayWindow.hide();
    }, 3200);
}

function createTray() {
    if (tray) return;

    const iconPath = path.join(__dirname, 'fenora192.png');
    let icon = nativeImage.createFromPath(iconPath);
    icon = icon.resize({ width: 16, height: 16 });

    tray = new Tray(icon);
    tray.setToolTip('Fenora');

    updateTrayMenu();

    tray.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

function registerGlobalShortcuts() {
    const bindings = [
        ['MediaPlayPause',       'toggle'],
        ['MediaNextTrack',       'next'],
        ['MediaPreviousTrack',   'prev'],
        ['MediaStop',            'stop'],

        ['CommandOrControl+Alt+Space', 'toggle'],
        ['CommandOrControl+Alt+Right', 'next'],
        ['CommandOrControl+Alt+Left',  'prev'],
        ['CommandOrControl+Alt+Up',    'vol-up'],
        ['CommandOrControl+Alt+Down',  'vol-down'],
    ];

    for (const [accel, action] of bindings) {
        try {
            const ok = globalShortcut.register(accel, () => {
                handleGlobalAction(action);
            });
            if (!ok) {
                console.warn('Не удалось зарегистрировать хоткей:', accel);
            }
        } catch (e) {
            console.warn('Ошибка регистрации хоткея', accel, e.message);
        }
    }
}

function handleGlobalAction(action) {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('global:action', action);
    }
}

app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const url = details.url;

        const ALLOWED = [
            'lrclib.net',
            'api.web3forms.com',
        ];

        const shouldRewrite = ALLOWED.some(host => url.includes(host));

        if (shouldRewrite) {
            details.requestHeaders['Origin'] = 'https://mbox.app';
            details.requestHeaders['Referer'] = 'https://mbox.app/';
            if (!details.requestHeaders['User-Agent']) {
                details.requestHeaders['User-Agent'] = 'mbox/0.52 (https://mbox.app)';
            }
        }

        callback({ requestHeaders: details.requestHeaders });
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const url = details.url;

        const NEED_CORS =
            url.includes('api.deezer.com') ||
            url.includes('itunes.apple.com') ||
            url.includes('musicbrainz.org') ||
            url.includes('coverartarchive.org');

        if (!NEED_CORS) {
            callback({ responseHeaders: details.responseHeaders });
            return;
        }

        const responseHeaders = Object.assign({}, details.responseHeaders);
        responseHeaders['Access-Control-Allow-Origin'] = ['*'];
        responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
        responseHeaders['Access-Control-Allow-Headers'] = ['*'];

        callback({ responseHeaders });
    });

    const mboxSession = session.fromPartition('persist:mbox');

    mboxSession.protocol.handle('app', (request) => {
        try {
            const url = new URL(request.url);
            let pathname = decodeURIComponent(url.pathname);

            if (pathname === '/' || pathname === '') pathname = '/index.html';

            const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
            const filePath = path.join(__dirname, safePath);

            if (!fs.existsSync(filePath)) {
                console.error('❌ Файл не найден:', filePath);
                return new Response('Not found', { status: 404 });
            }

            const data = fs.readFileSync(filePath);

            let mimeType = 'application/octet-stream';
            if (filePath.endsWith('.html')) mimeType = 'text/html; charset=utf-8';
            else if (filePath.endsWith('.js')) mimeType = 'text/javascript; charset=utf-8';
            else if (filePath.endsWith('.css')) mimeType = 'text/css; charset=utf-8';
            else if (filePath.endsWith('.json')) mimeType = 'application/json; charset=utf-8';
            else if (filePath.endsWith('.png')) mimeType = 'image/png';
            else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) mimeType = 'image/jpeg';
            else if (filePath.endsWith('.svg')) mimeType = 'image/svg+xml';
            else if (filePath.endsWith('.woff2')) mimeType = 'font/woff2';
            else if (filePath.endsWith('.woff')) mimeType = 'font/woff';
            else if (filePath.endsWith('.mp3')) mimeType = 'audio/mpeg';

            return new Response(data, {
                headers: { 'Content-Type': mimeType },
            });
        } catch (e) {
            console.error('❌ Ошибка протокола app://', e);
            return new Response('Internal Server Error', { status: 500 });
        }
    });

    const { net } = require('electron');

    ipcMain.handle('fetch-external', async (event, url, isBlob = false) => {
        return new Promise((resolve, reject) => {
            const request = net.request(url);
            request.on('response', (response) => {
                const chunks = [];
                response.on('data', (chunk) => { chunks.push(chunk); });
                response.on('end', () => {
                    if (isBlob) {
                        const buffer = Buffer.concat(chunks);
                        const base64 = buffer.toString('base64');
                        const contentType = response.headers['content-type'] || 'image/jpeg';
                        resolve({ status: response.statusCode, data: base64, isBase64: true, contentType });
                    } else {
                        const data = Buffer.concat(chunks).toString('utf8');
                        resolve({ status: response.statusCode, data });
                    }
                });
            });
            request.on('error', (error) => { reject(error); });
            request.end();
        });
    });

    const { registerMusicIpc } = require('./music-auth');
    registerMusicIpc(ipcMain, () => mainWindow);

    ipcMain.on('overlay:show', (e, data) => {
        showOverlay(data);
    });

    ipcMain.on('tray:update', (e, data) => {
        trayState.track = data && data.track ? data.track : null;
        trayState.isPlaying = !!(data && data.isPlaying);
        updateTrayMenu();
    });

    ipcMain.on('tray:hide-to-tray', () => {
        if (mainWindow) mainWindow.hide();
    });

    ipcMain.handle('tray:get-close-preference', () => {
        const s = readTraySettings();
        return {
            askOnClose:  s.askOnClose !== false,
            preferTray:  s.preferTray === true,
        };
    });

    ipcMain.on('tray:set-close-preference', (e, data) => {
        const s = readTraySettings();
        s.askOnClose = !!(data && data.askOnClose);
        s.preferTray = !!(data && data.preferTray);
        writeTraySettings(s);
    });

    ipcMain.on('window:minimize', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) win.minimize();
    });

    ipcMain.on('window:maximize', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) return;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    });

    ipcMain.on('window:close', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) win.close();
    });

    ipcMain.handle('window:isMaximized', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        return win ? win.isMaximized() : false;
    });

    createWindow();
    createTray();
    registerGlobalShortcuts();
    createOverlay();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('before-quit', () => {
    isQuitting = true;
    globalShortcut.unregisterAll();

    if (tray) {
        try { tray.destroy(); } catch (e) {}
        tray = null;
    }
    if (overlayWindow) {
        try { overlayWindow.destroy(); } catch (e) {}
        overlayWindow = null;
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});