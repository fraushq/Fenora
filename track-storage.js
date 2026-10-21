class TrackStorage {
    constructor() {
        this.db = null;
        this.ready = false;
        this._readyPromise = this._init();
    }

    async _init() {
        try {
            this.db = await this._openDB();
            this.ready = true;
        } catch (e) {
            console.warn('TrackStorage: IndexedDB недоступен', e);
            this.db = null;
        }
        return this.db;
    }

    waitReady() {
        return this._readyPromise;
    }

    _openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('mbox_tracks', 1);
            req.onerror = () => reject(req.error);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('tracks')) {
                    const store = db.createObjectStore('tracks', { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    _store(mode) {
        const tx = this.db.transaction('tracks', mode);
        return tx.objectStore('tracks');
    }
    async saveTrack(track) {
        if (!this.ready) await this.waitReady();
        if (!this.db) return false;
    
        return new Promise((resolve) => {
            try {
                const store = this._store('readwrite');
                const record = {
                    id:           track.id,
                    title:        track.title,
                    artist:       track.artist,
                    region:       track.region ?? -1,
                    duration:     track.duration || 0,
                    fileName:     track.fileName || '',
                    createdAt:    track.createdAt || Date.now(),
                    blob:         track.blob,
                    coverBlob:    track.coverBlob || null,
                    playCount:    track.playCount || 0,
                    lastPlayedAt: track.lastPlayedAt || null
                };
                const req = store.put(record);
                req.onsuccess = () => resolve(true);
                req.onerror = () => resolve(false);
            } catch (e) {
                console.warn('saveTrack error:', e);
                resolve(false);
            }
        });
    }
    async updateMetadata(track) {
        if (!this.ready) await this.waitReady();
        if (!this.db) return false;
        return new Promise((resolve) => {
            try {
                const store = this._store('readwrite');
                const getReq = store.get(track.id);
                getReq.onsuccess = () => {
                    const rec = getReq.result;
                    if (!rec) { resolve(false); return; }
                    rec.region       = track.region       ?? rec.region;
                    rec.title        = track.title        || rec.title;
                    rec.artist       = track.artist       || rec.artist;
                    rec.duration     = track.duration     || rec.duration;
                    rec.playCount    = track.playCount    ?? rec.playCount    ?? 0;
                    rec.lastPlayedAt = track.lastPlayedAt ?? rec.lastPlayedAt ?? null;
                    if (track.coverBlob !== undefined) rec.coverBlob = track.coverBlob;
                    const putReq = store.put(rec);
                    putReq.onsuccess = () => resolve(true);
                    putReq.onerror = () => resolve(false);
                };
                getReq.onerror = () => resolve(false);
            } catch (e) {
                console.warn('updateMetadata error:', e);
                resolve(false);
            }
        });
    }
    async deleteTrack(track) {
        if (!this.ready) await this.waitReady();
        if (!this.db) return false;
        return new Promise((resolve) => {
            try {
                const store = this._store('readwrite');
                const req = store.delete(track);
                req.onsuccess = () => resolve(true);
                req.onerror = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }
    async getAllTracks(track) {
        if (!this.ready) await this.waitReady();
        if (!this.db) return false;
        return new Promise((resolve) => {
            try {
                const store = this._store('readonly');
                const req = store.getAll();
                req.onsuccess = () => {
                    const arr = req.result || [];
                    arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
                    resolve(arr);
                };
                req.onerror = () => resolve([]);
            } catch (e) {
                resolve([]);
            }
        });
    }
    async clearAll() {
        if (!this.ready) await this.waitReady();
        if (!this.db) return false;
        return new Promise((resolve) => {
            try {
                const store = this._store('readwrite');
                const req = store.clear();
                req.onsuccess = () => resolve(true);
                req.onerror = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }
    async countTracks() {
        if (!this.ready) await this.waitReady();
        if (!this.db) return 0;
        return new Promise((resolve) => {
            try {
                const store = this._store('readonly');
                const req = store.count();
                req.onsuccess = () => resolve(req.result || 0);
                req.onerror = () => resolve(0);
            } catch (e) {
                resolve(0);
            }
        });
    }
    async estimateSize() {
        if (!navigator.storage || !navigator.storage.estimate) return null;
        try {
            const est = await navigator.storage.estimate();
            return {
                usage: est.usage || 0,
                quota: est.quota || 0
            };
        } catch (e) {
            return null;
        }
    }
}