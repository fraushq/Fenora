class Visualizer {
    constructor(audioEngine) {
        this.audioEngine = audioEngine;
        this.mode = 'bars';
        this.animId = null;
        this.bars = [];
        this.canvas = null;
        this.ctx = null;
        this.pulse = null;
        this.disabled = false;
        this.init();
    }

    init() {
        const container = document.getElementById('visualizer');
        if (!container) {
            this.disabled = true;
            return;
        }
        container.innerHTML = '';

        const barsWrap = document.createElement('div');
        barsWrap.className = 'viz-bars';
        for (let i = 0; i < 32; i++) {
            const bar = document.createElement('div');
            bar.className = 'viz-bar';
            barsWrap.appendChild(bar);
            this.bars.push(bar);
        }
        container.appendChild(barsWrap);

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'viz-wave';
        this.canvas.width = 380;
        this.canvas.height = 60;
        this.ctx = this.canvas.getContext('2d');
        container.appendChild(this.canvas);

        const pulseWrap = document.createElement('div');
        pulseWrap.className = 'viz-pulse-wrap';
        this.pulse = document.createElement('div');
        this.pulse.className = 'viz-pulse';
        pulseWrap.appendChild(this.pulse);
        container.appendChild(pulseWrap);

        container.dataset.mode = this.mode;
    }

    setMode(mode) {
        if (!['bars', 'wave', 'pulse'].includes(mode)) mode = 'bars';
        if (this.disabled && mode !== 'bars') mode = 'bars';
        this.mode = mode;

        const container = document.getElementById('visualizer');
        if (!container) return;
        container.dataset.mode = mode;

        if (mode !== 'bars') {
            this.bars.forEach(b => b.style.height = '4px');
        }
        if (mode !== 'wave' && this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        if (mode !== 'pulse' && this.pulse) {
            this.pulse.style.transform = 'scale(1)';
            this.pulse.style.boxShadow = '0 0 0 0 transparent';
            this.pulse.style.background = 'var(--ink)';
        }
    }

    start() {
        if (this.animId || this.disabled) return;
        const animate = () => {
            if (isEcoMode) { this.stop(); return; }
            const data = this.audioEngine.getFrequencyData();
            if (data) {
                if (this.mode === 'bars')       this.drawBars(data);
                else if (this.mode === 'wave' && this.canvas && this.ctx)  this.drawWave(data);
                else if (this.mode === 'pulse' && this.pulse)              this.drawPulse(data);
            }
            this.animId = requestAnimationFrame(animate);
        };
        this.animId = requestAnimationFrame(animate);
    }

    stop() {
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
        if (this.disabled) return;
        this.bars.forEach(bar => bar.style.height = '4px');
        if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.pulse) {
            this.pulse.style.transform = 'scale(1)';
            this.pulse.style.boxShadow = '0 0 0 0 transparent';
            this.pulse.style.background = 'var(--ink)';
        }
    }

    drawBars(data) {
        if (!this.bars.length) return;
        const step = Math.floor(data.length / this.bars.length);
        this.bars.forEach((bar, i) => {
            const h = Math.max(4, (data[i * step] / 255) * 60);
            bar.style.height = h + 'px';
        });
    }

    drawWave(data) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const mid = h / 2;

        this.ctx.clearRect(0, 0, w, h);

        const N = 64;
        const step = Math.max(1, Math.floor(data.length / N));
        const points = [];
        for (let i = 0; i < N; i++) {
            const amp = (data[i * step] / 255) * (h / 2 - 4);
            points.push({
                x: (i / (N - 1)) * w,
                y: mid - amp
            });
        }

        this.ctx.beginPath();
        this.ctx.moveTo(0, mid);
        for (const p of points) this.ctx.lineTo(p.x, p.y);
        this.ctx.lineTo(w, mid);
        this.ctx.closePath();
        const [r, g, b] = getAccentRGB();
        this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.15)`;
        this.ctx.fill();

        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            this.ctx.lineTo(points[i].x, points[i].y);
        }
        this.ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        this.ctx.lineWidth = 2;
        this.ctx.lineJoin = 'round';
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(0, mid);
        for (const p of points) {
            this.ctx.lineTo(p.x, mid + (mid - p.y));
        }
        this.ctx.lineTo(w, mid);
        this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.3)`;
        this.ctx.lineWidth = 1;
        this.ctx.stroke();
    }

    drawPulse(data) {
        if (!this.pulse) return;
        const bassCount = Math.max(1, Math.floor(data.length / 8));
        let sum = 0;
        for (let i = 0; i < bassCount; i++) sum += data[i];
        const bass = sum / bassCount / 255;

        const scale = 1 + bass * 0.45;
        const glow = Math.round(bass * 24);

        this.pulse.style.transform = `scale(${scale.toFixed(3)})`;
        const [r, g, b] = getAccentRGB();
        this.pulse.style.boxShadow = `0 0 ${glow}px rgba(${r}, ${g}, ${b}, ${(bass * 0.7).toFixed(2)})`;
        this.pulse.style.background = bass > 0.55 ? `rgb(${r}, ${g}, ${b})` : 'var(--ink)';
    }
}