class BackgroundSystem {
    constructor() {
        this.canvas = document.getElementById('bgCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.animId = null;
        this.grid = [];
        this.cellSize = 0;
        this.cols = 0;
        this.rows = 0;
        this.audioEngine = null;

        this._inkColor = '#0A0A0A';
        this._accentRGB = [254, 23, 67];
        this._accentDirty = true;
        this._updateColorCache();

        this._lastRender = 0;
        this._frameInterval = 1000 / 30;

        this.resize();
        window.addEventListener('resize', () => this.resize());

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.stop();
            } else if (!isEcoMode) {
                this.start();
            }
        });
    }

    setAudioEngine(engine) {
        this.audioEngine = engine;
    }

    _updateColorCache() {
        const style = getComputedStyle(document.documentElement);
        this._inkColor = style.getPropertyValue('--ink').trim() || '#0A0A0A';
        this._accentDirty = true;
    }

    refreshColors() {
        this._updateColorCache();
    }

    resize() {
        this.canvas.width  = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.buildGrid();
    }

    buildGrid() {
        const maxDim = Math.max(this.canvas.width, this.canvas.height);
        this.cellSize = Math.max(24, Math.round(maxDim / 32));
        this.cols = Math.ceil(this.canvas.width / this.cellSize);
        this.rows = Math.ceil(this.canvas.height / this.cellSize);

        this.grid = [];
        const grid = this.grid;
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                grid.push({
                    x: c * this.cellSize,
                    y: r * this.cellSize,
                    intensity: Math.random() * 0.15,
                    target: Math.random() * 0.15,
                    phase: Math.random() * Math.PI * 2,
                    speed: 0.0004 + Math.random() * 0.0008
                });
            }
        }
    }

    start() {
        if (this.animId) return;
        this._lastRender = 0;
        const draw = (now) => {
            if (isEcoMode) { this.stop(); return; }
            this.animId = requestAnimationFrame(draw);

            if (now - this._lastRender < this._frameInterval) return;
            this._lastRender = now;

            this.update();
            this.render();
        };
        this.animId = requestAnimationFrame(draw);
    }

    update() {
        const audioActive = this.audioEngine && this.audioEngine.isPlaying;
        const data = audioActive ? this.audioEngine.getFrequencyData() : null;
        const W = this.canvas.width;
        const H = this.canvas.height;

        if (data && data.length > 0) {
            const N = data.length - 1;
            for (const sq of this.grid) {
                const cx = sq.x / W;
                const cy = sq.y / H;
                const fIdx = Math.floor((cx * 0.7 + (1 - cy) * 0.3) * N);
                const freq = data[fIdx] / 255;
                sq.target = freq * Math.sqrt(freq);
            }
        } else {
            for (const sq of this.grid) {
                sq.phase += sq.speed;
                sq.target = 0.03 + (Math.sin(sq.phase) * 0.5 + 0.5) * 0.12;
            }
        }

        for (const sq of this.grid) {
            sq.intensity += (sq.target - sq.intensity) * 0.2;
        }
    }

    render() {
        const ctx = this.ctx;
        const cs = this.cellSize;
        const gap = 2;

        ctx.fillStyle = this._inkColor;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        if (this._accentDirty) {
            if (typeof getAccentRGB === 'function') {
                this._accentRGB = getAccentRGB();
            }
            this._accentDirty = false;
        }
        const [r, g, b] = this._accentRGB;

        const buckets = [[], [], [], []];
        for (const sq of this.grid) {
            const i = sq.intensity;
            if (i < 0.02) continue;
            const alpha = Math.min(0.55, i * 0.7);
            const bucket = alpha < 0.15 ? 0 : alpha < 0.3 ? 1 : alpha < 0.45 ? 2 : 3;
            buckets[bucket].push(sq);
        }

        const alphas = [0.10, 0.22, 0.37, 0.55];
        const w = cs - gap * 2;
        for (let bi = 0; bi < 4; bi++) {
            const list = buckets[bi];
            if (!list.length) continue;
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alphas[bi]})`;
            for (const sq of list) {
                ctx.fillRect(sq.x + gap, sq.y + gap, w, w);
            }
        }
    }

    stop() {
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
        if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
}