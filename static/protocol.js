/**
 * LiveDraw Binary Protocol Encoder / Decoder
 * Ultra-low footprint binary serialization for WebRTC DataChannels.
 */

const MsgType = {
  STROKE_START: 0x01,
  STROKE_CHUNK: 0x02,
  STROKE_END: 0x03,
  STROKE_UNDO: 0x04,
  STROKE_REDO: 0x05,
  BOARD_CLEAR: 0x06,
  CURSOR_MOVE: 0x07,
  PING: 0x08,
  PONG: 0x09,
  STROKE_TEXT: 0x0A,
};

const COORD_SCALE = 10000;

class Protocol {
  static textEncoder = new TextEncoder();
  static textDecoder = new TextDecoder();

  // Helper: Hex color to RGB
  static hexToRgb(hex) {
    let clean = hex.replace('#', '');
    if (clean.length === 3) {
      clean = clean.split('').map(c => c + c).join('');
    }
    const num = parseInt(clean, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255,
    };
  }

  // Helper: RGB to Hex
  static rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Encode STROKE_START
   * Header: Type(1) | StrokeId(4) | Tool(1) | R(1) | G(1) | B(1) | Size(2) | X0(2) | Y0(2) | UidLen(1) | UidBytes(N)
   */
  static encodeStrokeStart(strokeId, userId, tool, colorHex, size, x0, y0) {
    const uidBytes = this.textEncoder.encode(userId || '');
    const rgb = this.hexToRgb(colorHex || '#000000');
    const buffer = new ArrayBuffer(16 + uidBytes.length);
    const view = new DataView(buffer);

    view.setUint8(0, MsgType.STROKE_START);
    view.setUint32(1, strokeId, false);
    view.setUint8(5, tool);
    view.setUint8(6, rgb.r);
    view.setUint8(7, rgb.g);
    view.setUint8(8, rgb.b);
    view.setUint16(9, Math.round(size * 10), false);
    view.setUint16(11, Math.round(x0), false);
    view.setUint16(13, Math.round(y0), false);
    view.setUint8(15, uidBytes.length);
    new Uint8Array(buffer).set(uidBytes, 16);

    return buffer;
  }

  /**
   * Encode STROKE_CHUNK
   * Header: Type(1) | StrokeId(4) | Seq(2) | Count(2) | Points: [X(2), Y(2)] * N
   */
  static encodeStrokeChunk(strokeId, seq, points) {
    const count = points.length;
    const buffer = new ArrayBuffer(9 + count * 4);
    const view = new DataView(buffer);

    view.setUint8(0, MsgType.STROKE_CHUNK);
    view.setUint32(1, strokeId, false);
    view.setUint16(5, seq, false);
    view.setUint16(7, count, false);

    let offset = 9;
    for (let i = 0; i < count; i++) {
      view.setUint16(offset, Math.round(points[i][0]), false);
      view.setUint16(offset + 2, Math.round(points[i][1]), false);
      offset += 4;
    }

    return buffer;
  }

  /**
   * Encode STROKE_END
   * Header: Type(1) | StrokeId(4)
   */
  static encodeStrokeEnd(strokeId) {
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    view.setUint8(0, MsgType.STROKE_END);
    view.setUint32(1, strokeId, false);
    return buffer;
  }

  /**
   * Encode STROKE_UNDO
   */
  static encodeStrokeUndo(userId, strokeId) {
    const uidBytes = this.textEncoder.encode(userId || '');
    const buffer = new ArrayBuffer(6 + uidBytes.length);
    const view = new DataView(buffer);
    view.setUint8(0, MsgType.STROKE_UNDO);
    view.setUint32(1, strokeId, false);
    view.setUint8(5, uidBytes.length);
    new Uint8Array(buffer).set(uidBytes, 6);
    return buffer;
  }

  /**
   * Encode STROKE_REDO
   */
  static encodeStrokeRedo(userId, strokeId) {
    const uidBytes = this.textEncoder.encode(userId || '');
    const buffer = new ArrayBuffer(6 + uidBytes.length);
    const view = new DataView(buffer);
    view.setUint8(0, MsgType.STROKE_REDO);
    view.setUint32(1, strokeId, false);
    view.setUint8(5, uidBytes.length);
    new Uint8Array(buffer).set(uidBytes, 6);
    return buffer;
  }

  /**
   * Encode BOARD_CLEAR
   */
  static encodeBoardClear(userId) {
    const uidBytes = this.textEncoder.encode(userId || '');
    const buffer = new ArrayBuffer(2 + uidBytes.length);
    const view = new DataView(buffer);
    view.setUint8(0, MsgType.BOARD_CLEAR);
    view.setUint8(1, uidBytes.length);
    new Uint8Array(buffer).set(uidBytes, 2);
    return buffer;
  }

  /**
   * Encode CURSOR_MOVE
   * Type(1) | X(2) | Y(2) | IsDrawing(1) | UidLen(1) | Uid(N)
   */
  static encodeCursorMove(userId, x, y, isDrawing) {
    const uidBytes = this.textEncoder.encode(userId || '');
    const buffer = new ArrayBuffer(7 + uidBytes.length);
    const view = new DataView(buffer);
    view.setUint8(0, MsgType.CURSOR_MOVE);
    view.setUint16(1, Math.round(x), false);
    view.setUint16(3, Math.round(y), false);
    view.setUint8(5, isDrawing ? 1 : 0);
    view.setUint8(6, uidBytes.length);
    new Uint8Array(buffer).set(uidBytes, 7);
    return buffer;
  }

  /**
   * Encode STROKE_TEXT
   * Type(1) | StrokeId(4) | R(1) | G(1) | B(1) | Size(2) | X(2) | Y(2) | TextLen(2) | TextBytes(N) | UidLen(1) | Uid(M)
   */
  static encodeStrokeText(strokeId, userId, text, colorHex, size, x, y) {
    const textBytes = this.textEncoder.encode(text || '');
    const uidBytes = this.textEncoder.encode(userId || '');
    const rgb = this.hexToRgb(colorHex || '#000000');
    const buffer = new ArrayBuffer(17 + textBytes.length + uidBytes.length);
    const view = new DataView(buffer);

    view.setUint8(0, MsgType.STROKE_TEXT);
    view.setUint32(1, strokeId, false);
    view.setUint8(5, rgb.r);
    view.setUint8(6, rgb.g);
    view.setUint8(7, rgb.b);
    view.setUint16(8, Math.round(size * 10), false);
    view.setUint16(10, Math.round(x), false);
    view.setUint16(12, Math.round(y), false);
    view.setUint16(14, textBytes.length, false);
    new Uint8Array(buffer).set(textBytes, 16);

    const uidOffset = 16 + textBytes.length;
    view.setUint8(uidOffset, uidBytes.length);
    new Uint8Array(buffer).set(uidBytes, uidOffset + 1);

    return buffer;
  }

  /**
   * Encode PING
   */
  static encodePing(timestamp) {
    const buffer = new ArrayBuffer(9);
    const view = new DataView(buffer);
    view.setUint8(0, MsgType.PING);
    view.setFloat64(1, timestamp, false);
    return buffer;
  }

  /**
   * Encode PONG
   */
  static encodePong(timestamp) {
    const buffer = new ArrayBuffer(9);
    const view = new DataView(buffer);
    view.setUint8(0, MsgType.PONG);
    view.setFloat64(1, timestamp, false);
    return buffer;
  }

  /**
   * Decode binary message from ArrayBuffer
   */
  static decode(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 1) return null;

    const type = view.getUint8(0);

    switch (type) {
      case MsgType.STROKE_START: {
        const strokeId = view.getUint32(1, false);
        const tool = view.getUint8(5);
        const r = view.getUint8(6);
        const g = view.getUint8(7);
        const b = view.getUint8(8);
        const size = view.getUint16(9, false) / 10;
        const x0 = view.getUint16(11, false);
        const y0 = view.getUint16(13, false);
        const uidLen = view.getUint8(15);
        const uidBytes = new Uint8Array(arrayBuffer, 16, uidLen);
        const userId = this.textDecoder.decode(uidBytes);

        return {
          type: 'stroke_start',
          strokeId,
          userId,
          tool,
          color: this.rgbToHex(r, g, b),
          size,
          point: [x0, y0],
        };
      }

      case MsgType.STROKE_CHUNK: {
        const strokeId = view.getUint32(1, false);
        const seq = view.getUint16(5, false);
        const count = view.getUint16(7, false);
        const points = [];
        let offset = 9;
        for (let i = 0; i < count; i++) {
          const x = view.getUint16(offset, false);
          const y = view.getUint16(offset + 2, false);
          points.push([x, y]);
          offset += 4;
        }

        return {
          type: 'stroke_chunk',
          strokeId,
          seq,
          points,
        };
      }

      case MsgType.STROKE_END: {
        const strokeId = view.getUint32(1, false);
        return {
          type: 'stroke_end',
          strokeId,
        };
      }

      case MsgType.STROKE_UNDO: {
        const strokeId = view.getUint32(1, false);
        const uidLen = view.getUint8(5);
        const uidBytes = new Uint8Array(arrayBuffer, 6, uidLen);
        const userId = this.textDecoder.decode(uidBytes);
        return {
          type: 'stroke_undo',
          strokeId,
          userId,
        };
      }

      case MsgType.STROKE_REDO: {
        const strokeId = view.getUint32(1, false);
        const uidLen = view.getUint8(5);
        const uidBytes = new Uint8Array(arrayBuffer, 6, uidLen);
        const userId = this.textDecoder.decode(uidBytes);
        return {
          type: 'stroke_redo',
          strokeId,
          userId,
        };
      }

      case MsgType.BOARD_CLEAR: {
        const uidLen = view.getUint8(1);
        const uidBytes = new Uint8Array(arrayBuffer, 2, uidLen);
        const userId = this.textDecoder.decode(uidBytes);
        return {
          type: 'board_clear',
          userId,
        };
      }

      case MsgType.CURSOR_MOVE: {
        const x = view.getUint16(1, false);
        const y = view.getUint16(3, false);
        const isDrawing = view.getUint8(5) === 1;
        const uidLen = view.getUint8(6);
        const uidBytes = new Uint8Array(arrayBuffer, 7, uidLen);
        const userId = this.textDecoder.decode(uidBytes);
        return {
          type: 'cursor_move',
          userId,
          x,
          y,
          isDrawing,
        };
      }

      case MsgType.PING: {
        const timestamp = view.getFloat64(1, false);
        return {
          type: 'ping',
          timestamp,
        };
      }

      case MsgType.PONG: {
        const timestamp = view.getFloat64(1, false);
        return {
          type: 'pong',
          timestamp,
        };
      }

      case MsgType.STROKE_TEXT: {
        const strokeId = view.getUint32(1, false);
        const r = view.getUint8(5);
        const g = view.getUint8(6);
        const b = view.getUint8(7);
        const size = view.getUint16(8, false) / 10;
        const x = view.getUint16(10, false);
        const y = view.getUint16(12, false);
        const textLen = view.getUint16(14, false);
        const textBytes = new Uint8Array(arrayBuffer, 16, textLen);
        const text = this.textDecoder.decode(textBytes);

        const uidOffset = 16 + textLen;
        const uidLen = view.getUint8(uidOffset);
        const uidBytes = new Uint8Array(arrayBuffer, uidOffset + 1, uidLen);
        const userId = this.textDecoder.decode(uidBytes);

        return {
          type: 'stroke_text',
          strokeId,
          userId,
          tool: 2,
          color: this.rgbToHex(r, g, b),
          size,
          text,
          point: [x, y],
        };
      }

      default:
        return null;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Protocol, MsgType, COORD_SCALE };
}
