class EqualizerUI {
    constructor(audioEngine) {
        this.audioEngine = audioEngine;
        this.board = document.getElementById('eqBoard');
        this.savedList = document.getElementById('eqSavedList');
        this.select = document.getElementById('eqPreset');
        this.customPresets = {};
        this.currentGains = [...EQ_PRESETS.flat];
        this.sliders = [];
        this.loadCustomPresets();
        this.build();
        this.bindControls();
        this.renderSaved();
    }

    build() {
        if (!this.board) return;
        this.board.innerHTML = '';
        this.sliders = [];

        EQ_BANDS.forEach((band, i) => {
            const wrap = document.createElement('div');
            wrap.className = 'eq-band';
            wrap.innerHTML = `
                <div class="eq-band-value">0</div>
                <div class="eq-band-slider-wrap">
                    <input type="range" class="eq-slider"
                           min="-12" max="12" step="1" value="0"
                           data-index="${i}"
                           aria-label="${band.freq} Hz">
                </div>
                <div class="eq-band-label">${band.label}</div>
            `;

            const slider = wrap.querySelector('.eq-slider');
            const valueEl = wrap.querySelector('.eq-band-value');

            slider.addEventListener('input', () => {
                const val = parseInt(slider.value, 10);
                valueEl.textContent = val > 0 ? '+' + val : String(val);
                wrap.classList.add('show-value');
                this.currentGains[i] = val;
                this.audioEngine.setEQGains(this.currentGains);
                this.markAsCustom();
            });

            slider.addEventListener('change', () => {
                this.saveState();
                setTimeout(() => wrap.classList.remove('show-value'), 700);
            });

            slider.addEventListener('mouseenter', () => {
                const val = parseInt(slider.value, 10);
                valueEl.textContent = val > 0 ? '+' + val : String(val);
                wrap.classList.add('show-value');
            });
            slider.addEventListener('mouseleave', () => {
                if (document.activeElement !== slider) wrap.classList.remove('show-value');
            });
            slider.addEventListener('focus', () => {
                const val = parseInt(slider.value, 10);
                valueEl.textContent = val > 0 ? '+' + val : String(val);
                wrap.classList.add('show-value');
            });
            slider.addEventListener('blur', () => wrap.classList.remove('show-value'));

            this.board.appendChild(wrap);
            this.sliders.push({ slider, valueEl, wrap });
        });
    }

    bindControls() {
        this.select?.addEventListener('change', (e) => {
            const v = e.target.value;
            if (v.startsWith('custom:')) {
                const name = v.slice(7);
                const gains = this.customPresets[name];
                if (gains) {
                    this.setGains(gains);
                    showNotification(`Эквалайзер: ${name}`);
                }
            } else if (EQ_PRESETS[v]) {
                this.setGains(v);
                this.audioEngine.setEQPreset(v);
                showNotification(`Эквалайзер: ${EQ_PRESET_LABELS[v] || v}`);
            }
            this.saveState();
        });

        document.getElementById('eqSaveBtn')?.addEventListener('click', () => this.savePreset());
        document.getElementById('eqResetBtn')?.addEventListener('click', () => {
            this.setGains('flat');
            this.audioEngine.setEQPreset('flat');
            this.select.value = 'flat';
            this.saveState();
            showNotification('Эквалайзер сброшен');
        });
    }

    setGains(gains, opts = {}) {
        const vals = Array.isArray(gains) ? gains : (EQ_PRESETS[gains] || EQ_PRESETS.flat);
        this.currentGains = [...vals];
        this.sliders.forEach((s, i) => {
            const v = Math.max(-12, Math.min(12, this.currentGains[i] || 0));
            s.slider.value = v;
            s.valueEl.textContent = v > 0 ? '+' + v : String(v);
        });
        this.audioEngine.setEQGains(this.currentGains);
        if (!opts.silent) this.saveState();
    }

    markAsCustom() {
        if (!this.select) return;
        if (this.select.value !== 'custom' && !this.select.value.startsWith('custom:')) {
            let customOpt = this.select.querySelector('option[value="custom"]');
            if (!customOpt) {
                customOpt = document.createElement('option');
                customOpt.value = 'custom';
                customOpt.textContent = 'Свой';
                this.select.appendChild(customOpt);
            }
            this.select.value = 'custom';
        }
    }

    async savePreset() {
        const name = await window.askPrompt('Название пресета:', 'Мой пресет');
        if (!name) return;
        const clean = name.trim().slice(0, 30);
        if (EQ_PRESETS[clean] || this.customPresets[clean]) {
            if (!confirm(`Пресет «${clean}» уже существует. Перезаписать?`)) return;
        }
        this.customPresets[clean] = [...this.currentGains];
        this.saveCustomPresets();
        this.renderSaved();
        this.rebuildSelect();
        this.select.value = 'custom:' + clean;
        this.saveState();
        showNotification(`Пресет «${clean}» сохранён`);
    }

    rebuildSelect() {
        if (!this.select) return;
        this.select.querySelectorAll('option[data-custom]').forEach(o => o.remove());
        this.select.querySelector('option[value="custom"]')?.remove();
        Object.keys(this.customPresets).forEach(name => {
            const opt = document.createElement('option');
            opt.value = 'custom:' + name;
            opt.textContent = name;
            opt.dataset.custom = '1';
            this.select.appendChild(opt);
        });
    }

    renderSaved() {
        if (!this.savedList) return;
        this.savedList.innerHTML = '';
        Object.keys(this.customPresets).forEach(name => {
            const chip = document.createElement('div');
            chip.className = 'eq-saved-chip';
            chip.innerHTML = `<span>${this.escapeHtml(name)}</span><span class="del" title="Удалить">×</span>`;
            chip.addEventListener('click', (e) => {
                if (e.target.classList.contains('del')) {
                    if (confirm(`Удалить пресет «${name}»?`)) {
                        delete this.customPresets[name];
                        this.saveCustomPresets();
                        this.renderSaved();
                        this.rebuildSelect();
                        if (this.select.value === 'custom:' + name) {
                            this.select.value = 'flat';
                        }
                        showNotification(`Пресет «${name}» удалён`);
                    }
                    return;
                }
                this.select.value = 'custom:' + name;
                this.setGains(this.customPresets[name]);
                showNotification(`Эквалайзер: ${name}`);
            });
            this.savedList.appendChild(chip);
        });
    }

    loadCustomPresets() {
        try {
            this.customPresets = JSON.parse(localStorage.getItem('eqCustomPresets') || '{}');
        } catch {
            this.customPresets = {};
        }
    }
    saveCustomPresets() {
        localStorage.setItem('eqCustomPresets', JSON.stringify(this.customPresets));
    }

    saveState() {
        saveSettings();
    }

    restore(settings) {
        this.rebuildSelect();
        if (settings.eqPreset) {
            if (settings.eqPreset.startsWith('custom:')) {
                const name = settings.eqPreset.slice(7);
                if (this.customPresets[name]) {
                    this.select.value = settings.eqPreset;
                    this.setGains(this.customPresets[name], { silent: true });
                    this.audioEngine.setEQGains(this.currentGains);
                    return;
                }
            } else if (EQ_PRESETS[settings.eqPreset]) {
                this.select.value = settings.eqPreset;
                this.setGains(settings.eqPreset, { silent: true });
                this.audioEngine.setEQPreset(settings.eqPreset);
                return;
            }
        }

        if (Array.isArray(settings.eqCustomGains) && settings.eqCustomGains.length === 10) {
            this.setGains(settings.eqCustomGains, { silent: true });
        } else {
            this.setGains('flat', { silent: true });
        }
    }

    escapeHtml(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
}