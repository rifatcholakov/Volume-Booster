(async () => {
    // ─────────────────────────────────────────────────────────────
    // All global variables
    let currentStreamId = null;
    let currentTabId = null;
    let offscreenCreated = false;
    let creatingOffscreen = null;  // global promise lock to prevent races

    // ─────────────────────────────────────────────────────────────
    // All functions (in logical order)

    async function createOffscreenDocument() {
        if (offscreenCreated) return;
        if (creatingOffscreen) {
            await creatingOffscreen;
            return;
        }
        if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
            offscreenCreated = true;
            return;
        }

        creatingOffscreen = (async () => {
            try {
                await chrome.offscreen.createDocument({
                    url: 'offscreen.html',
                    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
                    justification: 'Persistent tab audio capture and volume adjustment'
                });
                offscreenCreated = true;
                console.log('Offscreen document created successfully');
            } catch (err) {
                console.error('Offscreen creation failed:', err);
                if (!err.message?.includes('Only a single offscreen document may be created')) {
                    throw err;
                }
                offscreenCreated = true;
            } finally {
                creatingOffscreen = null;
            }
        })();

        await creatingOffscreen;
    }

    function updateBadge(volumePercent = null) {
        if (volumePercent === null || !currentTabId) {
            chrome.action.setBadgeText({ text: '' });
            chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] });
            chrome.action.setTitle({ title: 'Volume Booster - Not active' });
            return;
        }

        const percent = Math.round(volumePercent);
        const text = percent > 899 ? 'MAX' : percent.toString();
        chrome.action.setBadgeText({ text });

        let color;
        if (percent <= 100) color = '#4CAF50';
        else if (percent <= 400) color = '#FFC107';
        else color = '#F44336';

        chrome.action.setBadgeBackgroundColor({ color });
        chrome.action.setTitle({ title: `Volume: ${text}%` });
        console.log(`Badge updated: ${text}% (${color})`);
    }

    async function startCapture(tabId) {
        try {
            console.log('Starting capture attempt for tabId:', tabId);

            if (currentTabId) {
                console.log('Previous capture exists → cleaning first');
                await trueStopCapture(currentTabId);
            }

            const savedData = await chrome.storage.local.get('lastVolume');
            const initialVolume = savedData.lastVolume ?? 1.0;

            await createOffscreenDocument();
            console.log('Offscreen document ready');

            const streamId = await new Promise((resolve, reject) => {
                chrome.tabCapture.getMediaStreamId(
                    { targetTabId: tabId },
                    (id) => {
                        if (chrome.runtime.lastError) {
                            const errorMsg = chrome.runtime.lastError.message;
                            console.error('getMediaStreamId failed - runtime.lastError:', errorMsg);
                            reject(new Error(errorMsg));
                            return;
                        }
                        if (!id || typeof id !== 'string' || id.trim() === '') {
                            console.error('getMediaStreamId returned invalid/empty ID');
                            reject(new Error('No valid stream ID returned'));
                            return;
                        }
                        console.log('Successfully got streamId:', id);
                        resolve(id);
                    }
                );
            });

            currentStreamId = streamId;
            currentTabId = tabId;

            chrome.runtime.sendMessage({
                action: 'startAudio',
                streamId: streamId,
                volume: initialVolume
            });

            await chrome.storage.local.set({
                isControlling: true,
                controlledTabId: tabId,
                lastVolume: initialVolume
            });

            console.log('State saved: controlling tab', tabId, 'with volume', initialVolume);

            updateBadge(initialVolume * 100);
        } catch (err) {
            console.error('Full startCapture error:', err.message || err);
            chrome.runtime.sendMessage({ action: 'captureError', message: err.message });
            updateBadge(null);
        }
    }

    async function trueStopCapture(tabId) {
        try {
            console.log('True stop & restore attempt for tab:', tabId);

            chrome.runtime.sendMessage({ action: 'stopAudio' });

            await new Promise(resolve => setTimeout(resolve, 500));

            if (tabId) {
                await chrome.tabs.update(tabId, { muted: false }).catch(e => {
                    console.warn('Unmute attempt failed (common with tabCapture):', e);
                });
            }

            currentStreamId = null;
            currentTabId = null;

            if (offscreenCreated) {
                await chrome.offscreen.closeDocument().catch(e => console.warn('Offscreen close failed:', e));
                offscreenCreated = false;
                console.log('Offscreen document closed');
                creatingOffscreen = null;
            }

            updateBadge(null);
            console.log('True stop completed. If tab audio is still silent, user may need to manually unmute or reload tab.');
        } catch (err) {
            console.error('True stop failed:', err);
            creatingOffscreen = null;
            updateBadge(null);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Register all listeners (they run immediately)

    chrome.runtime.onStartup.addListener(async () => {
        await createOffscreenDocument();
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'startCapture') {
            startCapture(message.tabId);
        } else if (message.action === 'trueStopCapture') {
            trueStopCapture(message.tabId);
        } else if (message.action === 'setVolume') {
            if (currentStreamId) {
                chrome.storage.local.set({ lastVolume: message.volume });
                chrome.runtime.sendMessage({
                    action: 'setVolume',
                    volume: message.volume
                });
                updateBadge(message.volume * 100);
            }
        }
    });

    chrome.runtime.onInstalled.addListener(async (details) => {
        if (details.reason === 'update' || details.reason === 'install') {
            await chrome.storage.local.remove(['isControlling', 'controlledTabId', 'lastVolume']);
            console.log('Cleared old state on extension update');
        }
    });

    // ─────────────────────────────────────────────────────────────
    // Awaited initialization at startup / reload

    await restoreBadgeOnStartup();
    console.log('Volume Booster background service worker fully initialized');

    // ─────────────────────────────────────────────────────────────
    // Helper function for startup badge restore
    async function restoreBadgeOnStartup() {
        try {
            const data = await chrome.storage.local.get(['isControlling', 'controlledTabId', 'lastVolume']);
            if (data.isControlling && data.controlledTabId && data.lastVolume != null) {
                const tab = await chrome.tabs.get(data.controlledTabId);
                if (tab) {
                    updateBadge(data.lastVolume * 100);

                    await createOffscreenDocument();

                    chrome.runtime.sendMessage({
                        action: 'setVolume',
                        volume: data.lastVolume
                    });

                    console.log('Restored badge and volume on service worker startup');
                }
            }
        } catch (err) {
            console.warn('Startup badge restore failed (normal if no active control):', err);
        }
    }
})();