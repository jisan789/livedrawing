"""
LiveDraw In-Memory Board State Manager
Authoritative storage of vector strokes, supporting concurrent users, undo/redo, and fast sync.
"""

from typing import Dict, List, Optional, Any
import os
import json
import time
import threading
import logging

logger = logging.getLogger("livedraw.state")

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
    def __init__(self, storage_path: str = "board_state.json"):
        self._lock = threading.Lock()
        self.storage_path = storage_path
        self.strokes: Dict[int, Stroke] = {}
        self.stroke_order: List[int] = []
        self.user_undo_stack: Dict[str, List[int]] = {}  # user_id -> list of stroke_ids
        self.user_redo_stack: Dict[str, List[int]] = {}  # user_id -> list of stroke_ids
        self.load_from_disk()

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
            self.user_redo_stack[user_id].clear()
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
        self.save_to_disk()

    def move_stroke(self, stroke_id: int, dx: int, dy: int) -> bool:
        moved = False
        with self._lock:
            if stroke_id in self.strokes:
                stroke = self.strokes[stroke_id]
                for pt in stroke.points:
                    pt[0] = max(0, min(10000, pt[0] + dx))
                    pt[1] = max(0, min(10000, pt[1] + dy))
                moved = True
        if moved:
            self.save_to_disk()
        return moved

    def undo(self, user_id: str) -> Optional[int]:
        """Undoes the last active stroke by the user."""
        undone_sid = None
        with self._lock:
            stack = self.user_undo_stack.get(user_id, [])
            while stack:
                sid = stack.pop()
                if sid in self.strokes and not self.strokes[sid].is_undone:
                    self.strokes[sid].is_undone = True
                    self.user_redo_stack.setdefault(user_id, []).append(sid)
                    undone_sid = sid
                    break
        if undone_sid:
            self.save_to_disk()
        return undone_sid

    def redo(self, user_id: str) -> Optional[int]:
        """Redoes the last undone stroke by the user."""
        redone_sid = None
        with self._lock:
            stack = self.user_redo_stack.get(user_id, [])
            while stack:
                sid = stack.pop()
                if sid in self.strokes and self.strokes[sid].is_undone:
                    self.strokes[sid].is_undone = False
                    self.user_undo_stack.setdefault(user_id, []).append(sid)
                    redone_sid = sid
                    break
        if redone_sid:
            self.save_to_disk()
        return redone_sid

    def clear(self, user_id: Optional[str] = None):
        """Clears the board and updates disk state."""
        with self._lock:
            self.strokes.clear()
            self.stroke_order.clear()
            self.user_undo_stack.clear()
            self.user_redo_stack.clear()
        self.save_to_disk()

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

    def save_to_disk(self):
        """Saves current RAM state to disk JSON file."""
        with self._lock:
            try:
                data = {
                    "strokes": {sid: s.to_dict() for sid, s in self.strokes.items()},
                    "stroke_order": self.stroke_order,
                    "user_undo_stack": self.user_undo_stack,
                    "user_redo_stack": self.user_redo_stack,
                    "saved_at": time.time(),
                }
                temp_file = f"{self.storage_path}.tmp"
                with open(temp_file, "w", encoding="utf-8") as f:
                    json.dump(data, f)
                os.replace(temp_file, self.storage_path)

                visible_strokes = sum(1 for s in self.strokes.values() if not s.is_undone)
                total_points = sum(len(s.points) for s in self.strokes.values() if not s.is_undone)
                log_msg = f"[BOARD SAVE] Saved {visible_strokes} active strokes ({total_points} points) to disk file '{self.storage_path}'."
                logger.info(log_msg)
                print(log_msg, flush=True)
            except Exception as e:
                logger.error(f"[BOARD SAVE ERROR] Failed to save board state to disk: {e}")

    def load_from_disk(self):
        """Loads board state from disk JSON backup into RAM."""
        with self._lock:
            if not os.path.exists(self.storage_path):
                log_msg = f"[BOARD RESTORE] No existing backup found at '{self.storage_path}'. Starting with fresh board."
                logger.info(log_msg)
                print(log_msg, flush=True)
                return
            try:
                with open(self.storage_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.strokes.clear()
                self.stroke_order.clear()

                strokes_dict = data.get("strokes", {})
                for sid_str, s_dict in strokes_dict.items():
                    sid = int(sid_str)
                    stroke = Stroke(
                        stroke_id=s_dict["id"],
                        user_id=s_dict["user_id"],
                        tool=s_dict["tool"],
                        color=s_dict["color"],
                        size=s_dict["size"],
                        points=s_dict["points"],
                    )
                    stroke.is_undone = s_dict.get("undone", False)
                    self.strokes[sid] = stroke

                self.stroke_order = [int(sid) for sid in data.get("stroke_order", [])]
                self.user_undo_stack = data.get("user_undo_stack", {})
                self.user_redo_stack = data.get("user_redo_stack", {})

                visible_strokes = sum(1 for s in self.strokes.values() if not s.is_undone)
                total_points = sum(len(s.points) for s in self.strokes.values() if not s.is_undone)
                log_msg = f"[BOARD RESTORE] Restored {visible_strokes} active strokes ({total_points} points) from disk file '{self.storage_path}'."
                logger.info(log_msg)
                print(log_msg, flush=True)
            except Exception as e:
                logger.error(f"[BOARD RESTORE ERROR] Failed to load board state from disk: {e}")

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
