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
    this.onZoomChange = options.onZoomChange || (() => {});
    this.onReferenceImageChange = options.onReferenceImageChange || (() => {});

    // Drawing settings
    this.tool = 0; // 0 = Pen, 1 = Eraser, 2 = Select, 3 = Zoom/Pan
    this.color = '#1e1e1e';
    this.brushSize = 2;
    this.userId = options.userId || 'ME';

    // Local Reference Image Layer (Strictly local, 50% opacity default, lockable)
    this.referenceImage = null; // { img, x, y, width, height, opacity, locked, visible, loaded }
    this.isDraggingRefImage = false;
    this.isResizingRefImage = false;
    this.refResizeHandle = null;
    this.refDragStart = [0, 0];
    this.refInitialState = null;

    // Viewport Navigation (Zoom & Pan)
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.activePointers = new Map(); // pointerId -> { x, y }
    this.isPanning = false;
    this.isPinching = false;
    this.pinchStartDist = 0;
    this.pinchStartZoom = 1.0;
    this.pinchStartPan = [0, 0];
    this.pinchStartCenterLocal = [0, 0];
    this.panStartPointer = [0, 0];
    this.panStartOffset = [0, 0];

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
    }
    if (tool === 3) {
      this.cursorCanvas.style.cursor = 'grab';
    } else if (tool === 2) {
      this.cursorCanvas.style.cursor = 'default';
    } else {
      this.cursorCanvas.style.cursor = 'crosshair';
    }
    this.redrawAll();
  }

  setColor(color) {
    this.color = color;
  }

  setBrushSize(size) {
    this.brushSize = size;
  }

  // Zoom & Pan API
  zoomAt(screenX, screenY, newZoom) {
    const clampedZoom = Math.max(0.25, Math.min(10.0, newZoom));
    const oldZoom = this.zoom;
    if (Math.abs(clampedZoom - oldZoom) < 0.001) return;

    // Pin the content under (screenX, screenY) during zoom
    this.panX = screenX - (screenX - this.panX) * (clampedZoom / oldZoom);
    this.panY = screenY - (screenY - this.panY) * (clampedZoom / oldZoom);
    this.zoom = clampedZoom;

    this.onZoomChange(this.zoom, this.panX, this.panY);
    this.redrawAll();
  }

  zoomIn() {
    this.zoomAt(this.width / 2, this.height / 2, this.zoom * 1.25);
  }

  zoomOut() {
    this.zoomAt(this.width / 2, this.height / 2, this.zoom / 1.25);
  }

  resetZoom() {
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.onZoomChange(this.zoom, this.panX, this.panY);
    this.redrawAll();
  }

  // Coordinate Conversion: Screen Pixels <-> Normalized 0..10000 (Respecting Pan & Zoom)
  toNormalized(clientX, clientY) {
    const rect = this.cursorCanvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const normX = Math.max(0, Math.min(COORD_SCALE, Math.round(((px - this.panX) / (this.width * this.zoom)) * COORD_SCALE)));
    const normY = Math.max(0, Math.min(COORD_SCALE, Math.round(((py - this.panY) / (this.height * this.zoom)) * COORD_SCALE)));
    return [normX, normY];
  }

  toScreen(normX, normY) {
    return [
      this.panX + (normX / COORD_SCALE) * this.width * this.zoom,
      this.panY + (normY / COORD_SCALE) * this.height * this.zoom,
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

  // Reference Image Geometry Helpers
  isPointInsideRefImage(normX, normY) {
    if (!this.referenceImage || !this.referenceImage.visible) return false;
    const { x, y, width, height } = this.referenceImage;
    return normX >= x && normX <= x + width && normY >= y && normY <= y + height;
  }

  getRefImageScreenBounds() {
    if (!this.referenceImage || !this.referenceImage.visible) return null;
    const ref = this.referenceImage;
    const [sx, sy] = this.toScreen(ref.x, ref.y);
    const sw = (ref.width / COORD_SCALE) * this.width * this.zoom;
    const sh = (ref.height / COORD_SCALE) * this.height * this.zoom;
    return { x: sx, y: sy, width: sw, height: sh };
  }

  getRefImageHandles() {
    const b = this.getRefImageScreenBounds();
    if (!b) return {};
    const { x, y, width, height } = b;
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

  getRefImageHandleUnderPointer(sx, sy) {
    if (!this.referenceImage || this.referenceImage.locked || !this.referenceImage.visible) return null;
    const handles = this.getRefImageHandles();
    const hitRadius = 14;
    for (const [name, pos] of Object.entries(handles)) {
      const distSq = (sx - pos[0]) ** 2 + (sy - pos[1]) ** 2;
      if (distSq <= hitRadius ** 2) {
        return name;
      }
    }
    return null;
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

    // Wheel zooming & trackpad panning
    this.cursorCanvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });

    // Pointer Events on topmost layer
    this.cursorCanvas.addEventListener('pointerdown', this.handlePointerDown.bind(this));
    this.cursorCanvas.addEventListener('pointermove', this.handlePointerMove.bind(this));
    this.cursorCanvas.addEventListener('pointerup', this.handlePointerUp.bind(this));
    this.cursorCanvas.addEventListener('pointercancel', this.handlePointerUp.bind(this));
    this.cursorCanvas.addEventListener('pointerleave', this.handlePointerLeave.bind(this));
  }

  handleWheel(e) {
    e.preventDefault();
    const rect = this.cursorCanvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    if (e.ctrlKey || e.metaKey || this.tool === 3) {
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      this.zoomAt(screenX, screenY, this.zoom * zoomFactor);
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.onZoomChange(this.zoom, this.panX, this.panY);
      this.redrawAll();
    }
  }

  cancelDrawing() {
    this.isDrawing = false;
    this.localPoints = [];
    this.pendingPoints = [];
    this.clearActiveCanvas();
    this.renderAllActiveStrokes();
  }

  handlePointerDown(e) {
    e.preventDefault();
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Multi-touch pinch gesture detected (2 or more fingers)
    if (this.activePointers.size >= 2) {
      if (this.isDrawing) {
        this.cancelDrawing();
      }
      this.isDraggingSelection = false;
      this.isResizing = false;
      this.isMarqueeSelecting = false;
      this.isPanning = false;
      this.isPinching = true;

      const pts = Array.from(this.activePointers.values());
      this.pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.pinchStartZoom = this.zoom;
      this.pinchStartPan = [this.panX, this.panY];
      const rect = this.cursorCanvas.getBoundingClientRect();
      this.pinchStartCenterLocal = [
        (pts[0].x + pts[1].x) / 2 - rect.left,
        (pts[0].y + pts[1].y) / 2 - rect.top,
      ];
      this.redrawAll();
      return;
    }

    // Zoom / Pan Tool (tool === 3)
    if (this.tool === 3) {
      this.isPanning = true;
      this.panStartPointer = [e.clientX, e.clientY];
      this.panStartOffset = [this.panX, this.panY];
      this.cursorCanvas.style.cursor = 'grabbing';
      try {
        this.cursorCanvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      return;
    }

    if (e.button !== undefined && e.button !== 0) return; // Only primary button

    const [normX, normY] = this.toNormalized(e.clientX, e.clientY);
    const [sx, sy] = this.toScreen(normX, normY);

    // Check Unlocked Reference Image Interaction (resize handles or drag move)
    if (this.referenceImage && !this.referenceImage.locked && this.referenceImage.visible) {
      const refHandle = this.getRefImageHandleUnderPointer(sx, sy);
      if (refHandle) {
        this.isResizingRefImage = true;
        this.refResizeHandle = refHandle;
        this.refDragStart = [normX, normY];
        this.refInitialState = {
          x: this.referenceImage.x,
          y: this.referenceImage.y,
          width: this.referenceImage.width,
          height: this.referenceImage.height,
        };
        try { this.cursorCanvas.setPointerCapture(e.pointerId); } catch (_) {}
        this.redrawAll();
        return;
      }

      if (this.isPointInsideRefImage(normX, normY)) {
        this.isDraggingRefImage = true;
        this.refDragStart = [normX, normY];
        this.refInitialState = {
          x: this.referenceImage.x,
          y: this.referenceImage.y,
          width: this.referenceImage.width,
          height: this.referenceImage.height,
        };
        try { this.cursorCanvas.setPointerCapture(e.pointerId); } catch (_) {}
        this.redrawAll();
        return;
      }
    }

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
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Handle 2-Finger Pinch Zoom + Pan
    if (this.isPinching && this.activePointers.size >= 2) {
      const pts = Array.from(this.activePointers.values());
      const currDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const rect = this.cursorCanvas.getBoundingClientRect();
      const currCenterLocal = [
        (pts[0].x + pts[1].x) / 2 - rect.left,
        (pts[0].y + pts[1].y) / 2 - rect.top,
      ];

      if (this.pinchStartDist > 0) {
        const scaleFactor = currDist / this.pinchStartDist;
        const targetZoom = Math.max(0.25, Math.min(10.0, this.pinchStartZoom * scaleFactor));

        const cX = this.pinchStartCenterLocal[0];
        const cY = this.pinchStartCenterLocal[1];

        const newPanX = cX - (cX - this.pinchStartPan[0]) * (targetZoom / this.pinchStartZoom) + (currCenterLocal[0] - this.pinchStartCenterLocal[0]);
        const newPanY = cY - (cY - this.pinchStartPan[1]) * (targetZoom / this.pinchStartZoom) + (currCenterLocal[1] - this.pinchStartCenterLocal[1]);

        this.zoom = targetZoom;
        this.panX = newPanX;
        this.panY = newPanY;
        this.onZoomChange(this.zoom, this.panX, this.panY);
        this.redrawAll();
      }
      return;
    }

    // Handle 1-Finger Pan in Zoom/Hand Tool (tool === 3)
    if (this.tool === 3 && this.isPanning) {
      const dx = e.clientX - this.panStartPointer[0];
      const dy = e.clientY - this.panStartPointer[1];
      this.panX = this.panStartOffset[0] + dx;
      this.panY = this.panStartOffset[1] + dy;
      this.onZoomChange(this.zoom, this.panX, this.panY);
      this.redrawAll();
      return;
    }

    const [normX, normY] = this.toNormalized(e.clientX, e.clientY);
    const [sx, sy] = this.toScreen(normX, normY);
    
    // Broadcast cursor position
    this.onCursorMove(normX, normY, this.isDrawing || this.isDraggingSelection || this.isResizing || this.isDraggingRefImage || this.isResizingRefImage);

    // Handle Unlocked Reference Image Dragging & Resizing
    if (this.isDraggingRefImage && this.referenceImage && this.refInitialState) {
      const dx = normX - this.refDragStart[0];
      const dy = normY - this.refDragStart[1];
      this.referenceImage.x = Math.max(0, Math.min(COORD_SCALE - this.referenceImage.width, this.refInitialState.x + dx));
      this.referenceImage.y = Math.max(0, Math.min(COORD_SCALE - this.referenceImage.height, this.refInitialState.y + dy));
      this.redrawAll();
      return;
    }

    if (this.isResizingRefImage && this.referenceImage && this.refInitialState) {
      const dx = normX - this.refDragStart[0];
      const dy = normY - this.refDragStart[1];
      const handle = this.refResizeHandle;
      const init = this.refInitialState;

      let newX = init.x;
      let newY = init.y;
      let newW = init.width;
      let newH = init.height;

      if (handle.includes('e')) newW = Math.max(400, init.width + dx);
      if (handle.includes('s')) newH = Math.max(400, init.height + dy);
      if (handle.includes('w')) {
        const delta = Math.min(dx, init.width - 400);
        newX = init.x + delta;
        newW = init.width - delta;
      }
      if (handle.includes('n')) {
        const delta = Math.min(dy, init.height - 400);
        newY = init.y + delta;
        newH = init.height - delta;
      }

      this.referenceImage.x = Math.max(0, newX);
      this.referenceImage.y = Math.max(0, newY);
      this.referenceImage.width = Math.min(COORD_SCALE - this.referenceImage.x, newW);
      this.referenceImage.height = Math.min(COORD_SCALE - this.referenceImage.y, newH);
      this.redrawAll();
      return;
    }

    // Hover cursor for Unlocked Reference Image
    if (this.referenceImage && !this.referenceImage.locked && this.referenceImage.visible && !this.isDrawing && !this.isDraggingSelection && !this.isResizing && !this.isMarqueeSelecting) {
      const refHandle = this.getRefImageHandleUnderPointer(sx, sy);
      if (refHandle) {
        if (refHandle === 'nw' || refHandle === 'se') this.cursorCanvas.style.cursor = 'nwse-resize';
        else if (refHandle === 'ne' || refHandle === 'sw') this.cursorCanvas.style.cursor = 'nesw-resize';
        else if (refHandle === 'n' || refHandle === 's') this.cursorCanvas.style.cursor = 'ns-resize';
        else if (refHandle === 'w' || refHandle === 'e') this.cursorCanvas.style.cursor = 'ew-resize';
      } else if (this.isPointInsideRefImage(normX, normY)) {
        this.cursorCanvas.style.cursor = 'move';
      }
    }

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
    this.activePointers.delete(e.pointerId);

    if (this.isDraggingRefImage || this.isResizingRefImage) {
      this.isDraggingRefImage = false;
      this.isResizingRefImage = false;
      this.refResizeHandle = null;
      try {
        this.cursorCanvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      this.onReferenceImageChange(this.referenceImage);
      this.redrawAll();
      return;
    }

    if (this.isPinching) {
      if (this.activePointers.size < 2) {
        this.isPinching = false;
      }
      this.redrawAll();
      return;
    }

    if (this.tool === 3) {
      this.isPanning = false;
      this.cursorCanvas.style.cursor = 'grab';
      try {
        this.cursorCanvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      return;
    }

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
    this.activePointers.clear();
    this.isPinching = false;
    if (this.tool === 3) {
      this.isPanning = false;
      this.cursorCanvas.style.cursor = 'grab';
    }
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
    const r = ((size || 2) * this.zoom) / 2;
    ctx.arc(x, y, r, 0, Math.PI * 2);
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
    ctx.lineWidth = (size || 2) * this.zoom;
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
    ctx.lineWidth = (stroke.size || 2) * this.zoom;
    ctx.strokeStyle = stroke.tool === 1 ? '#ffffff' : stroke.color;

    if (pts.length === 1) {
      const [sx, sy] = this.toScreen(pts[0][0], pts[0][1]);
      ctx.beginPath();
      ctx.arc(sx, sy, ((stroke.size || 2) * this.zoom) / 2, 0, Math.PI * 2);
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

    // 1. Render Local Reference Image (underneath all strokes at 50% opacity)
    if (this.referenceImage && this.referenceImage.loaded) {
      this.renderReferenceImage(this.baseCtx);
    }

    // 2. Draw all non-undone committed strokes
    for (const sid of this.strokeOrder) {
      const stroke = this.committedStrokes.get(sid);
      if (stroke && !stroke.undone) {
        this.renderStrokeToBase(stroke);
      }
    }

    this.clearActiveCanvas();
    this.renderAllActiveStrokes();
    this.drawSelectionBox(this.activeCtx);

    // 3. Draw Unlocked Reference Image Bounding Box & Handles
    if (this.referenceImage && !this.referenceImage.locked && this.referenceImage.visible) {
      this.drawReferenceImageOverlay(this.activeCtx);
    }
  }

  // =========================================================================
  // Local Reference Image API (Tracing & Reference Overlay)
  // =========================================================================

  setReferenceImage(img) {
    if (!img) return;

    const aspect = (img.naturalWidth || img.width || 1) / (img.naturalHeight || img.height || 1);
    let targetNormW = 5000;
    let targetNormH = Math.round(5000 / aspect);
    if (targetNormH > 7500) {
      targetNormH = 7500;
      targetNormW = Math.round(7500 * aspect);
    }

    const [centerNormX, centerNormY] = this.toNormalized(this.width / 2, this.height / 2);
    const normX = Math.max(0, Math.min(COORD_SCALE - targetNormW, Math.round(centerNormX - targetNormW / 2)));
    const normY = Math.max(0, Math.min(COORD_SCALE - targetNormH, Math.round(centerNormY - targetNormH / 2)));

    this.referenceImage = {
      img: img,
      x: normX,
      y: normY,
      width: targetNormW,
      height: targetNormH,
      opacity: 0.5,
      locked: false,
      visible: true,
      loaded: true,
    };

    this.onReferenceImageChange(this.referenceImage);
    this.redrawAll();
  }

  renderReferenceImage(ctx) {
    if (!this.referenceImage || !this.referenceImage.visible || !this.referenceImage.img) return;
    const ref = this.referenceImage;
    const [sx, sy] = this.toScreen(ref.x, ref.y);
    const sw = (ref.width / COORD_SCALE) * this.width * this.zoom;
    const sh = (ref.height / COORD_SCALE) * this.height * this.zoom;

    ctx.save();
    ctx.globalAlpha = ref.opacity !== undefined ? ref.opacity : 0.5;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ref.img, sx, sy, sw, sh);
    ctx.restore();
  }

  drawReferenceImageOverlay(ctx) {
    if (!this.referenceImage || this.referenceImage.locked || !this.referenceImage.visible) return;
    const ref = this.referenceImage;
    const [sx, sy] = this.toScreen(ref.x, ref.y);
    const sw = (ref.width / COORD_SCALE) * this.width * this.zoom;
    const sh = (ref.height / COORD_SCALE) * this.height * this.zoom;

    ctx.save();
    // Bounding box dashed outline
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx, sy, sw, sh);

    // 8 handles
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    const handleSize = 8;
    const handles = this.getRefImageHandles();

    for (const [hx, hy] of Object.values(handles)) {
      ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
    }
    ctx.restore();
  }

  setReferenceImageOpacity(opacity) {
    if (this.referenceImage) {
      this.referenceImage.opacity = Math.max(0.1, Math.min(1.0, opacity));
      this.onReferenceImageChange(this.referenceImage);
      this.redrawAll();
    }
  }

  lockReferenceImage(locked) {
    if (this.referenceImage) {
      this.referenceImage.locked = locked;
      this.isDraggingRefImage = false;
      this.isResizingRefImage = false;
      this.onReferenceImageChange(this.referenceImage);
      this.redrawAll();
    }
  }

  toggleReferenceImageVisibility() {
    if (this.referenceImage) {
      this.referenceImage.visible = !this.referenceImage.visible;
      this.onReferenceImageChange(this.referenceImage);
      this.redrawAll();
    }
  }

  removeReferenceImage() {
    this.referenceImage = null;
    this.isDraggingRefImage = false;
    this.isResizingRefImage = false;
    this.onReferenceImageChange(null);
    this.redrawAll();
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
