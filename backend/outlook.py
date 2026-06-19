"""
Microsoft Graph API integration for ticket email notifications and reply sync.

Required environment variables:
  AZURE_TENANT_ID     - Your Azure AD tenant ID
  AZURE_CLIENT_ID     - App registration client ID
  AZURE_CLIENT_SECRET - App registration client secret
  OUTLOOK_MAILBOX     - The mailbox to send from and monitor (e.g. support@yourcompany.com)
  APP_URL             - Public URL of the frontend app (for links in emails)
"""
import os
import re
import logging
from datetime import datetime, timezone, timedelta

import msal
import httpx

log = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
SCOPE = ["https://graph.microsoft.com/.default"]

_token_cache: dict = {}


def _get_token() -> str:
    tenant = os.environ.get("AZURE_TENANT_ID")
    client_id = os.environ.get("AZURE_CLIENT_ID")
    client_secret = os.environ.get("AZURE_CLIENT_SECRET")

    if not all([tenant, client_id, client_secret]):
        raise RuntimeError("Missing Azure credentials (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)")

    # Return cached token if still valid
    now = datetime.now(timezone.utc)
    if _token_cache.get("expires_at", now) > now:
        return _token_cache["access_token"]

    app = msal.ConfidentialClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{tenant}",
        client_credential=client_secret,
    )
    result = app.acquire_token_for_client(scopes=SCOPE)
    if "access_token" not in result:
        raise RuntimeError(f"MSAL token error: {result.get('error_description')}")

    _token_cache["access_token"] = result["access_token"]
    _token_cache["expires_at"] = now + timedelta(seconds=result.get("expires_in", 3600) - 60)
    return result["access_token"]


def _headers() -> dict:
    return {"Authorization": f"Bearer {_get_token()}", "Content-Type": "application/json"}


def send_ticket_email(ticket_data: dict) -> dict:
    """Send assignment email to the assignee and return outlook tracking IDs."""
    mailbox = os.environ.get("OUTLOOK_MAILBOX", "")
    app_url = os.environ.get("APP_URL", "")

    priority_emoji = {"Low": "🟢", "Medium": "🟡", "High": "🟠", "Critical": "🔴"}.get(
        ticket_data["priority"], "⚪"
    )

    body = f"""
<p>Hi,</p>
<p>A support ticket has been assigned to you:</p>
<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Ticket ID:</td><td>{ticket_data["id"]}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Title:</td><td>{ticket_data["title"]}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Priority:</td><td>{priority_emoji} {ticket_data["priority"]}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Category:</td><td>{ticket_data["category"]}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Reporter:</td><td>{ticket_data["reporter"]}</td></tr>
</table>
<br>
<p><strong>Description:</strong><br>{ticket_data.get("description", "No description.")}</p>
<p>
  <a href="{app_url}" style="background:#2563eb;color:white;padding:8px 18px;border-radius:6px;text-decoration:none;font-weight:bold">
    View Ticket in Portal
  </a>
</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
<p style="font-size:12px;color:#6b7280">
  To update this ticket, <strong>reply to this email</strong> with one of these on the first line:<br>
  <code>CLOSE</code> &mdash; Mark as Closed<br>
  <code>RESOLVE</code> &mdash; Mark as Resolved<br>
  <code>PROGRESS</code> &mdash; Mark as In Progress<br>
  <code>PENDING</code> &mdash; Mark as Pending<br>
  Any other text will be added as a comment on the ticket.
</p>
"""

    payload = {
        "message": {
            "subject": f"[{ticket_data['id']}] {ticket_data['title']}",
            "body": {"contentType": "HTML", "content": body},
            "toRecipients": [{"emailAddress": {"address": ticket_data["assignee"]}}],
        },
        "saveToSentItems": True,
    }

    url = f"{GRAPH_BASE}/users/{mailbox}/sendMail"
    with httpx.Client(timeout=30) as client:
        resp = client.post(url, headers=_headers(), json=payload)
        resp.raise_for_status()

    # Retrieve the sent message to get its ID and conversation ID
    sent = _get_sent_message(mailbox, ticket_data["id"])
    return sent


def _get_sent_message(mailbox: str, ticket_id: str) -> dict:
    """Find the just-sent message in Sent Items to capture IDs."""
    url = (
        f"{GRAPH_BASE}/users/{mailbox}/mailFolders/sentItems/messages"
        f"?$filter=contains(subject,'{ticket_id}')&$orderby=sentDateTime desc&$top=1"
        f"&$select=id,conversationId,internetMessageId"
    )
    with httpx.Client(timeout=30) as client:
        resp = client.get(url, headers=_headers())
        resp.raise_for_status()
        messages = resp.json().get("value", [])

    if messages:
        m = messages[0]
        return {
            "outlook_message_id": m.get("internetMessageId"),
            "outlook_conversation_id": m.get("conversationId"),
        }
    return {}


def fetch_conversation_replies(mailbox: str, conversation_id: str, since: datetime) -> list[dict]:
    """Return new reply messages in the conversation since `since`."""
    since_str = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    url = (
        f"{GRAPH_BASE}/users/{mailbox}/messages"
        f"?$filter=conversationId eq '{conversation_id}' and receivedDateTime ge {since_str}"
        f"&$orderby=receivedDateTime asc"
        f"&$select=id,subject,body,from,receivedDateTime,isDraft"
    )
    with httpx.Client(timeout=30) as client:
        resp = client.get(url, headers=_headers())
        resp.raise_for_status()
        return resp.json().get("value", [])


_COMMAND_MAP = {
    "CLOSE": "Closed",
    "CLOSED": "Closed",
    "RESOLVE": "Resolved",
    "RESOLVED": "Resolved",
    "PROGRESS": "In Progress",
    "IN PROGRESS": "In Progress",
    "PENDING": "Pending",
}


def parse_reply(email_body_html: str) -> tuple[str | None, str | None]:
    """
    Returns (new_status, comment_text).
    Strips quoted/replied content, reads the first non-empty line for a command.
    """
    # Strip HTML tags
    text = re.sub(r"<[^>]+>", " ", email_body_html)
    text = re.sub(r"&[a-z]+;", " ", text)

    # Remove quoted reply block (lines starting with > or From:)
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(">") or re.match(r"^From:\s+", stripped, re.I):
            break
        lines.append(stripped)

    cleaned = "\n".join(lines).strip()
    if not cleaned:
        return None, None

    first_line = lines[0].strip().upper() if lines else ""
    new_status = _COMMAND_MAP.get(first_line)

    if new_status:
        return new_status, None

    # No command — treat entire text as a comment
    return None, cleaned[:2000]  # cap length
