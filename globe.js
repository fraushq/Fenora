class GlobeView {
    constructor() {
        this.canvas = document.getElementById('globeCanvas');
        if (!this.canvas) { this.disabled = true; return; }
        this.disabled = false;
        this.ctx = this.canvas.getContext('2d', { alpha: true });
        this.hintEl = document.getElementById('worldHint');
        this.infoEl = document.getElementById('worldInfo');
        this.infoNameEl = document.getElementById('worldInfoName');
        this.infoCountEl = document.getElementById('worldInfoCount');
        this.infoPlayEl = document.getElementById('worldInfoPlay');

        this.W = 0; this.H = 0; this.DPR = 1;
        this.RAD = 300; this.CX = 0; this.CY = 0;

        this.rotY = 1.40;
        this.rotX = 0.30;
        this.velY = 0; this.velX = 0;

        this.dragging = false;
        this.lastPX = 0; this.lastPY = 0;
        this.mouseX = -9999; this.mouseY = -9999;
        this.pointerInside = false;

        this.hoveredRegion = -1;
        this.selectedRegion = -1;
        this.labelRegion = -2;
        this.hoverAmt = new Array(REGION_DATA.length).fill(0);
        this.anyHover = 0;

        this.labelDots = null;
        this.labelW = 1; this.labelH = 1; this.labelStep = 6;
        this.labelStart = 0; this.labelAlpha = 0; this.labelTarget = 0;

        this.animId = null;
        this.labelCache = new Map();
        this.onRegionSelect = null;

        this._ptsCache = {};
        this._landPtsCache = {};
        this._currentQuality = null;

        this.quality = localStorage.getItem('globeQuality') || 'medium';
        this._applyQualityConfig();

        this._accentRGB = { r: 255, g: 212, b: 0 };
        this._accentDirty = true;

        this._lastRender = 0;
        this._frameInterval = 1000 / this._targetFps;

        this.pts = [];
        this.landPts = [];
        this._ensurePoints();

        this.bindEvents();
        this.resize();

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.stop();
            else if (!isEcoMode && this._shouldRun()) this.start();
        });
    }

    _applyQualityConfig() {
        const configs = {
            low:    { points: 4000,  fps: 30 },
            medium: { points: 8000,  fps: 30 },
            high:   { points: 12000, fps: 60 },
        };
        const cfg = configs[this.quality] || configs.medium;
        this._targetPoints = cfg.points;
        this._targetFps = cfg.fps;
        this._frameInterval = 1000 / this._targetFps;
    }

    setQuality(q) {
        if (!['low', 'medium', 'high'].includes(q)) return;
        this.quality = q;
        localStorage.setItem('globeQuality', q);
        this._applyQualityConfig();
        this._ensurePoints();
    }

    _ensurePoints() {
        const N = this._targetPoints;
        if (this._ptsCache[N] && this._landPtsCache[N]) {
            this.pts = this._ptsCache[N];
            this.landPts = this._landPtsCache[N];
            this._currentQuality = N;
            return;
        }

        const pts = [];
        const landPts = [];
        const GOLDEN = Math.PI * (3 - Math.sqrt(5));
        const DEG = 180 / Math.PI;

        for (let i = 0; i < N; i++) {
            const y = 1 - (i + 0.5) * 2 / N;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const th = GOLDEN * i;
            const x = Math.cos(th) * r;
            const z = Math.sin(th) * r;
            const lat = Math.asin(Math.max(-1, Math.min(1, y))) * DEG;
            const lon = Math.atan2(z, x) * DEG;
            const reg = regionAt(lon, lat);
            const p = { x, y, z, reg, phase: Math.random() * Math.PI * 2 };
            pts.push(p);
            if (reg >= 0) landPts.push(p);
        }

        this._ptsCache[N] = pts;
        this._landPtsCache[N] = landPts;
        this.pts = pts;
        this.landPts = landPts;
        this._currentQuality = N;
    }

    refreshColors() {
        this._accentDirty = true;
    }

    _getAccent() {
        if (this._accentDirty) {
            const raw = getComputedStyle(document.documentElement)
                .getPropertyValue('--y-rgb').trim();
            if (raw) {
                const parts = raw.split(',');
                this._accentRGB = {
                    r: parseInt(parts[0], 10) || 255,
                    g: parseInt(parts[1], 10) || 212,
                    b: parseInt(parts[2], 10) || 0
                };
            }
            this._accentDirty = false;
        }
        return this._accentRGB;
    }

    resize() {
        if (this.disabled) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.DPR = Math.min(window.devicePixelRatio || 1, 1.5);
        this.W = rect.width;
        this.H = rect.height;
        this.hintEl?.classList.remove('hide');
        this.canvas.width  = Math.round(this.W * this.DPR);
        this.canvas.height = Math.round(this.H * this.DPR);
        this.canvas.style.width  = this.W + 'px';
        this.canvas.style.height = this.H + 'px';
        this.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
        this.CX = this.W / 2;
        this.CY = this.H / 2;
        this.RAD = Math.min(this.W, this.H) * 0.34;
    }

    _shouldRun() {
        const home = document.getElementById('page-home');
        return home && home.classList.contains('active') &&
               !document.getElementById('stageColumn')?.classList.contains('show-cover');
    }

        updateHoveredRegion() {
        if (!this.pointerInside || this.dragging) {
            this.hoveredRegion = -1;
            return;
        }
        
        const cY = Math.cos(this.rotY), sY = Math.sin(this.rotY);
        const cX = Math.cos(this.rotX), sX = Math.sin(this.rotX);
        
        let bestD = 35 * 35; 
        let newHover = -1;
        
        for (const p of this.landPts) {
            const x1 = p.x * cY - p.z * sY;
            const z1 = p.x * sY + p.z * cY;
            const y2 = p.y * cX - z1 * sX;
            const z2 = p.y * sX + z1 * cX;
            if (z2 < 0.18) continue;
            
            const sx = this.CX - x1 * this.RAD;
            const sy = this.CY - y2 * this.RAD;
            const dx = sx - this.mouseX, dy = sy - this.mouseY;
            const d2 = dx * dx + dy * dy;
            
            if (d2 < bestD) { 
                bestD = d2; 
                newHover = p.reg; 
            }
        }
        
        this.hoveredRegion = newHover;
    }

    bindEvents() {
        if (this.disabled) return;

        window.addEventListener('resize', () => this.resize());

        this._downX = 0;
        this._downY = 0;
        this._wasDrag = false;

        this.canvas.addEventListener('pointerdown', (e) => {
            this.dragging = true;
            this._wasDrag = false;
            this._downX = e.clientX;
            this._downY = e.clientY;
            this.canvas.classList.add('dragging');
            this.lastPX = e.clientX;
            this.lastPY = e.clientY;
            this.velY = 0; this.velX = 0;
            this.pointerInside = true;
            if (this.canvas.setPointerCapture) {
                try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
            }
            this.hintEl?.classList.add('hide');
        });

        this.canvas.addEventListener('pointermove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
            this.pointerInside = true;

            if (this.dragging) {
                const dx = e.clientX - this.lastPX;
                const dy = e.clientY - this.lastPY;
                this.lastPX = e.clientX;
                this.lastPY = e.clientY;

                const totalDx = Math.abs(e.clientX - this._downX);
                const totalDy = Math.abs(e.clientY - this._downY);
                if (totalDx + totalDy > 6) this._wasDrag = true;

                const k = 0.0052;
                this.rotY += dx * k;
                this.rotX += dy * k;
                this.rotX = Math.max(-1.32, Math.min(1.32, this.rotX));
                this.velY = dx * k * 26;
                this.velX = dy * k * 26;
            }
        });

        this.canvas.addEventListener('pointerup', (e) => {
            const wasDrag = this._wasDrag;

            this.dragging = false;
            this._wasDrag = false;
            this.canvas.classList.remove('dragging');
            try {
                if (this.canvas.releasePointerCapture) {
                    this.canvas.releasePointerCapture(e.pointerId);
                }
            } catch (err) {}

            if (wasDrag) return;

            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;

            this.updateHoveredRegion();
            this.handleRegionClick();
        });

        this.canvas.addEventListener('pointercancel', () => {
            this.dragging = false;
            this._wasDrag = false;
            this.canvas.classList.remove('dragging');
        });

        this.canvas.addEventListener('pointerleave', () => {
            if (this.dragging) return;
            this.pointerInside = false;
            this.hoveredRegion = -1;
        });

        this.infoPlayEl?.addEventListener('click', () => {
            if (this.selectedRegion < 0) return;
            this.playRegion(this.selectedRegion);
        });
    }

    handleRegionClick() {
        if (this.hoveredRegion < 0) {
            this.selectedRegion = -1;
            this.infoEl?.classList.remove('active');
            return;
        }

        this.selectedRegion = this.hoveredRegion;
        const name = REGION_NAMES[this.selectedRegion];
        const count = this.countTracksInRegion(this.selectedRegion);

        if (this.infoNameEl) this.infoNameEl.textContent = name.toUpperCase();
        if (this.infoCountEl) {
            this.infoCountEl.textContent = count > 0
                ? `${count} ${count === 1 ? 'трек' : (count < 5 ? 'трека' : 'треков')}`
                : 'нет треков';
        }
        if (this.infoPlayEl) this.infoPlayEl.disabled = count === 0;
        this.infoEl?.classList.add('active');

        if (typeof this.onRegionSelect === 'function') {
            this.onRegionSelect(this.selectedRegion, name, count);
        }
    }

    countTracksInRegion(regIdx) {
        if (!window.audioEngine) return 0;
        return window.audioEngine.playlist.filter(t => t.region === regIdx).length;
    }

    playRegion(regIdx) {
        const engine = window.audioEngine;
        if (!engine) return;
        const tracks = engine.playlist.filter(t => t.region === regIdx);
        if (tracks.length === 0) {
            showNotification('В этом регионе пока нет треков', true);
            return;
        }
        const firstIdx = engine.playlist.indexOf(tracks[0]);
        engine.currentIndex = firstIdx;
        engine.loadCurrentTrack();
        engine.play();
        if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
        showNotification(`▶️ ${REGION_NAMES[regIdx]}: ${tracks.length} треков`);
    }

    buildLabel(text) {
        if (this.labelCache.has(text)) return this.labelCache.get(text);
        const FS = 100;
        const FONT = '900 ' + FS + 'px "Arial Black", sans-serif';
        const tmp = document.createElement('canvas');
        let tctx = tmp.getContext('2d');
        tctx.font = FONT;
        const tw = Math.ceil(tctx.measureText(text).width) + 48;
        const th = Math.ceil(FS * 1.45);
        tmp.width = tw; tmp.height = th;
        tctx = tmp.getContext('2d');
        tctx.font = FONT;
        tctx.textAlign = 'center';
        tctx.textBaseline = 'middle';
        tctx.fillStyle = '#fff';
        tctx.fillText(text, tw / 2, th / 2 + 2);
        const data = tctx.getImageData(0, 0, tw, th).data;
        const STEP = 6;
        const dots = [];
        for (let y = 0; y < th; y += STEP) {
            for (let x = 0; x < tw; x += STEP) {
                if (data[(y * tw + x) * 4 + 3] > 130) {
                    dots.push({ x: x + STEP * 0.5, y: y + STEP * 0.5,
                                delay: (x / tw) * 0.42 + Math.random() * 0.18 });
                }
            }
        }
        const res = { dots, w: tw, h: th, step: STEP };
        this.labelCache.set(text, res);
        return res;
    }

    makePalette(r, g, b) {
        const arr = new Array(66);
        for (let i = 0; i <= 65; i++) {
            arr[i] = `rgba(${r},${g},${b},${(i / 65).toFixed(3)})`;
        }
        return arr;
    }

    start() {
        if (this.disabled || this.animId) return;
        if (!this._shouldRun()) return;

        clearTimeout(this._hintTimer);
        this._hintTimer = setTimeout(() => {
            this.hintEl?.classList.add('hide');
        }, 6000);

        this._lastRender = 0;
        this.lastT = performance.now();
        const loop = (now) => {
            this.animId = requestAnimationFrame(loop);

            if (now - this._lastRender < this._frameInterval) return;
            this._lastRender = now;

            this.frame(now);
        };
        this.animId = requestAnimationFrame(loop);
    }

    stop() {
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
        if (this.ctx) this.ctx.clearRect(0, 0, this.W, this.H);
    }

    frame(now) {
        let dt = (now - this.lastT) / 1000;
        this.lastT = now;
        if (!isFinite(dt) || dt <= 0) dt = 0.016;
        if (dt > 0.05) dt = 0.05;
        const fpsMult = this._targetFps === 30 ? 2 : 1;
        const dtAdjusted = dt * fpsMult;

        if (!this.dragging) {
            this.rotY += this.velY * dt;
            this.rotX += this.velX * dt;
            const decay = Math.pow(0.3, dtAdjusted);
            this.velY *= decay;
            this.velX *= decay;
            if (Math.abs(this.velY) < 0.002) this.velY = 0;
            if (Math.abs(this.velX) < 0.002) this.velX = 0;
            this.rotX = Math.max(-1.32, Math.min(1.32, this.rotX));
        }
        if (!this.dragging && this.hoveredRegion < 0) this.rotY += 0.13 * dt;

        const cY = Math.cos(this.rotY), sY = Math.sin(this.rotY);
        const cX = Math.cos(this.rotX), sX = Math.sin(this.rotX);

        this.updateHoveredRegion();

        this.anyHover = 0;
        const ease = Math.min(1, dtAdjusted * 13);
        for (let i = 0; i < REGION_DATA.length; i++) {
            const target = (i === this.hoveredRegion) ? 1 : 0;
            this.hoverAmt[i] += (target - this.hoverAmt[i]) * ease;
            if (this.hoverAmt[i] > this.anyHover) this.anyHover = this.hoverAmt[i];
        }

        if (this.hoveredRegion !== this.labelRegion) {
            this.labelRegion = this.hoveredRegion;
            if (this.hoveredRegion >= 0) {
                const built = this.buildLabel(REGION_DATA[this.hoveredRegion].name);
                this.labelDots = built.dots;
                this.labelW = built.w;
                this.labelH = built.h;
                this.labelStep = built.step;
                this.labelStart = now;
            }
        }
        this.labelTarget = (this.hoveredRegion >= 0) ? 1 : 0;
        this.labelAlpha += (this.labelTarget - this.labelAlpha) * Math.min(1, dtAdjusted * (this.labelTarget > 0 ? 14 : 7));

        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.W, this.H);

        const { r, g, b } = this._getAccent();
        const PAL_LAND  = this.makePalette(r, g, b);
        const PAL_DIM   = this.makePalette(Math.round(r * 0.6), Math.round(g * 0.6), Math.round(b * 0.6));
        const PAL_HOT   = this.makePalette(255, Math.min(255, g + 30), Math.min(255, b + 60));
        const PAL_OCEAN = this.makePalette(r, g, b);

        const glow = ctx.createRadialGradient(this.CX, this.CY, this.RAD * 0.1, this.CX, this.CY, this.RAD * 1.9);
        glow.addColorStop(0, `rgba(${r},${g},${b},0.085)`);
        glow.addColorStop(0.45, `rgba(${r},${g},${b},0.030)`);
        glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(this.CX, this.CY, this.RAD * 1.9, 0, Math.PI * 2);
        ctx.fill();

        let curStyle = '';
        const t = now * 0.005;

        for (const p of this.pts) {
            const x1 = p.x * cY - p.z * sY;
            const z1 = p.x * sY + p.z * cY;
            const y2 = p.y * cX - z1 * sX;
            const z2 = p.y * sX + z1 * cX;
            if (z2 <= 0) continue;

            const sx = this.CX - x1 * this.RAD;
            const sy = this.CY - y2 * this.RAD;
            const d = Math.sqrt(z2);

            let a, size, pal;
            if (p.reg < 0) {
                a = 0.030 + 0.085 * d;
                size = 1.4 + 0.7 * d;
                pal = PAL_OCEAN;
            } else {
                const h = this.hoverAmt[p.reg];
                const baseA = 0.20 + 0.80 * d;
                const baseS = 1.15 + 1.85 * d;
                if (h > 0.012) {
                    const pulse = 0.86 + 0.14 * Math.sin(t + p.phase);
                    a = baseA + (1 - baseA) * h * 0.88 * pulse;
                    size = baseS + 2.1 * h * (0.9 + 0.1 * pulse);
                    pal = PAL_HOT;
                } else {
                    a = baseA * (1 - 0.58 * this.anyHover);
                    size = baseS * (1 - 0.22 * this.anyHover);
                    pal = (this.anyHover > 0.012) ? PAL_DIM : PAL_LAND;
                }
            }

            let ai = (a * 65) | 0;
            if (ai < 0) ai = 0; else if (ai > 65) ai = 65;
            const style = pal[ai];
            if (style !== curStyle) { ctx.fillStyle = style; curStyle = style; }
            ctx.fillRect(sx - size * 0.5, sy - size * 0.5, size, size);
        }

        if (this.labelDots && this.labelAlpha > 0.012) {
            const sc = Math.min((this.W * 0.86) / this.labelW, (this.H * 0.17) / this.labelH, 1.4);
            const dw = this.labelW * sc, dh = this.labelH * sc;
            const ox = (this.W - dw) * 0.5;
            const oy = this.H * 0.95 - dh;
            const elapsed = (now - this.labelStart) / 1000;
            const DUR = 0.46;
            curStyle = '';
            for (const dot of this.labelDots) {
                let p = (elapsed - dot.delay) / DUR;
                if (p <= 0) continue;
                if (p > 1) p = 1;
                const e = 1 - Math.pow(1 - p, 3);
                const size = this.labelStep * sc * 0.72 * (0.35 + 0.65 * e);
                const a = this.labelAlpha * e;
                let ai = (a * 65) | 0;
                if (ai < 1) continue;
                if (ai > 65) ai = 65;
                const style = PAL_HOT[ai];
                if (style !== curStyle) { ctx.fillStyle = style; curStyle = style; }
                ctx.fillRect(ox + dot.x * sc - size * 0.5,
                             oy + dot.y * sc - size * 0.5,
                             size, size);
            }
        }
    }
}