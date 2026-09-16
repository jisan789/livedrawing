/**
 * LiveDraw Multi-Layered High-DPI Canvas Engine
 * Optimized for mobile touch, stylus pressure, and concurrent live rendering.
 */

class DrawingCanvas {
  constructor(container, options = {}) {
    this.container = container;
    this.baseCanvas = document.getElementById('base-canvas');
    this.activeCanvas = document.getElementById('active-canvas');
    this.cursorCanvas = document.getElementById('cursor-canvas');

    this.baseCtx = this.baseCanvas.getContext('2d', { desynchronized: true });
    this.activeCtx = this.activeCanvas.getContext('2d', { desynchronized: true });
    this.cursorCtx = this.cursorCanvas.getContext('2d');

    // Callbacks to network manager
    this.onStrokeStart = options.onStrokeStart || (() => {});
    this.onStrokeChunk = options.onStrokeChunk || (() => {});
    this.onStrokeEnd = options.onStrokeEnd || (() => {});
    this.onStrokeMove = options.onStrokeMove || (() => {});
    this.onCursorMove = options.onCursorMove || (() => {});
    this.onSelectionChange = options.onSelectionChange || (() => {});

    // Drawing settings
    this.tool = 0; // 0 = Pen, 1 = Eraser, 2 = Select
    this.color = '#1e1e1e';
    this.brushSize = 2;
    this.userId = options.userId || 'ME';

    // Local drawing state
    this.isDrawing = false;
    this.currentStrokeId = 0;
    this.currentSeq = 0;
    this.localPoints = [];
    this.pendingPoints = [];
    this.rawPointCount = 0;
    this.sampledPointCount = 0;

    // Multi-Selection & Transform tool state
    this.selectedStrokeIds = new Set();
    this.isDraggingSelection = false;
    this.isResizing = false;
    this.activeResizeHandle = null;
    this.isMarqueeSelecting = false;
    this.marqueeStart = [0, 0];
    this.marqueeCurrent = [0, 0];
    this.dragLastNorm = [0, 0];
    this.totalMoved = [0, 0];
    this.initialBounds = null;
    this.initialPointsMap = new Map();

    // Remote active strokes map: strokeId -> { userId, tool, color, size, points, lastPoint }
    this.remoteActiveStrokes = new Map();
    // Remote cursors map: userId -> { x, y, isDrawing, color, lastSeen }
    this.remoteCursors = new Map();

    // Authoritative committed strokes for redraws: strokeId -> strokeObject
    this.committedStrokes = new Map();
    this.strokeOrder = [];

    // Scaling & Metrics
    this.dpr = window.devicePixelRatio || 1;
    this.width = 0;
    this.height = 0;
    this.minSampleDistance = 18; // normalized distance threshold (out of 10000)

    this.initCanvasSize();
    this.bindEvents();
    this.startRenderLoop();
  }

  initCanvasSize() {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = window.devicePixelRatio || 1;

    [this.baseCanvas, this.activeCanvas, this.cursorCanvas].forEach(c => {
      c.width = Math.round(this.width * this.dpr);
      c.height = Math.round(this.height * this.dpr);
      c.style.width = `${this.width}px`;
      c.style.height = `${this.height}px`;
    });

    this.baseCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.activeCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.cursorCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.redrawAll();
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 2) {
      this.selectedStrokeIds.clear();
      this.isDraggingSelection = false;
      this.isResizing = false;
      this.isMarqueeSelecting = false;
      this.cursorCanvas.style.cursor = 'default';
    }
    this.redrawAll();
  }

  setColor(color) {
    this.color = color;
  }

  setBrushSize(size) {
    this.brushSize = size;
  }

  // Coordinate Conversion: Screen Pixels <-> Normalized 0..10000
  toNormalized(clientX, clientY) {
    const rect = this.cursorCanvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const normX = Math.max(0, Math.min(COORD_SCALE, (px / rect.width) * COORD_SCALE));
    const normY = Math.max(0, Math.min(COORD_SCALE, (py / rect.height) * COORD_SCALE));
    return [normX, normY];
  }

  toScreen(normX, normY) {
    return [
      (normX / COORD_SCALE) * this.width,
      (normY / COORD_SCALE) * this.height,
    ];
  }

  // Hit-Testing & Bounding Utilities
  getStrokeBounds(stroke) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return null;
    let minX = stroke.points[0][0], maxX = stroke.points[0][0];
    let minY = stroke.points[0][1], maxY = stroke.points[0][1];
    for (let i = 1; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    return [minX, minY, maxX, maxY];
  }

  getSelectionBounds() {
    if (this.selectedStrokeIds.size === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const sid of this.selectedStrokeIds) {
      const stroke = this.committedStrokes.get(sid);
      if (!stroke || stroke.undone || !stroke.points || stroke.points.length === 0) continue;
      const b = this.getStrokeBounds(stroke);
      if (!b) continue;
      minX = Math.min(minX, b[0]);
      minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[2]);
      maxY = Math.max(maxY, b[3]);
      count++;
    }
    if (count === 0) return null;
    return [minX, minY, maxX, maxY];
  }

  getSelectionScreenBounds() {
    const bounds = this.getSelectionBounds();
    if (!bounds) return null;

    const padScreen = 10;
    const [minSx, minSy] = this.toScreen(bounds[0], bounds[1]);
    const [maxSx, maxSy] = this.toScreen(bounds[2], bounds[3]);

    const x = minSx - padScreen;
    const y = minSy - padScreen;
    const width = Math.max(24, (maxSx - minSx) + padScreen * 2);
    const height = Math.max(24, (maxSy - minSy) + padScreen * 2);

    return {
      x,
      y,
      width,
      height,
      minSx: x,
      minSy: y,
      maxSx: x + width,
      maxSy: y + height,
      topCenterX: x + width / 2,
      topRightX: x + width,
      topY: y,
    };
  }

  getHandles(screenBounds) {
    if (!screenBounds) return {};
    const { x, y, width, height } = screenBounds;
    return {
      nw: [x, y],
      n: [x + width / 2, y],
      ne: [x + width, y],
      e: [x + width, y + height / 2],
      se: [x + width, y + height],
      s: [x + width / 2, y + height],
      sw: [x, y + height],
      w: [x, y + height / 2],
    };
  }

  getHandleUnderPointer(sx, sy) {
    const screenBounds = this.getSelectionScreenBounds();
    if (!screenBounds) return null;
    const handles = this.getHandles(screenBounds);
    const hitRadius = 14; // Touch & cursor friendly radius

    for (const [name, pos] of Object.entries(handles)) {
      const distSq = (sx - pos[0]) ** 2 + (sy - pos[1]) ** 2;
      if (distSq <= hitRadius ** 2) {
        return name;
      }
    }
    return null;
  }

  isPointInsideSelection(normX, normY) {
    const bounds = this.getSelectionBounds();
    if (!bounds) return false;
    const padding = Math.max(120, (14 / this.width) * COORD_SCALE);
    return (
      normX >= bounds[0] - padding &&
      normX <= bounds[2] + padding &&
      normY >= bounds[1] - padding &&
      normY <= bounds[3] + padding
    );
  }

  distToSegmentSq(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return (px - x1) ** 2 + (py - y1) ** 2;
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * (x2 - x1);
    const projY = y1 + t * (y2 - y1);
    return (px - projX) ** 2 + (py - projY) ** 2;
  }

  hitTest(normX, normY) {
    const normTolerance = Math.max(120, (14 / this.width) * COORD_SCALE);

    for (let i = this.strokeOrder.length - 1; i >= 0; i--) {
      const sid = this.strokeOrder[i];
      const stroke = this.committedStrokes.get(sid);
      if (!stroke || stroke.undone || !stroke.points || stroke.points.length === 0) continue;

      const bounds = this.getStrokeBounds(stroke);
      if (!bounds) continue;

      const strokeTol = Math.max(normTolerance, ((stroke.size || 2) * COORD_SCALE / this.width) * 1.5 + 80);
      if (
        normX < bounds[0] - strokeTol ||
        normX > bounds[2] + strokeTol ||
        normY < bounds[1] - strokeTol ||
        normY > bounds[3] + strokeTol
      ) {
        continue;
      }

      if (stroke.points.length === 1) {
        const dSq = (normX - stroke.points[0][0]) ** 2 + (normY - stroke.points[0][1]) ** 2;
        if (dSq <= strokeTol ** 2) return stroke;
      } else {
        for (let j = 0; j < stroke.points.length - 1; j++) {
          const p1 = stroke.points[j];
          const p2 = stroke.points[j + 1];
          if (this.distToSegmentSq(normX, normY, p1[0], p1[1], p2[0], p2[1]) <= strokeTol ** 2) {
            return stroke;
          }
        }
      }
    }
    return null;
  }

  bindEvents() {
    window.addEventListener('resize', () => {
      this.initCanvasSize();
    });

    // Pointer Events on topmost layer
    this.cursorCanvas.addEventListener('pointerdown', this.handlePointerDown.bind(this));
    this.cursorCanvas.addEventListener('pointermove', this.handlePointerMove.bind(this));
    this.cursorCanvas.addEventListener('pointerup', this.handlePointerUp.bind(this));
    this.cursorCanvas.addEventListener('pointercancel', this.handlePointerUp.bind(this));
    this.cursorCanvas.addEventListener('pointerleave', this.handlePointerLeave.bind(this));
  }

  handlePointerDown(e) {
    e.preventDefault();
    if (e.button !== undefined && e.button !== 0) return; // Only primary button

    const [normX, normY] = this.toNormalized(e.clientX, e.clientY);
    const [sx, sy] = this.toScreen(normX, normY);

    // Select Tool handler
    if (this.tool === 2) {
      // 1. Check if clicked on a resize handle
      const resizeHandle = this.getHandleUnderPointer(sx, sy);
      if (resizeHandle && this.selectedStrokeIds.size > 0) {
        this.isResizing = true;
        this.activeResizeHandle = resizeHandle;
        this.dragLastNorm = [normX, normY];
        this.initialBounds = this.getSelectionBounds();
        this.initialPointsMap.clear();
        for (const sid of this.selectedStrokeIds) {
          const s = this.committedStrokes.get(sid);
          if (s && s.points) {
            this.initialPointsMap.set(sid, s.points.map(p => [p[0], p[1]]));
          }
        }
        try {
          this.cursorCanvas.setPointerCapture(e.pointerId);
        } catch (_) {}
        this.redrawAll();
        return;
      }

      // 2. Check if clicked inside existing selection box to drag all selected
      if (this.selectedStrokeIds.size > 0 && this.isPointInsideSelection(normX, normY)) {
        this.isDraggingSelection = true;
        this.dragLastNorm = [normX, normY];
        this.totalMoved = [0, 0];
        try {
          this.cursorCanvas.setPointerCapture(e.pointerId);
        } catch (_) {}
        this.redrawAll();
        return;
      }

      // 3. Hit test individual stroke
      const hit = this.hitTest(normX, normY);
      if (hit) {
        if (!e.shiftKey) {
          this.selectedStrokeIds.clear();
        }
        this.selectedStrokeIds.add(hit.id);
        this.isDraggingSelection = true;
        this.dragLastNorm = [normX, normY];
        this.totalMoved = [0, 0];
        try {
          this.cursorCanvas.setPointerCapture(e.pointerId);
        } catch (_) {}
      } else {
        // 4. Clicked on empty space: Start Marquee selection drag
        if (!e.shiftKey) {
          this.selectedStrokeIds.clear();
        }
        this.isMarqueeSelecting = true;
        this.marqueeStart = [normX, normY];
        this.marqueeCurrent = [normX, normY];
        try {
          this.cursorCanvas.setPointerCapture(e.pointerId);
        } catch (_) {}
      }

      this.onSelectionChange(this.selectedStrokeIds);
      this.redrawAll();
      return;
    }

    // Normal Pen / Eraser drawing
    this.selectedStrokeIds.clear();
    this.cursorCanvas.setPointerCapture(e.pointerId);
    this.isDrawing = true;
    this.currentStrokeId = (Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 100000);
    this.currentSeq = 0;

    this.localPoints = [[normX, normY]];
    this.pendingPoints = [];
    this.rawPointCount++;
    this.sampledPointCount++;

    // Notify network
    this.onStrokeStart({
      id: this.currentStrokeId,
      userId: this.userId,
      tool: this.tool,
      color: this.color,
      size: this.brushSize,
      x: normX,
      y: normY,
    });

    // Draw starting dot immediately
    this.drawDot(this.activeCtx, sx, sy, this.tool, this.color, this.brushSize);
  }

  handlePointerMove(e) {
    const [normX, normY] = this.toNormalized(e.clientX, e.clientY);
    const [sx, sy] = this.toScreen(normX, normY);
    
    // Broadcast cursor position
    this.onCursorMove(normX, normY, this.isDrawing || this.isDraggingSelection || this.isResizing);

    // In Select Mode
    if (this.tool === 2) {
      // Hover cursor management
      if (!this.isDrawing && !this.isDraggingSelection && !this.isResizing && !this.isMarqueeSelecting) {
        const handle = this.getHandleUnderPointer(sx, sy);
        if (handle) {
          if (handle === 'nw' || handle === 'se') this.cursorCanvas.style.cursor = 'nwse-resize';
          else if (handle === 'ne' || handle === 'sw') this.cursorCanvas.style.cursor = 'nesw-resize';
          else if (handle === 'n' || handle === 's') this.cursorCanvas.style.cursor = 'ns-resize';
          else if (handle === 'w' || handle === 'e') this.cursorCanvas.style.cursor = 'ew-resize';
        } else if (this.isPointInsideSelection(normX, normY)) {
          this.cursorCanvas.style.cursor = 'move';
        } else {
          this.cursorCanvas.style.cursor = 'default';
        }
      }

      // Handle Resizing
      if (this.isResizing && this.initialBounds) {
        const [initMinX, initMinY, initMaxX, initMaxY] = this.initialBounds;
        let newMinX = initMinX;
        let newMinY = initMinY;
        let newMaxX = initMaxX;
        let newMaxY = initMaxY;

        const handle = this.activeResizeHandle;
        if (handle.includes('w')) newMinX = Math.min(normX, initMaxX - 50);
        if (handle.includes('e')) newMaxX = Math.max(normX, initMinX + 50);
        if (handle.includes('n')) newMinY = Math.min(normY, initMaxY - 50);
        if (handle.includes('s')) newMaxY = Math.max(normY, initMinY + 50);

        const initW = Math.max(1, initMaxX - initMinX);
        const initH = Math.max(1, initMaxY - initMinY);
        const scaleX = (newMaxX - newMinX) / initW;
        const scaleY = (newMaxY - newMinY) / initH;

        for (const sid of this.selectedStrokeIds) {
          const stroke = this.committedStrokes.get(sid);
          const initPts = this.initialPointsMap.get(sid);
          if (stroke && initPts) {
            for (let i = 0; i < stroke.points.length; i++) {
              stroke.points[i][0] = Math.max(0, Math.min(COORD_SCALE, Math.round(newMinX + (initPts[i][0] - initMinX) * scaleX)));
              stroke.points[i][1] = Math.max(0, Math.min(COORD_SCALE, Math.round(newMinY + (initPts[i][1] - initMinY) * scaleY)));
            }
          }
        }
        this.redrawAll();
        return;
      }

      // Handle Dragging / Moving Selection
      if (this.isDraggingSelection && this.selectedStrokeIds.size > 0) {
        const dx = normX - this.dragLastNorm[0];
        const dy = normY - this.dragLastNorm[1];
        this.dragLastNorm = [normX, normY];
        this.totalMoved[0] += dx;
        this.totalMoved[1] += dy;

        for (const sid of this.selectedStrokeIds) {
          const stroke = this.committedStrokes.get(sid);
          if (stroke && stroke.points) {
            for (const pt of stroke.points) {
              pt[0] = Math.max(0, Math.min(COORD_SCALE, pt[0] + dx));
              pt[1] = Math.max(0, Math.min(COORD_SCALE, pt[1] + dy));
            }
          }
        }
        this.redrawAll();
        return;
      }

      // Handle Marquee Drag Selection
      if (this.isMarqueeSelecting) {
        this.marqueeCurrent = [normX, normY];
        const boxMinX = Math.min(this.marqueeStart[0], this.marqueeCurrent[0]);
        const boxMinY = Math.min(this.marqueeStart[1], this.marqueeCurrent[1]);
        const boxMaxX = Math.max(this.marqueeStart[0], this.marqueeCurrent[0]);
        const boxMaxY = Math.max(this.marqueeStart[1], this.marqueeCurrent[1]);

        this.selectedStrokeIds.clear();
        for (const [sid, stroke] of this.committedStrokes.entries()) {
          if (stroke.undone || !stroke.points || stroke.points.length === 0) continue;
          const b = this.getStrokeBounds(stroke);
          if (!b) continue;
          // Check box intersection
          if (b[0] <= boxMaxX && b[2] >= boxMinX && b[1] <= boxMaxY && b[3] >= boxMinY) {
            this.selectedStrokeIds.add(sid);
          }
        }
        this.onSelectionChange(this.selectedStrokeIds);
        this.redrawAll();
        return;
      }

      return;
    }

    if (!this.isDrawing) return;
    this.rawPointCount++;

    // Process coalesced points if available for high-frequency input
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

    for (const evt of events) {
      const [ptX, ptY] = this.toNormalized(evt.clientX, evt.clientY);
      const lastPt = this.localPoints[this.localPoints.length - 1];

      // Distance threshold filtering
      const distSq = (ptX - lastPt[0]) ** 2 + (ptY - lastPt[1]) ** 2;
      if (distSq >= this.minSampleDistance ** 2) {
        this.sampledPointCount++;
        const newPt = [ptX, ptY];
        this.localPoints.push(newPt);
        this.pendingPoints.push(newPt);

        // Incremental draw locally on active layer
        const [p1x, p1y] = this.toScreen(lastPt[0], lastPt[1]);
        const [p2x, p2y] = this.toScreen(ptX, ptY);
        this.drawLineSegment(this.activeCtx, p1x, p1y, p2x, p2y, this.tool, this.color, this.brushSize);
      }
    }

    // Flush pending points in chunks to maintain low latency (< 16ms)
    if (this.pendingPoints.length >= 2) {
      this.flushPendingPoints();
    }
  }

  flushPendingPoints() {
    if (this.pendingPoints.length === 0) return;
    this.currentSeq++;
    this.onStrokeChunk({
      strokeId: this.currentStrokeId,
      seq: this.currentSeq,
      points: [...this.pendingPoints],
    });
    this.pendingPoints = [];
  }

  handlePointerUp(e) {
    if (this.tool === 2) {
      try {
        this.cursorCanvas.releasePointerCapture(e.pointerId);
      } catch (_) {}

      if (this.isResizing) {
        this.isResizing = false;
        this.activeResizeHandle = null;
        // Broadcast all modified stroke movements
        for (const sid of this.selectedStrokeIds) {
          this.onStrokeMove(sid, 0, 0);
        }
        this.onSelectionChange(this.selectedStrokeIds);
        this.redrawAll();
        return;
      }

      if (this.isDraggingSelection) {
        this.isDraggingSelection = false;
        if (Math.abs(this.totalMoved[0]) > 2 || Math.abs(this.totalMoved[1]) > 2) {
          for (const sid of this.selectedStrokeIds) {
            this.onStrokeMove(sid, this.totalMoved[0], this.totalMoved[1]);
          }
        }
        this.totalMoved = [0, 0];
        this.onSelectionChange(this.selectedStrokeIds);
        this.redrawAll();
        return;
      }

      if (this.isMarqueeSelecting) {
        this.isMarqueeSelecting = false;
        this.onSelectionChange(this.selectedStrokeIds);
        this.redrawAll();
        return;
      }
      return;
    }

    if (!this.isDrawing) return;
    this.isDrawing = false;
    try {
      this.cursorCanvas.releasePointerCapture(e.pointerId);
    } catch (_) {}

    // Flush any remaining points
    this.flushPendingPoints();

    // Notify stroke end
    this.onStrokeEnd(this.currentStrokeId);

    // Commit local stroke to base layer & store
    const stroke = {
      id: this.currentStrokeId,
      userId: this.userId,
      tool: this.tool,
      color: this.color,
      size: this.brushSize,
      points: [...this.localPoints],
      undone: false,
    };
    this.committedStrokes.set(stroke.id, stroke);
    this.strokeOrder.push(stroke.id);

    // Bake into base canvas and clear active canvas
    this.renderStrokeToBase(stroke);
    this.clearActiveCanvas();
    this.renderAllActiveStrokes();
  }

  handlePointerLeave() {
    this.onCursorMove(0, 0, false);
  }

  // =========================================================================
  // Remote Stroke Handlers (Live Real-Time Rendering)
  // =========================================================================

  handleRemoteStrokeStart(data) {
    const stroke = {
      id: data.strokeId,
      userId: data.userId,
      tool: data.tool,
      color: data.color,
      size: data.size,
      points: [data.point],
      lastPoint: data.point,
    };
    this.remoteActiveStrokes.set(data.strokeId, stroke);

    // Render starting dot immediately
    const [sx, sy] = this.toScreen(data.point[0], data.point[1]);
    this.drawDot(this.activeCtx, sx, sy, data.tool, data.color, data.size);
  }

  handleRemoteStrokeChunk(data) {
    const stroke = this.remoteActiveStrokes.get(data.strokeId);
    if (!stroke || !data.points || data.points.length === 0) return;

    let prev = stroke.lastPoint;
    for (const pt of data.points) {
      stroke.points.push(pt);
      const [p1x, p1y] = this.toScreen(prev[0], prev[1]);
      const [p2x, p2y] = this.toScreen(pt[0], pt[1]);
      this.drawLineSegment(this.activeCtx, p1x, p1y, p2x, p2y, stroke.tool, stroke.color, stroke.size);
      prev = pt;
    }
    stroke.lastPoint = prev;
  }

  handleRemoteStrokeEnd(strokeId) {
    const stroke = this.remoteActiveStrokes.get(strokeId);
    if (stroke) {
      this.remoteActiveStrokes.delete(strokeId);
      stroke.undone = false;
      this.committedStrokes.set(stroke.id, stroke);
      this.strokeOrder.push(stroke.id);
      
      this.renderStrokeToBase(stroke);
      this.clearActiveCanvas();
      this.renderAllActiveStrokes();
    }
  }

  handleRemoteCursor(data) {
    if (data.userId === this.userId) return;
    this.remoteCursors.set(data.userId, {
      x: data.x,
      y: data.y,
      isDrawing: data.isDrawing,
      lastSeen: Date.now(),
    });
  }

  removeRemoteUser(userId) {
    this.remoteCursors.delete(userId);
  }

  // =========================================================================
  // Canvas Rendering Primitives (Curves, Dots, Layers)
  // =========================================================================

  drawDot(ctx, x, y, tool, color, size) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    if (tool === 1) {
      ctx.fillStyle = '#ffffff';
    } else {
      ctx.fillStyle = color;
    }
    ctx.fill();
    ctx.restore();
  }

  drawLineSegment(ctx, x1, y1, x2, y2, tool, color, size) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    ctx.strokeStyle = tool === 1 ? '#ffffff' : color;
    ctx.stroke();
    ctx.restore();
  }

  renderStrokeToBase(stroke) {
    if (!stroke || stroke.undone || stroke.points.length === 0) return;
    this.renderStroke(this.baseCtx, stroke);
  }

  renderStroke(ctx, stroke) {
    const pts = stroke.points;
    if (!pts || pts.length === 0) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.size;
    ctx.strokeStyle = stroke.tool === 1 ? '#ffffff' : stroke.color;

    if (pts.length === 1) {
      const [sx, sy] = this.toScreen(pts[0][0], pts[0][1]);
      ctx.beginPath();
      ctx.arc(sx, sy, stroke.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    } else {
      ctx.beginPath();
      const [p0x, p0y] = this.toScreen(pts[0][0], pts[0][1]);
      ctx.moveTo(p0x, p0y);

      // Smooth quadratic curve through midpoints
      for (let i = 1; i < pts.length; i++) {
        const [currX, currY] = this.toScreen(pts[i][0], pts[i][1]);
        const [prevX, prevY] = this.toScreen(pts[i - 1][0], pts[i - 1][1]);
        const midX = (prevX + currX) / 2;
        const midY = (prevY + currY) / 2;
        ctx.quadraticCurveTo(prevX, prevY, midX, midY);
      }
      const [lastX, lastY] = this.toScreen(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      ctx.lineTo(lastX, lastY);
      ctx.stroke();
    }
    ctx.restore();
  }

  clearActiveCanvas() {
    this.activeCtx.clearRect(0, 0, this.width, this.height);
  }

  renderAllActiveStrokes() {
    // Re-render local in-progress stroke if active
    if (this.isDrawing && this.localPoints.length > 0) {
      this.renderStroke(this.activeCtx, {
        tool: this.tool,
        color: this.color,
        size: this.brushSize,
        points: this.localPoints,
      });
    }

    // Re-render remote in-progress strokes
    for (const stroke of this.remoteActiveStrokes.values()) {
      this.renderStroke(this.activeCtx, stroke);
    }
  }

  drawSelectionBox(ctx) {
    if (this.tool !== 2) return;

    // Draw active marquee selection box
    if (this.isMarqueeSelecting) {
      const minX = Math.min(this.marqueeStart[0], this.marqueeCurrent[0]);
      const minY = Math.min(this.marqueeStart[1], this.marqueeCurrent[1]);
      const maxX = Math.max(this.marqueeStart[0], this.marqueeCurrent[0]);
      const maxY = Math.max(this.marqueeStart[1], this.marqueeCurrent[1]);

      const [p1x, p1y] = this.toScreen(minX, minY);
      const [p2x, p2y] = this.toScreen(maxX, maxY);
      const mw = p2x - p1x;
      const mh = p2y - p1y;

      ctx.save();
      ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
      ctx.fillRect(p1x, p1y, mw, mh);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p1x, p1y, mw, mh);
      ctx.restore();
    }

    // Draw selection bounding box and 8-point square handles
    if (this.selectedStrokeIds.size > 0) {
      const bounds = this.getSelectionScreenBounds();
      if (!bounds) return;

      const { x, y, width, height } = bounds;

      ctx.save();
      // Subtle highlight fill
      ctx.fillStyle = 'rgba(59, 130, 246, 0.04)';
      ctx.fillRect(x, y, width, height);

      // Bounding Box outline
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, width, height);

      // 8 Square Resize Handles (corners and side midpoints)
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5;
      const handleSize = 8;
      const handles = this.getHandles(bounds);

      for (const [hx, hy] of Object.values(handles)) {
        ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
        ctx.strokeRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      }

      ctx.restore();
    }
  }

  redrawAll() {
    // Clear base canvas with white background
    this.baseCtx.fillStyle = '#ffffff';
    this.baseCtx.fillRect(0, 0, this.width, this.height);

    // Draw all non-undone committed strokes
    for (const sid of this.strokeOrder) {
      const stroke = this.committedStrokes.get(sid);
      if (stroke && !stroke.undone) {
        this.renderStrokeToBase(stroke);
      }
    }

    this.clearActiveCanvas();
    this.renderAllActiveStrokes();
    this.drawSelectionBox(this.activeCtx);
  }

  getSelectedStrokeScreenBounds() {
    return this.getSelectionScreenBounds();
  }

  deleteSelectedStrokes() {
    if (this.selectedStrokeIds.size === 0) return [];
    const deletedIds = [];
    for (const sid of this.selectedStrokeIds) {
      const stroke = this.committedStrokes.get(sid);
      if (stroke) {
        stroke.undone = true;
        deletedIds.push(sid);
      }
    }
    this.selectedStrokeIds.clear();
    this.isDraggingSelection = false;
    this.isResizing = false;
    this.onSelectionChange(this.selectedStrokeIds);
    this.redrawAll();
    return deletedIds;
  }

  deleteSelectedStroke() {
    const ids = this.deleteSelectedStrokes();
    return ids.length > 0 ? ids[0] : null;
  }

  // =========================================================================
  // Board State Sync & Mutations (Undo, Redo, Clear, Initial Snapshot)
  // =========================================================================

  applyStrokeMove(strokeId, dx, dy) {
    const stroke = this.committedStrokes.get(strokeId);
    if (stroke && stroke.points) {
      for (const pt of stroke.points) {
        pt[0] = Math.max(0, Math.min(COORD_SCALE, pt[0] + dx));
        pt[1] = Math.max(0, Math.min(COORD_SCALE, pt[1] + dy));
      }
      this.redrawAll();
    }
  }

  loadSnapshot(strokesList) {
    this.committedStrokes.clear();
    this.strokeOrder = [];
    if (Array.isArray(strokesList)) {
      for (const s of strokesList) {
        const strokeObj = {
          id: s.id,
          userId: s.user_id || s.userId,
          tool: s.tool,
          color: s.color,
          size: s.size,
          points: s.points,
          undone: s.undone || false,
        };
        this.committedStrokes.set(strokeObj.id, strokeObj);
        this.strokeOrder.push(strokeObj.id);
      }
    }
    this.redrawAll();
  }

  applyUndo(strokeId) {
    if (this.committedStrokes.has(strokeId)) {
      this.committedStrokes.get(strokeId).undone = true;
      this.redrawAll();
    }
  }

  applyRedo(strokeId) {
    if (this.committedStrokes.has(strokeId)) {
      this.committedStrokes.get(strokeId).undone = false;
      this.redrawAll();
    }
  }

  clearBoard() {
    this.committedStrokes.clear();
    this.strokeOrder = [];
    this.remoteActiveStrokes.clear();
    this.redrawAll();
  }

  // =========================================================================
  // Render Loop for Remote Cursors
  // =========================================================================

  startRenderLoop() {
    const loop = () => {
      this.drawCursors();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  drawCursors() {
    this.cursorCtx.clearRect(0, 0, this.width, this.height);
    const now = Date.now();

    for (const [userId, cursor] of this.remoteCursors.entries()) {
      if (now - cursor.lastSeen > 3500 || cursor.x === 0) continue;

      const [sx, sy] = this.toScreen(cursor.x, cursor.y);

      this.cursorCtx.save();
      // Draw minimal sleek indicator dot (red when drawing, blue/indigo when moving)
      this.cursorCtx.beginPath();
      this.cursorCtx.arc(sx, sy, cursor.isDrawing ? 5 : 3.5, 0, Math.PI * 2);
      this.cursorCtx.fillStyle = cursor.isDrawing ? '#ef4444' : '#3b82f6';
      this.cursorCtx.fill();
      this.cursorCtx.lineWidth = 1.5;
      this.cursorCtx.strokeStyle = '#ffffff';
      this.cursorCtx.stroke();
      this.cursorCtx.restore();
    }
  }

  getMetrics() {
    const reduction = this.rawPointCount > 0
      ? Math.round(((this.rawPointCount - this.sampledPointCount) / this.rawPointCount) * 100)
      : 0;
    return {
      rawPoints: this.rawPointCount,
      sampledPoints: this.sampledPointCount,
      reductionPercent: reduction,
      totalStrokes: this.committedStrokes.size,
    };
  }
}
