function parseTrackFilename(name) {
    let baseName = String(name || '').replace(/\.[^/.]+$/, '');

    baseName = baseName.replace(/^\s*[\[\(]?\d{1,3}[\]\)]?\s*[-._\u2013\u2014]\s*/, '');
    baseName = baseName.trim();

    let title  = baseName || 'Неизвестный трек';
    let artist = 'Неизвестный исполнитель';

    const m = baseName.match(/^(.+?)\s+[-\u2013\u2014]\s+(.+)$/);
    if (m && m[1].trim() && m[2].trim()) {
        artist = m[1].trim();
        title  = m[2].trim();
    }

    if (/^\d+$/.test(artist)) {
        title  = `${artist} - ${title}`;
        artist = 'Неизвестный исполнитель';
    }

    return { artist, title };
}

class AudioEngine {
    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = 'anonymous';
        this.audio.preload = 'metadata';
        this.playlist = [];
        this.currentIndex = 0;
        this.isPlaying = false;
        this.shuffle = false;
        this.repeatMode = 'off';
        this.volume = 0.25;
        this.audio.volume = 1;
        this.audio.muted = false;
        this._preMuteVolume = 0.25;
        this._muted = false;
        this.masterGain = null;
        this.audioCtx = null;
        this.analyser = null;
        this.sourceNode = null;
        this.highpass = null;
        this.lowpass = null;
        this.fadeGain = null;
        this.currentQuality = 'high';
        this.currentEQ = 'flat';
        this.crossfadeDuration = 0;
        this.eqFilters = [];
        this._expectFadeIn = false;
        this._isFadingOut = false;
        this.storage = null;
        this.normalizeEnabled = true;
        this.normGain = null;
        this.limiter = null;
        this.normAnalyser = null;
        this._normBuf = null;
        this._rmsSmoothed = 0;
        this._normTimer = null;
        this._normTarget = 0.08;
        this.onCoverLoaded = null;
        this.setupListeners();
    }

        setStorage(storage) {
        this.storage = storage;
    }

    setupListeners() {
        this.audio.addEventListener('ended', () => {
            if (this.repeatMode === 'one') {
                this.audio.currentTime = 0;
                this.audio.play().catch(() => {});
            } else {
                this._expectFadeIn = this.crossfadeDuration > 0;
                this.next(true);
            }
            if (typeof this.onPause === 'function') this.onPause();
        });

        this.audio.addEventListener('timeupdate', () => {
            this.checkCrossfade();
            this._maybeCountPlay();
        });

        this.audio.addEventListener('play', () => {
            this.isPlaying = true;
            this.updatePlayButtons();
            if (this.normalizeEnabled && !this._normTimer) {
                this._startNormLoop();
            }
            if (typeof this.onPlay === 'function') this.onPlay();
        });

        this.audio.addEventListener('pause', () => {
            this.isPlaying = false;
            this.updatePlayButtons();
            if (typeof this.onPause === 'function') this.onPause();
        });

        this.audio.addEventListener('loadedmetadata', () => {
            const totalEl = document.getElementById('totalTime');
            if (totalEl) totalEl.textContent = this.formatTime(this.audio.duration);
            const track = this.playlist[this.currentIndex];
            if (track) {
                track.duration = this.audio.duration;
                if (this.storage) {
                    this.storage.updateMetadata(track).catch(() => {});
                }
            }
        });

        this.audio.addEventListener('error', (e) => {
            console.warn('Audio error:', e);
        });
    }

    initAudioContext() {
        if (this.audioCtx) {
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            return;
        }
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            this.audioCtx = new Ctx();
            this.highpass = this.audioCtx.createBiquadFilter();
            this.highpass.type = 'highpass';
            this.highpass.frequency.value = 20;
            this.highpass.Q.value = 0.7;
            this.lowpass = this.audioCtx.createBiquadFilter();
            this.lowpass.type = 'lowpass';
            this.lowpass.frequency.value = 22050;
            this.lowpass.Q.value = 0.7;

            const bands = [
                { freq: 32,    type: 'lowshelf',  Q: 0.7 },
                { freq: 64,    type: 'peaking',   Q: 1.4 },
                { freq: 125,   type: 'peaking',   Q: 1.4 },
                { freq: 250,   type: 'peaking',   Q: 1.4 },
                { freq: 500,   type: 'peaking',   Q: 1.4 },
                { freq: 1000,  type: 'peaking',   Q: 1.4 },
                { freq: 2000,  type: 'peaking',   Q: 1.4 },
                { freq: 4000,  type: 'peaking',   Q: 1.4 },
                { freq: 8000,  type: 'peaking',   Q: 1.4 },
                { freq: 16000, type: 'highshelf', Q: 0.7 }
            ];
            this.eqFilters = bands.map(b => {
                const f = this.audioCtx.createBiquadFilter();
                f.type = b.type;
                f.frequency.value = b.freq;
                f.Q.value = b.Q;
                f.gain.value = 0;
                return f;
            });

            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.8;
            this.fadeGain = this.audioCtx.createGain();
            this.fadeGain.gain.value = 1;
            this.normGain = this.audioCtx.createGain();
            this.normGain.gain.value = 1;
            this.limiter = this.audioCtx.createDynamicsCompressor();
            this.limiter.threshold.value = 0; 
            this.limiter.knee.value = 6;
            this.limiter.ratio.value = 1;
            this.limiter.attack.value = 0.003;
            this.limiter.release.value = 0.25;
            this.normAnalyser = this.audioCtx.createAnalyser();
            this.normAnalyser.fftSize = 2048;
            this.normAnalyser.smoothingTimeConstant = 0.3;
            this._normBuf = new Float32Array(this.normAnalyser.fftSize);
            this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);
            this.masterGain = this.audioCtx.createGain();
            this.masterGain.gain.value = this._muted ? 0 : this.volume;
            let node = this.sourceNode;
            node.connect(this.highpass); node = this.highpass;
            for (const f of this.eqFilters) { node.connect(f); node = f; }
            node.connect(this.lowpass);   node = this.lowpass;
            this.lowpass.connect(this.normGain);
            this.normGain.connect(this.limiter);
            this.limiter.connect(this.fadeGain);
            this.fadeGain.connect(this.analyser);
            this.analyser.connect(this.masterGain);
            this.masterGain.connect(this.audioCtx.destination);
            this.lowpass.connect(this.normAnalyser);
            this.applyQuality(this.currentQuality);
            this.applyEQ(this.currentEQ);
            this.setNormalize(this.normalizeEnabled);

        } catch (err) {
            console.warn('AudioContext init failed:', err);
            this.audioCtx = null;
            this.analyser = null;
            this.sourceNode = null;
            this.highpass = null;
            this.lowpass = null;
            this.fadeGain = null;
            this.eqFilters = [];
            this.normGain = null;
            this.limiter = null;
            this.normAnalyser = null;
            this._normBuf = null;
        }
    }

    _extractCover(track, file) {
        if (!window.jsmediatags || !file) return;

        try {
            window.jsmediatags.read(file, {
                onSuccess: (tag) => {
                    const pic = tag && tag.tags && tag.tags.picture;
                    if (!pic || !pic.data) return;

                    try {
                        const bytes = new Uint8Array(pic.data);
                        const blob = new Blob([bytes], {
                            type: pic.format || 'image/jpeg'
                        });
                        if (blob.size > 5 * 1024 * 1024) return;

                        track.coverBlob = blob;
                        if (track.coverUrl) {
                            try { URL.revokeObjectURL(track.coverUrl); } catch (e) {}
                        }
                        track.coverUrl = URL.createObjectURL(blob);
                        if (this.storage) {
                            this.storage.updateMetadata(track).catch(() => {});
                        }
                        if (typeof this.onCoverLoaded === 'function') {
                            this.onCoverLoaded(track);
                        }
                    } catch (e) {
                        console.warn('cover parse failed:', e);
                    }
                },
                onError: () => {}
            });

        } catch (e) {
            console.warn('_extractCover error:', e);
        }
    }
    reextractAllCovers() {
        if (!this.storage) return;
        this.playlist.forEach(track => {
            if (track.coverBlob || !track.blob) return;
            this._extractCover(track, track.blob);
        });
    }

    getFrequencyData() {
        if (!this.analyser) return null;
        const data = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(data);
        return data;
    }

    setNormalize(enabled) {
        this.normalizeEnabled = !!enabled;
        if (!this.audioCtx) return;

        const now = this.audioCtx.currentTime;

        if (enabled) {
            this.limiter.threshold.setTargetAtTime(-6, now, 0.1);
            this.limiter.ratio.setTargetAtTime(12, now, 0.1);
            this._rmsSmoothed = 0;
            if (this.isPlaying) this._startNormLoop();
        } else {
            this.limiter.threshold.setTargetAtTime(0, now, 0.1);
            this.limiter.ratio.setTargetAtTime(1, now, 0.1);
            this.normGain.gain.cancelScheduledValues(now);
            this.normGain.gain.setTargetAtTime(1, now, 0.3);
            this._stopNormLoop();
        }
    }

    _startNormLoop() {
        if (this._normTimer) return;
        this._tickNorm();
    }

    _stopNormLoop() {
        clearTimeout(this._normTimer);
        this._normTimer = null;
    }

    _tickNorm() {
        if (!this.normalizeEnabled || !this.audioCtx) {
            this._normTimer = null;
            return;
        }
        if (!this.isPlaying) {
            this._normTimer = null;
            return;
        }
        this._updateNormGain();
        this._normTimer = setTimeout(() => this._tickNorm(), 200);
    }

    _maybeCountPlay() {
        const track = this.playlist[this.currentIndex];
        if (!track) return;
        if (track._counted) return;
        if (this.audio.currentTime < 20) return;

        track._counted = true;
        track.playCount = (track.playCount || 0) + 1;

        if (this.storage) {
            this.storage.updateMetadata(track).catch(() => {});
        }
        if (typeof this.onPlayCounted === 'function') {
            try { this.onPlayCounted(track); } catch (e) {}
        }
    }


    _updateNormGain() {
        if (!this.normAnalyser || !this.normGain) return;

        this.normAnalyser.getFloatTimeDomainData(this._normBuf);

        let sum = 0;
        for (let i = 0; i < this._normBuf.length; i++) {
            const s = this._normBuf[i];
            sum += s * s;
        }
        const rms = Math.sqrt(sum / this._normBuf.length);
        if (rms < 0.0005) return;
        if (this._rmsSmoothed === 0) this._rmsSmoothed = rms;
        else this._rmsSmoothed = this._rmsSmoothed * 0.85 + rms * 0.15;
        let desired = this._normTarget / this._rmsSmoothed;
        desired = Math.max(0.6, Math.min(2.5, desired));
        const now = this.audioCtx.currentTime;
        this.normGain.gain.cancelScheduledValues(now);
        this.normGain.gain.setTargetAtTime(desired, now, 0.8);
    }

    setEQPreset(preset) {
        const valid = ['flat', 'bass', 'vocal', 'electronic', 'rock', 'classical'];
        if (!valid.includes(preset)) return;
        this.currentEQ = preset;
        if (this.audioCtx) this.applyEQ(preset);
    }

    applyEQ(preset) {
        if (!this.eqFilters.length) return;
        const gains = EQ_PRESETS[preset] || EQ_PRESETS.flat;
        this.applyEQGains(gains);
    }

    applyEQGains(gainsArray) {
        if (!this.eqFilters.length || !this.audioCtx) return;
        const now = this.audioCtx.currentTime;
        const smooth = 0.05;
        this.eqFilters.forEach((f, i) => {
            const g = Math.max(-12, Math.min(12, gainsArray[i] || 0));
            f.gain.setTargetAtTime(g, now, smooth);
        });
    }

    setEQGains(gainsArray) {
        this.currentEQ = 'custom';
        if (!this.eqFilters.length) return;
        this.applyEQGains(gainsArray);
    }

    getEQGains() {
        if (!this.eqFilters.length) return [...EQ_PRESETS.flat];
        return this.eqFilters.map(f => f.gain.value);
    }

    setQuality(level) {
        if (!['low', 'normal', 'high', 'lossless'].includes(level)) return;
        this.currentQuality = level;
        if (this.audioCtx) this.applyQuality(level);
    }

    applyQuality(level) {
        if (!this.highpass || !this.lowpass || !this.analyser) return;
        const now = this.audioCtx.currentTime;
        const smooth = 0.05;

        switch (level) {
            case 'low':
                this.highpass.frequency.setTargetAtTime(300, now, smooth);
                this.lowpass.frequency.setTargetAtTime(3400, now, smooth);
                this.analyser.fftSize = 128;
                break;
            case 'normal':
                this.highpass.frequency.setTargetAtTime(60, now, smooth);
                this.lowpass.frequency.setTargetAtTime(8000, now, smooth);
                this.analyser.fftSize = 256;
                break;
            case 'high':
                this.highpass.frequency.setTargetAtTime(20, now, smooth);
                this.lowpass.frequency.setTargetAtTime(16000, now, smooth);
                this.analyser.fftSize = 256;
                break;
            case 'lossless':
                this.highpass.frequency.setTargetAtTime(15, now, smooth);
                this.lowpass.frequency.setTargetAtTime(22050, now, smooth);
                this.analyser.fftSize = 256;
                break;
        }
    }

    setCrossfade(seconds) {
        const s = Math.max(0, Math.min(12, parseInt(seconds, 10) || 0));
        this.crossfadeDuration = s;
    }

    checkCrossfade() {
        if (!this.crossfadeDuration || !this.fadeGain) return;
        if (this._isFadingOut) return;

        const dur = this.audio.duration;
        if (!dur || !isFinite(dur) || dur <= 0) return;

        const remain = dur - this.audio.currentTime;
        if (remain <= this.crossfadeDuration && remain > 0.05) {
            this._isFadingOut = true;
            this.fadeOut(this.crossfadeDuration);
        }
    }

    fadeOut(duration) {
        if (!this.fadeGain || !this.audioCtx) return;
        const now = this.audioCtx.currentTime;
        this.fadeGain.gain.cancelScheduledValues(now);
        this.fadeGain.gain.setValueAtTime(this.fadeGain.gain.value, now);
        this.fadeGain.gain.linearRampToValueAtTime(0.0001, now + duration);
    }

    fadeIn(duration) {
        if (!this.fadeGain || !this.audioCtx) return;
        const now = this.audioCtx.currentTime;
        this.fadeGain.gain.cancelScheduledValues(now);
        this.fadeGain.gain.setValueAtTime(0.0001, now);
        this.fadeGain.gain.linearRampToValueAtTime(1, now + duration);
    }

        addTracks(files) {
        const audioFiles = files.filter(f =>
            f.type.startsWith('audio/') ||
            /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i.test(f.name)
        );
        const added = [];

        audioFiles.forEach((file, i) => {
            const url = URL.createObjectURL(file);
            const { artist, title } = parseTrackFilename(file.name);

            const createdAt = Date.now() + i;

            const track = {
                id: 'trk_' + createdAt + '_' + Math.random().toString(36).slice(2, 8),
                title,
                artist,
                url,
                duration: 0,
                fileName: file.name,
                region: guessRegionFromArtist(artist),
                blob: file,
                createdAt,
                playCount: 0,
                lastPlayedAt: null
            };

            this.playlist.push(track);
            added.push(track);

            if (this.storage) {
                this.storage.saveTrack(track).catch(e =>
                    console.warn('Не удалось сохранить трек:', e)
                );
            }
            this._extractCover(track, file);
        });

        if (added.length > 0 && this.playlist.length === added.length) {
            this.currentIndex = 0;
            this.loadCurrentTrack();
        }
        return added;
    }

    removeTrack(index) {
        if (index < 0 || index >= this.playlist.length) return;
        const track = this.playlist[index];
        const wasPlaying = this.isPlaying && this.currentIndex === index;

        if (this.storage) {
            this.storage.deleteTrack(track.id).catch(e =>
                console.warn('Не удалось удалить трек:', e)
            );
        }

        if (track.url && track.url.startsWith('blob:')) {
            try { URL.revokeObjectURL(track.url); } catch (e) {}
        }
        if (track.coverUrl && track.coverUrl.startsWith('blob:')) {
            try { URL.revokeObjectURL(track.coverUrl); } catch (e) {}
        }
        this.playlist.splice(index, 1);

        if (this.playlist.length === 0) {
            this.audio.pause();
            this.audio.removeAttribute('src');
            this.audio.load();
            this.isPlaying = false;
            this.updatePlayButtons();
            document.getElementById('trackTitle').textContent = 'Загрузите музыку';
            document.getElementById('trackArtist').textContent = 'Нажмите кнопку "Загрузить"';
            document.getElementById('progressFill').style.width = '0%';
            document.getElementById('currentTime').textContent = '0:00';
            document.getElementById('totalTime').textContent = '0:00';
            return;
        }

        if (index < this.currentIndex) {
            this.currentIndex--;
        } else if (index === this.currentIndex) {
            this.currentIndex = Math.min(this.currentIndex, this.playlist.length - 1);
            this.loadCurrentTrack();
            if (wasPlaying) this.play();
        }
    }

    removeTracks(ids) {
        if (!ids || ids.length === 0) return 0;
        const idSet = new Set(ids);
        const currentTrack = this.playlist[this.currentIndex];
        const wasPlaying = this.isPlaying;
        const currentRemoved = currentTrack && idSet.has(currentTrack.id);
        for (const t of this.playlist) {
            if (!idSet.has(t.id)) continue;
            if (t.url && t.url.startsWith('blob:')) {
                try { URL.revokeObjectURL(t.url); } catch (e) {}
            }
            if (t.coverUrl && t.coverUrl.startsWith('blob:')) {
                try { URL.revokeObjectURL(t.coverUrl); } catch (e) {}
            }
            if (this.storage) {
                this.storage.deleteTrack(t.id).catch(() => {});
            }
        }

        const before = this.playlist.length;
        this.playlist = this.playlist.filter(t => !idSet.has(t.id));
        const removedCount = before - this.playlist.length;

        if (this.playlist.length === 0) {
            this.audio.pause();
            this.audio.removeAttribute('src');
            this.audio.load();
            this.isPlaying = false;
            this.updatePlayButtons();

            const set = (id, text) => {
                const el = document.getElementById(id);
                if (el) el.textContent = text;
            };
            set('trackTitle', 'Загрузите музыку');
            set('trackArtist', 'Нажмите кнопку "Загрузить"');
            set('currentTime', '0:00');
            set('totalTime', '0:00');
            const pf = document.getElementById('progressFill');
            if (pf) pf.style.width = '0%';

            this._updatePlayerCover(null);
            return removedCount;
        }

        if (currentRemoved) {
            this.currentIndex = Math.min(this.currentIndex, this.playlist.length - 1);
            this.loadCurrentTrack();
            if (wasPlaying) this.play();
        } else {
            const newIdx = this.playlist.indexOf(currentTrack);
            if (newIdx >= 0) this.currentIndex = newIdx;
        }

        return removedCount;
    }

    async restoreFromStorage() {
        if (!this.storage) return 0;

        const records = await this.storage.getAllTracks();
        if (!records.length) return 0;

        for (const t of this.playlist) {
            if (t.url && t.url.startsWith('blob:')) {
                try { URL.revokeObjectURL(t.url); } catch (e) {}
            }
        }
        this.playlist = [];

        records.forEach(rec => {
            const parsed = rec.fileName ? parseTrackFilename(rec.fileName) : null;
            const finalArtist = parsed ? parsed.artist : (rec.artist || 'Неизвестный исполнитель');
            const finalTitle  = parsed ? parsed.title  : (rec.title  || 'Неизвестный трек');

            let region = rec.region ?? -1;
            let regionChanged = false;
            if (region < 0 && typeof guessRegionFromArtist === 'function') {
                const auto = guessRegionFromArtist(finalArtist);
                if (auto >= 0) {
                    region = auto;
                    regionChanged = true;
                }
            }

            const track = {
                id:           rec.id,
                title:        finalTitle,
                artist:       finalArtist,
                url:          null,
                duration:     rec.duration || 0,
                fileName:     rec.fileName || '',
                region:       region,
                createdAt:    rec.createdAt || Date.now(),
                blob:         rec.blob,
                coverBlob:    rec.coverBlob || null,
                coverUrl:     null,
                playCount:    rec.playCount || 0,
                lastPlayedAt: rec.lastPlayedAt || null
            };
            this.playlist.push(track);

            const artistTitleChanged = parsed && (parsed.artist !== rec.artist || parsed.title !== rec.title);
            if (artistTitleChanged || regionChanged) {
                if (this.storage) {
                    this.storage.updateMetadata(track).catch(() => {});
                }
            }
        });

        this.currentIndex = 0;
        if (this.playlist.length > 0) {
            try {
                this.loadCurrentTrack();
            } catch (e) {
                console.warn('loadCurrentTrack failed on restore:', e);
            }
        }
        return this.playlist.length;
    }

        loadCurrentTrack() {
            const track = this.playlist[this.currentIndex];
            if (!track) return;
            this._isFadingOut = false;
            track._counted = false;

        if (this.normGain && this.audioCtx) {
            const now = this.audioCtx.currentTime;
            this.normGain.gain.cancelScheduledValues(now);
            this.normGain.gain.setValueAtTime(1, now);
            this._rmsSmoothed = 0;
        }

        if (track.blob && !track.url) {
            track.url = URL.createObjectURL(track.blob);
        }

        if (track.coverBlob && !track.coverUrl) {
            try {
                track.coverUrl = URL.createObjectURL(track.coverBlob);
            } catch (e) {}
        }

        this.audio.src = track.url;
        document.getElementById('trackTitle').textContent = track.title;
        document.getElementById('trackArtist').textContent = track.artist;
        document.getElementById('progressFill').style.width = '0%';
        document.getElementById('currentTime').textContent = '0:00';

        this._updatePlayerCover(track);

        if (typeof this.onTrackChange === 'function') {
            try { this.onTrackChange(track, this.currentIndex); }
            catch (e) { console.warn('onTrackChange error:', e); }
        }
    }
    

    ensureCoverUrl(track) {
        if (!track) return null;
        if (track.coverUrl) return track.coverUrl;
        if (track.coverBlob) {
            try {
                track.coverUrl = URL.createObjectURL(track.coverBlob);
            } catch (e) {
                return null;
            }
        }
        return track.coverUrl || null;
    }

    _updatePlayerCover(track) {
        const el = document.getElementById('playerCover');
        if (!el) return;
        if (track && track.coverUrl) {
            el.style.backgroundImage = `url("${track.coverUrl}")`;
            el.classList.add('has-image');
        } else {
            el.style.backgroundImage = '';
            el.classList.remove('has-image');
        }
    }

        play() {
        if (this.playlist.length === 0) return;
        if (!this.audio.src) this.loadCurrentTrack();
        this.initAudioContext();

        if (!this.fadeGain || !this.audioCtx) {
            this.audio.play().catch(err => console.warn('Play failed:', err));
            return;
        }

        const now = this.audioCtx.currentTime;
        const currentGain = this.fadeGain.gain.value;
        const shouldFadeIn = this._expectFadeIn || currentGain < 0.95;
        const fadeDur = this.crossfadeDuration > 0 ? this.crossfadeDuration : 0.3;

        this._expectFadeIn = false;

        this.audio.play().then(() => {
            if (shouldFadeIn) {
                this.fadeIn(fadeDur);
            } else {
                this.fadeGain.gain.cancelScheduledValues(now);
                this.fadeGain.gain.setValueAtTime(1, now);
            }
        }).catch(err => console.warn('Play failed:', err));
    }

    pause() {
        if (this.fadeGain && this.audioCtx) {
            const now = this.audioCtx.currentTime;
            const currentGain = this.fadeGain.gain.value;
            this.fadeGain.gain.cancelScheduledValues(now);
            this.fadeGain.gain.setValueAtTime(currentGain, now);
        }
        this._isFadingOut = false;
        this.audio.pause();
    }

    togglePlay() {
        if (this.playlist.length === 0) {
            document.getElementById('uploadBtnHeader')?.click();
            return;
        }
        if (this.isPlaying) this.pause();
        else this.play();
    }

    next(autoAdvance = false) {
        if (this.playlist.length === 0) return;

        if (autoAdvance && this.repeatMode === 'off' && !this.shuffle && this.currentIndex >= this.playlist.length - 1) {
            this.isPlaying = false;
            this.updatePlayButtons();
            return;
        }

        if (this.shuffle && this.playlist.length > 1) {
            let next;
            do { next = Math.floor(Math.random() * this.playlist.length); }
            while (next === this.currentIndex);
            this.currentIndex = next;
        } else {
            this.currentIndex = (this.currentIndex + 1) % this.playlist.length;
        }
        this.loadCurrentTrack();
        this.play();
    }

    prev() {
        if (this.playlist.length === 0) return;
        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
            return;
        }
        if (this.shuffle && this.playlist.length > 1) {
            let prev;
            do { prev = Math.floor(Math.random() * this.playlist.length); }
            while (prev === this.currentIndex);
            this.currentIndex = prev;
        } else {
            this.currentIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
        }
        this.loadCurrentTrack();
        this.play();
    }

    toggleShuffle() {
        this.shuffle = !this.shuffle;
        return this.shuffle;
    }

    cycleRepeat() {
        const modes = ['off', 'all', 'one'];
        const i = modes.indexOf(this.repeatMode);
        this.repeatMode = modes[(i + 1) % modes.length];
        return this.repeatMode;
    }

    seek(pct) {
        if (!this.audio.duration) return;
        pct = Math.max(0, Math.min(100, pct));
        this.audio.currentTime = (pct / 100) * this.audio.duration;
    }

    setVolume(val) {
        const v = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
        this.volume = v / 100;
        if (this.masterGain && this.audioCtx) {
            const now = this.audioCtx.currentTime;
            const target = this._muted ? 0 : this.volume;
            this.masterGain.gain.cancelScheduledValues(now);
            this.masterGain.gain.setTargetAtTime(target, now, 0.02);
        }
        if (v > 0 && this._muted) this._muted = false;
        if (v > 0) this._preMuteVolume = this.volume;

        this.updateVolumeUI();
    }

    toggleMute() {
        this._muted = !this._muted;
        if (!this._muted && this.volume === 0) {
            this.volume = this._preMuteVolume || 0.25;
        }
        if (this.masterGain && this.audioCtx) {
            const now = this.audioCtx.currentTime;
            const target = this._muted ? 0 : this.volume;
            this.masterGain.gain.cancelScheduledValues(now);
            this.masterGain.gain.setTargetAtTime(target, now, 0.02);
        }
        this.updateVolumeUI();
        return this._muted;
    }

    updateVolumeUI() {
        const slider = document.getElementById('volumeSlider');
        const btn = document.getElementById('volumeIconBtn');
        const muted = this._muted || this.volume === 0;

        if (slider && !slider.matches(':active')) {
            slider.value = Math.round(this.volume * 100);
        }
        if (btn) {
            btn.classList.toggle('muted', muted);
            const title = muted ? 'Включить звук' : 'Выключить звук';
            btn.title = title;
            btn.setAttribute('aria-label', title);
            btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
        }
    }

    formatTime(sec) {
        if (!isFinite(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    updatePlayButtons() {
        const playIcon = document.getElementById('mainPlayIcon');
        const pauseIcon = document.getElementById('mainPauseIcon');
        if (playIcon && pauseIcon) {
            playIcon.style.display = this.isPlaying ? 'none' : '';
            pauseIcon.style.display = this.isPlaying ? '' : 'none';
        }
        const sphereBtn = document.getElementById('playBtn');
        if (sphereBtn) sphereBtn.classList.toggle('playing', this.isPlaying);
    }
}
