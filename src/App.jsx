import { useState } from "react";

// ── Constants ──────────────────────────────────────────────────────────────
const PRIORITIES = ["Low", "Medium", "High", "Critical"];
const CATEGORIES = ["Bug Report", "Feature Request", "Access Issue", "Data Issue", "Integration", "Performance", "Other"];
const STATUSES = ["Open", "In Progress", "Pending", "Resolved", "Closed"];

const STATUS_COLOR = {
  "Open": "bg-blue-100 text-blue-800",
  "In Progress": "bg-yellow-100 text-yellow-800",
  "Pending": "bg-purple-100 text-purple-800",
  "Resolved": "bg-green-100 text-green-800",
  "Closed": "bg-gray-100 text-gray-600",
};
const PRIORITY_COLOR = {
  "Low": "bg-slate-100 text-slate-600",
  "Medium": "bg-amber-100 text-amber-700",
  "High": "bg-orange-100 text-orange-700",
  "Critical": "bg-red-100 text-red-700",
};

// ── Claude API helper ──────────────────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, mcpServers = []) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing VITE_ANTHROPIC_API_KEY environment variable.");

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (mcpServers.length > 0) body.mcp_servers = mcpServers;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-request-allowlist": "allow-all",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
}

const MS365_SERVERS = [
  { type: "url", url: "https://microsoft365.mcp.claude.com/mcp", name: "ms365" },
];

// ── Ticket ID generator ────────────────────────────────────────────────────
let ticketCounter = 1000;
const nextId = () => `TKT-${++ticketCounter}`;

// ── Mock initial tickets ───────────────────────────────────────────────────
const INITIAL_TICKETS = [
  {
    id: "TKT-1001", title: "Dashboard not loading for new users",
    category: "Bug Report", priority: "High", status: "Open",
    reporter: "priya.m@company.com", assignee: "support@pmsgroup.com",
    created: "2026-06-17T09:30:00Z", updated: "2026-06-17T09:30:00Z",
    description: "New users who joined last week cannot load the PM dashboard. Error: 403 Forbidden.",
    comments: [],
    sharepointRef: null, outlookRef: null,
  },
  {
    id: "TKT-1002", title: "Feature: Export to Excel from Project View",
    category: "Feature Request", priority: "Medium", status: "In Progress",
    reporter: "raj.k@company.com", assignee: "support@pmsgroup.com",
    created: "2026-06-15T14:00:00Z", updated: "2026-06-18T10:00:00Z",
    description: "PMs need to export project data to Excel for weekly status reports.",
    comments: [{ author: "support@pmsgroup.com", text: "Reviewing feasibility with dev team.", time: "2026-06-18T10:00:00Z" }],
    sharepointRef: null, outlookRef: null,
  },
];

// ── Sub-components ─────────────────────────────────────────────────────────
function Badge({ label, colorClass }) {
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colorClass}`}>{label}</span>;
}

function Spinner() {
  return (
    <span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin align-middle mr-1" />
  );
}

function AIPanel({ ticket, onClose }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [action, setAction] = useState(null);

  const run = async (actionKey) => {
    setLoading(true);
    setAction(actionKey);
    setResult("");
    try {
      let text = "";
      if (actionKey === "suggest") {
        text = await callClaude(
          "You are a PMS Support expert. Analyze support tickets and suggest resolution steps concisely.",
          `Ticket: ${ticket.title}\nCategory: ${ticket.category}\nPriority: ${ticket.priority}\nDescription: ${ticket.description}\n\nProvide 3-5 actionable resolution steps.`
        );
      } else if (actionKey === "sharepoint") {
        text = await callClaude(
          "You are a PMS Support assistant. Search SharePoint for relevant documentation and return a brief summary of what you find. If you use tools, summarize the findings for the ticket.",
          `Search SharePoint for documents related to: "${ticket.title}" (category: ${ticket.category}). Summarize any relevant docs found.`,
          MS365_SERVERS
        );
      } else if (actionKey === "email") {
        text = await callClaude(
          "You are a PMS Support assistant. Draft a professional support update email for the ticket reporter.",
          `Draft a polite email update for ticket ${ticket.id}: "${ticket.title}". Status: ${ticket.status}. Keep it under 100 words. Include next steps.`
        );
      } else if (actionKey === "related") {
        text = await callClaude(
          "You are a PMS Support assistant. Search Outlook for related emails about the same issue and summarize findings.",
          `Search Outlook for emails related to: "${ticket.title}" in the last 30 days. Summarize any related communications found.`,
          MS365_SERVERS
        );
      }
      setResult(text);
    } catch (e) {
      setResult("Error: " + e.message);
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <p className="text-xs text-gray-400 font-mono">{ticket.id}</p>
            <h3 className="font-bold text-gray-800 text-sm leading-tight">{ticket.title}</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl font-bold">&times;</button>
        </div>

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-2 p-4 border-b">
          {[
            { key: "suggest", icon: "💡", label: "Suggest Fix" },
            { key: "sharepoint", icon: "📂", label: "Search SharePoint" },
            { key: "email", icon: "✉️", label: "Draft Reply Email" },
            { key: "related", icon: "🔍", label: "Find Related Emails" },
          ].map(a => (
            <button
              key={a.key}
              onClick={() => run(a.key)}
              disabled={loading}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition
                ${action === a.key && loading ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-gray-50 border-gray-200 hover:bg-blue-50 hover:border-blue-300 text-gray-700"}`}
            >
              <span>{a.icon}</span>
              {loading && action === a.key ? <Spinner /> : null}
              {a.label}
            </button>
          ))}
        </div>

        {/* Result area */}
        <div className="flex-1 overflow-y-auto p-4">
          {!result && !loading && (
            <p className="text-sm text-gray-400 text-center mt-6">Select an AI action above to get started.</p>
          )}
          {loading && (
            <div className="flex items-center justify-center gap-2 mt-6 text-blue-500 text-sm">
              <Spinner /> AI is working…
            </div>
          )}
          {result && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {result}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NewTicketModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    title: "", description: "", category: "Bug Report",
    priority: "Medium", reporter: "", assignee: "support@pmsgroup.com",
  });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState("");

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const autoClassify = async () => {
    if (!form.title && !form.description) return;
    setAiLoading(true);
    try {
      const res = await callClaude(
        'You are a PMS support classifier. Return JSON only: {"priority":"Low|Medium|High|Critical","category":"Bug Report|Feature Request|Access Issue|Data Issue|Integration|Performance|Other","suggestion":"one sentence suggestion"}',
        `Title: ${form.title}\nDescription: ${form.description}`
      );
      const clean = res.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      set("priority", parsed.priority || form.priority);
      set("category", parsed.category || form.category);
      setAiSuggestion(parsed.suggestion || "");
    } catch {
      setAiSuggestion("Could not auto-classify. Please set manually.");
    }
    setAiLoading(false);
  };

  const submit = () => {
    if (!form.title || !form.reporter) return;
    const now = new Date().toISOString();
    onSave({
      id: nextId(), ...form,
      status: "Open", created: now, updated: now,
      comments: [], sharepointRef: null, outlookRef: null,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[95vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0 bg-white z-10">
          <h2 className="font-bold text-gray-800">New Support Ticket</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl font-bold">&times;</button>
        </div>

        <div className="p-5 flex flex-col gap-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Title *</label>
            <input value={form.title} onChange={e => set("title", e.target.value)}
              className="w-full mt-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              placeholder="Brief summary of the issue" />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</label>
            <textarea value={form.description} onChange={e => set("description", e.target.value)}
              rows={3} className="w-full mt-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none"
              placeholder="Describe the issue in detail…" />
          </div>

          <button onClick={autoClassify} disabled={aiLoading}
            className="flex items-center justify-center gap-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 text-sm font-medium py-2 rounded-lg transition">
            {aiLoading ? <><Spinner /> Classifying…</> : "✨ Auto-classify with AI"}
          </button>
          {aiSuggestion && (
            <p className="text-xs bg-indigo-50 text-indigo-700 rounded-lg px-3 py-2 border border-indigo-100">{aiSuggestion}</p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Category</label>
              <select value={form.category} onChange={e => set("category", e.target.value)}
                className="w-full mt-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Priority</label>
              <select value={form.priority} onChange={e => set("priority", e.target.value)}
                className="w-full mt-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
                {PRIORITIES.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Reporter Email *</label>
              <input value={form.reporter} onChange={e => set("reporter", e.target.value)}
                className="w-full mt-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                placeholder="user@company.com" type="email" />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Assignee</label>
              <input value={form.assignee} onChange={e => set("assignee", e.target.value)}
                className="w-full mt-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                placeholder="support@pmsgroup.com" type="email" />
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={onClose}
              className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-xl text-sm font-medium hover:bg-gray-50 transition">
              Cancel
            </button>
            <button onClick={submit} disabled={!form.title || !form.reporter}
              className="flex-1 bg-blue-600 text-white py-2 rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-40 transition">
              Create Ticket
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TicketDetail({ ticket, onClose, onUpdate }) {
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState(ticket.status);
  const [aiPanel, setAiPanel] = useState(false);

  const addComment = () => {
    if (!comment.trim()) return;
    const updated = {
      ...ticket,
      comments: [...ticket.comments, { author: "support@pmsgroup.com", text: comment, time: new Date().toISOString() }],
      updated: new Date().toISOString(),
    };
    onUpdate(updated);
    setComment("");
  };

  const updateStatus = (s) => {
    setStatus(s);
    onUpdate({ ...ticket, status: s, updated: new Date().toISOString() });
  };

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-40 p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[95vh]">
          {/* Header */}
          <div className="flex items-start justify-between px-5 py-4 border-b">
            <div>
              <p className="text-xs text-gray-400 font-mono">{ticket.id}</p>
              <h2 className="font-bold text-gray-800 text-base leading-tight">{ticket.title}</h2>
              <div className="flex gap-2 mt-1 flex-wrap">
                <Badge label={ticket.priority} colorClass={PRIORITY_COLOR[ticket.priority]} />
                <Badge label={ticket.category} colorClass="bg-gray-100 text-gray-600" />
              </div>
            </div>
            <div className="flex gap-2 items-center">
              <button onClick={() => setAiPanel(true)}
                className="text-xs bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 px-3 py-1.5 rounded-lg font-medium transition">
                ✨ AI Assist
              </button>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl font-bold">&times;</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
            {/* Status selector */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500 font-semibold uppercase tracking-wide">Status:</span>
              <div className="flex gap-1 flex-wrap">
                {STATUSES.map(s => (
                  <button key={s} onClick={() => updateStatus(s)}
                    className={`text-xs px-2 py-1 rounded-full border font-medium transition
                      ${status === s ? "border-blue-400 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Meta */}
            <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 bg-gray-50 rounded-xl p-3">
              <div><span className="font-semibold">Reporter:</span> {ticket.reporter}</div>
              <div><span className="font-semibold">Assignee:</span> {ticket.assignee}</div>
              <div><span className="font-semibold">Created:</span> {new Date(ticket.created).toLocaleString()}</div>
              <div><span className="font-semibold">Updated:</span> {new Date(ticket.updated).toLocaleString()}</div>
            </div>

            {/* Description */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Description</p>
              <p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3 leading-relaxed">{ticket.description || "No description provided."}</p>
            </div>

            {/* Comments */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Comments ({ticket.comments.length})
              </p>
              <div className="flex flex-col gap-2">
                {ticket.comments.map((c, i) => (
                  <div key={i} className="bg-blue-50 border border-blue-100 rounded-xl p-3">
                    <div className="flex justify-between text-xs text-gray-400 mb-1">
                      <span className="font-semibold text-blue-700">{c.author}</span>
                      <span>{new Date(c.time).toLocaleString()}</span>
                    </div>
                    <p className="text-sm text-gray-700">{c.text}</p>
                  </div>
                ))}
                {ticket.comments.length === 0 && (
                  <p className="text-xs text-gray-400 italic">No comments yet.</p>
                )}
              </div>
            </div>

            {/* Add comment */}
            <div className="flex gap-2">
              <input value={comment} onChange={e => setComment(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addComment()}
                className="flex-1 border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                placeholder="Add a comment and press Enter…" />
              <button onClick={addComment}
                className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-blue-700 transition">
                Post
              </button>
            </div>
          </div>
        </div>
      </div>
      {aiPanel && <AIPanel ticket={ticket} onClose={() => setAiPanel(false)} />}
    </>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const [tickets, setTickets] = useState(INITIAL_TICKETS);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState(null);
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterPriority, setFilterPriority] = useState("All");
  const [search, setSearch] = useState("");

  const stats = {
    open: tickets.filter(t => t.status === "Open").length,
    inProgress: tickets.filter(t => t.status === "In Progress").length,
    resolved: tickets.filter(t => ["Resolved", "Closed"].includes(t.status)).length,
    critical: tickets.filter(t => t.priority === "Critical").length,
  };

  const filtered = tickets.filter(t => {
    const matchStatus = filterStatus === "All" || t.status === filterStatus;
    const matchPriority = filterPriority === "All" || t.priority === filterPriority;
    const matchSearch = !search ||
      t.title.toLowerCase().includes(search.toLowerCase()) ||
      t.id.toLowerCase().includes(search.toLowerCase()) ||
      t.reporter.toLowerCase().includes(search.toLowerCase());
    return matchStatus && matchPriority && matchSearch;
  });

  const addTicket = (t) => setTickets(ts => [t, ...ts]);
  const updateTicket = (updated) => {
    setTickets(ts => ts.map(t => t.id === updated.id ? updated : t));
    if (selected?.id === updated.id) setSelected(updated);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      {/* Top nav */}
      <header className="bg-white border-b shadow-sm sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-sm">PM</div>
            <div>
              <h1 className="font-bold text-gray-800 text-sm leading-tight">PMS Support Portal</h1>
              <p className="text-xs text-gray-400">Powered by SharePoint &amp; Outlook</p>
            </div>
          </div>
          <button onClick={() => setShowNew(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition shadow-sm">
            + New Ticket
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 flex flex-col gap-5">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Open", value: stats.open, color: "text-blue-600", bg: "bg-blue-50" },
            { label: "In Progress", value: stats.inProgress, color: "text-yellow-600", bg: "bg-yellow-50" },
            { label: "Resolved", value: stats.resolved, color: "text-green-600", bg: "bg-green-50" },
            { label: "Critical", value: stats.critical, color: "text-red-600", bg: "bg-red-50" },
          ].map(s => (
            <div key={s.label} className={`${s.bg} rounded-2xl p-4 flex flex-col gap-1`}>
              <span className={`text-2xl font-bold ${s.color}`}>{s.value}</span>
              <span className="text-xs text-gray-500 font-medium">{s.label}</span>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border p-4 flex flex-wrap gap-3 items-center">
          <input value={search} onChange={e => setSearch(e.target.value)}
            className="flex-1 min-w-48 border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            placeholder="Search tickets by title, ID, or reporter…" />
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
            <option>All</option>
            {STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
          <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)}
            className="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
            <option>All</option>
            {PRIORITIES.map(p => <option key={p}>{p}</option>)}
          </select>
          <span className="text-xs text-gray-400 ml-auto">{filtered.length} ticket{filtered.length !== 1 ? "s" : ""}</span>
        </div>

        {/* Ticket list */}
        <div className="flex flex-col gap-2">
          {filtered.length === 0 && (
            <div className="text-center py-12 text-gray-400 text-sm">No tickets match your filters.</div>
          )}
          {filtered.map(t => (
            <button key={t.id} onClick={() => setSelected(t)}
              className="bg-white border rounded-2xl px-4 py-3 flex items-start gap-4 hover:shadow-md hover:border-blue-200 transition text-left w-full group">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-xs font-mono text-gray-400">{t.id}</span>
                  <Badge label={t.status} colorClass={STATUS_COLOR[t.status]} />
                  <Badge label={t.priority} colorClass={PRIORITY_COLOR[t.priority]} />
                  <Badge label={t.category} colorClass="bg-gray-100 text-gray-500" />
                </div>
                <p className="text-sm font-semibold text-gray-800 truncate group-hover:text-blue-700">{t.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {t.reporter} · {new Date(t.updated).toLocaleDateString()} · {t.comments.length} comment{t.comments.length !== 1 ? "s" : ""}
                </p>
              </div>
              <span className="text-gray-300 group-hover:text-blue-400 text-lg mt-1">›</span>
            </button>
          ))}
        </div>
      </main>

      {/* Modals */}
      {showNew && <NewTicketModal onClose={() => setShowNew(false)} onSave={addTicket} />}
      {selected && <TicketDetail ticket={selected} onClose={() => setSelected(null)} onUpdate={updateTicket} />}
    </div>
  );
}
