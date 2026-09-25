// Web Audio API Synthesizer for authentic Two-Way Radio sound effects
// Synthesizes Roger Beeps, Squelch crashes, Key-up chirps, and Error alerts in real time.

class RadioSoundFX {
  constructor() {
    this.ctx = null;
    this.rogerBeepStyle = 'motorola'; // 'motorola', 'quindar', 'cb', 'none'
    this.squelchEnabled = true;
    this.volume = 0.7;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // Key-up chirp when transmitter starts
  playKeyUpChirp() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(850, now);
    osc.frequency.exponentialRampToValueAtTime(1450, now + 0.035);

    gain.gain.setValueAtTime(this.volume * 0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.045);
  }

  // Authentic Roger Beep triggered on unkey
  playRogerBeep() {
    this.ensureContext();
    const now = this.ctx.currentTime;

    switch (this.rogerBeepStyle) {
      case 'motorola':
        // Two-tone Motorola classic beep (1000Hz -> 1800Hz)
        this._playTone(1000, now, 0.06, 0.35);
        this._playTone(1800, now + 0.065, 0.08, 0.35);
        break;

      case 'quindar':
        // NASA Apollo style Quindar unkey tone (2475 Hz)
        this._playTone(2475, now, 0.15, 0.3);
        break;

      case 'cb':
        // Classic CB Radio single beep (1050 Hz)
        this._playTone(1050, now, 0.10, 0.4);
        break;

      case 'none':
      default:
        break;
    }

    if (this.squelchEnabled) {
      // Followed by brief squelch noise burst
      const squelchDelay = (this.rogerBeepStyle === 'none') ? 0.01 : 0.16;
      this.playSquelchTail(now + squelchDelay);
    }
  }

  // Squelch tail white-noise crash burst
  playSquelchTail(startTime) {
    this.ensureContext();
    const now = startTime || this.ctx.currentTime;
    const duration = 0.07; // 70ms burst

    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.5;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    // Bandpass filter to sound like an FM discriminator noise burst
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2200, now);
    filter.Q.setValueAtTime(1.5, now);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(this.volume * 0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(now);
    noise.stop(now + duration);
  }

  // Channel busy / access denied error bonk
  playBusyTone() {
    this.ensureContext();
    const now = this.ctx.currentTime;

    // Dual-tone low buzz (350Hz + 440Hz)
    [350, 440].forEach((freq) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(this.volume * 0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.26);
    });
  }

  // TOT Warning tone
  playTOTTimeout() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      this._playTone(900, now + (i * 0.08), 0.05, 0.4);
    }
  }

  // Emergency Siren / Call Alert Tone
  playCallAlertTone() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1750, now);
    osc.frequency.setValueAtTime(1750, now + 0.5);

    gain.gain.setValueAtTime(this.volume * 0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.6);
  }

  // Sonar / Sub-audible Radio Ping Chirp
  playPingChirp() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1100, now);
    osc.frequency.exponentialRampToValueAtTime(2200, now + 0.08);

    gain.gain.setValueAtTime(this.volume * 0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.13);
  }

  // Scanner step click
  playScanClick() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(2400, now);
    gain.gain.setValueAtTime(this.volume * 0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.025);
  }

  // Scanner signal detected lock chirp
  playScanFound() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    this._playTone(1200, now, 0.05, 0.3);
    this._playTone(1800, now + 0.055, 0.07, 0.35);
  }

  // Tactical incoming text message blip
  playMessageChirp() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    this._playTone(980, now, 0.04, 0.25);
    this._playTone(1480, now + 0.045, 0.06, 0.3);
  }

  // Incoming or outgoing video call chime
  playVideoCallChime() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    this._playTone(523.25, now, 0.10, 0.25);
    this._playTone(659.25, now + 0.11, 0.10, 0.25);
    this._playTone(783.99, now + 0.22, 0.16, 0.30);
  }

  // Video call ended / hang up tone
  playCallEndChime() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    this._playTone(659.25, now, 0.09, 0.25);
    this._playTone(440.00, now + 0.10, 0.14, 0.25);
  }

  // Tactical Radar Sonar / Ping Blip
  playRadarBlip() {
    this.ensureContext();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(2600, now);
    osc.frequency.exponentialRampToValueAtTime(1300, now + 0.07);

    gain.gain.setValueAtTime(this.volume * 0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.095);
  }

  _playTone(freq, start, duration, gainVal) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(this.volume * gainVal, start);
    gain.gain.setValueAtTime(this.volume * gainVal, start + duration - 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(start);
    osc.stop(start + duration + 0.01);
  }
}

window.radioSoundFX = new RadioSoundFX();
