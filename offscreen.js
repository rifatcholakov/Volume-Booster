import { CONSTANTS, setupLogging } from './shared.js';

setupLogging();

let audioContext = null;
let gainNode = null;
let source = null;
let pendingVolume = null;

chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.action) {
        case 'startAudio':
            startAudio(msg.streamId, msg.volume);
            break;
        case 'setVolume':
            setVolume(msg.volume);
            break;
        case 'stopAudio':
            stopAudio();
            break;
    }
});

function setVolume(volume) {
    if (gainNode && audioContext) {
        // Use exponential ramping for natural sounding volume changes and to prevent clicks
        // We use a small offset (+ 0.0001) because exponentialRampToValueAtTime cannot ramp to 0
        const targetValue = Math.max(0.0001, volume);
        gainNode.gain.exponentialRampToValueAtTime(targetValue, audioContext.currentTime + CONSTANTS.RAMP_TIME);
    } else {
        pendingVolume = volume;
    }
}

async function startAudio(streamId, initialVolume) {
    stopAudio();
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            }
        });

        audioContext = new AudioContext();
        await audioContext.resume();

        source = audioContext.createMediaStreamSource(stream);
        gainNode = audioContext.createGain();

        // Initial set without ramping for immediate feedback
        const volumeToUse = pendingVolume !== null ? pendingVolume : initialVolume;
        gainNode.gain.value = Math.max(0.0001, volumeToUse);
        pendingVolume = null;

        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
    } catch (err) {
        console.error('Offscreen start failed:', err);
        chrome.runtime.sendMessage({ action: 'captureError', message: 'Audio capture initialization failed' });
    }
}

function stopAudio() {
    if (source && source.mediaStream) {
        source.mediaStream.getTracks().forEach(track => track.stop());
    }
    if (gainNode) gainNode.disconnect();
    if (source) source.disconnect();
    if (audioContext) {
        audioContext.close().catch(console.error);
    }
    audioContext = null;
    gainNode = null;
    source = null;
}