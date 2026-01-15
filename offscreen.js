let audioContext = null;
let gainNode = null;
let source = null;
let pendingVolume = null;

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'startAudio') {
        startAudio(msg.streamId, msg.volume);
    } else if (msg.action === 'setVolume') {
        if (gainNode) {
            gainNode.gain.value = msg.volume;
        } else {
            pendingVolume = msg.volume;
        }
    } else if (msg.action === 'stopAudio') {
        stopAudio();
    }
});

async function startAudio(streamId, initialVolume) {
    stopAudio(); // Prevent leaks or overlapping audio
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

        const volumeToUse = pendingVolume !== null ? pendingVolume : initialVolume;
        gainNode.gain.value = volumeToUse;
        pendingVolume = null;

        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
    } catch (err) {
        console.error('Offscreen start failed:', err);
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