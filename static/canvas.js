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
    this.onCursorMove = options.onCursorMove || (() => {});
    this.onTextRequest = options.onTextRequest || (() => {});

    // Drawing settings
    this.tool = 0; // 0 = Pen, 1 = Eraser, 2 = Text
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

    // Remote active strokes map: strokeId -> { userId, tool, color, size, points, lastPoint }
    this.remoteActiveStrokes = new Map();
    // Remote live text editing map: strokeId -> { id, userId, text, color, size, point, lastSeen }
    this.remoteLiveTexts = new Map();
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

    // Text tool tap handler
    if (this.tool === 2) {
      this.onTextRequest({ x: normX, y: normY, clientX: e.clientX, clientY: e.clientY });
      return;
    }

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
    const [sx, sy] = this.toScreen(normX, normY);
    this.drawDot(this.activeCtx, sx, sy, this.tool, this.color, this.brushSize);
  }

  handlePointerMove(e) {
    const [normX, normY] = this.toNormalized(e.clientX, e.clientY);
    
    // Broadcast cursor position
    this.onCursorMove(normX, normY, this.isDrawing);

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

    // Render Text Element
    if (stroke.tool === 2 && stroke.text) {
      const [sx, sy] = this.toScreen(pts[0][0], pts[0][1]);
      const fontSize = Math.max(14, Math.round((stroke.size || 2) * 6));
      ctx.save();
      ctx.font = `600 ${fontSize}px 'Outfit', -apple-system, sans-serif`;
      ctx.fillStyle = stroke.color || '#1e1e1e';
      ctx.textBaseline = 'top';
      ctx.fillText(stroke.text, sx, sy);
      ctx.restore();
      return;
    }

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

    // Re-render remote live typing text in real time
    for (const item of this.remoteLiveTexts.values()) {
      if (item.text && item.point) {
        const [sx, sy] = this.toScreen(item.point[0], item.point[1]);
        const fontSize = Math.max(14, Math.round((item.size || 2) * 6));
        this.activeCtx.save();
        this.activeCtx.font = `600 ${fontSize}px 'Outfit', -apple-system, sans-serif`;
        this.activeCtx.fillStyle = item.color || '#1e1e1e';
        this.activeCtx.textBaseline = 'top';
        this.activeCtx.fillText(item.text, sx, sy);

        // Blinking live cursor indicator next to remote text
        const textWidth = this.activeCtx.measureText(item.text).width;
        this.activeCtx.fillStyle = item.color || '#3b82f6';
        this.activeCtx.fillRect(sx + textWidth + 2, sy, 2, fontSize);
        this.activeCtx.restore();
      }
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
  }

  // =========================================================================
  // Board State Sync & Mutations (Undo, Redo, Clear, Initial Snapshot)
  // =========================================================================

  handleRemoteLiveText(data) {
    if (!data.text || !data.text.trim()) {
      this.remoteLiveTexts.delete(data.strokeId);
    } else {
      this.remoteLiveTexts.set(data.strokeId, {
        strokeId: data.strokeId,
        userId: data.userId,
        text: data.text,
        color: data.color,
        size: data.size,
        point: data.point,
        lastSeen: Date.now(),
      });
    }
    this.clearActiveCanvas();
    this.renderAllActiveStrokes();
  }

  handleRemoteStrokeText(data) {
    this.remoteLiveTexts.delete(data.strokeId);
    const stroke = {
      id: data.strokeId,
      userId: data.userId,
      tool: 2,
      text: data.text,
      color: data.color,
      size: data.size,
      points: [data.point],
      undone: false,
    };
    this.committedStrokes.set(stroke.id, stroke);
    this.strokeOrder.push(stroke.id);
    this.renderStrokeToBase(stroke);
    this.clearActiveCanvas();
    this.renderAllActiveStrokes();
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
          text: s.text,
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
