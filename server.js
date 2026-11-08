import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AGENTS } from "./agents.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const geminiApiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
let genAI = null;
if (geminiApiKey) {
  genAI = new GoogleGenerativeAI(geminiApiKey);
}

// CRM Database in memory with persistent fields
const db = {
  stats: { leadsCollected: 0, messagesSent: 0, responseRate: 0, callsBooked: 0 },
  agentsState: {
    scraper: { status: "active", statusText: "ממתינה לפקודה" },
    copywriter: { status: "active", statusText: "ממתין לפקודה" },
    sdr: { status: "active", statusText: "מאזינה לרשת" },
    analytics: { status: "active", statusText: "מנתח נתונים" }
  },
  activityFeed: [],
  leads: [],
  chats: { scraper: [], copywriter: [], sdr: [], analytics: [] }
};

let sseClients = [];
function broadcastUpdate() {
  const payload = JSON.stringify({ stats: db.stats, agentsState: db.agentsState, activityFeed: db.activityFeed });
  sseClients.forEach(c => { try { c.res.write(`data: ${payload}\n\n`); } catch(e) {} });
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const clientId = Date.now();
  sseClients.push({ id: clientId, res });
  res.write(`data: ${JSON.stringify({ stats: db.stats, agentsState: db.agentsState, activityFeed: db.activityFeed })}\n\n`);
  req.on("close", () => { sseClients = sseClients.filter(c => c.id !== clientId); });
});

app.get("/api/state", (req, res) => res.json({ stats: db.stats, agentsState: db.agentsState, activityFeed: db.activityFeed, chats: db.chats, leads: db.leads }));

// CRM Export Endpoint - CSV compatible with Google Sheets & Excel
app.get("/api/crm/export", (req, res) => {
  let csv = "\uFEFFשם המשרד,מספר טלפון,עיר,סטטוס,תאריך הוספה\n";
  for (const lead of db.leads) {
    csv += `"${lead.name}","${lead.phone}","${lead.city}","${lead.status || 'חדש'}","${lead.date || new Date().toLocaleDateString('he-IL')}"\n`;
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=leads_crm.csv");
  res.send(csv);
});

// Sync to user's Google Sheet Webhook if GOOGLE_SHEET_WEBHOOK is set
async function syncLeadToGoogleSheet(lead) {
  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead)
    });
  } catch(e) {
    console.error("Sheet sync error:", e);
  }
}

const agentTools = {
  functionDeclarations: [
    {
      name: "scrape_lawyers",
      description: "סריקת משרדי עורכי דין לחדלות פירעון בישראל והזנתם ל-CRM",
      parameters: {
        type: "OBJECT",
        properties: {
          location: { type: "STRING", description: "העיר לסריקה (לדוגמה: פתח תקווה, תל אביב)" },
          limit: { type: "NUMBER", description: "כמות עסקים לסריקה" }
        },
        required: ["location"]
      }
    },
    {
      name: "send_whatsapp",
      description: "שליחת הודעת וואטסאפ אמיתית למספר טלפון ועדכון סטטוס הליד ב-CRM",
      parameters: {
        type: "OBJECT",
        properties: {
          phone: { type: "STRING", description: "מספר טלפון בינלאומי" },
          message: { type: "STRING", description: "תוכן ההודעה" }
        },
        required: ["phone", "message"]
      }
    },
    {
      name: "get_crm_status",
      description: "קבלת רשימת הלידים המלאה והסטטוסים מתוך ה-CRM",
      parameters: { type: "OBJECT", properties: {} }
    }
  ]
};

async function executeScrape(location, limit = 10) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { error: "חסר APIFY_TOKEN בהגדרות שרת ב-Railway" };

  try {
    const query = `עורך דין חדלות פירעון ${location}`;
    const res = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchStringsArray: [query], maxCrawledPlacesPerSearch: limit, language: "iw" })
    });
    const items = await res.json();
    let count = 0;
    const added = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const rawPhone = (item.phone || "").replace(/[^0-9]/g, "");
        if (rawPhone.startsWith("05") || rawPhone.startsWith("9725")) {
          const newLead = { 
            name: item.title, 
            phone: rawPhone, 
            city: location, 
            status: "חדש במאגר", 
            date: new Date().toLocaleDateString('he-IL') 
          };
          db.leads.push(newLead);
          syncLeadToGoogleSheet(newLead);
          added.push(item.title);
          count++;
        }
      }
    }
    db.stats.leadsCollected = db.leads.length;
    db.activityFeed.unshift({ id: Date.now(), time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}), title: `Apify סיים סריקה ב${location}`, desc: `נוספו ${count} לידים לגיליון ה-CRM`, tag: "Apify", type: "success" });
    broadcastUpdate();
    return { success: true, count, names: added.slice(0, 5) };
  } catch (err) {
    return { error: err.message };
  }
}

async function executeSendWhatsapp(phone, message) {
  const id = process.env.GREEN_API_ID;
  const token = process.env.GREEN_API_TOKEN;
  if (!id || !token) return { error: "חסר GREEN_API_ID או GREEN_API_TOKEN בשרת" };

  try {
    const clean = phone.replace(/[^0-9]/g, "");
    const chatId = clean.includes("@c.us") ? clean : `${clean}@c.us`;
    const res = await fetch(`https://api.green-api.com/waInstance${id}/sendMessage/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message })
    });
    const data = await res.json();
    if (data.idMessage) {
      db.stats.messagesSent++;
      // Update status in CRM
      const lead = db.leads.find(l => l.phone.includes(clean) || clean.includes(l.phone));
      if (lead) {
        lead.status = "נשלחה פנייה ראשונה";
        syncLeadToGoogleSheet(lead);
      }
      db.activityFeed.unshift({ id: Date.now(), time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}), title: "הודעת וואטסאפ נשלחה", desc: `נשלח ל-${phone}`, tag: "WhatsApp", type: "info" });
      broadcastUpdate();
      return { success: true, idMessage: data.idMessage };
    }
    return { error: "שגיאת וואטסאפ", details: data };
  } catch (err) {
    return { error: err.message };
  }
}

async function callGeminiModel(systemPrompt, userMessage, history) {
  // Use gemini-1.5-flash as standard
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    tools: [agentTools],
    systemInstruction: systemPrompt
  });

  const formattedHistory = history.filter(m => m.sender !== "system").map(m => ({
    role: m.sender === "user" ? "user" : "model",
    parts: [{ text: m.text }]
  }));
  formattedHistory.pop();

  const chat = model.startChat({ history: formattedHistory });
  let result = await chat.sendMessage(userMessage);
  let response = result.response;

  const calls = response.functionCalls();
  if (calls && calls.length > 0) {
    const call = calls[0];
    let toolResult = {};
    if (call.name === "scrape_lawyers") {
      toolResult = await executeScrape(call.args.location, call.args.limit);
    } else if (call.name === "send_whatsapp") {
      toolResult = await executeSendWhatsapp(call.args.phone, call.args.message);
    } else if (call.name === "get_crm_status") {
      toolResult = { stats: db.stats, totalLeads: db.leads.length, sample: db.leads.slice(0, 5) };
    }

    result = await chat.sendMessage([{
      functionResponse: { name: call.name, response: toolResult }
    }]);
    response = result.response;
  }

  return response.text();
}

app.post("/api/agents/:id/chat", async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const agent = AGENTS[id];

  if (!agent) return res.status(404).json({ error: "Agent not found" });
  if (!db.chats[id]) db.chats[id] = [];
  db.chats[id].push({ sender: "user", text: message });

  if (!geminiApiKey) {
    const errorMsg = "שגיאה: חסר משתנה GEMINI_API_KEY ב-Railway.";
    db.chats[id].push({ sender: "agent", text: errorMsg });
    return res.json({ reply: errorMsg });
  }

  db.agentsState[id].status = "processing";
  db.agentsState[id].statusText = "חושב ומתכנן...";
  broadcastUpdate();

  try {
    const dynamicSystem = `${agent.systemPrompt}\n\nמצב ה-CRM כרגע:\n- סה"כ לידים במאגר: ${db.leads.length}\n- הודעות שנשלחו: ${db.stats.messagesSent}\nענה בעברית רהוטה ומקצועית בלבד.`;
    const finalReply = await callGeminiModel(dynamicSystem, message, db.chats[id]);

    db.chats[id].push({ sender: "agent", text: finalReply });
    db.agentsState[id].status = "active";
    db.agentsState[id].statusText = "המשימה הושלמה";
    broadcastUpdate();

    res.json({ reply: finalReply });
  } catch (err) {
    console.error("Agent chat error:", err);
    let errorMsg = err.message;
    if (errorMsg.includes("404") || errorMsg.includes("not found")) {
      errorMsg = "⚠️ מפתח ה-API של Google דורש הפעלה: אנא היכנס לקישור הבא ולחץ 'Enable' (הפעל) כדי לאפשר ל-Gemini לרוץ בפרויקט:\nhttps://console.cloud.google.com/apis/library/generativelanguage.googleapis.com";
    }
    db.chats[id].push({ sender: "agent", text: errorMsg });
    db.agentsState[id].status = "active";
    db.agentsState[id].statusText = "שגיאה";
    broadcastUpdate();
    res.json({ reply: errorMsg });
  }
});

app.post("/api/webhooks/green-api", async (req, res) => {
  const body = req.body;
  if (body?.typeWebhook === "incomingMessageReceived") {
    const text = body?.messageData?.textMessageData?.textMessage;
    const phone = body?.senderData?.chatId;
    if (text && phone) {
      db.activityFeed.unshift({ id: Date.now(), time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}), title: "הודעה נכנסת", desc: `${phone}: "${text}"`, tag: "WhatsApp", type: "success" });
      broadcastUpdate();
    }
  }
  res.status(200).send("OK");
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
const PORT = process.env.PORT || 8787;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Live Server running on port ${PORT}`));
