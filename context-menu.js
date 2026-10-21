class ContextMenu {
    constructor(audioEngine, playlistManager) {
        this.audioEngine = audioEngine;
        this.playlistManager = playlistManager;
        this.menu = document.getElementById('contextMenu');
        this.submenu = document.getElementById('playlistSubmenu');
        this.currentTrackIndex = null;
        this.regionItem = null;
        this.regionSubmenu = null;
        this.init();
    }

    init() {
        document.addEventListener('click', (e) => { if (!this.menu.contains(e.target)) this.hide(); });
        document.addEventListener('scroll', () => this.hide(), true);
        window.addEventListener('resize', () => this.hide());
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(); });

        this.menu.querySelectorAll('.context-menu-item[data-action]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                if (action === 'addToPlaylist') return;
                this.handleAction(action); this.hide();
            });
        });

        this.createRegionItem();
        this.createSelectItem();
    }

    createRegionItem() {
        const divider = document.createElement('div');
        divider.className = 'context-menu-divider';

        const regionItem = document.createElement('div');
        regionItem.className = 'context-menu-item context-menu-submenu';
        regionItem.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            <span>Регион</span>
            <div class="submenu-list"></div>
        `;
        const submenu = regionItem.querySelector('.submenu-list');

        if (typeof REGION_NAMES !== 'undefined') {
            REGION_NAMES.forEach((name, idx) => {
                const it = document.createElement('div');
                it.className = 'context-menu-item';
                it.dataset.region = idx;
                it.innerHTML = `<span>${name}</span><span class="region-check" style="margin-left:auto;color:var(--y);display:none">✓</span>`;
                it.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setTrackRegion(idx);
                    this.hide();
                });
                submenu.appendChild(it);
            });
        }

        const noneIt = document.createElement('div');
        noneIt.className = 'context-menu-item';
        noneIt.dataset.region = '-1';
        noneIt.innerHTML = `<span>Не указан</span><span class="region-check" style="margin-left:auto;color:var(--y);display:none">✓</span>`;
        noneIt.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setTrackRegion(-1);
            this.hide();
        });
        submenu.appendChild(noneIt);

        this.menu.appendChild(divider);
        this.menu.appendChild(regionItem);
        this.regionItem = regionItem;
        this.regionSubmenu = submenu;
    }

    createSelectItem() {
        const divider = document.createElement('div');
        divider.className = 'context-menu-divider';

        const item = document.createElement('div');
        item.className = 'context-menu-item';
        item.dataset.action = 'select-mode';
        item.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8.29 13.29-3.29-3.29 1.41-1.42 1.88 1.88 4.88-4.88 1.42 1.41-6.3 6.3z"/></svg>
            <span>Выбрать несколько</span>
        `;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.currentTrackIndex === null) { this.hide(); return; }
            const track = this.audioEngine.playlist[this.currentTrackIndex];
            if (track && window.fileUploadSystem) {
                window.fileUploadSystem.startSelectionFrom(track.id);
            }
            this.hide();
        });

        this.menu.appendChild(divider);
        this.menu.appendChild(item);
    }

    show(x, y, trackIndex) {
        this.currentTrackIndex = trackIndex;
        this.updatePlaylistSubmenu();
        this.menu.style.left = x + 'px';
        this.menu.style.top = y + 'px';
        this.menu.classList.add('active');
        requestAnimationFrame(() => {
            const rect = this.menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) this.menu.style.left = (x - rect.width) + 'px';
            if (rect.bottom > window.innerHeight) this.menu.style.top = (y - rect.height) + 'px';
        });
    }

    hide() {
        this.menu.classList.remove('active');
        this.currentTrackIndex = null;
    }

    updatePlaylistSubmenu() {
        const playlists = this.playlistManager.getAllPlaylists();
        this.submenu.innerHTML = '';
        if (playlists.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'submenu-empty';
            empty.textContent = 'Нет плейлистов';
            this.submenu.appendChild(empty);
        } else {
            playlists.forEach(playlist => {
                const item = document.createElement('div');
                item.className = 'context-menu-item';
                item.innerHTML = `<svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg><span>${this.escapeHtml(playlist.name)}</span>`;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.addTrackToPlaylist(playlist.id);
                    this.hide();
                });
                this.submenu.appendChild(item);
            });
        }
        const divider = document.createElement('div');
        divider.className = 'context-menu-divider';
        this.submenu.appendChild(divider);

        const createItem = document.createElement('div');
        createItem.className = 'context-menu-item submenu-create';
        createItem.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg><span>Создать новый плейлист</span>`;
        createItem.addEventListener('click', (e) => {
            e.stopPropagation();
            this.createAndAddToNewPlaylist();
            this.hide();
        });
        this.submenu.appendChild(createItem);

        this.updateRegionChecks();
    }

    updateRegionChecks() {
        if (!this.regionSubmenu) return;
        const track = this.currentTrackIndex !== null
            ? this.audioEngine.playlist[this.currentTrackIndex]
            : null;
        const currentRegion = track ? (track.region ?? -1) : -1;

        this.regionSubmenu.querySelectorAll('.context-menu-item[data-region]').forEach(it => {
            const idx = parseInt(it.dataset.region, 10);
            const check = it.querySelector('.region-check');
            if (check) check.style.display = (idx === currentRegion) ? '' : 'none';
        });
    }

    setTrackRegion(regionIdx) {
        if (this.currentTrackIndex === null) return;
        const track = this.audioEngine.playlist[this.currentTrackIndex];
        if (!track) return;
        track.region = regionIdx;

        if (window.trackStorage) {
            window.trackStorage.updateMetadata(track).catch(() => {});
        }

        const label = regionIdx < 0
            ? 'Не указан'
            : (typeof REGION_NAMES !== 'undefined' ? REGION_NAMES[regionIdx] : regionIdx);
        showNotification(`Регион: ${label}`);

        if (window.playlistManager) {
            const pl = window.playlistManager.playlists.find(p =>
                p.tracks && p.tracks.some(t => t.id === track.id)
            );
            if (pl) {
                const t = pl.tracks.find(t => t.id === track.id);
                if (t) t.region = regionIdx;
                window.playlistManager.savePlaylists();
            }
        }

        if (window.globeView && document.getElementById('page-world')?.classList.contains('active')) {
            window.globeView.selectedRegion = regionIdx;
        }
    }

    handleAction(action) {
        if (this.currentTrackIndex === null) return;
        const track = this.audioEngine.playlist[this.currentTrackIndex];
        if (!track) return;
        if (action === 'play') {
            this.audioEngine.currentIndex = this.currentTrackIndex;
            this.audioEngine.loadCurrentTrack();
            this.audioEngine.play();
        } else if (action === 'delete') {
            if (confirm(`Удалить трек "${track.title}"?`)) {
                this.audioEngine.removeTrack(this.currentTrackIndex);
                if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
            }
        } else if (action === 'lyrics') {
            if (typeof window.openLyrics === 'function') {
                window.openLyrics(this.currentTrackIndex);
            }
        } else if (action === 'findCover') {
            if (typeof window.findCoverForTrack === 'function') {
                window.findCoverForTrack(track);
            }
        }
    }

    addTrackToPlaylist(playlistId) {
        if (this.currentTrackIndex === null) return;
        const track = this.audioEngine.playlist[this.currentTrackIndex];
        const playlist = this.playlistManager.getPlaylist(playlistId);
        if (playlist && track) {
            const added = this.playlistManager.addTrackToPlaylist(playlistId, track);
            const n = document.createElement('div');
            n.textContent = added ? `✅ Добавлено в "${playlist.name}"` : `Трек уже в "${playlist.name}"`;
            n.style.cssText = `position: fixed; top: 100px; right: 20px; padding: 16px 24px; background: ${added ? 'rgba(76,175,80,0.9)' : 'rgba(255,59,48,0.9)'}; border-radius: 12px; color: white; font-weight: 600; z-index: 10001; animation: slideIn 0.3s ease forwards;`;
            document.body.appendChild(n);
            setTimeout(() => n.remove(), 2500);
            const countEl = document.getElementById('playlistCount');
            if (countEl) countEl.textContent = `${this.playlistManager.getPlaylistCount()} плейлистов`;
        }
    }

    async createAndAddToNewPlaylist() {
        if (this.currentTrackIndex === null) return;
        const track = this.audioEngine.playlist[this.currentTrackIndex];
        if (!track) return;

        const name = await window.askPrompt('Введите название нового плейлиста:', 'Мой плейлист');
        if (!name) return;

        const playlist = this.playlistManager.createPlaylist(name.trim());
        this.playlistManager.addTrackToPlaylist(playlist.id, track);

        const countEl = document.getElementById('playlistCount');
        if (countEl) {
            const n = this.playlistManager.getPlaylistCount();
            countEl.textContent = `${n} ${n === 1 ? 'плейлист' : (n >= 2 && n <= 4 ? 'плейлиста' : 'плейлистов')}`;
        }
        if (document.getElementById('playlistsModal').classList.contains('active')) {
            buildPlaylistsModal();
        }

        const n = document.createElement('div');
        n.textContent = `✅ Создан плейлист "${playlist.name}" и добавлен трек`;
        n.style.cssText = `position: fixed; top: 100px; right: 20px; padding: 16px 24px; background: rgba(76,175,80,0.9); border-radius: 12px; color: white; font-weight: 600; z-index: 10001; animation: slideIn 0.3s ease forwards; box-shadow: 0 8px 32px rgba(0,0,0,0.3);`;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 2500);
    }

    escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}