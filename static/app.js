/**
 * LiveDraw Main Application Coordinator
 * Connects Canvas, WebRTC DataChannels, Protocol, Direct On-Canvas Text Tool, and Mobile UI.
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const container = document.getElementById('canvas-container');
  const userCountDisplay = document.getElementById('user-count-display');
  const latencyDisplay = document.getElementById('latency-display');
  const myUserTag = document.getElementById('my-user-tag');
  const myUserIdDisplay = document.getElementById('my-user-id');
  const myUserDot = document.getElementById('my-user-dot');

  // Name Modal Elements
  const nameModal = document.getElementById('name-modal');
  const nameForm = document.getElementById('name-form');
  const usernameInput = document.getElementById('username-input');
  const btnRandomName = document.getElementById('btn-random-name');
  const btnSaveName = document.getElementById('btn-save-name');
  const nameModalTitle = document.getElementById('name-modal-title');
  const nameModalSubtitle = document.getElementById('name-modal-subtitle');

  // Direct On-Canvas Text Editor Element
  const directTextEditor = document.getElementById('direct-text-editor');

  // Tool Buttons
  const toolPen = document.getElementById('tool-pen');
  const toolEraser = document.getElementById('tool-eraser');
  const toolText = document.getElementById('tool-text');
  const btnColorTrigger = document.getElementById('btn-color-trigger');
  const btnSizeTrigger = document.getElementById('btn-size-trigger');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnClear = document.getElementById('btn-clear');

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

  let currentUserId = 'ME';
  let currentUserColor = '#3b82f6';
  let activeTool = 0; // 0 = Pen, 1 = Eraser, 2 = Text
  let activeColor = '#1e1e1e';
  let activeBrushSize = 2;
  let net = null;
  let canvas = null;
  let pendingTextPos = null;
  let currentTextStrokeId = 0;

  // Nickname Generators
  const ADJECTIVES = ['Creative', 'Swift', 'Bright', 'Cosmic', 'Neon', 'Velvet', 'Lunar', 'Solar', 'Epic', 'Wild'];
  const NOUNS = ['Artist', 'Fox', 'Hawk', 'Doodle', 'Painter', 'Pixel', 'Pencil', 'Spark', 'Comet', 'Wave'];

  function generateRandomName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(100 + Math.random() * 900);
    return `${adj}${noun}_${num}`;
  }

  // =========================================================================
  // Username & LocalStorage Management
  // =========================================================================

  let savedUsername = localStorage.getItem('livedraw_username');

  function initApp(chosenName) {
    if (net) return;

    currentUserId = chosenName || generateRandomName();
    myUserIdDisplay.textContent = `YOU (${currentUserId})`;

    // Initialize WebRTC Manager
    net = new WebRTCManager({
      requestedUsername: currentUserId,

      onWelcome: (msg) => {
        currentUserId = msg.user_id;
        currentUserColor = msg.color;
        localStorage.setItem('livedraw_username', currentUserId);
        myUserIdDisplay.textContent = `YOU (${currentUserId})`;
        myUserDot.style.backgroundColor = currentUserColor;
        userCountDisplay.textContent = `${msg.user_count} ${msg.user_count === 1 ? 'USER' : 'USERS'}`;

        if (canvas) {
          canvas.userId = currentUserId;
          if (msg.board) {
            canvas.loadSnapshot(msg.board);
          }
        }
        showToast(`Connected as ${currentUserId}`);
      },

      onUsernameConfirmed: (confirmedName) => {
        currentUserId = confirmedName;
        localStorage.setItem('livedraw_username', currentUserId);
        myUserIdDisplay.textContent = `YOU (${currentUserId})`;
        if (canvas) canvas.userId = currentUserId;
        showToast(`Display name set to ${currentUserId}`);
      },

      onPeerJoined: (msg) => {
        userCountDisplay.textContent = `${msg.user_count} USERS`;
        showToast(`${msg.user_id} joined`);
      },

      onPeerLeft: (msg) => {
        userCountDisplay.textContent = `${msg.user_count} ${msg.user_count === 1 ? 'USER' : 'USERS'}`;
        if (canvas) {
          canvas.removeRemoteUser(msg.user_id);
        }
        showToast(`${msg.user_id} left`);
      },

      onPeerRenamed: (msg) => {
        if (canvas) {
          canvas.removeRemoteUser(msg.old_user_id);
        }
        showToast(`${msg.old_user_id} is now ${msg.new_user_id}`);
      },

      onStrokeTextLive: (data) => {
        if (canvas) {
          canvas.handleRemoteLiveText(data);
        }
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
          case 'stroke_text':
            if (msg.isCommit) {
              canvas.handleRemoteStrokeText(msg);
            } else {
              canvas.handleRemoteLiveText(msg);
            }
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
    canvas = new DrawingCanvas(container, {
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
        net.broadcastBinary(buffer, true);
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

      onTextRequest: (pos) => {
        openDirectText(pos);
      },
    });
  }

  // =========================================================================
  // Direct On-Canvas Text Tool & Live Keystroke Streaming
  // =========================================================================

  function openDirectText(pos) {
    if (pendingTextPos) {
      commitDirectText();
    }
    pendingTextPos = pos;
    currentTextStrokeId = (Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 100000);

    const rect = container.getBoundingClientRect();
    let left = pos.clientX - rect.left;
    let top = pos.clientY - rect.top;

    const fontSize = Math.max(14, Math.round(activeBrushSize * 6));
    directTextEditor.style.fontSize = `${fontSize}px`;
    directTextEditor.style.color = activeColor;
    directTextEditor.style.left = `${left}px`;
    directTextEditor.style.top = `${top}px`;
    directTextEditor.value = '';
    directTextEditor.style.height = 'auto';
    directTextEditor.classList.remove('hidden');

    setTimeout(() => directTextEditor.focus(), 30);
  }

  // Broadcast text live as the user types
  directTextEditor.addEventListener('input', () => {
    directTextEditor.style.height = 'auto';
    directTextEditor.style.height = directTextEditor.scrollHeight + 'px';

    if (pendingTextPos) {
      const textVal = directTextEditor.value;
      const buffer = Protocol.encodeStrokeText(
        currentTextStrokeId,
        currentUserId,
        textVal,
        activeColor,
        activeBrushSize,
        pendingTextPos.x,
        pendingTextPos.y,
        false
      );
      if (net) {
        net.broadcastBinary(buffer, true);
        net.sendServerMessage({
          type: 'stroke_text_live',
          stroke: {
            id: currentTextStrokeId,
            text: textVal,
            color: activeColor,
            size: activeBrushSize,
            x: pendingTextPos.x,
            y: pendingTextPos.y,
          },
        });
      }
    }
  });

  function commitDirectText() {
    if (!pendingTextPos) return;

    const text = directTextEditor.value.trim();
    if (text) {
      const textStroke = {
        id: currentTextStrokeId,
        userId: currentUserId,
        tool: 2,
        text,
        color: activeColor,
        size: activeBrushSize,
        points: [[pendingTextPos.x, pendingTextPos.y]],
        undone: false,
      };

      // Broadcast final committed binary text
      const buffer = Protocol.encodeStrokeText(
        currentTextStrokeId,
        currentUserId,
        text,
        activeColor,
        activeBrushSize,
        pendingTextPos.x,
        pendingTextPos.y,
        true
      );
      if (net) {
        net.broadcastBinary(buffer, false);
        net.sendServerMessage({
          type: 'stroke_text',
          stroke: {
            id: currentTextStrokeId,
            text,
            color: activeColor,
            size: activeBrushSize,
            x: pendingTextPos.x,
            y: pendingTextPos.y,
          },
        });
      }

      // Commit to local canvas
      if (canvas) {
        canvas.committedStrokes.set(currentTextStrokeId, textStroke);
        canvas.strokeOrder.push(currentTextStrokeId);
        canvas.renderStrokeToBase(textStroke);
        canvas.clearActiveCanvas();
        canvas.renderAllActiveStrokes();
      }
    } else {
      // Broadcast empty text to clear remote live typing
      if (net) {
        const buffer = Protocol.encodeStrokeText(
          currentTextStrokeId,
          currentUserId,
          '',
          activeColor,
          activeBrushSize,
          pendingTextPos.x,
          pendingTextPos.y,
          false
        );
        net.broadcastBinary(buffer, true);
        net.sendServerMessage({
          type: 'stroke_text_live',
          stroke: {
            id: currentTextStrokeId,
            text: '',
            color: activeColor,
            size: activeBrushSize,
            x: pendingTextPos.x,
            y: pendingTextPos.y,
          },
        });
      }
    }

    directTextEditor.classList.add('hidden');
    directTextEditor.value = '';
    pendingTextPos = null;
  }

  directTextEditor.addEventListener('blur', () => {
    commitDirectText();
  });

  directTextEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitDirectText();
    } else if (e.key === 'Escape') {
      if (net && pendingTextPos) {
        const buffer = Protocol.encodeStrokeText(
          currentTextStrokeId,
          currentUserId,
          '',
          activeColor,
          activeBrushSize,
          pendingTextPos.x,
          pendingTextPos.y,
          false
        );
        net.broadcastBinary(buffer, true);
        net.sendServerMessage({
          type: 'stroke_text_live',
          stroke: {
            id: currentTextStrokeId,
            text: '',
            color: activeColor,
            size: activeBrushSize,
            x: pendingTextPos.x,
            y: pendingTextPos.y,
          },
        });
      }
      directTextEditor.classList.add('hidden');
      directTextEditor.value = '';
      pendingTextPos = null;
    }
  });

  // =========================================================================
  // First-time / Rename Modal
  // =========================================================================

  function showNameModal(isRename = false) {
    if (isRename) {
      nameModalTitle.textContent = 'Change Display Name';
      nameModalSubtitle.textContent = 'Enter your new nickname:';
      btnSaveName.textContent = 'Update Name';
      usernameInput.value = currentUserId;
    } else {
      nameModalTitle.textContent = 'Welcome to LiveDraw';
      nameModalSubtitle.textContent = 'Choose your display name for this board:';
      btnSaveName.textContent = 'Join Board';
      usernameInput.value = generateRandomName();
    }
    nameModal.classList.remove('hidden');
    setTimeout(() => usernameInput.focus(), 150);
  }

  function hideNameModal() {
    nameModal.classList.add('hidden');
  }

  btnRandomName.addEventListener('click', () => {
    usernameInput.value = generateRandomName();
  });

  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const entered = usernameInput.value.trim() || generateRandomName();
    hideNameModal();

    if (!net) {
      initApp(entered);
    } else {
      net.setUsername(entered);
    }
  });

  myUserTag.addEventListener('click', () => {
    showNameModal(true);
  });

  if (savedUsername && savedUsername.trim()) {
    initApp(savedUsername.trim());
  } else {
    showNameModal(false);
  }

  // =========================================================================
  // Tool & Action Handlers
  // =========================================================================

  function selectTool(toolIndex) {
    activeTool = toolIndex;
    if (canvas) canvas.setTool(toolIndex);

    toolPen.classList.toggle('active', toolIndex === 0);
    toolEraser.classList.toggle('active', toolIndex === 1);
    if (toolText) toolText.classList.toggle('active', toolIndex === 2);

    if (toolIndex !== 2 && pendingTextPos) {
      commitDirectText();
    }
    closeTrays();
  }

  function setColor(hex) {
    activeColor = hex;
    if (canvas) canvas.setColor(hex);
    activeColorIndicator.style.backgroundColor = hex;
    sizePreviewDot.style.backgroundColor = hex;
    directTextEditor.style.color = hex;

    colorSwatches.forEach(s => {
      if (s.dataset.color.toLowerCase() === hex.toLowerCase()) {
        s.classList.add('active');
      } else {
        s.classList.remove('active');
      }
    });

    if (activeTool === 1) {
      selectTool(0);
    }
  }

  function setBrushSize(size) {
    activeBrushSize = parseInt(size, 10);
    if (canvas) canvas.setBrushSize(activeBrushSize);
    sizeSlider.value = activeBrushSize;
    sizeValueDisplay.textContent = `${activeBrushSize}px`;
    activeSizeLabel.textContent = `${activeBrushSize}px`;
    sizePreviewDot.style.width = `${Math.min(28, Math.max(2, activeBrushSize))}px`;
    sizePreviewDot.style.height = `${Math.min(28, Math.max(2, activeBrushSize))}px`;

    const fontSize = Math.max(14, Math.round(activeBrushSize * 6));
    directTextEditor.style.fontSize = `${fontSize}px`;
  }

  function closeTrays() {
    colorTray.classList.add('hidden');
    sizeTray.classList.add('hidden');
  }

  // Event Listeners for UI
  toolPen.addEventListener('click', () => selectTool(0));
  toolEraser.addEventListener('click', () => selectTool(1));
  if (toolText) toolText.addEventListener('click', () => selectTool(2));

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
    if (pendingTextPos) commitDirectText();
    if (net) net.sendServerMessage({ type: 'stroke_undo' });
  });

  btnRedo.addEventListener('click', () => {
    closeTrays();
    if (pendingTextPos) commitDirectText();
    if (net) net.sendServerMessage({ type: 'stroke_redo' });
  });

  btnClear.addEventListener('click', () => {
    closeTrays();
    if (pendingTextPos) commitDirectText();
    if (confirm('Clear the shared whiteboard for everyone?')) {
      const buffer = Protocol.encodeBoardClear(currentUserId);
      if (net) {
        net.broadcastBinary(buffer, false);
        net.sendServerMessage({ type: 'board_clear' });
      }
      if (canvas) canvas.clearBoard();
    }
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

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
    } else if (e.key.toLowerCase() === 't') {
      selectTool(2);
    }
  });

  // Close floating trays when clicking outside
  document.addEventListener('click', (e) => {
    if (!colorTray.contains(e.target) && !btnColorTrigger.contains(e.target) &&
        !sizeTray.contains(e.target) && !btnSizeTrigger.contains(e.target)) {
      closeTrays();
    }
  });

  // Smooth Periodic Latency Update
  setInterval(() => {
    if (net) {
      const netStats = net.getStats();
      latencyDisplay.textContent = netStats.latencyMs > 0 ? `${netStats.latencyMs} ms` : '< 10 ms';
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
      setTimeout(() => toast.remove(), 250);
    }, 2000);
  }

  // Initialize defaults
  setColor('#1e1e1e');
  setBrushSize(2);
});
