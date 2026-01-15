// popup.js - Per-tab volume, only one tab active at a time

// Silence logs in production
const isDev = !('update_url' in chrome.runtime.getManifest());
if (!isDev) {
    console.log = () => { };
    console.error = () => { };
    console.warn = () => { };
}

let isControlling = false;
let hasStarted = false;
let currentVolume = 1.0;

async function sendToBackground(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(response);
            }
        });
    });
}

function updateWarning(percent) {
    const warning = document.getElementById('warning');
    if (warning) {
        warning.style.display = (percent > 400) ? 'block' : 'none';
    }
}

function updateStatus(active) {
    const status = document.getElementById('status');
    if (active) {
        status.textContent = 'Controlling this tab';
        status.classList.add('active');
    } else {
        status.textContent = 'Not controlling this tab';
        status.classList.remove('active');
    }
}

// ─────────────────────────────────────────────────────────────
// Load per-tab volume when popup opens
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Small delay for background readiness
        await new Promise(r => setTimeout(r, 300));

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.id) return;

        const tabId = activeTab.id;

        // Load saved volume for this tab
        const key = `volume_${tabId}`;
        const savedData = await chrome.storage.local.get(key);
        const savedVolume = savedData[key];

        const initialVolume = savedVolume ?? 1.0;
        const percent = Math.round(initialVolume * 100);

        document.getElementById('volume').value = percent;
        document.getElementById('volumeValue').textContent = percent;
        updateWarning(percent);

        // Check if this tab is currently being controlled
        const state = await chrome.storage.local.get(['controlledTabId']);
        if (state.controlledTabId === tabId) {
            isControlling = true;
            hasStarted = true;
            updateStatus(true);
        } else {
            updateStatus(false);
        }

        console.log(`Popup opened on tab ${tabId} → volume: ${percent}%`);

    } catch (err) {
        console.error('Popup load error:', err);
        document.getElementById('volume').value = 100;
        document.getElementById('volumeValue').textContent = 100;
        updateWarning(100);
    }
});

// ─────────────────────────────────────────────────────────────
// Slider – auto-start on first move, stop previous tab if needed
document.getElementById('volume').addEventListener('input', async (event) => {
    const value = parseInt(event.target.value, 10);
    document.getElementById('volumeValue').textContent = value;
    updateWarning(value);

    const volumeLevel = value / 100;

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) return;

    const tabId = activeTab.id;

    if (!hasStarted) {
        try {
            await sendToBackground({ action: 'startCapture', tabId });
            hasStarted = true;
            isControlling = true;
            updateStatus(true);

            console.log(`Started control on tab ${tabId}`);
        } catch (err) {
            showError('Failed to start: ' + (err.message || 'Unknown error'));
            return;
        }
    }

    if (isControlling) {
        await sendToBackground({ action: 'setVolume', tabId, volume: volumeLevel });
        currentVolume = volumeLevel;

        // Save per-tab
        const key = `volume_${tabId}`;
        await chrome.storage.local.set({ [key]: volumeLevel });
    }
});

// Restore to 100%
document.getElementById('restoreBtn').addEventListener('click', async () => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) return;

    const tabId = activeTab.id;

    // Set storage FIRST so startCapture (in background) picks up 100%
    const key = `volume_${tabId}`;
    await chrome.storage.local.set({ [key]: 1.0 });

    if (!hasStarted) {
        try {
            await sendToBackground({ action: 'startCapture', tabId });
            hasStarted = true;
            isControlling = true;
            updateStatus(true);
            console.log(`Started control on tab ${tabId} via Restore button`);
        } catch (err) {
            console.error('Start failed via Restore:', err);
            alert('Failed to start: ' + (err.message || 'Unknown error'));
            return;
        }
    }

    currentVolume = 1.0;
    document.getElementById('volume').value = 100;
    document.getElementById('volumeValue').textContent = 100;
    updateWarning(100);

    // Also send explicit setVolume to ensure UI/offscreen sync
    await sendToBackground({ action: 'setVolume', tabId, volume: 1.0 });
});

// ─────────────────────────────────────────────────────────────
// True stop – stop current tab
document.getElementById('trueStopBtn').addEventListener('click', async () => {
    if (!isControlling) return;

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) return;

    const tabId = activeTab.id;

    await sendToBackground({ action: 'trueStopCapture', tabId });

    const key = `volume_${tabId}`;
    await chrome.storage.local.remove(key);

    isControlling = false;
    hasStarted = false;
    updateStatus(false);

    // Reset UI to 100%
    document.getElementById('volume').value = 100;
    document.getElementById('volumeValue').textContent = 100;
    updateWarning(100);
});

// Error feedback
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'captureError') {
        showError('Capture failed: ' + msg.message);
        isControlling = false;
        hasStarted = false;
        updateStatus(false);

        // Reset UI to 100%
        document.getElementById('volume').value = 100;
        document.getElementById('volumeValue').textContent = 100;
        updateWarning(100);

        document.getElementById('helpText').style.display = 'none';
    }
});

function showError(message) {
    const container = document.getElementById('errorContainer');
    if (container) {
        container.textContent = message;
        container.style.display = 'block';
        setTimeout(() => {
            container.style.display = 'none';
        }, 5000);
    }
}