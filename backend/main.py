import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from apscheduler.schedulers.background import BackgroundScheduler

from database import Base, engine, get_db
from models import Ticket, Comment
import outlook as graph

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

_scheduler = BackgroundScheduler()


def sync_outlook_replies():
    """Background job: poll Outlook for replies and update tickets."""
    mailbox = os.environ.get("OUTLOOK_MAILBOX")
    if not mailbox:
        return
    try:
        from database import SessionLocal
        db = SessionLocal()
        try:
            since = datetime.now(timezone.utc) - timedelta(minutes=10)
            tickets = (
                db.query(Ticket)
                .filter(
                    Ticket.outlook_conversation_id.isnot(None),
                    Ticket.status.notin_(["Closed", "Resolved"]),
                )
                .all()
            )
            for ticket in tickets:
                try:
                    replies = graph.fetch_conversation_replies(
                        mailbox, ticket.outlook_conversation_id, since
                    )
                    for msg in replies:
                        sender = msg.get("from", {}).get("emailAddress", {}).get("address", "")
                        if sender.lower() == mailbox.lower():
                            continue  # skip our own sent messages
                        body_html = msg.get("body", {}).get("content", "")
                        new_status, comment_text = graph.parse_reply(body_html)
                        if new_status:
                            ticket.status = new_status
                            ticket.updated_at = datetime.now(timezone.utc)
                            c = Comment(
                                ticket_id=ticket.id,
                                author=sender,
                                text=f"[Outlook] Status changed to {new_status}",
                            )
                            db.add(c)
                            log.info(f"Ticket {ticket.id} → {new_status} via Outlook reply from {sender}")
                        elif comment_text:
                            c = Comment(
                                ticket_id=ticket.id,
                                author=sender,
                                text=f"[Outlook] {comment_text}",
                            )
                            db.add(c)
                            ticket.updated_at = datetime.now(timezone.utc)
                            log.info(f"Ticket {ticket.id}: comment from {sender} via Outlook")
                except Exception as e:
                    log.warning(f"Outlook sync error for {ticket.id}: {e}")
            db.commit()
        finally:
            db.close()
    except Exception as e:
        log.error(f"Outlook sync job failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    _scheduler.add_job(sync_outlook_replies, "interval", minutes=5, id="outlook_sync")
    _scheduler.start()
    log.info("Started Outlook sync scheduler (every 5 min)")
    yield
    _scheduler.shutdown(wait=False)


app = FastAPI(title="PMS Ticketing API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class TicketCreate(BaseModel):
    id: str
    title: str
    description: str = ""
    category: str = "Other"
    priority: str = "Medium"
    status: str = "Open"
    reporter: str = ""
    assignee: str = ""


class TicketUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    category: str | None = None
    priority: str | None = None
    status: str | None = None
    reporter: str | None = None
    assignee: str | None = None


class CommentCreate(BaseModel):
    author: str
    text: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def ticket_to_dict(t: Ticket, db: Session) -> dict:
    comments = db.query(Comment).filter(Comment.ticket_id == t.id).order_by(Comment.created_at).all()
    return {
        "id": t.id,
        "title": t.title,
        "description": t.description,
        "category": t.category,
        "priority": t.priority,
        "status": t.status,
        "reporter": t.reporter,
        "assignee": t.assignee,
        "created": t.created_at.isoformat() if t.created_at else None,
        "updated": t.updated_at.isoformat() if t.updated_at else None,
        "outlookLinked": bool(t.outlook_conversation_id),
        "comments": [
            {"author": c.author, "text": c.text, "time": c.created_at.isoformat()}
            for c in comments
        ],
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/tickets")
def list_tickets(db: Session = Depends(get_db)):
    tickets = db.query(Ticket).order_by(Ticket.created_at.desc()).all()
    return [ticket_to_dict(t, db) for t in tickets]


@app.post("/api/tickets", status_code=201)
def create_ticket(body: TicketCreate, db: Session = Depends(get_db)):
    if db.query(Ticket).filter(Ticket.id == body.id).first():
        raise HTTPException(400, "Ticket ID already exists")
    t = Ticket(**body.model_dump())
    db.add(t)
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t, db)


@app.get("/api/tickets/{ticket_id}")
def get_ticket(ticket_id: str, db: Session = Depends(get_db)):
    t = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    return ticket_to_dict(t, db)


@app.patch("/api/tickets/{ticket_id}")
def update_ticket(ticket_id: str, body: TicketUpdate, db: Session = Depends(get_db)):
    t = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(t, field, val)
    t.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t, db)


@app.post("/api/tickets/{ticket_id}/comments", status_code=201)
def add_comment(ticket_id: str, body: CommentCreate, db: Session = Depends(get_db)):
    t = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    c = Comment(ticket_id=ticket_id, author=body.author, text=body.text)
    db.add(c)
    t.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "ok"}


@app.post("/api/tickets/{ticket_id}/notify")
def notify_assignee(ticket_id: str, db: Session = Depends(get_db)):
    """Send assignment email to the assignee and link the ticket to Outlook."""
    t = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    if not t.assignee:
        raise HTTPException(400, "Ticket has no assignee")

    try:
        result = graph.send_ticket_email({
            "id": t.id,
            "title": t.title,
            "description": t.description,
            "category": t.category,
            "priority": t.priority,
            "reporter": t.reporter,
            "assignee": t.assignee,
        })
        if result:
            t.outlook_message_id = result.get("outlook_message_id")
            t.outlook_conversation_id = result.get("outlook_conversation_id")
            t.updated_at = datetime.now(timezone.utc)
            db.commit()
        return {"status": "sent", "outlookLinked": bool(t.outlook_conversation_id)}
    except RuntimeError as e:
        raise HTTPException(503, f"Outlook not configured: {e}")
    except Exception as e:
        log.error(f"Failed to send email for {ticket_id}: {e}")
        raise HTTPException(500, f"Email send failed: {e}")


@app.post("/api/outlook/sync")
def manual_sync():
    """Manually trigger an Outlook reply sync."""
    sync_outlook_replies()
    return {"status": "synced"}
