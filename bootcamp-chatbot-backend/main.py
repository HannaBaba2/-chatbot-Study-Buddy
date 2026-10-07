import json
import os
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database.db import SessionLocal, get_db
from database.models import Conversation, Message

load_dotenv()

RODIUMAI_URL = "https://api.rodiumai.io/v1/chat/completions"
RODIUMAI_API_KEY = os.environ["RODIUMAI_API_KEY"]  # lue côté serveur uniquement, jamais envoyée au navigateur

# --- Modèles autorisés (liste définie côté serveur, dans .env) ---
DEFAULT_MODEL = os.getenv("RODIUMAI_MODEL", "anthropic/claude-sonnet-4-5-20250929")
ALLOWED_MODELS = [m.strip() for m in os.getenv("ALLOWED_MODELS", DEFAULT_MODEL).split(",") if m.strip()]
if DEFAULT_MODEL not in ALLOWED_MODELS:
    ALLOWED_MODELS.insert(0, DEFAULT_MODEL)

PREVIEW_LENGTH = 60

# --- Rôles stockés en base ---
LLM_ROLES = {"user", "assistant"}  # les seuls rôles que le LLM comprend
NOTIFICATION_ROLE = "system-notification"
NOTE_ROLE = "note"  # rôle custom : note personnelle de l'étudiant, visible dans le chat, jamais envoyée au LLM

NOTIFICATION_EVERY = 10
NOTIFICATION_TEXT = "Notification système : Une dizaine de messages écrits."

# Le prompt système vit dans un fichier dédié
SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "system.md").read_text(encoding="utf-8").strip()

app = FastAPI(title="Study Buddy Chatbot")


class ConversationResponse(BaseModel):
    conversation_id: int


class ConversationSummary(BaseModel):
    id: int
    created_at: datetime
    preview: str | None  # first user message, truncated; None while the conversation is empty


class ChatRequest(BaseModel):
    conversation_id: int
    message: str
    model: str | None = None  # modèle choisi par l'utilisateur ; validé côté serveur


class NoteRequest(BaseModel):
    content: str


class MessageResponse(BaseModel):
    seq: int
    role: str
    content: str
    created_at: datetime


class ModelsResponse(BaseModel):
    models: list[str]
    default: str


def load_messages(db: Session, conversation_id: int) -> list[Message]:
    # A conversation's messages in order; 404 if the conversation doesn't exist.
    if db.get(Conversation, conversation_id) is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return db.scalars(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.seq)
    ).all()


def build_llm_history(rows: list[Message]) -> list[dict]:
    # L'historique stocké en base n'est pas celui envoyé au LLM : c'est ici qu'on le construit.
    history = []
    for m in rows:
        if m.role in LLM_ROLES:
            history.append({"role": m.role, "content": m.content})
        elif m.role == NOTE_ROLE:
            continue  # note personnelle : volontairement jamais envoyée au LLM
        elif m.role == NOTIFICATION_ROLE:
            continue  # message technique de l'application, inutile pour le LLM
        # tout autre rôle inconnu est ignoré par sécurité
    return history


def next_seq_of(rows: list[Message]) -> int:
    # seq follows every stored row (notifications and notes included) so it stays unique.
    return rows[-1].seq + 1 if rows else 1


@app.get("/models")
def list_models() -> ModelsResponse:
    return ModelsResponse(models=ALLOWED_MODELS, default=DEFAULT_MODEL)


@app.post("/conversations", status_code=201)
def create_conversation(db: Session = Depends(get_db)) -> ConversationResponse:
    conversation = Conversation()
    db.add(conversation)
    db.commit()
    return ConversationResponse(conversation_id=conversation.id)


@app.get("/conversations")
def list_conversations(db: Session = Depends(get_db)) -> list[ConversationSummary]:
    # Newest first, each joined to its first message (seq 1, always the user's) for the preview.
    rows = db.execute(
        select(Conversation, Message.content)
        .outerjoin(Message, and_(Message.conversation_id == Conversation.id, Message.seq == 1))
        .order_by(Conversation.id.desc())
    ).all()
    return [
        ConversationSummary(
            id=conversation.id,
            created_at=conversation.created_at,
            preview=content[:PREVIEW_LENGTH] if content else None,
        )
        for conversation, content in rows
    ]


@app.get("/conversations/{conversation_id}/messages")
def list_messages(conversation_id: int, db: Session = Depends(get_db)) -> list[MessageResponse]:
    return [
        MessageResponse(seq=m.seq, role=m.role, content=m.content, created_at=m.created_at)
        for m in load_messages(db, conversation_id)
    ]


@app.post("/conversations/{conversation_id}/notes", status_code=201)
def add_note(conversation_id: int, req: NoteRequest, db: Session = Depends(get_db)) -> MessageResponse:
    # Rôle custom "note" : enregistré comme les autres messages, mais jamais envoyé au LLM.
    content = req.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Note is empty.")
    rows = load_messages(db, conversation_id)
    note = Message(conversation_id=conversation_id, seq=next_seq_of(rows), role=NOTE_ROLE, content=content)
    db.add(note)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="The conversation was updated concurrently, please retry.")
    db.refresh(note)
    return MessageResponse(seq=note.seq, role=note.role, content=note.content, created_at=note.created_at)


def sse(payload: dict) -> str:
    # Un événement Server-Sent Events : "data: {...}" suivi d'une ligne vide.
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def stream_reply(conversation_id: int, user_text: str, model: str, messages: list[dict],
                 history_len: int, seq: int):
    """Appelle le LLM en streaming, relaie les morceaux, puis enregistre le tour en base.

    Rien n'est écrit en base tant que le flux n'est pas terminé sans erreur :
    une erreur ou une interruption ne laisse donc aucun message orphelin.
    """
    chunks: list[str] = []
    try:
        with httpx.stream(
            "POST",
            RODIUMAI_URL,
            headers={"Authorization": f"Bearer {RODIUMAI_API_KEY}"},
            json={"model": model, "messages": messages, "max_tokens": 512, "stream": True},
            timeout=httpx.Timeout(30.0, read=60.0),
        ) as response:
            if response.status_code != 200:
                raise RuntimeError(f"LLM API returned HTTP {response.status_code}")
            for line in response.iter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if "error" in event:
                    raise RuntimeError("LLM API error during the stream")
                choices = event.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0].get("delta") or {}).get("content")
                if delta:
                    chunks.append(delta)
                    yield sse({"type": "delta", "content": delta})
    except Exception:
        # Erreur réseau ou API au milieu du flux : on prévient le client, on n'écrit rien en base.
        yield sse({"type": "error", "detail": "The LLM API call failed."})
        return

    reply = "".join(chunks)
    if not reply:
        yield sse({"type": "error", "detail": "The LLM returned an empty reply."})
        return

    # Flux terminé proprement : on enregistre le tour complet (user + assistant) en une seule transaction.
    notification = None
    with SessionLocal() as db:
        db.add_all([
            Message(conversation_id=conversation_id, seq=seq, role="user", content=user_text),
            Message(conversation_id=conversation_id, seq=seq + 1, role="assistant", content=reply),
        ])
        if (history_len + 2) % NOTIFICATION_EVERY == 0:
            notification = NOTIFICATION_TEXT
            db.add(Message(conversation_id=conversation_id, seq=seq + 2,
                           role=NOTIFICATION_ROLE, content=notification))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            yield sse({"type": "error", "detail": "The conversation was updated concurrently, please retry."})
            return
    yield sse({"type": "done", "notification": notification, "model": model})


@app.post("/chat")
def chat(req: ChatRequest, db: Session = Depends(get_db)):
    # Ne jamais faire confiance au client : le modèle doit figurer dans la liste du serveur.
    model = req.model or DEFAULT_MODEL
    if model not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"Model not allowed: {model}")

    rows = load_messages(db, req.conversation_id)  # 404 si la conversation n'existe pas
    history = build_llm_history(rows)
    # The LLM is stateless: resend the system prompt + the whole (filtered) conversation each turn.
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *history,
        {"role": "user", "content": req.message},
    ]
    return StreamingResponse(
        stream_reply(req.conversation_id, req.message, model, messages, len(history), next_seq_of(rows)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
