// music-services.js
(() => {
    function proxyCover(url, size = 200) {
        if (!url) return null;
        return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=${size}&h=${size}&fit=cover&output=webp&q=85`;
    }
    window.proxyCover = proxyCover;

    class MusicServices {
        constructor(audioEngine) {
            this.audioEngine = audioEngine;
            this.api   = window.electronAPI?.music?.soundcloud;
            this.ymApi = window.electronAPI?.music?.yandex;
            this._renderUI();
            this._bind();
            this._checkStatus();
            this._refreshYandexStatus();

            window.importYandexTrack = (t) => this._importYandexTrack(t);
        }

        _renderUI() {
            const host = document.getElementById('musicServicesSection');
            if (!host) return;
            host.innerHTML = `
                <!-- ═══ SoundCloud ═══ -->
                <div class="setting-item">
                    <div>
                        <div class="setting-label">SoundCloud</div>
                        <div class="setting-description" id="scStatus">Проверка подключения…</div>
                    </div>
                </div>

                <div class="setting-item" id="scSearchRow" hidden>
                    <div style="width:100%">
                        <label class="edit-profile-label" for="scSearchInput">Поиск в SoundCloud</label>
                        <input type="text" class="form-input" id="scSearchInput"
                               placeholder="Артист или название трека..." autocomplete="off">
                        <div id="scResults" class="music-results"></div>
                    </div>
                </div>

                <hr style="border:none;border-top:1px solid var(--ink-line);margin:20px 0;">

                <!-- ═══ Yandex Music ═══ -->
                <div class="setting-item">
                    <div>
                        <div class="setting-label">Яндекс.Музыка</div>
                        <div class="setting-description" id="ymStatus">Проверка…</div>
                    </div>
                    <div style="display:flex;gap:8px">
                        <button class="artist-btn primary" id="ymConnectBtn">Войти через Яндекс</button>
                        <button class="artist-btn" id="ymDisconnectBtn" hidden>Отключить</button>
                    </div>
                </div>

                <div class="setting-item" id="ymSearchRow" hidden>
                    <div style="width:100%">
                        <label class="edit-profile-label" for="ymSearchInput">Поиск в Яндекс.Музыке</label>
                        <input type="text" class="form-input" id="ymSearchInput"
                               placeholder="Артист или название трека..." autocomplete="off">
                        <div id="ymResults" class="music-results"></div>
                    </div>
                </div>
            `;
        }

        _bind() {
            const scInput = document.getElementById('scSearchInput');
            let scTimer = null;
            scInput?.addEventListener('input', () => {
                clearTimeout(scTimer);
                scTimer = setTimeout(() => this._doSearch(scInput.value), 400);
            });

            document.getElementById('ymConnectBtn')?.addEventListener('click', () => {
                this._startYandexAuth();
            });

            document.getElementById('ymDisconnectBtn')?.addEventListener('click', async () => {
                if (!confirm('Отключить Яндекс.Музыку?')) return;
                await this.ymApi.disconnect();
                showNotification('Яндекс.Музыка отключена');
                this._refreshYandexStatus();
            });

            this.ymApi?.onDeviceCode?.((data) => this._showDeviceCodeModal(data));
            this.ymApi?.onAuthDone?.((data) => {
                this._closeDeviceCodeModal();
                if (data.ok) {
                    showNotification('✓ Яндекс.Музыка подключена');
                    this._refreshYandexStatus();
                } else {
                    showNotification('Ошибка авторизации: ' + data.error, true);
                }
            });

            const ymInput = document.getElementById('ymSearchInput');
            let ymTimer = null;
            ymInput?.addEventListener('input', () => {
                clearTimeout(ymTimer);
                ymTimer = setTimeout(() => this._doYandexSearch(ymInput.value), 400);
            });
        }

        _checkStatus() {
            const statusEl  = document.getElementById('scStatus');
            const searchRow = document.getElementById('scSearchRow');
            if (!statusEl || !searchRow) return;
            statusEl.textContent = '✓ Готово — начни вводить запрос';
            searchRow.hidden = false;
        }

        async _doSearch(q) {
            const box = document.getElementById('scResults');
            if (!box) return;
            q = (q || '').trim();
            if (!q) { box.innerHTML = ''; return; }

            box.innerHTML = `<div class="sr-status">Поиск…</div>`;

            try {
                const results = await this.api.search(q, { limit: 25 });
                if (!results.length) {
                    box.innerHTML = `<div class="sr-status">Ничего не найдено</div>`;
                    return;
                }
                box.innerHTML = '';

                results.forEach(t => {
                    const cover = proxyCover(t.cover);
                    const dur = t.duration ? this.audioEngine.formatTime(t.duration) : '';

                    const el = document.createElement('div');
                    el.className = 'sr-item';
                    el.innerHTML = `
                        <div class="sr-cover ${cover ? 'has-image' : ''}"
                             ${cover ? `style="background-image:url('${cover}')"` : ''}>
                            <span>♪</span>
                        </div>
                        <div class="sr-info">
                            <div class="sr-title">${escapeHtml(t.title)}</div>
                            <div class="sr-artist">${escapeHtml(t.artist)}${t.album ? ' · ' + escapeHtml(t.album) : ''}</div>
                        </div>
                        <div class="sr-meta">
                            ${dur ? `<span class="sr-dur">${dur}</span>` : ''}
                        </div>
                        <button class="artist-btn primary" data-act="import">Импорт</button>
                    `;

                    el.querySelector('[data-act="import"]').addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._importTrack(t, e.currentTarget);
                    });
                    box.appendChild(el);
                });

            } catch (e) {
                box.innerHTML = `<div class="sr-status">Ошибка поиска: ${escapeHtml(e.message)}</div>`;
                const st = document.getElementById('scStatus');
                if (st) st.textContent = '✗ Поиск временно недоступен';
            }
        }

        async _importTrack(t, btn) {
            if (btn) { btn.disabled = true; btn.textContent = '…'; }
            try {
                showNotification(`Скачиваю «${t.title}»…`);
                const res = await this.api.download(t.id);

                if (!res || !res.ok) {
                    showNotification('Не удалось скачать: ' + (res?.error || 'неизвестная ошибка'), true);
                    return;
                }

                const bytes = Uint8Array.from(atob(res.data), c => c.charCodeAt(0));
                const blob  = new Blob([bytes], { type: res.contentType || 'audio/mpeg' });
                const fileName = `${t.artist} - ${t.title}.mp3`.replace(/[<>:"/\\|?*]/g, '_');
                const file  = new File([blob], fileName, { type: 'audio/mpeg' });

                const added = this.audioEngine.addTracks([file]);
                if (added.length > 0) {
                    const track = added[0];
                    track.title  = t.title;
                    track.artist = t.artist;
                    track.source = 'soundcloud';
                    track.sourceId = t.id;

                    if (t.cover) {
                        try {
                            const cov = await window.electronAPI.fetchExternal(proxyCover(t.cover, 600), true);
                            if (cov?.isBase64) {
                                const cb = Uint8Array.from(atob(cov.data), c => c.charCodeAt(0));
                                track.coverBlob = new Blob([cb], { type: cov.contentType || 'image/jpeg' });
                                track.coverUrl  = URL.createObjectURL(track.coverBlob);
                            }
                        } catch (e) {}
                    }

                    if (window.trackStorage) {
                        window.trackStorage.saveTrack(track).catch(() => {});
                    }
                    if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
                    if (window.trackQueue) window.trackQueue.render();
                    if (typeof updateLibraryCounters === 'function') updateLibraryCounters();

                    showNotification(`✓ Импортировано: ${t.title}`);
                }
            } catch (e) {
                console.error('Import failed:', e);
                showNotification('Ошибка импорта: ' + e.message, true);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Импорт'; }
            }
        }

        async _refreshYandexStatus() {
            const desc       = document.getElementById('ymStatus');
            const connectBtn = document.getElementById('ymConnectBtn');
            const disconnBtn = document.getElementById('ymDisconnectBtn');
            const searchRow  = document.getElementById('ymSearchRow');
            if (!desc || !connectBtn || !disconnBtn || !searchRow) return;
            if (!this.ymApi) {
                desc.textContent = '✗ Модуль не загружен';
                connectBtn.hidden = true;
                return;
            }

            try {
                const st = await this.ymApi.status();
                if (!st.installed) {
                    desc.textContent = `✗ Ошибка: ${st.error || 'yamd2 не установлен'}`;
                    desc.style.color = '#ff3b30';
                    desc.style.fontSize = '11px';
                    desc.style.wordBreak = 'break-word';
                    
                    connectBtn.hidden = true;
                    disconnBtn.hidden = true;
                    searchRow.hidden = true;
                    return;
                }
                if (st.connected) {
                    desc.textContent = `✓ Подключено${st.uid ? ' (uid: ' + st.uid + ')' : ''}`;
                    connectBtn.hidden = true;
                    disconnBtn.hidden = false;
                    searchRow.hidden = false;
                } else {
                    desc.textContent = 'Не подключено';
                    connectBtn.hidden = false;
                    disconnBtn.hidden = true;
                    searchRow.hidden = true;
                }
            } catch (e) {
                desc.textContent = '✗ Ошибка проверки';
            }
        }

        async _startYandexAuth() {
            const btn = document.getElementById('ymConnectBtn');
            if (btn) { btn.disabled = true; btn.textContent = 'Ожидание…'; }
            try {
                const res = await this.ymApi.deviceAuth();
                if (!res.ok) showNotification('Ошибка: ' + res.error, true);
            } catch (e) {
                showNotification('Ошибка авторизации: ' + e.message, true);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Войти через Яндекс'; }
            }
        }

        _showDeviceCodeModal(data) {
            document.getElementById('ymDeviceModal')?.remove();

            const modal = document.createElement('div');
            modal.id = 'ymDeviceModal';
            modal.className = 'ask-modal-overlay visible';
            modal.innerHTML = `
                <div class="ask-modal" style="max-width:480px;text-align:center;">
                    <div class="ask-modal-title" style="text-align:left;">Вход в Яндекс.Музыку</div>
                    <p style="color:var(--text-secondary);font-size:13px;line-height:1.55;margin-bottom:18px;">
                        Откройте <b>ya.ru/device</b> в браузере и введите код ниже.
                        Мы ждём подтверждения…
                    </p>
                    <div style="
                        font-family:'JetBrains Mono', monospace;
                        font-size:28px; font-weight:700;
                        letter-spacing:0.12em; color:var(--y);
                        padding:16px; background:var(--ink);
                        border:1px solid var(--ink-line);
                        border-radius:10px; margin-bottom:16px;
                        user-select:all; cursor:pointer;
                    " id="ymDeviceCodeText">${escapeHtml(data.user_code || '—')}</div>

                    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:12px;">
                        <button class="artist-btn primary" id="ymOpenDeviceBtn">Открыть ya.ru/device</button>
                        <button class="artist-btn" id="ymCopyDeviceBtn">Скопировать</button>
                    </div>

                    <div style="display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);">
                        <span class="lyrics-spinner" style="width:14px;height:14px;border-width:2px;margin:0;"></span>
                        Ожидание подтверждения…
                    </div>

                    <div class="ask-modal-actions" style="justify-content:center;margin-top:18px;">
                        <button class="artist-btn" id="ymCancelAuthBtn" type="button">Отмена</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const codeText = modal.querySelector('#ymDeviceCodeText');
            const url = data.verification_url || 'https://ya.ru/device';

            try { navigator.clipboard.writeText(data.user_code || ''); } catch (e) {}

            modal.querySelector('#ymOpenDeviceBtn')?.addEventListener('click', () => {
                if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
                else window.open(url, '_blank');
            });

            modal.querySelector('#ymCopyDeviceBtn')?.addEventListener('click', () => {
                try {
                    navigator.clipboard.writeText(data.user_code || '');
                    showNotification('Код скопирован');
                } catch (e) {}
            });

            modal.querySelector('#ymCancelAuthBtn')?.addEventListener('click', () => {
                this._closeDeviceCodeModal();
                showNotification('Авторизация отменена. Может потребоваться перезапуск окна.', true);
            });

            codeText?.addEventListener('click', () => {
                const range = document.createRange();
                range.selectNodeContents(codeText);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            });
        }

        _closeDeviceCodeModal() {
            document.getElementById('ymDeviceModal')?.remove();
        }

        async _doYandexSearch(q) {
            const box = document.getElementById('ymResults');
            if (!box) return;
            q = (q || '').trim();
            if (!q) { box.innerHTML = ''; return; }

            box.innerHTML = `<div class="sr-status">Поиск…</div>`;
            try {
                const results = await this.ymApi.search(q, { limit: 20 });
                if (!results.length) {
                    box.innerHTML = `<div class="sr-status">Ничего не найдено</div>`;
                    return;
                }
                box.innerHTML = '';
                results.forEach(t => {
                    const cover = proxyCover(t.cover, 120);
                    const coverStyle = cover ? `style="background-image:url('${cover}')"` : '';
                    const coverClass = cover ? 'sr-cover has-image' : 'sr-cover';
                    const dur = t.duration ? this.audioEngine.formatTime(t.duration) : '';

                    const el = document.createElement('div');
                    el.className = 'sr-item sr-item-ya';
                    el.innerHTML = `
                        <div class="${coverClass}" ${coverStyle}><span>♪</span></div>
                        <div class="sr-info">
                            <div class="sr-title">${escapeHtml(t.title)}</div>
                            <div class="sr-artist">${escapeHtml(t.artist)}${t.album ? ' · ' + escapeHtml(t.album) : ''}</div>
                        </div>
                        <div class="sr-meta">
                            ${dur ? `<span class="sr-dur">${dur}</span>` : ''}
                            <span class="sr-play sr-play-import">Импорт</span>
                        </div>
                    `;
                    el.addEventListener('click', () => {
                        this._importYandexTrack(t, el.querySelector('.sr-play-import'));
                    });
                    box.appendChild(el);
                });
            } catch (e) {
                box.innerHTML = `<div class="sr-status">Ошибка поиска: ${escapeHtml(e.message)}</div>`;
            }
        }

        async _importYandexTrack(t, label) {
            const orig = label?.textContent;
            if (label) label.textContent = '…';
            try {
                showNotification(`Скачиваю «${t.title}»…`);
                const res = await this.ymApi.download(t.id);

                if (!res || !res.ok) {
                    showNotification('Не удалось скачать: ' + (res?.error || 'ошибка'), true);
                    return;
                }

                const bytes = Uint8Array.from(atob(res.data), c => c.charCodeAt(0));
                const blob  = new Blob([bytes], { type: res.contentType || 'audio/mpeg' });

                const ext = (res.contentType || '').includes('flac') ? 'flac'
                          : (res.contentType || '').includes('mp4')  ? 'm4a'
                          : 'mp3';
                const safeName = `${t.artist} - ${t.title}`.replace(/[<>:"/\\|?*]/g, '_');
                const file = new File([blob], `${safeName}.${ext}`, { type: res.contentType });

                const added = this.audioEngine.addTracks([file]);
                if (added.length > 0) {
                    const track = added[0];
                    track.title  = t.title;
                    track.artist = t.artist;
                    track.source = 'yandex';
                    track.sourceId = t.id;

                    if (t.cover) {
                        try {
                            const cov = await window.electronAPI.fetchExternal(proxyCover(t.cover, 600), true);
                            if (cov?.isBase64) {
                                const cb = Uint8Array.from(atob(cov.data), c => c.charCodeAt(0));
                                track.coverBlob = new Blob([cb], { type: cov.contentType || 'image/jpeg' });
                                track.coverUrl  = URL.createObjectURL(track.coverBlob);
                            }
                        } catch (e) {}
                    }

                    if (window.trackStorage) {
                        window.trackStorage.saveTrack(track).catch(() => {});
                    }
                    if (window.fileUploadSystem) window.fileUploadSystem.updateTrackListUI();
                    if (window.trackQueue) window.trackQueue.render();
                    if (typeof updateLibraryCounters === 'function') updateLibraryCounters();

                    showNotification(`✓ Импортировано: ${t.title}`);
                }
            } catch (e) {
                console.error('Yandex import failed:', e);
                showNotification('Ошибка импорта: ' + e.message, true);
            } finally {
                if (label && orig) label.textContent = orig;
            }
        }
    }

    window.MusicServices = MusicServices;
})();