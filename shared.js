// shared.js - Shared constants and utilities (ES Module)

export const CONSTANTS = {
    MAX_VOLUME: 900,
    WARNING_THRESHOLD: 400,
    DEFAULT_VOLUME: 100,
    RAMP_TIME: 0.1, // Seconds for volume smoothing
    STORAGE_KEYS: {
        CONTROLLED_TAB_ID: 'controlledTabId',
        IS_CONTROLLING: 'isControlling',
        LAST_VOLUME: 'lastVolume'
    }
};

export function getVolumeKey(tabId) {
    return `volume_${tabId}`;
}

export function isDevMode() {
    try {
        return typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function' && !('update_url' in chrome.runtime.getManifest());
    } catch (e) {
        return false;
    }
}

export function setupLogging() {
    if (!isDevMode()) {
        console.log = () => { };
        console.error = () => { };
        console.warn = () => { };
    }
}
