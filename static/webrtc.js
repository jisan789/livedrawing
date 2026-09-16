/**
 * LiveDraw WebRTC Mesh & Signaling Manager
 * Manages low-latency DataChannels for real-time stroke streaming with WebSocket fallback.
 */

class WebRTCManager {
  constructor(options = {}) {
    this.userId = null;
    this.userColor = null;
    this.requestedUsername = options.requestedUsername || null;
    this.pin = options.pin || null;
    this.iceServers = [];
    this.peers = new Map(); // peerId -> { pc, liveChannel, reliableChannel, isConnected }
    this.ws = null;
    this.isConnected = false;

    // Metrics tracking
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.packetsSent = 0;
    this.packetsReceived = 0;
    this.latencyMs = 0;

    // Callbacks
    this.onWelcome = options.onWelcome || (() => {});
    this.onUsernameConfirmed = options.onUsernameConfirmed || (() => {});
    this.onPeerJoined = options.onPeerJoined || (() => {});
    this.onPeerLeft = options.onPeerLeft || (() => {});
    this.onPeerRenamed = options.onPeerRenamed || (() => {});
    this.onBinaryMessage = options.onBinaryMessage || (() => {});
    this.onBoardUndo = options.onBoardUndo || (() => {});
    this.onBoardRedo = options.onBoardRedo || (() => {});
    this.onBoardClear = options.onBoardClear || (() => {});
    this.onStrokeMove = options.onStrokeMove || (() => {});
    this.onStatsUpdate = options.onStatsUpdate || (() => {});
    this.onChatMessage = options.onChatMessage || (() => {});
    this.onInvalidPin = options.onInvalidPin || (() => {});

    this.init();
  }

  async init() {
    try {
      // 1. Fetch ICE configuration from server
      const res = await fetch('/api/config');
      const data = await res.json();
      this.iceServers = data.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    } catch (e) {
      console.warn('Using fallback STUN servers:', e);
      this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    }

    // 2. Connect WebSocket for signaling
    this.connectSignaling();
    this.startPingLoop();
  }

  connectSignaling() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/ws`;
    const params = [];
    if (this.requestedUsername) {
      params.push(`username=${encodeURIComponent(this.requestedUsername)}`);
    }
    if (this.pin) {
      params.push(`pin=${encodeURIComponent(this.pin)}`);
    }
    if (params.length > 0) {
      wsUrl += `?${params.join('&')}`;
    }

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log('Connected to signaling server');
    };

    this.ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.trackReceived(event.data.byteLength);
        this.onBinaryMessage(event.data);
        return;
      }

      try {
        const msg = JSON.parse(event.data);
        this.trackReceived(event.data.length);
        this.handleSignalingMessage(msg);
      } catch (e) {
        console.error('Signaling JSON error:', e);
      }
    };

    this.ws.onclose = (event) => {
      this.isConnected = false;
      if (event && event.code === 4001) {
        console.error('WebSocket close: Invalid PIN (code 4001)');
        this.onInvalidPin();
        return;
      }
      console.warn('Signaling WebSocket closed. Reconnecting in 2s...');
      setTimeout(() => this.connectSignaling(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('Signaling WebSocket error:', err);
    };
  }

  setUsername(newName) {
    if (!newName || !newName.trim()) return;
    this.requestedUsername = newName.trim();
    this.sendServerMessage({
      type: 'set_username',
      username: this.requestedUsername,
    });
  }

  handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.userId = msg.user_id;
        this.userColor = msg.color;
        this.onWelcome(msg);

        // Initiate WebRTC peer connections with existing peers
        if (Array.isArray(msg.peers)) {
          for (const peer of msg.peers) {
            this.createPeerConnection(peer.user_id, true);
          }
        }
        break;

      case 'username_confirmed':
        this.userId = msg.user_id;
        this.onUsernameConfirmed(msg.user_id);
        break;

      case 'peer_joined':
        this.onPeerJoined(msg);
        break;

      case 'peer_left':
        this.closePeerConnection(msg.user_id);
        this.onPeerLeft(msg);
        break;

      case 'peer_renamed':
        // Update peer tracking with new user ID
        if (this.peers.has(msg.old_user_id)) {
          const peerData = this.peers.get(msg.old_user_id);
          this.peers.delete(msg.old_user_id);
          this.peers.set(msg.new_user_id, peerData);
        }
        this.onPeerRenamed(msg);
        break;

      case 'signal':
        this.handlePeerSignal(msg.sender, msg.data);
        break;

      case 'stroke_move':
        this.onStrokeMove(msg);
        break;

      case 'board_undo':
        this.onBoardUndo(msg.stroke_id);
        break;

      case 'board_redo':
        this.onBoardRedo(msg.stroke_id);
        break;

      case 'board_clear':
        this.onBoardClear();
        break;

      case 'chat_message':
        this.onChatMessage(msg);
        break;

      case 'pong':
        if (msg.client_time) {
          const rtt = Math.round(performance.now() - msg.client_time);
          this.latencyMs = rtt;
        }
        break;
    }
  }

  sendChatMessage(text) {
    if (!text || !text.trim()) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.sendServerMessage({
      type: 'chat_message',
      text: text.trim(),
      time: timeStr,
    });
  }

  // =========================================================================
  // WebRTC PeerConnection & DataChannel Management
  // =========================================================================

  createPeerConnection(targetPeerId, isInitiator) {
    if (this.peers.has(targetPeerId)) return this.peers.get(targetPeerId);

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peerData = {
      pc,
      liveChannel: null,
      reliableChannel: null,
      isConnected: false,
    };
    this.peers.set(targetPeerId, peerData);

    // ICE Candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(targetPeerId, {
          candidate: event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        peerData.isConnected = true;
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        peerData.isConnected = false;
      }
    };

    if (isInitiator) {
      const liveDc = pc.createDataChannel('livedraw_live', {
        ordered: false,
        maxRetransmits: 0,
      });
      this.setupDataChannel(targetPeerId, liveDc, true);

      const reliableDc = pc.createDataChannel('livedraw_reliable', {
        ordered: true,
      });
      this.setupDataChannel(targetPeerId, reliableDc, false);

      pc.createOffer().then((offer) => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        this.sendSignal(targetPeerId, {
          sdp: pc.localDescription,
        });
      }).catch((err) => {
        console.error(`Error creating offer to ${targetPeerId}:`, err);
      });
    } else {
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        const isLive = dc.label === 'livedraw_live';
        this.setupDataChannel(targetPeerId, dc, isLive);
      };
    }

    return peerData;
  }

  setupDataChannel(peerId, dc, isLive) {
    dc.binaryType = 'arraybuffer';
    const peerData = this.peers.get(peerId);

    if (isLive) {
      peerData.liveChannel = dc;
    } else {
      peerData.reliableChannel = dc;
    }

    dc.onopen = () => {
      console.log(`DataChannel [${dc.label}] open with peer ${peerId}`);
    };

    dc.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.trackReceived(event.data.byteLength);
        this.onBinaryMessage(event.data);
      }
    };

    dc.onclose = () => {
      console.log(`DataChannel [${dc.label}] closed with peer ${peerId}`);
    };
  }

  async handlePeerSignal(senderId, signal) {
    let peerData = this.peers.get(senderId);
    if (!peerData) {
      peerData = this.createPeerConnection(senderId, false);
    }
    const pc = peerData.pc;

    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal(senderId, {
          sdp: pc.localDescription,
        });
      }
    } else if (signal.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch (e) {
        console.warn('ICE candidate add error:', e);
      }
    }
  }

  sendSignal(targetPeerId, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'signal',
        target: targetPeerId,
        data,
      }));
    }
  }

  closePeerConnection(peerId) {
    const peerData = this.peers.get(peerId);
    if (peerData) {
      try {
        if (peerData.liveChannel) peerData.liveChannel.close();
        if (peerData.reliableChannel) peerData.reliableChannel.close();
        peerData.pc.close();
      } catch (_) {}
      this.peers.delete(peerId);
    }
  }

  // =========================================================================
  // Data Transmission (Binary DataChannels with Server Sync)
  // =========================================================================

  broadcastBinary(arrayBuffer, isLiveHighFrequency = false) {
    this.trackSent(arrayBuffer.byteLength);
    let dcSentCount = 0;

    for (const [peerId, peer] of this.peers.entries()) {
      const channel = isLiveHighFrequency ? (peer.liveChannel || peer.reliableChannel) : peer.reliableChannel;
      if (channel && channel.readyState === 'open') {
        try {
          channel.send(arrayBuffer);
          dcSentCount++;
        } catch (e) {
          console.warn(`DataChannel send to ${peerId} failed:`, e);
        }
      }
    }

    return dcSentCount;
  }

  sendServerMessage(msgObj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const str = JSON.stringify(msgObj);
      this.trackSent(str.length);
      this.ws.send(str);
    }
  }

  trackSent(bytes) {
    this.bytesSent += bytes;
    this.packetsSent++;
  }

  trackReceived(bytes) {
    this.bytesReceived += bytes;
    this.packetsReceived++;
  }

  startPingLoop() {
    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'ping',
          client_time: performance.now(),
        }));
      }
    }, 2000);
  }

  getOpenChannelCount() {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.liveChannel && peer.liveChannel.readyState === 'open') count++;
      if (peer.reliableChannel && peer.reliableChannel.readyState === 'open') count++;
    }
    return count;
  }

  getStats() {
    return {
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      latencyMs: this.latencyMs,
      openChannels: this.getOpenChannelCount(),
      peerCount: this.peers.size,
    };
  }
}
