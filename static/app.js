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

  // Selection Actions
  const selectionActions = document.getElementById('selection-actions');
  const btnDeleteSelection = document.getElementById('btn-delete-selection');

  // Reference Image Controls
  const btnImportImage = document.getElementById('btn-import-image');
  const imageUploadInput = document.getElementById('image-upload-input');
  const refImageBar = document.getElementById('reference-image-bar');
  const btnRefLock = document.getElementById('btn-ref-lock');
  const refLockLabel = document.getElementById('ref-lock-label');
  const iconUnlocked = btnRefLock ? btnRefLock.querySelector('.icon-unlocked') : null;
  const iconLocked = btnRefLock ? btnRefLock.querySelector('.icon-locked') : null;
  const btnRefOpacity = document.getElementById('btn-ref-opacity');
  const refOpacityLabel = document.getElementById('ref-opacity-label');
  const btnRefDelete = document.getElementById('btn-ref-delete');

  // Tool Buttons
  const toolPen = document.getElementById('tool-pen');
  const toolEraser = document.getElementById('tool-eraser');
  const toolSelect = document.getElementById('tool-select');
  const toolZoom = document.getElementById('tool-zoom');
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
  let activeTool = 0; // 0 = Pen, 1 = Eraser
  let activeColor = '#1e1e1e';
  let activeBrushSize = 2;
  let net = null;
  let canvas = null;

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

  function cleanBaseName(name) {
    if (!name) return 'Artist';
    const cleaned = name.trim().replace(/(_\d+)+$/, '');
    return cleaned || name.trim() || 'Artist';
  }

  let savedUsername = localStorage.getItem('livedraw_username');

  function initApp(chosenName) {
    if (net) return;

    currentUserId = chosenName || generateRandomName();
    myUserIdDisplay.textContent = 'YOU';
    myUserIdDisplay.title = `Display name: ${currentUserId}`;

    // Initialize WebRTC Manager
    net = new WebRTCManager({
      requestedUsername: currentUserId,

      onWelcome: (msg) => {
        currentUserId = msg.user_id;
        currentUserColor = msg.color;
        localStorage.setItem('livedraw_username', cleanBaseName(currentUserId));
        myUserIdDisplay.textContent = 'YOU';
        myUserIdDisplay.title = `Display name: ${currentUserId}`;
        myUserDot.style.backgroundColor = currentUserColor;
        userCountDisplay.textContent = msg.user_count;

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
        localStorage.setItem('livedraw_username', cleanBaseName(currentUserId));
        myUserIdDisplay.textContent = 'YOU';
        myUserIdDisplay.title = `Display name: ${currentUserId}`;
        if (canvas) canvas.userId = currentUserId;
        showToast(`Display name set to ${currentUserId}`);
      },

      onPeerJoined: (msg) => {
        userCountDisplay.textContent = msg.user_count;
        showToast(`${msg.user_id} joined`);
      },

      onPeerLeft: (msg) => {
        userCountDisplay.textContent = msg.user_count;
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
          case 'stroke_move':
            canvas.applyStrokeMove(msg.strokeId, msg.dx, msg.dy);
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

      onStrokeMove: (msg) => {
        if (canvas) canvas.applyStrokeMove(msg.stroke_id, msg.dx, msg.dy);
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

      onStrokeMove: (strokeId, dx, dy) => {
        const buffer = Protocol.encodeStrokeMove(strokeId, currentUserId, dx, dy);
        net.broadcastBinary(buffer, false);
        net.sendServerMessage({
          type: 'stroke_move',
          stroke_id: strokeId,
          dx,
          dy,
        });
        updateSelectionOverlay();
      },

      onSelectionChange: (strokeId) => {
        updateSelectionOverlay();
      },

      onZoomChange: (zoom, panX, panY) => {
        updateSelectionOverlay();
      },

      onReferenceImageChange: (refImage) => {
        updateRefImageBar(refImage);
      },

      onCursorMove: (normX, normY, isDrawing) => {
        const buffer = Protocol.encodeCursorMove(currentUserId, normX, normY, isDrawing);
        net.broadcastBinary(buffer, true);
        if (canvas && canvas.isDraggingSelection) {
          updateSelectionOverlay();
        }
      },
    });
  }

  function updateRefImageBar(refImage) {
    if (!refImageBar) return;
    if (!refImage) {
      refImageBar.classList.add('hidden');
      return;
    }
    refImageBar.classList.remove('hidden');

    if (refImage.locked) {
      btnRefLock.classList.add('active-lock');
      if (refLockLabel) refLockLabel.textContent = 'Locked';
      if (iconUnlocked) iconUnlocked.classList.add('hidden');
      if (iconLocked) iconLocked.classList.remove('hidden');
    } else {
      btnRefLock.classList.remove('active-lock');
      if (refLockLabel) refLockLabel.textContent = 'Lock';
      if (iconUnlocked) iconUnlocked.classList.remove('hidden');
      if (iconLocked) iconLocked.classList.add('hidden');
    }

    const pct = Math.round((refImage.opacity !== undefined ? refImage.opacity : 0.5) * 100);
    if (refOpacityLabel) refOpacityLabel.textContent = `${pct}%`;
  }

  function updateSelectionOverlay() {
    if (!selectionActions || !canvas) return;
    if (activeTool === 2 && canvas.selectedStrokeIds && canvas.selectedStrokeIds.size > 0) {
      const bounds = canvas.getSelectedStrokeScreenBounds();
      if (bounds) {
        selectionActions.classList.remove('hidden');
        const contW = container.clientWidth || window.innerWidth;
        const clampedX = Math.max(30, Math.min(contW - 30, bounds.topCenterX));
        const clampedY = Math.max(45, bounds.topY);
        selectionActions.style.left = `${clampedX}px`;
        selectionActions.style.top = `${clampedY}px`;
        return;
      }
    }
    selectionActions.classList.add('hidden');
  }

  // =========================================================================
  // First-time / Rename Modal
  // =========================================================================

  function showNameModal(isRename = false) {
    if (isRename) {
      nameModalTitle.textContent = 'Change Display Name';
      nameModalSubtitle.textContent = 'Enter your new nickname:';
      btnSaveName.textContent = 'Update Name';
      usernameInput.value = cleanBaseName(currentUserId);
    } else {
      nameModalTitle.textContent = 'Welcome to LiveDraw';
      nameModalSubtitle.textContent = 'Choose your display name for this board:';
      btnSaveName.textContent = 'Join Board';
      usernameInput.value = generateRandomName();
    }
    nameModal.classList.remove('hidden');
    setTimeout(() => {
      usernameInput.focus();
      usernameInput.select();
    }, 150);
  }

  function hideNameModal() {
    nameModal.classList.add('hidden');
  }

  btnRandomName.addEventListener('click', () => {
    usernameInput.value = generateRandomName();
  });

  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const rawVal = usernameInput.value.trim();
    const entered = cleanBaseName(rawVal || generateRandomName());
    hideNameModal();

    localStorage.setItem('livedraw_username', entered);

    if (!net) {
      initApp(entered);
    } else {
      net.setUsername(entered);
    }
  });

  myUserTag.addEventListener('click', () => {
    showNameModal(true);
  });

  const initialName = cleanBaseName(savedUsername);
  if (savedUsername && savedUsername.trim()) {
    initApp(initialName);
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
    if (toolSelect) toolSelect.classList.toggle('active', toolIndex === 2);
    if (toolZoom) toolZoom.classList.toggle('active', toolIndex === 3);
    updateSelectionOverlay();
    closeTrays();
  }

  function setColor(hex) {
    activeColor = hex;
    if (canvas) canvas.setColor(hex);
    activeColorIndicator.style.backgroundColor = hex;
    sizePreviewDot.style.backgroundColor = hex;

    colorSwatches.forEach(s => {
      if (s.dataset.color.toLowerCase() === hex.toLowerCase()) {
        s.classList.add('active');
      } else {
        s.classList.remove('active');
      }
    });

    if (activeTool === 1 || activeTool === 3) {
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
  }

  function closeTrays() {
    colorTray.classList.add('hidden');
    sizeTray.classList.add('hidden');
  }

  // Event Listeners for UI
  toolPen.addEventListener('click', () => selectTool(0));
  toolEraser.addEventListener('click', () => selectTool(1));
  if (toolSelect) toolSelect.addEventListener('click', () => selectTool(2));
  if (toolZoom) toolZoom.addEventListener('click', () => selectTool(3));

  // Delete Selection Handler
  if (btnDeleteSelection) {
    btnDeleteSelection.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!canvas) return;
      const deletedIds = canvas.deleteSelectedStrokes();
      if (deletedIds && deletedIds.length > 0) {
        for (const sid of deletedIds) {
          const buffer = Protocol.encodeStrokeUndo(currentUserId, sid);
          if (net) {
            net.broadcastBinary(buffer, false);
          }
        }
        if (net) {
          net.sendServerMessage({ type: 'stroke_undo' });
        }
        updateSelectionOverlay();
        showToast(deletedIds.length === 1 ? 'Element deleted' : `${deletedIds.length} elements deleted`);
      }
    });
  }

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
    if (net) net.sendServerMessage({ type: 'stroke_undo' });
  });

  btnRedo.addEventListener('click', () => {
    closeTrays();
    if (net) net.sendServerMessage({ type: 'stroke_redo' });
  });

  btnClear.addEventListener('click', () => {
    closeTrays();
    if (confirm('Clear the shared whiteboard for everyone?')) {
      const buffer = Protocol.encodeBoardClear(currentUserId);
      if (net) {
        net.broadcastBinary(buffer, false);
        net.sendServerMessage({ type: 'board_clear' });
      }
      if (canvas) canvas.clearBoard();
    }
  });

  // =========================================================================
  // Reference Image Handlers (Local-Only Tracing Layer)
  // =========================================================================

  if (btnImportImage && imageUploadInput) {
    btnImportImage.addEventListener('click', () => {
      closeTrays();
      imageUploadInput.click();
    });

    imageUploadInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (evt) => {
        const img = new Image();
        img.onload = () => {
          if (canvas) {
            canvas.setReferenceImage(img);
            showToast('Image loaded at 50% opacity. Adjust & tap Lock to trace.');
          }
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
      imageUploadInput.value = '';
    });
  }

  if (btnRefLock) {
    btnRefLock.addEventListener('click', () => {
      if (!canvas || !canvas.referenceImage) return;
      const isLocked = !canvas.referenceImage.locked;
      canvas.lockReferenceImage(isLocked);
      showToast(isLocked ? '🔒 Locked: draw and trace freely over image' : '🔓 Unlocked: drag or resize image position');
    });
  }

  if (btnRefOpacity) {
    btnRefOpacity.addEventListener('click', () => {
      if (!canvas || !canvas.referenceImage) return;
      const opacities = [0.5, 0.25, 0.75, 1.0];
      const curr = canvas.referenceImage.opacity !== undefined ? canvas.referenceImage.opacity : 0.5;
      const nextIdx = (opacities.indexOf(curr) + 1) % opacities.length;
      canvas.setReferenceImageOpacity(opacities[nextIdx]);
    });
  }

  if (btnRefDelete) {
    btnRefDelete.addEventListener('click', () => {
      if (!canvas) return;
      canvas.removeReferenceImage();
      showToast('Reference image removed.');
    });
  }

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
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (canvas && canvas.selectedStrokeIds && canvas.selectedStrokeIds.size > 0) {
        e.preventDefault();
        if (btnDeleteSelection) btnDeleteSelection.click();
      }
    } else if (e.key.toLowerCase() === 'p') {
      selectTool(0);
    } else if (e.key.toLowerCase() === 'e') {
      selectTool(1);
    } else if (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'v') {
      selectTool(2);
    } else if (e.key.toLowerCase() === 'h' || e.key.toLowerCase() === 'z') {
      selectTool(3);
    } else if (e.key === '=' || e.key === '+') {
      if (canvas) canvas.zoomIn();
    } else if (e.key === '-' || e.key === '_') {
      if (canvas) canvas.zoomOut();
    } else if (e.key === '0') {
      if (canvas) canvas.resetZoom();
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
      latencyDisplay.textContent = netStats.latencyMs > 0 ? `${netStats.latencyMs}ms` : '<10ms';
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
