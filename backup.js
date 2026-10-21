// ==================== BACKUP SYSTEM ====================
class BackupSystem {
    constructor(audioEngine, playlistManager) {
        this.audioEngine = audioEngine;
        this.playlistManager = playlistManager;
        this.VERSION = 1;
        this.init();
    }

    init() {
        // Кнопки в настройках
        document.getElementById('exportBackupBtn')?.addEventListener('click', () => this.export());
        document.getElementById('importBackupBtn')?.addEventListener('click', () => this.openImportPicker());
    }

    // ═══════════════════════════════════════════════════════════
    // ЭКСПОРТ
    // ═══════════════════════════════════════════════════════════
    async export() {
        try {
            showNotification('Собираю данные...');

            const backup = {
                meta: {
                    app: 'mbox',
                    version: this.VERSION,
                    exportedAt: new Date().toISOString(),
                    appVersion: '0.52' // можно брать из константы
                },
                profile: this._getJSON('user'),
                playlists: this._getJSON('playlists'),
                settings: this._getJSON('settings'),
                eqPresets: this._getJSON('eqCustomPresets'),
                colorPreset: localStorage.getItem('colorPreset'),
                ecoMode: localStorage.getItem('ecoMode'),
                animIntensity: localStorage.getItem('animIntensity'),
                bgSettings: this._getJSON('bgSettings'),
                bgActiveId: localStorage.getItem('bgActiveId'),
                tracks: await this._exportTrackMetadata()
            };

            const json = JSON.stringify(backup, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const filename = `mbox-backup-${this._dateStamp()}.json`;
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            const size = (blob.size / 1024).toFixed(1);
            showNotification(`✅ Бэкап сохранён (${size} КБ)`);
        } catch (e) {
            console.error('Export failed:', e);
            showNotification('❌ Не удалось создать бэкап', true);
        }
    }

    async _exportTrackMetadata() {
        // Только метаданные, без blob-ов
        if (window.trackStorage) {
            const records = await window.trackStorage.getAllTracks();
            return records.map(r => ({
                id: r.id,
                title: r.title,
                artist: r.artist,
                duration: r.duration || 0,
                fileName: r.fileName || '',
                region: r.region ?? -1,
                createdAt: r.createdAt || Date.now()
                // НЕ включаем: blob, coverBlob
            }));
        }
        // Fallback: из памяти
        return this.audioEngine.playlist.map(t => ({
            id: t.id,
            title: t.title,
            artist: t.artist,
            duration: t.duration || 0,
            fileName: t.fileName || '',
            region: t.region ?? -1,
            createdAt: t.createdAt || Date.now()
        }));
    }

    // ═══════════════════════════════════════════════════════════
    // ИМПОРТ
    // ═══════════════════════════════════════════════════════════
    openImportPicker() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this._readAndImport(file);
            input.value = '';
        });
        document.body.appendChild(input);
        input.click();
    }

    _readAndImport(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const backup = JSON.parse(e.target.result);
                this._validateAndApply(backup);
            } catch (err) {
                console.error('Import parse failed:', err);
                showNotification('❌ Файл повреждён или не является бэкапом', true);
            }
        };
        reader.onerror = () => showNotification('❌ Не удалось прочитать файл', true);
        reader.readAsText(file);
    }

    _validateAndApply(backup) {
        // Проверка формата
        if (!backup || typeof backup !== 'object') {
            showNotification('❌ Неверный формат файла', true);
            return;
        }
        if (!backup.meta || backup.meta.app !== 'mbox') {
            showNotification('❌ Это не бэкап mbox', true);
            return;
        }
        if (backup.meta.version > this.VERSION) {
            showNotification('⚠️ Бэкап из более новой версии. Обнови mbox.', true);
            return;
        }

        // Подтверждение
        const stats = this._describeBackup(backup);
        const msg = `Восстановить из бэкапа?\n\n` +
                    `📅 Дата: ${new Date(backup.meta.exportedAt).toLocaleString('ru')}\n` +
                    `👤 Профиль: ${backup.profile?.name || '—'}\n` +
                    `🎵 Треков: ${backup.tracks?.length || 0}\n` +
                    `📋 Плейлистов: ${backup.playlists?.length || 0}\n\n` +
                    `⚠️ Текущие данные будут перезаписаны!`;

        if (!confirm(msg)) return;

        this._applyBackup(backup);
    }

    _describeBackup(backup) {
        return {
            tracks: backup.tracks?.length || 0,
            playlists: backup.playlists?.length || 0,
            hasProfile: !!backup.profile,
            hasSettings: !!backup.settings
        };
    }

    async _applyBackup(backup) {
        try {
            // 1. Профиль
            if (backup.profile) {
                localStorage.setItem('user', JSON.stringify(backup.profile));
            }

            // 2. Плейлисты
            if (backup.playlists) {
                localStorage.setItem('playlists', JSON.stringify(backup.playlists));
                if (window.playlistManager) {
                    window.playlistManager.loadPlaylists();
                }
            }

            // 3. Настройки
            if (backup.settings) {
                localStorage.setItem('settings', JSON.stringify(backup.settings));
            }

            // 4. Пресеты эквалайзера
            if (backup.eqPresets) {
                localStorage.setItem('eqCustomPresets', JSON.stringify(backup.eqPresets));
            }

            // 5. Цвет, эко, анимации
            if (backup.colorPreset) localStorage.setItem('colorPreset', backup.colorPreset);
            if (backup.ecoMode != null) localStorage.setItem('ecoMode', backup.ecoMode);
            if (backup.animIntensity != null) localStorage.setItem('animIntensity', backup.animIntensity);

            // 6. Фон
            if (backup.bgSettings) {
                localStorage.setItem('bgSettings', JSON.stringify(backup.bgSettings));
            }
            if (backup.bgActiveId) {
                localStorage.setItem('bgActiveId', backup.bgActiveId);
            }

            // 7. Метаданные треков (только регионы и названия, blob-ы не трогаем)
            if (backup.tracks && backup.tracks.length > 0 && window.audioEngine) {
                await this._applyTrackMetadata(backup.tracks);
            }

            showNotification('✅ Бэкап восстановлен! Перезагрузи страницу.');
            setTimeout(() => {
                if (confirm('Перезагрузить сейчас?')) location.reload();
            }, 1500);

        } catch (e) {
            console.error('Apply backup failed:', e);
            showNotification('❌ Ошибка восстановления', true);
        }
    }

    async _applyTrackMetadata(backupTracks) {
        // Обновляем регионы и метаданные для существующих треков
        // Blob-ы НЕ восстанавливаем (их нет в JSON)
        const playlist = this.audioEngine.playlist;
        const backupById = new Map(backupTracks.map(t => [t.id, t]));

        for (const track of playlist) {
            const saved = backupById.get(track.id);
            if (saved) {
                track.region = saved.region ?? track.region;
                track.duration = saved.duration || track.duration;
                // Название/артист не перезаписываем — файл уже загружен
                if (window.trackStorage) {
                    await window.trackStorage.updateMetadata(track).catch(() => {});
                }
            }
        }

        // Обновляем UI
        if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
        if (window.trackQueue) window.trackQueue.render();
    }

    // ═══════════════════════════════════════════════════════════
    // УТИЛИТЫ
    // ═══════════════════════════════════════════════════════════
    _getJSON(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    _dateStamp() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
    }
}