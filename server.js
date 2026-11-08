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

const geminiApiKey = process.env.GEMINI_API_KEY;
let genAI = null;
if (geminiApiKey) {
  genAI = new GoogleGenerativeAI(geminiApiKey);
}

// 100% REAL SHARED DATABASE
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

app.get("/api/state", (req, res) => res.json({ stats: db.stats, agentsState: db.agentsState, activityFeed: db.activityFeed, chats: db.chats }));

// REAL TOOLS DEFINITION FOR GEMINI
const agentTools = {
  functionDeclarations: [
    {
      name: "scrape_lawyers",
      description: "הפעלת מנוע Apify כדי לסרוק מגוגל מפס עורכי דין לחדלות פירעון בישראל",
      parameters: {
        type: "OBJECT",
        properties: {
          location: { type: "STRING", description: "העיר או האזור לסריקה (למשל: תל אביב, פתח תקווה)" },
          limit: { type: "NUMBER", description: "כמות עסקים לסרוק (מקסימום 20)" }
        },
        required: ["location"]
      }
    },
    {
      name: "send_whatsapp",
      description: "שליחת הודעת וואטסאפ אמיתית למספר טלפון דרך Green-API",
      parameters: {
        type: "OBJECT",
        properties: {
          phone: { type: "STRING", description: "מספר הטלפון בפורמט 9725XXXXXXXX" },
          message: { type: "STRING", description: "תוכן ההודעה המדויק לשליחה" }
        },
        required: ["phone", "message"]
      }
    },
    {
      name: "get_system_data",
      description: "קבלת מצב המערכת האמיתי: כמות הלידים, שמות הלידים, וכמות ההודעות שנשלחו",
      parameters: { type: "OBJECT", properties: {} }
    }
  ]
};

// REAL EXECUTIONS
async function executeScrape(location, limit = 10) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { error: "חסר APIFY_TOKEN בשרת. לא ניתן לבצע סריקה אמתית. אנא הוסף את המשתנה ב-Railway." };

  try {
    const query = `עורך דין חדלות פירעון ${location}`;
    const res = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchStringsArray: [query], maxCrawledPlacesPerSearch: limit, language: "iw" })
    });
    const items = await res.json();
    if (res.status !== 200 && res.status !== 201) return { error: "שגיאה מ-Apify", details: items };
    
    let count = 0;
    const added = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const rawPhone = (item.phone || "").replace(/[^0-9]/g, "");
        if (rawPhone.startsWith("05") || rawPhone.startsWith("9725")) {
          db.leads.push({ name: item.title, phone: rawPhone, city: location });
          added.push(item.title);
          count++;
        }
      }
    }
    db.stats.leadsCollected = db.leads.length;
    db.activityFeed.unshift({ id: Date.now(), time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}), title: `Apify סיים סריקה ב${location}`, desc: `נוספו ${count} לידים עם נייד`, tag: "Apify", type: "success" });
    broadcastUpdate();
    return { success: true, newLeadsFound: count, names: added.slice(0,5) };
  } catch (err) {
    return { error: err.message };
  }
}

async function executeSendWhatsapp(phone, message) {
  const id = process.env.GREEN_API_ID;
  const token = process.env.GREEN_API_TOKEN;
  if (!id || !token) return { error: "חסר GREEN_API_ID או GREEN_API_TOKEN בהגדרות השרת." };

  try {
    const clean = phone.replace(/[^0-9]/g, "");
    const chatId = clean.includes("@c.us") ? clean : `${clean}@c.us`;
    const res = await fetch(`https://api.green-api.com/waInstance${id}/sendMessage/${token}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message })
    });
    const data = await res.json();
    if (data.idMessage) {
      db.stats.messagesSent++;
      db.activityFeed.unshift({ id: Date.now(), time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}), title: "הודעה יצאה", desc: `נשלח ל-${phone}: ${message.substring(0,20)}...`, tag: "WhatsApp", type: "info" });
      broadcastUpdate();
      return { success: true, idMessage: data.idMessage };
    }
    return { error: "שגיאת וואטסאפ", details: data };
  } catch(e) { return { error: e.message }; }
}

// NO MORE FAKE FALLBACKS. 100% REAL GEMINI.
app.post("/api/agents/:id/chat", async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const agent = AGENTS[id];

  if (!agent) return res.status(404).json({ error: "Agent not found" });
  if (!db.chats[id]) db.chats[id] = [];
  
  db.chats[id].push({ sender: "user", text: message });

  if (!genAI) {
    const errorMsg = "שגיאה קריטית: חסר מפתח GEMINI_API_KEY בשרת. אין לי אפשרות לחשוב. אנא הוסף את המפתח ל-Railway.";
    db.chats[id].push({ sender: "agent", text: errorMsg });
    return res.json({ reply: errorMsg });
  }

  db.agentsState[id].status = "processing";
  db.agentsState[id].statusText = "חושב ומתכנן פעולה...";
  broadcastUpdate();

  try {
    const dynamicSystemPrompt = `${agent.systemPrompt}\n\nזיכרון מערכת משותף כרגע:\n- סה"כ לידים במאגר: ${db.leads.length}\n- סה"כ הודעות שנשלחו: ${db.stats.messagesSent}\nהפעל את הכלים שלך רק מתי שצריך. לעולם אל תשקר שעשית משהו אם לא קראת לפונקציה שלו!`;

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      tools: [agentTools],
      systemInstruction: dynamicSystemPrompt
    });

    const history = db.chats[id].filter(m => m.sender !== "system").map(m => ({
      role: m.sender === "user" ? "user" : "model",
      parts: [{ text: m.text }]
    }));

    // Remove the very last user message because sendMessage takes it separately
    history.pop();
    
    const chat = model.startChat({ history });
    
    let result = await chat.sendMessage(message);
    let response = result.response;

    // Check if the AI decided to use a tool (Apify / WhatsApp)
    const calls = response.functionCalls();
    if (calls && calls.length > 0) {
      const call = calls[0];
      let toolResult = {};

      db.agentsState[id].statusText = `מפעיל את ${call.name}...`;
      broadcastUpdate();

      if (call.name === "scrape_lawyers") {
        toolResult = await executeScrape(call.args.location, call.args.limit);
      } else if (call.name === "send_whatsapp") {
        toolResult = await executeSendWhatsapp(call.args.phone, call.args.message);
      } else if (call.name === "get_system_data") {
        toolResult = { stats: db.stats, leads: db.leads.slice(0, 10) }; // send up to 10 leads as sample
      }

      // Return the real results from the code back to Gemini's brain
      result = await chat.sendMessage([{
        functionResponse: {
          name: call.name,
          response: toolResult
        }
      }]);
      response = result.response;
    }

    const finalReply = response.text();
    db.chats[id].push({ sender: "agent", text: finalReply });
    db.agentsState[id].status = "active";
    db.agentsState[id].statusText = "המשימה הושלמה";
    broadcastUpdate();

    res.json({ reply: finalReply });

  } catch (err) {
    console.error(err);
    const errorMsg = "שגיאת מערכת בזמן הפעלת המודל האמיתי: " + err.message;
    db.chats[id].push({ sender: "agent", text: errorMsg });
    db.agentsState[id].status = "active";
    db.agentsState[id].statusText = "שגיאה";
    broadcastUpdate();
    res.json({ reply: errorMsg });
  }
});

// Real webhook receiver
app.post("/api/webhooks/green-api", async (req, res) => {
  const body = req.body;
  if (body?.typeWebhook === "incomingMessageReceived") {
    const text = body?.messageData?.textMessageData?.textMessage;
    const phone = body?.senderData?.chatId;
    if (text && phone) {
      db.activityFeed.unshift({ id: Date.now(), time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}), title: "הודעה נכנסת", desc: `${phone}: "${text}"`, tag: "WhatsApp", type: "success" });
      broadcastUpdate();
      // SDR agent can process this asynchronously here if needed
    }
  }
  res.status(200).send("OK");
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
const PORT = process.env.PORT || 8787;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Real Agent Hub running on port ${PORT}`));
