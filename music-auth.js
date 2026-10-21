const { ipcMain, safeStorage, app } = require('electron');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'ffmpeg-static') {
        let ffmpegPath = originalRequire.apply(this, arguments);
        if (typeof ffmpegPath === 'string' && ffmpegPath.includes('app.asar')) {
            ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
        }
        return ffmpegPath;
    }
    return originalRequire.apply(this, arguments);
};

try {
    const resolvedFfmpeg = require('ffmpeg-static');
    console.log('[FFmpeg] Путь:', resolvedFfmpeg);
    process.env.FFMPEG_PATH = resolvedFfmpeg;
} catch (e) {
    console.warn('[FFmpeg] ffmpeg-static не найден:', e.message);
}

let Soundcloud = null;
try {
    Soundcloud = require('soundcloud.ts').default;
    console.log('[SoundCloud] soundcloud.ts загружен');
} catch (e) {
    console.warn('[SoundCloud] soundcloud.ts НЕ загружен:', e.message);
}

let _yamd2Promise = null;
let _yamd2Error = null;

function getYamd2() {
    if (!_yamd2Promise) {
        _yamd2Promise = (async () => {
            try {
                const m = require('yamd2');
                console.log('[Yandex] yamd2 успешно загружен через require()');
                return { YMApi: m.YMApi, WrappedYMApi: m.WrappedYMApi };
            } catch (errRequire) {
                console.warn('[Yandex] require() не сработал, пробуем import():', errRequire.message);
                try {
                    const { createRequire } = require('module');
                    const localRequire = createRequire(__filename);
                    const yamd2Path = localRequire.resolve('yamd2');
                    const importUrl = require('url').pathToFileURL(yamd2Path).href;

                    console.log('[Yandex] Загрузка через import() из:', importUrl);
                    const m = await import(importUrl);
                    console.log('[Yandex] yamd2 успешно загружен через import()');
                    return { YMApi: m.YMApi, WrappedYMApi: m.WrappedYMApi };
                } catch (errImport) {
                    _yamd2Error = `Require: ${errRequire.message} | Import: ${errImport.message}`;
                    console.error('[Yandex] Обе попытки не удались:', _yamd2Error);
                    return null;
                }
            }
        })();
    }
    return _yamd2Promise;
}

getYamd2();

const SC_TOKEN_FILE = () => path.join(app.getPath('userData'), 'soundcloud-token.bin');
function scSaveToken(token) {
    try {
        if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(SC_TOKEN_FILE(), safeStorage.encryptString(token));
        else fs.writeFileSync(SC_TOKEN_FILE(), token, 'utf8');
    } catch (e) { console.warn('SC saveToken failed:', e); }
}
function scLoadToken() {
    try {
        if (!fs.existsSync(SC_TOKEN_FILE())) return null;
        const buf = fs.readFileSync(SC_TOKEN_FILE());
        return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch (e) { return null; }
}
function scClearToken() { try { fs.unlinkSync(SC_TOKEN_FILE()); } catch (e) {} }

let soundcloudClient = null;
function getSoundcloudClient() {
    if (!Soundcloud) throw new Error('SOUNDCLOUD_NOT_INSTALLED');
    if (soundcloudClient) return soundcloudClient;
    const oauthToken = scLoadToken();
    soundcloudClient = new Soundcloud(undefined, oauthToken || undefined);
    return soundcloudClient;
}

const YM_TOKEN_FILE = () => path.join(app.getPath('userData'), 'yandex-token.bin');
function ymSaveToken(data) {
    try {
        const json = JSON.stringify(data);
        if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(YM_TOKEN_FILE(), safeStorage.encryptString(json));
        else fs.writeFileSync(YM_TOKEN_FILE(), json, 'utf8');
    } catch (e) { console.warn('YM saveToken failed:', e); }
}
function ymLoadToken() {
    try {
        if (!fs.existsSync(YM_TOKEN_FILE())) return null;
        const buf = fs.readFileSync(YM_TOKEN_FILE());
        const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
        return JSON.parse(json);
    } catch (e) { return null; }
}
function ymClearToken() { try { fs.unlinkSync(YM_TOKEN_FILE()); } catch (e) {} }

let ymClient = null;
async function getYandexClient() {
    if (ymClient) return ymClient;
    const lib = await getYamd2();
    if (!lib || !lib.YMApi) return null;

    const tokenData = ymLoadToken();
    if (!tokenData || !tokenData.access_token || !tokenData.uid) return null;

    try {
        const api = new lib.YMApi();
        await api.init({ access_token: tokenData.access_token, uid: tokenData.uid });
        ymClient = api;
        return ymClient;
    } catch (e) {
        console.warn('[Yandex] client init failed:', e.message);
        return null;
    }
}

function registerSoundcloudIpc(ipcMain) {
    ipcMain.handle('music:soundcloud:search', async (_, query, opts = {}) => {
        if (!query || typeof query !== 'string') return [];
        try {
            const client = getSoundcloudClient();
            const limit = Math.min(50, opts.limit || 20);
            const results = await client.tracks.search({ q: query, limit });
            return (results.collection || []).map(t => ({
                id: t.id, title: t.title, artist: t.user?.username || 'Unknown',
                album: t.album || '', cover: t.artwork_url || t.user?.avatar_url || null,
                duration: Math.round((t.duration || 0) / 1000), streamUrl: t.stream_url || null, source: 'soundcloud',
            }));
        } catch (e) {
            console.error('SoundCloud search failed:', e);
            throw new Error('SEARCH_FAILED');
        }
    });

    ipcMain.handle('music:soundcloud:download', async (_, trackOrId) => {
        const id = (typeof trackOrId === 'object' && trackOrId !== null) ? trackOrId.id : trackOrId;
        if (!id) return { ok: false, error: 'INVALID_TRACK' };

        try {
            const client = getSoundcloudClient();
            const fullTrack = await client.tracks.get(id);
            if (!fullTrack) return { ok: false, error: 'TRACK_NOT_FOUND' };

            const stream = await client.util.streamTrack(fullTrack);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);
            if (!buffer.length) return { ok: false, error: 'EMPTY_STREAM' };

            return { ok: true, data: buffer.toString('base64'), contentType: 'audio/mpeg', size: buffer.length };
        } catch (e) {
            console.error('SoundCloud download failed:', e);
            return { ok: false, error: e.message || String(e) };
        }
    });

    ipcMain.handle('music:soundcloud:status', async () => {
        try {
            const client = getSoundcloudClient();
            await client.tracks.search({ q: 'test', limit: 1 });
            return { connected: true };
        } catch (e) {
            return { connected: false, error: e.message };
        }
    });

    ipcMain.handle('music:soundcloud:disconnect', () => {
        scClearToken();
        soundcloudClient = null;
        return { ok: true };
    });
}

function registerYandexIpc(ipcMain, getMainWindow) {
    console.log('[Yandex] Начинаю регистрацию IPC-обработчиков...');

    ipcMain.handle('music:yandex:status', async () => {
        const lib = await getYamd2();
        if (!lib) return { connected: false, installed: false, error: _yamd2Error };
        const token = ymLoadToken();
        return { connected: !!token, installed: true, uid: token?.uid ?? null };
    });
    console.log('[Yandex] ✓ Зарегистрирован: music:yandex:status');

    ipcMain.handle('music:yandex:deviceAuth', async () => {
        const lib = await getYamd2();
        if (!lib) return { ok: false, error: 'NOT_INSTALLED' };

        try {
            const api = new lib.YMApi();
            const codeResp = await api.deviceAuth.requestDeviceCode();
            const deviceCode = codeResp.deviceCode || codeResp.device_code;
            const userCode = codeResp.userCode || codeResp.user_code;
            const verificationUrl = codeResp.verificationUrl || codeResp.verification_url || 'https://ya.ru/device';
            const expiresIn = codeResp.expiresIn || codeResp.expires_in || 300;
            const interval = codeResp.interval || 5;

            if (!deviceCode || !userCode) throw new Error('INVALID_DEVICE_CODE_RESPONSE');

            const win = getMainWindow?.();
            if (win && !win.isDestroyed()) {
                win.webContents.send('music:yandex:deviceCode', { user_code: userCode, verification_url: verificationUrl, expires_in: expiresIn });
            }

            const startedAt = Date.now();
            const maxWaitMs = expiresIn * 1000;
            let pollDelayMs = interval * 1000;
            let accessToken = null, refreshToken = null;

            while (Date.now() - startedAt < maxWaitMs) {
                await new Promise(r => setTimeout(r, pollDelayMs));
                try {
                    const tokenResp = await api.deviceAuth.pollDeviceToken(deviceCode, { interval: pollDelayMs / 1000 });
                    let at = null, rt = null;
                    if (typeof tokenResp === 'string') at = tokenResp;
                    else if (tokenResp && typeof tokenResp === 'object') {
                        at = tokenResp.access_token || tokenResp.accessToken || tokenResp.token || null;
                        rt = tokenResp.refresh_token || tokenResp.refreshToken || null;
                    }
                    if (at) { accessToken = at; refreshToken = rt; break; }
                } catch (pollErr) {
                    const msg = String(pollErr.message || pollErr);
                    if (msg.includes('slow_down')) { pollDelayMs += 5000; continue; }
                    if (msg.includes('authorization_pending')) continue;
                    if (msg.includes('expired_token')) throw new Error('DEVICE_CODE_EXPIRED');
                    if (msg.includes('access_denied')) throw new Error('ACCESS_DENIED');
                }
            }

            if (!accessToken) throw new Error('TIMEOUT_OR_NO_TOKEN');

            let uid = 0;
            try {
                const tempApi = new lib.YMApi();
                await tempApi.init({ access_token: accessToken, uid: '0' });
                const status = await tempApi.account.getAccountStatus();
                uid = status?.account?.uid ?? status?.uid ?? status?.result?.account?.uid ?? status?.result?.uid ?? status?.account?.id ?? 0;
                uid = parseInt(uid, 10) || 0;
            } catch (e) { console.warn('[Yandex] accountStatus failed:', e.message); }

            if (!uid) {
                const winUid = getMainWindow?.();
                if (winUid && !winUid.isDestroyed()) winUid.webContents.send('music:yandex:needUid', { access_token: accessToken, refresh_token: refreshToken });
                return { ok: false, error: 'NEED_UID' };
            }

            ymSaveToken({ access_token: accessToken, refresh_token: refreshToken, uid });
            ymClient = null;
            const win2 = getMainWindow?.();
            if (win2 && !win2.isDestroyed()) win2.webContents.send('music:yandex:authDone', { ok: true, uid });
            return { ok: true, uid };
        } catch (outerErr) {
            return { ok: false, error: outerErr.message || String(outerErr) };
        }
    });
    console.log('[Yandex] ✓ Зарегистрирован: music:yandex:deviceAuth');

    ipcMain.handle('music:yandex:search', async (_, query, opts = {}) => {
        const client = await getYandexClient();
        if (!client) throw new Error('NOT_CONNECTED');
        if (!query || typeof query !== 'string') return [];

        const limit = Math.min(50, opts.limit || 20);
        const result = await client.search.tracks(query, { page: 0, pageSize: limit });
        const tracks = result?.tracks?.results || result?.result?.tracks?.results || result?.results || [];

        return tracks.map(t => {
            const coverRaw = t.coverUri || t.albums?.[0]?.coverUri || null;
            return {
                id: String(t.id), title: t.title || '', artist: (t.artists || []).map(a => a.name).join(', '),
                album: t.albums?.[0]?.title || '', cover: coverRaw ? `https://${coverRaw.replace('%%', '400x400')}` : null,
                duration: Math.round((t.durationMs || 0) / 1000), source: 'yandex',
            };
        });
    });
    console.log('[Yandex] ✓ Зарегистрирован: music:yandex:search');

    ipcMain.handle('music:yandex:download', async (_, trackId) => {
        const lib = await getYamd2();
        if (!lib || !lib.WrappedYMApi) return { ok: false, error: 'WRAPPED_NOT_AVAILABLE' };
        const tokenData = ymLoadToken();
        if (!tokenData) return { ok: false, error: 'NOT_CONNECTED' };

        let numericId = null, trackUrl = null;
        const s = String(trackId).trim();
        if (/^\d+$/.test(s)) { numericId = parseInt(s, 10); trackUrl = `https://music.yandex.ru/track/${numericId}`; }
        else if (s.startsWith('http')) trackUrl = s;
        else return { ok: false, error: 'INVALID_TRACK_ID: ' + s };

        try {
            const wrapped = new lib.WrappedYMApi();
            await wrapped.init({ access_token: tokenData.access_token, uid: tokenData.uid || 0 });
            let url = null;
            const attempts = [
                () => wrapped.getMp3DownloadUrl(numericId),
                () => wrapped.getMp3DownloadUrl(trackUrl),
                () => wrapped.getBestDownloadUrl(numericId),
                () => wrapped.getBestDownloadUrl(trackUrl),
            ];
            for (const fn of attempts) {
                try { const r = await fn(); if (r && r.startsWith('http')) { url = r; break; } } catch (e) {}
            }
            if (!url) return { ok: false, error: 'NO_URL' };

            const api = await getYandexClient();
            if (!api) return { ok: false, error: 'NOT_CONNECTED' };

            const chunks = [];
            for await (const chunk of api.tracks.streamTrack(url)) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);
            if (!buffer.length) return { ok: false, error: 'EMPTY_STREAM' };

            let contentType = 'audio/mpeg';
            const lower = String(url).toLowerCase();
            if (lower.includes('.flac') || lower.includes('codec=flac')) contentType = 'audio/flac';
            else if (lower.includes('.mp4')) contentType = 'audio/mp4';

            return { ok: true, data: buffer.toString('base64'), contentType, size: buffer.length };
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
    });
    console.log('[Yandex] ✓ Зарегистрирован: music:yandex:download');

    ipcMain.handle('music:yandex:disconnect', () => {
        ymClearToken(); ymClient = null; return { ok: true };
    });
    console.log('[Yandex] ✓ Зарегистрирован: music:yandex:disconnect');

    ipcMain.handle('music:yandex:saveUid', async (_, { access_token, refresh_token, uid }) => {
        const lib = await getYamd2();
        if (!lib) return { ok: false, error: 'NOT_INSTALLED' };
        try {
            uid = parseInt(uid, 10);
            if (!uid || uid < 1) return { ok: false, error: 'INVALID_UID' };
            const api = new lib.YMApi();
            await api.init({ access_token, uid });
            await api.account.getAccountStatus();
            ymSaveToken({ access_token, refresh_token, uid });
            ymClient = api;
            const win = getMainWindow?.();
            if (win && !win.isDestroyed()) win.webContents.send('music:yandex:authDone', { ok: true, uid });
            return { ok: true, uid };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });
    console.log('[Yandex] ✓ Зарегистрирован: music:yandex:saveUid');
    
    console.log('[Yandex] Все IPC-обработчики успешно зарегистрированы!');
}

let _isMusicIpcRegistered = false;

function registerMusicIpc(ipcMain, getMainWindow) {
    if (_isMusicIpcRegistered) {
        console.log('[Music] IPC уже зарегистрированы, пропускаем повторную регистрацию.');
        return;
    }
    _isMusicIpcRegistered = true;

    registerSoundcloudIpc(ipcMain);
    registerYandexIpc(ipcMain, getMainWindow);
}

module.exports = { registerMusicIpc };