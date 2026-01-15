import { CONSTANTS, getVolumeKey, setupLogging } from './shared.js';

// Global State
let state = {
    currentTabId: null,
    currentVolume: 1.0,
    offscreenCreated: false,
    creatingOffscreen: null
};

// Silence logs in production
setupLogging();

// ─────────────────────────────────────────────────────────────
// Offscreen Document Management

async function createOffscreenDocument() {
    if (state.offscreenCreated) return;
    if (state.creatingOffscreen) return state.creatingOffscreen;

    try {
        const hasDocument = await chrome.offscreen.hasDocument();
        if (hasDocument) {
            state.offscreenCreated = true;
            return;
        }
    } catch (e) {
        // Ignore error
    }

    state.creatingOffscreen = (async () => {
        try {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
                justification: 'Volume control requires an offscreen document'
            });
            state.offscreenCreated = true;
            console.log('Offscreen document created');
        } catch (err) {
            console.error('Offscreen creation failed:', err);
            if (!err.message?.includes('single offscreen document')) {
                throw err;
            }
            state.offscreenCreated = true;
        } finally {
            state.creatingOffscreen = null;
        }
    })();

    return state.creatingOffscreen;
}

// ─────────────────────────────────────────────────────────────
// Badge & UI Updates

function updateBadge(volumePercent = null) {
    if (volumePercent === null || !state.currentTabId) {
        chrome.action.setBadgeText({ text: '' });
        chrome.action.setTitle({ title: 'Easy Volume Booster - Inactive' });
        return;
    }

    const percent = Math.round(volumePercent);
    const text = percent > 999 ? 'MAX' : percent.toString();
    chrome.action.setBadgeText({ text });

    const color = percent <= 100 ? '#34c759' : (percent <= CONSTANTS.WARNING_THRESHOLD ? '#ffcc00' : '#ff3b30');
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setTitle({ title: `Volume: ${text}%` });
}

async function updateBadgeForActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && state.currentTabId === tab.id) {
        updateBadge(state.currentVolume * 100);
    } else {
        updateBadge(null);
    }
}

// ─────────────────────────────────────────────────────────────
// Capture Logic

async function startCapture(tabId) {
    try {
        if (state.currentTabId === tabId) return;

        if (state.currentTabId) {
            await trueStopCapture(state.currentTabId);
        }

        const key = getVolumeKey(tabId);
        const saved = await chrome.storage.local.get(key);
        const initialVolume = saved[key] ?? 1.0;

        await createOffscreenDocument();

        const streamId = await new Promise((resolve, reject) => {
            chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(id);
                }
            });
        });

        state.currentTabId = tabId;
        state.currentVolume = initialVolume;

        chrome.runtime.sendMessage({
            action: 'startAudio',
            streamId,
            volume: initialVolume
        });

        await chrome.storage.local.set({
            [CONSTANTS.STORAGE_KEYS.IS_CONTROLLING]: true,
            [CONSTANTS.STORAGE_KEYS.CONTROLLED_TAB_ID]: tabId,
            [CONSTANTS.STORAGE_KEYS.LAST_VOLUME]: initialVolume,
            [key]: initialVolume
        });

        updateBadge(initialVolume * 100);
    } catch (err) {
        console.error('Capture failed:', err);
        chrome.runtime.sendMessage({ action: 'captureError', message: err.message || 'Unknown error' });
        updateBadge(null);
    }
}

async function trueStopCapture(tabId) {
    try {
        state.currentTabId = null;
        chrome.runtime.sendMessage({ action: 'stopAudio' });

        if (tabId) {
            setTimeout(async () => {
                try {
                    const tab = await chrome.tabs.get(tabId);
                    if (tab) await chrome.tabs.update(tabId, { muted: false });
                } catch (e) { /* Tab might be closed */ }
            }, 300);
        }

        updateBadge(null);
    } catch (err) {
        console.error('Stop failed:', err);
    }
}

// ─────────────────────────────────────────────────────────────
// Event Listeners (Top-Level)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'ping':
            sendResponse({ ready: true });
            break;
        case 'startCapture':
            startCapture(message.tabId)
                .then(() => sendResponse({ success: true }))
                .catch(e => sendResponse({ error: e.message }));
            return true;
        case 'trueStopCapture':
            trueStopCapture(message.tabId)
                .then(() => sendResponse({ success: true }))
                .catch(e => sendResponse({ error: e.message }));
            return true;
        case 'setVolume':
            state.currentVolume = message.volume;
            chrome.runtime.sendMessage({ action: 'setVolume', volume: state.currentVolume });
            updateBadge(state.currentVolume * 100);

            if (state.currentTabId) {
                chrome.storage.local.set({
                    [getVolumeKey(state.currentTabId)]: state.currentVolume,
                    [CONSTANTS.STORAGE_KEYS.LAST_VOLUME]: state.currentVolume
                });
            }
            sendResponse({ success: true });
            break;
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove(getVolumeKey(tabId));
    if (state.currentTabId === tabId) {
        trueStopCapture(tabId);
        chrome.storage.local.remove([
            CONSTANTS.STORAGE_KEYS.IS_CONTROLLING,
            CONSTANTS.STORAGE_KEYS.CONTROLLED_TAB_ID,
            CONSTANTS.STORAGE_KEYS.LAST_VOLUME
        ]);
    }
});

chrome.tabs.onActivated.addListener(updateBadgeForActiveTab);
chrome.windows.onFocusChanged.addListener(updateBadgeForActiveTab);

// ─────────────────────────────────────────────────────────────
// Initialization

async function init() {
    const data = await chrome.storage.local.get([
        CONSTANTS.STORAGE_KEYS.IS_CONTROLLING,
        CONSTANTS.STORAGE_KEYS.CONTROLLED_TAB_ID,
        CONSTANTS.STORAGE_KEYS.LAST_VOLUME
    ]);

    if (data[CONSTANTS.STORAGE_KEYS.IS_CONTROLLING] && data[CONSTANTS.STORAGE_KEYS.CONTROLLED_TAB_ID]) {
        try {
            const tabId = data[CONSTANTS.STORAGE_KEYS.CONTROLLED_TAB_ID];
            const tab = await chrome.tabs.get(tabId);
            if (tab) {
                state.currentTabId = tabId;
                state.currentVolume = data[CONSTANTS.STORAGE_KEYS.LAST_VOLUME] ?? 1.0;
                updateBadge(state.currentVolume * 100);

                await createOffscreenDocument();
                // Re-sync offscreen if it was restarted
                setTimeout(() => {
                    chrome.runtime.sendMessage({
                        action: 'setVolume',
                        volume: state.currentVolume
                    }).catch(() => { });
                }, 1000);
            }
        } catch (e) {
            console.log('No active session to restore');
            chrome.storage.local.remove([
                CONSTANTS.STORAGE_KEYS.IS_CONTROLLING,
                CONSTANTS.STORAGE_KEYS.CONTROLLED_TAB_ID,
                CONSTANTS.STORAGE_KEYS.LAST_VOLUME
            ]);
        }
    }
    console.log('Background service worker initialized');
}

// Start Init
init().catch(console.error);