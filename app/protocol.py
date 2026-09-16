"""
LiveDraw Binary & JSON Protocol Definition
Ultra-compact encoding for low-latency live stroke streaming.
"""

from enum import IntEnum

class MsgType(IntEnum):
    STROKE_START = 0x01
    STROKE_CHUNK = 0x02
    STROKE_END = 0x03
    STROKE_UNDO = 0x04
    STROKE_REDO = 0x05
    BOARD_CLEAR = 0x06
    CURSOR_MOVE = 0x07
    PING = 0x08
    PONG = 0x09
    BOARD_SYNC_REQUEST = 0x10
    BOARD_SYNC_RESPONSE = 0x11

class ToolType(IntEnum):
    PEN = 0
    ERASER = 1

# Coordinate scale for 0..10000 normalization
COORD_SCALE = 10000
