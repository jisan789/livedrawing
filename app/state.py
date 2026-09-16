"""
LiveDraw In-Memory Board State Manager
Authoritative storage of vector strokes, supporting concurrent users, undo/redo, and fast sync.
"""

from typing import Dict, List, Optional, Any
import time
import threading

class Stroke:
    def __init__(
        self,
        stroke_id: int,
        user_id: str,
        tool: int,
        color: str,
        size: float,
        points: Optional[List[List[int]]] = None,
    ):
        self.stroke_id = stroke_id
        self.user_id = user_id
        self.tool = tool
        self.color = color
        self.size = size
        self.points: List[List[int]] = points or []
        self.created_at = time.time()
        self.is_finished = False
        self.is_undone = False

    def add_point(self, x: int, y: int):
        self.points.append([x, y])

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.stroke_id,
            "user_id": self.user_id,
            "tool": self.tool,
            "color": self.color,
            "size": self.size,
            "points": self.points,
            "undone": self.is_undone,
        }


class BoardState:
    def __init__(self):
        self._lock = threading.Lock()
        self.strokes: Dict[int, Stroke] = {}
        self.stroke_order: List[int] = []
        self.user_undo_stack: Dict[str, List[int]] = {}  # user_id -> list of stroke_ids
        self.user_redo_stack: Dict[str, List[int]] = {}  # user_id -> list of stroke_ids

    def start_stroke(self, stroke_id: int, user_id: str, tool: int, color: str, size: float, x: int, y: int) -> Stroke:
        with self._lock:
            stroke = Stroke(stroke_id, user_id, tool, color, size, [[x, y]])
            self.strokes[stroke_id] = stroke
            self.stroke_order.append(stroke_id)
            
            if user_id not in self.user_undo_stack:
                self.user_undo_stack[user_id] = []
            if user_id not in self.user_redo_stack:
                self.user_redo_stack[user_id] = []
            
            self.user_undo_stack[user_id].append(stroke_id)
            self.user_redo_stack[user_id].clear()  # New drawing clears redo stack
            return stroke

    def append_points(self, stroke_id: int, points: List[List[int]]):
        with self._lock:
            if stroke_id in self.strokes:
                stroke = self.strokes[stroke_id]
                for pt in points:
                    stroke.add_point(pt[0], pt[1])

    def end_stroke(self, stroke_id: int):
        with self._lock:
            if stroke_id in self.strokes:
                self.strokes[stroke_id].is_finished = True

    def undo(self, user_id: str) -> Optional[int]:
        """Undoes the last active stroke by the user."""
        with self._lock:
            stack = self.user_undo_stack.get(user_id, [])
            while stack:
                sid = stack.pop()
                if sid in self.strokes and not self.strokes[sid].is_undone:
                    self.strokes[sid].is_undone = True
                    self.user_redo_stack.setdefault(user_id, []).append(sid)
                    return sid
            return None

    def redo(self, user_id: str) -> Optional[int]:
        """Redoes the last undone stroke by the user."""
        with self._lock:
            stack = self.user_redo_stack.get(user_id, [])
            while stack:
                sid = stack.pop()
                if sid in self.strokes and self.strokes[sid].is_undone:
                    self.strokes[sid].is_undone = False
                    self.user_undo_stack.setdefault(user_id, []).append(sid)
                    return sid
            return None

    def clear(self, user_id: Optional[str] = None):
        """Clears the board."""
        with self._lock:
            self.strokes.clear()
            self.stroke_order.clear()
            self.user_undo_stack.clear()
            self.user_redo_stack.clear()

    def get_snapshot(self) -> List[Dict[str, Any]]:
        """Returns all visible (non-undone) strokes in order."""
        with self._lock:
            snapshot = []
            for sid in self.stroke_order:
                if sid in self.strokes:
                    s = self.strokes[sid]
                    if not s.is_undone and len(s.points) > 0:
                        snapshot.append(s.to_dict())
            return snapshot

    def get_stats(self) -> Dict[str, Any]:
        with self._lock:
            total_strokes = len(self.strokes)
            visible_strokes = sum(1 for s in self.strokes.values() if not s.is_undone)
            total_points = sum(len(s.points) for s in self.strokes.values() if not s.is_undone)
            return {
                "total_strokes": total_strokes,
                "visible_strokes": visible_strokes,
                "total_points": total_points,
            }

board_state = BoardState()
