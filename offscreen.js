let audioContext = null;
let gainNode = null;
let source = null;

// Listen for messages from background or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startAudio') {
        startAudioProcessing(message.streamId, message.volume || 1.0);
    } else if (message.action === 'setVolume') {
        if (gainNode) {
            gainNode.gain.value = message.volume;
        }
    } else if (message.action === 'stopAudio') {
        stopAudioProcessing();
    }
});

async function startAudioProcessing(streamId, initialVolume) {
    try {
        console.log('Offscreen: Attempting to get tab stream with ID:', streamId);

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            }
        });

        console.log('Offscreen: Got stream successfully');

        audioContext = new AudioContext();
        console.log('AudioContext state before resume:', audioContext.state);

        // Always try to resume (critical in background/offscreen contexts)
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
            console.log('AudioContext resumed');
        }

        source = audioContext.createMediaStreamSource(stream);
        gainNode = audioContext.createGain();
        gainNode.gain.value = initialVolume;

        source.connect(gainNode);
        gainNode.connect(audioContext.destination);

        console.log('Offscreen: Audio processing fully started');
    } catch (err) {
        console.error('Offscreen startAudioProcessing failed:', err.name, err.message, err.stack);
        // Optional: Send error back to background/popup if you add messaging
    }
}

function stopAudioProcessing() {
    if (gainNode) gainNode.disconnect();
    if (source) source.disconnect();
    if (audioContext) audioContext.close();
    audioContext = null; gainNode = null; source = null;
    console.log('Offscreen: Audio stopped');
}