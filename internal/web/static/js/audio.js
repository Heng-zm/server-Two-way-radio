// Ultra-Low Latency PCM Audio Engine & Tactical Radio DSP
// Features:
// - 16kHz 16-bit linear PCM streaming (sub-50ms latency)
// - Sample-accurate Web Audio timeline scheduling (zero clicks, seamless gapless audio)
// - Military/Commercial Radio DSP chain (300Hz-3400Hz bandpass, 2kHz presence boost, compression)
// - Input Noise Gate (Squelch) & Mic Highpass filter
// - Instant Replay AudioBuffer
// - Battery-optimized VU Meter loop

class RadioAudioEngine {
  constructor(socketSender) {
    this.sendPacket = socketSender;
    this.audioCtx = null;
    this.mediaStream = null;

    // Mic capture nodes
    this.micSource = null;
    this.inputHighpass = null;
    this.scriptProcessor = null;
    this.micAnalyser = null;
    this.micDataArray = null;

    // Transmission state
    this.isTransmitting = false;
    this.currentChannel = 1;
    this.seqCounter = 0;
    this.isFirstChunk = true;

    // Resampling state for 16kHz
    this.targetSampleRate = 16000;
    this.packetSampleCount = 640; // 40ms low-latency frames at 16kHz (reduced from 80ms)
    this.pcmBuffer = new Int16Array(this.packetSampleCount);
    this.pcmBufferIndex = 0;

    // Receiver audio DSP & scheduling
    this.dspEnabled = true;
    this.masterGain = null;
    this.dspHighpass = null;
    this.dspLowpass = null;
    this.dspPresence = null;
    this.dspCompressor = null;
    this.rxAnalyser = null;

    // Gapless playback timeline
    this.nextPlayTime = 0;
    this.isPlayingIncoming = false;
    this.replayChunks = [];
    this.lastReplayBuffer = null;

    // Noise gate (Squelch) threshold
    this.squelchThreshold = 0.008;
    this.micGain = 1.0;
    this.micGainNode = null;
    this.onLevelCallback = null;

    // VU meter canvas
    this.vuCanvas = null;
    this.vuCtx = null;
    this.vuLevel = 0;
    this.isVULoopRunning = false;
  }

  ensureContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx({ latencyHint: 'interactive' });
      this._initDSPChain();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  // Tactical Radio DSP chain: 300Hz HPF -> 3400Hz LPF -> 2kHz Presence -> Compressor -> Master Gain
  _initDSPChain() {
    const ctx = this.audioCtx;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.8, ctx.currentTime);

    this.rxAnalyser = ctx.createAnalyser();
    this.rxAnalyser.fftSize = 64;

    this.dspHighpass = ctx.createBiquadFilter();
    this.dspHighpass.type = 'highpass';
    this.dspHighpass.frequency.setValueAtTime(320, ctx.currentTime);
    this.dspHighpass.Q.setValueAtTime(0.7, ctx.currentTime);

    this.dspLowpass = ctx.createBiquadFilter();
    this.dspLowpass.type = 'lowpass';
    this.dspLowpass.frequency.setValueAtTime(3400, ctx.currentTime);
    this.dspLowpass.Q.setValueAtTime(0.7, ctx.currentTime);

    this.dspPresence = ctx.createBiquadFilter();
    this.dspPresence.type = 'peaking';
    this.dspPresence.frequency.setValueAtTime(2000, ctx.currentTime);
    this.dspPresence.gain.setValueAtTime(3.5, ctx.currentTime); // +3.5dB speech punch
    this.dspPresence.Q.setValueAtTime(1.2, ctx.currentTime);

    this.dspCompressor = ctx.createDynamicsCompressor();
    this.dspCompressor.threshold.setValueAtTime(-24, ctx.currentTime);
    this.dspCompressor.knee.setValueAtTime(8, ctx.currentTime);
    this.dspCompressor.ratio.setValueAtTime(6, ctx.currentTime);
    this.dspCompressor.attack.setValueAtTime(0.003, ctx.currentTime);
    this.dspCompressor.release.setValueAtTime(0.12, ctx.currentTime);

    this._updateDSPRouting();
    this.masterGain.connect(ctx.destination);
  }

  setDSPEnabled(enabled) {
    this.dspEnabled = enabled;
    if (this.audioCtx) {
      this._updateDSPRouting();
    }
  }

  _updateDSPRouting() {
    if (!this.audioCtx) return;

    try {
      this.dspHighpass.disconnect();
      this.dspLowpass.disconnect();
      this.dspPresence.disconnect();
      this.dspCompressor.disconnect();
    } catch (e) {
      // ignore
    }

    if (this.dspEnabled) {
      // Full tactical radio chain
      this.dspHighpass.connect(this.dspLowpass);
      this.dspLowpass.connect(this.dspPresence);
      this.dspPresence.connect(this.dspCompressor);
      this.dspCompressor.connect(this.rxAnalyser);
      this.rxAnalyser.connect(this.masterGain);
      this.inputNode = this.dspHighpass;
    } else {
      // Bypass: clean wideband
      this.rxAnalyser.connect(this.masterGain);
      this.inputNode = this.rxAnalyser;
    }
  }

  setVolume(vol) {
    if (this.masterGain && this.audioCtx) {
      this.masterGain.gain.setValueAtTime(vol, this.audioCtx.currentTime);
    }
  }

  setVuCanvas(canvas) {
    this.vuCanvas = canvas;
    if (canvas) {
      this.vuCtx = canvas.getContext('2d');
      this._ensureVULoop();
    }
  }

  // Request Mic & set up low-latency PCM processing
  async requestMic() {
    this.ensureContext();
    if (!this.mediaStream) {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      this.micSource = this.audioCtx.createMediaStreamSource(this.mediaStream);

      // Mic Gain Boost Node (1.0x to 3.0x)
      this.micGainNode = this.audioCtx.createGain();
      this.micGainNode.gain.setValueAtTime(this.micGain, this.audioCtx.currentTime);

      // Low rumble filter for mic
      this.inputHighpass = this.audioCtx.createBiquadFilter();
      this.inputHighpass.type = 'highpass';
      this.inputHighpass.frequency.setValueAtTime(250, this.audioCtx.currentTime);

      this.micAnalyser = this.audioCtx.createAnalyser();
      this.micAnalyser.fftSize = 64;
      this.micDataArray = new Uint8Array(this.micAnalyser.frequencyBinCount);

      // ScriptProcessor for exact 16kHz PCM downsampling (1024 samples = 21.3ms at 48kHz)
      const bufferSize = 1024;
      this.scriptProcessor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);

      this.scriptProcessor.onaudioprocess = (e) => {
        if (!this.isTransmitting) return;

        const inputChannelData = e.inputBuffer.getChannelData(0);
        const inputRate = this.audioCtx.sampleRate;
        const resampleRatio = inputRate / this.targetSampleRate;

        // Compute RMS for Noise Gate / Squelch
        let sumSquares = 0;
        for (let i = 0; i < inputChannelData.length; i++) {
          sumSquares += inputChannelData[i] * inputChannelData[i];
        }
        const rms = Math.sqrt(sumSquares / inputChannelData.length);

        // Resample down to 16kHz and convert to Int16 PCM
        for (let i = 0; i < inputChannelData.length; i += resampleRatio) {
          const sampleIndex = Math.floor(i);
          let sample = (sampleIndex < inputChannelData.length) ? inputChannelData[sampleIndex] : 0;

          // Squelch attenuation if below threshold
          if (rms < this.squelchThreshold) {
            sample *= 0.1;
          }

          // Clamp & convert float [-1.0, 1.0] to 16-bit signed integer [-32768, 32767]
          sample = Math.max(-1.0, Math.min(1.0, sample));
          const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;

          this.pcmBuffer[this.pcmBufferIndex++] = int16;

          // When buffer is full (80ms of audio), send packet
          if (this.pcmBufferIndex >= this.packetSampleCount) {
            this._flushPCMPacket();
          }
        }
      };

      this.micSource.connect(this.micGainNode);
      this.micGainNode.connect(this.inputHighpass);
      this.inputHighpass.connect(this.micAnalyser);
      this.micAnalyser.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioCtx.destination);
    }
  }

  _flushPCMPacket() {
    this.seqCounter++;
    let flags = 0;
    if (this.isFirstChunk) {
      flags |= 0x01; // FlagAudioFirst
      this.isFirstChunk = false;
    }

    const payloadBytes = new Uint8Array(this.pcmBuffer.buffer);
    const packet = this._buildAudioPacket(this.currentChannel, flags, this.seqCounter, payloadBytes);

    if (this.sendPacket) {
      this.sendPacket(packet);
    }

    this.pcmBufferIndex = 0;
  }

  _buildAudioPacket(channelID, flags, seqNum, payloadBytes) {
    const headerSize = 8;
    const packet = new Uint8Array(headerSize + payloadBytes.length);
    packet[0] = 0x52; // 'R'
    packet[1] = 0x41; // 'A'
    packet[2] = channelID & 0xff;
    packet[3] = flags & 0xff;
    packet[4] = (seqNum >> 24) & 0xff;
    packet[5] = (seqNum >> 16) & 0xff;
    packet[6] = (seqNum >> 8) & 0xff;
    packet[7] = seqNum & 0xff;

    packet.set(payloadBytes, headerSize);
    return packet.buffer;
  }

  // Start transmitting audio on granted channel
  async startTransmission(channelID) {
    await this.requestMic();
    this.ensureContext();
    this.currentChannel = channelID;
    this.isTransmitting = true;
    this.isFirstChunk = true;
    this.seqCounter = 0;
    this.pcmBufferIndex = 0;
    this._ensureVULoop();
  }

  // Stop transmitting
  stopTransmission() {
    if (this.isTransmitting && this.pcmBufferIndex > 0) {
      // Flush any trailing samples
      this._flushPCMPacket();
    }
    this.isTransmitting = false;
  }

  // Receiving: start of incoming transmission
  onIncomingStart(callsign) {
    this.ensureContext();
    this.isPlayingIncoming = true;
    this.replayChunks = [];
    this.nextPlayTime = 0; // Reset scheduling timeline
    this._ensureVULoop();
  }

  // Receiving: process incoming 16kHz PCM audio packet
  onIncomingAudioChunk(arrayBuffer) {
    if (arrayBuffer.byteLength <= 8) return;
    this.ensureContext();

    const header = new DataView(arrayBuffer, 0, 8);
    const flags = header.getUint8(3);
    const isFirst = (flags & 0x01) !== 0;

    // Extract Int16 samples (little-endian)
    const pcmByteLength = arrayBuffer.byteLength - 8;
    const sampleCount = pcmByteLength / 2;
    const int16View = new Int16Array(arrayBuffer, 8, sampleCount);

    // Convert to Float32 [-1.0, 1.0]
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      float32[i] = int16View[i] / 32768.0;
    }

    // Save for instant replay
    this.replayChunks.push(float32);

    // Create 16kHz AudioBuffer
    const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, this.targetSampleRate);
    audioBuffer.getChannelData(0).set(float32);

    // Create Source Node and route through DSP chain
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.inputNode);

    // Sample-accurate timeline scheduling with ultra-low latency clamp
    const now = this.audioCtx.currentTime;
    if (isFirst || this.nextPlayTime < now) {
      // Fast jitter buffer of 20ms on burst start (reduced from 35ms)
      this.nextPlayTime = now + 0.020;
    } else {
      // Dynamic anti-lag clamp: prevent audio packet queue from lagging behind
      const maxLeadTime = 0.065; // 65ms max lead time
      if (this.nextPlayTime > now + maxLeadTime) {
        this.nextPlayTime = now + 0.020;
      }
    }

    source.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
  }

  // Receiving: end of incoming transmission
  onIncomingEnd() {
    this.isPlayingIncoming = false;

    // Concatenate replay chunks into one AudioBuffer
    if (this.replayChunks.length > 0) {
      let totalSamples = 0;
      for (let c of this.replayChunks) totalSamples += c.length;

      const merged = this.audioCtx.createBuffer(1, totalSamples, this.targetSampleRate);
      const channel = merged.getChannelData(0);
      let offset = 0;
      for (let c of this.replayChunks) {
        channel.set(c, offset);
        offset += c.length;
      }
      this.lastReplayBuffer = merged;
      this.replayChunks = [];
    }
  }

  // Instant Replay of last transmission
  replayLastTransmission() {
    this.ensureContext();
    if (!this.lastReplayBuffer) {
      return false;
    }

    const source = this.audioCtx.createBufferSource();
    source.buffer = this.lastReplayBuffer;
    source.connect(this.inputNode);
    source.start(this.audioCtx.currentTime);
    return true;
  }

  // Battery-optimized VU Meter Loop
  _ensureVULoop() {
    if (this.isVULoopRunning) return;
    this.isVULoopRunning = true;
    this._runVULoop();
  }

  _runVULoop() {
    if (!this.vuCtx || !this.vuCanvas) {
      this.isVULoopRunning = false;
      return;
    }

    let targetLevel = 0;

    if (this.isTransmitting && this.micAnalyser && this.micDataArray) {
      this.micAnalyser.getByteFrequencyData(this.micDataArray);
      let sum = 0;
      for (let i = 0; i < this.micDataArray.length; i++) {
        sum += this.micDataArray[i];
      }
      targetLevel = (sum / this.micDataArray.length) / 255;
    } else if (this.isPlayingIncoming && this.rxAnalyser) {
      const rxData = new Uint8Array(this.rxAnalyser.frequencyBinCount);
      this.rxAnalyser.getByteFrequencyData(rxData);
      let sum = 0;
      for (let i = 0; i < rxData.length; i++) {
        sum += rxData[i];
      }
      targetLevel = (sum / rxData.length) / 255;
    }

    // Smooth decay
    this.vuLevel = this.vuLevel * 0.72 + targetLevel * 0.28;

    // Phase animation step for organic fluid wave
    this.vuPhase = (this.vuPhase || 0) + 0.14;

    // Notify listeners (e.g. ChatGPT voice orb reactive animator)
    if (this.onLevelCallback) {
      this.onLevelCallback(this.vuLevel);
    }

    // Render Fluid ChatGPT Multi-Wave Visualizer Ribbon
    const ctx = this.vuCtx;
    const width = this.vuCanvas.width;
    const height = this.vuCanvas.height;
    const midY = height / 2;

    ctx.clearRect(0, 0, width, height);

    // Color theme based on radio transmission state
    let primaryColor = 'rgba(255, 255, 255, 0.22)';
    let secondaryColor = 'rgba(255, 255, 255, 0.08)';
    let glowColor = 'transparent';

    if (this.isTransmitting) {
      primaryColor = 'rgba(239, 68, 68, 0.95)';
      secondaryColor = 'rgba(239, 68, 68, 0.35)';
      glowColor = 'rgba(239, 68, 68, 0.6)';
    } else if (this.isPlayingIncoming) {
      primaryColor = 'rgba(16, 163, 127, 0.95)';
      secondaryColor = 'rgba(16, 163, 127, 0.35)';
      glowColor = 'rgba(16, 163, 127, 0.6)';
    }

    const amplitude = Math.max(1, this.vuLevel * (height / 2 - 2));

    // Secondary subtle back wave
    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = secondaryColor;
    for (let x = 0; x <= width; x += 4) {
      const edgeFactor = Math.sin((x / width) * Math.PI);
      const y = midY + Math.sin((x * 0.035) + this.vuPhase * 0.8) * (amplitude * 0.65) * edgeFactor;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Primary bright wave with atmospheric glow
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = primaryColor;
    if (this.vuLevel > 0.04) {
      ctx.shadowBlur = 6;
      ctx.shadowColor = glowColor;
    } else {
      ctx.shadowBlur = 0;
    }

    for (let x = 0; x <= width; x += 3) {
      const edgeFactor = Math.sin((x / width) * Math.PI);
      const y = midY + Math.sin((x * 0.055) - this.vuPhase) * amplitude * edgeFactor;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0; // Reset shadow

    // Throttle rendering when idle to save CPU/battery
    if (!this.isTransmitting && !this.isPlayingIncoming && this.vuLevel < 0.01) {
      this.vuLevel = 0;
      if (this.onLevelCallback) this.onLevelCallback(0);
      this.isVULoopRunning = false;
      return; // Sleep until transmission resumes
    }

    requestAnimationFrame(() => this._runVULoop());
  }

  setLevelListener(callback) {
    this.onLevelCallback = callback;
  }

  setMicGain(gain) {
    this.micGain = Math.max(0.5, Math.min(3.5, gain));
    if (this.micGainNode && this.audioCtx) {
      this.micGainNode.gain.setValueAtTime(this.micGain, this.audioCtx.currentTime);
    }
  }

  setNoiseGateThreshold(threshold) {
    this.squelchThreshold = Math.max(0.0001, Math.min(0.05, threshold));
  }
}
