"""
LiveDraw WebRTC Signaling & WebSocket Hub
Manages connected peers, forwards SDP offers/answers, ICE candidates, and manages board state sync.
"""

from fastapi import WebSocket, WebSocketDisconnect
from typing import Dict, List, Any
import json
import secrets
import logging
from app.state import board_state

logger = logging.getLogger("livedraw.signaling")

# Palette of clean vibrant user avatar colors
USER_COLORS = [
    "#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6",
    "#EC4899", "#06B6D4", "#F97316", "#14B8A6", "#6366F1"
]

class Peer:
    def __init__(self, user_id: str, websocket: WebSocket, color: str):
        self.user_id = user_id
        self.websocket = websocket
        self.color = color

class SignalingHub:
    def __init__(self):
        self.active_peers: Dict[str, Peer] = {}

    def get_peer_count(self) -> int:
        return len(self.active_peers)

    def generate_user_id(self) -> str:
        while True:
            uid = secrets.token_hex(2).upper()
            if uid not in self.active_peers:
                return uid

    def pick_color(self) -> str:
        idx = len(self.active_peers) % len(USER_COLORS)
        return USER_COLORS[idx]

    async def connect(self, websocket: WebSocket) -> Peer:
        await websocket.accept()
        user_id = self.generate_user_id()
        color = self.pick_color()
        peer = Peer(user_id, websocket, color)
        
        # Existing peer IDs before adding this one
        existing_peers = [
            {"user_id": p.user_id, "color": p.color}
            for p in self.active_peers.values()
        ]
        
        self.active_peers[user_id] = peer
        logger.info(f"User {user_id} connected. Total peers: {len(self.active_peers)}")

        # 1. Send welcome packet to new peer
        snapshot = board_state.get_snapshot()
        welcome_msg = {
            "type": "welcome",
            "user_id": user_id,
            "color": color,
            "peers": existing_peers,
            "user_count": len(self.active_peers),
            "board": snapshot,
        }
        await websocket.send_text(json.dumps(welcome_msg))

        # 2. Broadcast peer_joined to all other peers
        join_msg = json.dumps({
            "type": "peer_joined",
            "user_id": user_id,
            "color": color,
            "user_count": len(self.active_peers),
        })
        for pid, p in list(self.active_peers.items()):
            if pid != user_id:
                try:
                    await p.websocket.send_text(join_msg)
                except Exception as e:
                    logger.warning(f"Failed to notify peer {pid}: {e}")

        return peer

    async def disconnect(self, user_id: str):
        if user_id in self.active_peers:
            del self.active_peers[user_id]
            logger.info(f"User {user_id} disconnected. Total peers: {len(self.active_peers)}")
            
            leave_msg = json.dumps({
                "type": "peer_left",
                "user_id": user_id,
                "user_count": len(self.active_peers),
            })
            for pid, p in list(self.active_peers.items()):
                try:
                    await p.websocket.send_text(leave_msg)
                except Exception:
                    pass

    async def handle_message(self, sender_id: str, raw_data: Any):
        # Support both text (JSON) signaling and binary sync
        if isinstance(raw_data, str):
            try:
                msg = json.loads(raw_data)
            except json.JSONDecodeError:
                return

            mtype = msg.get("type")

            # 1. WebRTC Signaling Forwarding (Offer, Answer, ICE Candidate)
            if mtype == "signal":
                target_id = msg.get("target")
                if target_id and target_id in self.active_peers:
                    forward_msg = json.dumps({
                        "type": "signal",
                        "sender": sender_id,
                        "data": msg.get("data"),
                    })
                    try:
                        await self.active_peers[target_id].websocket.send_text(forward_msg)
                    except Exception as e:
                        logger.warning(f"Error forwarding signal to {target_id}: {e}")

            # 2. Board state mutations from client to sync server state
            elif mtype == "stroke_start":
                s = msg.get("stroke")
                if s:
                    board_state.start_stroke(
                        stroke_id=s["id"],
                        user_id=sender_id,
                        tool=s.get("tool", 0),
                        color=s.get("color", "#000000"),
                        size=s.get("size", 3.0),
                        x=s.get("x", 0),
                        y=s.get("y", 0),
                    )

            elif mtype == "stroke_chunk":
                sid = msg.get("stroke_id")
                points = msg.get("points", [])
                if sid and points:
                    board_state.append_points(sid, points)

            elif mtype == "stroke_end":
                sid = msg.get("stroke_id")
                if sid:
                    board_state.end_stroke(sid)

            elif mtype == "stroke_undo":
                undone_sid = board_state.undo(sender_id)
                # Broadcast undo confirmation to all peers (ensures absolute consistency)
                undo_msg = json.dumps({
                    "type": "board_undo",
                    "user_id": sender_id,
                    "stroke_id": undone_sid,
                })
                for p in self.active_peers.values():
                    try:
                        await p.websocket.send_text(undo_msg)
                    except Exception:
                        pass

            elif mtype == "stroke_redo":
                redone_sid = board_state.redo(sender_id)
                redo_msg = json.dumps({
                    "type": "board_redo",
                    "user_id": sender_id,
                    "stroke_id": redone_sid,
                })
                for p in self.active_peers.values():
                    try:
                        await p.websocket.send_text(redo_msg)
                    except Exception:
                        pass

            elif mtype == "board_clear":
                board_state.clear(sender_id)
                clear_msg = json.dumps({
                    "type": "board_clear",
                    "user_id": sender_id,
                })
                for p in self.active_peers.values():
                    try:
                        await p.websocket.send_text(clear_msg)
                    except Exception:
                        pass

            elif mtype == "ping":
                # Instant ping-pong latency response
                pong_msg = json.dumps({
                    "type": "pong",
                    "client_time": msg.get("client_time"),
                })
                if sender_id in self.active_peers:
                    await self.active_peers[sender_id].websocket.send_text(pong_msg)

signaling_hub = SignalingHub()
