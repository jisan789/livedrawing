"""
LiveDraw WebRTC Signaling & WebSocket Hub
Manages connected peers, unique usernames, forwards SDP offers/answers, ICE candidates, and manages board state sync.
"""

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
from typing import Dict, List, Any, Optional
import json
import secrets
import logging
import re
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

    def clean_base_name(self, name: str) -> str:
        """Strips repeating numerical suffixes like _2_2_2 down to base name."""
        stripped = re.sub(r'(_\d+)+$', '', name.strip())
        return stripped if stripped else name.strip()

    def ensure_unique_name(self, requested_name: Optional[str], exclude_id: Optional[str] = None) -> str:
        """Ensures a unique, clean username among active peers without cascading suffixes."""
        # Prune any dead or closing websocket peers first
        stale_peers = []
        for pid, p in self.active_peers.items():
            if pid != exclude_id:
                try:
                    if hasattr(p.websocket, "client_state") and p.websocket.client_state != WebSocketState.CONNECTED:
                        stale_peers.append(pid)
                except Exception:
                    pass
        for pid in stale_peers:
            if pid in self.active_peers:
                del self.active_peers[pid]

        if not requested_name or not requested_name.strip():
            while True:
                candidate = f"Artist_{secrets.token_hex(2).upper()}"
                if candidate not in self.active_peers and candidate != exclude_id:
                    return candidate

        raw_name = requested_name.strip()[:20]
        base_name = self.clean_base_name(raw_name)

        # 1. Prefer clean base name if it is available or held by this user
        if base_name not in self.active_peers or base_name == exclude_id:
            return base_name

        # 2. If base name is held by another peer, check requested raw name
        if raw_name not in self.active_peers or raw_name == exclude_id:
            return raw_name

        # 3. If taken, find lowest available numeric suffix on the base name (e.g. PC_2, PC_3)
        suffix = 2
        while True:
            candidate = f"{base_name}_{suffix}"
            if candidate not in self.active_peers and candidate != exclude_id:
                return candidate
            suffix += 1

    def pick_color(self) -> str:
        idx = len(self.active_peers) % len(USER_COLORS)
        return USER_COLORS[idx]

    async def connect(self, websocket: WebSocket, requested_name: Optional[str] = None) -> Peer:
        await websocket.accept()
        user_id = self.ensure_unique_name(requested_name)
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

    async def rename_peer(self, old_user_id: str, new_requested_name: str) -> str:
        if old_user_id not in self.active_peers:
            return old_user_id

        peer = self.active_peers[old_user_id]
        final_new_name = self.ensure_unique_name(new_requested_name, exclude_id=old_user_id)
        if final_new_name == old_user_id:
            return old_user_id

        # Update peer map key
        del self.active_peers[old_user_id]
        peer.user_id = final_new_name
        self.active_peers[final_new_name] = peer

        # Confirm to client
        await peer.websocket.send_text(json.dumps({
            "type": "username_confirmed",
            "user_id": final_new_name,
        }))

        # Broadcast rename to other peers
        rename_msg = json.dumps({
            "type": "peer_renamed",
            "old_user_id": old_user_id,
            "new_user_id": final_new_name,
            "color": peer.color,
            "user_count": len(self.active_peers),
        })
        for pid, p in self.active_peers.items():
            if pid != final_new_name:
                try:
                    await p.websocket.send_text(rename_msg)
                except Exception:
                    pass

        return final_new_name

    async def disconnect(self, user_id: str):
        if user_id in self.active_peers:
            del self.active_peers[user_id]
            logger.info(f"User {user_id} disconnected. Total peers: {len(self.active_peers)}")
            
            if len(self.active_peers) == 0:
                logger.info("All users left the board. Saving drawing state from RAM to disk...")
                board_state.save_to_disk()

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

    async def handle_message(self, sender_id: str, raw_data: Any) -> str:
        current_sender_id = sender_id
        # Support both text (JSON) signaling and binary sync
        if isinstance(raw_data, str):
            try:
                msg = json.loads(raw_data)
            except json.JSONDecodeError:
                return current_sender_id

            mtype = msg.get("type")

            # 0. User rename
            if mtype == "set_username":
                req_name = msg.get("username")
                if req_name:
                    current_sender_id = await self.rename_peer(sender_id, req_name)

            # 1. WebRTC Signaling Forwarding
            elif mtype == "signal":
                target_id = msg.get("target")
                if target_id and target_id in self.active_peers:
                    forward_msg = json.dumps({
                        "type": "signal",
                        "sender": current_sender_id,
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
                        user_id=current_sender_id,
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

            elif mtype == "stroke_move":
                sid = msg.get("stroke_id")
                dx = msg.get("dx", 0)
                dy = msg.get("dy", 0)
                if sid and (dx or dy):
                    board_state.move_stroke(sid, dx, dy)
                    move_msg = json.dumps({
                        "type": "stroke_move",
                        "stroke_id": sid,
                        "dx": dx,
                        "dy": dy,
                        "user_id": current_sender_id,
                    })
                    for pid, p in self.active_peers.items():
                        if pid != current_sender_id:
                            try:
                                await p.websocket.send_text(move_msg)
                            except Exception:
                                pass

            elif mtype == "stroke_undo":
                undone_sid = board_state.undo(current_sender_id)
                undo_msg = json.dumps({
                    "type": "board_undo",
                    "user_id": current_sender_id,
                    "stroke_id": undone_sid,
                })
                for p in self.active_peers.values():
                    try:
                        await p.websocket.send_text(undo_msg)
                    except Exception:
                        pass

            elif mtype == "stroke_redo":
                redone_sid = board_state.redo(current_sender_id)
                redo_msg = json.dumps({
                    "type": "board_redo",
                    "user_id": current_sender_id,
                    "stroke_id": redone_sid,
                })
                for p in self.active_peers.values():
                    try:
                        await p.websocket.send_text(redo_msg)
                    except Exception:
                        pass

            elif mtype == "board_clear":
                board_state.clear(current_sender_id)
                clear_msg = json.dumps({
                    "type": "board_clear",
                    "user_id": current_sender_id,
                })
                for p in self.active_peers.values():
                    try:
                        await p.websocket.send_text(clear_msg)
                    except Exception:
                        pass

            elif mtype == "chat_message":
                text = str(msg.get("text") or "").strip()[:300]
                if text and current_sender_id in self.active_peers:
                    sender_peer = self.active_peers[current_sender_id]
                    chat_payload = json.dumps({
                        "type": "chat_message",
                        "user_id": current_sender_id,
                        "color": sender_peer.color,
                        "text": text,
                        "time": msg.get("time") or "",
                    })
                    for p in self.active_peers.values():
                        try:
                            await p.websocket.send_text(chat_payload)
                        except Exception:
                            pass

            elif mtype == "ping":
                pong_msg = json.dumps({
                    "type": "pong",
                    "client_time": msg.get("client_time"),
                })
                if current_sender_id in self.active_peers:
                    await self.active_peers[current_sender_id].websocket.send_text(pong_msg)

        return current_sender_id

signaling_hub = SignalingHub()
