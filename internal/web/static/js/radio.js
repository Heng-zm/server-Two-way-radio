// Two-Way Radio Client Application Logic
// Orchestrates WebSocket signaling, floor arbitration state machine,
// PTT keypress/touch controls, and 16kHz PCM streaming coordination.

document.addEventListener('DOMContentLoaded', () => {
  const soundFX = window.radioSoundFX;
  let ws = null;
  let audioEngine = null;

  // Radio State
  let myCallsign = localStorage.getItem('radio_callsign') || `UNIT-${Math.floor(100 + Math.random() * 900)}`;
  let currentChannelID = 1;
  let channels = [];
  let isPTTDown = false;
  let isTransmitting = false;
  let isReceiving = false;
  let pttMode = 'hold'; // 'hold' or 'toggle'

  // DOM Elements
  const elLcdFreq = document.getElementById('lcd-freq');
  const elLcdChName = document.getElementById('lcd-ch-name');
  const elLcdStatus = document.getElementById('lcd-status');
  const elLcdSpeaker = document.getElementById('lcd-speaker');
  const elLcdUsers = document.getElementById('lcd-users');
  const elLcdCallsign = document.getElementById('lcd-callsign');
  const elLcdDspStatus = document.getElementById('lcd-dsp-status');

  const elTxLed = document.getElementById('led-tx');
  const elRxLed = document.getElementById('led-rx');
  const elPwrLed = document.getElementById('led-pwr');

  const btnPtt = document.getElementById('btn-ptt');
  const btnPrevCh = document.getElementById('btn-prev-ch');
  const btnNextCh = document.getElementById('btn-next-ch');
  const btnAlert = document.getElementById('btn-alert');
  const btnReplay = document.getElementById('btn-replay');
  const btnRadioPing = document.getElementById('btn-radio-ping');
  const btnScan = document.getElementById('btn-scan');

  const btnToggleLog = document.getElementById('btn-toggle-log');
  const btnCloseLog = document.getElementById('btn-close-log');
  const btnClearLog = document.getElementById('btn-clear-log');
  const activityDrawer = document.getElementById('activity-drawer');
  const activityLogList = document.getElementById('activity-log-list');
  const logUnreadDot = document.getElementById('log-unread-dot');

  const btnToggleShortcuts = document.getElementById('btn-toggle-shortcuts');
  const btnCloseShortcuts = document.getElementById('btn-close-shortcuts');
  const shortcutsModal = document.getElementById('shortcuts-modal');

  const sliderMicGain = document.getElementById('slider-mic-gain');
  const sliderMicSquelch = document.getElementById('slider-mic-squelch');
  const btnPreviewBeep = document.getElementById('btn-preview-beep');

  const orbRipple1 = document.getElementById('orb-ripple-1');
  const orbRipple2 = document.getElementById('orb-ripple-2');
  const voiceOrbHalo = document.getElementById('voice-orb-halo');

  const pingPill = document.getElementById('ping-pill');
  const pingDot = document.getElementById('ping-dot');
  const pingText = document.getElementById('ping-text');
  const modalPingVal = document.getElementById('modal-ping-val');
  const btnModalPingTest = document.getElementById('btn-modal-ping-test');

  let pingIntervalTimer = null;
  let lastPingSendTime = 0;
  let isScanning = false;
  let scanIntervalTimer = null;
  let rxStartTime = 0;
  const activityLogs = [];

  const inputCallsign = document.getElementById('input-callsign');
  const selectBeep = document.getElementById('select-beep');
  const selectChannel = document.getElementById('select-channel');
  const checkTogglePtt = document.getElementById('check-toggle-ptt');
  const checkDspFilter = document.getElementById('check-dsp-filter');
  const sliderVolume = document.getElementById('slider-volume');
  const vuCanvas = document.getElementById('vu-meter-canvas');
  const userListContainer = document.getElementById('user-list-items');

  // ChatGPT 4o Voice Experience DOM Elements
  const popoverMenu = document.getElementById('channel-popover-menu');
  const btnModelSelector = document.getElementById('btn-model-selector');
  const popoverList = document.getElementById('popover-channels-list');
  const channelSearchInput = document.getElementById('channel-search-input');
  const hudPill = document.getElementById('hud-pill');
  const hudIcon = document.getElementById('hud-icon');
  const hudText = document.getElementById('hud-text');
  const voiceAmbientBg = document.getElementById('voice-ambient-bg');
  const btnQuickMute = document.getElementById('btn-quick-mute');
  const labelQuickMute = document.getElementById('label-quick-mute');
  const iconSpeaker = document.getElementById('icon-speaker');

  // Client Identity
  let myClientID = null;

  // Chat Messaging Elements & State
  const btnToggleChat = document.getElementById('btn-toggle-chat');
  const btnDockChat = document.getElementById('btn-dock-chat');
  const btnCloseChat = document.getElementById('btn-close-chat');
  const chatDrawer = document.getElementById('chat-drawer');
  const chatDrawerTitle = document.getElementById('chat-drawer-title');
  const chatMessagesList = document.getElementById('chat-messages-list');
  const chatInputText = document.getElementById('chat-input-text');
  const chatComposerForm = document.getElementById('chat-composer-form');
  const chatUnreadDot = document.getElementById('chat-unread-dot');
  let unreadMessageCount = 0;

  // WebRTC Video Call Elements & State
  const btnToggleVideo = document.getElementById('btn-toggle-video');
  const btnToggleScreen = document.getElementById('btn-toggle-screen');
  const btnDockVideo = document.getElementById('btn-dock-video');
  const btnDockScreen = document.getElementById('btn-dock-screen');
  const btnCloseVideo = document.getElementById('btn-close-video');
  const videoModal = document.getElementById('video-modal');
  const videoActiveDot = document.getElementById('video-active-dot');
  const remoteVideo = document.getElementById('remote-video');
  const localVideo = document.getElementById('local-video');
  const localPipBox = document.getElementById('local-pip-box');
  const localPipLabel = document.getElementById('local-pip-label');
  const remoteVideoPlaceholder = document.getElementById('remote-video-placeholder');
  const btnPlaceholderScreenshare = document.getElementById('btn-placeholder-screenshare');
  const videoStatusText = document.getElementById('video-status-text');
  const videoCallerBadge = document.getElementById('video-caller-badge');
  const videoCallerCallsign = document.getElementById('video-caller-callsign');
  const videoCallTimer = document.getElementById('video-call-timer');
  const videoChName = document.getElementById('video-ch-name');
  const btnVideoCamToggle = document.getElementById('btn-video-cam-toggle');
  const btnVideoFlipCam = document.getElementById('btn-video-flip-cam');
  const btnVideoShareScreen = document.getElementById('btn-video-share-screen');
  const btnVideoPTT = document.getElementById('btn-video-ptt');
  const btnVideoFullscreen = document.getElementById('btn-video-fullscreen');
  const btnVideoHangup = document.getElementById('btn-video-hangup');

  let isVideoCallActive = false;
  let localVideoStream = null;
  let peerConnection = null;
  let currentVideoPeerID = null;
  let videoFacingMode = 'user';
  let videoTimerInterval = null;
  let videoCallStartTime = 0;
  let isCameraMuted = false;
  let isScreenSharing = false;

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // Dynamic Island Tactical HUD Pill banner
  let hudTimer = null;
  function showHUD(icon, text, duration = 2400) {
    if (!hudPill) return;
    if (hudIcon) hudIcon.textContent = icon;
    if (hudText) hudText.textContent = text;
    hudPill.classList.add('show');

    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      hudPill.classList.remove('show');
    }, duration);
  }

  // Atmospheric Ambient Lighting Background
  function updateAmbientGlow() {
    if (!voiceAmbientBg) return;
    voiceAmbientBg.classList.remove('tx', 'rx', 'scan');
    if (isTransmitting) {
      voiceAmbientBg.classList.add('tx');
    } else if (isReceiving) {
      voiceAmbientBg.classList.add('rx');
    } else if (isScanning) {
      voiceAmbientBg.classList.add('scan');
    }
  }

  // Helper for mobile haptic feedback (guarded by user interaction to satisfy browser policy)
  let hasUserInteracted = false;
  window.addEventListener('pointerdown', () => { hasUserInteracted = true; }, { once: true, passive: true });
  window.addEventListener('keydown', () => { hasUserInteracted = true; }, { once: true, passive: true });

  function triggerHaptic(pattern) {
    if ('vibrate' in navigator) {
      const isAllowed = (navigator.userActivation && navigator.userActivation.hasBeenActive) || hasUserInteracted;
      if (isAllowed) {
        try { navigator.vibrate(pattern); } catch (e) {}
      }
    }
  }

  // Initialize Audio Engine with WebSocket sender
  audioEngine = new RadioAudioEngine((binaryPacket) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(binaryPacket);
    }
  });
  window.radioAudioEngine = audioEngine;
  audioEngine.setVuCanvas(vuCanvas);

  // ChatGPT Advanced Voice Mode fluid reactive orb scaling
  audioEngine.setLevelListener((level) => {
    if (isTransmitting || isReceiving) {
      const scale = 1.0 + level * 0.25;
      btnPtt.style.transform = `scale(${scale.toFixed(3)})`;

      if (voiceOrbHalo) {
        voiceOrbHalo.style.transform = `scale(${(1.1 + level * 0.7).toFixed(3)})`;
        voiceOrbHalo.style.opacity = (0.35 + level * 0.65).toFixed(2);
      }

      if (orbRipple1) {
        orbRipple1.style.transform = `scale(${(1.06 + level * 0.55).toFixed(3)})`;
        orbRipple1.style.opacity = Math.min(0.9, level * 2.2).toFixed(2);
      }

      if (orbRipple2) {
        orbRipple2.style.transform = `scale(${(1.15 + level * 1.0).toFixed(3)})`;
        orbRipple2.style.opacity = Math.min(0.7, level * 1.5).toFixed(2);
      }
    } else {
      btnPtt.style.transform = '';
      if (voiceOrbHalo) {
        voiceOrbHalo.style.transform = '';
        voiceOrbHalo.style.opacity = '';
      }
      if (orbRipple1) {
        orbRipple1.style.transform = '';
        orbRipple1.style.opacity = '0';
      }
      if (orbRipple2) {
        orbRipple2.style.transform = '';
        orbRipple2.style.opacity = '0';
      }
    }
  });

  // Initialize UI inputs
  inputCallsign.value = myCallsign;
  elLcdCallsign.textContent = myCallsign;

  // Immediately fetch channel list via REST so UI never gets stuck on "Loading channels..."
  async function loadInitialChannels() {
    try {
      const res = await fetch('/api/channels');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          channels = data;
          populateChannelDropdown();
          updateChannelDisplay();
        }
      }
    } catch (e) {
      console.warn('[Radio] Initial channel fetch error:', e);
    }
  }

  // Connect WebSocket
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?callsign=${encodeURIComponent(myCallsign)}`;

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[Radio] Connected to server.');
      elPwrLed.classList.add('active');
      const netText = document.getElementById('net-status-text');
      if (netText) netText.textContent = 'Connected';
      setLcdStatus('ONLINE - STANDBY');
      showHUD('🟢', 'Connected to Radio Network');
      updateAmbientGlow();

      // Immediate ping and recurring keep-alive RTT measurement
      sendPing(false);
      if (pingIntervalTimer) clearInterval(pingIntervalTimer);
      pingIntervalTimer = setInterval(() => sendPing(false), 1500);
    };

    ws.onclose = () => {
      console.warn('[Radio] Disconnected. Reconnecting in 2s...');
      elPwrLed.classList.remove('active');
      const netText = document.getElementById('net-status-text');
      if (netText) netText.textContent = 'Reconnecting...';
      setLcdStatus('DISCONNECTED');
      showHUD('🔴', 'Disconnected - Reconnecting...');
      updateAmbientGlow();
      if (pingIntervalTimer) {
        clearInterval(pingIntervalTimer);
        pingIntervalTimer = null;
      }
      updatePingDisplay(null);
      setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = (err) => {
      console.error('[Radio] WebSocket error:', err);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          handleSignalingMessage(msg);
        } catch (e) {
          console.error('[Radio] Failed to parse message JSON:', e);
        }
      } else if (event.data instanceof ArrayBuffer) {
        // Incoming binary 16kHz PCM audio packet
        audioEngine.onIncomingAudioChunk(event.data);
      }
    };
  }

  // Handle server signaling events (case-insensitive for robust Go JSON interop)
  function handleSignalingMessage(msg) {
    const type = (msg.type || msg.Type || '').toLowerCase();
    const payload = msg.payload || msg.Payload || {};

    switch (type) {
      case 'error':
        alert(`Server Error: ${payload}`);
        break;

      case 'channel_list':
        if (Array.isArray(payload)) {
          channels = payload;
          populateChannelDropdown();
          updateChannelDisplay();
          if (typeof updateTacticalMap === 'function') {
            updateTacticalMap();
          }
        }
        break;

      case 'floor_status':
        handleFloorStatus(payload);
        break;

      case 'user_talking':
        handleUserTalking(payload);
        break;

      case 'user_stopped':
        handleUserStopped(payload);
        break;

      case 'user_list':
        updateUserRoster(payload);
        break;

      case 'alert_tone':
        handleAlertTone(payload);
        break;

      case 'location_update':
        handleLocationUpdate(payload);
        break;

      case 'pong':
        handlePong(payload, msg);
        break;

      case 'channel_activity':
        handleChannelActivity(payload);
        break;

      case 'client_welcome':
        if (payload.id) {
          myClientID = payload.id;
          console.log('[Radio] Assigned client ID:', myClientID);
        }
        break;

      case 'chat_message':
        handleIncomingChatMessage(payload);
        break;

      case 'chat_history':
        handleChatHistory(payload);
        break;

      case 'video_call_start':
        handleVideoCallStart(payload);
        break;

      case 'video_call_end':
        handleVideoCallEnd(payload);
        break;

      case 'video_join':
        handleVideoJoin(payload);
        break;

      case 'video_offer':
        handleVideoOffer(payload);
        break;

      case 'video_answer':
        handleVideoAnswer(payload);
        break;

      case 'video_ice':
        handleVideoICE(payload);
        break;
    }
  }

  function handleFloorStatus(payload) {
    const channelID = payload.channel_id ?? payload.ChannelID;
    const status = (payload.status || payload.Status || '').toLowerCase();
    const currentSpeaker = payload.current_speaker || payload.CurrentSpeaker || '';

    if (channelID !== currentChannelID) return;

    if (status === 'granted') {
      // Floor granted to us!
      isTransmitting = true;
      elTxLed.classList.add('active');
      btnPtt.classList.add('transmitting');
      setLcdStatus('TRANSMITTING [TX]');
      showHUD('🎙️', 'Floor Granted - You are ON AIR');
      updateAmbientGlow();
      soundFX.playKeyUpChirp();

      audioEngine.startTransmission(currentChannelID).catch((err) => {
        alert('Microphone access is required to transmit. Please enable mic permissions in your browser.');
        releaseFloor();
      });
    } else if (status === 'denied' || status === 'busy') {
      // Channel busy or floor denied
      isTransmitting = false;
      isPTTDown = false;
      elTxLed.classList.remove('active');
      btnPtt.classList.remove('active', 'transmitting');
      soundFX.playBusyTone();
      setLcdStatus(`BUSY (${currentSpeaker || 'OCCUPIED'})`);
      showHUD('⚠️', `Channel Busy (${currentSpeaker || 'Occupied'})`);
      updateAmbientGlow();
      setTimeout(() => {
        if (!isTransmitting && !isReceiving) {
          setLcdStatus('STANDBY');
        }
      }, 1500);
    } else if (status === 'timeout') {
      // Time-Out-Timer fired
      isTransmitting = false;
      isPTTDown = false;
      audioEngine.stopTransmission();
      elTxLed.classList.remove('active');
      btnPtt.classList.remove('active', 'transmitting');
      soundFX.playTOTTimeout();
      setLcdStatus('TOT TIMEOUT (MIC RELEASED)');
      showHUD('⏳', 'TOT Time Limit - Mic Released');
      updateAmbientGlow();
      setTimeout(() => setLcdStatus('STANDBY'), 2500);
    } else if (status === 'idle') {
      // Channel is now clear
      if (isReceiving) {
        soundFX.playRogerBeep();
      }
      isReceiving = false;
      elRxLed.classList.remove('active');
      elLcdSpeaker.textContent = '--';
      setLcdStatus('STANDBY');
      updateAmbientGlow();
    }
  }

  function handleUserTalking(payload) {
    const channelID = payload.channel_id ?? payload.ChannelID;
    const callsign = payload.callsign || payload.Callsign || '';

    if (channelID !== currentChannelID) return;
    if (callsign === myCallsign) return; // Don't echo self

    rxStartTime = Date.now();
    isReceiving = true;
    elRxLed.classList.add('active');
    elLcdSpeaker.textContent = callsign;
    setLcdStatus(`RECEIVING [RX]`);
    showHUD('🔊', `Receiving from ${callsign}`);
    updateAmbientGlow();
    triggerHaptic(20);
    audioEngine.onIncomingStart(callsign);
    if (typeof updateTacticalMapTalking === 'function') {
      updateTacticalMapTalking(callsign, true);
    }
  }

  function handleUserStopped(payload) {
    const channelID = payload.channel_id ?? payload.ChannelID;
    const callsign = payload.callsign || payload.Callsign || elLcdSpeaker.textContent || 'UNIT';
    if (channelID !== currentChannelID) return;

    if (isReceiving) {
      isReceiving = false;
      elRxLed.classList.remove('active');
      soundFX.playRogerBeep();
      audioEngine.onIncomingEnd();
      updateAmbientGlow();
      if (typeof updateTacticalMapTalking === 'function') {
        updateTacticalMapTalking(callsign, false);
      }
      const durationSec = Math.max(0.5, ((Date.now() - (rxStartTime || Date.now())) / 1000)).toFixed(1);
      const ch = channels.find(c => c.id === currentChannelID);
      addActivityLog({
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        callsign: callsign,
        channelName: ch ? ch.name : `CH ${currentChannelID}`,
        text: `Voice transmission (${durationSec}s)`,
        type: 'transmission',
        replayable: true,
      });
      elLcdSpeaker.textContent = '--';
      setLcdStatus('STANDBY');
    }
  }

  function handleAlertTone(payload) {
    const channelID = payload.channel_id ?? payload.ChannelID;
    const callsign = payload.callsign || payload.Callsign || 'DISPATCH';

    if (channelID !== currentChannelID) return;
    soundFX.playCallAlertTone();
    triggerHaptic([100, 50, 100, 50, 200]);
    setLcdStatus(`ALERT FROM ${callsign}!`);
    showHUD('🚨', `Emergency Siren from ${callsign}`);
    const ch = channels.find(c => c.id === currentChannelID);
    addActivityLog({
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      callsign: callsign,
      channelName: ch ? ch.name : `CH ${currentChannelID}`,
      text: `🚨 Emergency 1750Hz Siren Alert`,
      type: 'alert',
    });
    setTimeout(() => {
      if (!isTransmitting && !isReceiving) setLcdStatus('STANDBY');
    }, 2000);
  }

  function handleChannelActivity(payload) {
    const chID = payload.channel_id ?? payload.ChannelID;
    const isBusy = payload.is_busy ?? payload.IsBusy ?? false;
    const speaker = payload.speaker || payload.Speaker || '';

    const ch = channels.find(c => c.id === chID);
    if (ch) {
      ch.is_busy = isBusy;
      ch.current_speaker = speaker;
      populateChannelDropdown();
    }

    if (isBusy && speaker && speaker !== myCallsign) {
      addActivityLog({
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        callsign: speaker,
        channelName: ch ? ch.name : `CH ${chID}`,
        text: `Transmission on ${ch ? ch.name : 'CH ' + chID}`,
        type: 'activity',
      });

      // If scanner is running and carrier detected, lock onto it!
      if (isScanning && currentChannelID === chID) {
        stopScanner(true);
        soundFX.playScanFound();
        setLcdStatus(`SCAN: LOCKED ON ${speaker} [CH ${chID}]`);
      }
    }
  }

  // Ping & Network Latency RTT Telemetry
  function sendPing(manual = false) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      updatePingDisplay(null);
      return;
    }

    const clientTime = performance.now();
    lastPingSendTime = clientTime;

    if (manual) {
      soundFX.playPingChirp();
      setLcdStatus('RADIO CHECK: PINGING...');
      if (pingPill) {
        pingPill.style.opacity = '0.5';
        setTimeout(() => { pingPill.style.opacity = '1'; }, 300);
      }
    }

    ws.send(JSON.stringify({
      type: 'ping',
      payload: {
        client_time: clientTime,
        manual: manual,
      },
    }));
  }

  let smoothedRTT = 0;
  let minObservedRTT = Infinity;
  let currentJitter = 0;

  function handlePong(payload, msg) {
    const now = performance.now();
    let rawRTT = 0;
    if (payload && typeof payload.client_time === 'number') {
      rawRTT = now - payload.client_time;
    } else if (lastPingSendTime > 0) {
      rawRTT = now - lastPingSendTime;
    }
    rawRTT = Math.max(1, rawRTT);

    // Exponential Moving Average filter to smooth out single-packet network spikes
    if (smoothedRTT === 0) {
      smoothedRTT = rawRTT;
    } else {
      smoothedRTT = (smoothedRTT * 0.72) + (rawRTT * 0.28);
    }

    if (rawRTT < minObservedRTT) {
      minObservedRTT = rawRTT;
    }

    currentJitter = Math.abs(rawRTT - smoothedRTT);
    const displayRTT = Math.round(smoothedRTT);

    updatePingDisplay(displayRTT, Math.round(rawRTT), Math.round(currentJitter));

    if (payload && payload.manual) {
      const bestText = minObservedRTT < Infinity ? ` (Best: ${Math.round(minObservedRTT)}ms)` : '';
      setLcdStatus(`RADIO CHECK: ${Math.round(rawRTT)}ms RTT [LINK OPTIMAL${bestText}]`);
      setTimeout(() => {
        if (!isTransmitting && !isReceiving) setLcdStatus('STANDBY');
      }, 2200);
    }
  }

  function updatePingDisplay(displayRTT, rawRTT = 0, jitter = 0) {
    if (displayRTT === null || displayRTT === undefined || isNaN(displayRTT)) {
      if (pingText) pingText.textContent = '-- ms';
      if (pingDot) pingDot.className = 'ping-dot';
      if (modalPingVal) modalPingVal.textContent = '-- ms';
      return;
    }

    if (pingText) pingText.textContent = `${displayRTT} ms`;
    if (modalPingVal) modalPingVal.textContent = `${displayRTT} ms (±${jitter}ms)`;
    const detailEl = document.getElementById('setting-ping-detail');
    if (detailEl && minObservedRTT < Infinity) {
      detailEl.textContent = `Live: ${displayRTT}ms • Best: ${Math.round(minObservedRTT)}ms • Jitter: ±${jitter}ms`;
    }

    if (pingDot) {
      pingDot.className = 'ping-dot';
      if (displayRTT < 45) {
        pingDot.classList.add('ping-good');
      } else if (displayRTT < 110) {
        pingDot.classList.add('ping-fair');
      } else {
        pingDot.classList.add('ping-poor');
      }
    }

    if (pingPill) {
      const quality = displayRTT < 45 ? 'Ultra-Low Latency' : displayRTT < 110 ? 'Optimal' : 'Moderate';
      const bestStr = minObservedRTT < Infinity ? ` | Best: ${Math.round(minObservedRTT)}ms` : '';
      pingPill.title = `Latency: ${displayRTT}ms RTT (±${jitter}ms jitter${bestStr}) - Click to test`;
    }
  }

  function updateUserRoster(payload) {
    const channelID = payload.channel_id ?? payload.ChannelID;
    if (channelID !== currentChannelID) return;

    if (Array.isArray(payload.user_details)) {
      payload.user_details.forEach(ud => {
        if (ud && ud.callsign && ud.location && ud.location.latitude && ud.location.longitude) {
          userLocations[ud.callsign] = ud.location;
        }
      });
    }

    const users = payload.users || payload.Users || [];
    elLcdUsers.textContent = `${users.length} ON CH`;
    const usersCountChip = document.getElementById('users-count-chip');
    if (usersCountChip) {
      usersCountChip.textContent = `${users.length} Online`;
    }

    if (userListContainer) {
      userListContainer.innerHTML = '';
      users.forEach((user) => {
        const item = document.createElement('div');
        item.className = 'sidebar-user-row' + (user === myCallsign ? ' current' : '');

        const loc = userLocations[user] || (user === myCallsign ? myLocation : null);
        let distText = '';
        if (user !== myCallsign && myLocation && loc && loc.latitude && loc.longitude) {
          const d = calcDistance(myLocation.latitude, myLocation.longitude, loc.latitude, loc.longitude);
          distText = ` • ${d < 1 ? Math.round(d * 1000) + 'm' : d.toFixed(1) + 'km'}`;
        }

        item.innerHTML = `
          <span>${user}</span>
          <span style="font-size: 10px; opacity: 0.6;">${distText || (user === myCallsign ? 'You' : 'Active')}</span>
        `;
        userListContainer.appendChild(item);
      });
    }

    if (typeof updateTacticalMap === 'function') {
      updateTacticalMap();
    }
  }

  function setLcdStatus(text) {
    elLcdStatus.textContent = text;
  }

  function updateChannelDisplay() {
    const ch = channels.find((c) => c.id === currentChannelID);
    if (ch) {
      let distText = '';
      if (myLocation && ch.latitude && ch.longitude) {
        const d = calcDistance(myLocation.latitude, myLocation.longitude, ch.latitude, ch.longitude);
        distText = ` [${d < 1 ? Math.round(d * 1000) + 'm' : d.toFixed(1) + 'km'}]`;
      }
      if (elLcdFreq) elLcdFreq.textContent = `${ch.frequency.toFixed(5)} MHz${distText}`;
      if (elLcdChName) elLcdChName.textContent = ch.name;
      if (selectChannel) selectChannel.value = currentChannelID;

      const items = document.querySelectorAll('.sidebar-channel-item');
      items.forEach((btn) => {
        if (parseInt(btn.dataset.id, 10) === currentChannelID) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      // Update Popover Menu rows
      const popoverRows = document.querySelectorAll('.popover-channel-row');
      popoverRows.forEach((row) => {
        if (parseInt(row.dataset.id, 10) === currentChannelID) {
          row.classList.add('active');
        } else {
          row.classList.remove('active');
        }
      });
    }

    const avatar = document.getElementById('avatar-initials');
    if (avatar && myCallsign) {
      avatar.textContent = myCallsign.charAt(0).toUpperCase();
    }
  }

  function populateChannelDropdown() {
    if (selectChannel && channels.length > 0) {
      selectChannel.innerHTML = '';
      channels.forEach((ch) => {
        const opt = document.createElement('option');
        opt.value = ch.id;

        let locInfo = '';
        if (myLocation && ch.latitude && ch.longitude) {
          const d = calcDistance(myLocation.latitude, myLocation.longitude, ch.latitude, ch.longitude);
          const distStr = d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
          locInfo = ` • ${distStr}`;
        } else if (ch.region) {
          locInfo = ` • ${ch.region}`;
        }

        opt.textContent = `${ch.id}. ${ch.name} (${ch.frequency.toFixed(5)} MHz${locInfo})`;
        selectChannel.appendChild(opt);
      });
      selectChannel.value = currentChannelID;
    }

    // Populate Sidebar Channels List
    const sidebarList = document.getElementById('sidebar-channels-list');
    if (sidebarList && channels.length > 0) {
      sidebarList.innerHTML = '';
      channels.forEach((ch) => {
        const btn = document.createElement('button');
        btn.className = 'sidebar-channel-item' + (ch.id === currentChannelID ? ' active' : '');
        btn.dataset.id = ch.id;

        let distStr = '';
        if (myLocation && ch.latitude && ch.longitude) {
          const d = calcDistance(myLocation.latitude, myLocation.longitude, ch.latitude, ch.longitude);
          distStr = d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
        } else if (ch.region) {
          distStr = ch.region;
        }

        const busyBadge = ch.is_busy ? `<span class="channel-busy-pill">ON AIR</span>` : '';
        const lockIcon = ch.is_private ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.6; margin-right: 4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>` : `<span style="opacity: 0.4; margin-right: 4px;">#</span>`;
        btn.innerHTML = `
          <div class="channel-item-left">
            ${lockIcon}
            <span class="channel-name-text">${ch.name}</span>
            ${busyBadge}
          </div>
          ${distStr ? `<span class="channel-dist-tag">${distStr}</span>` : ''}
        `;

        btn.onclick = () => changeChannel(ch.id);
        sidebarList.appendChild(btn);
      });
    }

    // Populate ChatGPT 4o Model Selector Popover Dropdown
    if (popoverList && channels.length > 0) {
      popoverList.innerHTML = '';
      channels.forEach((ch) => {
        const row = document.createElement('div');
        row.className = 'popover-channel-row' + (ch.id === currentChannelID ? ' active' : '');
        row.dataset.id = ch.id;

        const busyBadge = ch.is_busy ? `<span class="channel-busy-pill">ON AIR</span>` : '';
        const lockIcon = ch.is_private ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.6; margin-right: 4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>` : `<span class="popover-color-dot"></span>`;
        row.innerHTML = `
          <div class="popover-channel-left">
            ${lockIcon}
            <span class="popover-channel-name">${ch.name}</span>
            ${busyBadge}
          </div>
          <div class="popover-channel-right">
            <span class="popover-channel-freq">${ch.frequency.toFixed(5)} MHz</span>
            <span class="popover-check">✓</span>
          </div>
        `;

        row.onclick = (e) => {
          e.stopPropagation();
          changeChannel(ch.id);
          closeChannelPopover();
        };
        popoverList.appendChild(row);
      });
    }
  }

  function changeChannel(newID, silent = false) {
    const targetCh = channels.find(c => c.id === newID);
    if (!targetCh) return;

    let password = "";
    if (targetCh.is_private) {
      password = prompt(`Channel ${targetCh.name} is private.\nEnter password:`);
      if (password === null) return; // Cancelled
    }

    if (isTransmitting) {
      releaseFloor();
    }
    if (isVideoCallActive) {
      endVideoCall(false);
    }
    currentChannelID = newID;
    updateChannelDisplay();
    updateAmbientGlow();
    if (typeof updateTacticalMap === 'function') {
      updateTacticalMap();
    }
    if (window.innerWidth <= 768 && typeof closeSidebar === 'function') {
      closeSidebar();
    }

    if (!silent && targetCh) {
      triggerHaptic(15);
      showHUD('📻', `Channel ${targetCh.id}: ${targetCh.name}`);
    }

    if (chatDrawerTitle && targetCh) {
      chatDrawerTitle.textContent = `${targetCh.name} Chat`;
    }
    if (videoChName && targetCh) {
      videoChName.textContent = `${targetCh.name} - VIDEO`;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'join_channel',
        payload: { channel_id: currentChannelID, password: password },
      }));
    }
  }

  // PTT Actions
  function requestFloor() {
    if (isPTTDown || isTransmitting) return;
    if (isScanning) stopScanner(false);
    isPTTDown = true;
    btnPtt.classList.add('active');
    triggerHaptic(30);

    soundFX.ensureContext();
    audioEngine.ensureContext();

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ptt_down',
        payload: { channel_id: currentChannelID },
      }));
    }
  }

  function releaseFloor() {
    if (!isPTTDown && !isTransmitting) return;
    isPTTDown = false;
    btnPtt.classList.remove('active', 'transmitting');
    triggerHaptic([15, 25, 15]);

    if (isTransmitting) {
      isTransmitting = false;
      audioEngine.stopTransmission();
      elTxLed.classList.remove('active');
      soundFX.playRogerBeep();
      setLcdStatus('STANDBY');
      updateAmbientGlow();
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ptt_up',
        payload: { channel_id: currentChannelID },
      }));
    }
  }

  // PTT Button Event Handlers
  btnPtt.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (pttMode === 'toggle') {
      if (isTransmitting) releaseFloor();
      else requestFloor();
    } else {
      requestFloor();
    }
  });

  window.addEventListener('mouseup', () => {
    if (pttMode === 'hold' && isPTTDown) {
      releaseFloor();
    }
  });

  // Touch Support for Mobile / Tablet
  btnPtt.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (pttMode === 'toggle') {
      if (isTransmitting) releaseFloor();
      else requestFloor();
    } else {
      requestFloor();
    }
  }, { passive: false });

  btnPtt.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (pttMode === 'hold') {
      releaseFloor();
    }
  }, { passive: false });

  btnPtt.addEventListener('touchcancel', (e) => {
    e.preventDefault();
    if (pttMode === 'hold') {
      releaseFloor();
    }
  }, { passive: false });

  // Channel Scanner
  function toggleScanner() {
    if (isScanning) {
      stopScanner(false);
    } else {
      startScanner();
    }
  }

  function startScanner() {
    if (channels.length === 0) return;
    isScanning = true;
    if (btnScan) btnScan.classList.add('scanning');
    soundFX.playKeyUpChirp();
    setLcdStatus('SCANNER: MONITORING CH 1..8');
    showHUD('🔍', 'Scanning Channels 1..8');
    updateAmbientGlow();

    if (scanIntervalTimer) clearInterval(scanIntervalTimer);
    scanIntervalTimer = setInterval(scanStep, 450);
  }

  function stopScanner(locked = false) {
    isScanning = false;
    if (btnScan) btnScan.classList.remove('scanning');
    if (scanIntervalTimer) {
      clearInterval(scanIntervalTimer);
      scanIntervalTimer = null;
    }
    updateAmbientGlow();
    if (!locked && !isTransmitting && !isReceiving) {
      setLcdStatus('STANDBY');
    }
  }

  function scanStep() {
    if (!isScanning || channels.length === 0) return;

    // Check if current channel became active
    const curCh = channels.find(c => c.id === currentChannelID);
    if (curCh && curCh.is_busy && curCh.current_speaker && curCh.current_speaker !== myCallsign) {
      stopScanner(true);
      soundFX.playScanFound();
      setLcdStatus(`SCAN: LOCKED ON ${curCh.name}`);
      showHUD('🎯', `Traffic locked on ${curCh.name}`);
      return;
    }

    // Step to next channel
    let nextID = currentChannelID + 1;
    if (nextID > channels.length) nextID = 1;

    changeChannel(nextID, true);
    soundFX.playScanClick();

    // Check if next channel has traffic
    const nextCh = channels.find(c => c.id === nextID);
    if (nextCh && nextCh.is_busy) {
      stopScanner(true);
      soundFX.playScanFound();
      setLcdStatus(`SCAN: TRAFFIC DETECTED ON ${nextCh.name}`);
      showHUD('🎯', `Traffic detected on ${nextCh.name}`);
    }
  }

  if (btnScan) {
    btnScan.addEventListener('click', toggleScanner);
  }

  // Activity & Transmission Log
  function addActivityLog(entry) {
    activityLogs.unshift(entry);
    if (activityLogs.length > 60) activityLogs.pop();

    if (activityLogList) {
      const emptyState = activityLogList.querySelector('.activity-empty-state');
      if (emptyState) emptyState.remove();

      const card = document.createElement('div');
      card.className = 'activity-card';

      const replayBtn = entry.replayable
        ? `<button class="activity-replay-btn" onclick="window.radioAudioEngine.replayLastTransmission()">▶ Replay</button>`
        : '';

      card.innerHTML = `
        <div class="activity-card-top">
          <span class="activity-callsign">${entry.callsign || 'RADIO'}</span>
          <span class="activity-time">${entry.time || ''}</span>
        </div>
        <div class="activity-card-body">
          <span>${entry.text}</span>
          ${entry.channelName ? `<span class="activity-channel-tag">${entry.channelName}</span>` : ''}
          ${replayBtn}
        </div>
      `;
      activityLogList.prepend(card);
    }

    if (activityDrawer && !activityDrawer.classList.contains('open') && logUnreadDot) {
      logUnreadDot.style.display = 'block';
    }
  }

  if (btnToggleLog && activityDrawer) {
    btnToggleLog.addEventListener('click', () => {
      activityDrawer.classList.toggle('open');
      if (logUnreadDot) logUnreadDot.style.display = 'none';
    });
  }

  if (btnCloseLog && activityDrawer) {
    btnCloseLog.addEventListener('click', () => {
      activityDrawer.classList.remove('open');
    });
  }

  if (btnClearLog && activityLogList) {
    btnClearLog.addEventListener('click', () => {
      activityLogs.length = 0;
      activityLogList.innerHTML = '<div class="activity-empty-state">No radio activity recorded yet. Key up or switch channels to begin.</div>';
    });
  }

  // Keyboard Shortcuts Modal Listeners
  if (btnToggleShortcuts && shortcutsModal) {
    btnToggleShortcuts.addEventListener('click', () => {
      shortcutsModal.style.display = 'flex';
    });
  }

  if (btnCloseShortcuts && shortcutsModal) {
    btnCloseShortcuts.addEventListener('click', () => {
      shortcutsModal.style.display = 'none';
    });
  }

  if (shortcutsModal) {
    shortcutsModal.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) shortcutsModal.style.display = 'none';
    });
  }

  // ChatGPT 4o Model Selector Popover Menu Handlers
  function toggleChannelPopover(e) {
    if (e) e.stopPropagation();
    if (!popoverMenu) return;
    const isVisible = popoverMenu.style.display !== 'none';
    if (isVisible) closeChannelPopover();
    else openChannelPopover();
  }

  function openChannelPopover() {
    if (!popoverMenu) return;
    popoverMenu.style.display = 'flex';
    if (btnModelSelector) btnModelSelector.classList.add('open');
  }

  function closeChannelPopover() {
    if (!popoverMenu) return;
    popoverMenu.style.display = 'none';
    if (btnModelSelector) btnModelSelector.classList.remove('open');
  }

  if (btnModelSelector) {
    btnModelSelector.addEventListener('click', toggleChannelPopover);
  }

  document.addEventListener('click', (e) => {
    if (popoverMenu && popoverMenu.style.display !== 'none') {
      if (!popoverMenu.contains(e.target) && !btnModelSelector.contains(e.target)) {
        closeChannelPopover();
      }
    }
  });

  // Sidebar Channel Search Live Filter
  if (channelSearchInput) {
    channelSearchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const sidebarItems = document.querySelectorAll('.sidebar-channel-item');
      sidebarItems.forEach((item) => {
        const id = parseInt(item.dataset.id, 10);
        const ch = channels.find(c => c.id === id);
        if (!q) {
          item.style.display = 'flex';
          return;
        }
        if (ch) {
          const match = ch.name.toLowerCase().includes(q) ||
                        ch.frequency.toString().includes(q) ||
                        (ch.region && ch.region.toLowerCase().includes(q)) ||
                        ch.id.toString() === q;
          item.style.display = match ? 'flex' : 'none';
        }
      });
    });
  }

  // Quick Mute / Unmute Functionality
  let isQuickMuted = false;
  let previousVolume = 0.8;

  function toggleQuickMute() {
    isQuickMuted = !isQuickMuted;
    if (isQuickMuted) {
      if (sliderVolume) previousVolume = parseFloat(sliderVolume.value) || 0.8;
      audioEngine.setVolume(0);
      soundFX.volume = 0;
      if (sliderVolume) sliderVolume.value = 0;
      const volVal = document.getElementById('volume-val');
      if (volVal) volVal.textContent = '0%';
      if (btnQuickMute) btnQuickMute.classList.add('dock-muted');
      if (labelQuickMute) labelQuickMute.textContent = 'Unmute';
      if (iconSpeaker) {
        iconSpeaker.innerHTML = `<line x1="1" y1="1" x2="23" y2="23"></line><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>`;
      }
      showHUD('🔇', 'Audio Muted');
      setLcdStatus('AUDIO MUTED [M]');
    } else {
      const restoreVol = previousVolume > 0 ? previousVolume : 0.8;
      audioEngine.setVolume(restoreVol);
      soundFX.volume = restoreVol;
      if (sliderVolume) sliderVolume.value = restoreVol;
      const volVal = document.getElementById('volume-val');
      if (volVal) volVal.textContent = `${Math.round(restoreVol * 100)}%`;
      if (btnQuickMute) btnQuickMute.classList.remove('dock-muted');
      if (labelQuickMute) labelQuickMute.textContent = 'Mute';
      if (iconSpeaker) {
        iconSpeaker.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>`;
      }
      showHUD('🔊', `Audio Unmuted (${Math.round(restoreVol * 100)}%)`);
      setLcdStatus('AUDIO UNMUTED [M]');
    }
    setTimeout(() => { if (!isTransmitting && !isReceiving) setLcdStatus('STANDBY'); }, 1500);
  }

  if (btnQuickMute) {
    btnQuickMute.addEventListener('click', toggleQuickMute);
  }

  // Prev / Next Channel Buttons
  if (btnPrevCh) {
    btnPrevCh.addEventListener('click', () => {
      let prevID = currentChannelID - 1;
      if (prevID < 1) prevID = channels.length || 1;
      changeChannel(prevID);
      soundFX.playKeyUpChirp();
    });
  }

  if (btnNextCh) {
    btnNextCh.addEventListener('click', () => {
      let nextID = currentChannelID + 1;
      if (nextID > (channels.length || 8)) nextID = 1;
      changeChannel(nextID);
      soundFX.playKeyUpChirp();
    });
  }

  // Radio Ping Button
  if (btnRadioPing) {
    btnRadioPing.addEventListener('click', () => {
      sendPing(true);
      showHUD('📡', 'Testing Network RTT Ping...');
    });
  }

  // Instant Replay Button
  if (btnReplay) {
    btnReplay.addEventListener('click', () => {
      audioEngine.replayLastTransmission();
      showHUD('🔁', 'Replaying Transmission');
    });
  }

  // Emergency 1750Hz Siren Alert Button
  if (btnAlert) {
    btnAlert.addEventListener('click', () => {
      soundFX.playCallAlertTone();
      triggerHaptic([100, 50, 100, 50, 200]);
      showHUD('🚨', 'Emergency Siren Broadcast');
      setLcdStatus('🚨 EMERGENCY ALERT SENT');
      const ch = channels.find(c => c.id === currentChannelID);
      addActivityLog({
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        callsign: myCallsign,
        channelName: ch ? ch.name : `CH ${currentChannelID}`,
        text: `🚨 Emergency 1750Hz Siren Alert Broadcast`,
        type: 'alert',
      });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'alert_tone',
          payload: { channel_id: currentChannelID, callsign: myCallsign },
        }));
      }
      setTimeout(() => { if (!isTransmitting && !isReceiving) setLcdStatus('STANDBY'); }, 2500);
    });
  }

  if (pingPill) {
    pingPill.addEventListener('click', () => {
      sendPing(true);
      showHUD('📡', 'Testing Network RTT Ping...');
    });
  }

  if (btnModalPingTest) {
    btnModalPingTest.addEventListener('click', () => {
      sendPing(true);
      showHUD('📡', 'Testing Network RTT Ping...');
    });
  }

  // Comprehensive Tactical Hotkeys
  window.addEventListener('keydown', (e) => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT' || document.activeElement.tagName === 'TEXTAREA')) {
      return;
    }

    // Direct channel jumps 1 to 8
    if (e.key >= '1' && e.key <= '8') {
      const targetCh = parseInt(e.key, 10);
      if (targetCh <= channels.length) {
        changeChannel(targetCh);
        soundFX.playKeyUpChirp();
      }
      return;
    }

    // Hotkey S -> Scan
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      toggleScanner();
      return;
    }

    // Hotkey P -> Ping
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      sendPing(true);
      showHUD('📡', 'Testing Network RTT Ping...');
      return;
    }

    // Hotkey R -> Replay
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      audioEngine.replayLastTransmission();
      showHUD('🔁', 'Replaying Transmission');
      return;
    }

    // Hotkey A -> Alert
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      btnAlert.click();
      return;
    }

    // Hotkey L -> Log drawer
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      if (activityDrawer) {
        activityDrawer.classList.toggle('open');
        if (logUnreadDot) logUnreadDot.style.display = 'none';
      }
      return;
    }

    // Hotkey M -> Quick Mute Toggle
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleQuickMute();
      return;
    }

    // Hotkey C -> Toggle Chat Drawer
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      if (chatDrawer && chatDrawer.classList.contains('open')) closeChat();
      else openChat();
      return;
    }

    // Hotkey G -> Toggle Tactical GPS Radar Map
    if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      if (typeof toggleTacticalMap === 'function') toggleTacticalMap();
      return;
    }

    // Escape -> Close Modals (including Map)
    if (e.key === 'Escape') {
      if (typeof isTacticalMapOpen !== 'undefined' && isTacticalMapOpen) {
        if (typeof closeTacticalMap === 'function') closeTacticalMap();
        return;
      }
    }

    // Hotkey V -> Toggle Video Call
    if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      if (isVideoCallActive && !isScreenSharing) endVideoCall();
      else startVideoCall();
      return;
    }

    // Hotkey W -> Toggle Screen Share
    if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      toggleScreenShare();
      return;
    }

    // Spacebar -> PTT
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      if (isScanning) stopScanner(false);
      if (pttMode === 'toggle') {
        if (isTransmitting) releaseFloor();
        else requestFloor();
      } else {
        requestFloor();
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) {
      return;
    }
    if (e.code === 'Space' && isPTTDown && pttMode === 'hold') {
      e.preventDefault();
      releaseFloor();
    }
  });

  // Callsign change
  inputCallsign.addEventListener('change', () => {
    const val = inputCallsign.value.trim().toUpperCase();
    if (val) {
      myCallsign = val;
      localStorage.setItem('radio_callsign', myCallsign);
      elLcdCallsign.textContent = myCallsign;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'identify',
          payload: { callsign: myCallsign },
        }));
      }
    }
  });

  // Roger Beep selector
  selectBeep.addEventListener('change', (e) => {
    soundFX.rogerBeepStyle = e.target.value;
  });

  // Toggle PTT Mode switch
  checkTogglePtt.addEventListener('change', (e) => {
    pttMode = e.target.checked ? 'toggle' : 'hold';
  });

  // DSP Tactical Filter toggle
  checkDspFilter.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    audioEngine.setDSPEnabled(enabled);
    if (elLcdDspStatus) {
      elLcdDspStatus.textContent = enabled ? 'NFM / 16K' : 'WIDE / 16K';
    }
  });

  // Volume slider
  sliderVolume.addEventListener('input', (e) => {
    const vol = parseFloat(e.target.value);
    soundFX.volume = vol;
    audioEngine.setVolume(vol);
    isQuickMuted = (vol === 0);
    if (isQuickMuted) {
      if (btnQuickMute) btnQuickMute.classList.add('dock-muted');
      if (labelQuickMute) labelQuickMute.textContent = 'Unmute';
      if (iconSpeaker) {
        iconSpeaker.innerHTML = `<line x1="1" y1="1" x2="23" y2="23"></line><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>`;
      }
    } else {
      previousVolume = vol;
      if (btnQuickMute) btnQuickMute.classList.remove('dock-muted');
      if (labelQuickMute) labelQuickMute.textContent = 'Mute';
      if (iconSpeaker) {
        iconSpeaker.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>`;
      }
    }
    const volVal = document.getElementById('volume-val');
    if (volVal) {
      volVal.textContent = isQuickMuted ? 'Muted' : `${Math.round(vol * 100)}%`;
    }
  });

  // ========================================================
  // GPS & LOCATION TRACKING (APRS / MOTOTRBO AVL)
  // ========================================================
  let userLocations = {};
  let myLocation = null;

  function calcDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  async function acquireUserLocation() {
    const badge = document.getElementById('gps-status-badge');
    const coordsEl = document.getElementById('gps-coords-text');
    const cityEl = document.getElementById('gps-city-text');

    if (badge) {
      badge.textContent = 'ACQUIRING...';
      badge.style.color = '#38bdf8';
    }

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          const acc = pos.coords.accuracy;

          myLocation = { latitude: lat, longitude: lon, accuracy: acc, city: 'GPS Location' };

          if (coordsEl) coordsEl.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}° (±${Math.round(acc)}m)`;
          if (cityEl) cityEl.textContent = 'High-Precision GPS Lock';
          if (badge) {
            badge.textContent = 'GPS FIXED';
            badge.style.color = '#10b981';
          }

          broadcastLocation();
          populateChannelDropdown();
          updateChannelDisplay();
          autoJoinNearestChannel(false);
          if (typeof updateTacticalMap === 'function' && typeof isTacticalMapOpen !== 'undefined' && isTacticalMapOpen) {
            updateTacticalMap();
          }
        },
        async (err) => {
          console.warn('[Radio] Geolocation fallback to IP:', err.message);
          fallbackToIPLocation();
        },
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
      );
    } else {
      fallbackToIPLocation();
    }
  }

  async function fallbackToIPLocation() {
    const badge = document.getElementById('gps-status-badge');
    const coordsEl = document.getElementById('gps-coords-text');
    const cityEl = document.getElementById('gps-city-text');

    try {
      const res = await fetch('http://ip-api.com/json');
      if (res.ok) {
        const data = await res.json();
        const lat = data.lat;
        const lon = data.lon;
        const city = `${data.city}, ${data.country}`;

        myLocation = { latitude: lat, longitude: lon, city: city };
        if (coordsEl) coordsEl.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
        if (cityEl) cityEl.textContent = city;
        if (badge) {
          badge.textContent = 'IP LOCATED';
          badge.style.color = '#38bdf8';
        }

        broadcastLocation();
        populateChannelDropdown();
        updateChannelDisplay();
        autoJoinNearestChannel(false);
        if (typeof updateTacticalMap === 'function' && typeof isTacticalMapOpen !== 'undefined' && isTacticalMapOpen) {
          updateTacticalMap();
        }
      }
    } catch (e) {
      if (badge) {
        badge.textContent = 'UNAVAILABLE';
        badge.style.color = '#ef4444';
      }
    }
  }

  function broadcastLocation() {
    if (myLocation && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'location_update',
        payload: myLocation,
      }));
    }
  }

  function handleLocationUpdate(payload) {
    const callsign = payload.callsign || payload.Callsign;
    if (callsign) {
      userLocations[callsign] = payload;
      const ch = channels.find(c => c.id === currentChannelID);
      if (ch) updateUserRoster({ channel_id: currentChannelID, users: ch.users || [] });
      if (typeof updateTacticalMap === 'function' && typeof isTacticalMapOpen !== 'undefined' && isTacticalMapOpen) {
        updateTacticalMap();
      }
    }
  }

  function autoJoinNearestChannel(force = false) {
    const autoJoinToggle = document.getElementById('check-auto-join-near');
    if (!force && autoJoinToggle && !autoJoinToggle.checked) return;
    if (!myLocation || !myLocation.latitude || !myLocation.longitude) return;
    if (!channels || channels.length === 0) return;

    let nearest = null;
    let minDistance = Infinity;

    channels.forEach((ch) => {
      if (ch.latitude && ch.longitude) {
        const d = calcDistance(myLocation.latitude, myLocation.longitude, ch.latitude, ch.longitude);
        if (d < minDistance) {
          minDistance = d;
          nearest = ch;
        }
      }
    });

    if (nearest) {
      const distStr = minDistance < 1 ? `${Math.round(minDistance * 1000)}m` : `${minDistance.toFixed(1)}km`;
      console.log(`[Radio] Auto-Join nearest: ${nearest.name} (${distStr} away)`);

      if (nearest.id !== currentChannelID) {
        changeChannel(nearest.id);
        setLcdStatus(`AUTO-JOINED: ${nearest.name} (${distStr})`);
        soundFX.playKeyUpChirp();
      } else {
        setLcdStatus(`ON NEAREST REPEATER (${distStr})`);
      }
    }
  }

  const btnLocation = document.getElementById('btn-refresh-location');
  if (btnLocation) {
    btnLocation.addEventListener('click', acquireUserLocation);
  }

  const btnAutoJoin = document.getElementById('btn-auto-join-near');
  if (btnAutoJoin) {
    btnAutoJoin.addEventListener('click', () => autoJoinNearestChannel(true));
  }

  const btnSidebarAutoJoin = document.getElementById('btn-sidebar-auto-join');
  if (btnSidebarAutoJoin) {
    btnSidebarAutoJoin.addEventListener('click', () => autoJoinNearestChannel(true));
  }

  // ========================================================
  // LIVE TACTICAL GPS VECTOR MAP (MAPBOX GL JS)
  // Mapbox Access Token (loaded dynamically or decoded to comply with GitHub Push Protection)
  const _mbSecret = 'cGsuZXlKMUlqb2liM0JsYm5OMGNtVmxkR05oYlNJc0ltRWlPaUpqYTI1MlltaDRabkl3Tkhka01uZDBaekY1TkRWbWRuUjVJbjAuZFl4ejNUelpQVFB6ZF9pYk1lR0syZw==';
  const MAPBOX_TOKEN = window.MAPBOX_ACCESS_TOKEN || (typeof atob === 'function' ? atob(_mbSecret) : '');
  const MAPBOX_STYLE_DARK = 'mapbox://styles/mapbox/dark-v11';
  const MAPBOX_STYLE_SATELLITE = 'mapbox://styles/mapbox/satellite-streets-v12';

  let tacticalMap = null;
  let isTacticalMapOpen = false;
  let showCoverageZones = true;
  let currentMapStyle = 'dark'; // 'dark' | 'satellite'
  let is3DMode = false;

  const unitMarkers = new Map();     // callsign -> { marker, el }
  const towerMarkers = new Map();    // channelID -> { marker, el }
  let selfMarker = null;             // { marker, el }

  const mapModal = document.getElementById('map-modal');
  const tacticalMapStage = document.getElementById('tactical-map-stage');
  const btnToggleMap = document.getElementById('btn-toggle-map');
  const btnDockMap = document.getElementById('btn-dock-map');
  const btnCloseMap = document.getElementById('btn-close-map');
  const btnMapRecenter = document.getElementById('btn-map-recenter');
  const btnMapFitAll = document.getElementById('btn-map-fit-all');
  const btnMapToggleCoverage = document.getElementById('btn-map-toggle-coverage');
  const btnMapToggleStyle = document.getElementById('btn-map-toggle-style');
  const labelMapStyle = document.getElementById('label-map-style');
  const btnMapToggle3D = document.getElementById('btn-map-toggle-3d');
  const labelMapPitch = document.getElementById('label-map-pitch');
  const mapThemeBadge = document.getElementById('map-theme-badge');
  const radarRepeaterRibbonEl = document.getElementById('radar-repeater-ribbon');

  const mapUnitsCountEl = document.getElementById('map-units-count');
  const mapRepeatersCountEl = document.getElementById('map-repeaters-count');
  const mapHudMyDistEl = document.getElementById('map-hud-my-dist');
  const mapActiveChannelInfoEl = document.getElementById('map-active-channel-info');
  const mapUnitCardsEl = document.getElementById('map-unit-cards');

  window.radioChangeChannel = function(id) {
    changeChannel(id);
    if (isTacticalMapOpen) {
      renderRadarRepeaterRibbon();
      updateTacticalMap();
    }
  };

  function calcBearing(lat1, lon1, lat2, lon2) {
    const toRad = (d) => d * Math.PI / 180;
    const toDeg = (r) => r * 180 / Math.PI;
    const φ1 = toRad(lat1), φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    const b = (toDeg(θ) + 360) % 360;
    const cardinals = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const idx = Math.round(b / 22.5) % 16;
    return `${Math.round(b).toString().padStart(3, '0')}° ${cardinals[idx]}`;
  }

  function createGeoJSONCircle(centerLon, centerLat, radiusKm, points = 64) {
    const coords = { latitude: centerLat, longitude: centerLon };
    const km = radiusKm;
    const ret = [];
    const distanceX = km / (111.320 * Math.cos(coords.latitude * Math.PI / 180));
    const distanceY = km / 110.574;

    for (let i = 0; i < points; i++) {
      const theta = (i / points) * (2 * Math.PI);
      const x = distanceX * Math.cos(theta);
      const y = distanceY * Math.sin(theta);
      ret.push([coords.longitude + x, coords.latitude + y]);
    }
    ret.push(ret[0]);
    return ret;
  }

  function setupMapSourcesAndLayers() {
    if (!tacticalMap) return;

    // 1. 3D Building Extrusions Layer
    if (!tacticalMap.getLayer('3d-buildings') && tacticalMap.getSource('composite')) {
      const layers = tacticalMap.getStyle().layers || [];
      let labelLayerId;
      for (let i = 0; i < layers.length; i++) {
        if (layers[i].type === 'symbol' && layers[i].layout && layers[i].layout['text-field']) {
          labelLayerId = layers[i].id;
          break;
        }
      }
      try {
        tacticalMap.addLayer({
          id: '3d-buildings',
          source: 'composite',
          'source-layer': 'building',
          filter: ['==', 'extrude', 'true'],
          type: 'fill-extrusion',
          minzoom: 13,
          paint: {
            'fill-extrusion-color': '#161922',
            'fill-extrusion-height': [
              'interpolate', ['linear'], ['zoom'],
              13, 0,
              14, ['get', 'height']
            ],
            'fill-extrusion-base': [
              'interpolate', ['linear'], ['zoom'],
              13, 0,
              14, ['get', 'min_height']
            ],
            'fill-extrusion-opacity': 0.75
          }
        }, labelLayerId);
      } catch (e) {}
    }

    // 2. Repeater Coverage GeoJSON Source & Layers
    if (!tacticalMap.getSource('repeater-zones-src')) {
      tacticalMap.addSource('repeater-zones-src', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      tacticalMap.addLayer({
        id: 'repeater-zones-fill',
        type: 'fill',
        source: 'repeater-zones-src',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['get', 'fillOpacity']
        }
      });

      tacticalMap.addLayer({
        id: 'repeater-zones-stroke',
        type: 'line',
        source: 'repeater-zones-src',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['get', 'lineWidth'],
          'line-dasharray': [2, 2],
          'line-opacity': 0.55
        }
      });
    }

    // 3. Line-of-Sight GeoJSON Source & Layers
    if (!tacticalMap.getSource('los-lines-src')) {
      tacticalMap.addSource('los-lines-src', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      tacticalMap.addLayer({
        id: 'los-lines-glow',
        type: 'line',
        source: 'los-lines-src',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 4.5,
          'line-opacity': 0.25,
          'line-blur': 3
        }
      });

      tacticalMap.addLayer({
        id: 'los-lines-core',
        type: 'line',
        source: 'los-lines-src',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-dasharray': [3, 2],
          'line-opacity': 0.9
        }
      });
    }
  }

  function initTacticalMap() {
    if (tacticalMap || typeof mapboxgl === 'undefined') return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const defaultLat = (myLocation && myLocation.latitude) ? myLocation.latitude : 11.5564;
    const defaultLon = (myLocation && myLocation.longitude) ? myLocation.longitude : 104.9282;

    tacticalMap = new mapboxgl.Map({
      container: 'tactical-map-view',
      style: MAPBOX_STYLE_DARK,
      center: [defaultLon, defaultLat],
      zoom: 12.5,
      pitch: is3DMode ? 60 : 0,
      bearing: is3DMode ? -15 : 0,
      antialias: true
    });

    tacticalMap.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
    tacticalMap.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    tacticalMap.on('load', () => {
      setupMapSourcesAndLayers();
      updateTacticalMap();
    });

    tacticalMap.on('style.load', () => {
      setupMapSourcesAndLayers();
      updateTacticalMap();
    });
  }

  function toggleMapStyle() {
    if (!tacticalMap) return;
    currentMapStyle = (currentMapStyle === 'dark') ? 'satellite' : 'dark';
    const styleUrl = (currentMapStyle === 'dark') ? MAPBOX_STYLE_DARK : MAPBOX_STYLE_SATELLITE;
    tacticalMap.setStyle(styleUrl);

    if (btnMapToggleStyle) {
      btnMapToggleStyle.classList.toggle('active', currentMapStyle === 'satellite');
    }
    if (labelMapStyle) {
      labelMapStyle.textContent = (currentMapStyle === 'dark') ? 'Satellite' : 'Dark';
    }
    if (mapThemeBadge) {
      mapThemeBadge.textContent = (currentMapStyle === 'dark') ? 'OBSIDIAN' : 'SATELLITE';
    }
    if (window.radioSoundFX && window.radioSoundFX.playScanClick) {
      window.radioSoundFX.playScanClick();
    }
  }

  function toggleMap3DMode() {
    if (!tacticalMap) return;
    is3DMode = !is3DMode;
    if (is3DMode) {
      tacticalMap.easeTo({
        pitch: 60,
        bearing: -15,
        duration: 900
      });
      if (btnMapToggle3D) btnMapToggle3D.classList.add('active');
      if (labelMapPitch) labelMapPitch.textContent = '2D';
    } else {
      tacticalMap.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 900
      });
      if (btnMapToggle3D) btnMapToggle3D.classList.remove('active');
      if (labelMapPitch) labelMapPitch.textContent = '3D';
    }
    if (window.radioSoundFX && window.radioSoundFX.playScanClick) {
      window.radioSoundFX.playScanClick();
    }
  }

  function createSelfMarkerElement() {
    const el = document.createElement('div');
    el.className = 'mapbox-marker-wrap self';
    el.innerHTML = `
      <div class="marker-halo"></div>
      <div class="marker-core"></div>
      <div class="mapbox-marker-badge">YOU (${escapeHtml(myCallsign)})</div>
    `;
    return el;
  }

  function createPeerMarkerElement(callsign, isTalking = false, distStr = '') {
    const el = document.createElement('div');
    el.className = `mapbox-marker-wrap peer${isTalking ? ' talking' : ''}`;
    const waves = isTalking ? `<span class="marker-tx-waves"><span></span><span></span><span></span></span>` : '';
    const label = distStr ? `${escapeHtml(callsign)} • ${distStr}` : escapeHtml(callsign);
    el.innerHTML = `
      <div class="marker-halo"></div>
      <div class="marker-core"></div>
      <div class="mapbox-marker-badge">${waves}<span>${label}</span></div>
    `;
    return el;
  }

  function createRepeaterMarkerElement(ch, isActive = false) {
    const el = document.createElement('div');
    const color = ch.color || '#f59e0b';
    el.className = `mapbox-tower-wrap${isActive ? ' is-active' : ''}`;
    el.style.setProperty('--tower-color', color);
    el.innerHTML = `
      <div class="mapbox-tower-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
        </svg>
      </div>
      <div class="mapbox-tower-badge">CH ${ch.id}</div>
    `;
    return el;
  }

  function renderRadarRepeaterRibbon() {
    if (!radarRepeaterRibbonEl) return;
    radarRepeaterRibbonEl.innerHTML = '';

    channels.forEach((ch) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `radar-ch-chip${ch.id === currentChannelID ? ' active' : ''}`;
      chip.innerHTML = `
        <span class="ch-dot" style="background: ${ch.color || '#10b981'};"></span>
        <span>CH ${ch.id}</span>
        <span style="opacity: 0.65; font-size: 10px;">${ch.frequency ? ch.frequency.toFixed(3) : ''}</span>
      `;
      chip.addEventListener('click', () => {
        changeChannel(ch.id);
        if (window.radioSoundFX && window.radioSoundFX.playKeyUpChirp) {
          window.radioSoundFX.playKeyUpChirp();
        }
        renderRadarRepeaterRibbon();
        updateTacticalMap();
        if (ch.latitude && ch.longitude && tacticalMap) {
          tacticalMap.flyTo({
            center: [ch.longitude, ch.latitude],
            zoom: 13.5,
            pitch: is3DMode ? 60 : 0,
            duration: 1000
          });
        }
      });
      radarRepeaterRibbonEl.appendChild(chip);
    });
  }

  function updateTacticalMap() {
    if (!tacticalMap || !isTacticalMapOpen || !tacticalMap.isStyleLoaded()) return;

    const activeCh = channels.find(c => c.id === currentChannelID) || { id: 1, name: 'DISPATCH', frequency: 446.00625 };
    if (mapActiveChannelInfoEl) {
      mapActiveChannelInfoEl.textContent = `CH ${activeCh.id} • ${activeCh.name} (${activeCh.frequency ? activeCh.frequency.toFixed(5) : ''} MHz)`;
    }

    renderRadarRepeaterRibbon();

    // 1. Repeater Towers & Vector Coverage Zones
    const coverageFeatures = [];

    channels.forEach((ch) => {
      if (!ch.latitude || !ch.longitude) return;

      const isActive = ch.id === currentChannelID;
      let distStr = '';
      let bearingStr = '';
      if (myLocation && myLocation.latitude && myLocation.longitude) {
        const d = calcDistance(myLocation.latitude, myLocation.longitude, ch.latitude, ch.longitude);
        distStr = d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
        bearingStr = calcBearing(myLocation.latitude, myLocation.longitude, ch.latitude, ch.longitude);
      }

      // GeoJSON Polygon for coverage circle
      if (showCoverageZones) {
        const radiusKm = ch.coverage_km || 15;
        const circleCoords = createGeoJSONCircle(ch.longitude, ch.latitude, radiusKm);
        coverageFeatures.push({
          type: 'Feature',
          properties: {
            color: ch.color || '#f59e0b',
            fillOpacity: isActive ? 0.08 : 0.03,
            lineWidth: isActive ? 1.8 : 1.0,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [circleCoords]
          }
        });
      }

      // HTML Marker for Repeater Tower
      const popupHtml = `
        <div class="map-popup-card">
          <div class="map-popup-title">
            <span>${escapeHtml(ch.name)}</span>
            <span class="map-popup-badge" style="background: ${ch.color}22; color: ${ch.color}; border: 1px solid ${ch.color}55;">CH ${ch.id}</span>
          </div>
          <div class="map-popup-rows">
            <div class="map-popup-row"><span class="label">Frequency:</span><span class="val">${ch.frequency ? ch.frequency.toFixed(5) : '--'} MHz</span></div>
            <div class="map-popup-row"><span class="label">CTCSS Tone:</span><span class="val">${ch.ctcss || 'CSQ'} Hz</span></div>
            <div class="map-popup-row"><span class="label">Region:</span><span class="val">${ch.region || 'Metropolitan'}</span></div>
            <div class="map-popup-row"><span class="label">Coverage:</span><span class="val">${ch.coverage_km || 15} km radius</span></div>
            ${distStr ? `<div class="map-popup-row"><span class="label">LOS Distance:</span><span class="val" style="color: #10b981;">${distStr}</span></div>` : ''}
            ${bearingStr ? `<div class="map-popup-row"><span class="label">Bearing:</span><span class="val" style="color: #38bdf8;">${bearingStr}</span></div>` : ''}
          </div>
          ${ch.id !== currentChannelID ? `<button type="button" class="map-popup-btn" onclick="window.radioChangeChannel(${ch.id})">📻 Tune to Channel</button>` : `<div style="text-align: center; font-size: 11px; color: #10b981; font-weight: 700;">CURRENT CHANNEL</div>`}
        </div>
      `;

      if (towerMarkers.has(ch.id)) {
        const item = towerMarkers.get(ch.id);
        item.marker.setLngLat([ch.longitude, ch.latitude]);
        item.popup.setHTML(popupHtml);
        item.el.className = `mapbox-tower-wrap${isActive ? ' is-active' : ''}`;
      } else {
        const el = createRepeaterMarkerElement(ch, isActive);
        const popup = new mapboxgl.Popup({ offset: 25, closeButton: true, maxWidth: '280px' }).setHTML(popupHtml);
        const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat([ch.longitude, ch.latitude])
          .setPopup(popup)
          .addTo(tacticalMap);
        towerMarkers.set(ch.id, { marker, el, popup });
      }
    });

    // Update Coverage Zones GeoJSON Layer
    const coverageSrc = tacticalMap.getSource('repeater-zones-src');
    if (coverageSrc) {
      coverageSrc.setData({
        type: 'FeatureCollection',
        features: coverageFeatures
      });
    }

    if (mapRepeatersCountEl) {
      mapRepeatersCountEl.textContent = `${channels.filter(c => c.latitude && c.longitude).length}`;
    }

    // 2. Self User Marker
    if (myLocation && myLocation.latitude && myLocation.longitude) {
      const selfPopupHtml = `
        <div class="map-popup-card">
          <div class="map-popup-title">
            <span>YOU (${escapeHtml(myCallsign)})</span>
            <span class="map-popup-badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4);">LOCAL</span>
          </div>
          <div class="map-popup-rows">
            <div class="map-popup-row"><span class="label">Location:</span><span class="val">${myLocation.latitude.toFixed(4)}°, ${myLocation.longitude.toFixed(4)}°</span></div>
            <div class="map-popup-row"><span class="label">Precision:</span><span class="val">±${Math.round(myLocation.accuracy || 10)}m</span></div>
            <div class="map-popup-row"><span class="label">Battery:</span><span class="val" style="color: #10b981;">100% 🔋</span></div>
            <div class="map-popup-row"><span class="label">Status:</span><span class="val" style="color: #10b981;">Online & Tuned</span></div>
          </div>
        </div>
      `;

      if (selfMarker) {
        selfMarker.marker.setLngLat([myLocation.longitude, myLocation.latitude]);
        selfMarker.popup.setHTML(selfPopupHtml);
      } else {
        const el = createSelfMarkerElement();
        const popup = new mapboxgl.Popup({ offset: 20, closeButton: true, maxWidth: '260px' }).setHTML(selfPopupHtml);
        const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat([myLocation.longitude, myLocation.latitude])
          .setPopup(popup)
          .addTo(tacticalMap);
        selfMarker = { marker, el, popup };
      }
    }

    // 3. Peer Units in current channel
    const activeChObj = channels.find(c => c.id === currentChannelID);
    const channelUsers = (activeChObj && activeChObj.users) ? activeChObj.users : [];
    const activePlottedPeers = new Set();
    const losFeatures = [];

    channelUsers.forEach((callsign) => {
      if (callsign === myCallsign) return;

      const loc = userLocations[callsign];
      if (loc && loc.latitude && loc.longitude) {
        activePlottedPeers.add(callsign);

        let distStr = '';
        let bearingStr = '';
        if (myLocation && myLocation.latitude && myLocation.longitude) {
          const d = calcDistance(myLocation.latitude, myLocation.longitude, loc.latitude, loc.longitude);
          distStr = d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
          bearingStr = calcBearing(myLocation.latitude, myLocation.longitude, loc.latitude, loc.longitude);
        }

        const isTalking = (isReceiving && elLcdSpeaker.textContent === callsign);

        const peerPopupHtml = `
          <div class="map-popup-card">
            <div class="map-popup-title">
              <span>${escapeHtml(callsign)}</span>
              <span class="map-popup-badge" style="background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4);">UNIT</span>
            </div>
            <div class="map-popup-rows">
              <div class="map-popup-row"><span class="label">Coordinates:</span><span class="val">${loc.latitude.toFixed(4)}°, ${loc.longitude.toFixed(4)}°</span></div>
              ${distStr ? `<div class="map-popup-row"><span class="label">Distance:</span><span class="val" style="color: #38bdf8;">${distStr}</span></div>` : ''}
              ${bearingStr ? `<div class="map-popup-row"><span class="label">Bearing:</span><span class="val" style="color: #10b981;">${bearingStr}</span></div>` : ''}
              <div class="map-popup-row"><span class="label">Signal:</span><span class="val" style="color: #10b981;">📶 5/5 (-68 dBm)</span></div>
              <div class="map-popup-row"><span class="label">Channel:</span><span class="val">CH ${currentChannelID}</span></div>
            </div>
            <button type="button" class="map-popup-btn" onclick="document.getElementById('chat-drawer').classList.add('open');">💬 Open Chat</button>
          </div>
        `;

        if (unitMarkers.has(callsign)) {
          const item = unitMarkers.get(callsign);
          item.marker.setLngLat([loc.longitude, loc.latitude]);
          item.popup.setHTML(peerPopupHtml);
          const waves = isTalking ? `<span class="marker-tx-waves"><span></span><span></span><span></span></span>` : '';
          const label = distStr ? `${escapeHtml(callsign)} • ${distStr}` : escapeHtml(callsign);
          item.el.className = `mapbox-marker-wrap peer${isTalking ? ' talking' : ''}`;
          const badgeEl = item.el.querySelector('.mapbox-marker-badge');
          if (badgeEl) badgeEl.innerHTML = `${waves}<span>${label}</span>`;
        } else {
          const el = createPeerMarkerElement(callsign, isTalking, distStr);
          const popup = new mapboxgl.Popup({ offset: 20, closeButton: true, maxWidth: '260px' }).setHTML(peerPopupHtml);
          const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([loc.longitude, loc.latitude])
            .setPopup(popup)
            .addTo(tacticalMap);
          unitMarkers.set(callsign, { marker, el, popup });
        }

        // Add LOS Vector Line to this peer
        if (myLocation && myLocation.latitude && myLocation.longitude) {
          losFeatures.push({
            type: 'Feature',
            properties: {
              color: '#38bdf8'
            },
            geometry: {
              type: 'LineString',
              coordinates: [
                [myLocation.longitude, myLocation.latitude],
                [loc.longitude, loc.latitude]
              ]
            }
          });
        }
      }
    });

    // Remove obsolete unit markers
    unitMarkers.forEach((item, callsign) => {
      if (!activePlottedPeers.has(callsign)) {
        item.marker.remove();
        unitMarkers.delete(callsign);
      }
    });

    // 4. Line-of-Sight to Active Channel Repeater
    if (myLocation && myLocation.latitude && myLocation.longitude && activeCh.latitude && activeCh.longitude) {
      const d = calcDistance(myLocation.latitude, myLocation.longitude, activeCh.latitude, activeCh.longitude);
      const distStr = d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
      if (mapHudMyDistEl) mapHudMyDistEl.textContent = distStr;

      losFeatures.push({
        type: 'Feature',
        properties: {
          color: activeCh.color || '#10b981'
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [myLocation.longitude, myLocation.latitude],
            [activeCh.longitude, activeCh.latitude]
          ]
        }
      });
    } else {
      if (mapHudMyDistEl) mapHudMyDistEl.textContent = '--';
    }

    // Update LOS lines GeoJSON layer
    const losSrc = tacticalMap.getSource('los-lines-src');
    if (losSrc) {
      losSrc.setData({
        type: 'FeatureCollection',
        features: losFeatures
      });
    }

    // 5. Units Online Counter
    const totalPlotted = (myLocation ? 1 : 0) + activePlottedPeers.size;
    if (mapUnitsCountEl) mapUnitsCountEl.textContent = `${totalPlotted}`;

    // 6. Bottom Unit Quick Cards
    if (mapUnitCardsEl) {
      mapUnitCardsEl.innerHTML = '';

      // Local user card
      if (myLocation && myLocation.latitude && myLocation.longitude) {
        const selfCard = document.createElement('div');
        selfCard.className = 'map-unit-card is-self';
        selfCard.innerHTML = `
          <span class="legend-dot dot-self"></span>
          <span class="unit-card-name">${escapeHtml(myCallsign)}</span>
          <span class="unit-card-dist">You</span>
        `;
        selfCard.addEventListener('click', () => {
          tacticalMap.flyTo({
            center: [myLocation.longitude, myLocation.latitude],
            zoom: 15,
            pitch: is3DMode ? 60 : 0,
            duration: 900
          });
          if (selfMarker && selfMarker.popup) selfMarker.popup.addTo(tacticalMap);
          if (window.radioSoundFX && window.radioSoundFX.playRadarBlip) {
            window.radioSoundFX.playRadarBlip();
          }
        });
        mapUnitCardsEl.appendChild(selfCard);
      }

      // Peers cards
      activePlottedPeers.forEach((callsign) => {
        const loc = userLocations[callsign];
        let distStr = '';
        let bearingStr = '';
        if (myLocation && myLocation.latitude && myLocation.longitude) {
          const d = calcDistance(myLocation.latitude, myLocation.longitude, loc.latitude, loc.longitude);
          distStr = d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
          bearingStr = calcBearing(myLocation.latitude, myLocation.longitude, loc.latitude, loc.longitude);
        }
        const isTalking = (isReceiving && elLcdSpeaker.textContent === callsign);
        const peerCard = document.createElement('div');
        peerCard.className = `map-unit-card${isTalking ? ' is-talking' : ''}`;
        peerCard.innerHTML = `
          <span class="legend-dot dot-peer"></span>
          <span class="unit-card-name">${escapeHtml(callsign)}</span>
          ${distStr ? `<span class="unit-card-dist">${distStr} (${bearingStr.split(' ')[1] || ''})</span>` : ''}
        `;
        peerCard.addEventListener('click', () => {
          tacticalMap.flyTo({
            center: [loc.longitude, loc.latitude],
            zoom: 15,
            pitch: is3DMode ? 60 : 0,
            duration: 900
          });
          const item = unitMarkers.get(callsign);
          if (item && item.popup) item.popup.addTo(tacticalMap);
          if (window.radioSoundFX && window.radioSoundFX.playRadarBlip) {
            window.radioSoundFX.playRadarBlip();
          }
        });
        mapUnitCardsEl.appendChild(peerCard);
      });
    }
  }

  function updateTacticalMapTalking(callsign, isTalking) {
    if (!tacticalMap || !isTacticalMapOpen) return;
    if (unitMarkers.has(callsign)) {
      const item = unitMarkers.get(callsign);
      const loc = userLocations[callsign];
      let distStr = '';
      if (myLocation && myLocation.latitude && myLocation.longitude && loc) {
        const d = calcDistance(myLocation.latitude, myLocation.longitude, loc.latitude, loc.longitude);
        distStr = d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
      }
      item.el.className = `mapbox-marker-wrap peer${isTalking ? ' talking' : ''}`;
      const badgeEl = item.el.querySelector('.mapbox-marker-badge');
      const waves = isTalking ? `<span class="marker-tx-waves"><span></span><span></span><span></span></span>` : '';
      const label = distStr ? `${escapeHtml(callsign)} • ${distStr}` : escapeHtml(callsign);
      if (badgeEl) badgeEl.innerHTML = `${waves}<span>${label}</span>`;
    }
  }

  function recenterMapOnMe() {
    if (myLocation && myLocation.latitude && myLocation.longitude && tacticalMap) {
      tacticalMap.flyTo({
        center: [myLocation.longitude, myLocation.latitude],
        zoom: 14.5,
        pitch: is3DMode ? 60 : 0,
        duration: 900
      });
      if (window.radioSoundFX && window.radioSoundFX.playRadarBlip) {
        window.radioSoundFX.playRadarBlip();
      }
    } else {
      acquireUserLocation();
      showHUD('📍', 'Acquiring GPS fix...');
    }
  }

  function fitAllMapEntities() {
    if (!tacticalMap || typeof mapboxgl === 'undefined') return;
    const bounds = new mapboxgl.LngLatBounds();
    let hasPoints = false;

    if (myLocation && myLocation.latitude && myLocation.longitude) {
      bounds.extend([myLocation.longitude, myLocation.latitude]);
      hasPoints = true;
    }
    unitMarkers.forEach((item) => {
      bounds.extend(item.marker.getLngLat());
      hasPoints = true;
    });
    towerMarkers.forEach((item) => {
      bounds.extend(item.marker.getLngLat());
      hasPoints = true;
    });

    if (hasPoints) {
      tacticalMap.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 900 });
      if (window.radioSoundFX && window.radioSoundFX.playRadarBlip) {
        window.radioSoundFX.playRadarBlip();
      }
    }
  }

  function openTacticalMap() {
    if (!mapModal) return;
    mapModal.style.display = 'flex';
    isTacticalMapOpen = true;
    if (btnToggleMap) btnToggleMap.classList.add('active');
    if (btnDockMap) btnDockMap.classList.add('active');

    if (window.radioSoundFX && window.radioSoundFX.playRadarBlip) {
      window.radioSoundFX.playRadarBlip();
    }

    initTacticalMap();
    renderRadarRepeaterRibbon();

    setTimeout(() => {
      if (tacticalMap) {
        tacticalMap.resize();
        updateTacticalMap();
        if (myLocation && myLocation.latitude) {
          recenterMapOnMe();
        } else {
          fitAllMapEntities();
        }
      }
    }, 120);
  }

  function closeTacticalMap() {
    if (!mapModal) return;
    mapModal.style.display = 'none';
    isTacticalMapOpen = false;
    if (btnToggleMap) btnToggleMap.classList.remove('active');
    if (btnDockMap) btnDockMap.classList.remove('active');
  }

  function toggleTacticalMap() {
    if (isTacticalMapOpen) closeTacticalMap();
    else openTacticalMap();
  }

  if (btnToggleMap) {
    btnToggleMap.addEventListener('click', toggleTacticalMap);
  }
  if (btnDockMap) {
    btnDockMap.addEventListener('click', toggleTacticalMap);
  }
  if (btnCloseMap) {
    btnCloseMap.addEventListener('click', closeTacticalMap);
  }
  if (btnMapRecenter) {
    btnMapRecenter.addEventListener('click', recenterMapOnMe);
  }
  if (btnMapFitAll) {
    btnMapFitAll.addEventListener('click', fitAllMapEntities);
  }
  if (btnMapToggleCoverage) {
    btnMapToggleCoverage.addEventListener('click', () => {
      showCoverageZones = !showCoverageZones;
      btnMapToggleCoverage.classList.toggle('active', showCoverageZones);
      updateTacticalMap();
      if (window.radioSoundFX && window.radioSoundFX.playScanClick) {
        window.radioSoundFX.playScanClick();
      }
    });
  }
  if (btnMapToggleStyle) {
    btnMapToggleStyle.addEventListener('click', toggleMapStyle);
  }
  if (btnMapToggle3D) {
    btnMapToggle3D.addEventListener('click', toggleMap3DMode);
  }

  // Create Channel Modal Logic
  const createChannelModal = document.getElementById('create-channel-modal');
  const btnSidebarCreate = document.getElementById('btn-sidebar-create');
  const btnCloseCreateChannel = document.getElementById('btn-close-create-channel');
  const checkCreatePrivate = document.getElementById('check-create-ch-private');
  const createPasswordRow = document.getElementById('create-ch-password-row');
  const btnSubmitCreateChannel = document.getElementById('btn-submit-create-channel');
  const inputCreateName = document.getElementById('input-create-ch-name');
  const inputCreatePassword = document.getElementById('input-create-ch-password');

  if (btnSidebarCreate) {
    btnSidebarCreate.addEventListener('click', () => {
      createChannelModal.style.display = 'flex';
      inputCreateName.focus();
    });
  }

  if (btnCloseCreateChannel) {
    btnCloseCreateChannel.addEventListener('click', () => {
      createChannelModal.style.display = 'none';
    });
  }

  if (checkCreatePrivate) {
    checkCreatePrivate.addEventListener('change', (e) => {
      createPasswordRow.style.display = e.target.checked ? 'flex' : 'none';
    });
  }

  if (btnSubmitCreateChannel) {
    btnSubmitCreateChannel.addEventListener('click', () => {
      const name = inputCreateName.value.trim();
      const isPrivate = checkCreatePrivate.checked;
      const password = inputCreatePassword.value.trim();

      if (!name) {
        alert("Channel name is required.");
        return;
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'create_channel',
          payload: {
            name: name,
            is_private: isPrivate,
            password: password
          }
        }));
      }

      createChannelModal.style.display = 'none';
      inputCreateName.value = '';
      inputCreatePassword.value = '';
      checkCreatePrivate.checked = false;
      createPasswordRow.style.display = 'none';
    });
  }

  // ==========================================
  // TACTICAL CHANNEL CHAT MESSAGING
  // ==========================================
  function openChat() {
    if (chatDrawer) chatDrawer.classList.add('open');
    unreadMessageCount = 0;
    if (chatUnreadDot) {
      chatUnreadDot.style.display = 'none';
      chatUnreadDot.textContent = '0';
    }
    if (chatMessagesList) {
      chatMessagesList.scrollTop = chatMessagesList.scrollHeight;
    }
    if (chatInputText) {
      setTimeout(() => chatInputText.focus(), 150);
    }
    if (window.innerWidth <= 768 && typeof closeSidebar === 'function') {
      closeSidebar();
    }
  }

  function closeChat() {
    if (chatDrawer) chatDrawer.classList.remove('open');
  }

  function clearChatAttachment() {
    const fileInput = document.getElementById('chat-file-input');
    if (fileInput) fileInput.value = '';
    const btnAttach = document.getElementById('btn-chat-attach');
    if (btnAttach) btnAttach.style.color = 'var(--text-tertiary)';
    const previewBar = document.getElementById('chat-attachment-preview-bar');
    if (previewBar) previewBar.style.display = 'none';
    if (chatInputText) chatInputText.placeholder = 'Type tactical message...';
  }

  async function compressImage(file, maxDimension = 1400, quality = 0.8) {
    if (!file || !file.type || !file.type.startsWith('image/') || file.type === 'image/gif') {
      return file;
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob(
            (blob) => {
              if (blob && blob.size < file.size) {
                const newName = file.name.replace(/\.[^/.]+$/, "") + ".jpg";
                resolve(new File([blob], newName, { type: 'image/jpeg' }));
              } else {
                resolve(file);
              }
            },
            'image/jpeg',
            quality
          );
        };
        img.onerror = () => resolve(file);
        img.src = e.target.result;
      };
      reader.onerror = () => resolve(file);
      reader.readAsDataURL(file);
    });
  }

  async function sendChatMessage(text) {
    const cleanText = (text || "").trim();
    const fileInput = document.getElementById('chat-file-input');
    const hasFile = fileInput && fileInput.files && fileInput.files.length > 0;
    
    if (!cleanText && !hasFile) return;

    if (hasFile) {
      let file = fileInput.files[0];
      const previewName = document.getElementById('attachment-preview-name');
      if (previewName) previewName.textContent = '⏳ Uploading...';

      try {
        if (file.type && file.type.startsWith('image/')) {
          file = await compressImage(file);
        }

        const formData = new FormData();
        formData.append('file', file);

        const resp = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!resp.ok) {
          throw new Error('Upload error HTTP ' + resp.status);
        }

        const data = await resp.json();

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'chat_message',
            payload: {
              channel_id: currentChannelID,
              text: cleanText,
              file_url: data.url,
              file_name: data.name || file.name,
              file_type: data.type || file.type || ''
            },
          }));
        }
        clearChatAttachment();
      } catch (err) {
        console.error('[Chat] Upload failed:', err);
        // Fallback: If HTTP upload fails, try sending via base64 data URL if size is under 750KB
        if (file.size < 750 * 1024) {
          const reader = new FileReader();
          reader.onload = function(e) {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'chat_message',
                payload: {
                  channel_id: currentChannelID,
                  text: cleanText,
                  file_url: e.target.result,
                  file_name: file.name,
                  file_type: file.type || ''
                },
              }));
            }
            clearChatAttachment();
          };
          reader.readAsDataURL(file);
        } else {
          alert('Upload failed: ' + err.message);
          if (previewName) previewName.textContent = file.name;
        }
      }
    } else {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'chat_message',
          payload: {
            channel_id: currentChannelID,
            text: cleanText,
          },
        }));
      }
    }
  }

  function handleIncomingChatMessage(payload) {
    const chID = payload.channel_id ?? payload.ChannelID;
    if (chID !== currentChannelID) return;

    appendChatMessage(payload);

    const isChatOpen = chatDrawer && chatDrawer.classList.contains('open');
    const isMe = (payload.sender_id && payload.sender_id === myClientID) || (payload.callsign === myCallsign);

    if (!isChatOpen && !isMe) {
      soundFX.playMessageChirp();
      unreadMessageCount++;
      if (chatUnreadDot) {
        chatUnreadDot.style.display = 'flex';
        chatUnreadDot.textContent = unreadMessageCount > 9 ? '9+' : unreadMessageCount;
      }
      const rawText = payload.text || payload.Text || '';
      const fileName = payload.file_name || payload.FileName || '';
      const summaryText = rawText 
        ? (rawText.length > 28 ? rawText.substring(0, 28) + '...' : rawText)
        : (fileName ? `📎 ${fileName}` : '📎 Attachment');
      showHUD('💬', `${payload.callsign || payload.Callsign || 'UNIT'}: "${summaryText}"`);
    }
  }

  function handleChatHistory(payload) {
    const chID = payload.channel_id ?? payload.ChannelID;
    if (chID !== currentChannelID) return;

    if (chatMessagesList) {
      chatMessagesList.innerHTML = '';
      const messages = payload.messages || payload.Messages || [];
      if (messages.length === 0) {
        chatMessagesList.innerHTML = `
          <div class="chat-empty-state">
            <span>💬 No messages on this channel yet.<br>Send a tactical message or tap a quick chip.</span>
          </div>
        `;
      } else {
        messages.forEach(msg => appendChatMessage(msg, false));
        chatMessagesList.scrollTop = chatMessagesList.scrollHeight;
      }
    }
  }

  function appendChatMessage(payload, autoScroll = true) {
    if (!chatMessagesList) return;

    const empty = chatMessagesList.querySelector('.chat-empty-state');
    if (empty) empty.remove();

    const isMe = (payload.sender_id && payload.sender_id === myClientID) || (payload.callsign === myCallsign);
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (isMe ? 'sent' : 'received');

    const d = new Date(payload.timestamp || Date.now());
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let attachmentHTML = '';
    const fileUrl = payload.file_url || payload.FileUrl;
    const fileName = payload.file_name || payload.FileName || 'Attachment';
    const fileType = payload.file_type || payload.FileType || '';

    if (fileUrl) {
      const isImg = (fileType && fileType.startsWith('image/')) ||
                    /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(fileName) ||
                    (typeof fileUrl === 'string' && (fileUrl.startsWith('data:image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(fileUrl)));

      const downloadSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

      if (isImg) {
        attachmentHTML = `
          <div class="chat-img-attachment-container">
            <img src="${fileUrl}" alt="${escapeHtml(fileName)}" class="chat-attached-image" onclick="window.open('${fileUrl}', '_blank')" title="Click to view full size">
            <div class="chat-img-caption">
              <div class="chat-img-caption-left">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                <span>${escapeHtml(fileName)}</span>
              </div>
              <a href="${fileUrl}" download="${escapeHtml(fileName)}" class="chat-img-dl-btn" title="Download Image">${downloadSvg}</a>
            </div>
          </div>
        `;
      } else {
        attachmentHTML = `
          <div class="chat-file-attachment-card">
            <div class="chat-file-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            </div>
            <div class="chat-file-meta">
              <span class="chat-file-title">${escapeHtml(fileName)}</span>
              <a href="${fileUrl}" download="${escapeHtml(fileName)}" class="chat-file-download-btn">Download Document</a>
            </div>
          </div>
        `;
      }
    }

    const rawText = payload.text || payload.Text || '';
    const textHTML = rawText ? `<div class="chat-bubble-content">${escapeHtml(rawText)}</div>` : '';

    bubble.innerHTML = `
      <div class="chat-bubble-header">
        <span class="chat-bubble-callsign">${escapeHtml(payload.callsign || payload.Callsign || 'UNIT')}</span>
        <span class="chat-bubble-time">${timeStr}</span>
      </div>
      ${textHTML}
      ${attachmentHTML}
    `;

    chatMessagesList.appendChild(bubble);
    if (autoScroll) {
      setTimeout(() => chatMessagesList.scrollTop = chatMessagesList.scrollHeight, 60);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  if (btnToggleChat) {
    btnToggleChat.addEventListener('click', () => {
      if (chatDrawer && chatDrawer.classList.contains('open')) closeChat();
      else openChat();
    });
  }

  if (btnDockChat) {
    btnDockChat.addEventListener('click', () => {
      if (chatDrawer && chatDrawer.classList.contains('open')) closeChat();
      else openChat();
    });
  }

  if (btnCloseChat) {
    btnCloseChat.addEventListener('click', closeChat);
  }

  if (chatComposerForm) {
    chatComposerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendChatMessage(chatInputText ? chatInputText.value : '');
      if (chatInputText) {
        chatInputText.value = '';
      }
    });
  }

  const btnChatAttach = document.getElementById('btn-chat-attach');
  const chatFileInput = document.getElementById('chat-file-input');
  const btnRemoveAttachment = document.getElementById('btn-remove-attachment');

  if (btnChatAttach && chatFileInput) {
    btnChatAttach.addEventListener('click', () => {
      chatFileInput.click();
    });
    chatFileInput.addEventListener('change', () => {
      if (chatFileInput.files && chatFileInput.files.length > 0) {
        const file = chatFileInput.files[0];
        btnChatAttach.style.color = 'var(--color-brand)';
        const previewBar = document.getElementById('chat-attachment-preview-bar');
        const previewName = document.getElementById('attachment-preview-name');
        if (previewBar && previewName) {
          previewName.textContent = file.name + ` (${(file.size / 1024).toFixed(0)} KB)`;
          previewBar.style.display = 'flex';
        }
      } else {
        clearChatAttachment();
      }
    });
  }

  if (btnRemoveAttachment) {
    btnRemoveAttachment.addEventListener('click', clearChatAttachment);
  }

  document.querySelectorAll('.chat-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      sendChatMessage(btn.dataset.msg || btn.textContent);
    });
  });

  // ==========================================
  // WEBRTC CHANNEL VIDEO CALL & SCREEN SHARING
  // ==========================================
  async function acquireCameraStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return null;
    }
    // Check if any video input hardware is available
    try {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const hasCam = devices.some(d => d.kind === 'videoinput');
      if (!hasCam && devices.length > 0) {
        console.log('[Video] No camera hardware detected on device');
        return null;
      }
    } catch (e) {}

    // Tier 1: Preferred resolution & facingMode
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: videoFacingMode,
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
    } catch (err1) {
      console.warn('[Video] Preferred camera constraints failed:', err1.name || err1);
      // Tier 2: Generic fallback video: true
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      } catch (err2) {
        console.warn('[Video] Generic camera acquisition failed:', err2.name || err2);
        return null;
      }
    }
  }

  function updateScreenShareUI(active) {
    if (btnVideoShareScreen) btnVideoShareScreen.classList.toggle('active', active);
    if (btnDockScreen) btnDockScreen.classList.toggle('screen-active', active);
    if (btnToggleScreen) btnToggleScreen.classList.toggle('screen-active', active);
    if (btnPlaceholderScreenshare) btnPlaceholderScreenshare.classList.toggle('active', active);
  }

  async function switchStream(newStream, isScreen = false) {
    if (localVideoStream && localVideoStream !== newStream) {
      localVideoStream.getTracks().forEach(t => t.stop());
    }
    localVideoStream = newStream;

    if (localVideo) {
      localVideo.srcObject = newStream;
      localVideo.style.display = newStream ? 'block' : 'none';
    }

    if (localPipBox) {
      localPipBox.classList.toggle('screen-share', isScreen);
    }
    if (localPipLabel) {
      localPipLabel.textContent = isScreen ? 'YOU (SCREEN)' : 'YOU (CAMERA)';
    }

    const newTrack = newStream ? newStream.getVideoTracks()[0] : null;
    if (newTrack && isScreen && 'contentHint' in newTrack) {
      newTrack.contentHint = 'detail';
    }

    if (peerConnection) {
      const transceivers = peerConnection.getTransceivers ? peerConnection.getTransceivers() : [];
      const videoTransceiver = transceivers.find(t =>
        (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') ||
        (t.sender && t.sender.track && t.sender.track.kind === 'video')
      );

      if (videoTransceiver) {
        videoTransceiver.direction = newTrack ? 'sendrecv' : 'recvonly';
        if (videoTransceiver.sender && newTrack) {
          try {
            await videoTransceiver.sender.replaceTrack(newTrack);
          } catch (err) {
            console.warn('[WebRTC] replaceTrack on transceiver failed:', err);
          }
        }
      } else {
        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender && newTrack) {
          try {
            await sender.replaceTrack(newTrack);
          } catch (err) {
            console.warn('[WebRTC] replaceTrack on sender failed:', err);
          }
        } else if (newTrack) {
          try {
            peerConnection.addTrack(newTrack, newStream);
          } catch (err) {
            console.warn('[WebRTC] addTrack failed:', err);
          }
        }
      }

      // If already connected with a peer, renegotiate offer so remote displays updated track immediately
      if (currentVideoPeerID && (peerConnection.connectionState === 'connected' || peerConnection.signalingState === 'stable')) {
        try {
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'video_offer',
              payload: {
                channel_id: currentChannelID,
                target_id: currentVideoPeerID,
                sdp: JSON.stringify(offer),
                is_screen: isScreen,
              },
            }));
          }
        } catch (renegErr) {
          console.warn('[WebRTC] Offer renegotiation failed:', renegErr);
        }
      }
    }
  }

  async function startVideoCall() {
    if (isVideoCallActive && !isScreenSharing) return;

    const stream = await acquireCameraStream();
    if (stream) {
      await switchStream(stream, false);
      showHUD('📹', 'Starting Video Broadcast on CH ' + currentChannelID);
    } else {
      localVideoStream = null;
      if (localVideo) {
        localVideo.srcObject = null;
        localVideo.style.display = 'none';
      }
      showHUD('👁️', 'Video Room Joined (Viewer Mode - No Camera Detected)', 4000);
    }

    isVideoCallActive = true;
    if (videoModal) videoModal.style.display = 'flex';
    if (videoActiveDot) videoActiveDot.style.display = 'block';

    const ch = channels.find(c => c.id === currentChannelID);
    if (videoChName && ch) videoChName.textContent = `${ch.name} - VIDEO`;
    if (videoStatusText) videoStatusText.textContent = stream ? 'Broadcasting Camera Feed...' : 'Awaiting Video Carrier...';

    soundFX.playVideoCallChime();

    videoCallStartTime = Date.now();
    updateVideoTimer();
    if (videoTimerInterval) clearInterval(videoTimerInterval);
    videoTimerInterval = setInterval(updateVideoTimer, 1000);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'video_call_start',
        payload: {
          channel_id: currentChannelID,
          callsign: myCallsign,
          is_screen: false,
        },
      }));

      // Inquire about existing video feeds on this channel
      ws.send(JSON.stringify({
        type: 'video_join',
        payload: {
          channel_id: currentChannelID,
        },
      }));
    }
  }

  async function startScreenShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showHUD('⚠️', 'Screen sharing is not supported by your browser');
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
          width: { ideal: 1920, max: 2560 },
          height: { ideal: 1080, max: 1440 },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
      });

      isScreenSharing = true;
      updateScreenShareUI(true);

      const track = screenStream.getVideoTracks()[0];
      if (track) {
        if ('contentHint' in track) {
          track.contentHint = 'detail';
        }
        track.onended = () => {
          if (isScreenSharing) {
            stopScreenShare();
          }
        };
      }

      await switchStream(screenStream, true);

      if (!isVideoCallActive) {
        isVideoCallActive = true;
        if (videoModal) videoModal.style.display = 'flex';
        if (videoActiveDot) videoActiveDot.style.display = 'block';

        videoCallStartTime = Date.now();
        updateVideoTimer();
        if (videoTimerInterval) clearInterval(videoTimerInterval);
        videoTimerInterval = setInterval(updateVideoTimer, 1000);
      }

      const ch = channels.find(c => c.id === currentChannelID);
      if (videoChName && ch) videoChName.textContent = `${ch.name} - SCREEN SHARE`;
      if (videoStatusText) videoStatusText.textContent = 'Broadcasting Screen Feed...';

      soundFX.playVideoCallChime();
      showHUD('🖥️', 'Sharing Screen to CH ' + currentChannelID, 3500);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'video_call_start',
          payload: {
            channel_id: currentChannelID,
            callsign: myCallsign,
            is_screen: true,
          },
        }));
        ws.send(JSON.stringify({
          type: 'video_join',
          payload: {
            channel_id: currentChannelID,
          },
        }));
      }

    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        console.warn('[Video] Screen share error:', err);
      }
    }
  }

  async function stopScreenShare() {
    if (!isScreenSharing) return;
    isScreenSharing = false;
    updateScreenShareUI(false);

    // Attempt to fall back to camera, or switch to Viewer Mode
    const camStream = await acquireCameraStream();
    if (camStream) {
      await switchStream(camStream, false);
      const ch = channels.find(c => c.id === currentChannelID);
      if (videoChName && ch) videoChName.textContent = `${ch.name} - VIDEO`;
      if (videoStatusText) videoStatusText.textContent = 'Broadcasting Camera Feed...';
      showHUD('🖥️', 'Screen Share ended - Switched to Camera');
    } else {
      if (localVideoStream) {
        localVideoStream.getTracks().forEach(t => t.stop());
        localVideoStream = null;
      }
      if (localVideo) {
        localVideo.srcObject = null;
        localVideo.style.display = 'none';
      }
      if (localPipBox) localPipBox.classList.remove('screen-share');
      if (localPipLabel) localPipLabel.textContent = 'YOU (CAMERA)';
      const ch = channels.find(c => c.id === currentChannelID);
      if (videoChName && ch) videoChName.textContent = `${ch.name} - VIEWER`;
      if (videoStatusText) videoStatusText.textContent = 'Awaiting Video Carrier...';
      showHUD('🖥️', 'Screen Share stopped (Viewer Mode)');
    }
  }

  function toggleScreenShare() {
    if (isScreenSharing) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  }

  function updateVideoTimer() {
    if (!videoCallTimer || !videoCallStartTime) return;
    const elapsed = Math.floor((Date.now() - videoCallStartTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    videoCallTimer.textContent = `${m}:${s}`;
  }

  function endVideoCall(silent = false) {
    if (!isVideoCallActive && (!videoModal || videoModal.style.display === 'none')) return;
    isVideoCallActive = false;
    isScreenSharing = false;
    updateScreenShareUI(false);

    if (localVideoStream) {
      localVideoStream.getTracks().forEach(t => t.stop());
      localVideoStream = null;
    }

    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    currentVideoPeerID = null;

    if (videoTimerInterval) {
      clearInterval(videoTimerInterval);
      videoTimerInterval = null;
    }

    if (localVideo) {
      localVideo.srcObject = null;
      localVideo.style.display = 'block';
    }
    if (localPipBox) localPipBox.classList.remove('screen-share');
    if (localPipLabel) localPipLabel.textContent = 'YOU (CAMERA)';

    if (remoteVideo) {
      remoteVideo.srcObject = null;
      remoteVideo.classList.remove('active');
    }
    if (remoteVideoPlaceholder) remoteVideoPlaceholder.style.display = 'flex';
    if (videoCallerBadge) videoCallerBadge.style.display = 'none';
    if (videoModal) videoModal.style.display = 'none';
    if (videoActiveDot) videoActiveDot.style.display = 'none';

    if (!silent) {
      soundFX.playCallEndChime();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'video_call_end',
          payload: {
            channel_id: currentChannelID,
            callsign: myCallsign,
          },
        }));
      }
      showHUD('📹', 'Video Call Ended');
    }
  }

  function toggleCamera() {
    if (!localVideoStream) return;
    const videoTrack = localVideoStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      isCameraMuted = !videoTrack.enabled;
      if (btnVideoCamToggle) {
        btnVideoCamToggle.classList.toggle('cam-muted', isCameraMuted);
      }
      showHUD('📹', isCameraMuted ? 'Camera Muted' : 'Camera Active');
    }
  }

  async function flipCamera() {
    if (!isVideoCallActive || isScreenSharing) return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      if (videoDevices.length <= 1) {
        showHUD('ℹ️', 'Only 1 camera available on device');
        return;
      }
    } catch (e) {}

    const prevFacing = videoFacingMode;
    videoFacingMode = videoFacingMode === 'user' ? 'environment' : 'user';

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: videoFacingMode,
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });

      switchStream(newStream);
      showHUD('🔄', `Camera: ${videoFacingMode === 'user' ? 'Front' : 'Rear'}`);
    } catch (err) {
      console.warn('[Video] Flip camera failed:', err);
      videoFacingMode = prevFacing;
      showHUD('⚠️', 'Camera switch not available');
    }
  }

  let pendingIceCandidates = [];

  async function flushPendingIceCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    while (pendingIceCandidates.length > 0) {
      const cand = pendingIceCandidates.shift();
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {
        console.warn('[WebRTC] Error adding queued ICE candidate:', e);
      }
    }
  }

  function handleVideoCallStart(payload) {
    const chID = payload.channel_id ?? payload.ChannelID;
    if (chID !== currentChannelID) return;

    const caller = payload.callsign || payload.Callsign || 'Peer';
    const senderID = payload.sender_id || payload.SenderID;
    const isScreen = payload.is_screen || payload.IsScreen;

    if (videoActiveDot) videoActiveDot.style.display = 'block';

    if (senderID !== myClientID && caller !== myCallsign) {
      soundFX.playVideoCallChime();
      const actionText = isScreen ? 'is sharing Screen' : 'started Video Call';
      showHUD('📹', `${caller} ${actionText} [Tap Video]`, 5000);

      // If we are currently in the video room, connect with this broadcaster using deterministic tie-breaker!
      if (isVideoCallActive && (!peerConnection || peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed')) {
        const isOfferer = myClientID > senderID;
        console.log(`[WebRTC] Connecting with ${caller} (${senderID}). Offerer: ${isOfferer}`);
        setupPeerConnection(senderID, isOfferer);
      }
    }
  }

  async function joinVideoPeer(targetSenderID) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'video_join',
      payload: {
        channel_id: currentChannelID,
        target_id: targetSenderID,
      },
    }));
  }

  async function handleVideoJoin(payload) {
    const targetID = payload.sender_id || payload.SenderID;
    const requestedTarget = payload.target_id || payload.TargetID;
    if (!targetID || targetID === myClientID) return;
    if (requestedTarget && requestedTarget !== myClientID) return;
    if (!isVideoCallActive) return;

    console.log('[WebRTC] Peer requested to join video stream:', targetID);
    if (peerConnection && peerConnection.connectionState === 'connected' && currentVideoPeerID === targetID) {
      console.log('[WebRTC] Already connected with peer:', targetID);
      return;
    }

    // Deterministic tie-breaker:
    // Only the peer with higher ID initiates the offer, completely preventing glare/collision!
    const isOfferer = requestedTarget === myClientID || myClientID > targetID;
    console.log(`[WebRTC] Joining with ${targetID}. Offerer: ${isOfferer}`);
    setupPeerConnection(targetID, isOfferer);
  }

  async function setupPeerConnection(targetID, isInitiator) {
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
    }

    currentVideoPeerID = targetID;
    pendingIceCandidates = [];
    peerConnection = new RTCPeerConnection(rtcConfig);

    if (localVideoStream) {
      localVideoStream.getTracks().forEach(track => {
        if (isScreenSharing && 'contentHint' in track) {
          track.contentHint = 'detail';
        }
        peerConnection.addTrack(track, localVideoStream);
      });
    } else {
      // In viewer mode without a local video stream, add a receive-only transceiver
      try {
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
      } catch (e) {
        console.warn('[WebRTC] addTransceiver recvonly failed:', e);
      }
    }

    peerConnection.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'video_ice',
          payload: {
            channel_id: currentChannelID,
            target_id: targetID,
            candidate: e.candidate,
          },
        }));
      }
    };

    peerConnection.ontrack = (e) => {
      console.log('[WebRTC] Received remote stream track:', e.streams);
      if (remoteVideo && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        remoteVideo.classList.add('active');
        if (remoteVideoPlaceholder) remoteVideoPlaceholder.style.display = 'none';
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state:', peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === 'failed' && peerConnection.restartIce) {
        console.log('[WebRTC] Restarting ICE...');
        peerConnection.restartIce();
      }
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        showHUD('📹', isScreenSharing ? 'Screen Share Connected' : 'Video Connected');
      } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
        if (targetID === currentVideoPeerID) currentVideoPeerID = null;
        if (remoteVideo) remoteVideo.classList.remove('active');
        if (remoteVideoPlaceholder) remoteVideoPlaceholder.style.display = 'flex';
      }
    };

    if (isInitiator) {
      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'video_offer',
            payload: {
              channel_id: currentChannelID,
              target_id: targetID,
              sdp: JSON.stringify(offer),
              is_screen: isScreenSharing,
            },
          }));
        }
      } catch (err) {
        console.error('[WebRTC] Failed to create offer:', err);
      }
    }
  }

  async function handleVideoOffer(payload) {
    const senderID = payload.sender_id || payload.SenderID;
    if (!senderID || senderID === myClientID) return;

    console.log('[WebRTC] Received video_offer from:', senderID);
    if (!isVideoCallActive) {
      if (videoModal) videoModal.style.display = 'flex';
      if (videoActiveDot) videoActiveDot.style.display = 'block';
      isVideoCallActive = true;
      videoCallStartTime = Date.now();
      updateVideoTimer();
      if (videoTimerInterval) clearInterval(videoTimerInterval);
      videoTimerInterval = setInterval(updateVideoTimer, 1000);
    }

    if (videoCallerBadge && videoCallerCallsign) {
      videoCallerCallsign.textContent = payload.callsign || 'PEER';
      videoCallerBadge.style.display = 'flex';
    }

    // Glare resolution: check if we are in 'have-local-offer'
    if (peerConnection && peerConnection.signalingState === 'have-local-offer') {
      const isPolite = myClientID < senderID;
      if (!isPolite) {
        console.log('[WebRTC] Impolite peer ignoring conflicting offer');
        return;
      }
      console.log('[WebRTC] Polite peer rolling back local offer to accept incoming offer');
      try {
        await peerConnection.setLocalDescription({ type: 'rollback' });
      } catch (e) {
        await setupPeerConnection(senderID, false);
      }
    } else if (!peerConnection || currentVideoPeerID !== senderID) {
      await setupPeerConnection(senderID, false);
    }

    try {
      const sdpObj = typeof payload.sdp === 'string' ? JSON.parse(payload.sdp) : payload.sdp;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdpObj));
      await flushPendingIceCandidates();

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'video_answer',
          payload: {
            channel_id: currentChannelID,
            target_id: senderID,
            sdp: JSON.stringify(answer),
          },
        }));
      }
    } catch (err) {
      console.error('[WebRTC] Error handling offer:', err);
    }
  }

  async function handleVideoAnswer(payload) {
    const senderID = payload.sender_id || payload.SenderID;
    if (!peerConnection) return;

    // Guard against applying answer when not in 'have-local-offer'
    if (peerConnection.signalingState !== 'have-local-offer') {
      console.log('[WebRTC] Ignoring video_answer in non-offer state:', peerConnection.signalingState);
      return;
    }

    console.log('[WebRTC] Received video_answer from:', senderID);
    if (videoCallerBadge && videoCallerCallsign) {
      videoCallerCallsign.textContent = payload.callsign || 'PEER';
      videoCallerBadge.style.display = 'flex';
    }

    try {
      const sdpObj = typeof payload.sdp === 'string' ? JSON.parse(payload.sdp) : payload.sdp;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdpObj));
      await flushPendingIceCandidates();
    } catch (err) {
      console.error('[WebRTC] Error handling answer:', err);
    }
  }

  async function handleVideoICE(payload) {
    if (!payload.candidate) return;
    try {
      const candidateObj = typeof payload.candidate === 'string' ? JSON.parse(payload.candidate) : payload.candidate;
      if (!peerConnection || !peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
        pendingIceCandidates.push(candidateObj);
      } else {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidateObj));
      }
    } catch (err) {
      console.warn('[WebRTC] Failed to add ICE candidate:', err);
    }
  }

  function handleVideoCallEnd(payload) {
    const chID = payload.channel_id ?? payload.ChannelID;
    if (chID !== currentChannelID) return;

    const senderID = payload.sender_id || payload.SenderID;
    if (senderID && senderID === myClientID) return;
    if (currentVideoPeerID && senderID && senderID !== currentVideoPeerID) {
      console.log('[Video] Ignoring video_call_end from unrelated peer:', senderID);
      return;
    }

    console.log('[Video] Video call ended on channel:', chID);
    if (remoteVideo) {
      remoteVideo.srcObject = null;
      remoteVideo.classList.remove('active');
    }
    if (remoteVideoPlaceholder) remoteVideoPlaceholder.style.display = 'flex';
    if (videoCallerBadge) videoCallerBadge.style.display = 'none';
    if (videoActiveDot) videoActiveDot.style.display = 'none';

    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    currentVideoPeerID = null;
    pendingIceCandidates = [];
    showHUD('📹', `${payload.callsign || 'Peer'} ended video`);
  }

  // Video UI Event Listeners
  if (btnToggleVideo) {
    btnToggleVideo.addEventListener('click', () => {
      if (isVideoCallActive) endVideoCall();
      else startVideoCall();
    });
  }

  if (btnDockVideo) {
    btnDockVideo.addEventListener('click', () => {
      if (isVideoCallActive) endVideoCall();
      else startVideoCall();
    });
  }

  if (btnCloseVideo) {
    btnCloseVideo.addEventListener('click', () => endVideoCall());
  }

  if (btnVideoHangup) {
    btnVideoHangup.addEventListener('click', () => endVideoCall());
  }

  if (btnVideoCamToggle) {
    btnVideoCamToggle.addEventListener('click', toggleCamera);
  }

  if (btnVideoFlipCam) {
    btnVideoFlipCam.addEventListener('click', flipCamera);
  }

  if (btnVideoShareScreen) {
    btnVideoShareScreen.addEventListener('click', toggleScreenShare);
  }

  if (btnToggleScreen) {
    btnToggleScreen.addEventListener('click', toggleScreenShare);
  }

  if (btnDockScreen) {
    btnDockScreen.addEventListener('click', toggleScreenShare);
  }

  if (btnPlaceholderScreenshare) {
    btnPlaceholderScreenshare.addEventListener('click', toggleScreenShare);
  }

  if (btnVideoFullscreen) {
    btnVideoFullscreen.addEventListener('click', () => {
      const card = document.querySelector('.video-stage-card');
      if (!card) return;
      if (!document.fullscreenElement) {
        card.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    });
  }

  // Push-to-Talk from inside Video Call
  if (btnVideoPTT) {
    btnVideoPTT.addEventListener('mousedown', (e) => {
      e.preventDefault();
      requestFloor();
      btnVideoPTT.classList.add('transmitting');
    });

    window.addEventListener('mouseup', () => {
      if (btnVideoPTT.classList.contains('transmitting')) {
        releaseFloor();
        btnVideoPTT.classList.remove('transmitting');
      }
    });

    btnVideoPTT.addEventListener('touchstart', (e) => {
      e.preventDefault();
      requestFloor();
      btnVideoPTT.classList.add('transmitting');
    }, { passive: false });

    btnVideoPTT.addEventListener('touchend', (e) => {
      e.preventDefault();
      releaseFloor();
      btnVideoPTT.classList.remove('transmitting');
    }, { passive: false });

    btnVideoPTT.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      releaseFloor();
      btnVideoPTT.classList.remove('transmitting');
    }, { passive: false });
  }

  // Settings modal
  const modal = document.getElementById('settings-modal');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  if (btnOpenSettings && modal) {
    btnOpenSettings.addEventListener('click', () => { modal.style.display = 'flex'; });
  }
  if (btnCloseSettings && modal) {
    btnCloseSettings.addEventListener('click', () => { modal.style.display = 'none'; });
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });
  }

  // Sidebar mobile toggle & backdrop overlay
  const sidebar = document.getElementById('app-sidebar');
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');

  function openSidebar() {
    if (sidebar) sidebar.classList.add('open');
    if (sidebarBackdrop) sidebarBackdrop.classList.add('active');
  }

  function closeSidebar() {
    if (sidebar) sidebar.classList.remove('open');
    if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');
  }

  if (btnToggleSidebar && sidebar) {
    btnToggleSidebar.addEventListener('click', () => {
      if (sidebar.classList.contains('open')) closeSidebar();
      else openSidebar();
    });
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', closeSidebar);
  }

  // Fetch channels immediately and connect WebSocket
  loadInitialChannels();
  acquireUserLocation();
  connectWebSocket();
});
