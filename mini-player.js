(() => {
    class MiniPlayer {
        constructor(audioEngine) {
            this.audioEngine = audioEngine;

            this.el        = document.getElementById('miniPlayer');
            this.cover     = document.getElementById('miniCover');
            this.title     = document.getElementById('miniTitle');
            this.artist    = document.getElementById('miniArtist');
            this.progress  = document.getElementById('miniProgressFill');
            this.playBtn   = document.getElementById('miniPlayBtn');
            this.prevBtn   = document.getElementById('miniPrevBtn');
            this.nextBtn   = document.getElementById('miniNextBtn');
            this.shuffleBtn    = document.getElementById('miniShuffleBtn');
            this.repeatBtn     = document.getElementById('miniRepeatBtn');
            this.volumeBtn     = document.getElementById('miniVolumeBtn');
            this.volumeSlider  = document.getElementById('miniVolumeSlider');
            this.currentTimeEl = document.getElementById('miniCurrentTime');
            this.totalTimeEl   = document.getElementById('miniTotalTime');
            this.progressWrap  = document.getElementById('miniProgressWrapper');
            this.playIcon  = this.el.querySelector('.mini-play-icon');
            this.pauseIcon = this.el.querySelector('.mini-pause-icon');

            if (!this.el) return;

            this._snapshot = null;
            this._updateTimer = null;

            this._bindControls();
            this._bindEngine();
            this._updateFromTrack();

            this._tick = this._tick.bind(this);
            requestAnimationFrame(this._tick);
        }

        _bindControls() {
            this.playBtn.addEventListener('click', () => this.audioEngine.togglePlay());
            this.prevBtn.addEventListener('click', () => this.audioEngine.prev());
            this.nextBtn.addEventListener('click', () => this.audioEngine.next());

            this.shuffleBtn?.addEventListener('click', () => {
                const on = this.audioEngine.toggleShuffle();
                this.shuffleBtn.classList.toggle('active', on);
            });

            this.repeatBtn?.addEventListener('click', () => {
                this.audioEngine.cycleRepeat();
                const mode = this.audioEngine.repeatMode;
                this.repeatBtn.classList.toggle('active', mode !== 'off');
                this.repeatBtn.title = `Повтор: ${mode}`;
            });

            this.volumeBtn?.addEventListener('click', () => {
                this.audioEngine.toggleMute();
                this._syncVolumeUI();
            });

            this.volumeSlider?.addEventListener('input', (e) => {
                this.audioEngine.setVolume(e.target.value);
                this._syncVolumeUI();
            });

            this.progressWrap?.addEventListener('click', (e) => {
                const rect = this.progressWrap.getBoundingClientRect();
                const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
                this.audioEngine.seek(pct);
            });

            const slider = document.getElementById('volumeSlider');
            slider?.addEventListener('input', () => {
                if (this.volumeSlider) this.volumeSlider.value = slider.value;
                this._syncVolumeUI();
            });
            document.getElementById('volumeIconBtn')?.addEventListener('click', () => {
                this._syncVolumeUI();
            });
        }

        _syncVolumeUI() {
            const vol = Math.round((this.audioEngine.volume || 0) * 100);
            const muted = this.audioEngine._muted;
            if (this.volumeSlider) this.volumeSlider.value = vol;
            this.volumeBtn?.classList.toggle('muted', muted || vol === 0);
        }

        _bindEngine() {
            const eng = this.audioEngine;

            const prevPlay  = eng.onPlay;
            const prevPause = eng.onPause;
            const prevTrack = eng.onTrackChange;

            eng.onPlay = () => {
                if (typeof prevPlay === 'function') prevPlay();
                this._syncPlayState(true);
            };
            eng.onPause = () => {
                if (typeof prevPause === 'function') prevPause();
                this._syncPlayState(false);
            };
            eng.onTrackChange = (track) => {
                if (typeof prevTrack === 'function') prevTrack(track);
                this._updateFromTrack();
            };
        }

        _syncPlayState(isPlaying) {
            if (!this.playIcon) return;
            this.playIcon.style.display = isPlaying ? 'none' : '';
            this.pauseIcon.style.display = isPlaying ? '' : 'none';
        }

        _updateFromTrack() {
            const eng = this.audioEngine;
            const track = eng.playlist[eng.currentIndex];

            if (!track) {
                this.el.classList.add('no-track');
                this.title.textContent = 'Нет трека';
                this.artist.textContent = '—';
                this.cover.classList.remove('has-image');
                this.cover.style.backgroundImage = '';
                return;
            }

            this.el.classList.remove('no-track');
            this.title.textContent = track.title || '—';
            this.artist.textContent = track.artist || '—';

            const url = eng.ensureCoverUrl ? eng.ensureCoverUrl(track) : track.coverUrl;
            if (url) {
                this.cover.style.backgroundImage = `url("${url}")`;
                this.cover.classList.add('has-image');
            } else {
                this.cover.style.backgroundImage = '';
                this.cover.classList.remove('has-image');
            }
        }

        _tick() {
            requestAnimationFrame(this._tick);

            if (!this.el.classList.contains('visible')) return;
            if (!this.audioEngine) return;

            const a = this.audioEngine.audio;
            const dur = a.duration || 0;
            const cur = a.currentTime || 0;

            if (this.progress) {
                const pct = dur > 0 ? (cur / dur) * 100 : 0;
                this.progress.style.width = pct.toFixed(2) + '%';
            }
            if (this.currentTimeEl) {
                this.currentTimeEl.textContent = this.audioEngine.formatTime(cur);
            }
            if (this.totalTimeEl && dur > 0) {
                this.totalTimeEl.textContent = this.audioEngine.formatTime(dur);
            }
        }

        show() {
            this.el.classList.add('visible');
            this.el.setAttribute('aria-hidden', 'false');
            this._updateFromTrack();
            this._syncPlayState(this.audioEngine.isPlaying);
        }

        hide() {
            this.el.classList.remove('visible');
            this.el.setAttribute('aria-hidden', 'true');
        }

        forceHide() {
            this._preModalState = this.el.classList.contains('visible');
            this.el.classList.remove('visible');
            this.el.setAttribute('aria-hidden', 'true');
        }

        restoreAfterModal() {
            if (this._preModalState) {
                this.el.classList.add('visible');
                this.el.setAttribute('aria-hidden', 'false');
            }
            this._preModalState = null;
        }

        prepareTransition(fromPage, toPage) {
            if (fromPage === 'home' && toPage !== 'home') {
                const pc = document.querySelector('.player-column');
                if (pc) pc.classList.add('is-shrinking');
            }
        }

        applyTransition(targetPage) {
            const pc = document.querySelector('.player-column');

            if (targetPage === 'builder') {
                this.hide();
                if (pc) pc.classList.remove('is-shrinking');
                return;
            }

            if (targetPage !== 'home') {
                this.show();
            } else {
                this.hide();
                if (pc) pc.classList.remove('is-shrinking');
            }
        }
    }
    window.MiniPlayer = MiniPlayer;
})();