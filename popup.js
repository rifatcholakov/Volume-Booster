import { CONSTANTS, getVolumeKey, setupLogging } from './shared.js';

// Silence logs in production
setupLogging();

// DOM Cache
const ELEMENTS = {
    volume: document.getElementById('volume'),
    volumeValue: document.getElementById('volumeValue'),
    warning: document.getElementById('warning'),
    status: document.getElementById('status'),
    restoreBtn: document.getElementById('restoreBtn'),
    trueStopBtn: document.getElementById('trueStopBtn'),
    errorContainer: document.getElementById('errorContainer'),
    helpText: document.getElementById('helpText')
};

let state = {
    isControlling: false,
    hasStarted: false,
    currentTabId: null
};

// Messaging helper
async function sendToBackground(message) {
    try {
        return await chrome.runtime.sendMessage(message);
    } catch (err) {
        console.error('Messaging error:', err);
        throw err;
    }
}

// UI Updates
function updateWarning(percent) {
    if (percent > CONSTANTS.WARNING_THRESHOLD) {
        ELEMENTS.warning.classList.add('visible');
    } else {
        ELEMENTS.warning.classList.remove('visible');
    }
}

function updateStatus(active) {
    if (active) {
        ELEMENTS.status.textContent = 'Controlling this tab';
        ELEMENTS.status.classList.add('active');
    } else {
        ELEMENTS.status.textContent = 'Not controlling';
        ELEMENTS.status.classList.remove('active');
    }
}

function showError(message) {
    ELEMENTS.errorContainer.textContent = message;
    ELEMENTS.errorContainer.style.display = 'block';
    setTimeout(() => {
        ELEMENTS.errorContainer.style.display = 'none';
    }, 5000);
}

function syncUI(percent, isActive) {
    ELEMENTS.volume.value = percent;
    ELEMENTS.volumeValue.textContent = percent;
    updateWarning(percent);
    updateStatus(isActive);
}

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.id) return;

        state.currentTabId = activeTab.id;

        // Load saved volume and capture state
        const key = getVolumeKey(state.currentTabId);
        const storageData = await chrome.storage.local.get([key, CONSTANTS.STORAGE_KEYS.CONTROLLED_TAB_ID]);

        const savedVolume = storageData[key];
        const controlledTabId = storageData[CONSTANTS.STORAGE_KEYS.CONTROLLED_TAB_ID];

        const initialVolume = savedVolume ?? 1.0;
        const percent = Math.round(initialVolume * 100);

        state.isControlling = (controlledTabId === state.currentTabId);
        state.hasStarted = state.isControlling;

        syncUI(percent, state.isControlling);

        console.log(`Popup initialized on tab ${state.currentTabId} - ${percent}%`);
    } catch (err) {
        console.error('Init error:', err);
        syncUI(100, false);
    }
});

// Slider Input (Debounced setVolume)
let volumeTimeout;
ELEMENTS.volume.addEventListener('input', async (e) => {
    const value = parseInt(e.target.value, 10);
    ELEMENTS.volumeValue.textContent = value;
    updateWarning(value);

    const volumeLevel = value / 100;

    if (!state.hasStarted) {
        try {
            await sendToBackground({ action: 'startCapture', tabId: state.currentTabId });
            state.hasStarted = true;
            state.isControlling = true;
            updateStatus(true);
        } catch (err) {
            showError('Failed to start: ' + (err.message || 'Unknown error'));
            return;
        }
    }

    if (state.isControlling) {
        // Debounce setVolume to avoid flooding
        clearTimeout(volumeTimeout);
        volumeTimeout = setTimeout(async () => {
            await sendToBackground({ action: 'setVolume', tabId: state.currentTabId, volume: volumeLevel });
            const key = getVolumeKey(state.currentTabId);
            await chrome.storage.local.set({ [key]: volumeLevel });
        }, 50);
    }
});

// Restore to 100%
ELEMENTS.restoreBtn.addEventListener('click', async () => {
    if (!state.currentTabId) return;

    const key = getVolumeKey(state.currentTabId);
    await chrome.storage.local.set({ [key]: 1.0 });

    if (!state.hasStarted) {
        try {
            await sendToBackground({ action: 'startCapture', tabId: state.currentTabId });
            state.hasStarted = true;
            state.isControlling = true;
        } catch (err) {
            showError('Failed to start: ' + (err.message || 'Unknown error'));
            return;
        }
    }

    syncUI(100, true);
    await sendToBackground({ action: 'setVolume', tabId: state.currentTabId, volume: 1.0 });
});

// Turn Off
ELEMENTS.trueStopBtn.addEventListener('click', async () => {
    if (!state.isControlling || !state.currentTabId) return;

    await sendToBackground({ action: 'trueStopCapture', tabId: state.currentTabId });
    await chrome.storage.local.remove(getVolumeKey(state.currentTabId));

    state.isControlling = false;
    state.hasStarted = false;
    syncUI(100, false);
});

// Handle Background Messages
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'captureError') {
        showError('Capture failed: ' + msg.message);
        state.isControlling = false;
        state.hasStarted = false;
        syncUI(100, false);
    }
});