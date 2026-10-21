class FileUploadSystem {
    constructor(audioEngine) {
        this.audioEngine = audioEngine;
        this.dropZone = null;
        this.fileInput = null;
        this._query = '';
        this._sort = 'date-desc';
        this._searchDebounce = null;
        this._selectionMode = false;
        this._selected = new Set();
        this._lastSelectedId = null;
        this._selectionBar = null;
        this._playlistPickMenu = null;

        this.init();
    }

        init() {
        const headerBtn = document.getElementById('uploadBtnHeader');
        if (headerBtn) headerBtn.addEventListener('click', () => this.showDropZone());

        const uploadTile = document.getElementById('uploadTile');
        if (uploadTile) uploadTile.addEventListener('click', () => this.showDropZone());

        this.createDropZone();
        this.setupEventListeners();
        this.setupLibraryToolbar();
        this.createSelectionBar();
        this.setupSelectionKeyboard();
    }

    setupLibraryToolbar() {
        const input = document.getElementById('librarySearch');
        const clear = document.getElementById('librarySearchClear');
        const sort  = document.getElementById('librarySort');
        const savedSort = localStorage.getItem('librarySort');
        if (savedSort && sort) {
            this._sort = savedSort;
            sort.value = savedSort;
        }

        input?.addEventListener('input', (e) => {
            this._query = e.target.value.trim();
            clear?.classList.toggle('visible', this._query.length > 0);
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => this.updateTrackListUI(), 120);
        });

        clear?.addEventListener('click', () => {
            if (input) input.value = '';
            this._query = '';
            clear.classList.remove('visible');
            input?.focus();
            this.updateTrackListUI();
        });

        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._query) {
                e.stopPropagation();
                clear?.click();
            }
        });

        sort?.addEventListener('change', (e) => {
            this._sort = e.target.value;
            localStorage.setItem('librarySort', this._sort);
            this.updateTrackListUI();
        });
    }

    getFilteredPlaylist() {
        const q = this._query.toLowerCase();
        const list = this.audioEngine.playlist;

        const indexed = list.map((track, originalIndex) => ({ track, originalIndex }));

        const filtered = q
            ? indexed.filter(({ track }) =>
                track.title.toLowerCase().includes(q) ||
                track.artist.toLowerCase().includes(q))
            : indexed;

        const cmp = {
            'date-desc':      (a, b) => (b.track.createdAt || 0) - (a.track.createdAt || 0),
            'date-asc':       (a, b) => (a.track.createdAt || 0) - (b.track.createdAt || 0),
            'title-asc':      (a, b) => a.track.title.localeCompare(b.track.title, 'ru'),
            'title-desc':     (a, b) => b.track.title.localeCompare(a.track.title, 'ru'),
            'artist-asc':     (a, b) => a.track.artist.localeCompare(b.track.artist, 'ru'),
            'artist-desc':    (a, b) => b.track.artist.localeCompare(a.track.artist, 'ru'),
            'duration-desc':  (a, b) => (b.track.duration || 0) - (a.track.duration || 0),
            'duration-asc':   (a, b) => (a.track.duration || 0) - (b.track.duration || 0)
        }[this._sort] || ((a, b) => 0);

        return filtered.slice().sort(cmp);
    }

    _highlight(text) {
        const safe = escapeHtml(text);
        if (!this._query) return safe;

        const q = this._query.toLowerCase();
        const lower = text.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx < 0) return safe;
        const before = escapeHtml(text.slice(0, idx));
        const match  = escapeHtml(text.slice(idx, idx + q.length));
        const after  = escapeHtml(text.slice(idx + q.length));

        return `${before}<mark class="lib-mark">${match}</mark>${after}`;
    }

    createSelectionBar() {
        const bar = document.createElement('div');
        bar.className = 'selection-bar';
        bar.innerHTML = `
            <div class="selection-bar-count">Выбрано: 0</div>
            <button class="selection-bar-btn" data-action="playlist">
                <svg viewBox="0 0 24 24"><path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z"/></svg>
                <span>В плейлист</span>
            </button>
            <button class="selection-bar-btn danger" data-action="delete">
                <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                <span>Удалить</span>
            </button>
            <button class="selection-bar-btn ghost" data-action="cancel">
                <span>Отмена</span>
            </button>
        `;
        document.body.appendChild(bar);
        this._selectionBar = bar;

        bar.querySelector('[data-action="cancel"]').addEventListener('click', () => this.exitSelectionMode());
        bar.querySelector('[data-action="delete"]').addEventListener('click', () => this.bulkDelete());
        bar.querySelector('[data-action="playlist"]').addEventListener('click', (e) => this.openBulkPlaylistMenu(e.currentTarget));
    }

    setupSelectionKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (!this._selectionMode) return;
            const inField = e.target.closest('input, textarea, [contenteditable]');
            if (inField) return;

            if (e.key === 'Escape') {
                e.preventDefault();
                this.exitSelectionMode();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                this.bulkDelete();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                const page = document.getElementById('page-mymusic');
                if (page && page.classList.contains('active')) {
                    e.preventDefault();
                    this.selectAllVisible();
                }
            }
        });
    }

    enterSelectionMode(initialId) {
        if (this._selectionMode) return;
        this._selectionMode = true;
        this._selected.clear();

        if (initialId !== undefined && initialId !== null) {
            this._selected.add(initialId);
            this._lastSelectedId = initialId;
        }

        this.updateTrackListUI();
        this.updateSelectionBar();
    }

    startSelectionFrom(trackId) {
        this.enterSelectionMode(trackId);
    }

    exitSelectionMode() {
        if (!this._selectionMode) return;
        this._selectionMode = false;
        this._selected.clear();
        this._lastSelectedId = null;
        this.closeBulkPlaylistMenu();
        this.updateTrackListUI();
        this.updateSelectionBar();
    }

    toggleSelect(trackId, shiftKey) {
        const rows = this.getFilteredPlaylist();
        const ids = rows.map(r => r.track.id);

        if (shiftKey && this._lastSelectedId !== null) {
            const fromIdx = ids.indexOf(this._lastSelectedId);
            const toIdx = ids.indexOf(trackId);
            if (fromIdx >= 0 && toIdx >= 0) {
                const [a, b] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
                for (let i = a; i <= b; i++) this._selected.add(ids[i]);
                this._lastSelectedId = trackId;
                this.updateTrackListUI();
                this.updateSelectionBar();
                return;
            }
        }

        if (this._selected.has(trackId)) this._selected.delete(trackId);
        else this._selected.add(trackId);
        this._lastSelectedId = trackId;

        this.updateTrackListUI();
        this.updateSelectionBar();
    }

    selectAllVisible() {
        const rows = this.getFilteredPlaylist();
        rows.forEach(r => this._selected.add(r.track.id));
        this.updateTrackListUI();
        this.updateSelectionBar();
    }

    updateSelectionBar() {
        const bar = this._selectionBar;
        if (!bar) return;

        if (!this._selectionMode) {
            bar.classList.remove('visible');
            return;
        }
        bar.classList.add('visible');
        const count = this._selected.size;
        const word = count === 1 ? 'трек' : (count >= 2 && count <= 4 ? 'трека' : 'треков');
        bar.querySelector('.selection-bar-count').textContent = `Выбрано: ${count} ${word}`;
        bar.querySelector('[data-action="delete"]').disabled = count === 0;
        bar.querySelector('[data-action="playlist"]').disabled = count === 0;
    }

    bulkDelete() {
        const ids = Array.from(this._selected);
        if (ids.length === 0) return;

        const word = ids.length === 1 ? 'трек' : (ids.length >= 2 && ids.length <= 4 ? 'трека' : 'треков');
        if (!confirm(`Удалить ${ids.length} ${word}? Действие нельзя отменить.`)) return;

        const removed = this.audioEngine.removeTracks(ids);
        this.exitSelectionMode();
        this.updateTrackListUI();
        if (window.trackQueue) window.trackQueue.render();
        showNotification(`Удалено: ${removed} ${removed === 1 ? 'трек' : (removed >= 2 && removed <= 4 ? 'трека' : 'треков')}`);
    }

    openBulkPlaylistMenu(anchorBtn) {
        this.closeBulkPlaylistMenu();
        if (!window.playlistManager) return;

        const playlists = window.playlistManager.getAllPlaylists();
        const menu = document.createElement('div');
        menu.className = 'bulk-playlist-menu';

        if (playlists.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'context-menu-empty';
            empty.textContent = 'Плейлистов пока нет';
            menu.appendChild(empty);
        } else {
            playlists.forEach(pl => {
                const item = document.createElement('div');
                item.className = 'context-menu-item';
                item.innerHTML = `<svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg><span>${escapeHtml(pl.name)}</span>`;
                item.addEventListener('click', () => this.bulkAddToPlaylist(pl.id));
                menu.appendChild(item);
            });
        }

        const divider = document.createElement('div');
        divider.className = 'context-menu-divider';
        menu.appendChild(divider);

        const createItem = document.createElement('div');
        createItem.className = 'context-menu-item new';
        createItem.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg><span>Создать новый плейлист</span>`;
        createItem.addEventListener('click', () => this.bulkAddToNewPlaylist());
        menu.appendChild(createItem);

        document.body.appendChild(menu);
        this._playlistPickMenu = menu;

        const rect = anchorBtn.getBoundingClientRect();
        requestAnimationFrame(() => {
            const mRect = menu.getBoundingClientRect();
            const left = Math.max(12, Math.min(
                window.innerWidth - mRect.width - 12,
                rect.left + rect.width / 2 - mRect.width / 2
            ));
            const top = Math.max(12, rect.top - mRect.height - 8);
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
        });

        setTimeout(() => {
            const close = (e) => {
                if (menu.contains(e.target) || e.target === anchorBtn) return;
                this.closeBulkPlaylistMenu();
                document.removeEventListener('mousedown', close, true);
            };
            document.addEventListener('mousedown', close, true);
            this._playlistPickMenuCloser = close;
        }, 0);
    }

    closeBulkPlaylistMenu() {
        if (this._playlistPickMenu) {
            this._playlistPickMenu.remove();
            this._playlistPickMenu = null;
        }
        if (this._playlistPickMenuCloser) {
            document.removeEventListener('mousedown', this._playlistPickMenuCloser, true);
            this._playlistPickMenuCloser = null;
        }
    }

    bulkAddToPlaylist(playlistId) {
        const ids = Array.from(this._selected);
        if (ids.length === 0) return;

        const playlist = window.playlistManager.getPlaylist(playlistId);
        if (!playlist) return;

        let added = 0;
        ids.forEach(id => {
            const track = this.audioEngine.playlist.find(t => t.id === id);
            if (!track) return;
            if (window.playlistManager.addTrackToPlaylist(playlistId, track)) added++;
        });

        this.closeBulkPlaylistMenu();
        this.exitSelectionMode();
        showNotification(added > 0
            ? `Добавлено в «${playlist.name}»: ${added}`
            : `Все выбранные треки уже в «${playlist.name}»`);
    }

    async bulkAddToNewPlaylist() {
        const ids = Array.from(this._selected);
        if (ids.length === 0) return;

        const name = await window.askPrompt('Название нового плейлиста:', 'Мой плейлист');
        if (!name) return;

        const playlist = window.playlistManager.createPlaylist(name.trim());
        let added = 0;
        ids.forEach(id => {
            const track = this.audioEngine.playlist.find(t => t.id === id);
            if (!track) return;
            if (window.playlistManager.addTrackToPlaylist(playlist.id, track)) added++;
        });

        this.closeBulkPlaylistMenu();
        this.exitSelectionMode();
        if (document.getElementById('playlistsModal').classList.contains('active')) {
            buildPlaylistsModal();
        }
        showNotification(`Создан «${playlist.name}»: +${added}`);
    }

    createDropZone() {
        this.dropZone = document.createElement('div');
        this.dropZone.className = 'drop-zone';
        this.dropZone.innerHTML = `
            <div class="drop-zone-content">
                <div class="drop-zone-icon">📁</div>
                <div class="drop-zone-title">Перетащите аудиофайлы сюда</div>
                <div class="drop-zone-subtitle">или нажмите для выбора файлов</div>
            </div>
        `;
        this.dropZone.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.85); backdrop-filter: blur(20px);
            z-index: 9999; display: none; align-items: center; justify-content: center;
            cursor: pointer; transition: opacity 0.3s ease;
        `;
        document.body.appendChild(this.dropZone);
    }

    setupEventListeners() {
        this.dropZone.addEventListener('click', () => this.openFilePicker());
        this.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZone.querySelector('.drop-zone-content').style.borderColor = 'rgba(255,255,255,0.8)';
        });
        this.dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            this.dropZone.querySelector('.drop-zone-content').style.borderColor = 'rgba(255,255,255,0.3)';
        });
        this.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.handleFiles(Array.from(e.dataTransfer.files));
            this.hideDropZone();
        });
        document.addEventListener('dragover', (e) => e.preventDefault());
        document.addEventListener('drop', (e) => {
            e.preventDefault();
            if (e.target !== this.dropZone && !this.dropZone.contains(e.target)) {
                const files = Array.from(e.dataTransfer.files);
                const audio = files.filter(f => f.type.startsWith('audio/'));
                const images = files.filter(f => f.type.startsWith('image/'));
                if (audio.length) this.handleFiles(audio);
                if (images.length && window.backgroundManager) {
                    images.forEach(f => window.backgroundManager.handleFile(f));
                }
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hideDropZone();
        });
    }

    showDropZone() { this.dropZone.style.display = 'flex'; }
    hideDropZone() { this.dropZone.style.display = 'none'; }

    openFilePicker() {
        if (!this.fileInput) {
            this.fileInput = document.createElement('input');
            this.fileInput.type = 'file';
            this.fileInput.accept = 'audio/*';
            this.fileInput.multiple = true;
            this.fileInput.style.display = 'none';
            this.fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) this.handleFiles(Array.from(e.target.files));
                this.hideDropZone();
                this.fileInput.value = '';
            });
            document.body.appendChild(this.fileInput);
        }
        this.fileInput.click();
    }

    handleFiles(files) {
        const tracks = this.audioEngine.addTracks(files);
        if (tracks.length > 0) {
            this.showNotification(`✅ Загружено треков: ${tracks.length}`);
            this.updateTrackListUI();
        } else {
            this.showNotification('⚠️ Выберите аудиофайлы', true);
        }
    }

    updateTrackListUI() {
        const recentGrid = document.getElementById('recentGrid');
        if (recentGrid) {
            recentGrid.innerHTML = '';
            const recent = [...this.audioEngine.playlist]
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .slice(0, 8);

            recent.forEach((track, rowIdx) => {
                const actualIndex = this.audioEngine.playlist.indexOf(track);
                const card = document.createElement('div');
                card.className = 'recent-card glass';
                card.style.setProperty('--i', rowIdx);
                const coverUrl = this.audioEngine.ensureCoverUrl(track);
                const coverStyle = track.coverUrl
                    ? `style="background-image:url('${track.coverUrl}')"`
                    : '';
                const coverClass = track.coverUrl ? 'recent-cover has-image' : 'recent-cover';

                card.innerHTML = `
                    <div class="${coverClass}" ${coverStyle}><span>🎵</span></div>
                    <div class="recent-info">
                        <div class="recent-title">${escapeHtml(track.title)}</div>
                        <div class="recent-artist">${escapeHtml(track.artist)}</div>
                    </div>
                `;
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    if (window.contextMenu) window.contextMenu.show(e.clientX, e.clientY, actualIndex);
                });
                card.addEventListener('click', () => {
                    this.audioEngine.currentIndex = actualIndex;
                    this.audioEngine.loadCurrentTrack();
                    this.audioEngine.play();
                    document.querySelector('[data-page="home"]').click();
                });
                recentGrid.appendChild(card);
            });
        }

        const likedCount = document.getElementById('likedCount');
        if (likedCount) {
            updateCounter(likedCount, this.audioEngine.playlist.length, 'треков');
        }
        const uploaded = document.getElementById('uploadedTracksList');
        const emptyEl = document.getElementById('libraryEmpty');
        const countEl = document.getElementById('libraryCount');

        if (uploaded) {
            uploaded.innerHTML = '';
            const rows = this.getFilteredPlaylist();
            const total = this.audioEngine.playlist.length;
            if (countEl) {
                if (this._query) {
                    countEl.innerHTML = `Найдено: <b>${rows.length}</b> из ${total}`;
                } else if (total > 0) {
                    countEl.innerHTML = `Всего треков: <b>${total}</b>`;
                } else {
                    countEl.textContent = '';
                }
            }

            if (emptyEl) emptyEl.hidden = !(this._query && rows.length === 0);

            rows.forEach(({ track, originalIndex }, rowIdx) => {
                const item = document.createElement('div');
                item.className = 'track-list-item glass';
                item.style.setProperty('--i', rowIdx);
                if (this._selectionMode) item.classList.add('selection-mode');
                if (this._selected.has(track.id)) item.classList.add('selected');
                const coverUrl = this.audioEngine.ensureCoverUrl(track);
                const coverStyle = track.coverUrl
                    ? `style="background-image:url('${track.coverUrl}');background-size:cover;background-position:center"`
                    : '';
                const coverClass = track.coverUrl ? 'track-list-item-cover has-image' : 'track-list-item-cover';

                const titleHtml  = this._highlight(track.title);
                const artistHtml = this._highlight(track.artist);
                const dur = track.duration ? this.audioEngine.formatTime(track.duration) : '';

                item.innerHTML = `
                    <div class="select-checkbox"></div>
                    <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
                    <div class="track-list-item-main">
                        <div class="track-list-item-title">${titleHtml}</div>
                        <div class="track-list-item-artist">${artistHtml}</div>
                    </div>
                    <div class="track-list-item-right">
                        ${dur ? `<span class="track-list-item-dur">${dur}</span>` : ''}
                        <span class="track-list-item-play">▶</span>
                    </div>
                `;

                item.addEventListener('click', (e) => {
                    if (this._selectionMode) {
                        this.toggleSelect(track.id, e.shiftKey);
                        return;
                    }
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        this.enterSelectionMode(track.id);
                        return;
                    }
                    this.audioEngine.currentIndex = originalIndex;
                    this.audioEngine.loadCurrentTrack();
                    this.audioEngine.play();
                });

                item.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    if (this._selectionMode) {
                        this.toggleSelect(track.id, e.shiftKey);
                        return;
                    }
                    window.contextMenu?.show(e.clientX, e.clientY, originalIndex);
                });

                uploaded.appendChild(item);
            });
        }   

        const playlistCount = document.getElementById('playlistCount');
        if (playlistCount && window.playlistManager) {
            const n = window.playlistManager.getPlaylistCount();
            const word = n === 1 ? 'плейлист' : (n >= 2 && n <= 4 ? 'плейлиста' : 'плейлистов');
            updateCounter(playlistCount, n, word);
        }

        if (window.trackQueue) window.trackQueue.render();
        if (typeof updateEmptyState === 'function') updateEmptyState();
}

    showNotification(message, isError = false) {
        const n = document.createElement('div');
        n.textContent = message;
        n.style.cssText = `position: fixed; top: 100px; right: 20px; padding: 16px 24px; background: ${isError ? 'rgba(255,59,48,0.9)' : 'rgba(76,175,80,0.9)'}; border-radius: 12px; color: white; font-weight: 600; z-index: 10000; box-shadow: 0 8px 32px rgba(0,0,0,0.3); animation: slideIn 0.3s ease forwards;`;
        document.body.appendChild(n);
        setTimeout(() => {
            n.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => n.remove(), 300);
        }, 3000);
    }
}