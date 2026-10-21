const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,
    platform: process.platform,
    version: process.versions.electron,

    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (cb) => ipcRenderer.on('window:maximized', (_, v) => cb(v)),

    tray: {
        onAction: (cb) => ipcRenderer.on('tray:action', (_, a) => cb(a)),
        update: (data) => ipcRenderer.send('tray:update', data),
        hideToTray: () => ipcRenderer.send('tray:hide-to-tray'),
        getClosePreference: () => ipcRenderer.invoke('tray:get-close-preference'),
        setClosePreference: (data) => ipcRenderer.send('tray:set-close-preference', data),
    },

    global: {
        onAction: (cb) => ipcRenderer.on('global:action', (_, a) => cb(a)),
    },

    overlay: {
        onData: (cb) => ipcRenderer.on('overlay:data', (_, d) => cb(d)),
        show: (data) => ipcRenderer.send('overlay:show', data),
    },
    
    fetchExternal: (url, isBlob) => ipcRenderer.invoke('fetch-external', url, isBlob),

    music: {
        soundcloud: {
            search:   (q, opts) => ipcRenderer.invoke('music:soundcloud:search', q, opts),
            download: (trackId) => ipcRenderer.invoke('music:soundcloud:download', trackId),
        },

        yandex: {
            status:      ()     => ipcRenderer.invoke('music:yandex:status'),
            deviceAuth:  ()     => ipcRenderer.invoke('music:yandex:deviceAuth'),
            search:      (q,o)  => ipcRenderer.invoke('music:yandex:search', q, o),
            download:    (id)   => ipcRenderer.invoke('music:yandex:download', id),
            disconnect:  ()     => ipcRenderer.invoke('music:yandex:disconnect'),
            saveUid:     (data) => ipcRenderer.invoke('music:yandex:saveUid', data),
            onDeviceCode:(cb)   => ipcRenderer.on('music:yandex:deviceCode', (_, d) => cb(d)),
            onAuthDone:  (cb)   => ipcRenderer.on('music:yandex:authDone',   (_, d) => cb(d)),
            onNeedUid:   (cb)   => ipcRenderer.on('music:yandex:needUid',    (_, d) => cb(d)),
        },
    },
});