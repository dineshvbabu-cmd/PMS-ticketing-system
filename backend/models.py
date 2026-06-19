from datetime import datetime, timezone
from sqlalchemy import Column, String, Text, DateTime, ForeignKey, Integer
from database import Base


def utcnow():
    return datetime.now(timezone.utc)


class Ticket(Base):
    __tablename__ = "tickets"

    id = Column(String, primary_key=True)          # TKT-1001
    title = Column(String, nullable=False)
    description = Column(Text, default="")
    category = Column(String, default="Other")
    priority = Column(String, default="Medium")
    status = Column(String, default="Open")
    reporter = Column(String, default="")
    assignee = Column(String, default="")
    created_at = Column(DateTime(timezone=True), default=utcnow)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    # Outlook tracking
    outlook_message_id = Column(String, nullable=True)      # Message-ID of sent email
    outlook_conversation_id = Column(String, nullable=True) # Graph conversation ID


class Comment(Base):
    __tablename__ = "comments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ticket_id = Column(String, ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False)
    author = Column(String, nullable=False)
    text = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)
