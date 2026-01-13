// popup.js - Auto-start on first slider change

let tabId = null;
let isControlling = false;
let currentVolume = 1.0;
let hasStarted = false;  // Prevent multiple starts

function sendToBackground(message) {
    chrome.runtime.sendMessage(message)
        .catch(err => {
            console.error('Send message failed:', err);
        });
    // No (response) callback → no "port closed" expectation
}

async function loadState() {
    const data = await chrome.storage.local.get([
        'isControlling',
        'controlledTabId',
        'lastVolume'
    ]);

    if (data.isControlling && data.controlledTabId) {
        try {
            const tab = await chrome.tabs.get(data.controlledTabId);
            if (tab) {
                tabId = data.controlledTabId;
                isControlling = true;
                hasStarted = true;
                currentVolume = data.lastVolume || 1.0;

                document.getElementById('restoreBtn').style.display = 'inline-block';
                document.getElementById('trueStopBtn').style.display = 'inline-block';
                document.getElementById('helpText').style.display = 'block';

                const percent = Math.round(currentVolume * 100);
                document.getElementById('volume').value = percent;
                document.getElementById('volumeValue').textContent = percent;

                updateWarning(percent);
                return;
            }
        } catch (err) {
            // Tab gone → clean up storage silently
            chrome.storage.local.remove(['isControlling', 'controlledTabId', 'lastVolume']);
            console.debug('Cleared invalid/old controlled tab state');
        }
    }

    // Default fresh state
    isControlling = false;
    hasStarted = false;
    document.getElementById('restoreBtn').style.display = 'none';
    document.getElementById('trueStopBtn').style.display = 'none';
    document.getElementById('helpText').style.display = 'none';

    document.getElementById('volume').value = 100;
    document.getElementById('volumeValue').textContent = 100;
    updateWarning(100);
}

function updateWarning(percent) {
    const warning = document.getElementById('warning');
    if (warning) {
        warning.style.display = (percent > 400) ? 'block' : 'none';
    }
}

// ------------------- Slider is now the trigger -------------------
document.getElementById('volume').addEventListener('input', async (event) => {
    const value = parseInt(event.target.value, 10);
    document.getElementById('volumeValue').textContent = value;
    updateWarning(value);

    const volumeLevel = value / 100;

    if (!hasStarted) {
        // First movement → auto-start capture
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!activeTab?.id) {
                alert('No active tab found. Please try on a tab with sound.');
                return;
            }

            tabId = activeTab.id;
            sendToBackground({ action: 'startCapture', tabId });

            hasStarted = true;
            isControlling = true;

            // Show control buttons
            document.getElementById('restoreBtn').style.display = 'inline-block';
            document.getElementById('trueStopBtn').style.display = 'inline-block';
            document.getElementById('helpText').style.display = 'block';

            console.log('Auto-started control on first slider move');
        } catch (err) {
            console.error('Auto-start failed:', err);
            alert('Failed to start: ' + (err.message || 'Unknown error'));
        }
    }

    // Always send volume update if controlling
    if (isControlling) {
        sendToBackground({ action: 'setVolume', volume: volumeLevel });
        currentVolume = volumeLevel;
        chrome.storage.local.set({ lastVolume: volumeLevel });
    }
});

// Restore to 100%
document.getElementById('restoreBtn').addEventListener('click', () => {
    if (!isControlling) return;

    currentVolume = 1.0;
    document.getElementById('volume').value = 100;
    document.getElementById('volumeValue').textContent = 100;
    updateWarning(100);

    sendToBackground({ action: 'setVolume', volume: 1.0 });
    chrome.storage.local.set({ lastVolume: 1.0 });
});

// True stop / Fix audio
document.getElementById('trueStopBtn').addEventListener('click', async () => {
    if (!isControlling || !tabId) return;

    sendToBackground({ action: 'trueStopCapture', tabId });

    isControlling = false;
    hasStarted = false;

    document.getElementById('restoreBtn').style.display = 'none';
    document.getElementById('trueStopBtn').style.display = 'none';
    document.getElementById('helpText').style.display = 'none';

    await chrome.storage.local.remove(['isControlling', 'controlledTabId', 'lastVolume']);
});

// Error feedback
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'captureError') {
        alert('Capture failed: ' + msg.message);
        isControlling = false;
        hasStarted = false;
        document.getElementById('restoreBtn').style.display = 'none';
        document.getElementById('trueStopBtn').style.display = 'none';
    }
});

document.addEventListener('DOMContentLoaded', loadState);