// Native browser text-to-speech - free, no API, no model to host. Default
// voices are intentionally left as-is (no custom voice selection) since
// that flat, slightly robotic read is exactly the vibe being matched here.
// Resolves once the line has actually finished playing (or immediately if
// there's nothing to say) so callers can hold the countdown open until the
// taunt is done instead of guessing at a fixed delay.
export function speakTaunt(text, { pitch = 0.85, rate = 1.05 } = {}) {
  if (!text || !window.speechSynthesis) return Promise.resolve();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.pitch = pitch;
    utterance.rate = rate;
    utterance.volume = 0.8;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

export function cancelSpeech() {
  window.speechSynthesis?.cancel();
}
