(async () => {
    // Silence logs in production
    const isDev = !('update_url' in chrome.runtime.getManifest());
    if (!isDev) {
        console.log = () => { };
        console.error = () => { };
        console.warn = () => { };
    }

    let currentTabId = null;
    let currentVolume = 1.0;
    let offscreenCreated = false;
    let creatingOffscreen = null;

    async function createOffscreenDocument() {
        if (offscreenCreated) return;
        if (creatingOffscreen) {
            await creatingOffscreen;
            return;
        }

        try {
            const hasDocument = await chrome.offscreen.hasDocument();
            if (hasDocument) {
                offscreenCreated = true;
                return;
            }
        } catch (e) {
            // Ignore error from hasDocument if context is invalid
        }

        creatingOffscreen = (async () => {
            try {
                await chrome.offscreen.createDocument({
                    url: 'offscreen.html',
                    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
                    justification: 'Volume control requires an offscreen document'
                });
                offscreenCreated = true;
                console.log('Offscreen document created');
            } catch (err) {
                console.error('Offscreen creation failed:', err);
                if (err.message?.includes('single offscreen document')) {
                    offscreenCreated = true;
                } else {
                    throw err;
                }
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
        const text = percent > 999 ? 'MAX' : percent.toString();
        chrome.action.setBadgeText({ text });

        let color = percent <= 100 ? '#4CAF50' :
            percent <= 400 ? '#FFC107' : '#F44336';

        chrome.action.setBadgeBackgroundColor({ color });
        chrome.action.setTitle({ title: `Volume: ${text}%` });
    }

    async function startCapture(tabId) {
        try {
            if (currentTabId === tabId) {
                console.log('Tab already being captured:', tabId);
                return;
            }

            if (currentTabId && currentTabId !== tabId) {
                await trueStopCapture(currentTabId);
            }

            const key = `volume_${tabId}`;
            const saved = await chrome.storage.local.get(key);
            const initialVolume = saved[key] ?? 1.0;

            await createOffscreenDocument();

            const streamId = await new Promise((resolve, reject) => {
                chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError.message);
                    } else {
                        resolve(id);
                    }
                });
            });

            currentTabId = tabId;
            currentVolume = initialVolume;

            chrome.runtime.sendMessage({
                action: 'startAudio',
                streamId,
                volume: initialVolume
            });

            await chrome.storage.local.set({
                isControlling: true,
                controlledTabId: tabId,
                lastVolume: initialVolume,
                [key]: initialVolume
            });

            updateBadge(initialVolume * 100);
        } catch (err) {
            console.error('Start capture failed:', err);
            chrome.runtime.sendMessage({ action: 'captureError', message: err.message || 'Unknown error' });
            updateBadge(null);
        }
    }

    async function trueStopCapture(tabId) {
        try {
            currentTabId = null;
            chrome.runtime.sendMessage({ action: 'stopAudio' });

            if (tabId) {
                setTimeout(async () => {
                    try {
                        const tab = await chrome.tabs.get(tabId);
                        if (tab) await chrome.tabs.update(tabId, { muted: false });
                    } catch (e) {
                        // ignore
                    }
                }, 500);
            }

            updateBadge(null);
        } catch (err) {
            console.error('Stop capture failed:', err);
            updateBadge(null);
        }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'ping') {
            sendResponse({ ready: true });
            return true;
        }

        if (message.action === 'startCapture') {
            startCapture(message.tabId)
                .then(() => sendResponse({ success: true }))
                .catch(e => sendResponse({ error: e }));
            return true;
        }

        if (message.action === 'trueStopCapture') {
            trueStopCapture(message.tabId)
                .then(() => sendResponse({ success: true }))
                .catch(e => sendResponse({ error: e }));
            return true;
        }

        if (message.action === 'setVolume') {
            currentVolume = message.volume;
            chrome.runtime.sendMessage({
                action: 'setVolume',
                volume: currentVolume
            });
            updateBadge(currentVolume * 100);

            if (currentTabId) {
                chrome.storage.local.set({
                    [`volume_${currentTabId}`]: currentVolume,
                    lastVolume: currentVolume
                });
            }
            sendResponse({ success: true });
            return true;
        }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
        chrome.storage.local.remove(`volume_${tabId}`); // Prevent storage bloat
        if (currentTabId === tabId) {
            trueStopCapture(tabId);
            chrome.storage.local.remove(['isControlling', 'controlledTabId', 'lastVolume']);
        }
    });

    chrome.tabs.onActivated.addListener(() => {
        updateBadgeForActiveTab();
    });

    async function restoreBadgeOnStartup() {
        const data = await chrome.storage.local.get(['isControlling', 'controlledTabId', 'lastVolume']);
        if (data.isControlling && data.controlledTabId && data.lastVolume != null) {
            try {
                const tab = await chrome.tabs.get(data.controlledTabId);
                if (tab) {
                    currentTabId = data.controlledTabId;
                    currentVolume = data.lastVolume;
                    updateBadge(currentVolume * 100);

                    await createOffscreenDocument();
                    // Small delay to ensure offscreen is ready
                    setTimeout(() => {
                        chrome.runtime.sendMessage({
                            action: 'setVolume',
                            volume: data.lastVolume
                        }).catch(() => { });
                    }, 500);
                }
            } catch (e) {
                console.log('No tab to restore volume for');
            }
        }
    }

    function updateBadgeForActiveTab() {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (tab?.id && currentTabId === tab.id) {
                updateBadge(currentVolume * 100);
            } else {
                updateBadge(null);
            }
        });
    }

    try {
        await restoreBadgeOnStartup();
        console.log('Background initialized');
    } catch (err) {
        console.error('Initialization error:', err);
    }
})();