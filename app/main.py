"""
LiveDraw Main FastAPI Application
"""

import os
import logging
from pathlib import Path
from typing import List, Dict, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.signaling import signaling_hub
from app.state import board_state

# Logging setup
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("livedraw")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="LiveDraw - Real-time Collaborative Mobile Drawing Board",
    description="Ultra-low latency real-time collaborative whiteboard using WebRTC DataChannels and compact vector streaming.",
    version="1.0.0",
)

# CORS middleware for open deployment
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_ice_servers() -> List[Dict[str, Any]]:
    """Builds ICE server list from environment variables with fallback to Google/Cloudflare STUN."""
    ice_servers = []
    
    # Custom or default STUN servers
    stun_env = os.getenv("STUN_SERVERS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478")
    stun_urls = [s.strip() for s in stun_env.split(",") if s.strip()]
    if stun_urls:
        ice_servers.append({"urls": stun_urls})

    # Optional TURN configuration
    turn_server = os.getenv("TURN_SERVER")
    turn_user = os.getenv("TURN_USERNAME")
    turn_pass = os.getenv("TURN_PASSWORD")

    if turn_server:
        turn_entry: Dict[str, Any] = {"urls": [turn_server.strip()]}
        if turn_user and turn_pass:
            turn_entry["username"] = turn_user
            turn_entry["credential"] = turn_pass
        ice_servers.append(turn_entry)

    return ice_servers

@app.get("/health")
async def health_check():
    stats = board_state.get_stats()
    return {
        "status": "healthy",
        "active_users": signaling_hub.get_peer_count(),
        **stats,
    }

@app.get("/api/config")
async def get_config():
    return {
        "iceServers": get_ice_servers(),
        "protocolVersion": "1.0",
        "coordScale": 10000,
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    peer = None
    try:
        peer = await signaling_hub.connect(websocket)
        while True:
            raw_msg = await websocket.receive_text()
            await signaling_hub.handle_message(peer.user_id, raw_msg)
    except WebSocketDisconnect:
        if peer:
            await signaling_hub.disconnect(peer.user_id)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        if peer:
            await signaling_hub.disconnect(peer.user_id)

# Serve static directory
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
async def serve_root():
    return FileResponse(STATIC_DIR / "index.html")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "0.0.0.0")
    uvicorn.run("app.main:app", host=host, port=port, reload=True)
