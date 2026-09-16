/**
 * LiveDraw Main Application Coordinator
 * Connects Canvas, WebRTC DataChannels, Protocol, and Mobile UI.
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const container = document.getElementById('canvas-container');
  const userCountDisplay = document.getElementById('user-count-display');
  const latencyDisplay = document.getElementById('latency-display');
  const myUserIdDisplay = document.getElementById('my-user-id');
  const myUserDot = document.getElementById('my-user-dot');
  const webrtcStatus = document.getElementById('webrtc-status');

  // Tool Buttons
  const toolPen = document.getElementById('tool-pen');
  const toolEraser = document.getElementById('tool-eraser');
  const btnColorTrigger = document.getElementById('btn-color-trigger');
  const btnSizeTrigger = document.getElementById('btn-size-trigger');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnClear = document.getElementById('btn-clear');
  const btnStatsToggle = document.getElementById('btn-stats-toggle');

  // Floating Trays
  const colorTray = document.getElementById('color-tray');
  const sizeTray = document.getElementById('size-tray');
  const colorSwatches = document.querySelectorAll('.color-swatch');
  const customColorInput = document.getElementById('custom-color-input');
  const activeColorIndicator = document.getElementById('active-color-indicator');
  const sizeSlider = document.getElementById('size-slider');
  const sizePreviewDot = document.getElementById('size-preview-dot');
  const sizeValueDisplay = document.getElementById('size-value-display');
  const activeSizeLabel = document.getElementById('active-size-label');

  // Stats Modal Elements
  const statsModal = document.getElementById('stats-modal');
  const btnCloseStats = document.getElementById('btn-close-stats');
  const statUsers = document.getElementById('stat-users');
  const statWebRTC = document.getElementById('stat-webrtc');
  const statChannels = document.getElementById('stat-channels');
  const statLatency = document.getElementById('stat-latency');
  const statBytesSent = document.getElementById('stat-bytes-sent');
  const statBytesRecv = document.getElementById('stat-bytes-recv');
  const statPacketsSent = document.getElementById('stat-packets-sent');
  const statPacketsRecv = document.getElementById('stat-packets-recv');
  const statStrokePoints = document.getElementById('stat-stroke-points');
  const statTotalStrokes = document.getElementById('stat-total-strokes');
  const statReduction = document.getElementById('stat-reduction');

  let currentUserId = 'ME';
  let currentUserColor = '#3b82f6';
  let activeTool = 0; // 0 = Pen, 1 = Eraser
  let activeColor = '#1e1e1e';
  let activeBrushSize = 4;

  // Initialize WebRTC Manager
  const net = new WebRTCManager({
    onWelcome: (msg) => {
      currentUserId = msg.user_id;
      currentUserColor = msg.color;
      myUserIdDisplay.textContent = `YOU (${currentUserId})`;
      myUserDot.style.backgroundColor = currentUserColor;
      userCountDisplay.textContent = `${msg.user_count} ${msg.user_count === 1 ? 'USER' : 'USERS'}`;

      if (canvas) {
        canvas.userId = currentUserId;
        if (msg.board) {
          canvas.loadSnapshot(msg.board);
        }
      }
      showToast(`Connected as User ${currentUserId}`);
    },

    onPeerJoined: (msg) => {
      userCountDisplay.textContent = `${msg.user_count} USERS`;
      showToast(`User ${msg.user_id} joined`);
    },

    onPeerLeft: (msg) => {
      userCountDisplay.textContent = `${msg.user_count} ${msg.user_count === 1 ? 'USER' : 'USERS'}`;
      if (canvas) {
        canvas.removeRemoteUser(msg.user_id);
      }
      showToast(`User ${msg.user_id} left`);
    },

    onBinaryMessage: (arrayBuffer) => {
      const msg = Protocol.decode(arrayBuffer);
      if (!msg) return;

      switch (msg.type) {
        case 'stroke_start':
          canvas.handleRemoteStrokeStart(msg);
          break;
        case 'stroke_chunk':
          canvas.handleRemoteStrokeChunk(msg);
          break;
        case 'stroke_end':
          canvas.handleRemoteStrokeEnd(msg.strokeId);
          break;
        case 'stroke_undo':
          canvas.applyUndo(msg.strokeId);
          break;
        case 'stroke_redo':
          canvas.applyRedo(msg.strokeId);
          break;
        case 'board_clear':
          canvas.clearBoard();
          showToast('Board cleared');
          break;
        case 'cursor_move':
          canvas.handleRemoteCursor(msg);
          break;
      }
    },

    onBoardUndo: (strokeId) => {
      if (strokeId) canvas.applyUndo(strokeId);
    },

    onBoardRedo: (strokeId) => {
      if (strokeId) canvas.applyRedo(strokeId);
    },

    onBoardClear: () => {
      canvas.clearBoard();
      showToast('Board cleared');
    },
  });

  // Initialize Canvas Engine
  const canvas = new DrawingCanvas(container, {
    userId: currentUserId,

    onStrokeStart: (stroke) => {
      const buffer = Protocol.encodeStrokeStart(
        stroke.id,
        stroke.userId,
        stroke.tool,
        stroke.color,
        stroke.size,
        stroke.x,
        stroke.y
      );
      net.broadcastBinary(buffer, false);
      net.sendServerMessage({
        type: 'stroke_start',
        stroke: {
          id: stroke.id,
          tool: stroke.tool,
          color: stroke.color,
          size: stroke.size,
          x: stroke.x,
          y: stroke.y,
        },
      });
    },

    onStrokeChunk: (chunk) => {
      const buffer = Protocol.encodeStrokeChunk(chunk.strokeId, chunk.seq, chunk.points);
      net.broadcastBinary(buffer, true); // live fast UDP channel
      net.sendServerMessage({
        type: 'stroke_chunk',
        stroke_id: chunk.strokeId,
        seq: chunk.seq,
        points: chunk.points,
      });
    },

    onStrokeEnd: (strokeId) => {
      const buffer = Protocol.encodeStrokeEnd(strokeId);
      net.broadcastBinary(buffer, false);
      net.sendServerMessage({
        type: 'stroke_end',
        stroke_id: strokeId,
      });
    },

    onCursorMove: (normX, normY, isDrawing) => {
      const buffer = Protocol.encodeCursorMove(currentUserId, normX, normY, isDrawing);
      net.broadcastBinary(buffer, true);
    },
  });

  // =========================================================================
  // Tool & Action Handlers
  // =========================================================================

  function selectTool(toolIndex) {
    activeTool = toolIndex;
    canvas.setTool(toolIndex);

    if (toolIndex === 0) {
      toolPen.classList.add('active');
      toolEraser.classList.remove('active');
    } else {
      toolEraser.classList.add('active');
      toolPen.classList.remove('active');
    }
    closeTrays();
  }

  function setColor(hex) {
    activeColor = hex;
    canvas.setColor(hex);
    activeColorIndicator.style.backgroundColor = hex;
    sizePreviewDot.style.backgroundColor = hex;

    colorSwatches.forEach(s => {
      if (s.dataset.color.toLowerCase() === hex.toLowerCase()) {
        s.classList.add('active');
      } else {
        s.classList.remove('active');
      }
    });

    if (activeTool === 1) {
      selectTool(0); // Switch back to pen if user selects color
    }
  }

  function setBrushSize(size) {
    activeBrushSize = parseInt(size, 10);
    canvas.setBrushSize(activeBrushSize);
    sizeSlider.value = activeBrushSize;
    sizeValueDisplay.textContent = `${activeBrushSize}px`;
    activeSizeLabel.textContent = `${activeBrushSize}px`;
    sizePreviewDot.style.width = `${Math.min(32, Math.max(2, activeBrushSize))}px`;
    sizePreviewDot.style.height = `${Math.min(32, Math.max(2, activeBrushSize))}px`;
  }

  function closeTrays() {
    colorTray.classList.add('hidden');
    sizeTray.classList.add('hidden');
  }

  // Event Listeners for UI
  toolPen.addEventListener('click', () => selectTool(0));
  toolEraser.addEventListener('click', () => selectTool(1));

  btnColorTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = colorTray.classList.contains('hidden');
    closeTrays();
    if (isHidden) colorTray.classList.remove('hidden');
  });

  btnSizeTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = sizeTray.classList.contains('hidden');
    closeTrays();
    if (isHidden) sizeTray.classList.remove('hidden');
  });

  colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      setColor(swatch.dataset.color);
      closeTrays();
    });
  });

  customColorInput.addEventListener('input', (e) => {
    setColor(e.target.value);
  });

  sizeSlider.addEventListener('input', (e) => {
    setBrushSize(e.target.value);
  });

  // Undo / Redo / Clear
  btnUndo.addEventListener('click', () => {
    closeTrays();
    net.sendServerMessage({ type: 'stroke_undo' });
  });

  btnRedo.addEventListener('click', () => {
    closeTrays();
    net.sendServerMessage({ type: 'stroke_redo' });
  });

  btnClear.addEventListener('click', () => {
    closeTrays();
    if (confirm('Clear the shared whiteboard for everyone?')) {
      const buffer = Protocol.encodeBoardClear(currentUserId);
      net.broadcastBinary(buffer, false);
      net.sendServerMessage({ type: 'board_clear' });
      canvas.clearBoard();
    }
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        btnRedo.click();
      } else {
        btnUndo.click();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      btnRedo.click();
    } else if (e.key.toLowerCase() === 'p') {
      selectTool(0);
    } else if (e.key.toLowerCase() === 'e') {
      selectTool(1);
    }
  });

  // Close floating trays when clicking outside
  document.addEventListener('click', (e) => {
    if (!colorTray.contains(e.target) && !btnColorTrigger.contains(e.target) &&
        !sizeTray.contains(e.target) && !btnSizeTrigger.contains(e.target)) {
      closeTrays();
    }
  });

  // Stats Modal
  btnStatsToggle.addEventListener('click', () => {
    updateStatsModal();
    statsModal.classList.remove('hidden');
  });

  btnCloseStats.addEventListener('click', () => {
    statsModal.classList.add('hidden');
  });

  statsModal.addEventListener('click', (e) => {
    if (e.target === statsModal) {
      statsModal.classList.add('hidden');
    }
  });

  // =========================================================================
  // Metrics & Stats Monitor Loop
  // =========================================================================

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function updateStatsModal() {
    const netStats = net.getStats();
    const canvasStats = canvas.getMetrics();

    statUsers.textContent = `${netStats.peerCount + 1}`;
    statChannels.textContent = `${netStats.openChannels}`;
    statLatency.textContent = netStats.latencyMs > 0 ? `${netStats.latencyMs} ms` : '< 10 ms';
    statBytesSent.textContent = formatBytes(netStats.bytesSent);
    statBytesRecv.textContent = formatBytes(netStats.bytesReceived);
    statPacketsSent.textContent = netStats.packetsSent.toLocaleString();
    statPacketsRecv.textContent = netStats.packetsReceived.toLocaleString();
    statStrokePoints.textContent = canvasStats.sampledPoints.toLocaleString();
    statTotalStrokes.textContent = canvasStats.totalStrokes.toLocaleString();
    statReduction.textContent = `~${canvasStats.reductionPercent}%`;

    const isDirectP2P = netStats.openChannels > 0;
    statWebRTC.textContent = isDirectP2P ? 'P2P Mesh (Active)' : 'WebSocket Fallback';
    statWebRTC.className = `stat-value ${isDirectP2P ? 'text-green' : 'highlight'}`;
  }

  // Periodic metrics update for header pills
  setInterval(() => {
    const netStats = net.getStats();
    latencyDisplay.textContent = netStats.latencyMs > 0 ? `${netStats.latencyMs} ms` : '< 10 ms';
    
    if (netStats.openChannels > 0) {
      webrtcStatus.textContent = 'P2P DC';
      webrtcStatus.parentElement.style.color = '#10b981';
    } else {
      webrtcStatus.textContent = 'LIVE WS';
      webrtcStatus.parentElement.style.color = '#3b82f6';
    }

    if (!statsModal.classList.contains('hidden')) {
      updateStatsModal();
    }
  }, 500);

  // Toast Notification System
  function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2200);
  }

  // Initialize defaults
  setColor('#1e1e1e');
  setBrushSize(4);
});
