let audioEngine, fileUploadSystem, visualizer, backgroundSystem,
    playlistManager, contextMenu, registrationSystem;
let isEcoMode = false;
let lastProgressUpdate = 0;
let lyricsLoadToken = 0;
let coverBgEnabled = false;
let coverAccentEnabled = false;
let currentCoverPalette = null;

function ensureGlobe() {
    if (window.globeView) return window.globeView;
    window.globeView = new GlobeView();
    return window.globeView;
}

function _normalizeForSearch(str) {
    return String(str || '')
        .toLowerCase()
        .replace(/[^\wа-яё0-9]/gi, '')
        .trim();
}

const COVER_SEARCH_PROXIES = [
    (url) => url,
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

async function _fetchJsonViaProxy(targetUrl, timeoutMs = 8000) {
    if (window.electronAPI?.fetchExternal) {
        try {
            const res = await window.electronAPI.fetchExternal(targetUrl);
            if (res.status === 200 && res.data) {
                return JSON.parse(res.data);
            }
        } catch (e) {
            console.warn('IPC fetch failed, falling back to proxies:', e);
        }
    }

    for (let i = 0; i < COVER_SEARCH_PROXIES.length; i++) {
        const finalUrl = COVER_SEARCH_PROXIES[i](targetUrl);
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            const r = await fetch(finalUrl, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const text = await r.text();
            if (!text || (text[0] !== '{' && text[0] !== '[')) throw new Error('Not JSON');
            return JSON.parse(text);
        } catch (e) {
            if (i === COVER_SEARCH_PROXIES.length - 1) {
                console.warn('All cover-search proxies failed for:', targetUrl, e.message);
                return null;
            }
        }
    }
    return null;
}

async function _fetchBlobViaProxy(targetUrl, timeoutMs = 12000) {
    if (window.electronAPI?.fetchExternal) {
        try {
            const res = await window.electronAPI.fetchExternal(targetUrl, true);
            if (res.status === 200 && res.data && res.isBase64) {
                const byteCharacters = atob(res.data);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                return new Blob([byteArray], { type: res.contentType || 'image/jpeg' });
            }
        } catch (e) {
            console.warn('IPC blob fetch failed, falling back to proxies:', e);
        }
    }

    for (let i = 0; i < COVER_SEARCH_PROXIES.length; i++) {
        const finalUrl = COVER_SEARCH_PROXIES[i](targetUrl);
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            const r = await fetch(finalUrl, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!r.ok) continue;
            const blob = await r.blob();
            if (blob && blob.size > 500) return blob;
        } catch (e) {}
    }
    return null;
}

async function fetchCoverFromDeezer(artist, title) {
    const q = `${artist} ${title}`.trim();
    if (!q) return null;

    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`;
    const data = await _fetchJsonViaProxy(url);
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;

    const aN = _normalizeForSearch(artist);
    const tN = _normalizeForSearch(title);

    let best = null, bestScore = -1;
    for (const r of data.data) {
        if (!r.album || !r.album.cover_xl) continue;
        const rA = _normalizeForSearch(r.artist && r.artist.name);
        const rT = _normalizeForSearch(r.title);
        let score = 0;
        if (rA === aN) score += 5;
        else if (rA.includes(aN) || aN.includes(rA)) score += 3;
        if (rT === tN) score += 5;
        else if (rT.includes(tN) || tN.includes(rT)) score += 3;
        if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best || bestScore < 3) return null;

    const blob = await _fetchBlobViaProxy(best.album.cover_xl);
    if (!blob || blob.size < 500) return null;

    return {
        blob,
        source: 'Deezer',
        artist: best.artist.name,
        title: best.title,
        album: best.album.title || ''
    };
}

async function fetchCoverFromiTunes(artist, title) {
    const term = `${artist} ${title}`.trim();
    if (!term) return null;

    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=10&media=music`;
    const data = await _fetchJsonViaProxy(url);
    if (!data || !Array.isArray(data.results) || data.results.length === 0) return null;

    const aN = _normalizeForSearch(artist);
    const tN = _normalizeForSearch(title);

    let best = null, bestScore = -1;
    for (const r of data.results) {
        if (!r.artworkUrl100) continue;
        const rA = _normalizeForSearch(r.artistName);
        const rT = _normalizeForSearch(r.trackName);
        let score = 0;
        if (rA === aN) score += 5;
        else if (rA.includes(aN) || aN.includes(rA)) score += 3;
        if (rT === tN) score += 5;
        else if (rT.includes(tN) || tN.includes(rT)) score += 3;
        if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best || bestScore < 3) return null;

    const bigUrl = best.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.');
    const blob = await _fetchBlobViaProxy(bigUrl);
    if (!blob || blob.size < 500) return null;

    return {
        blob,
        source: 'iTunes',
        artist: best.artistName,
        title: best.trackName,
        album: best.collectionName || ''
    };
}

async function findCoverForTrack(track, opts = {}) {
    if (!track) return null;
    const silent = !!opts.silent;

    const artist = cleanTrackQuery(primaryArtist(track.artist));
    const title  = cleanTrackQuery(track.title);

    if (!artist || !title) {
        if (!silent) showNotification('Не хватает имени артиста или названия', true);
        return null;
    }

    if (!silent) showNotification(`Ищу обложку для «${track.title}»...`);

    let result = await fetchCoverFromDeezer(artist, title);

    if (!result) result = await fetchCoverFromiTunes(artist, title);

    if (!result) {
        if (!silent) showNotification('Обложка не найдена', true);
        return null;
    }

    if (track.coverUrl && track.coverUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(track.coverUrl); } catch (e) {}
    }
    track.coverBlob = result.blob;
    track.coverUrl = URL.createObjectURL(result.blob);

    if (window.trackStorage) {
        window.trackStorage.updateMetadata(track).catch(() => {});
    }

    if (window.audioEngine) {
        window.audioEngine._updatePlayerCover(track);
        if (typeof refreshCoverAppearance === 'function') {
            refreshCoverAppearance(track);
        }
    }
    if (typeof updateStageCover === 'function') updateStageCover(track);
    if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
    if (window.trackQueue) window.trackQueue.render();
    if (window.miniPlayer && typeof window.miniPlayer._updateFromTrack === 'function') {
        window.miniPlayer._updateFromTrack();
    }

    if (!silent) showNotification(`Обложка найдена (${result.source})`);
    return result;
}

window.findCoverForTrack = findCoverForTrack;

class MiniViz {
    constructor(audioEngine) {
        this.audioEngine = audioEngine;
        this.canvas = document.getElementById('topbarViz');
        if (!this.canvas) { this.disabled = true; return; }

        this.canvas.innerHTML = '';
        const c = document.createElement('canvas');
        this.canvas.appendChild(c);
        this.ctx = c.getContext('2d');

        this.mode = 'bars';
        this.modes = ['bars', 'wave', 'pulse'];
        this.animId = null;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);

        this._resize();
        window.addEventListener('resize', () => this._resize());

        this.canvas.addEventListener('click', () => this._cycleMode());

        this._tick = this._tick.bind(this);
        this._start();
    }

    _resize() {
        if (!this.ctx) return;
        const r = this.canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        this.canvas.firstElementChild.width  = w * this.dpr;
        this.canvas.firstElementChild.height = h * this.dpr;
        this.canvas.firstElementChild.style.width  = w + 'px';
        this.canvas.firstElementChild.style.height = h + 'px';
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this._rect = null;
        this.W = w;
        this.H = h;
    }

    _cycleMode() {
        const i = this.modes.indexOf(this.mode);
        this.mode = this.modes[(i + 1) % this.modes.length];
        this.canvas.title = `Визуализатор: ${this.mode === 'bars' ? 'Столбики' : this.mode === 'wave' ? 'Волна' : 'Пульс'}`;
    }

    _start() {
        if (this.animId || this.disabled) return;
        this._lastRender = 0;
        this._frameInterval = 1000 / 30;
        this._idleDrawn = false;
        this.animId = requestAnimationFrame(this._tick);
    }

    _stop() {
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
        this._idleDrawn = false;
        if (this.ctx) this.ctx.clearRect(0, 0, this.W, this.H);
    }

    _tick(now) {
        if (isEcoMode) { this._stop(); return; }

        const eng = this.audioEngine;
        const playing = eng && eng.isPlaying;
        const data = playing && eng.getFrequencyData ? eng.getFrequencyData() : null;

        if (!playing || !data || data.length === 0) {
            if (!this._idleDrawn) {
                this.ctx.clearRect(0, 0, this.W, this.H);
                this._drawIdle();
                this._idleDrawn = true;
            }
            this.animId = requestAnimationFrame(this._tick);
            return;
        }
        this._idleDrawn = false;

        if (now - this._lastRender < this._frameInterval) {
            this.animId = requestAnimationFrame(this._tick);
            return;
        }
        this._lastRender = now;

        this.ctx.clearRect(0, 0, this.W, this.H);

        if (this.mode === 'bars')       this._drawBars(data);
        else if (this.mode === 'wave')  this._drawWave(data);
        else                            this._drawPulse(data);

        this.animId = requestAnimationFrame(this._tick);
    }

    _drawIdle() {
        const [r, g, b] = (typeof getAccentRGB === 'function') ? getAccentRGB() : [254, 23, 67];
        this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.25)`;
        const W = this.W, H = this.H;
        const bw = 3, gap = 3;
        const totalW = bw * 3 + gap * 2;
        const startX = (W - totalW) / 2;
        const heights = [4, 8, 6];
        heights.forEach((h, i) => {
            this.ctx.fillRect(startX + i * (bw + gap), H - 4 - h, bw, h);
        });
    }

    _drawBars(data) {
        const [r, g, b] = getAccentRGB();
        this.ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

        const W = this.W, H = this.H;
        const barCount = 3;
        const gap = 3;
        const bw = Math.max(2, Math.floor((W - gap * (barCount - 1) - 8) / barCount));
        const totalW = bw * barCount + gap * (barCount - 1);
        const startX = (W - totalW) / 2;
        const maxH = H - 8;

        for (let i = 0; i < barCount; i++) {
            const idx = Math.floor((i + 1) * data.length / (barCount + 2));
            const v = Math.max(4, (data[idx] / 255) * maxH);
            this.ctx.fillRect(startX + i * (bw + gap), H - 4 - v, bw, v);
        }
    }

    _drawWave(data) {
        const [r, g, b] = getAccentRGB();
        const W = this.W, H = this.H;
        const mid = H / 2;

        const N = 10;
        const step = Math.max(1, Math.floor(data.length / N));
        const pts = [];
        for (let i = 0; i < N; i++) {
            const v = data[i * step] / 255;
            pts.push({
                x: (i / (N - 1)) * (W - 4) + 2,
                y: mid - v * (mid - 3)
            });
        }

        this.ctx.beginPath();
        this.ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i].x, pts[i].y);

        this.ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        this.ctx.lineWidth = 1.5;
        this.ctx.lineJoin = 'round';
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(pts[0].x, mid + (mid - pts[0].y));
        for (let i = 1; i < pts.length; i++) {
            this.ctx.lineTo(pts[i].x, mid + (mid - pts[i].y));
        }
        this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.35)`;
        this.ctx.lineWidth = 1;
        this.ctx.stroke();
    }

    _drawPulse(data) {
        const [r, g, b] = getAccentRGB();
        const W = this.W, H = this.H;
        const cx = W / 2, cy = H / 2;

        const bassCount = Math.max(1, Math.floor(data.length / 8));
        let sum = 0;
        for (let i = 0; i < bassCount; i++) sum += data[i];
        const bass = sum / bassCount / 255;

        const radius = 3 + bass * (Math.min(W, H) / 2 - 4);
        const glow = 4 + bass * 8;

        this.ctx.beginPath();
        this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(0.4 + bass * 0.6).toFixed(2)})`;
        this.ctx.fill();

        this.ctx.beginPath();
        this.ctx.arc(cx, cy, radius + 1, 0, Math.PI * 2);
        this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(0.4 * bass).toFixed(2)})`;
        this.ctx.lineWidth = glow * 0.5;
        this.ctx.stroke();
    }
}

const EMPTY_GREETINGS = [
    { text: 'Привет.', sub: 'Здесь будет твоя музыка' },
    { text: 'Ммм. Тут пусто.', sub: 'Перетащи аудиофайлы на главную' },
    { text: 'Добро пожаловать.', sub: 'Fenora — это твой личный плеер' },
    { text: 'Пора начать.', sub: 'Загрузи треки — они останутся у тебя' },
    { text: 'Это твой плеер.', sub: 'Всё локально, ничего не уходит' },
];

const EmptyGreeting = {
    idx: 0,
    timer: null,
    started: false,

    start() {
        if (this.started) return;
        this.started = true;
        this.idx = 0;
        this._show(0, true);
        this._schedule();
    },

    stop() {
        this.started = false;
        clearTimeout(this.timer);
        this.timer = null;
        const el = document.getElementById('stageEmptyGreeting');
        const sub = document.getElementById('stageEmptySub');
        el?.classList.remove('visible');
        sub?.classList.remove('visible');
    },

    _show(i, instant = false) {
        const el = document.getElementById('stageEmptyGreeting');
        const sub = document.getElementById('stageEmptySub');
        if (!el) return;
        const g = EMPTY_GREETINGS[i % EMPTY_GREETINGS.length];

        if (instant) {
            el.textContent = g.text;
            if (sub) sub.textContent = g.sub;
            el.classList.add('visible');
            sub?.classList.add('visible');
            return;
        }

        el.classList.remove('visible');
        sub?.classList.remove('visible');

        setTimeout(() => {
            el.textContent = g.text;
            if (sub) sub.textContent = g.sub;
            el.classList.add('visible');
            sub?.classList.add('visible');
        }, 420);
    },

    _schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.idx = (this.idx + 1) % EMPTY_GREETINGS.length;
            this._show(this.idx);
            this._schedule();
        }, 5500);
    },
};

class CoverPingPong {
    constructor() {
        this.canvas = document.getElementById('playerCoverCanvas');
        if (!this.canvas) { this.disabled = true; return; }
        this.ctx = this.canvas.getContext('2d');
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.animId = null;
        this.running = false;

        this.ball         = { x: 0.5, y: 0.5, vx: 0.6, vy: 0.35, size: 0.11 };
        this.paddleLeft   = { x: 0.08, y: 0.5, w: 0.045, h: 0.22 };
        this.paddleRight  = { x: 0.92, y: 0.5, w: 0.045, h: 0.22 };

        this.w = 0; this.h = 0; this.lastT = 0;

        this._resize = this._resize.bind(this);
        this._tick   = this._tick.bind(this);
        window.addEventListener('resize', this._resize);
        this._resize();
    }

    _resize() {
        if (this.disabled) return;
        const r = this.canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        this.canvas.width  = w * this.dpr;
        this.canvas.height = h * this.dpr;
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.w = w; this.h = h;
    }

    start() {
        if (this.disabled || this.running) return;
        this.running = true;
        this.lastT = performance.now();
        this.animId = requestAnimationFrame(this._tick);
    }

    stop() {
        this.running = false;
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
        if (this.ctx) this.ctx.clearRect(0, 0, this.w, this.h);
    }

    _tick(now) {
        if (!this.running) return;
        this.animId = requestAnimationFrame(this._tick);

        let dt = (now - this.lastT) / 1000;
        this.lastT = now;
        if (!isFinite(dt) || dt <= 0) dt = 0.016;
        if (dt > 0.05) dt = 0.05;

        this._update(dt);
        this._draw();
    }

    _update(dt) {
        if (this.w <= 0 || this.h <= 0) return;

        const ball = this.ball;
        const pl = this.paddleLeft;
        const pr = this.paddleRight;
        const half = ball.size / 2;

        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;

        if (ball.y < half)     { ball.y = half;     ball.vy =  Math.abs(ball.vy); }
        if (ball.y > 1 - half) { ball.y = 1 - half; ball.vy = -Math.abs(ball.vy); }

        if (ball.vx < 0 && ball.x - half <= pl.x + pl.w / 2 && ball.x - half > pl.x - 0.02) {
            if (Math.abs(ball.y - pl.y) <= pl.h / 2 + half) {
                const off = (ball.y - pl.y) / (pl.h / 2);
                ball.vx =  Math.abs(ball.vx) * 1.02;
                ball.vy += off * 0.5;
                ball.vx = Math.min(ball.vx, 1.15);
                ball.x = pl.x + pl.w / 2 + half;
            }
        }
        if (ball.vx > 0 && ball.x + half >= pr.x - pr.w / 2 && ball.x + half < pr.x + 0.02) {
            if (Math.abs(ball.y - pr.y) <= pr.h / 2 + half) {
                const off = (ball.y - pr.y) / (pr.h / 2);
                ball.vx = -Math.abs(ball.vx) * 1.02;
                ball.vy += off * 0.5;
                ball.vx = Math.max(ball.vx, -1.15);
                ball.x = pr.x - pr.w / 2 - half;
            }
        }

        if (ball.x < -0.06 || ball.x > 1.06) {
            const dir = ball.x < 0 ? 1 : -1;
            ball.x = 0.5;
            ball.y = 0.3 + Math.random() * 0.4;
            const ang = (Math.random() - 0.5) * 0.9;
            const sp  = 0.55;
            ball.vx = Math.cos(ang) * sp * dir;
            ball.vy = Math.sin(ang) * sp;
        }

        const kL = ball.vx < 0 ? 5.5 : 1.4;
        const kR = ball.vx > 0 ? 5.5 : 1.4;
        const targL = ball.vx < 0 ? ball.y : 0.5;
        const targR = ball.vx > 0 ? ball.y : 0.5;

        pl.y += (targL - pl.y) * Math.min(1, dt * kL);
        pr.y += (targR - pr.y) * Math.min(1, dt * kR);
        pl.y = Math.max(pl.h / 2, Math.min(1 - pl.h / 2, pl.y));
        pr.y = Math.max(pr.h / 2, Math.min(1 - pr.h / 2, pr.y));
    }

    _draw() {
        const ctx = this.ctx;
        const W = this.w, H = this.h;
        if (W <= 0 || H <= 0) return;

        const [r, g, b] = (typeof getAccentRGB === 'function') ? getAccentRGB() : [254, 23, 67];

        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#0A0A0A';
        ctx.fillRect(0, 0, W, H);

        const cell = Math.max(7, Math.floor(W / 14));
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.08)`;
        for (let y = cell / 2; y < H; y += cell) {
            for (let x = cell / 2; x < W; x += cell) {
                ctx.fillRect(x - 1, y - 1, 2, 2);
            }
        }

        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.14)`;
        ctx.setLineDash([3, 5]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(W / 2, 0);
        ctx.lineTo(W / 2, H);
        ctx.stroke();
        ctx.setLineDash([]);

        const pl = this.paddleLeft;
        const pr = this.paddleRight;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
        ctx.fillRect(pl.x * W - (pl.w * W) / 2, (pl.y - pl.h / 2) * H, pl.w * W, pl.h * H);
        ctx.fillRect(pr.x * W - (pr.w * W) / 2, (pr.y - pr.h / 2) * H, pr.w * W, pr.h * H);

        // мяч — квадратик с glow
        const bx = this.ball.x * W;
        const by = this.ball.y * H;
        const bs = this.ball.size * Math.min(W, H);

        const grad = ctx.createRadialGradient(bx, by, 0, bx, by, bs * 2.6);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.45)`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(bx - bs * 2.6, by - bs * 2.6, bs * 5.2, bs * 5.2);

        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(bx - bs / 2, by - bs / 2, bs, bs);
    }
}

function updateEmptyState() {
    if (!audioEngine) return;
    const isEmpty = audioEngine.playlist.length === 0;

    const stage = document.getElementById('stageColumn');
    if (stage) stage.classList.toggle('is-empty', isEmpty);

    const cover = document.getElementById('playerCover');
    if (cover) cover.classList.toggle('is-empty', isEmpty);

    if (isEmpty) {
        EmptyGreeting.start();
        if (window.coverPingPong) window.coverPingPong.start();
    } else {
        EmptyGreeting.stop();
        if (window.coverPingPong) window.coverPingPong.stop();
    }
}
window.updateEmptyState = updateEmptyState;

function setupWindowControls() {
    const api = window.electronAPI;
    if (!api) return;

    const btnMin    = document.getElementById('wcMin');
    const btnMax    = document.getElementById('wcMax');
    const btnClose  = document.getElementById('wcClose');
    const iconMax     = btnMax?.querySelector('.wc-icon-max');
    const iconRestore = btnMax?.querySelector('.wc-icon-restore');

    if (btnMin)   btnMin.addEventListener('click',   () => api.minimize());
    if (btnMax)   btnMax.addEventListener('click',   () => api.maximize());
    if (btnClose) btnClose.addEventListener('click', () => api.close());

    // синхронизация иконки maximize/restore
    const applyMaxState = (isMax) => {
        if (!iconMax || !iconRestore) return;
        iconMax.style.display     = isMax ? 'none' : '';
        iconRestore.style.display = isMax ? '' : 'none';
        if (btnMax) btnMax.title = isMax ? 'Восстановить' : 'Развернуть';
        document.body.classList.toggle('is-maximized', !!isMax);
    };

    if (typeof api.isMaximized === 'function') {
        api.isMaximized().then(applyMaxState).catch(() => {});
    }
    if (typeof api.onMaximizeChange === 'function') {
        api.onMaximizeChange((v) => applyMaxState(!!v));
    }
}
window.setupWindowControls = setupWindowControls;

function setupTrayIntegration() {
    const api = window.electronAPI;
    if (!api || !api.tray) return;

    const section = document.getElementById('traySettingsSection');
    if (section) section.hidden = false;

    api.tray.onAction((action) => {
        if (!audioEngine) return;
        if (action === 'toggle')      audioEngine.togglePlay();
        else if (action === 'prev')   audioEngine.prev();
        else if (action === 'next')   audioEngine.next();
    });

    const pushTrayState = () => {
        const track = audioEngine?.playlist?.[audioEngine.currentIndex];
        api.tray.update({
            track: track ? { title: track.title, artist: track.artist } : null,
            isPlaying: !!audioEngine?.isPlaying,
        });
    };

    const prevPlay  = audioEngine.onPlay;
    const prevPause = audioEngine.onPause;
    const prevTrack = audioEngine.onTrackChange;

    audioEngine.onPlay = () => { if (typeof prevPlay === 'function') prevPlay(); pushTrayState(); };
    audioEngine.onPause = () => { if (typeof prevPause === 'function') prevPause(); pushTrayState(); };
    audioEngine.onTrackChange = (t) => { if (typeof prevTrack === 'function') prevTrack(t); pushTrayState(); };

    setTimeout(pushTrayState, 400);

    api.tray.getClosePreference().then(pref => {
        const ask = document.getElementById('askOnCloseToggle');
        const pt  = document.getElementById('preferTrayToggle');
        if (ask) ask.checked = pref.askOnClose;
        if (pt)  pt.checked  = pref.preferTray;
    }).catch(() => {});

    const savePref = () => {
        const ask = document.getElementById('askOnCloseToggle');
        const pt  = document.getElementById('preferTrayToggle');
        api.tray.setClosePreference({
            askOnClose: ask ? ask.checked : true,
            preferTray: pt  ? pt.checked  : false,
        });
    };

    document.getElementById('askOnCloseToggle')?.addEventListener('change', savePref);
    document.getElementById('preferTrayToggle')?.addEventListener('change', savePref);
}
window.setupTrayIntegration = setupTrayIntegration;

function setupGlobalShortcuts() {
    const api = window.electronAPI;
    if (!api || !api.global) return;

    api.global.onAction((action) => {
        if (!audioEngine) return;

        if (action === 'toggle') {
            audioEngine.togglePlay();
            showTrackOverlay(audioEngine.isPlaying ? 'Играет' : 'Пауза');
        } else if (action === 'next') {
            audioEngine.next();
        } else if (action === 'prev') {
            audioEngine.prev();
        } else if (action === 'stop') {
            audioEngine.pause();
            audioEngine.audio.currentTime = 0;
        } else if (action === 'vol-up') {
            const v = Math.min(100, Math.round((audioEngine.volume || 0) * 100) + 5);
            audioEngine.setVolume(v);
        } else if (action === 'vol-down') {
            const v = Math.max(0, Math.round((audioEngine.volume || 0) * 100) - 5);
            audioEngine.setVolume(v);
        }
    });
}
window.setupGlobalShortcuts = setupGlobalShortcuts;

const FONT_FAMILIES = {
    'space-grotesk': "'Space Grotesk', -apple-system, sans-serif",
    'inter':         "'Inter', -apple-system, sans-serif",
    'unbounded':     "'Unbounded', sans-serif",
    'jetbrains':     "'JetBrains Mono', monospace",
    'playfair':      "'Playfair Display', serif",
    'bebas':         "'Bebas Neue', sans-serif",
    'system':        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
};

function applyFontFamily(key) {
    const css = FONT_FAMILIES[key] || FONT_FAMILIES['space-grotesk'];
    document.documentElement.style.setProperty('--font-ui', css);
    localStorage.setItem('fontFamily', key);
}

function applyFontThin(thin) {
    document.body.classList.toggle('font-thin', !!thin);
    localStorage.setItem('fontThin', thin ? '1' : '0');
}

function loadFontSettings() {
    const savedFamily = localStorage.getItem('fontFamily') || 'space-grotesk';
    const savedThin   = localStorage.getItem('fontThin') === '1';

    applyFontFamily(savedFamily);
    applyFontThin(savedThin);

    const sel = document.getElementById('fontFamilySelect');
    if (sel) sel.value = savedFamily;

    const tog = document.getElementById('fontThinToggle');
    if (tog) tog.checked = savedThin;
}

function setupFontSettings() {
    loadFontSettings();

    document.getElementById('fontFamilySelect')?.addEventListener('change', (e) => {
        applyFontFamily(e.target.value);
        saveSettings();
    });

    document.getElementById('fontThinToggle')?.addEventListener('change', (e) => {
        applyFontThin(e.target.checked);
        saveSettings();
        showNotification(e.target.checked ? 'Тонкий шрифт' : 'Обычный шрифт');
    });
}
window.setupFontSettings = setupFontSettings;

function showTrackOverlay(label) {
    const api = window.electronAPI;
    if (!api || !api.overlay) return;
    if (!audioEngine) return;

    const track = audioEngine.playlist[audioEngine.currentIndex];
    if (!track) return;

    const coverUrl = audioEngine.ensureCoverUrl(track) || null;
    const audio = audioEngine.audio;

    api.overlay.show({
        title:     track.title || '—',
        artist:    track.artist || '—',
        coverUrl,
        label:     label || 'Играет сейчас',
        duration:  audio.duration || 0,
        startTime: audio.currentTime || 0,
        startedAt: Date.now(),
    });
}
window.showTrackOverlay = showTrackOverlay;


async function init() {
    registrationSystem = new RegistrationSystem();
    window.trackStorage = new TrackStorage();
    audioEngine = new AudioEngine();
    audioEngine.setStorage(window.trackStorage);
    playlistManager    = new PlaylistManager();
    window.backupSystem = new BackupSystem(audioEngine, playlistManager);
    fileUploadSystem   = new FileUploadSystem(audioEngine);
    visualizer         = new Visualizer(audioEngine);
    backgroundSystem   = new BackgroundSystem();
    backgroundSystem.setAudioEngine(audioEngine);
    window.trackQueue  = new TrackQueue(audioEngine);
    contextMenu        = new ContextMenu(audioEngine, playlistManager);

    audioEngine.onPlay = () => {
        if (!isEcoMode) visualizer.start();
        if (window.trackQueue) window.trackQueue.update();

        const track = audioEngine.playlist[audioEngine.currentIndex];
        if (track) {
            track.lastPlayedAt = Date.now();
            if (audioEngine.storage) {
                audioEngine.storage.updateMetadata(track).catch(() => {});
            }
            renderSidebarRecent();
            renderSidebarStats();
        }
    };

    audioEngine.onPlayCounted = () => {
        renderSidebarRecent();
        renderSidebarStats();
        buildTop100();
        buildChartPlaylists();
        if (document.getElementById('page-profile')?.classList.contains('active')) {
            renderProfile();
        }

        if (typeof updateLibraryCounters === 'function') {
            updateLibraryCounters();
        }

        if (window.RecentTileBg) window.RecentTileBg.refresh();
    };

    audioEngine.onPause = () => {
        visualizer.stop();
    };

    audioEngine.onTrackChange = (track) => {
        refreshCoverAppearance(track);
        updateStageCover(track);
        const modal = document.getElementById('lyricsModal');
        if (modal && modal.classList.contains('active')) {
            openLyrics(audioEngine.currentIndex, { isRefresh: true });
        }
        setTimeout(() => {
            if (window.electronAPI?.overlay) {
                showTrackOverlay('Играет сейчас');
            }
        }, 250);
    };

    window.miniPlayer = new MiniPlayer(audioEngine);
    window.miniViz = new MiniViz(audioEngine);
    window.coverPingPong = new CoverPingPong();

    let _coverRerenderTimer = null;
    audioEngine.onCoverLoaded = (track) => {
        if (audioEngine.playlist[audioEngine.currentIndex] === track) {
            audioEngine._updatePlayerCover(track);
            refreshCoverAppearance(track);
        }

        clearTimeout(_coverRerenderTimer);
        _coverRerenderTimer = setTimeout(() => {
            if (fileUploadSystem) fileUploadSystem.updateTrackListUI();
            if (window.trackQueue) window.trackQueue.render();
        }, 120);
        
        if (typeof updateLibraryCounters === 'function') {
            updateLibraryCounters();
        }

    };

    window.audioEngine       = audioEngine;
    window.playlistManager   = playlistManager;
    window.fileUploadSystem  = fileUploadSystem;
    window.contextMenu       = contextMenu;
    window.matchMedia('(prefers-reduced-motion: reduce)')
        .addEventListener('change', respectReducedMotion);
    window.equalizerUI = new EqualizerUI(audioEngine);
    loadEcoState();
    const savedPreset = localStorage.getItem('colorPreset') || 'crimson';
    applyColorPreset(savedPreset);
    window.backgroundManager = new BackgroundManager(audioEngine);

    renderColorSwatches();
    buildChartPlaylists();
    buildTop100();
    buildPlaylistsModal();
    loadSettings();
    setupEvents();
    setupFontSettings();
    updateCacheSize();
    setupCardTilt();
    setupCustomCursor();
    window.tipPanel = new TipPanel();
    window.LyricsScene = LyricsScene;
    LyricsScene.init();
    audioEngine.updateVolumeUI();

    if (window.electronAPI?.music?.soundcloud) {
        window.musicServices = new window.MusicServices(audioEngine);
    }
 
    if (window.electronAPI?.isElectron) {
        setupTrayIntegration();
        setupGlobalShortcuts();
    }

    const _bootSettings = JSON.parse(localStorage.getItem('settings') || '{}');
    if (!_bootSettings.disableBg) {
        backgroundSystem.start();
    }

    setTimeout(() => {
        if (isEcoMode) return;
        const g = ensureGlobe();
        if (g) {
            g.onRegionSelect = (regionIdx) => openRegionPage(regionIdx);
        }
        g.resize();
        g.start();
    }, 300);

    let restored = 0;

    try {
        restored = await audioEngine.restoreFromStorage();
    } catch (e) {
        console.warn('Восстановление треков не удалось:', e);
    }

    fileUploadSystem.updateTrackListUI();
    if (window.trackQueue) window.trackQueue.render();

    buildChartPlaylists();
    _syncProfileAvatarInUI()
    buildTop100();

    updateEmptyState();

    if (typeof updateLibraryCounters === 'function') {
        updateLibraryCounters();
    }

    if (restored > 0) {
        showNotification(`Загружено треков из хранилища: ${restored}`);
    }

    if (typeof positionBottomNav === 'function') {
        setTimeout(positionBottomNav, 200);
    }

    const bufferEl = document.getElementById('progressBuffer');
    let lastBufferPct = 0;


    let _rafActive = false;
    let _lastProgressUpdate = 0;

    const tickProgress = () => {
        const a = audioEngine.audio;
        const cur = a.currentTime;
        const dur = a.duration || 0;

        const pct = dur > 0 ? (cur / dur) * 100 : 0;
        document.getElementById('progressFill').style.width = pct + '%';

        if (dur > 0 && bufferEl) {
            let bufEnd = 0;
            try {
                if (a.buffered.length > 0) {
                    bufEnd = a.buffered.end(a.buffered.length - 1);
                }
            } catch (e) {}

            const bufPct = bufEnd > 0 ? Math.min(100, (bufEnd / dur) * 100) : 0;
            if (bufPct > lastBufferPct) {
                lastBufferPct = bufPct;
                bufferEl.style.width = bufPct + '%';
            }
        }

        document.getElementById('currentTime').textContent =
            audioEngine.formatTime(cur);
        if (dur > 0) {
            document.getElementById('totalTime').textContent =
                audioEngine.formatTime(dur);
        }
    };

    const smoothLoop = (timestamp) => {
        if (!audioEngine.isPlaying) {
            _rafActive = false;
            return;
        }
        _rafActive = true;

        const threshold = isEcoMode ? 33.33 : 16.66;
        if (timestamp - _lastProgressUpdate >= threshold) {
            _lastProgressUpdate = timestamp;
            tickProgress();
        }
        requestAnimationFrame(smoothLoop);
    };

    audioEngine.audio.addEventListener('play', () => {
        if (!_rafActive) {
            _lastProgressUpdate = 0;
            requestAnimationFrame(smoothLoop);
        }
    });

    audioEngine.audio.addEventListener('loadedmetadata', () => {
        lastBufferPct = 0;
        if (bufferEl) bufferEl.style.width = '0%';
    });

    audioEngine.audio.addEventListener('timeupdate', () => {
        if (!_rafActive) tickProgress();
    });
}

async function updateCacheSize() {
    if (!window.trackStorage) return;
    const est = await window.trackStorage.estimateSize();
    const el = document.getElementById('cacheSize');
    if (!el) return;
    if (est && est.usage) {
        el.textContent = formatBytes(est.usage);
    } else {
        el.textContent = '0 МБ';
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
}

function _relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'только что';
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} дн`;
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function renderSidebarRecent() {
    const wrap = document.getElementById('sidebarRecent');
    if (!wrap || !audioEngine) return;

    const items = audioEngine.playlist
        .filter(t => t.lastPlayedAt)
        .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
        .slice(0, 5);

    if (items.length === 0) {
        wrap.innerHTML = `<div class="sidebar-empty">Ещё ничего<br>не слушали</div>`;
        return;
    }

    wrap.innerHTML = '';
    items.forEach(track => {
        const row = document.createElement('div');
        row.className = 'sidebar-recent-item';
        const url = audioEngine.ensureCoverUrl(track);
        const coverStyle = url ? `style="background-image:url('${url}')"` : '';
        const coverClass = url ? 'sidebar-recent-cover has-image' : 'sidebar-recent-cover';

        row.innerHTML = `
            <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
            <div class="sidebar-recent-info">
                <div class="sidebar-recent-title">${escapeHtml(track.title)}</div>
                <div class="sidebar-recent-artist">${escapeHtml(track.artist)}</div>
            </div>
            <div class="sidebar-recent-time">${_relativeTime(track.lastPlayedAt)}</div>
        `;

        row.addEventListener('click', () => {
            const idx = audioEngine.playlist.indexOf(track);
            if (idx < 0) return;
            audioEngine.currentIndex = idx;
            audioEngine.loadCurrentTrack();
            audioEngine.play();
        });

        wrap.appendChild(row);
    });
}

function renderSidebarStats() {
    const wrap = document.getElementById('sidebarStats');
    if (!wrap || !audioEngine) return;

    const list = audioEngine.playlist;

    let totalSeconds = 0;
    let totalPlays   = 0;
    const artists = new Set();

    list.forEach(t => {
        const plays = t.playCount || 0;
        totalPlays += plays;
        if (t.duration) totalSeconds += t.duration * plays;
        if (t.artist && t.artist !== 'Неизвестный исполнитель') artists.add(t.artist);
    });

    const hours   = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const timeStr = hours > 0 ? `${hours}ч ${minutes}м` : `${minutes}м`;

    wrap.innerHTML = `
        <div class="sidebar-stat">
            <div class="sidebar-stat-value">${timeStr}</div>
            <div class="sidebar-stat-label">Прослушано</div>
        </div>
        <div class="sidebar-stat">
            <div class="sidebar-stat-value">${list.length}</div>
            <div class="sidebar-stat-label">Треков</div>
        </div>
        <div class="sidebar-stat">
            <div class="sidebar-stat-value">${artists.size}</div>
            <div class="sidebar-stat-label">Артистов</div>
        </div>
        <div class="sidebar-stat">
            <div class="sidebar-stat-value">${totalPlays}</div>
            <div class="sidebar-stat-label">Запусков</div>
        </div>
    `;
}

function renderSidebarPlaylists() {
    const wrap = document.getElementById('sidebarPlaylists');
    const countEl = document.getElementById('sidebarPlaylistsCount');
    if (!wrap || !window.playlistManager) return;

    const playlists = window.playlistManager.getAllPlaylists();

    if (countEl) {
        countEl.textContent = playlists.length > 0 ? String(playlists.length) : '';
    }

    if (playlists.length === 0) {
        wrap.innerHTML = `<div class="sidebar-empty">Плейлистов<br>пока нет</div>`;
        return;
    }

    wrap.innerHTML = '';
    playlists.slice(0, 8).forEach(pl => {
        const row = document.createElement('div');
        row.className = 'sidebar-playlist-item';
        row.innerHTML = `
            <div class="sidebar-playlist-icon">🎵</div>
            <div class="sidebar-playlist-info">
                <div class="sidebar-playlist-name">${escapeHtml(pl.name)}</div>
                <div class="sidebar-playlist-count">${pl.tracks.length} ${pluralTracks(pl.tracks.length)}</div>
            </div>
        `;
        row.addEventListener('click', () => {
            if (typeof window.playPlaylist === 'function') {
                window.playPlaylist(pl);
            }
        });
        wrap.appendChild(row);
    });
}

function renderSidebarAll() {
    renderSidebarRecent();
    renderSidebarStats();
    renderSidebarPlaylists();
}
window.renderSidebarAll = renderSidebarAll;
window.renderSidebarPlaylists = renderSidebarPlaylists;

function applyNavLayout(layout) {
    const mode = (layout === 'alt') ? 'alt' : 'classic';
    document.body.classList.toggle('nav-layout-alt', mode === 'alt');
    localStorage.setItem('navLayout', mode);

    document.querySelectorAll('#navLayoutRadio .radio-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === mode);
    });
}
window.applyNavLayout = applyNavLayout;

function applyNavMode(mode) {
    const m = (mode === 'mbox') ? 'mbox' : 'classic';
    document.body.classList.toggle('nav-mode-mbox', m === 'mbox');
    localStorage.setItem('navMode', m);

    document.querySelectorAll('#navModeRadio .radio-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === m);
    });

    const nav = document.getElementById('bottomNav');
    if (nav) {
        if (m === 'mbox') {
            nav.removeAttribute('inert');
        } else {
            nav.classList.remove('visible');
            nav.setAttribute('inert', '');
        }
    }

    if (window.globeView) {
        setTimeout(() => {
            try { window.globeView.resize(); } catch (e) {}
        }, 120);
    }
    if (typeof positionBottomNav === 'function') {
        setTimeout(positionBottomNav, 150);
    }
}
window.applyNavMode = applyNavMode;

function positionBottomNav() {
    const nav = document.getElementById('bottomNav');
    if (!nav) return;

    const stage = document.getElementById('stageColumn');
    const homePage = document.getElementById('page-home');

    if (stage && homePage && homePage.classList.contains('active')) {
        const r = stage.getBoundingClientRect();
        if (r.width > 0) {
            nav.style.left = (r.left + r.width / 2) + 'px';
            return;
        }
    }

    nav.style.left = '50%';
}
window.positionBottomNav = positionBottomNav;

function setupLibraryDrawer() {
    const drawer  = document.getElementById('libraryDrawer');
    const overlay = document.getElementById('libraryOverlay');
    const closeBtn = document.getElementById('libraryDrawerClose');
    const uploadBtn = document.getElementById('libraryUploadBtn');
    if (!drawer) return;

    const open = () => {
        setDrawerOrigin(drawer, '#rightNav .rn-btn[data-page="library"]');

        if (document.body.classList.contains('settings-open')) {
            window.closeSettingsDrawer?.();
        }
        drawer.classList.add('open');
        overlay?.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        overlay?.setAttribute('aria-hidden', 'false');
        document.body.classList.add('library-open');
        switchLibraryView('home');
        updateLibraryCounters();
        renderLibraryMarquee();
    };
    const close = () => {
        drawer.classList.remove('open');
        overlay?.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        overlay?.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('library-open');
    };
    const isOpen = () => drawer.classList.contains('open');

    closeBtn?.addEventListener('click', close);
    overlay?.addEventListener('click', close);

    uploadBtn?.addEventListener('click', () => {
        document.getElementById('uploadBtnHeader')?.click();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) {
            e.stopPropagation();
            close();
        }
    });

    const switchLibraryView = (view) => {
        drawer.querySelectorAll('.library-view').forEach(v => {
            v.classList.toggle('is-active', v.dataset.view === view);
        });
        drawer.dataset.currentView = view;
        const titleEl = document.getElementById('libraryDrawerTitle');
        const titles = { home: 'Библиотека', artists: 'Артисты', recent: 'Последнее добавленное', tracks: 'Все треки' };
        if (titleEl) titleEl.textContent = titles[view] || 'Библиотека';

        if (view === 'artists') renderLibraryArtists();
        if (view === 'tracks')  {
            renderLibraryMarquee();
            const viewEl = drawer.querySelector('.library-view[data-view="tracks"]');
            if (viewEl && viewEl.dataset.mode === 'list') {
                renderLibraryTracksList();
            }
        }
    };

    drawer.querySelectorAll('[data-open]').forEach(btn => {
        btn.addEventListener('click', () => switchLibraryView(btn.dataset.open));
    });
    drawer.querySelectorAll('[data-back]').forEach(btn => {
        btn.addEventListener('click', () => switchLibraryView('home'));
    });

    document.getElementById('libraryNewPlaylistBtn')?.addEventListener('click', async () => {
        const name = await window.askPrompt('Название нового плейлиста:', 'Мой плейлист');
        if (!name) return;
        window.playlistManager?.createPlaylist(name);
        renderLibraryPlaylists();
        updatePlaylistCounters();
        showNotification(`Плейлист «${name}» создан`);
    });

        if (window.RecentTileBg) window.RecentTileBg.init();
        setupLibraryViewSwitch();

        window.openLibraryDrawer  = open;
        window.closeLibraryDrawer = close;
        window.isLibraryDrawerOpen = isOpen;
}
window.setupLibraryDrawer = setupLibraryDrawer;

function updateLibraryCounters() {
    const list = window.audioEngine?.playlist || [];

    const artists = new Set();
    list.forEach(t => { if (t.artist && t.artist !== 'Неизвестный исполнитель') artists.add(t.artist); });

    const el1 = document.getElementById('libraryArtistsCount');
    if (el1) el1.textContent = `${artists.size} ${pluralArtist(artists.size)}`;

    const el2 = document.getElementById('libraryRecentCount');
    if (el2) el2.textContent = `${Math.min(list.length, 20)} ${pluralTracks(Math.min(list.length, 20))}`;

    const el3 = document.getElementById('libraryTracksCount');
    if (el3) el3.textContent = `${list.length} ${pluralTracks(list.length)}`;

    const el4 = document.getElementById('libraryTracksListCount');
    if (el4) el4.textContent = list.length > 0
        ? `${list.length} ${pluralTracks(list.length)}`
        : '';

    if (document.getElementById('libraryTracksList') &&
        !document.getElementById('libraryTracksList').hidden) {
        renderLibraryTracksList();
    }

    renderLibraryPlaylists();

    const drawer = document.getElementById('libraryDrawer');
    if (drawer && drawer.dataset.currentView === 'tracks') {
        renderLibraryMarquee();
    }

    if (window.RecentTileBg) window.RecentTileBg.refresh();
}

function pluralArtist(n) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'артист';
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'артиста';
    return 'артистов';
}

function renderLibraryPlaylists() {
    const wrap = document.getElementById('libraryPlaylists');
    if (!wrap || !window.playlistManager) return;

    const playlists = window.playlistManager.getAllPlaylists();
    wrap.innerHTML = '';

    if (playlists.length === 0) {
        wrap.innerHTML = `<div class="library-playlists-empty">Плейлистов пока нет</div>`;
        return;
    }

    playlists.forEach(pl => {
        const row = document.createElement('div');
        row.className = 'library-playlist-item';
        row.innerHTML = `
            <div class="library-playlist-icon">🎵</div>
            <div class="library-playlist-info">
                <div class="library-playlist-name">${escapeHtml(pl.name)}</div>
                <div class="library-playlist-count">${pl.tracks.length} ${pluralTracks(pl.tracks.length)}</div>
            </div>
            <button class="library-playlist-del" type="button"
                    title="Удалить плейлист" aria-label="Удалить плейлист">
                <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
        `;

        row.addEventListener('click', (e) => {
            if (e.target.closest('.library-playlist-del')) return;
            window.playPlaylist?.(pl);
            window.closeLibraryDrawer?.();
        });

        row.querySelector('.library-playlist-del').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!confirm(`Удалить плейлист «${pl.name}»?`)) return;
            window.playlistManager.deletePlaylist(pl.id);
            renderLibraryPlaylists();
            updatePlaylistCounters();
            if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();
            showNotification(`Плейлист «${pl.name}» удалён`);
        });

        wrap.appendChild(row);
    });
}

function _sortLibraryTracks(list) {
    const sort = localStorage.getItem('librarySort') || 'date-desc';

    const indexed = list.map((track, originalIndex) => ({ track, originalIndex }));

    const cmp = {
        'date-desc':     (a, b) => (b.track.createdAt || 0) - (a.track.createdAt || 0),
        'date-asc':      (a, b) => (a.track.createdAt || 0) - (b.track.createdAt || 0),
        'title-asc':     (a, b) => String(a.track.title || '').localeCompare(String(b.track.title || ''), 'ru'),
        'title-desc':    (a, b) => String(b.track.title || '').localeCompare(String(a.track.title || ''), 'ru'),
        'artist-asc':    (a, b) => String(a.track.artist || '').localeCompare(String(b.track.artist || ''), 'ru'),
        'artist-desc':   (a, b) => String(b.track.artist || '').localeCompare(String(a.track.artist || ''), 'ru'),
        'duration-desc': (a, b) => (b.track.duration || 0) - (a.track.duration || 0),
        'duration-asc':  (a, b) => (a.track.duration || 0) - (b.track.duration || 0)
    }[sort] || ((a, b) => 0);

    return indexed.slice().sort(cmp);
}

function renderLibraryTracksList() {
    const wrap = document.getElementById('libraryTracksList');
    const countEl = document.getElementById('libraryTracksListCount');
    if (!wrap || !window.audioEngine) return;

    const list = window.audioEngine.playlist;

    if (countEl) {
        countEl.textContent = list.length > 0
            ? `${list.length} ${pluralTracks(list.length)}`
            : '';
    }

    wrap.innerHTML = '';

    if (list.length === 0) {
        wrap.innerHTML = `<div class="library-marquee-empty">Треков пока нет</div>`;
        return;
    }

    const sorted = _sortLibraryTracks(list);
    
    const isSelMode = window.fileUploadSystem?._selectionMode || false;
    const selSet = window.fileUploadSystem?._selected || new Set();

    sorted.forEach(({ track, originalIndex: idx }, rowIdx) => {
        const row = document.createElement('div');
        row.className = 'track-list-item glass';
        row.style.setProperty('--i', Math.min(rowIdx, 20));

        if (isSelMode) row.classList.add('selection-mode');
        if (isSelMode && selSet.has(track.id)) row.classList.add('selected');

        const coverUrl = window.audioEngine.ensureCoverUrl(track);
        const coverStyle = coverUrl
            ? `style="background-image:url('${coverUrl}');background-size:cover;background-position:center"`
            : '';
        const coverClass = coverUrl ? 'track-list-item-cover has-image' : 'track-list-item-cover';
        const dur = track.duration ? window.audioEngine.formatTime(track.duration) : '';

        row.innerHTML = `
            <div class="select-checkbox"></div>
            <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
            <div class="track-list-item-main">
                <div class="track-list-item-title">${escapeHtml(track.title)}</div>
                <div class="track-list-item-artist">${escapeHtml(track.artist)}</div>
            </div>
            <div class="track-list-item-right">
                ${dur ? `<span class="track-list-item-dur">${dur}</span>` : ''}
                <span class="track-list-item-play">▶</span>
            </div>
        `;

        row.addEventListener('click', (e) => {
            if (window.fileUploadSystem) {
                if (window.fileUploadSystem._selectionMode) {
                    window.fileUploadSystem.toggleSelect(track.id, e.shiftKey);
                    return;
                }
                
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    window.fileUploadSystem.enterSelectionMode(track.id);
                    return;
                }
            }

            window.audioEngine.currentIndex = idx;
            window.audioEngine.loadCurrentTrack();
            window.audioEngine.play();
        });

        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (window.fileUploadSystem?._selectionMode) {
                window.fileUploadSystem.toggleSelect(track.id, e.shiftKey);
                return;
            }
            if (window.contextMenu) {
                window.contextMenu.show(e.clientX, e.clientY, idx);
            }
        });

        wrap.appendChild(row);
    });
}
window.renderLibraryTracksList = renderLibraryTracksList;

function setupLibraryViewSwitch() {
    const wrap    = document.getElementById('libraryViewSwitch');
    const viewEl  = document.querySelector('.library-view[data-view="tracks"]');
    const marquee = document.getElementById('libraryMarqueeFull');
    const list    = document.getElementById('libraryTracksList');
    if (!wrap || !viewEl || !marquee || !list) return;

    let mode = localStorage.getItem('libraryTracksView') || 'marquee';
    if (mode !== 'marquee' && mode !== 'list') mode = 'marquee';

    const apply = () => {
        viewEl.dataset.mode = mode;
        wrap.querySelectorAll('.library-view-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.view === mode);
        });
        marquee.hidden = (mode !== 'marquee');
        list.hidden    = (mode !== 'list');
        if (mode === 'list') renderLibraryTracksList();
        localStorage.setItem('libraryTracksView', mode);
    };

        wrap.querySelectorAll('.library-view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.view === mode) return;
                mode = btn.dataset.view;
                apply();
            });
        });

        const sortSel = document.getElementById('librarySort');
        if (sortSel) {
            const saved = localStorage.getItem('librarySort');
            if (saved) sortSel.value = saved;

            sortSel.addEventListener('change', (e) => {
                localStorage.setItem('librarySort', e.target.value);
                if (mode === 'list') renderLibraryTracksList();
            });
        }

        apply();
}
window.setupLibraryViewSwitch = setupLibraryViewSwitch;

const RecentTileBg = {
    timer: null,
    layers: [],
    activeIdx: 0,
    queue: [],
    queueIdx: 0,
    _lastLen: -1,

    init() {
        const tile = document.querySelector('.library-tile-recent');
        if (!tile) return;
        this.layers = Array.from(tile.querySelectorAll('.library-tile-bg'));
        if (this.layers.length < 2) return;
        this._tile = tile;
        this.refresh(true);
    },

    refresh(force = false) {
        if (!this.layers.length) return;

        const list = window.audioEngine?.playlist || [];

        if (!force && list.length === this._lastLen && this.queue.length > 0) return;
        this._lastLen = list.length;

        this._buildQueue();

        if (this.queue.length === 0) {
            this.stop();
            this.layers.forEach(l => (l.style.opacity = '0'));
            this._tile?.classList.remove('has-bg');
            return;
        }

        this._tile?.classList.add('has-bg');
        this.queueIdx = 0;
        this._showNext(true);
        this.start();
    },

    _buildQueue() {
        const list = window.audioEngine?.playlist || [];
        const recent = list
            .filter(t => window.audioEngine.ensureCoverUrl(t))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, 20);

        for (let i = recent.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [recent[i], recent[j]] = [recent[j], recent[i]];
        }
        this.queue = recent;
    },

    _showNext(instant = false) {
        if (this.queue.length === 0) return;

        const track = this.queue[this.queueIdx % this.queue.length];
        this.queueIdx++;

        const url = window.audioEngine.ensureCoverUrl(track);
        if (!url) return;

        const active = this.layers[this.activeIdx];
        const idle   = this.layers[1 - this.activeIdx];

        idle.style.backgroundImage = `url("${url}")`;

        if (instant) {
            idle.style.transition = 'none';
            active.style.opacity = '0';
            idle.style.opacity = '1';
            requestAnimationFrame(() => {
                idle.style.transition = '';
            });
        } else {
            active.style.opacity = '0';
            idle.style.opacity = '1';
        }

        this.activeIdx = 1 - this.activeIdx;
    },

    start() {
        this.stop();
        this.timer = setInterval(() => this._showNext(), 3000);
    },

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    },
};

window.RecentTileBg = RecentTileBg;

function renderLibraryMarquee() {
    const previewWrap = document.getElementById('libraryMarqueePreview');
    const fullWrap    = document.getElementById('libraryMarqueeFull');
    const tracks      = window.audioEngine?.playlist || [];

    if (tracks.length === 0) {
        [previewWrap, fullWrap].forEach(wrap => {
            if (wrap) wrap.innerHTML =
                `<div class="library-marquee-empty">Треков пока нет</div>`;
        });
        return;
    }

    const pool = [...tracks];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const MIN_PER_ROW = 20;
    const ROWS = 3;

    const fillRows = (prefix) => {
        for (let rowIdx = 0; rowIdx < ROWS; rowIdx++) {
            const rowEl = document.getElementById(prefix + (rowIdx + 1));
            if (!rowEl) continue;

            const rowTracks = [];
            for (let i = 0; i < MIN_PER_ROW; i++) {
                rowTracks.push(pool[(i * ROWS + rowIdx) % pool.length]);
            }

            rowEl.innerHTML = '';
            rowTracks.forEach(t => rowEl.appendChild(createMarqueeCard(t)));
            rowTracks.forEach(t => rowEl.appendChild(createMarqueeCard(t)));
        }
    };

    fillRows('marqueePreviewRow');
    fillRows('marqueeFullRow');
}

function createMarqueeCard(track) {
    const card = document.createElement('div');
    card.className = 'library-marquee-card';

    const url = window.audioEngine?.ensureCoverUrl(track);
    const coverStyle = url ? `style="background-image:url('${url}')"` : '';
    const coverClass = url ? 'library-marquee-cover has-image' : 'library-marquee-cover';

    card.innerHTML = `
        <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
        <div class="library-marquee-title">${escapeHtml(track.title)}</div>
        <div class="library-marquee-artist">${escapeHtml(track.artist)}</div>
    `;

    card.addEventListener('click', () => {
        const idx = window.audioEngine.playlist.indexOf(track);
        if (idx < 0) return;
        window.audioEngine.currentIndex = idx;
        window.audioEngine.loadCurrentTrack();
        window.audioEngine.play();
    });

    return card;
}

function renderLibraryArtists() {
    const wrap = document.getElementById('libraryArtists');
    if (!wrap || !window.audioEngine) return;

    const map = new Map();
    window.audioEngine.playlist.forEach(t => {
        const name = t.artist || 'Неизвестный';
        if (!map.has(name)) map.set(name, 0);
        map.set(name, map.get(name) + 1);
    });

    const list = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'ru'));

    if (list.length === 0) {
        wrap.innerHTML = `<div class="library-playlists-empty">Артистов пока нет</div>`;
        return;
    }

    wrap.innerHTML = '';
    list.forEach(([name, count]) => {
        const row = document.createElement('div');
        row.className = 'library-artist-item';
        row.innerHTML = `
            <div class="library-artist-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</div>
            <div class="library-artist-info">
                <div class="library-artist-name">${escapeHtml(name)}</div>
                <div class="library-artist-meta">${count} ${pluralTracks(count)}</div>
            </div>
        `;
        row.addEventListener('click', () => {
            if (typeof openArtistPage === 'function') openArtistPage(name);
            window.closeLibraryDrawer?.();
        });
        wrap.appendChild(row);
    });
}

window.updateLibraryCounters = updateLibraryCounters;

function setupRightNav() {
    const nav = document.getElementById('rightNav');
    if (!nav) return;

    nav.querySelectorAll('.rn-btn[data-page]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const page = btn.dataset.page;

            if (page === 'library') {
                if (window.isLibraryDrawerOpen?.()) {
                    window.closeLibraryDrawer?.();
                } else {
                    window.openLibraryDrawer?.();
                }
                return;
            }

            if (page === 'settings') {
                if (document.body.classList.contains('settings-open')) {
                    window.closeSettingsDrawer?.();
                } else {
                    window.openSettingsDrawer?.();
                }
                return;
            }

            const currentPage =
                document.querySelector('.rn-btn[data-page].active')?.dataset.page ||
                document.querySelector('.page.active')?.id?.replace('page-', '') ||
                'home';

            if (currentPage === page) return;

            if (window.miniPlayer) {
                window.miniPlayer.prepareTransition(currentPage, page);
            }

            document.querySelectorAll('.rn-btn[data-page]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const target = document.getElementById('page-' + page);
            setPageOrigin(target, btn);

            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            if (target) target.classList.add('active');
            localStorage.setItem('currentPage', page);

            if (window.miniPlayer) {
                window.miniPlayer.applyTransition(page);
            }

            if (page === 'charts') {
                buildTop100?.();
                buildChartPlaylists?.();
            } else if (page === 'profile') {
                renderProfile?.();
            } else if (page === 'builder') {
                renderBuilderArtists?.();
                renderBuilderQueue?.();
            }
        });
    });

    const syncActive = () => {
        const currentPage = document.querySelector('.page.active')?.id?.replace('page-', '') || 'home';
        nav.querySelectorAll('.rn-btn[data-page]').forEach(b => {
            b.classList.toggle('active', b.dataset.page === currentPage);
        });
    };

    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
        item.addEventListener('click', () => setTimeout(syncActive, 50));
    });

    setTimeout(syncActive, 200);
    window.syncRightNav = syncActive;
}
window.setupRightNav = setupRightNav;

function setPageOrigin(pageEl, btnEl) {
    if (!pageEl) return;
    if (!btnEl) {
        pageEl.style.setProperty('--btn-y', '50%');
        return;
    }
    const btnRect  = btnEl.getBoundingClientRect();
    const topbarH  = 64;
    const pageH    = Math.max(1, window.innerHeight - topbarH);
    const centerY  = btnRect.top + btnRect.height / 2;
    const relY     = Math.max(0, Math.min(100, ((centerY - topbarH) / pageH) * 100));
    pageEl.style.setProperty('--btn-y', relY.toFixed(2) + '%');
}
window.setPageOrigin = setPageOrigin;

function setDrawerOrigin(drawer, buttonSelector) {
    if (!drawer) return;
    const btn = document.querySelector(buttonSelector)
             || document.querySelector('#rightNav .rn-btn[data-page]:not(.active)');
    if (!btn) {
        drawer.style.setProperty('--btn-y', '50%');
        return;
    }

    const btnRect = btn.getBoundingClientRect();
    const btnY = btnRect.top + btnRect.height / 2;

    const drawerTop = 64;
    const drawerH = window.innerHeight - drawerTop;
    const relY = Math.max(0, Math.min(100, ((btnY - drawerTop) / drawerH) * 100));

    drawer.style.setProperty('--btn-y', relY.toFixed(2) + '%');
}
window.setDrawerOrigin = setDrawerOrigin;

function setupSettingsDrawer() {
    const drawer   = document.getElementById('settingsDrawer');
    const overlay  = document.getElementById('settingsOverlay');
    const closeBtn = document.getElementById('settingsDrawerClose');
    if (!drawer) return;

    const open = () => {
        setDrawerOrigin(drawer, '#rightNav .rn-btn[data-page="settings"]');
        drawer.classList.add('open');
        overlay?.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        overlay?.setAttribute('aria-hidden', 'false');
        document.body.classList.add('settings-open');
        setTimeout(() => closeBtn?.focus(), 320);
    };

    const close = () => {
        drawer.classList.remove('open');
        overlay?.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        overlay?.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('settings-open');
    };

    const toggle = () => {
        if (drawer.classList.contains('open')) close();
        else open();
    };

    closeBtn?.addEventListener('click', close);
    overlay?.addEventListener('click', close);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && drawer.classList.contains('open')) {
            e.stopPropagation();
            close();
        }
    });

    window.openSettingsDrawer  = open;
    window.closeSettingsDrawer = close;
}
window.setupSettingsDrawer = setupSettingsDrawer;

function setupBottomNav() {
}
window.setupBottomNav = setupBottomNav;

function moveIndicator() {
    const indicator = document.getElementById('bnIndicator');
    const active = document.querySelector('.bottom-nav .bn-item.active');
    const inner = document.querySelector('.bottom-nav-inner');
    if (!indicator || !active || !inner) return;

    const innerRect = inner.getBoundingClientRect();
    const rect = active.getBoundingClientRect();

    indicator.style.width = rect.width + 'px';
    indicator.style.height = rect.height + 'px';
    indicator.style.transform = `translate(${rect.left - innerRect.left}px, ${rect.top - innerRect.top}px)`;
    indicator.style.borderRadius = active.classList.contains('bn-circle') ? '50%' : '12px';
}
window.moveBottomNavIndicator = moveIndicator;

setTimeout(moveIndicator, 100);

const observer = new MutationObserver(moveIndicator);
document.querySelectorAll('.bottom-nav .bn-item').forEach(btn => {
    observer.observe(btn, { attributes: true, attributeFilter: ['class'] });
});
window.addEventListener('resize', moveIndicator);

function setupQueueExpand() {
    const homeLayout = document.querySelector('.home-layout');
    const playerCol  = document.querySelector('.player-column');
    const queue      = document.querySelector('.player-queue');
    const btn        = document.getElementById('queueExpandBtn');

    if (!homeLayout || !playerCol || !queue || !btn) {
        console.warn('[queue-expand] элементы не найдены');
        return;
    }
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';

    let expanded = false;

    btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    expanded = !expanded; 

    if (expanded) {
        homeLayout.appendChild(queue);
        void homeLayout.offsetHeight;
        homeLayout.classList.add('queue-expanded');
    } else {
        homeLayout.classList.remove('queue-expanded');
        void homeLayout.offsetHeight;
        playerCol.insertBefore(queue, playerCol.firstChild);
    }

    setTimeout(() => {
        if (window.trackQueue) {
            window.trackQueue.recalcStep();
            window.trackQueue.update();
        }
        if (window.globeView) {
            try { window.globeView.resize(); } catch (err) {}
        }
        if (typeof positionBottomNav === 'function') positionBottomNav();
    }, 700);
});

}

(function autoInitQueueExpand() {
    const tryInit = () => {
        if (document.querySelector('.home-layout') && document.getElementById('queueExpandBtn')) {
            setupQueueExpand();
        } else {
            setTimeout(tryInit, 100);
        }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(tryInit, 50));
    } else {
        setTimeout(tryInit, 50);
    }
})();
window.setupQueueExpand = setupQueueExpand;

function setupGlobalSearch() {
    const input     = document.getElementById('globalSearchInput');
    const dropdown  = document.getElementById('topbarSearchDropdown');
    const searchBox = document.getElementById('topbarSearch');
    if (!input || !dropdown) return;

    const SOURCES = {
        all:        { label: 'Везде',         emoji: '🌐' },
        local:      { label: 'Локальные',     emoji: '📁' },
        soundcloud: { label: 'SoundCloud',    img: 'soundcloud.png' },
        yandex:     { label: 'Яндекс',        img: 'yandex.png' },
    };

    const sourceBtn  = document.getElementById('searchSourceBtn');
    const sourceMenu = document.getElementById('searchSourceMenu');
    let currentSource = localStorage.getItem('searchSource') || 'all';
    if (!SOURCES[currentSource]) currentSource = 'all';

    const _iconHTML = (key) => {
        const s = SOURCES[key];
        if (s.img) return `<img src="${s.img}" alt="" onerror="this.style.display='none'">`;
        return `<span class="search-source-emoji">${s.emoji}</span>`;
    };

    const updateSourceBtn = () => {
        if (!sourceBtn) return;
        const s = SOURCES[currentSource];
        sourceBtn.querySelector('.search-source-icon').innerHTML = _iconHTML(currentSource);
        sourceBtn.querySelector('.search-source-label').textContent = s.label;
    };

    const renderSourceMenu = () => {
        if (!sourceMenu) return;
        sourceMenu.innerHTML = Object.entries(SOURCES).map(([key, s]) => `
            <button class="search-source-item ${key === currentSource ? 'is-active' : ''}"
                    data-source="${key}" type="button" role="menuitem">
                ${_iconHTML(key)}
                <span>${s.label}</span>
            </button>
        `).join('');
    };

    const openSourceMenu = () => {
        if (!sourceMenu || !sourceBtn) return;
        renderSourceMenu();
        sourceMenu.hidden = false;
        sourceBtn.setAttribute('aria-expanded', 'true');
    };
    const closeSourceMenu = () => {
        if (!sourceMenu || !sourceBtn) return;
        sourceMenu.hidden = true;
        sourceBtn.setAttribute('aria-expanded', 'false');
    };

    updateSourceBtn();

    sourceBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (sourceMenu.hidden) openSourceMenu();
        else closeSourceMenu();
    });

    sourceMenu?.addEventListener('click', (e) => {
        const item = e.target.closest('[data-source]');
        if (!item) return;
        e.stopPropagation();
        currentSource = item.dataset.source;
        localStorage.setItem('searchSource', currentSource);
        updateSourceBtn();
        closeSourceMenu();
        if (input.value.trim()) renderResults(input.value);
        input.focus();
    });

    document.addEventListener('click', (e) => {
        if (e.target.closest('#searchSourceBtn') || e.target.closest('#searchSourceMenu')) return;
        closeSourceMenu();
    });

    let activeIdx = -1;
    let results = [];
    let _scToken = 0;
    let _scTimer = null;
    let _ymToken = 0;
    let _ymTimer = null;

    const openDropdown = () => {
        dropdown.hidden = false;
        document.body.classList.add('search-open');
    };
    const closeDropdown = () => {
        clearTimeout(_scTimer);
        clearTimeout(_ymTimer);
        _scToken++;
        _ymToken++;
        dropdown.hidden = true;
        dropdown.innerHTML = '';
        activeIdx = -1;
        results = [];
        document.body.classList.remove('search-open');
    };
    const clearSearch = () => {
        input.value = '';
        closeDropdown();
    };

    const renderLocalItem = (track, i, query) => {
        const coverUrl = audioEngine.ensureCoverUrl(track);
        const coverStyle = coverUrl ? `style="background-image:url('${coverUrl}')"` : '';
        const coverClass = coverUrl ? 'sr-cover has-image' : 'sr-cover';
        const dur = track.duration ? audioEngine.formatTime(track.duration) : '';
        return `
            <div class="sr-item ${i === activeIdx ? 'is-active' : ''}"
                 data-idx="${i}" data-track-id="${track.id}">
                <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
                <div class="sr-info">
                    <div class="sr-title">${_hl(track.title, query)}</div>
                    <div class="sr-artist">${_hl(track.artist, query)}</div>
                </div>
                <div class="sr-meta">
                    ${dur ? `<span class="sr-dur">${dur}</span>` : ''}
                    <span class="sr-play">Играть</span>
                </div>
            </div>
        `;
    };

    const renderScItem = (t, i) => {
        const proxy = window.proxyCover || ((u) => u);
        const cover = proxy(t.cover, 120);
        const coverStyle = cover ? `style="background-image:url('${cover}')"` : '';
        const coverClass = cover ? 'sr-cover has-image' : 'sr-cover';
        const dur = t.duration ? audioEngine.formatTime(t.duration) : '';
        return `
            <div class="sr-item sr-item-sc" data-sc-idx="${i}">
                <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
                <div class="sr-info">
                    <div class="sr-title">${escapeHtml(t.title)}</div>
                    <div class="sr-artist">${escapeHtml(t.artist)}${t.album ? ' · ' + escapeHtml(t.album) : ''}</div>
                </div>
                <div class="sr-meta">
                    ${dur ? `<span class="sr-dur">${dur}</span>` : ''}
                    <span class="sr-play sr-play-import">Импорт</span>
                </div>
            </div>
        `;
    };

    const renderYaItem = (t, i) => {
        const proxy = window.proxyCover || ((u) => u);
        const cover = proxy(t.cover, 120);
        const coverStyle = cover ? `style="background-image:url('${cover}')"` : '';
        const coverClass = cover ? 'sr-cover has-image' : 'sr-cover';
        const dur = t.duration ? audioEngine.formatTime(t.duration) : '';
        return `
            <div class="sr-item sr-item-ya" data-ya-idx="${i}">
                <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
                <div class="sr-info">
                    <div class="sr-title">${escapeHtml(t.title)}</div>
                    <div class="sr-artist">${escapeHtml(t.artist)}${t.album ? ' · ' + escapeHtml(t.album) : ''}</div>
                </div>
                <div class="sr-meta">
                    ${dur ? `<span class="sr-dur">${dur}</span>` : ''}
                    <span class="sr-play sr-play-import-ya">Импорт</span>
                </div>
            </div>
        `;
    };

    const renderResults = (query) => {
        const q = query.trim().toLowerCase();
        if (!q) { closeDropdown(); return; }

        const showLocal = currentSource === 'all' || currentSource === 'local';
        const showSC    = (currentSource === 'all' || currentSource === 'soundcloud')
                          && !!window.electronAPI?.music?.soundcloud;
        const showYA    = (currentSource === 'all' || currentSource === 'yandex')
                          && !!window.electronAPI?.music?.yandex;

        const list = audioEngine?.playlist || [];
        const matched = showLocal
            ? list
                .map((track, idx) => {
                    const t = String(track.title || '').toLowerCase();
                    const a = String(track.artist || '').toLowerCase();
                    if (!t.includes(q) && !a.includes(q)) return null;
                    const score = (t.startsWith(q) ? 3 : 0) + (t.includes(q) ? 1 : 0)
                                + (a.startsWith(q) ? 2 : 0) + (a.includes(q) ? 1 : 0);
                    return { track, idx, score };
                })
                .filter(Boolean)
                .sort((a, b) => b.score - a.score)
                .slice(0, 8)
            : [];

        results = matched;
        activeIdx = matched.length > 0 ? 0 : -1;

        const html = [];

        if (showLocal && matched.length > 0) {
            html.push(`<div class="sr-header">Локальные · ${matched.length}</div>`);
            matched.forEach(({ track }, i) => html.push(renderLocalItem(track, i, query)));
        }

        if (showSC) html.push(`<div id="sr-soundcloud-section"></div>`);
        if (showYA) html.push(`<div id="sr-yandex-section"></div>`);

        if (html.length === 0) {
            dropdown.innerHTML = '';
            openDropdown();
            return;
        }

        dropdown.innerHTML = html.join('');
        openDropdown();

        dropdown.querySelectorAll('.sr-item[data-track-id]').forEach(el => {
            el.addEventListener('mouseenter', () => {
                dropdown.querySelectorAll('.sr-item[data-track-id]')
                    .forEach(x => x.classList.remove('is-active'));
                el.classList.add('is-active');
                activeIdx = parseInt(el.dataset.idx, 10);
            });
            el.addEventListener('click', () => {
                playTrackById(el.dataset.trackId);
                clearSearch();
                input.blur();
            });
        });

        clearTimeout(_scTimer);
        clearTimeout(_ymTimer);
        const scTk = ++_scToken;
        const ymTk = ++_ymToken;

        if (q.length < 2) return;
        if (showSC) _scTimer = setTimeout(() => _runSoundCloud(q, scTk), 400);
        if (showYA) _ymTimer = setTimeout(() => _runYandex(q, ymTk), 500);
    };

    const _runSoundCloud = async (q, token) => {
        const section = dropdown.querySelector('#sr-soundcloud-section');
        if (!section || token !== _scToken) return;

        if (currentSource !== 'all' && currentSource !== 'soundcloud') return;

        section.innerHTML = `
            <div class="sr-header sr-header-sc">
                <img class="sr-logo" src="soundcloud.png" alt=""
                     onerror="this.style.display='none'">
                SoundCloud · поиск…
            </div>
        `;

        try {
            const scResults = await window.electronAPI.music.soundcloud.search(q, { limit: 10 });
            if (token !== _scToken) return;

            if (!scResults || scResults.length === 0) {
                section.innerHTML = `
                    <div class="sr-header sr-header-sc">
                        <img class="sr-logo" src="soundcloud.png" alt=""
                             onerror="this.style.display='none'">
                        SoundCloud
                    </div>
                    <div class="sr-status">Ничего не найдено</div>
                `;
                return;
            }

            let html = `
                <div class="sr-header sr-header-sc">
                    <img class="sr-logo" src="soundcloud.png" alt=""
                         onerror="this.style.display='none'">
                    SoundCloud · ${scResults.length}
                </div>
            `;
            scResults.forEach((t, i) => html += renderScItem(t, i));
            section.innerHTML = html;

            section.querySelectorAll('.sr-item-sc').forEach(el => {
                el.addEventListener('click', async () => {
                    const idx = parseInt(el.dataset.scIdx, 10);
                    const t = scResults[idx];
                    if (!t) return;

                    const label = el.querySelector('.sr-play-import');
                    if (label) label.textContent = '…';

                    try {
                        await window.musicServices?._importTrack(t);
                        clearSearch();
                        input.blur();
                    } catch (e) {
                        if (label) label.textContent = 'Импорт';
                    }
                });
            });
        } catch (e) {
            if (token !== _scToken) return;
            section.innerHTML = `
                <div class="sr-header sr-header-sc">
                    <img class="sr-logo" src="soundcloud.png" alt=""
                         onerror="this.style.display='none'">
                    SoundCloud
                </div>
                <div class="sr-status">Сервис недоступен</div>
            `;
        }
    };

    const _runYandex = async (q, token) => {
        const section = dropdown.querySelector('#sr-yandex-section');
        if (!section || token !== _ymToken) return;

        if (currentSource !== 'all' && currentSource !== 'yandex') return;

        let connected = false;
        try {
            const st = await window.electronAPI.music.yandex.status();
            connected = !!st.connected;
        } catch (e) {}

        if (!connected) {
            section.innerHTML = '';
            return;
        }

        section.innerHTML = `
            <div class="sr-header sr-header-ya">
                <img class="sr-logo" src="yandex.png" alt=""
                     onerror="this.style.display='none'">
                Яндекс.Музыка · поиск…
            </div>
        `;

        try {
            const yaResults = await window.electronAPI.music.yandex.search(q, { limit: 8 });
            if (token !== _ymToken) return;

            if (!yaResults || yaResults.length === 0) {
                section.innerHTML = `
                    <div class="sr-header sr-header-ya">
                        <img class="sr-logo" src="yandex.png" alt=""
                             onerror="this.style.display='none'">
                        Яндекс.Музыка
                    </div>
                    <div class="sr-status">Ничего не найдено</div>
                `;
                return;
            }

            let html = `
                <div class="sr-header sr-header-ya">
                    <img class="sr-logo" src="yandex.png" alt=""
                         onerror="this.style.display='none'">
                    Яндекс.Музыка · ${yaResults.length}
                </div>
            `;
            yaResults.forEach((t, i) => html += renderYaItem(t, i));
            section.innerHTML = html;

            section.querySelectorAll('.sr-item-ya').forEach(el => {
                el.addEventListener('click', async () => {
                    const idx = parseInt(el.dataset.yaIdx, 10);
                    const t = yaResults[idx];
                    if (!t) return;

                    const label = el.querySelector('.sr-play-import-ya');
                    if (label) label.textContent = '…';

                    try {
                        if (window.importYandexTrack) {
                            await window.importYandexTrack(t);
                            clearSearch();
                            input.blur();
                        }
                    } catch (e) {
                        if (label) label.textContent = 'Импорт';
                    }
                });
            });
        } catch (e) {
            if (token !== _ymToken) return;
            section.innerHTML = `
                <div class="sr-header sr-header-ya">
                    <img class="sr-logo" src="yandex.png" alt=""
                         onerror="this.style.display='none'">
                    Яндекс.Музыка
                </div>
                <div class="sr-status">Сервис недоступен</div>
            `;
        }
    };

    const _hl = (text, query) => {
        const safe = escapeHtml(text || '');
        if (!query) return safe;
        const q = query.toLowerCase();
        const lower = String(text).toLowerCase();
        const idx = lower.indexOf(q);
        if (idx < 0) return safe;
        const before = escapeHtml(String(text).slice(0, idx));
        const match  = escapeHtml(String(text).slice(idx, idx + q.length));
        const after  = escapeHtml(String(text).slice(idx + q.length));
        return `${before}<mark>${match}</mark>${after}`;
    };

    const playTrackById = (trackId) => {
        if (!audioEngine) return;
        const idx = audioEngine.playlist.findIndex(t => t.id === trackId);
        if (idx < 0) return;
        audioEngine.currentIndex = idx;
        audioEngine.loadCurrentTrack();
        audioEngine.play();
        const homeBtn = document.querySelector('.nav-item[data-page="home"]');
        if (homeBtn && !homeBtn.classList.contains('active')) homeBtn.click();
    };

    input.addEventListener('input', () => renderResults(input.value));
    input.addEventListener('focus', () => { if (input.value.trim()) renderResults(input.value); });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            clearSearch();
            input.blur();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (results.length === 0) return;
            activeIdx = (activeIdx + 1) % results.length;
            _highlightActive(dropdown, activeIdx);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (results.length === 0) return;
            activeIdx = (activeIdx - 1 + results.length) % results.length;
            _highlightActive(dropdown, activeIdx);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const item = dropdown.querySelector('.sr-item[data-track-id].is-active')
                       || dropdown.querySelector('.sr-item[data-track-id]');
            if (item) {
                playTrackById(item.dataset.trackId);
                clearSearch();
                input.blur();
            }
            return;
        }
    });

    document.addEventListener('mousedown', (e) => {
        if (searchBox.contains(e.target)) return;
        if (dropdown.contains(e.target)) return;
        closeDropdown();
    });

    document.addEventListener('scroll', (e) => {
        if (dropdown.hidden) return;
        if (dropdown.contains(e.target)) return;
        closeDropdown();
    }, true);

    input.addEventListener('focus', () => searchBox.classList.add('is-focused'));
    input.addEventListener('blur',  () => searchBox.classList.remove('is-focused'));

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
            e.preventDefault();
            if (document.activeElement === input) {
                clearSearch();
                input.blur();
            } else {
                input.focus();
                input.select();
                if (input.value.trim()) renderResults(input.value);
            }
        }
    });

    if (audioEngine) {
        const prevCb = audioEngine.onCoverLoaded;
        audioEngine.onCoverLoaded = (track) => {
            if (typeof prevCb === 'function') prevCb(track);
            if (!dropdown.hidden && input.value.trim()) renderResults(input.value);
        };
    }
}

function _highlightActive(dropdown, idx) {
    const items = dropdown.querySelectorAll('.sr-item');
    items.forEach((el, i) => el.classList.toggle('is-active', i === idx));
    const active = items[idx];
    if (active && active.scrollIntoView) {
        active.scrollIntoView({ block: 'nearest' });
    }
}

let _builderState = {
    queue: [],
    query: ''
};

function _builderAllArtists() {
    const map = new Map();
    (audioEngine?.playlist || []).forEach(t => {
        const name = t.artist || 'Неизвестный';
        if (!map.has(name)) map.set(name, { name, tracks: [] });
        map.get(name).tracks.push(t);
    });
    return Array.from(map.values())
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function renderBuilderArtists() {
    const listEl = document.getElementById('builderArtistsList');
    const countEl = document.getElementById('builderLibCount');
    if (!listEl) return;

    const artists = _builderAllArtists();
    const q = (_builderState.query || '').trim().toLowerCase();
    const filtered = q
        ? artists.filter(a => a.name.toLowerCase().includes(q))
        : artists;

    if (countEl) countEl.textContent = q
        ? `${filtered.length}/${artists.length}`
        : String(artists.length);

    listEl.innerHTML = '';

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="builder-empty-state">Ничего не найдено</div>`;
        return;
    }

    filtered.forEach(a => {
        const wrap = document.createElement('div');
        wrap.className = 'builder-artist-wrap';
        wrap.dataset.artistWrap = a.name;

        const card = document.createElement('div');
        card.className = 'builder-artist';
        card.draggable = true;
        card.dataset.artist = a.name;

        const letter = a.name.charAt(0).toUpperCase();
        card.innerHTML = `
            <div class="builder-artist-avatar">${escapeHtml(letter)}</div>
            <div class="builder-artist-info">
                <div class="builder-artist-name">${escapeHtml(a.name)}</div>
                <div class="builder-artist-meta">${a.tracks.length} ${pluralTracks(a.tracks.length)}</div>
            </div>
            <svg class="builder-artist-chevron" viewBox="0 0 24 24"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        `;

        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-mbox-artist', a.name);
            e.dataTransfer.effectAllowed = 'copy';
        });

        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            wrap.classList.toggle('expanded');
        });

        wrap.appendChild(card);

        const tracksEl = document.createElement('div');
        tracksEl.className = 'builder-artist-tracks';

        a.tracks.forEach(track => {
            const row = document.createElement('div');
            row.className = 'builder-artist-track';
            row.draggable = true;
            row.dataset.trackId = track.id;

            const url = audioEngine.ensureCoverUrl(track);
            const coverStyle = url ? `style="background-image:url('${url}')"` : '';
            const coverClass = url ? 'builder-artist-track-cover has-image' : 'builder-artist-track-cover';
            const dur = track.duration ? audioEngine.formatTime(track.duration) : '';

            row.innerHTML = `
                <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
                <div class="builder-artist-track-info">
                    <div class="builder-artist-track-title">${escapeHtml(track.title)}</div>
                    <div class="builder-artist-track-meta">${dur || '—'}</div>
                </div>
            `;

            row.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-mbox-track', track.id);
                e.dataTransfer.effectAllowed = 'copy';
            });

            tracksEl.appendChild(row);
        });

        wrap.appendChild(tracksEl);
        listEl.appendChild(wrap);
    });
}

function renderBuilderQueue(opts = {}) {
    const queueEl = document.getElementById('builderQueue');
    const countEl = document.getElementById('builderQueueCount');
    const emptyEl = document.getElementById('builderEmpty');
    const playBtn = document.getElementById('builderPlayBtn');
    if (!queueEl) return;

    const animate = !!opts.animate;

    const totalTracks = _builderState.queue.reduce((s, b) => s + (b.trackCount || 0), 0);
    if (countEl) {
        countEl.textContent = _builderState.queue.length > 0
            ? `${_builderState.queue.length} блоков · ${totalTracks} ${pluralTracks(totalTracks)}`
            : '';
    }
    if (playBtn) playBtn.disabled = _builderState.queue.length === 0;

    if (emptyEl) emptyEl.style.display = _builderState.queue.length === 0 ? 'flex' : 'none';

    queueEl.querySelectorAll('.builder-block, .builder-placeholder').forEach(el => el.remove());

    _builderState.queue.forEach((block, idx) => {
        const el = document.createElement('div');
        el.className = 'builder-block';
        el.dataset.index = String(idx);
        el.draggable = true;

        if (animate) {
            el.classList.add('builder-enter');
            el.style.setProperty('--i', idx);
        }

        const isTrack = block.type === 'track';

        let avatarHTML;
        if (isTrack && block.coverUrl) {
            avatarHTML = `<div class="builder-block-avatar has-image" style="background-image:url('${block.coverUrl}');background-size:cover;background-position:center"></div>`;
        } else {
            const letter = (block.name || '?').charAt(0).toUpperCase();
            avatarHTML = `<div class="builder-block-avatar">${escapeHtml(letter)}</div>`;
        }

        el.innerHTML = `
            <div class="builder-block-handle">⠿</div>
            ${avatarHTML}
            <div class="builder-block-info">
                <div class="builder-block-name">${escapeHtml(block.name)}</div>
                <div class="builder-block-meta">${isTrack ? '♪ трек' : block.trackCount + ' ' + pluralTracks(block.trackCount)}</div>
            </div>
            <button class="builder-block-remove" type="button" aria-label="Убрать">×</button>
        `;

        el.querySelector('.builder-block-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            _builderState.queue.splice(idx, 1);
            renderBuilderQueue();
        });

        el.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-mbox-reorder', String(idx));
            e.dataTransfer.effectAllowed = 'move';
            el.classList.add('dragging');
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            queueEl.querySelectorAll('.builder-placeholder').forEach(p => p.remove());
        });

        queueEl.appendChild(el);
    });
}

function addArtistToBuilderQueue(artistName) {
    if (!artistName) return;
    const artists = _builderAllArtists();
    const found = artists.find(a => a.name === artistName);
    if (!found) return;

    const exists = _builderState.queue.some(b => b.type === 'artist' && b.name === artistName);
    if (exists) {
        showNotification(`«${artistName}» уже в очереди`, true);
        return;
    }

    _builderState.queue.push({
        type: 'artist',
        id: artistName,
        name: artistName,
        trackCount: found.tracks.length,
        tracks: found.tracks.map(t => t.id)
    });

    renderBuilderQueue({ animate: true });
    showNotification(`Добавлен «${artistName}» (${found.tracks.length})`);
}

function addTrackToBuilderQueue(trackId) {
    if (!trackId) return;
    const track = (audioEngine?.playlist || []).find(t => t.id === trackId);
    if (!track) return;

    const exists = _builderState.queue.some(b => b.type === 'track' && b.id === trackId);
    if (exists) {
        showNotification(`«${track.title}» уже в очереди`, true);
        return;
    }

    const coverUrl = audioEngine.ensureCoverUrl(track) || null;

    _builderState.queue.push({
        type: 'track',
        id: track.id,
        name: track.title || '—',
        artist: track.artist || '—',
        coverUrl,
        trackCount: 1,
        tracks: [track.id]
    });

    renderBuilderQueue({ animate: true });
    showNotification(`Добавлен трек «${track.title}»`);
}

const BUILDER_PRESETS_KEY = 'builderPresets';

let _builderPresets = [];

function loadBuilderPresets() {
    try {
        _builderPresets = JSON.parse(localStorage.getItem(BUILDER_PRESETS_KEY) || '[]');
    } catch (e) {
        _builderPresets = [];
    }
    if (!Array.isArray(_builderPresets)) _builderPresets = [];
}

function saveBuilderPresetsToStorage() {
    localStorage.setItem(BUILDER_PRESETS_KEY, JSON.stringify(_builderPresets));
}

function renderBuilderPresets() {
    const listEl = document.getElementById('builderPresetsList');
    if (!listEl) return;

    listEl.innerHTML = '';

    if (_builderPresets.length === 0) {
        listEl.innerHTML = `<div class="builder-presets-empty">Пока нет пресетов.<br>Собери очередь<br>и нажми «Сохранить».</div>`;
        return;
    }

    _builderPresets.forEach(preset => {
        const el = document.createElement('div');
        el.className = 'builder-preset';

        const totalTracks = preset.blocks.reduce((s, b) => s + (b.trackCount || 0), 0);
        const tracksWord = pluralTracks(totalTracks);

        el.innerHTML = `
            <div class="builder-preset-name">${escapeHtml(preset.name)}</div>
            <div class="builder-preset-meta">${preset.blocks.length} блоков · ${totalTracks} ${tracksWord}</div>
            <button class="builder-preset-del" type="button" aria-label="Удалить">×</button>
        `;

        el.addEventListener('click', (e) => {
            if (e.target.closest('.builder-preset-del')) return;
            _builderState.queue = JSON.parse(JSON.stringify(preset.blocks));
            renderBuilderQueue({ animate: true });
            showNotification(`Пресет «${preset.name}» загружен`);
        });

        el.querySelector('.builder-preset-del').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!confirm(`Удалить пресет «${preset.name}»?`)) return;
            _builderPresets = _builderPresets.filter(p => p.id !== preset.id);
            saveBuilderPresetsToStorage();
            renderBuilderPresets();
            showNotification(`Пресет «${preset.name}» удалён`);
        });

        listEl.appendChild(el);
    });
}

async function saveBuilderPreset() {
    if (_builderState.queue.length === 0) {
        showNotification('Собери очередь сначала', true);
        return;
    }
    const name = await window.askPrompt('Название пресета:', 'Моя очередь');
    if (!name) return;

    const cleanName = name.trim().slice(0, 40);
    const existing = _builderPresets.find(p => p.name === cleanName);
    const id = existing ? existing.id : ('bp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));

    if (existing && !confirm(`Пресет «${cleanName}» уже есть. Перезаписать?`)) return;

    const preset = {
        id,
        name: cleanName,
        blocks: JSON.parse(JSON.stringify(_builderState.queue)),
        createdAt: existing ? existing.createdAt : Date.now(),
        updatedAt: Date.now()
    };

    if (existing) {
        const idx = _builderPresets.indexOf(existing);
        _builderPresets[idx] = preset;
    } else {
        _builderPresets.unshift(preset);
    }

    saveBuilderPresetsToStorage();
    renderBuilderPresets();
    showNotification(`Пресет «${cleanName}» сохранён`);
}

function playBuilderQueue() {
    if (_builderState.queue.length === 0) {
        showNotification('Собери очередь сначала', true);
        return;
    }

    const ordered = [];
    const seen = new Set();

    for (const block of _builderState.queue) {
        if (block.type === 'artist') {
            const artistTracks = (audioEngine.playlist || [])
                .filter(t => t.artist === block.name);
            artistTracks.forEach(t => {
                if (!seen.has(t.id)) {
                    ordered.push(t);
                    seen.add(t.id);
                }
            });
        } else if (block.type === 'track') {
            const live = (audioEngine.playlist || []).find(t => t.id === block.id);
            if (live && !seen.has(live.id)) {
                ordered.push(live);
                seen.add(live.id);
            }
        }
    }

    if (ordered.length === 0) {
        showNotification('В блоках не нашлось треков', true);
        return;
    }

    if (typeof playTrackList === 'function') {
        playTrackList(ordered, 'Конструктор');
    }
}

function setupBuilder() {
    const listEl   = document.getElementById('builderArtistsList');
    const queueEl  = document.getElementById('builderQueue');
    const searchEl = document.getElementById('builderSearch');
    const clearBtn = document.getElementById('builderClearBtn');
    const playBtn  = document.getElementById('builderPlayBtn');
    const saveBtn  = document.getElementById('builderSaveBtn');
    if (!listEl || !queueEl) return;

    loadBuilderPresets();
    renderBuilderPresets();

    searchEl?.addEventListener('input', () => {
        _builderState.query = searchEl.value;
        renderBuilderArtists();
    });

    let _pendingInsertIdx = -1;

    const _getInsertIndex = (y) => {
        const blocks = [...queueEl.querySelectorAll('.builder-block')];
        for (let i = 0; i < blocks.length; i++) {
            const r = blocks[i].getBoundingClientRect();
            if (y < r.top + r.height / 2) return i;
        }
        return blocks.length;
    };

    const _showPlaceholder = (insertIdx) => {
        const blocks = [...queueEl.querySelectorAll('.builder-block')];
        let ph = queueEl.querySelector('.builder-placeholder');
        if (!ph) {
            ph = document.createElement('div');
            ph.className = 'builder-placeholder';
        }
        if (insertIdx >= blocks.length) {
            queueEl.appendChild(ph);
        } else {
            queueEl.insertBefore(ph, blocks[insertIdx]);
        }
        _pendingInsertIdx = insertIdx;
    };

    const _hidePlaceholder = () => {
        queueEl.querySelectorAll('.builder-placeholder').forEach(p => p.remove());
        _pendingInsertIdx = -1;
    };

    queueEl.addEventListener('dragover', (e) => {
        e.preventDefault();

        const isReorder = e.dataTransfer.types.includes('application/x-mbox-reorder');
        const isArtist  = e.dataTransfer.types.includes('application/x-mbox-artist');
        const isTrack   = e.dataTransfer.types.includes('application/x-mbox-track');

        if (isReorder) {
            e.dataTransfer.dropEffect = 'move';
            const idx = _getInsertIndex(e.clientY);
            _showPlaceholder(idx);
            queueEl.classList.remove('dragover');
        } else if (isArtist || isTrack) {
            e.dataTransfer.dropEffect = 'copy';
            _hidePlaceholder();
            queueEl.classList.add('dragover');
        }
    });

    queueEl.addEventListener('dragleave', (e) => {
        if (!queueEl.contains(e.relatedTarget)) {
            queueEl.classList.remove('dragover');
            _hidePlaceholder();
        }
    });

    queueEl.addEventListener('drop', (e) => {
        e.preventDefault();
        queueEl.classList.remove('dragover');

        const reorderIdx = e.dataTransfer.getData('application/x-mbox-reorder');
        if (reorderIdx !== '') {
            const from = parseInt(reorderIdx, 10);
            let to = _pendingInsertIdx;

            if (from < 0 || isNaN(from) || to < 0) {
                _hidePlaceholder();
                return;
            }
            if (from < to) to -= 1;
            _hidePlaceholder();
            if (from === to) return;

            const [item] = _builderState.queue.splice(from, 1);
            _builderState.queue.splice(to, 0, item);
            renderBuilderQueue();
            return;
        }

        const artistName = e.dataTransfer.getData('application/x-mbox-artist');
        if (artistName) {
            addArtistToBuilderQueue(artistName);
            _hidePlaceholder();
            return;
        }

        const trackId = e.dataTransfer.getData('application/x-mbox-track');
        if (trackId) {
            addTrackToBuilderQueue(trackId);
            _hidePlaceholder();
            return;
        }

        _hidePlaceholder();
    });

    clearBtn?.addEventListener('click', () => {
        if (_builderState.queue.length === 0) return;
        if (!confirm('Очистить всю очередь?')) return;
        _builderState.queue = [];
        renderBuilderQueue();
    });

    playBtn?.addEventListener('click', () => playBuilderQueue());
    saveBtn?.addEventListener('click', () => saveBuilderPreset());

    renderBuilderArtists();
    renderBuilderQueue();
}
window.setupBuilder = setupBuilder;
window.renderBuilderArtists = renderBuilderArtists;
window.renderBuilderQueue = renderBuilderQueue;

function buildRecommendations() {
    const grid = document.getElementById('recGrid');
    if (!grid) return;
    grid.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">♪</div>
            <div class="empty-state-title">Рекомендаций пока нет</div>
            <div class="empty-state-text">
                Загрузите треки — и здесь появятся подсказки на основе вашей музыки
            </div>
        </div>
    `;
}

const ACHIEVEMENTS_DEF = [
    { id: 'first',    icon: '🌱', name: 'Первые шаги',  desc: 'Загружен 1 трек',          test: (s) => s.tracks >= 1 },
    { id: 'ten',      icon: '🎧', name: 'Слушатель',    desc: '10 треков в базе',         test: (s) => s.tracks >= 10 },
    { id: 'melo',     icon: '🎵', name: 'Меломан',      desc: '100 треков в базе',        test: (s) => s.tracks >= 100 },
    { id: 'legend',   icon: '👑', name: 'Легенда',      desc: '1000 треков в базе',       test: (s) => s.tracks >= 1000 },
    { id: 'hour',     icon: '⏱️', name: 'Час в деле',   desc: '1 час прослушивания',      test: (s) => s.hours >= 1 },
    { id: 'tenhours', icon: '🔥', name: 'На волне',     desc: '10 часов прослушивания',   test: (s) => s.hours >= 10 },
    { id: 'marathon', icon: '🏃', name: 'Марафонец',    desc: '50 часов прослушивания',   test: (s) => s.hours >= 50 },
    { id: 'collect',  icon: '💎', name: 'Коллекционер', desc: '10 плейлистов',            test: (s) => s.playlists >= 10 },
    { id: 'global',   icon: '🌍', name: 'Глобалист',    desc: '5 регионов в базе',        test: (s) => s.regions >= 5 },
    { id: 'explore',  icon: '🔍', name: 'Исследователь',desc: '20 артистов в базе',       test: (s) => s.artists >= 20 },
    { id: 'starter',  icon: '▶️', name: 'Начало положено',desc: 'Первый трек запущен',      test: (s) => s.plays >= 1 },
    { id: 'repeat',   icon: '🔁', name: 'По кругу',     desc: '100 запусков',             test: (s) => s.plays >= 100 }
];

function _profileStats() {
    const list = audioEngine?.playlist || [];
    const totalPlays = list.reduce((s, t) => s + (t.playCount || 0), 0);
    const totalSeconds = list.reduce((s, t) => s + (t.duration || 0) * (t.playCount || 0), 0);
    const hours = Math.floor(totalSeconds / 3600);

    const artistsSet = new Set();
    const regionsSet = new Set();
    const daysSet = new Set();

    list.forEach(t => {
        if (t.artist && t.artist !== 'Неизвестный исполнитель') artistsSet.add(t.artist);
        if (t.region != null && t.region >= 0) regionsSet.add(t.region);
        if (t.lastPlayedAt) {
            const d = new Date(t.lastPlayedAt);
            daysSet.add(d.toISOString().slice(0, 10));
        }
    });

    const playlists = window.playlistManager ? window.playlistManager.getPlaylistCount() : 0;

    return {
        tracks: list.length,
        plays: totalPlays,
        hours,
        minutes: Math.floor((totalSeconds % 3600) / 60),
        artists: artistsSet.size,
        regions: regionsSet.size,
        playlists,
        days: daysSet.size,
        totalSeconds
    };
}


const PROFILE_AVATAR_KEY = 'profileAvatar';
const PROFILE_COVER_KEY  = 'profileCover';

function _resizeImage(file, maxW, maxH, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read failed'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('load failed'));
            img.onload = () => {
                const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
                const w = Math.round(img.width * ratio);
                const h = Math.round(img.height * ratio);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve(dataUrl);
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function openEditProfileModal() {
    const modal = document.getElementById('editProfileModal');
    if (!modal) return;

    const user = JSON.parse(localStorage.getItem('user') || '{}');

    const nameEl = document.getElementById('editProfileName');
    const userEl = document.getElementById('editProfileUsername');
    const bioEl  = document.getElementById('editProfileBio');

    if (nameEl) nameEl.value = user.name || '';
    if (userEl) userEl.value = user.username || '';
    if (bioEl) {
        bioEl.value = user.bio || '';
        const counter = document.getElementById('editBioCount');
        if (counter) counter.textContent = bioEl.value.length;
    }

    const avatarUrl = localStorage.getItem(PROFILE_AVATAR_KEY);
    const avatarWrap = document.getElementById('editProfileAvatar');
    if (avatarWrap) {
        if (avatarUrl) {
            avatarWrap.style.backgroundImage = `url("${avatarUrl}")`;
            avatarWrap.classList.add('has-image');
        } else {
            avatarWrap.style.backgroundImage = '';
            avatarWrap.classList.remove('has-image');
            const ph = avatarWrap.querySelector('.edit-profile-avatar-placeholder');
            if (ph) ph.textContent = (user.name || '?').charAt(0).toUpperCase();
        }
    }

    const coverUrl = localStorage.getItem(PROFILE_COVER_KEY);
    const coverEl = document.getElementById('editProfileCover');
    const coverRemoveBtn = document.getElementById('editCoverRemoveBtn');
    if (coverEl) {
        if (coverUrl) {
            coverEl.style.backgroundImage = `url("${coverUrl}")`;
            coverEl.classList.add('has-image');
            if (coverRemoveBtn) coverRemoveBtn.hidden = false;
        } else {
            coverEl.style.backgroundImage = '';
            coverEl.classList.remove('has-image');
            if (coverRemoveBtn) coverRemoveBtn.hidden = true;
        }
    }

    modal.classList.add('active');

    setTimeout(() => nameEl?.focus(), 200);
}

function closeEditProfileModal() {
    const modal = document.getElementById('editProfileModal');
    if (modal) modal.classList.remove('active');
}

function saveProfile() {
    const nameEl = document.getElementById('editProfileName');
    const userEl = document.getElementById('editProfileUsername');
    const bioEl  = document.getElementById('editProfileBio');

    const name = (nameEl?.value || '').trim();
    const username = (userEl?.value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    const bio = (bioEl?.value || '').trim().slice(0, 120);

    if (name.length < 2) {
        showNotification('Имя — минимум 2 символа', true);
        nameEl?.focus();
        return;
    }
    if (username.length < 3) {
        showNotification('Username — минимум 3 символа', true);
        userEl?.focus();
        return;
    }

    const user = JSON.parse(localStorage.getItem('user') || '{}');
    user.name = name;
    user.username = username;
    user.bio = bio;
    user.avatar = name.charAt(0).toUpperCase();

    localStorage.setItem('user', JSON.stringify(user));

    renderProfile();
    _syncProfileAvatarInUI();

    closeEditProfileModal();
    showNotification('Профиль сохранён');
}

function _syncProfileAvatarInUI() {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const avatarUrl = localStorage.getItem(PROFILE_AVATAR_KEY);
    const letter = (user.name || '?').charAt(0).toUpperCase();

    const heroWrap = document.getElementById('profileAvatar');
    if (heroWrap) {
        let heroLetter = document.getElementById('profileAvatarLetter');
        let heroImage  = document.getElementById('profileAvatarImage');

        if (!heroLetter) {
            const rawText = (heroWrap.textContent || '').trim();
            heroWrap.innerHTML = '';
            heroLetter = document.createElement('span');
            heroLetter.className = 'profile-avatar-letter';
            heroLetter.id = 'profileAvatarLetter';
            heroLetter.textContent = rawText || letter;
            heroWrap.appendChild(heroLetter);
        }
        if (!heroImage) {
            heroImage = document.createElement('img');
            heroImage.className = 'profile-avatar-image';
            heroImage.id = 'profileAvatarImage';
            heroImage.alt = '';
            heroImage.hidden = true;
            heroWrap.appendChild(heroImage);
        }
    }

    document.querySelectorAll('.topbar-avatar .profile-avatar').forEach(el => {
        if (avatarUrl) {
            el.textContent = '';
            el.style.backgroundImage = `url("${avatarUrl}")`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.classList.add('has-image');
        } else {
            el.textContent = letter;
            el.style.backgroundImage = '';
            el.classList.remove('has-image');
        }
    });

    document.querySelectorAll('.bn-circle .profile-avatar').forEach(el => {
        if (avatarUrl) {
            el.textContent = '';
            el.style.backgroundImage = `url("${avatarUrl}")`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.classList.add('has-image');
        } else {
            el.textContent = letter;
            el.style.backgroundImage = '';
            el.classList.remove('has-image');
        }
    });

    document.querySelectorAll('.rn-profile .profile-avatar').forEach(el => {
        if (avatarUrl) {
            el.textContent = '';
            el.style.backgroundImage = `url("${avatarUrl}")`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.classList.add('has-image');
        } else {
            el.textContent = letter;
            el.style.backgroundImage = '';
            el.classList.remove('has-image');
        }
    });

    const heroLetter = document.getElementById('profileAvatarLetter');
    const heroImage  = document.getElementById('profileAvatarImage');

    if (heroLetter && heroImage) {
        if (avatarUrl) {
            heroImage.src = avatarUrl;
            heroImage.removeAttribute('hidden');
            heroImage.style.display = 'block';
            heroLetter.style.display = 'none';
        } else {
            heroImage.removeAttribute('src');
            heroImage.setAttribute('hidden', '');
            heroImage.style.display = 'none';
            heroLetter.style.display = 'flex';
            heroLetter.textContent = letter;
        }
    } else {
        console.warn('_syncProfileAvatarInUI: не найдены элементы hero');
    }
}

function setupEditProfile() {
    const modal = document.getElementById('editProfileModal');
    if (!modal) return;

    document.querySelectorAll('.account-item[data-action="edit-profile"]').forEach(el => {
        el.addEventListener('click', openEditProfileModal);
    });

    document.getElementById('editProfileClose')?.addEventListener('click', closeEditProfileModal);
    document.getElementById('editProfileCancelBtn')?.addEventListener('click', closeEditProfileModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeEditProfileModal();
    });

    const bioEl = document.getElementById('editProfileBio');
    bioEl?.addEventListener('input', () => {
        const c = document.getElementById('editBioCount');
        if (c) c.textContent = bioEl.value.length;
    });

    const userEl = document.getElementById('editProfileUsername');
    userEl?.addEventListener('input', (e) => {
        e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    });

    const nameEl = document.getElementById('editProfileName');
    nameEl?.addEventListener('input', (e) => {
        const wrap = document.getElementById('editProfileAvatar');
        if (!wrap || wrap.classList.contains('has-image')) return;
        const ph = wrap.querySelector('.edit-profile-avatar-placeholder');
        if (ph) ph.textContent = (e.target.value || '?').charAt(0).toUpperCase();
    });

    document.getElementById('editProfileForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        saveProfile();
    });

    const avatarFileInput = document.getElementById('editAvatarFile');
    document.getElementById('editAvatarUploadBtn')?.addEventListener('click', () => {
        avatarFileInput?.click();
    });
    avatarFileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            showNotification('Файл больше 5 МБ', true);
            return;
        }
        try {
            const dataUrl = await _resizeImage(file, 400, 400, 0.88);
            localStorage.setItem(PROFILE_AVATAR_KEY, dataUrl);

            const wrap = document.getElementById('editProfileAvatar');
            if (wrap) {
                wrap.style.backgroundImage = `url("${dataUrl}")`;
                wrap.classList.add('has-image');
            }
            _syncProfileAvatarInUI();
            showNotification('Аватар обновлён');
        } catch (err) {
            console.warn(err);
            showNotification('Не удалось загрузить аватар', true);
        }
        e.target.value = '';
    });

    document.getElementById('editAvatarRemoveBtn')?.addEventListener('click', () => {
        localStorage.removeItem(PROFILE_AVATAR_KEY);
        const wrap = document.getElementById('editProfileAvatar');
        if (wrap) {
            wrap.style.backgroundImage = '';
            wrap.classList.remove('has-image');
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            const ph = wrap.querySelector('.edit-profile-avatar-placeholder');
            if (ph) ph.textContent = (user.name || '?').charAt(0).toUpperCase();
        }
        _syncProfileAvatarInUI();
        showNotification('Аватар убран');
    });

    const coverFileInput = document.getElementById('editCoverFile');
    document.getElementById('editCoverBtn')?.addEventListener('click', () => {
        coverFileInput?.click();
    });
    coverFileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
            showNotification('Файл больше 8 МБ', true);
            return;
        }
        try {
            const dataUrl = await _resizeImage(file, 1600, 600, 0.82);
            localStorage.setItem(PROFILE_COVER_KEY, dataUrl);

            const coverEl = document.getElementById('editProfileCover');
            if (coverEl) {
                coverEl.style.backgroundImage = `url("${dataUrl}")`;
                coverEl.classList.add('has-image');
            }
            document.getElementById('editCoverRemoveBtn').hidden = false;

            renderProfileHero();
            showNotification('Обложка обновлена');
        } catch (err) {
            console.warn(err);
            showNotification('Не удалось загрузить обложку', true);
        }
        e.target.value = '';
    });

    document.getElementById('editCoverRemoveBtn')?.addEventListener('click', () => {
        localStorage.removeItem(PROFILE_COVER_KEY);
        const coverEl = document.getElementById('editProfileCover');
        if (coverEl) {
            coverEl.style.backgroundImage = '';
            coverEl.classList.remove('has-image');
        }
        document.getElementById('editCoverRemoveBtn').hidden = true;
        renderProfileHero();
        showNotification('Обложка убрана');
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
            closeEditProfileModal();
        }
    });
}

window.openEditProfileModal = openEditProfileModal;
window.closeEditProfileModal = closeEditProfileModal;
window.setupEditProfile = setupEditProfile;

function renderProfileHero() {
    const user = JSON.parse(localStorage.getItem('user') || '{}');

    const avatarEl = document.getElementById('profileAvatar');
    const nameEl   = document.getElementById('profileName');
    const userEl   = document.getElementById('profileUsername');
    const badgesEl = document.getElementById('profileBadges');
    const bioEl    = document.getElementById('profileBio');
    const heroEl   = document.getElementById('profileHero');
    const stats    = _profileStats();

    // имя
    if (nameEl) nameEl.textContent = user.name || 'Гость';

    // username
    if (userEl) {
        if (user.registeredAt) {
            const date = new Date(user.registeredAt);
            const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
            userEl.textContent = `@${user.username || 'guest'} · На платформе с ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
        } else {
            userEl.textContent = `@${user.username || 'guest'}`;
        }
    }

    // bio
    if (bioEl) {
        if (user.bio) {
            bioEl.textContent = user.bio;
            bioEl.hidden = false;
        } else {
            bioEl.hidden = true;
        }
    }

    // обложка профиля
    const coverUrl = localStorage.getItem(PROFILE_COVER_KEY);
    if (heroEl) {
        if (coverUrl) {
            heroEl.style.setProperty('--profile-cover', `url("${coverUrl}")`);
            heroEl.classList.add('has-cover');
        } else {
            heroEl.style.removeProperty('--profile-cover');
            heroEl.classList.remove('has-cover');
        }
    }

    // аватар + буква
    _syncProfileAvatarInUI();

    // бейджи
    if (badgesEl) {
        const badges = [];
        if (stats.hours >= 10)  badges.push({ label: '⭐ Активный', cls: 'premium' });
        if (stats.tracks >= 50) badges.push({ label: '🎵 Меломан' });
        if (stats.regions >= 3) badges.push({ label: '🌍 Глобалист' });
        if (stats.playlists >= 5) badges.push({ label: '💎 Коллекционер' });
        if (stats.plays >= 50)  badges.push({ label: '🔥 В ударе' });
        if (badges.length === 0) badges.push({ label: '👋 Новичок' });

        badgesEl.innerHTML = badges
            .map(b => `<span class="badge ${b.cls || ''}">${b.label}</span>`)
            .join('');
    }

    // статистика-hero
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    setText('profileStatTracks',    stats.tracks);
    setText('profileStatArtists',   stats.artists);
    setText('profileStatPlaylists', stats.playlists);
    setText('profileStatHours',     stats.hours > 0 ? `${stats.hours}ч` : `${stats.minutes}м`);
    setText('profileCardTracks', stats.tracks);
    setText('profileCardPlays',  stats.plays);
    setText('profileCardStreak', stats.days);

    const unlocked = ACHIEVEMENTS_DEF.filter(a => a.test(stats));
    setText('profileCardAchievements', `${unlocked.length}/${ACHIEVEMENTS_DEF.length}`);
}

function renderProfileAchievements() {
    const wrap = document.getElementById('profileAchievements');
    if (!wrap) return;

    const stats = _profileStats();
    wrap.innerHTML = '';

    ACHIEVEMENTS_DEF.forEach(a => {
        const unlocked = a.test(stats);
        const div = document.createElement('div');
        div.className = 'achievement' + (unlocked ? '' : ' locked');
        div.innerHTML = `
            <div class="achievement-icon">${unlocked ? a.icon : '🔒'}</div>
            <div class="achievement-name">${escapeHtml(a.name)}</div>
            <div class="achievement-desc">${escapeHtml(a.desc)}</div>
        `;
        wrap.appendChild(div);
    });
}

function renderProfileTopArtists() {
    const wrap = document.getElementById('profileTopArtists');
    if (!wrap || !audioEngine) return;

    const map = new Map();
    (audioEngine.playlist || []).forEach(t => {
        const name = t.artist || 'Неизвестный';
        if (!map.has(name)) map.set(name, { name, tracks: 0, plays: 0 });
        const e = map.get(name);
        e.tracks++;
        e.plays += (t.playCount || 0);
    });

    const list = Array.from(map.values())
        .sort((a, b) => b.plays - a.plays || b.tracks - a.tracks)
        .slice(0, 5);

    if (list.length === 0) {
        wrap.innerHTML = `<div class="sidebar-empty">Пока нет данных</div>`;
        return;
    }

    const maxPlays = Math.max(1, ...list.map(a => a.plays));

    wrap.innerHTML = '';
    list.forEach((a, i) => {
        const pct = (a.plays / maxPlays) * 100;
        const row = document.createElement('div');
        row.className = 'profile-artist-row';
        row.innerHTML = `
            <div class="profile-artist-rank">${i + 1}</div>
            <div class="profile-artist-info">
                <div class="profile-artist-name">${escapeHtml(a.name)}</div>
                <div class="profile-artist-meta">
                    <span>${a.tracks} ${pluralTracks(a.tracks)}</span>
                    <span class="dot">·</span>
                    <span>${a.plays} ${pluralPlays(a.plays)}</span>
                </div>
                <div class="profile-artist-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
            </div>
        `;
        row.addEventListener('click', () => {
            if (typeof openArtistPage === 'function') openArtistPage(a.name);
        });
        row.style.cursor = 'pointer';
        wrap.appendChild(row);
    });
}

function renderProfileRegions() {
    const wrap = document.getElementById('profileRegions');
    if (!wrap || !audioEngine) return;

    const counts = {};
    (audioEngine.playlist || []).forEach(t => {
        if (t.region == null || t.region < 0) return;
        counts[t.region] = (counts[t.region] || 0) + 1;
    });

    const list = Object.entries(counts)
        .map(([idx, n]) => ({ idx: parseInt(idx, 10), n }))
        .sort((a, b) => b.n - a.n);

    if (list.length === 0) {
        wrap.innerHTML = `<div class="sidebar-empty">Регионы не определены — добавь артистов в artists.js</div>`;
        return;
    }

    const max = list[0].n;
    wrap.innerHTML = list.map(({ idx, n }) => {
        const cls = n === max ? 'popular' : '';
        const name = (typeof REGION_NAMES !== 'undefined' && REGION_NAMES[idx]) || 'Регион';
        return `<span class="genre-tag ${cls}" data-region="${idx}">${escapeHtml(name)} <b>${n}</b></span>`;
    }).join('');

    wrap.querySelectorAll('.genre-tag[data-region]').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.region, 10);
            if (typeof openRegionPage === 'function') openRegionPage(idx);
        });
    });
}

function renderProfileActivity() {
    const wrap = document.getElementById('profileActivity');
    if (!wrap || !audioEngine) return;

    const list = (audioEngine.playlist || [])
        .filter(t => t.lastPlayedAt)
        .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
        .slice(0, 5);

    if (list.length === 0) {
        wrap.innerHTML = `<div class="sidebar-empty">Пока нет активности</div>`;
        return;
    }

    wrap.innerHTML = '';
    list.forEach(t => {
        const when = _relativeTime(t.lastPlayedAt);
        const plays = t.playCount || 0;
        const row = document.createElement('div');
        row.className = 'activity-item';
        row.innerHTML = `
            <div class="activity-icon">🎵</div>
            <div class="activity-info">
                <div class="activity-title">Прослушал «${escapeHtml(t.title)}»</div>
                <div class="activity-subtitle">${escapeHtml(t.artist)}${t.duration ? ' · ' + audioEngine.formatTime(t.duration) : ''}</div>
            </div>
            <div class="activity-time">${plays > 1 ? `${plays} ${pluralPlays(plays)} · ` : ''}${when}</div>
        `;
        row.addEventListener('click', () => {
            const idx = audioEngine.playlist.indexOf(t);
            if (idx < 0) return;
            audioEngine.currentIndex = idx;
            audioEngine.loadCurrentTrack();
            audioEngine.play();
            const homeBtn = document.querySelector('.nav-item[data-page="home"]');
            if (homeBtn && !homeBtn.classList.contains('active')) homeBtn.click();
        });
        row.style.cursor = 'pointer';
        wrap.appendChild(row);
    });
}

function renderProfile() {
    renderProfileHero();
    renderProfileAchievements();
    renderProfileTopArtists();
    renderProfileRegions();
    renderProfileActivity();
}
window.renderProfile = renderProfile;


function updateStageCover(track) {
    const el      = document.getElementById('stageCover');
    const titleEl = document.getElementById('stageMetaTitle');
    const artEl   = document.getElementById('stageMetaArtist');
    if (!el) return;

    if (!track) {
        el.style.backgroundImage = '';
        el.classList.remove('has-image');
        if (titleEl) titleEl.textContent = 'Загрузите музыку';
        if (artEl)   artEl.textContent   = 'Нажмите кнопку "Загрузить"';
        return;
    }

    const url = window.audioEngine?.ensureCoverUrl(track);
    if (url) {
        el.style.backgroundImage = `url("${url}")`;
        el.classList.add('has-image');
    } else {
        el.style.backgroundImage = '';
        el.classList.remove('has-image');
    }
    if (titleEl) titleEl.textContent = track.title || '—';
    if (artEl)   artEl.textContent   = track.artist || '—';
}
window.updateStageCover = updateStageCover;

function pluralPlays(n) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'раз';
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'раза';
    return 'раз';
}

function getTopTracks(limit = 100) {
    const lib = window.audioEngine?.playlist || [];
    return [...lib]
        .filter(t => (t.playCount || 0) > 0)
        .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
        .slice(0, limit);
}


const REGION_ICONS = {
    0: '🌎',  // Северная Америка
    1: '🌎',  // Южная Америка
    2: '🏰',  // Европа
    3: '🦁',  // Африка
    4: '🏯',  // Азия
    5: '🦘',  // Австралия
    6: '🐧'   // Антарктида
};

function openRegionPage(regionIdx) {
    if (regionIdx == null || regionIdx < 0) return;
    const modal = document.getElementById('regionModal');
    if (!modal) return;

    const regionName = (typeof REGION_NAMES !== 'undefined' && REGION_NAMES[regionIdx]) || 'Регион';

    const tracks = (audioEngine?.playlist || [])
        .filter(t => t.region === regionIdx)
        .sort((a, b) => (b.playCount || 0) - (a.playCount || 0));

    const avatar = document.getElementById('regionHeroAvatar');
    const name   = document.getElementById('regionHeroName');
    const stats  = document.getElementById('regionHeroStats');

    if (avatar) avatar.textContent = REGION_ICONS[regionIdx] || '🌍';
    if (name)   name.textContent   = regionName;

    const totalTracks  = tracks.length;
    const totalPlays   = tracks.reduce((s, t) => s + (t.playCount || 0), 0);
    const totalSeconds = tracks.reduce((s, t) => s + (t.duration || 0) * (t.playCount || 0), 0);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const timeStr = hours > 0 ? `${hours}ч ${minutes}м` : `${minutes}м`;

    if (stats) {
        stats.innerHTML = `
            <span><b>${totalTracks}</b> ${pluralTracks(totalTracks)}</span>
            <span class="dot"></span>
            <span><b>${totalPlays}</b> ${pluralPlays(totalPlays)}</span>
            <span class="dot"></span>
            <span><b>${timeStr}</b> прослушано</span>
        `;
    }

    const playAllBtn = document.getElementById('regionPlayAllBtn');
    const shuffleBtn = document.getElementById('regionShuffleBtn');

    const newPlayAll = playAllBtn.cloneNode(true);
    playAllBtn.parentElement.replaceChild(newPlayAll, playAllBtn);
    newPlayAll.addEventListener('click', () => {
        if (tracks.length === 0) return;
        playTrackList(tracks, regionName);
        closeRegionModal();
    });

    const newShuffle = shuffleBtn.cloneNode(true);
    shuffleBtn.parentElement.replaceChild(newShuffle, shuffleBtn);
    newShuffle.addEventListener('click', () => {
        if (tracks.length === 0) return;
        const shuffled = [...tracks];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        playTrackList(shuffled, regionName);
        closeRegionModal();
    });

    const listEl  = document.getElementById('regionTracks');
    const countEl = document.getElementById('regionTracksCount');
    if (countEl) countEl.textContent = totalTracks > 0 ? String(totalTracks) : '';

    if (!listEl) return;
    listEl.innerHTML = '';

    if (tracks.length === 0) {
        listEl.innerHTML = `<div class="sidebar-empty">В этом регионе<br>пока нет треков</div>`;
    } else {
        tracks.forEach((track, i) => {
            const row = document.createElement('div');
            row.className = 'artist-track-row';
            const coverUrl = audioEngine.ensureCoverUrl(track);
            const coverStyle = coverUrl
                ? `style="background-image:url('${coverUrl}');background-size:cover;background-position:center"`
                : '';
            const coverClass = coverUrl ? 'artist-track-cover has-image' : 'artist-track-cover';
            const dur = track.duration ? audioEngine.formatTime(track.duration) : '';
            const plays = track.playCount || 0;

            row.innerHTML = `
                <div class="artist-track-num">${i + 1}</div>
                <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
                <div class="artist-track-info">
                    <div class="artist-track-title">${escapeHtml(track.title)}</div>
                    <div class="artist-track-meta">
                        <span>${escapeHtml(track.artist)}</span>
                        ${plays > 0 ? `<span class="artist-track-plays">${plays} ${pluralPlays(plays)}</span>` : ''}
                    </div>
                </div>
                ${dur ? `<div class="artist-track-dur">${dur}</div>` : ''}
                <button class="artist-track-play" aria-label="Играть">
                    <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </button>
            `;

            row.addEventListener('click', () => {
                const idx = audioEngine.playlist.indexOf(track);
                if (idx < 0) return;
                audioEngine.currentIndex = idx;
                audioEngine.loadCurrentTrack();
                audioEngine.play();
                closeRegionModal();
                const homeBtn = document.querySelector('.nav-item[data-page="home"]');
                if (homeBtn && !homeBtn.classList.contains('active')) homeBtn.click();
            });

            listEl.appendChild(row);
        });
    }

    modal.classList.add('active');
}

function closeRegionModal() {
    const modal = document.getElementById('regionModal');
    if (modal) modal.classList.remove('active');
}

window.openRegionPage = openRegionPage;
window.closeRegionModal = closeRegionModal;

const ARTIST_META_KEY = 'artistMeta';

let _artistCurrent = null;
let _artistReturnPage = 'home';

function _loadArtistMeta() {
    try {
        return JSON.parse(localStorage.getItem(ARTIST_META_KEY) || '{}');
    } catch (e) {
        return {};
    }
}

function _saveArtistMeta(meta) {
    localStorage.setItem(ARTIST_META_KEY, JSON.stringify(meta));
}

function _getArtistMeta(name) {
    const meta = _loadArtistMeta();
    return meta[name] || {};
}

function _setArtistMeta(name, data) {
    const meta = _loadArtistMeta();
    meta[name] = Object.assign({}, meta[name] || {}, data);
    _saveArtistMeta(meta);
}

function _artistTracks(name) {
    const clean = String(name || '').trim().toLowerCase();
    return (audioEngine?.playlist || [])
        .filter(t => String(t.artist || '').toLowerCase() === clean)
        .sort((a, b) => {
            const dp = (b.playCount || 0) - (a.playCount || 0);
            if (dp !== 0) return dp;
            return (b.createdAt || 0) - (a.createdAt || 0);
        });
}

const AUDIODB_CACHE_VERSION = 1;

async function fetchArtistBioFromAudiodb(artistName) {
    const name = String(artistName || '').trim();
    if (!name) return null;

   try {
        const searchTarget = `https://www.theaudiodb.com/api/v1/json/123/search.php?s=${encodeURIComponent(name)}`;
        const searchData = await _fetchJsonViaProxy(searchTarget);

        if (!searchData || !Array.isArray(searchData.artists) || searchData.artists.length === 0) {
            return null;
        }

        const nameLower = name.toLowerCase();
        const artist =
            searchData.artists.find(a => String(a.strArtist || '').toLowerCase() === nameLower)
            || searchData.artists[0];

        const idArtist = artist.idArtist;
        if (!idArtist) return null;

        const artistTarget = `https://www.theaudiodb.com/api/v1/json/123/artist.php?i=${idArtist}`;
        const artistData = await _fetchJsonViaProxy(artistTarget);

        if (!artistData || !Array.isArray(artistData.artists) || artistData.artists.length === 0) {
            return {
                biography: artist.strBiographyEN || '',
                thumbnail: artist.strArtistThumb || null,
                genre: artist.strGenre || null,
                country: artist.strCountry || null,
                formedYear: artist.intFormedYear || null,
                idArtist
            };
        }

        const full = artistData.artists[0];

        return {
            biography: full.strBiographyEN || artist.strBiographyEN || '',
            thumbnail: full.strArtistThumb || artist.strArtistThumb || null,
            genre: full.strGenre || artist.strGenre || null,
            country: full.strCountry || artist.strCountry || null,
            formedYear: full.intFormedYear || artist.intFormedYear || null,
            idArtist
        };
    } catch (e) {
        console.warn('TheAudioDB fetch failed:', e);
        return null;
    }
}

function _applyAudiodbResult(artistName, result) {
    if (!artistName || !result) return;

    const patch = {
        bioFetched: true,
        bioFetchedVersion: AUDIODB_CACHE_VERSION
    };

    const meta = _getArtistMeta(artistName);
    if (!meta.bioManual && result.biography) {
        patch.bio = result.biography;
    }

    if (result.thumbnail) patch.audiodbThumb = result.thumbnail;
    if (result.idArtist) patch.audiodbId = result.idArtist;
    if (result.genre) patch.audiodbGenre = result.genre;
    if (result.country) patch.audiodbCountry = result.country;
    if (result.formedYear) patch.audiodbYear = result.formedYear;

    _setArtistMeta(artistName, patch);
}


function _artistRegionIdx(name, tracks) {
    const meta = _getArtistMeta(name);
    if (meta.region != null && meta.region >= 0) return meta.region;

    for (const t of tracks) {
        if (t.region != null && t.region >= 0) return t.region;
    }

    if (typeof guessRegionFromArtist === 'function') {
        const auto = guessRegionFromArtist(name);
        if (auto >= 0) return auto;
    }
    return -1;
}

function openArtistPage(artistName) {
    if (!artistName) return;
    const page = document.getElementById('page-artist');
    if (!page) return;

    const current = document.querySelector('.rn-btn.active')?.dataset.page || 'home';
    _artistReturnPage = (current === 'artist') ? 'home' : current;

    _artistCurrent = artistName;

    document.querySelectorAll('.rn-btn[data-page]').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    page.classList.add('active');

    renderArtistPage(artistName);
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function closeArtistPage() {
    const returnPage = _artistReturnPage || 'home';
    const targetNav = document.querySelector(`.rn-btn[data-page="${returnPage}"]`);
    if (targetNav) {
        targetNav.click();
    } else {
        document.querySelector('.rn-btn[data-page="home"]')?.click();
    }
}

function renderArtistPage(artistName) {
    if (!artistName) return;

    const clean = String(artistName).trim();
    const tracks = _artistTracks(clean);
    const meta = _getArtistMeta(clean);
    const regionIdx = _artistRegionIdx(clean, tracks);

    const nameEl = document.getElementById('artistPageName');
    if (nameEl) nameEl.textContent = clean;

    const avImg = document.getElementById('artistPageAvatarImg');
    const avLetter = document.getElementById('artistPageAvatarLetter');
    if (avImg && avLetter) {
        const imgSrc = meta.avatar || meta.audiodbThumb;
        if (imgSrc) {
            avImg.src = imgSrc;
            avImg.hidden = false;
            avLetter.hidden = true;
        } else {
            avImg.hidden = true;
            avLetter.hidden = false;
            avLetter.textContent = clean.charAt(0).toUpperCase();
        }
    }

    const bgEl = document.getElementById('artistPageHeroBg');
    if (bgEl) {
        const firstCoverTrack = tracks.find(t => audioEngine.ensureCoverUrl(t));
        if (firstCoverTrack) {
            const url = audioEngine.ensureCoverUrl(firstCoverTrack);
            bgEl.style.backgroundImage = `url("${url}")`;
            bgEl.classList.add('active');
        } else {
            bgEl.classList.remove('active');
            bgEl.style.backgroundImage = '';
        }
    }

    const regionEl = document.getElementById('artistPageRegion');
    if (regionEl) {
        if (regionIdx >= 0 && typeof REGION_NAMES !== 'undefined') {
            const icon = (typeof REGION_ICONS !== 'undefined' && REGION_ICONS[regionIdx]) || '🌍';
            regionEl.textContent = `${icon} ${REGION_NAMES[regionIdx]}`;
        } else {
            regionEl.textContent = '';
        }
    }

    const stats = document.getElementById('artistPageStats');
    if (stats) {
        const totalPlays = tracks.reduce((s, t) => s + (t.playCount || 0), 0);
        const totalSeconds = tracks.reduce((s, t) => s + (t.duration || 0) * (t.playCount || 0), 0);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const timeStr = hours > 0 ? `${hours}ч ${minutes}м` : `${minutes}м`;
        stats.innerHTML = `
            <b>${tracks.length}</b> ${pluralTracks(tracks.length)}
            · <b>${totalPlays}</b> ${pluralPlays(totalPlays)}
            · <b>${timeStr}</b> прослушано
        `;
        stats.querySelectorAll('b').forEach(b => {
            b.style.color = 'var(--y)';
            b.style.fontFamily = "'JetBrains Mono', monospace";
        });
    }

    const bioEl = document.getElementById('artistPageBio');
    if (bioEl) {
        if (meta.bio) {
            bioEl.textContent = meta.bio;
            bioEl.style.opacity = '0.85';
        } else {
            bioEl.textContent = '';
        }
    }

    const wikiBtn = document.getElementById('artistPageWikiBtn');
    if (wikiBtn) {
        const customUrl = (meta.wikiUrl || '').trim();
        if (customUrl) {
            wikiBtn.href = customUrl;
        } else {
            wikiBtn.href = `https://ru.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(clean)}`;
        }
    }

    renderArtistPageTracks(tracks);
}

function renderArtistPageTracks(tracks) {
    const listEl = document.getElementById('artistPageTracks');
    const countEl = document.getElementById('artistPageTracksCount');
    if (!listEl) return;

    if (countEl) countEl.textContent = tracks.length > 0 ? String(tracks.length) : '';

    listEl.innerHTML = '';

    if (tracks.length === 0) {
        listEl.innerHTML = `<div class="artist-page-empty">У этого артиста нет треков в библиотеке</div>`;
        return;
    }

    tracks.forEach((track, i) => {
        const row = document.createElement('div');
        row.className = 'artist-track-row';

        const coverUrl = audioEngine.ensureCoverUrl(track);
        const coverStyle = coverUrl
            ? `style="background-image:url('${coverUrl}');background-size:cover;background-position:center"`
            : '';
        const coverClass = coverUrl ? 'artist-track-cover has-image' : 'artist-track-cover';
        const dur = track.duration ? audioEngine.formatTime(track.duration) : '';
        const plays = track.playCount || 0;

        row.innerHTML = `
            <div class="artist-track-num">${i + 1}</div>
            <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
            <div class="artist-track-info">
                <div class="artist-track-title">${escapeHtml(track.title)}</div>
                <div class="artist-track-meta">
                    ${plays > 0 ? `<span class="artist-track-plays">${plays} ${pluralPlays(plays)}</span>` : ''}
                    ${track.region >= 0 && typeof REGION_NAMES !== 'undefined' ? `<span>${REGION_NAMES[track.region]}</span>` : ''}
                </div>
            </div>
            ${dur ? `<div class="artist-track-dur">${dur}</div>` : ''}
            <button class="artist-track-play" aria-label="Играть">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </button>
        `;

        row.addEventListener('click', () => {
            const idx = audioEngine.playlist.indexOf(track);
            if (idx < 0) return;
            audioEngine.currentIndex = idx;
            audioEngine.loadCurrentTrack();
            audioEngine.play();
            document.querySelector('.nav-item[data-page="home"]')?.click();
        });

        listEl.appendChild(row);
    });
}

function closeArtistModal() { closeArtistPage(); }

window.openArtistPage = openArtistPage;
window.closeArtistPage = closeArtistPage;
window.closeArtistModal = closeArtistModal;
window.renderArtistPage = renderArtistPage;

function buildChartPlaylists() {
    const grid = document.getElementById('playlistsGrid');
    if (!grid) return;

    const lib = window.audioEngine?.playlist || [];
    const lists = [];

    const topPlayed = [...lib]
        .filter(t => (t.playCount || 0) > 0)
        .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
        .slice(0, 20);
    if (topPlayed.length > 0) {
        lists.push({ key: 'leader', icon: '🔥', name: 'Лидеры', desc: 'Самые прослушиваемые', tracks: topPlayed });
    }

    const fresh = [...lib]
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 20);
    if (fresh.length > 0) {
        lists.push({ key: 'fresh', icon: '✨', name: 'Свежак', desc: 'Недавно добавленные', tracks: fresh });
    }

    const unheard = lib
        .filter(t => (t.playCount || 0) === 0)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 20);
    if (unheard.length > 0) {
        lists.push({ key: 'unheard', icon: '🔍', name: 'Нетронутое', desc: 'Ещё не слушали', tracks: unheard });
    }

    if (lib.length > 0) {
        const daySeed = new Date().toISOString().slice(0, 10);
        const pool = [...lib];
        let seed = 0;
        for (let i = 0; i < daySeed.length; i++) seed = (seed * 31 + daySeed.charCodeAt(i)) >>> 0;
        for (let i = pool.length - 1; i > 0; i--) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            const j = seed % (i + 1);
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const mixed = pool.slice(0, 20);
        lists.push({ key: 'mix', icon: '🎲', name: 'Микс дня', desc: 'Случайная двадцатка', tracks: mixed });
    }

    if (lists.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">★</div>
                <div class="empty-state-title">Подборок пока нет</div>
                <div class="empty-state-text">Загрузите треки — подборки появятся автоматически</div>
            </div>
        `;
        return;
    }

    grid.innerHTML = '';
    lists.forEach(pl => {
        const card = document.createElement('div');
        card.className = 'chart-playlist-card';
        card.innerHTML = `
            <div class="chart-playlist-cover pattern-${pl.key}">
                <span class="chart-playlist-icon">${pl.icon}</span>
            </div>
            <div class="chart-playlist-info">
                <div class="chart-playlist-name">${escapeHtml(pl.name)}</div>
                <div class="chart-playlist-desc">${escapeHtml(pl.desc)}</div>
                <div class="chart-playlist-count">${pl.tracks.length} ${pluralTracks(pl.tracks.length)}</div>
            </div>
        `;
        card.addEventListener('click', () => playTrackList(pl.tracks, pl.name));
        grid.appendChild(card);
    });
}

function buildTop100() {
    const list = document.getElementById('top100List');
    if (!list) return;

    const top = getTopTracks(100);
    if (top.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">#</div>
                <div class="empty-state-title">Чарт пуст</div>
                <div class="empty-state-text">Слушайте музыку — здесь появится топ по прослушиваниям</div>
            </div>
        `;
        return;
    }

    list.innerHTML = '';
    top.forEach((track, i) => {
        const row = document.createElement('div');
        row.className = 'track-item-chart';
        const coverUrl = audioEngine.ensureCoverUrl(track);
        const coverStyle = coverUrl
            ? `style="background-image:url('${coverUrl}');background-size:cover;background-position:center"`
            : '';
        const coverClass = coverUrl ? 'track-cover-chart has-image' : 'track-cover-chart';
        const dur = track.duration ? audioEngine.formatTime(track.duration) : '';
        const plays = track.playCount || 0;

        row.innerHTML = `
            <div class="track-number-chart">${i + 1}</div>
            <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
            <div class="track-details-chart">
                <div class="track-name-chart">${escapeHtml(track.title)}</div>
                <div class="track-artist-chart">
                    <span class="artist-link" data-artist="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</span>
                </div>
            </div>
            <div class="track-plays-chart" title="Прослушиваний">
                <span class="track-plays-num">${plays}</span>
                <span class="track-plays-label">${pluralPlays(plays)}</span>
            </div>
            ${dur ? `<div class="track-duration-chart">${dur}</div>` : ''}
            <button class="track-play-btn" aria-label="Играть">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </button>
        `;

        row.addEventListener('click', (e) => {
            const artistEl = e.target.closest('.artist-link');
            if (artistEl) {
                e.stopPropagation();
                const artist = artistEl.dataset.artist;
                if (typeof openArtistPage === 'function') {
                    openArtistPage(artist);
                }
                return;
            }
            const idx = audioEngine.playlist.indexOf(track);
            if (idx < 0) return;
            audioEngine.currentIndex = idx;
            audioEngine.loadCurrentTrack();
            audioEngine.play();
        });

        list.appendChild(row);
    });
}

function playTrackList(tracks, name) {
    if (!tracks || tracks.length === 0) {
        showNotification('Список пуст', true);
        return;
    }
    const lib = audioEngine.playlist;
    const ids = new Set(tracks.map(t => t.id));
    const rest = lib.filter(t => !ids.has(t.id));

    audioEngine.playlist = [...tracks, ...rest];
    audioEngine.currentIndex = 0;
    audioEngine.loadCurrentTrack();
    audioEngine.play();

    if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
    if (window.trackQueue) window.trackQueue.render();

    const homeBtn = document.querySelector('.nav-item[data-page="home"]');
    if (homeBtn && !homeBtn.classList.contains('active')) homeBtn.click();

    showNotification(`▶️ ${name}: ${tracks.length} ${pluralTracks(tracks.length)}`);
}
window.playTrackList = playTrackList;
window.buildChartPlaylists = buildChartPlaylists;
window.buildTop100 = buildTop100;

function buildPlaylistsModal() {
    const grid = document.getElementById('playlistGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const realPlaylists = playlistManager ? playlistManager.getAllPlaylists() : [];

    if (realPlaylists.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--text-secondary);">
                <div style="font-size: 64px; margin-bottom: 16px; opacity: 0.4;">🎵</div>
                <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px; color: var(--text-primary);">Плейлистов пока нет</div>
                <div style="font-size: 14px; max-width: 420px; margin: 0 auto;">
                    Кликните правой кнопкой мыши по треку и выберите
                    «Добавить в плейлист» → «Создать новый плейлист»
                </div>
            </div>
        `;
        return;
    }

    realPlaylists.forEach((playlist) => {
        const card = document.createElement('div');
        card.className = 'playlist-card glass';
        card.style.position = 'relative';
        card.innerHTML = `
            <div class="playlist-cover">🎵</div>
            <div class="playlist-info">
                <div class="playlist-name">${escapeHtml(playlist.name)}</div>
                <div class="playlist-count">${playlist.tracks.length} ${pluralTracks(playlist.tracks.length)}</div>
            </div>
            <button class="playlist-delete-btn" title="Удалить плейлист" style="
                position: absolute; top: 10px; right: 10px;
                width: 34px; height: 34px; border-radius: 50%;
                background: rgba(255, 59, 48, 0.9); border: none; color: #fff;
                font-size: 20px; line-height: 1; font-weight: 700; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                opacity: 0; transition: opacity 0.2s ease, transform 0.2s ease;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 2;
            ">×</button>
        `;

        const delBtn = card.querySelector('.playlist-delete-btn');
        card.addEventListener('mouseenter', () => {
            delBtn.style.opacity = '1';
            delBtn.style.transform = 'scale(1.05)';
        });
        card.addEventListener('mouseleave', () => {
            delBtn.style.opacity = '0';
            delBtn.style.transform = 'scale(1)';
        });

        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`Удалить плейлист "${playlist.name}"?`)) {
                playlistManager.deletePlaylist(playlist.id);
                buildPlaylistsModal();
                updatePlaylistCounters();
                showNotification(`🗑️ Плейлист "${playlist.name}" удалён`);
            }
        });

        card.addEventListener('click', () => {
            playPlaylist(playlist);
        });

        grid.appendChild(card);
    });
}

function updatePlaylistCounters() {
    const countEl = document.getElementById('playlistCount');
    if (countEl && playlistManager) {
        const n = playlistManager.getPlaylistCount();
        const word = n === 1 ? 'плейлист' : (n >= 2 && n <= 4 ? 'плейлиста' : 'плейлистов');
        updateCounter(countEl, n, word);
    }
    if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();
    if (typeof renderLibraryPlaylists === 'function') renderLibraryPlaylists();
}

function openPlaylistsModal() {
    buildPlaylistsModal();
    document.getElementById('playlistsModal').classList.add('active');
}
window.openPlaylistsModal = openPlaylistsModal;

function playPlaylist(playlist) {
    if (!playlist.tracks || playlist.tracks.length === 0) {
        showNotification('В плейлисте пока нет треков', true);
        return;
    }

    const library = audioEngine.playlist;
    const byId = new Map(library.map(t => [t.id, t]));

    const playlistTracks = [];
    const missing = [];
    playlist.tracks.forEach(pt => {
        const live = byId.get(pt.id);
        if (live) playlistTracks.push(live);
        else missing.push(pt.title || pt.id);
    });

    if (playlistTracks.length === 0) {
        showNotification('Треки из плейлиста не найдены в библиотеке', true);
        return;
    }

    const playlistIds = new Set(playlistTracks.map(t => t.id));
    const rest = library.filter(t => !playlistIds.has(t.id));

    audioEngine.playlist = [...playlistTracks, ...rest];
    audioEngine.currentIndex = 0;
    audioEngine.loadCurrentTrack();
    audioEngine.play();

    if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
    if (window.trackQueue) window.trackQueue.render();

    closeModal('playlistsModal');
    document.querySelector('[data-page="home"]').click();

    const msg = missing.length
        ? `▶️ "${playlist.name}" — ${missing.length} треков не найдено`
        : `▶️ Воспроизведение плейлиста "${playlist.name}"`;
    showNotification(msg);
}
window.playPlaylist = playPlaylist;

let _stageCoverBeforeEco = null;

function applyStageMode(showCover, opts = {}) {
    const stageColumn = document.getElementById('stageColumn');
    const stageToggle = document.getElementById('stageToggle');
    const stageLabel  = document.getElementById('stageToggleLabel');
    if (!stageColumn) return;

    const currentlyCover = stageColumn.classList.contains('show-cover');
    if (currentlyCover === showCover && !opts.force) return;

    stageColumn.classList.toggle('show-cover', showCover);

    if (stageLabel) {
        const newText = showCover ? 'Мир' : 'Обложка';
        if (opts.animate === false || !stageLabel.textContent.trim()) {
            stageLabel.textContent = newText;
        } else {
            stageLabel.classList.add('is-out');
            setTimeout(() => {
                stageLabel.textContent = newText;
                stageLabel.classList.remove('is-out');
                stageLabel.classList.add('is-in');
                void stageLabel.offsetWidth;
                stageLabel.classList.remove('is-in');
            }, 320);
        }
    }

    stageToggle?.classList.remove('hint-visible');

    if (showCover) {
        window.globeView?.stop();
    } else {
        const g = ensureGlobe();
        if (g) {
            g.onRegionSelect = (regionIdx) => openRegionPage(regionIdx);
            setTimeout(() => { g.resize(); g.start(); }, 250);
        }
    }
}
window.applyStageMode = applyStageMode;

function applyBackgroundDisabled(disabled) {
    const toggle = document.getElementById('disableBgToggle');
    if (toggle) toggle.checked = !!disabled;

    document.body.classList.toggle('bg-disabled', !!disabled);

    if (!window.backgroundSystem) return;

    if (disabled) {
        backgroundSystem.stop();
    } else if (!isEcoMode) {
        backgroundSystem.start();
    }
}
window.applyBackgroundDisabled = applyBackgroundDisabled;

function toggleEcoMode(enabled) {
    isEcoMode = enabled;
    document.body.classList.toggle('eco-mode', enabled);
    const statusText = document.getElementById('ecoStatusText');
    if (statusText) {
        statusText.textContent = enabled ? 'Включен' : 'Выключен';
        statusText.style.color = enabled ? '#4CAF50' : '#ff3b30';
    }

    if (enabled) {
        visualizer.stop();
        backgroundSystem.stop();

        const stageColumn = document.getElementById('stageColumn');
        if (stageColumn) {
            _stageCoverBeforeEco = stageColumn.classList.contains('show-cover');
            applyStageMode(true, { animate: false });
        }
    } else {
        if (!document.getElementById('disableBgToggle')?.checked) {
            backgroundSystem.start();
        }
        if (audioEngine.isPlaying) visualizer.start();

        if (window.miniViz) window.miniViz._start();

        if (_stageCoverBeforeEco === false) {
            applyStageMode(false, { animate: false });
        }
        _stageCoverBeforeEco = null;
    }

    localStorage.setItem('ecoMode', enabled ? '1' : '0');
}

function loadEcoState() {
    if (localStorage.getItem('ecoMode') === '1') {
        document.getElementById('ecoToggle').checked = true;
        toggleEcoMode(true);
    }
}

 
function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}
window.closeModal = closeModal;

function openLikedModal() {
    const list = document.getElementById('likedTrackList');
    list.innerHTML = '';
    if (audioEngine.playlist.length === 0) {
        list.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-secondary);">Загрузите треки на странице "Моя музыка"</div>';
    } else {
        audioEngine.playlist.forEach((track, i) => {
            const item = document.createElement('div');
            item.className = 'track-item';
            item.style.setProperty('--i', i);
            item.innerHTML = `
                <div class="track-number">${i + 1}</div>
                <div class="track-cover">🎵</div>
                <div class="track-details">
                    <div class="track-name">${track.title}</div>
                    <div class="track-artist-name">${track.artist}</div>
                </div>
                <div class="track-actions">
                    <button class="action-btn" onclick="playFromModal(${i}); event.stopPropagation();">▶️</button>
                </div>
            `;
            item.addEventListener('click', () => {
                playFromModal(i);
                closeModal('likedModal');
            });
            list.appendChild(item);
        });
    }
    document.getElementById('likedModal').classList.add('active');
}

window.playFromModal = playFromModal;

const WEB3FORMS_KEY = '01027621-2d58-4091-98aa-6f3584033e63';

function openSupportModal() {
    const modal = document.getElementById('supportModal');
    if (!modal) return;
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const nameField = document.getElementById('supportName');
    const emailField = document.getElementById('supportEmail');

    if (user.name && !nameField.value) nameField.value = user.name;
    if (user.email && !emailField.value) emailField.value = user.email;

    document.getElementById('supportStatus').textContent = '';
    document.getElementById('supportStatus').className = 'support-status';
    document.getElementById('errSupportEmail').textContent = '';
    document.getElementById('errSupportMessage').textContent = '';

    modal.classList.add('active');

    setTimeout(() => document.getElementById('supportMessage')?.focus(), 300);
}
window.openSupportModal = openSupportModal;

function setupSupportForm() {
    const form = document.getElementById('supportForm');
    if (!form) return;

    const textarea = document.getElementById('supportMessage');
    const counter  = document.getElementById('supportCharCount');
    textarea?.addEventListener('input', () => {
        counter.textContent = textarea.value.length;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const status = document.getElementById('supportStatus');
        const submit = document.getElementById('supportSubmit');

        const name    = document.getElementById('supportName').value.trim();
        const email   = document.getElementById('supportEmail').value.trim();
        const topic   = document.getElementById('supportTopic').value;
        const message = textarea.value.trim();
        const bot     = document.getElementById('supportBotCheck').checked;

        let ok = true;
        document.getElementById('errSupportEmail').textContent = '';
        document.getElementById('errSupportMessage').textContent = '';

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            document.getElementById('errSupportEmail').textContent = 'Некорректный email';
            ok = false;
        }
        if (message.length < 10) {
            document.getElementById('errSupportMessage').textContent = 'Минимум 10 символов';
            ok = false;
        }
        if (!ok) return;

        if (bot) {
            status.textContent = 'Отправлено';
            status.className = 'support-status ok';
            return;
        }

        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const payload = {
            access_key: WEB3FORMS_KEY,
            subject: `[mbox] ${topic} — ${name || 'без имени'}`,
            from_name: 'mbox — форма поддержки',

            Имя: name || '—',
            Email: email,
            Ник_на_сайте: user.username ? '@' + user.username : '—',
            Тема: topic,
            Сообщение: message,

            Браузер: navigator.userAgent,
            Страница: location.pathname,
            Время: new Date().toLocaleString('ru-RU'),
            replyto: email,
        };

        submit.classList.add('loading');
        submit.disabled = true;
        submit.textContent = 'Отправка…';
        status.textContent = '';

        try {
            const res = await fetch('https://api.web3forms.com/submit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (data.success) {
                status.textContent = '✅ Сообщение отправлено. Спасибо!';
                status.className = 'support-status ok';

                form.reset();
                counter.textContent = '0';

                setTimeout(() => {
                    document.getElementById('supportModal')?.classList.remove('active');
                }, 2500);
            } else {
                throw new Error(data.message || 'Ошибка отправки');
            }
        } catch (err) {
            console.warn('support send failed:', err);
            status.textContent = '❌ Не удалось отправить. Попробуйте позже.';
            status.className = 'support-status error';
        } finally {
            submit.classList.remove('loading');
            submit.disabled = false;
            submit.textContent = 'Отправить';
        }
    });
}

function playFromModal(index) {
    audioEngine.currentIndex = index;
    audioEngine.loadCurrentTrack();
    audioEngine.play();
}
window.playFromModal = playFromModal;

function cleanTrackQuery(str) {
    return String(str || '')
        .replace(/\(feat\.?[^)]*\)/gi, '')
        .replace(/\[feat\.?[^\]]*\]/gi, '')
        .replace(/\(ft\.?[^)]*\)/gi, '')
        .replace(/\[ft\.?[^\]]*\]/gi, '')
        .replace(/\((?:official|lyric|audio|video|clip|remix|radio|edit)[^)]*\)/gi, '')
        .replace(/\[(?:official|lyric|audio|video|clip|remix|radio|edit)[^\]]*\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function primaryArtist(artist) {
    return String(artist || '').split(',')[0].trim();
}

function parseLRC(lrc) {
    if (!lrc) return null;

    const lines = [];
    const lineRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

    for (const raw of String(lrc).split(/\r?\n/)) {
        const marks = [];
        let m;
        lineRe.lastIndex = 0;
        while ((m = lineRe.exec(raw)) !== null) {
            const mm = parseInt(m[1], 10) || 0;
            const ss = parseInt(m[2], 10) || 0;
            const frac = (m[3] || '0').padEnd(3, '0').slice(0, 3);
            const ms = parseInt(frac, 10) || 0;
            marks.push(mm * 60 + ss + ms / 1000);
        }
        if (!marks.length) continue;

        const text = raw.replace(lineRe, '').trim();
        for (const t of marks) {
            lines.push({ time: t, text: text || '\u00A0' });
        }
    }

    if (!lines.length) return null;
    lines.sort((a, b) => a.time - b.time);
    return lines;
}

function geniusSearchUrl(artist, title) {
    const q = encodeURIComponent(`${cleanTrackQuery(artist)} ${cleanTrackQuery(title)}`.trim());
    return `https://genius.com/search?q=${q}`;
}

async function fetchLyrics(artist, name, trackDuration) {
    if (!trackDuration || isNaN(trackDuration)) {
        trackDuration = window.audioEngine?.audio?.duration || 0;
    }

    const hasArtist = artist && artist.length > 1 && !artist.toLowerCase().includes('неизвест');
    const query = hasArtist ? `${artist} ${name}` : name;
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;

    let results = null;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 12000);
            const r = await fetch(url, {
                signal: ctrl.signal,
                headers: { 'Accept': 'application/json' }
            });
            clearTimeout(t);
            
            if (r.ok) {
                results = await r.json();
                break; // Успех, выходим из цикла
            }
        } catch (e) {
            console.warn(`[Lyrics] Попытка ${attempt + 1} не удалась:`, e.message);
            if (attempt === 0) await new Promise(res => setTimeout(res, 1000)); // Ждем 1 сек перед повтором
        }
    }

    if (!Array.isArray(results) || results.length === 0) return null;
    
    const artistL = artist.toLowerCase().trim();
    const nameL   = name.toLowerCase().trim();
    
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
    const artistN = norm(artistL);
    const nameN   = norm(nameL);

    const hasValidDuration = typeof trackDuration === 'number' && !isNaN(trackDuration) && trackDuration > 0;

    const scored = results
        .filter(r => r.plainLyrics || r.syncedLyrics)
        .map(r => {
            const rArtist = norm(r.artistName);
            const rTrack  = norm(r.trackName);
            let score = 0;

            const isArtistMatch = rArtist.includes(artistN) || artistN.includes(rArtist);
            if (hasArtist && !isArtistMatch) {
                score -= 100; 
            } else if (isArtistMatch) {
                score += 15;
            }

            if (hasValidDuration && r.duration) {
                const diff = Math.abs(trackDuration - r.duration);
                if (diff > 30) {
                    score -= 100; 
                } else if (diff <= 3) {
                    score += 10;
                } else if (diff <= 10) {
                    score += 5;
                }
            }

            if (rTrack === nameN) {
                score += 10;
            } else if (rTrack.includes(nameN) || nameN.includes(rTrack)) {
                score += 4;
            } else {
                score -= 20;
            }

            if (r.syncedLyrics) score += 3;

            return { r, score };
        })
        .sort((a, b) => b.score - a.score);

    const validMatches = scored.filter(item => item.score > -50);
    return validMatches.length > 0 ? validMatches[0].r : null;
}

const LyricsView = {
    scroller: null,
    linesEl: null,
    lineEls: [],
    raf: null,
    bound: false,
    _scrollBound: false,
    _controlsSnapshot: null,

    init() {
        this.scroller = document.getElementById('lyricsScroller');
        this.linesEl  = document.getElementById('lyricsLines');
        if (!this.scroller || !this.linesEl) return;

        this._onScroll = this._onScroll.bind(this);
        this._onResize = this._onResize.bind(this);
        window.addEventListener('resize', this._onResize);
        this.bound = true;
    },

    reset() {
        const stage = document.getElementById('lyricsStage');
        if (stage) stage.classList.remove('revealed');
        if (this.linesEl) this.linesEl.innerHTML = '';
        this.lineEls = [];
        if (this.scroller) this.scroller.scrollTop = 0;
        this.restorePlayerControls();
        this._syncLines = null;
        this._activeIdx = -1;
        this._scrolledIdx = -1;
        this._userScrollUntil = 0;
        this._stopSync();
    },

    clearLines() {
        if (this.linesEl) this.linesEl.innerHTML = '';
        this.lineEls = [];
        if (this.scroller) this.scroller.scrollTop = 0;
        const src = document.getElementById('lyricsSource');
        if (src) src.innerHTML = '';
    },

    setCover(track) {
        const coverEl = document.getElementById('lyricsCover');
        if (!coverEl) return;
        coverEl.innerHTML = '';
        const url = window.audioEngine?.ensureCoverUrl(track);
        if (url) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            coverEl.appendChild(img);
        } else {
            const ph = document.createElement('div');
            ph.className = 'lyrics-cover-ph';
            ph.textContent = '♪';
            coverEl.appendChild(ph);
        }
    },

    setMeta(track) {
        const t = document.getElementById('lyricsMetaTitle');
        const a = document.getElementById('lyricsMetaArtist');
        if (t) t.textContent = track.title;
        if (a) a.textContent = track.artist;
    },
    stealPlayerControls() {
        if (window.innerWidth < 720) return;
        if (this._controlsSnapshot) return;

        const buttonsSlot = document.getElementById('lyricsPlayerButtons');
        const volumeSlot  = document.getElementById('lyricsPlayerVolume');
        if (!buttonsSlot || !volumeSlot) return;

        const moves = [];
        ['prevBtn', 'mainPlayBtn', 'nextBtn'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el || !el.parentElement) return;

            const marker = document.createComment('lyrics-return-' + id);
            el.parentElement.insertBefore(marker, el);
            moves.push({ el, marker });

            buttonsSlot.appendChild(el);
        });

        const vol = document.querySelector('.main-content > .volume-control');
        if (vol && vol.parentElement) {
            const marker = document.createComment('lyrics-return-volume');
            vol.parentElement.insertBefore(marker, vol);
            moves.push({ el: vol, marker });

            volumeSlot.appendChild(vol);
        }

        this._controlsSnapshot = moves;
    },

    restorePlayerControls() {
        if (!this._controlsSnapshot) return;
        for (let i = this._controlsSnapshot.length - 1; i >= 0; i--) {
            const m = this._controlsSnapshot[i];
            try {
                if (m.marker && m.marker.parentElement) {
                    m.marker.parentElement.insertBefore(m.el, m.marker);
                    m.marker.remove();
                }
            } catch (e) {
                console.warn('restore player control failed:', e);
            }
        }
        this._controlsSnapshot = null;
    },

    setStatus(html) {
        const s = document.getElementById('lyricsStatus');
        if (s) s.innerHTML = html;
    },

    showLoading() {
        this.setStatus(`
            <div class="lyrics-spinner"></div>
            <div class="lyrics-status-text">Поиск текста…</div>
        `);
    },

    showNotFound(title, text, track) {
        const stage = document.getElementById('lyricsStage');
        if (stage) stage.classList.remove('revealed');

        const geniusUrl = track ? geniusSearchUrl(track.artist, track.title) : null;
        this.setStatus(`
            <div class="lyrics-notfound-title">${title}</div>
            <div class="lyrics-notfound-text">${text}</div>
            ${geniusUrl ? `
                <a class="lyrics-action-btn" href="${geniusUrl}" target="_blank" rel="noopener">
                    <svg viewBox="0 0 24 24"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z"/></svg>
                    Найти на Genius
                </a>` : ''}
        `);
    },

    renderLyrics(text, sourceUrl, syncLines) {
        if (!this.linesEl) return;
        const raw = String(text).split(/\r?\n/);
        this.linesEl.innerHTML = '';
        this.lineEls = [];

        this._currentText        = text;
        this._currentSourceUrl   = sourceUrl;
        this._currentSyncLines   = syncLines;

        const anim    = (window.LyricsScene && window.LyricsScene.settings && window.LyricsScene.settings.anim)    || 'stagger';
        const karaoke = (window.LyricsScene && window.LyricsScene.settings && window.LyricsScene.settings.karaoke) || 'glow';
        this.linesEl.dataset.anim = anim;

        const needsChars = anim === 'typewriter' || karaoke === 'wave' || karaoke === 'bounce';

        raw.forEach((line, i) => {
            const el = document.createElement('div');
            el.className = 'lyrics-line';
            el.dataset.idx = i;

            const content = line.length === 0 ? '\u00A0' : line;

            if (needsChars) {
                el.style.setProperty('--li', i);
                [...content].forEach((ch, ci) => {
                    const span = document.createElement('span');
                    span.className = 'ly-char';
                    span.style.setProperty('--ci', ci);
                    span.textContent = ch === ' ' ? '\u00A0' : ch;
                    el.appendChild(span);
                });
            } else {
                el.textContent = content;
            }

            el.style.setProperty('--i', Math.min(i, 20));

            el.addEventListener('click', () => this._seekToLine(i));

            if (window.LyricsScene) {
                const s = window.LyricsScene.settings;
                el.style.fontFamily = `'${s.font}', sans-serif`;
                el.style.fontSize   = (20 * (s.size || 1)).toFixed(1) + 'px';
            }

            this.linesEl.appendChild(el);
            this.lineEls.push(el);
        });

        this._syncLines = syncLines || null;
        this._activeIdx = -1;
        this._scrolledIdx = -1;
        this._userScrollUntil = 0;

        if (typeof LyricsScene !== 'undefined' && LyricsScene.updateOffsetUI) {
            const track = window.audioEngine?.playlist?.[window.audioEngine.currentIndex];
            LyricsScene.updateOffsetUI((track && track.lyricsOffset) || 0);
        }

        const srcEl = document.getElementById('lyricsSource');
        if (srcEl) {
            const syncedTag = this._syncLines
                ? ` · <span style="color:var(--y)">синхр.</span>`
                : '';
            srcEl.innerHTML = sourceUrl
                ? `Источник: <a href="${sourceUrl}" target="_blank" rel="noopener">LRCLIB</a>${syncedTag}`
                : '';
        }

        this._startSync();
    },

    reveal() {
        const stage = document.getElementById('lyricsStage');
        if (!stage) return;
        this._updatePadding();
        if (this.scroller) this.scroller.scrollTop = 0;
        this.stealPlayerControls();
        stage.classList.add('revealed');

        if (this.scroller && !this._scrollBound) {
            this.scroller.addEventListener('scroll', this._onScroll, { passive: true });
            this._bindUserScroll();
            this._scrollBound = true;
        }

        requestAnimationFrame(() => this._updateFocus());
        this._startSync();
    },

    _updatePadding() {
        if (!this.scroller || !this.linesEl) return;
        const h = this.scroller.clientHeight || 480;
        const pad = Math.max(60, h / 2 - 30);
        this.linesEl.style.paddingTop    = pad + 'px';
        this.linesEl.style.paddingBottom = pad + 'px';
    },

    _onScroll() {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = null;
            this._updateFocus();
        });
    },

    _onResize() {
        if (!document.getElementById('lyricsStage')?.classList.contains('revealed')) return;
        this._updatePadding();
        this._updateFocus();
    },

    _updateFocus() {
        if (!this.scroller || !this.lineEls.length) return;

        const scRect = this.scroller.getBoundingClientRect();
        const centerY = scRect.top + scRect.height / 2;
        const maxDist = scRect.height / 2;

        for (const line of this.lineEls) {
            const r = line.getBoundingClientRect();
            const lc = r.top + r.height / 2;
            const dist = Math.abs(lc - centerY);
            const p = Math.min(dist / maxDist, 1);
            const scale   = 1 - p * 0.30;
            const opacity = 1 - p * 0.82;
            const xShift  = p * 12;
            const blur    = p * 0.6;

            line.style.transform = `translateX(${xShift.toFixed(1)}px) scale(${scale.toFixed(3)})`;
            line.style.opacity   = opacity.toFixed(3);
            line.style.filter    = blur > 0.1 ? `blur(${blur.toFixed(2)}px)` : '';
        }
    },

    _bindUserScroll() {
        if (!this.scroller) return;
        const markUserScroll = () => {
            this._userScrollUntil = Date.now() + 4000;
        };
        this.scroller.addEventListener('wheel',       markUserScroll, { passive: true });
        this.scroller.addEventListener('touchstart',  markUserScroll, { passive: true });
        this.scroller.addEventListener('touchmove',   markUserScroll, { passive: true });
        this.scroller.addEventListener('mousedown',   markUserScroll, { passive: true });
        this.scroller.addEventListener('keydown',     markUserScroll, { passive: true });
    },

    _startSync() {
        if (this._syncRaf) return;
        this._syncRaf = requestAnimationFrame(() => this._syncTick());
    },

    _stopSync() {
        if (this._syncRaf) {
            cancelAnimationFrame(this._syncRaf);
            this._syncRaf = null;
        }
    },

    _syncTick() {
        const lines = this._syncLines;
        if (!lines || !lines.length) {
            this._syncRaf = null;
            return;
        }

        const stage = document.getElementById('lyricsStage');
        if (!stage || !stage.classList.contains('revealed')) {
            this._syncRaf = null;
            return;
        }

        this._syncRaf = requestAnimationFrame(() => this._syncTick());

        const audio = window.audioEngine?.audio;
        if (!audio) return;

        const track = window.audioEngine?.playlist?.[window.audioEngine.currentIndex];
        const offset = (track && track.lyricsOffset) || 0;
        const t = audio.currentTime + offset;
        const LEAD = 0.25;

        let scrollIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].time <= t + LEAD) { scrollIdx = i; break; }
        }

        let activeIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].time <= t + 0.05) { activeIdx = i; break; }
        }

        if (activeIdx !== this._activeIdx) {
            this._activeIdx = activeIdx;
            this.lineEls.forEach((el, i) => {
                el.classList.toggle('synced-active', i === activeIdx);
            });
        }

        const karaoke = window.LyricsScene?.settings?.karaoke;
        if (karaoke === 'fill' && activeIdx >= 0 && this.lineEls[activeIdx]) {
            const curLine = lines[activeIdx];
            const nextLine = lines[activeIdx + 1];
            const lineStart = curLine.time;
            const lineEnd = nextLine ? nextLine.time : lineStart + 4;
            const span = Math.max(0.1, lineEnd - lineStart);
            const progress = Math.max(0, Math.min(100, ((t - lineStart) / span) * 100));
            this.lineEls[activeIdx].style.setProperty('--progress', progress.toFixed(2));
        } else if (this.lineEls) {
            this.lineEls.forEach(el => {
                if (el !== this.lineEls[activeIdx]) el.style.removeProperty('--progress');
            });
        }

        if (scrollIdx < 0) return;
        if (!window.audioEngine.isPlaying) return;
        if (Date.now() < this._userScrollUntil) return;
        if (scrollIdx === this._scrolledIdx) return;

        this._scrolledIdx = scrollIdx;
        this._scrollLineToCenter(scrollIdx);
    },

    _scrollLineToCenter(idx) {
        const el = this.lineEls[idx];
        const sc = this.scroller;
        if (!el || !sc) return;

        const target = Math.max(0,
            el.offsetTop
            - sc.clientHeight / 2
            + el.clientHeight / 2
        );

        const start = sc.scrollTop;
        const delta = target - start;

        if (Math.abs(delta) < 2) {
            sc.scrollTop = target;
            return;
        }

        if (Math.abs(delta) > 350) {
            if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
            this._scrollRaf = null;
            sc.scrollTop = target;
            return;
        }

        const duration = Math.min(220, Math.max(120, Math.abs(delta) / 3));
        const t0 = performance.now();

        if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);

        const tick = (now) => {
            const p = Math.min(1, (now - t0) / duration);
            const eased = 1 - Math.pow(1 - p, 3);
            sc.scrollTop = start + delta * eased;
            if (p < 1) {
                this._scrollRaf = requestAnimationFrame(tick);
            } else {
                this._scrollRaf = null;
                sc.scrollTop = target;
            }
        };
        this._scrollRaf = requestAnimationFrame(tick);
    },

    rerenderForKaraoke() {
        if (!this._currentText) return;
        const text = this._currentText;
        const url  = this._currentSourceUrl;
        const sync = this._currentSyncLines;
        const scrollPos = this.scroller ? this.scroller.scrollTop : 0;
        this.renderLyrics(text, url, sync);
        if (this.scroller) {
            requestAnimationFrame(() => {
                this.scroller.scrollTop = scrollPos;
                if (typeof this._updatePadding === 'function') this._updatePadding();
            });
        }
    },

        restartEntranceAnim() {
        if (!this.lineEls || !this.lineEls.length) return;
        this.lineEls.forEach(el => {
            const chars = el.querySelectorAll('.ly-char');
            if (chars.length) {
                chars.forEach(ch => {
                    ch.style.animation = 'none';
                    void ch.offsetWidth;
                    ch.style.animation = '';
                });
            } else {
                el.style.animation = 'none';
                void el.offsetWidth;
                el.style.animation = '';
            }
        });
    },

    _seekToLine(idx) {
        const lines = this._syncLines;
        if (!lines || !lines[idx]) return;

        const audio = window.audioEngine?.audio;
        if (!audio) return;

        audio.currentTime = lines[idx].time;

        const el = this.lineEls[idx];
        if (el) {
            el.classList.add('sync-seek');
            setTimeout(() => el.classList.remove('sync-seek'), 400);
        }

        this._userScrollUntil = 0;
        this._activeIdx = -1;
    }
};

window.LyricsView = LyricsView;

const LYRICS_SCENE_KEY = 'lyricsSceneSettings';

const LYRICS_FONTS = [
    'Space Grotesk',
    'Inter',
    'Bebas Neue',
    'Playfair Display',
    'JetBrains Mono',
    'Unbounded',
    'Caveat',
    'Press Start 2P',
];

const LyricsScene = {
    settings: {
        font:    'Space Grotesk',
        size:    1,
        align:   'left',
        bg:      'dark',
        color:   'auto',
        cover:   'on',
        anim:     'stagger',
        karaoke:  'glow',
    },

    init() {
        this.load();

        const btn   = document.getElementById('lyricsSettingsBtn');
        const panel = document.getElementById('lyricsPanel');
        const reset = document.getElementById('lyricsPanelReset');
        const closeBtn = document.getElementById('lyricsPanelClose');

        const openPanel = () => {
            panel.classList.add('open');
            panel.setAttribute('aria-hidden', 'false');
            btn.classList.add('active');
        };
        const closePanel = () => {
            panel.classList.remove('open');
            panel.setAttribute('aria-hidden', 'true');
            btn.classList.remove('active');
        };
       
        btn?.addEventListener('click', () => {
            if (panel.classList.contains('open')) closePanel();
            else openPanel();
        });

        closeBtn?.addEventListener('click', closePanel);

        const stage = document.getElementById('lyricsStage');
        stage?.addEventListener('click', (e) => {
            if (!panel.classList.contains('open')) return;
            if (panel.contains(e.target)) return;
            if (e.target.closest('#lyricsSettingsBtn')) return;
            closePanel();
        });

        reset?.addEventListener('click', () => {
            this.settings = {
                font:    'Space Grotesk',
                size:    1,
                align:   'left',
                bg:      'dark',
                color:   'auto',
                cover:   'on',
                anim:     'stagger',
                karaoke:  'glow',
            };
            this.save();
            this.buildUI();
            this.apply();
        });

        const offsetMinus = document.getElementById('lyricsOffsetMinus');
        const offsetPlus  = document.getElementById('lyricsOffsetPlus');
        const offsetReset = document.getElementById('lyricsOffsetReset');

        const applyOffsetDelta = (delta) => {
            const track = window.audioEngine?.playlist?.[window.audioEngine.currentIndex];
            if (!track) return;
            const cur = track.lyricsOffset || 0;
            const next = Math.max(-10, Math.min(10, +(cur + delta).toFixed(2)));
            track.lyricsOffset = next;
            if (window.trackStorage) {
                window.trackStorage.updateMetadata(track).catch(() => {});
            }
            this.updateOffsetUI(next);
            if (window.LyricsView) window.LyricsView._activeIdx = -1;
        };

        offsetMinus?.addEventListener('click', () => applyOffsetDelta(-0.5));
        offsetPlus?.addEventListener('click',  () => applyOffsetDelta(+0.5));

        offsetReset?.addEventListener('click', () => {
            const track = window.audioEngine?.playlist?.[window.audioEngine.currentIndex];
            if (!track) return;
            track.lyricsOffset = 0;
            if (window.trackStorage) {
                window.trackStorage.updateMetadata(track).catch(() => {});
            }
            this.updateOffsetUI(0);
            if (window.LyricsView) window.LyricsView._activeIdx = -1;
        });

        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('lyricsModal');
            if (!modal || !modal.classList.contains('active')) return;
            if (e.target.closest('input, textarea, [contenteditable]')) return;
            if (e.key === '[') { e.preventDefault(); applyOffsetDelta(-0.1); }
            if (e.key === ']') { e.preventDefault(); applyOffsetDelta(+0.1); }
        });

        this.buildFontGrid();

        document.querySelectorAll('.lyrics-radio-row').forEach(row => {
            const key = row.dataset.option;
            row.querySelectorAll('.lyrics-radio').forEach(rb => {
                rb.addEventListener('click', () => {
                    row.querySelectorAll('.lyrics-radio').forEach(b => b.classList.remove('active'));
                    rb.classList.add('active');
                    const v = rb.dataset.value;
                    this.settings[key] = key === 'size' ? parseFloat(v) : v;
                    this.save();
                    this.apply();
                });
            });
        });

        this.apply();
    },

    buildFontGrid() {
        const grid = document.getElementById('lyricsFontGrid');
        if (!grid) return;
        grid.innerHTML = '';
        LYRICS_FONTS.forEach(font => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'lyrics-font-btn';
            b.dataset.font = font;
            b.textContent = font;
            b.addEventListener('click', () => {
                grid.querySelectorAll('.lyrics-font-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                this.settings.font = font;
                this.save();
                this.apply();
            });
            grid.appendChild(b);
        });
    },

    updateOffsetUI(offset) {
        const el = document.getElementById('lyricsOffsetValue');
        if (!el) return;
        const val = +(offset || 0);
        const sign = val > 0 ? '+' : '';
        el.textContent = `${sign}${val.toFixed(1)}с`;
        el.classList.toggle('positive', val > 0);
        el.classList.toggle('negative', val < 0);
    },

    buildUI() {
        document.querySelectorAll('.lyrics-font-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.font === this.settings.font);
        });

        document.querySelectorAll('.lyrics-radio-row').forEach(row => {
            const key = row.dataset.option;
            row.querySelectorAll('.lyrics-radio').forEach(rb => {
                const v = key === 'size' ? String(this.settings[key]) : this.settings[key];
                rb.classList.toggle('active', rb.dataset.value === v);
            });
        });
    },

    apply() {
        const scroller = document.getElementById('lyricsScroller');
        const stage    = document.getElementById('lyricsStage');
        const linesEl  = document.getElementById('lyricsLines');
        if (!scroller || !stage) return;

        const size = this.settings.size || 1;

        scroller.querySelectorAll('.lyrics-line').forEach(el => {
            el.style.fontFamily = `'${this.settings.font}', sans-serif`;
            el.style.fontSize   = (20 * size).toFixed(1) + 'px';
        });
        if (linesEl) {
            linesEl.style.fontFamily = `'${this.settings.font}', sans-serif`;
        }

        scroller.dataset.align = this.settings.align;
        if (linesEl) {
            linesEl.style.textAlign = this.settings.align === 'center' ? 'center' : 'left';
        }

        scroller.dataset.color = this.settings.color;
        stage.classList.toggle('no-cover', this.settings.cover === 'off');
        this.applyBackground();

        const anim = this.settings.anim || 'stagger';
        if (linesEl) {
            const changed = linesEl.dataset.anim !== anim;
            linesEl.dataset.anim = anim;
            if (changed && window.LyricsView && typeof window.LyricsView.restartEntranceAnim === 'function') {
                window.LyricsView.restartEntranceAnim();
            }
        }

        const karaoke = this.settings.karaoke || 'glow';
        scroller.dataset.karaoke = karaoke;

        const karaokeChanged = this._lastKaraoke !== karaoke;
        this._lastKaraoke = karaoke;

        if (karaokeChanged && window.LyricsView && typeof window.LyricsView.rerenderForKaraoke === 'function') {
            window.LyricsView.rerenderForKaraoke();
        }
    },

    applyBackground() {
        const bg = document.getElementById('lyricsBg');
        if (!bg) return;

        const track = window.audioEngine?.playlist?.[window.audioEngine.currentIndex];
        const mode  = this.settings.bg;

        bg.className = 'lyrics-bg';
        bg.removeAttribute('data-mode');
        bg.style.backgroundImage = '';
        bg.style.background = '';

        if (mode === 'dark' || !track) return;

        if (mode === 'blur') {
            const url = window.audioEngine?.ensureCoverUrl(track);
            if (url) {
                bg.style.backgroundImage = `url("${url}")`;
                bg.dataset.mode = 'blur';
                bg.classList.add('active');
            }
            return;
        }

        if (mode === 'gradient') {
            const palette = currentCoverPalette;
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--y').trim() || '#FE1743';
            const c1 = accent;
            const c2 = palette ? `rgb(${palette.hexRgb.join(',')})` : 'var(--y-deep)';
            const c3 = '#0A0A0A';

            bg.style.background = `
                radial-gradient(ellipse at 20% 20%, ${c1} 0%, transparent 55%),
                radial-gradient(ellipse at 80% 70%, ${c2} 0%, transparent 60%),
                ${c3}
            `;
            bg.dataset.mode = 'gradient';
            bg.classList.add('active');
        }
    },

    load() {
        try {
            const saved = JSON.parse(localStorage.getItem(LYRICS_SCENE_KEY) || '{}');
            Object.assign(this.settings, saved);
        } catch (e) {}
    },

    save() {
        localStorage.setItem(LYRICS_SCENE_KEY, JSON.stringify(this.settings));
    },

    refresh() {
        this.apply();
    },
};

window.LyricsScene = LyricsScene;

async function openLyrics(index, opts = {}) {
    const isRefresh = !!opts.isRefresh;
    const track = audioEngine.playlist[index];
    if (!track) return;
    if (track._isFetchingLyrics) {
        return;
    }

    if (!LyricsView.bound) LyricsView.init();
    const glowEl = document.getElementById('lyricsGlow');
    const modal  = document.getElementById('lyricsModal');

    if (!isRefresh) {
        LyricsView.restorePlayerControls();
        LyricsView.reset();
        LyricsView.setCover(track);
        LyricsView.setMeta(track);
        modal.classList.add('active');
        glowEl?.classList.add('active');

        if (window.miniPlayer) window.miniPlayer.forceHide();

        setTimeout(() => window.LyricsScene?.refresh(), 100);

    } else {
        LyricsView.setCover(track);
        LyricsView.setMeta(track);
        LyricsView.clearLines();

        if (LyricsView.linesEl) {
            const ph = document.createElement('div');
            ph.className = 'lyrics-line';
            ph.style.opacity = '0.4';
            ph.textContent = 'Загрузка текста…';
            LyricsView.linesEl.appendChild(ph);
            LyricsView.lineEls = [ph];
            requestAnimationFrame(() => LyricsView._updateFocus());
        }
    }

    const myToken = ++lyricsLoadToken;

    if (track._lyricsCache) {
        if (myToken !== lyricsLoadToken) return;
        LyricsView.renderLyrics(
            track._lyricsCache.text,
            'https://lrclib.net',
            track._lyricsCache.synced || null
        );
        if (!isRefresh) LyricsView.reveal();
        else requestAnimationFrame(() => LyricsView._updateFocus());
        glowEl?.classList.remove('active');
        return;
    }

    if (!isRefresh) LyricsView.showLoading();

    track._isFetchingLyrics = true;

    const artist = cleanTrackQuery(primaryArtist(track.artist));
    const name   = cleanTrackQuery(track.title);

    try {
        const best = await fetchLyrics(artist, name, track.duration);
        if (myToken !== lyricsLoadToken) return;
        if (!modal.classList.contains('active')) return;

        if (!best) {
            LyricsView.showNotFound('Текст не найден', 'Попробуйте поискать вручную.', track);
            return;
        }
        if (best.instrumental && !best.plainLyrics && !best.syncedLyrics) {
            LyricsView.showNotFound('Инструментальная композиция', 'У этого трека нет текста.', track);
            return;
        }

        const hasSynced = !!(best.syncedLyrics && best.syncedLyrics.trim());
        const syncLines = hasSynced ? parseLRC(best.syncedLyrics) : null;

        let plainText;
        if (syncLines && syncLines.length > 0) {
            plainText = syncLines
                .map(l => (l.text && l.text !== '\u00A0') ? l.text : '')
                .join('\n')
                .trim();
        } else {
            plainText = best.plainLyrics || '';
        }

        if (!plainText) {
            LyricsView.showNotFound('Текст пустой', 'Запись нашлась, но без содержимого.', track);
            return;
        }

        track._lyricsCache = {
            text:   plainText,
            synced: syncLines,
            source: 'lrclib',
            lrclibId: best.id,
            artist: best.artistName || track.artist,
            title:  best.trackName  || track.title
        };

        LyricsView.renderLyrics(plainText, 'https://lrclib.net', syncLines);

        if (!isRefresh) LyricsView.reveal();
        else requestAnimationFrame(() => LyricsView._updateFocus());

    } catch (e) {
        if (myToken !== lyricsLoadToken) return;
        if (!modal.classList.contains('active')) return;
        console.warn('lyrics fetch failed:', e);
        LyricsView.showNotFound('Не удалось загрузить', 'Проверьте интернет или откройте поиск вручную.', track);
    } finally {
        track._isFetchingLyrics = false;
        if (myToken === lyricsLoadToken) glowEl?.classList.remove('active');
    }
}
window.openLyrics = openLyrics;

function loadSettings() {
    const settings = JSON.parse(localStorage.getItem('settings') || '{}');

    const navMode = localStorage.getItem('navMode') || 'classic';
    applyNavMode(navMode);
    applyNavLayout(localStorage.getItem('navLayout') || 'classic');

    if (settings.fontFamily) {
        localStorage.setItem('fontFamily', settings.fontFamily);
    }
    if (settings.fontThin !== undefined) {
        localStorage.setItem('fontThin', settings.fontThin ? '1' : '0');
    }

    if (settings.crossfade !== undefined) {
        document.getElementById('crossfadeSlider').value = settings.crossfade;
        document.getElementById('crossfadeValue').textContent = settings.crossfade + ' сек';
    }

    if (settings.fontSize !== undefined) {
        document.getElementById('fontSizeSlider').value = settings.fontSize;
        document.getElementById('fontSizeValue').textContent = settings.fontSize + 'px';
        document.documentElement.style.fontSize = settings.fontSize + 'px';
    }

    if (settings.animation !== undefined) {
        document.getElementById('animationSlider').value = settings.animation;
        document.getElementById('animationValue').textContent = settings.animation + '%';
        applyAnimationIntensity(settings.animation);
    } else {
        respectReducedMotion();
    }

    if (settings.colorPreset) {
        applyColorPreset(settings.colorPreset);
    }

    coverBgEnabled     = !!settings.coverBg;
    coverAccentEnabled = !!settings.coverAccent;

    const bgToggle = document.getElementById('coverBgToggle');
    if (bgToggle) bgToggle.checked = coverBgEnabled;

    const accToggle = document.getElementById('coverAccentToggle');
    if (accToggle) accToggle.checked = coverAccentEnabled;
    if (settings.visualizerMode && visualizer) {
        document.getElementById('visualizerMode').value = settings.visualizerMode;
        visualizer.setMode(settings.visualizerMode);
    }

    if (settings.normalize !== undefined) {
        const toggle = document.getElementById('normalizeToggle');
        if (toggle) toggle.checked = !!settings.normalize;
        if (audioEngine) audioEngine.setNormalize(!!settings.normalize);
    }

    if (settings.quality) {
        const btn = document.querySelector(`#qualityRadio .radio-btn[data-value="${settings.quality}"]`);
        if (btn) {
            document.querySelectorAll('#qualityRadio .radio-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (audioEngine) audioEngine.setQuality(settings.quality);
        }
    }
    if (window.equalizerUI) {
        window.equalizerUI.restore(settings);
    }
    if (settings.crossfade !== undefined && audioEngine) {
        audioEngine.setCrossfade(settings.crossfade);
    }
    if (backgroundSystem) {
        applyBackgroundDisabled(settings.disableBg === true);
    }
    const current = audioEngine?.playlist?.[audioEngine.currentIndex];
    if (current) refreshCoverAppearance(current);
    saveSettings();
}

function saveSettings() {
    const settings = {
        quality:       document.querySelector('#qualityRadio .radio-btn.active')?.dataset.value,
        eqPreset:      document.getElementById('eqPreset').value,
        crossfade:     parseInt(document.getElementById('crossfadeSlider').value),
        normalize:     document.getElementById('normalizeToggle').checked,
        fontSize:      parseInt(document.getElementById('fontSizeSlider').value),
        animation:     parseInt(document.getElementById('animationSlider').value),
        disableBg:     document.getElementById('disableBgToggle').checked,
        visualizerMode: document.getElementById('visualizerMode')?.value,
        eqCustomGains: window.equalizerUI ? window.equalizerUI.currentGains : undefined,
        navMode:       localStorage.getItem('navMode') || 'classic',
        navLayout: localStorage.getItem('navLayout') || 'classic',
        coverBg:          document.getElementById('coverBgToggle')?.checked || false,
        coverAccent:      document.getElementById('coverAccentToggle')?.checked || false,
        fontFamily:    localStorage.getItem('fontFamily') || 'space-grotesk',
        fontThin:      localStorage.getItem('fontThin') === '1',
    };
    localStorage.setItem('settings', JSON.stringify(settings));
}

function setupCardTilt() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover)').matches) return;

    const CONFIG = {
        '.profile-hero': { max: 8 },
        '.player-cover': { max: 10 },
        '.lyrics-cover': { max: 18 },
    };

    const selectors = Object.keys(CONFIG);
    const state = new Map();

    function getState(el) {
        if (!state.has(el)) {
            state.set(el, { curX: 0, curY: 0, targetX: 0, targetY: 0, rafId: null });
        }
        return state.get(el);
    }

    function apply(el) {
        const s = getState(el);
        s.rafId = null;
        s.curX += (s.targetX - s.curX) * 0.18;
        s.curY += (s.targetY - s.curY) * 0.18;

        el.style.transform =
            `perspective(900px) rotateY(${s.curX.toFixed(2)}deg) rotateX(${s.curY.toFixed(2)}deg)`;
        if (Math.abs(s.targetX - s.curX) > 0.02 || Math.abs(s.targetY - s.curY) > 0.02) {
            s.rafId = requestAnimationFrame(() => apply(el));
        } else {
            if (s.targetX === 0 && s.targetY === 0) el.style.transform = '';
        }
    }

    function tick(el) {
        const s = getState(el);
        if (!s.rafId) s.rafId = requestAnimationFrame(() => apply(el));
    }

    function resetAll() {
        for (const [el, s] of state) {
            s.targetX = 0;
            s.targetY = 0;
            tick(el);
        }
    }

    let _pending = null;
    let _rafPending = false;

    const processMouse = () => {
        _rafPending = false;
        if (!_pending) return;
        const e = _pending;
        _pending = null;

        if (typeof isEcoMode !== 'undefined' && isEcoMode) {
            resetAll();
            return;
        }

        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el || !document.contains(el)) continue;

            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const cfg = CONFIG[sel];
            const s = getState(el);
            const inside =
                e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top  && e.clientY <= rect.bottom;

            if (inside) {
                const relX = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
                const relY = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);

                s.targetX = Math.max(-cfg.max, Math.min(cfg.max, relX * cfg.max));
                s.targetY = Math.max(-cfg.max, Math.min(cfg.max, relY * cfg.max));
            } else {
                s.targetX = 0;
                s.targetY = 0;
            }
            tick(el);
        }
    };

    document.addEventListener('mousemove', (e) => {
        _pending = e;
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(processMouse);
    });

    document.addEventListener('mouseleave', resetAll);
}

function setupCustomCursor() {
    if (!window.matchMedia('(hover: hover)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const dot = document.createElement('div');
    dot.className = 'cursor-dot';
    const ring = document.createElement('div');
    ring.className = 'cursor-ring';
    document.body.append(dot, ring);

    let mx = 0, my = 0, rx = 0, ry = 0;
    let rafActive = false;

    const loop = () => {
        rx += (mx - rx) * 0.18;
        ry += (my - ry) * 0.18;
        ring.style.transform = `translate(${rx}px, ${ry}px)`;

        if (Math.abs(mx - rx) > 0.5 || Math.abs(my - ry) > 0.5) {
            requestAnimationFrame(loop);
        } else {
            rx = mx;
            ry = my;
            rafActive = false;
        }
    };

    document.addEventListener('mousemove', (e) => {
        mx = e.clientX;
        my = e.clientY;
        dot.style.transform = `translate(${mx}px, ${my}px)`;

        if (!rafActive) {
            rafActive = true;
            requestAnimationFrame(loop);
        }
    });

    let _lastGrowCheck = 0;
    document.addEventListener('mouseover', (e) => {
        const now = performance.now();
        if (now - _lastGrowCheck < 80) return;
        _lastGrowCheck = now;

        const interactive = e.target.closest(
            'button, a, .nav-item, .control-btn, .queue-plate, [role="button"]'
        );
        ring.classList.toggle('grow', !!interactive);
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            dot.style.opacity = '0';
            ring.style.opacity = '0';
        } else {
            dot.style.opacity = '';
            ring.style.opacity = '';
        }
    });
}

function setupEvents() {
    const pageTransition = new PageTransition();
    
    setupGlobalSearch();
    setupEditProfile();
    setupBuilder();
    _setupArtistEditModal();
    setupBottomNav();
    setupSettingsDrawer();
    setupLibraryDrawer();
    setupRightNav();

    document.querySelectorAll('#navModeRadio .radio-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#navModeRadio .radio-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyNavMode(btn.dataset.value);
            showNotification(btn.dataset.value === 'mbox'
                ? 'Навигация: Mbox (нижний док)'
                : 'Навигация: Классика (в шапке)');
        });
    });

    document.querySelectorAll('#navLayoutRadio .radio-btn').forEach(btn => {
        btn.addEventListener('click', () => {
                document.querySelectorAll('#navLayoutRadio .radio-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyNavLayout(btn.dataset.value);
            showNotification(btn.dataset.value === 'alt'
                ? 'Кнопки: по центру'
                : 'Кнопки: классика');
        });
    });


if (localStorage.getItem('currentPage') === 'settings') {
    localStorage.setItem('currentPage', 'home');
}

if (localStorage.getItem('currentPage') === 'mymusic') {
    localStorage.setItem('currentPage', 'home');
}

    const savedPage = localStorage.getItem('currentPage');
    if (savedPage && savedPage !== 'home' && document.getElementById('page-' + savedPage)) {
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const targetNav = document.querySelector(`.nav-item[data-page="${savedPage}"]`);
        if (targetNav) targetNav.classList.add('active');
        document.getElementById('page-' + savedPage).classList.add('active');

        if (window.miniPlayer && savedPage !== 'builder') window.miniPlayer.show();
        if (savedPage === 'profile') {
            setTimeout(renderProfile, 100);
        }
    }


    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (item.classList.contains('active')) return;

            if (item.dataset.page === 'settings') {
                e.preventDefault();
                e.stopPropagation();
                if (typeof window.openSettingsDrawer === 'function') {
                    window.openSettingsDrawer();
                }
                return;
            }

            if (item.dataset.page === 'mymusic') {
                e.preventDefault();
                e.stopPropagation();
                if (window.isLibraryDrawerOpen?.()) {
                    window.closeLibraryDrawer?.();
                } else {
                    window.openLibraryDrawer?.();
                }
                return;
            }

            if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                const rect = item.getBoundingClientRect();
                const ripple = document.createElement('span');
                ripple.className = 'nav-ripple-el';
                const size = Math.max(rect.width, rect.height) * 0.9;
                ripple.style.width = ripple.style.height = size + 'px';
                ripple.style.left = (e.clientX - rect.left) + 'px';
                ripple.style.top  = (e.clientY - rect.top)  + 'px';
                item.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);
            }
            const targetPage  = item.dataset.page;
            const currentPage = document.querySelector('.nav-item.active')?.dataset.page || 'home';

            if (window.miniPlayer) {
                window.miniPlayer.prepareTransition(currentPage, targetPage);
            }

        if (targetPage === 'home') {
            setTimeout(() => {
                if (isEcoMode) return;
                const g = ensureGlobe();
                if (g) {
                    g.onRegionSelect = (regionIdx) => openRegionPage(regionIdx);
                }
                g.resize();
                g.start();
            }, 900);
        } else if (currentPage === 'home') {
            window.globeView?.stop();
        }

            pageTransition.play(() => {
                document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
                item.classList.add('active');
                item.classList.remove('nav-pop');
                void item.offsetWidth;   // перезапуск анимации
                item.classList.add('nav-pop');
                setTimeout(() => item.classList.remove('nav-pop'), 500);
                document.getElementById('page-' + targetPage).classList.add('active');
                localStorage.setItem('currentPage', targetPage);
                if (typeof window.syncRightNav === 'function') window.syncRightNav();

                if (targetPage === 'charts') {
                    buildTop100();
                    buildChartPlaylists();
                }

                if (targetPage === 'profile') {
                    renderProfile();
                }

                if (targetPage === 'builder') {
                    renderBuilderArtists();
                    renderBuilderQueue();
                }

                setTimeout(positionBottomNav, 100);

                if (window.miniPlayer) {
                    window.miniPlayer.applyTransition(targetPage);
                }
            });
        });
    });

    document.getElementById('ecoToggle').addEventListener('change', (e) => {
        toggleEcoMode(e.target.checked);
    });

    document.getElementById('playBtn').addEventListener('click', () => {
        audioEngine.togglePlay();
    });
    document.getElementById('mainPlayBtn').addEventListener('click', () => {
        document.getElementById('playBtn').click();
    });

    ['trackArtist', 'stageMetaArtist'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = audioEngine?.playlist?.[audioEngine.currentIndex];
            if (cur && cur.artist) openArtistPage(cur.artist);
        });
    });

    document.getElementById('playerCoverFindBtn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const track = audioEngine?.playlist?.[audioEngine.currentIndex];
        if (!track) {
            showNotification('Сначала включи трек', true);
            return;
        }
        const btn = e.currentTarget;
        btn.classList.add('loading');
        try {
            await findCoverForTrack(track);
        } finally {
            btn.classList.remove('loading');
        }
    });

    document.getElementById('prevBtn').addEventListener('click', () => audioEngine.prev());
    document.getElementById('nextBtn').addEventListener('click', () => audioEngine.next());
    document.getElementById('lyricsBtn')?.addEventListener('click', () => {
        if (audioEngine.playlist.length === 0) {
            showNotification('Сначала загрузите треки', true);
            return;
        }
        openLyrics(audioEngine.currentIndex);
    });
    document.getElementById('shuffleBtn').addEventListener('click', () => {
        const isShuffle = audioEngine.toggleShuffle();
        document.getElementById('shuffleBtn').style.opacity = isShuffle ? '1' : '0.5';
    });
    document.getElementById('repeatBtn').addEventListener('click', () => {
        const mode = audioEngine.cycleRepeat();
        const btn = document.getElementById('repeatBtn');
        btn.style.opacity = mode === 'off' ? '0.5' : '1';
        btn.title = `Повтор: ${mode}`;
    });

    (() => {
        const pw = document.getElementById('progressWrapper');
        const fill = document.getElementById('progressFill');
        let dragging = false;

        const seekTo = (clientX) => {
            const rect = pw.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
            audioEngine.seek(pct);
            fill.style.width = pct + '%';
            document.getElementById('currentTime').textContent =
                audioEngine.formatTime(audioEngine.audio.currentTime);
        };

        pw.addEventListener('mousedown', (e) => {
            dragging = true;
            document.body.style.userSelect = 'none';
            seekTo(e.clientX);
        });
        window.addEventListener('mousemove', (e) => { if (dragging) seekTo(e.clientX); });
        window.addEventListener('mouseup', () => {
            dragging = false;
            document.body.style.userSelect = '';
        });

        pw.addEventListener('touchstart', (e) => {
            dragging = true;
            seekTo(e.touches[0].clientX);
        }, { passive: true });
        pw.addEventListener('touchmove', (e) => {
            if (dragging) seekTo(e.touches[0].clientX);
        }, { passive: true });
        pw.addEventListener('touchend', () => { dragging = false; });
    })();

    document.getElementById('volumeSlider').addEventListener('input', (e) => {
        audioEngine.setVolume(e.target.value);
    });

    document.getElementById('volumeIconBtn')?.addEventListener('click', () => {
        audioEngine.toggleMute();
    });

    document.getElementById('likedTile')?.addEventListener('click', openLikedModal);
    document.getElementById('playlistsTile')?.addEventListener('click', openPlaylistsModal);
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });
    });

    document.querySelectorAll('.radio-group').forEach(group => {
        group.querySelectorAll('.radio-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                group.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                if (group.id === 'qualityRadio' && audioEngine) {
                    const value = btn.dataset.value;
                    audioEngine.setQuality(value);
                    const labels = { low: 'Low', normal: 'Normal', high: 'High', lossless: 'Lossless' };
                    showNotification(`Качество звука: ${labels[value]}`);
                }

                saveSettings();
            });
        });
    });

    document.getElementById('disableBgToggle')?.addEventListener('change', (e) => {
        applyBackgroundDisabled(e.target.checked);
        saveSettings();
        showNotification(e.target.checked
            ? 'Фоновые эффекты: Выкл'
            : 'Фоновые эффекты: Вкл');
    });

    document.querySelectorAll('.select').forEach(select => {
        select.addEventListener('change', () => saveSettings());
    });

    document.getElementById('crossfadeSlider').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        document.getElementById('crossfadeValue').textContent = val + ' сек';
        if (audioEngine) audioEngine.setCrossfade(val);
        saveSettings();
    });

    document.getElementById('fontSizeSlider').addEventListener('input', (e) => {
        document.getElementById('fontSizeValue').textContent = e.target.value + 'px';
        document.documentElement.style.fontSize = e.target.value + 'px';
        saveSettings();
    });

    document.getElementById('animationSlider').addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        document.getElementById('animationValue').textContent = val + '%';
        applyAnimationIntensity(val);
        saveSettings();
    });

        document.getElementById('coverBgToggle')?.addEventListener('change', (e) => {
        coverBgEnabled = e.target.checked;
        const current = audioEngine.playlist[audioEngine.currentIndex];
        setCoverBackground(current);
        saveSettings();
        showNotification(e.target.checked
            ? 'Обложка как фон: Вкл'
            : 'Обложка как фон: Выкл');
    });

    document.getElementById('coverAccentToggle')?.addEventListener('change', async (e) => {
        coverAccentEnabled = e.target.checked;
        if (coverAccentEnabled) {
            const current = audioEngine.playlist[audioEngine.currentIndex];
            await applyCoverAccent(current);
        } else {
            restoreUserAccent();
        }
        saveSettings();
        showNotification(e.target.checked
            ? 'Акцент под обложку: Вкл'
            : 'Акцент под обложку: Выкл');
    });

    document.getElementById('reducedMotionToggle')?.addEventListener('change', (e) => {
        const val = e.target.checked ? 20 : 100;
        document.getElementById('animationSlider').value = val;
        document.getElementById('animationValue').textContent = val + '%';
        applyAnimationIntensity(val);
        saveSettings();
    });

    document.getElementById('clearCacheBtn').addEventListener('click', async () => {
        if (!confirm('Удалить все сохранённые треки? Это действие нельзя отменить.')) return;

        if (window.trackStorage) {
            await window.trackStorage.clearAll();
        }

        if (audioEngine) {
            for (const t of audioEngine.playlist) {
                if (t.url && t.url.startsWith('blob:')) {
                    try { URL.revokeObjectURL(t.url); } catch (e) {}
                }
            }
            audioEngine.playlist = [];
            audioEngine.currentIndex = 0;
            audioEngine.pause();
            audioEngine.audio.removeAttribute('src');
            audioEngine.audio.load();
            document.getElementById('trackTitle').textContent = 'Загрузите музыку';
            document.getElementById('trackArtist').textContent = 'Нажмите кнопку "Загрузить"';
        }

        if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
        if (window.trackQueue) window.trackQueue.render();

        if (typeof updateEmptyState === 'function') updateEmptyState();

        updateCacheSize();
        showNotification('Хранилище очищено');
    });

    const SUPPORT_EMAIL = 'mus.mbox@gmail.com';

    document.querySelectorAll('.account-item').forEach(item => {
        item.addEventListener('click', () => {
            if (item.dataset.action === 'support') {
                openSupportModal();
                return;
            }

            const label = item.querySelector('.account-item-label').textContent;
            showNotification(`Открытие: ${label}`);
        });
    });

    setupSupportForm();

    document.querySelector('.logout-btn').addEventListener('click', () => {
        RegistrationSystem.logout();
    });
    document.querySelectorAll('.genre-tag').forEach(tag => {
        tag.addEventListener('click', () => showNotification(`Жанр: ${tag.textContent}`));
    });
    document.querySelectorAll('.achievement').forEach(ach => {
        ach.addEventListener('click', () => {
            if (!ach.classList.contains('locked')) {
                const name = ach.querySelector('.achievement-name').textContent;
                showNotification(`Достижение: ${name}`);
            }
        });
    });

    document.getElementById('visualizerMode')?.addEventListener('change', (e) => {
        if (visualizer) visualizer.setMode(e.target.value);
        saveSettings();
    });

    document.getElementById('normalizeToggle')?.addEventListener('change', (e) => {
        audioEngine.setNormalize(e.target.checked);
        saveSettings();
        showNotification(e.target.checked
            ? 'Нормализация громкости: Вкл'
            : 'Нормализация громкости: Выкл');
    });

        const lyricsModal = document.getElementById('lyricsModal');
        if (lyricsModal) {
            new MutationObserver(() => {
                if (!lyricsModal.classList.contains('active')) {
                    document.getElementById('lyricsGlow')?.classList.remove('active');
                    if (window.LyricsView) window.LyricsView.reset();
                    if (window.miniPlayer) window.miniPlayer.restoreAfterModal();
                }
            }).observe(lyricsModal, { attributes: true, attributeFilter: ['class'] });
        }

    document.getElementById('artistBackBtn')?.addEventListener('click', closeArtistPage);

    document.getElementById('artistPagePlayAllBtn')?.addEventListener('click', () => {
        const tracks = _artistTracks(_artistCurrent);
        if (tracks.length === 0) return;
        playTrackList(tracks, _artistCurrent);
    });

    document.getElementById('artistPageShuffleBtn')?.addEventListener('click', () => {
        const tracks = _artistTracks(_artistCurrent);
        if (tracks.length === 0) return;
        const shuffled = [...tracks];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        playTrackList(shuffled, _artistCurrent);
    });

    document.getElementById('artistPageEditBtn')?.addEventListener('click', () => {
        if (_artistCurrent) openArtistEditModal(_artistCurrent);
    });

    const regionModal = document.getElementById('regionModal');
    if (regionModal) {
        document.getElementById('regionModalClose')?.addEventListener('click', closeRegionModal);
        regionModal.addEventListener('click', (e) => {
            if (e.target === regionModal) closeRegionModal();
        });
    }

    (() => {
        const STORAGE_KEY = 'sidebarCollapsed';
        let state = {};
        try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) {}

        document.querySelectorAll('.sidebar-block[data-collapsible]').forEach(block => {
            const key = block.dataset.collapsible;
            const btn = block.querySelector('.sidebar-block-toggle');
            if (!btn) return;

            if (state[key]) {
                block.classList.add('is-collapsed');
                btn.setAttribute('aria-expanded', 'false');
            }

            btn.addEventListener('click', () => {
                const collapsed = block.classList.toggle('is-collapsed');
                btn.setAttribute('aria-expanded', String(!collapsed));
                state[key] = collapsed;
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
            });
        });
    })();

    const stageToggle = document.getElementById('stageToggle');
    const stageColumn = document.getElementById('stageColumn');

    stageToggle?.addEventListener('click', () => {
        if (!stageColumn) return;
        const currentlyCover = stageColumn.classList.contains('show-cover');
        applyStageMode(!currentlyCover, { animate: true });
    });

    if (stageToggle && stageColumn) {
        stageToggle.classList.add('hint-visible');
        setTimeout(() => {
            stageToggle.classList.remove('hint-visible');
        }, 5000);
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const aem = document.getElementById('artistEditModal');
            if (aem && aem.classList.contains('active')) {
                closeArtistEditModal();
                return;
            }
            const rm = document.getElementById('regionModal');
            if (rm && rm.classList.contains('active')) {
                closeRegionModal();
                return;
            }
            const ap = document.getElementById('page-artist');
            if (ap && ap.classList.contains('active')) {
                closeArtistPage();
                return;
            }
        }

        if (e.target.closest('input, select, textarea, button, [contenteditable]')) return;

        if (e.code === 'Space') {
            e.preventDefault();
            document.getElementById('playBtn').click();
        } else if (e.ctrlKey && e.code === 'ArrowRight') {
            e.preventDefault();
            audioEngine.next();
        } else if (e.ctrlKey && e.code === 'ArrowLeft') {
            e.preventDefault();
            audioEngine.prev();
        } else if (e.ctrlKey && e.code === 'ArrowUp') {
            e.preventDefault();
            const vol = Math.min(100, parseInt(document.getElementById('volumeSlider').value) + 5);
            document.getElementById('volumeSlider').value = vol;
            audioEngine.setVolume(vol);
        } else if (e.ctrlKey && e.code === 'ArrowDown') {
            e.preventDefault();
            const vol = Math.max(0, parseInt(document.getElementById('volumeSlider').value) - 5);
            document.getElementById('volumeSlider').value = vol;
            audioEngine.setVolume(vol);
        } else if (e.ctrlKey && e.code === 'KeyE') {
            e.preventDefault();
            const eco = document.getElementById('ecoToggle');
            eco.checked = !eco.checked;
            toggleEcoMode(eco.checked);
        }
    });

    (() => {
        const radio = document.getElementById('globeQualityRadio');
        if (!radio) return;
        const current = localStorage.getItem('globeQuality') || 'medium';
        radio.querySelectorAll('.radio-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.value === current);
            b.addEventListener('click', () => {
                radio.querySelectorAll('.radio-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                if (window.globeView) window.globeView.setQuality(b.dataset.value);
                showNotification(`Глобус: ${b.textContent}`);
            });
        });
    })();
}

let _artistEditTarget = null;

function openArtistEditModal(artistName) {
    const modal = document.getElementById('artistEditModal');
    if (!modal) return;

    _artistEditTarget = artistName;
    const meta = _getArtistMeta(artistName);

    const avatarWrap = document.getElementById('artistEditAvatar');
    if (avatarWrap) {
        if (meta.avatar) {
            avatarWrap.style.backgroundImage = `url("${meta.avatar}")`;
            avatarWrap.classList.add('has-image');
        } else {
            avatarWrap.style.backgroundImage = '';
            avatarWrap.classList.remove('has-image');
            const ph = avatarWrap.querySelector('.artist-edit-avatar-ph');
            if (ph) ph.textContent = artistName.charAt(0).toUpperCase();
        }
    }

    const bioEl = document.getElementById('artistEditBio');
    const counter = document.getElementById('artistEditBioCount');
    if (bioEl) {
        bioEl.value = meta.bio || '';
        if (counter) counter.textContent = bioEl.value.length;
    }

    const regionSel = document.getElementById('artistEditRegion');
    if (regionSel) {
        if (regionSel.options.length <= 1 && typeof REGION_NAMES !== 'undefined') {
            REGION_NAMES.forEach((name, i) => {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = name;
                regionSel.appendChild(opt);
            });
        }
        const tracks = _artistTracks(artistName);
        const idx = _artistRegionIdx(artistName, tracks);
        regionSel.value = String(idx >= 0 ? idx : -1);
    }

    const wikiInput = document.getElementById('artistEditWikiUrl');
    if (wikiInput) {
        wikiInput.value = meta.wikiUrl || '';
    }

    modal.classList.add('active');
}

function closeArtistEditModal() {
    const modal = document.getElementById('artistEditModal');
    if (modal) modal.classList.remove('active');
    _artistEditTarget = null;
}

function _setupArtistEditModal() {
    const modal = document.getElementById('artistEditModal');
    if (!modal) return;

    const close = () => closeArtistEditModal();
    document.getElementById('artistEditClose')?.addEventListener('click', close);
    document.getElementById('artistEditCancel')?.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });

    const bioEl = document.getElementById('artistEditBio');
    bioEl?.addEventListener('input', () => {
        const c = document.getElementById('artistEditBioCount');
        if (c) c.textContent = bioEl.value.length;
    });

    const fileInput = document.getElementById('artistEditAvatarFile');
    document.getElementById('artistEditAvatarUpload')?.addEventListener('click', () => {
        fileInput?.click();
    });
    fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            showNotification('Файл больше 5 МБ', true);
            return;
        }
        try {
            const dataUrl = await _resizeImage(file, 400, 400, 0.88);
            const wrap = document.getElementById('artistEditAvatar');
            if (wrap) {
                wrap.style.backgroundImage = `url("${dataUrl}")`;
                wrap.classList.add('has-image');
            }

            wrap.dataset.pendingAvatar = dataUrl;
            showNotification('Аватар загружен — не забудь сохранить');
        } catch (err) {
            console.warn(err);
            showNotification('Не удалось загрузить', true);
        }
        e.target.value = '';
    });

    document.getElementById('artistEditAvatarRemove')?.addEventListener('click', () => {
        const wrap = document.getElementById('artistEditAvatar');
        if (wrap) {
            wrap.style.backgroundImage = '';
            wrap.classList.remove('has-image');
            wrap.dataset.pendingAvatar = '';
            if (_artistEditTarget) {
                const ph = wrap.querySelector('.artist-edit-avatar-ph');
                if (ph) ph.textContent = _artistEditTarget.charAt(0).toUpperCase();
            }
        }
    });

    document.getElementById('artistEditForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!_artistEditTarget) return;

        const bioEl = document.getElementById('artistEditBio');
        const regionSel = document.getElementById('artistEditRegion');
        const avatarWrap = document.getElementById('artistEditAvatar');
        const wikiInput = document.getElementById('artistEditWikiUrl');
        const name = _artistEditTarget;

        const bio = (bioEl?.value || '').trim().slice(0, 500);
        const regionIdx = parseInt(regionSel?.value ?? '-1', 10);
        const pendingAvatar = avatarWrap?.dataset.pendingAvatar;
        const wikiUrl = (wikiInput?.value || '').trim();

        const patch = { bio, region: regionIdx, bioManual: true, wikiUrl };

        if (pendingAvatar === '') {
            patch.avatar = null;
        } else if (pendingAvatar) {
            patch.avatar = pendingAvatar;
        }

        _setArtistMeta(name, patch);

        if (regionIdx >= 0) {
            const tracks = _artistTracks(name);
            tracks.forEach(t => {
                t.region = regionIdx;
                if (window.trackStorage) {
                    window.trackStorage.updateMetadata(t).catch(() => {});
                }
            });
        }

        closeArtistEditModal();
        renderArtistPage(name);
        showNotification(`Профиль «${name}» обновлён`);
    });
}

window._setupArtistEditModal = _setupArtistEditModal;

document.addEventListener('DOMContentLoaded', () => {
    if (window.electronAPI?.isElectron) {
        document.body.classList.add('is-electron');

        const plat = window.electronAPI.platform;
        if (plat === 'darwin') {
            document.body.classList.add('is-mac');
        } else {
            document.body.classList.add('is-custom-frame');
            document.body.classList.add(plat === 'win32' ? 'is-win' : 'is-linux');
            if (typeof setupWindowControls === 'function') setupWindowControls();
        }

        if (window.electronAPI.overlay) {
            window.__showOverlayRaw = (data) => {
                try { window.electronAPI.overlay.show(data); } catch (e) {}
            };
        }
    } else {
        document.body.classList.add('no-cover-search');
    }

    init().catch(e => {
        console.error('[init] error:', e);

        if (window.electronAPI?.isElectron &&
            !document.body.classList.contains('is-custom-frame') &&
            window.electronAPI.platform !== 'darwin') {
            document.body.classList.add('is-electron', 'is-custom-frame');
            if (typeof setupWindowControls === 'function') setupWindowControls();
        }
    });
});