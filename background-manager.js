class BackgroundManager {
    constructor(audioEngine) {
        this.audioEngine = audioEngine;
        this.db = null;
        this.activeId = null;
        this.settings = { dim: 40, parallax: false };
        this.fileInput = null;
        this.parallaxBound = false;

        this.el = document.getElementById('bgImage');
        this.imgEl = document.getElementById('bgImageEl');
        this.gallery = document.getElementById('bgGallery');
        this.controls = document.getElementById('bgControls');

        this.init();
    }

    async init() {
        try {
            this.db = await this.openDB();
        } catch (e) {
            console.warn('IndexedDB недоступен:', e);
            this.db = null;
        }

        const saved = JSON.parse(localStorage.getItem('bgSettings') || '{}');
        this.settings.dim = saved.dim ?? 40;
        this.settings.parallax = saved.parallax ?? false;
        this.settings.accentFromBg = saved.accentFromBg ?? false;
        this.activeId = localStorage.getItem('bgActiveId') || null;

        document.getElementById('bgDimSlider').value = this.settings.dim;
        document.getElementById('bgDimValue').textContent = this.settings.dim + '%';
        document.getElementById('bgParallaxToggle').checked = this.settings.parallax;
        
        const bgAccentEl = document.getElementById('bgAccentToggle');
        if (bgAccentEl) bgAccentEl.checked = this.settings.accentFromBg;

        this.applyDim();
        this.bindControls();
        this.bindParallax();

        await this.render();
        await this.applyActive();
    }

    openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('mbox_bg', 1);
            req.onerror = () => reject(req.error);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('backgrounds')) {
                    db.createObjectStore('backgrounds', { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    dbAdd(record) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('backgrounds', 'readwrite');
            const store = tx.objectStore('backgrounds');
            const req = store.put(record);
            req.onsuccess = () => resolve(record);
            req.onerror = () => reject(req.error);
        });
    }

    dbGetAll() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('backgrounds', 'readonly');
            const store = tx.objectStore('backgrounds');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    dbGet(id) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('backgrounds', 'readonly');
            const store = tx.objectStore('backgrounds');
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    dbDelete(id) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('backgrounds', 'readwrite');
            const store = tx.objectStore('backgrounds');
            const req = store.delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async handleFile(file) {
        if (!file.type.startsWith('image/')) {
            showNotification('Только изображения', true);
            return;
        }
        const isGifInput = file.type === 'image/gif';
        const maxSize = isGifInput ? 25 * 1024 * 1024 : 15 * 1024 * 1024;
        if (file.size > maxSize) {
            showNotification(`Файл больше ${isGifInput ? 25 : 15} МБ`, true);
            return;
        }
        if (!this.db) {
            showNotification('Хранилище недоступно', true);
            return;
        }

        try {
            const isGif = file.type === 'image/gif';

            showNotification(isGif ? 'Загрузка GIF...' : 'Обработка изображения...');

            const thumb = isGif ? null : await this.createThumbnail(file, 200);
            const name = file.name.replace(/\.[^/.]+$/, '').slice(0, 40) || 'Фон';
            const id = 'bg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

            await this.dbAdd({
                id,
                name,
                blob: file,
                thumbnail: thumb,
                isGif,
                createdAt: Date.now()
            });

            await this.render();
            await this.setActive(id);
            showNotification(`Фон «${name}» добавлен`);
        } catch (e) {
            console.warn(e);
            showNotification('Не удалось загрузить', true);
        }
    }

    createThumbnail(file, size = 200) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                const ratio = Math.max(size / img.width, size / img.height);
                const w = img.width * ratio;
                const h = img.height * ratio;
                ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
                URL.revokeObjectURL(url);
                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else reject(new Error('toBlob failed'));
                }, 'image/jpeg', 0.75);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Image load failed'));
            };
            img.src = url;
        });
    }

    async applyActive() {
        if (!this.activeId || !this.db) {
            document.body.classList.remove('bg-is-gif');
            this.hide();
            return;
        }
        try {
            const record = await this.dbGet(this.activeId);
            if (!record) {
                this.activeId = null;
                localStorage.removeItem('bgActiveId');
                document.body.classList.remove('bg-is-gif');
                this.hide();
                return;
            }
            const url = URL.createObjectURL(record.blob);
            if (this._currentUrl) URL.revokeObjectURL(this._currentUrl);
            this._currentUrl = url;

            this.imgEl.src = url;
            this.imgEl.onload = () => {
                this.el.classList.add('active');
            };

            document.body.classList.toggle('bg-is-gif', !!record.isGif);

            if (this.settings.accentFromBg) {
                this._applyBgAccent(url);
            } else {
                this._restoreUserAccent();
            }
        } catch (e) {
            console.warn(e);
            document.body.classList.remove('bg-is-gif');
            this.hide();
        }
    }

    async _applyBgAccent(url) {
        if (typeof extractCoverPalette !== 'function') return;
        try {
            const palette = await extractCoverPalette(url);
            if (!palette) return;
            const root = document.documentElement;
            root.style.setProperty('--y', palette.hex);
            root.style.setProperty('--y-deep', palette.hexDeep);
            root.style.setProperty('--y-glow', `rgba(${palette.hexRgb.join(',')}, 0.15)`);
            root.style.setProperty('--y-rgb', palette.hexRgb.join(','));
            if (typeof currentAccentRGB !== 'undefined') {
                currentAccentRGB = palette.hexRgb;
            }
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        } catch (e) {
            console.warn('bg accent failed:', e);
        }
    }

    _restoreUserAccent() {
        if (typeof applyColorPreset !== 'function') return;
        const key = localStorage.getItem('colorPreset') || 'crimson';
        applyColorPreset(key);
    }

    hide() {
        this.el.classList.remove('active');
    }

    async setActive(id) {
        this.activeId = id;
        if (id) localStorage.setItem('bgActiveId', id);
        else localStorage.removeItem('bgActiveId');

        if (id) {
            await this.applyActive();
            this.controls.classList.remove('hidden');
        } else {
            document.body.classList.remove('bg-is-gif');
            this._restoreUserAccent();
            this.hide();
            this.controls.classList.add('hidden');
        }
        this.updateActiveTile();
    }

    applyDim() {
        document.documentElement.style.setProperty('--bg-dim', (this.settings.dim / 100).toFixed(2));
    }

    saveSettings() {
        localStorage.setItem('bgSettings', JSON.stringify(this.settings));
    }

    bindControls() {
        document.getElementById('bgDimSlider')?.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            document.getElementById('bgDimValue').textContent = v + '%';
            this.settings.dim = v;
            this.applyDim();
            this.saveSettings();
        });

        document.getElementById('bgParallaxToggle')?.addEventListener('change', (e) => {
            this.settings.parallax = e.target.checked;
            this.saveSettings();
            if (!this.settings.parallax) {
                this.imgEl.style.transform = 'scale(1.08)';
            }
        });

        document.getElementById('bgAccentToggle')?.addEventListener('change', (e) => {
            this.settings.accentFromBg = e.target.checked;
            this.saveSettings();
            if (this.settings.accentFromBg && this._currentUrl) {
                this._applyBgAccent(this._currentUrl);
            } else {
                this._restoreUserAccent();
            }
        });
    }

    bindParallax() {
        if (this.parallaxBound) return;
        this.parallaxBound = true;
        let rafId = null;
        let mouseX = 0, mouseY = 0;

        document.addEventListener('mousemove', (e) => {
            if (!this.settings.parallax) return;
            if (document.body.classList.contains('eco-mode')) return;
            mouseX = e.clientX / window.innerWidth - 0.5;
            mouseY = e.clientY / window.innerHeight - 0.5;

            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                const x = mouseX * -24;
                const y = mouseY * -24;
                this.imgEl.style.transform = `scale(1.08) translate(${x}px, ${y}px)`;
            });
        });
    }

    async render() {
        if (!this.gallery) return;
        this.gallery.innerHTML = '';
        const defaultTile = document.createElement('div');
        defaultTile.className = 'bg-tile bg-tile-default';
        defaultTile.dataset.id = '';
        defaultTile.title = 'По умолчанию';
        defaultTile.textContent = '◼';
        defaultTile.addEventListener('click', () => this.setActive(null));
        this.gallery.appendChild(defaultTile);

        if (this.db) {
            try {
                const records = await this.dbGetAll();
                records.sort((a, b) => b.createdAt - a.createdAt);

                this._tileUrls = this._tileUrls || [];
                this._tileUrls.forEach(u => URL.revokeObjectURL(u));
                this._tileUrls = [];

                for (const rec of records) {
                    const tile = document.createElement('div');
                    tile.className = 'bg-tile';
                    tile.dataset.id = rec.id;
                    tile.title = rec.name;

                    const img = document.createElement('img');
                    if (rec.isGif) {
                        const gifUrl = URL.createObjectURL(rec.blob);
                        this._tileUrls.push(gifUrl);
                        img.src = gifUrl;
                    } else if (rec.thumbnail) {
                        const thumbUrl = URL.createObjectURL(rec.thumbnail);
                        img.src = thumbUrl;
                        img.onload = () => URL.revokeObjectURL(thumbUrl);
                    }
                    tile.appendChild(img);

                    const del = document.createElement('button');
                    del.className = 'bg-tile-del';
                    del.textContent = '×';
                    del.title = 'Удалить';
                    del.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.removeBackground(rec.id, rec.name);
                    });
                    tile.appendChild(del);

                    tile.addEventListener('click', () => this.setActive(rec.id));
                    this.gallery.appendChild(tile);
                }
            } catch (e) {
                console.warn(e);
            }
        }
        const addTile = document.createElement('div');
        addTile.className = 'bg-tile bg-tile-add';
        addTile.title = 'Загрузить фон';
        addTile.textContent = '+';
        addTile.addEventListener('click', () => this.openFilePicker());
        addTile.addEventListener('dragover', (e) => {
            e.preventDefault();
            addTile.classList.add('dragover');
        });
        addTile.addEventListener('dragleave', () => addTile.classList.remove('dragover'));
        addTile.addEventListener('drop', (e) => {
            e.preventDefault();
            addTile.classList.remove('dragover');
            const files = Array.from(e.dataTransfer.files);
            files.filter(f => f.type.startsWith('image/')).forEach(f => this.handleFile(f));
        });
        this.gallery.appendChild(addTile);

        this.updateActiveTile();
    }

    updateActiveTile() {
        this.gallery?.querySelectorAll('.bg-tile').forEach(t => {
            const id = t.dataset.id || '';
            t.classList.toggle('active', id === (this.activeId || ''));
        });
    }

    async removeBackground(id, name) {
        if (!confirm(`Удалить фон «${name}»?`)) return;
        try {
            await this.dbDelete(id);
            if (this.activeId === id) {
                await this.setActive(null);
            }
            await this.render();
            showNotification(`Фон «${name}» удалён`);
        } catch (e) {
            console.warn(e);
            showNotification('Не удалось удалить', true);
        }
    }

    openFilePicker() {
        if (!this.fileInput) {
            this.fileInput = document.createElement('input');
            this.fileInput.type = 'file';
            this.fileInput.accept = 'image/*';
            this.fileInput.multiple = true;
            this.fileInput.style.display = 'none';
            this.fileInput.addEventListener('change', (e) => {
                const files = Array.from(e.target.files);
                files.forEach(f => this.handleFile(f));
                this.fileInput.value = '';
            });
            document.body.appendChild(this.fileInput);
        }
        this.fileInput.click();
    }
}