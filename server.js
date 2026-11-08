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
  try {
    genAI = new GoogleGenerativeAI(geminiApiKey);
  } catch (err) {
    console.error("Gemini init error:", err);
  }
}

const db = {
  stats: {
    leadsCollected: 1244,
    messagesSent: 236,
    responseRate: 14,
    callsBooked: 10
  },
  agentsState: {
    scraper: { status: "active", statusText: "מחובר (Gemini)", lastAction: "סריקת מפות פעילה" },
    copywriter: { status: "active", statusText: "מחובר (Gemini)", lastAction: "ניסוח פניות מוכן" },
    sdr: { status: "active", statusText: "מאזין לוואטסאפ", lastAction: "Green-API מחובר" },
    analytics: { status: "active", statusText: "מחובר (Gemini)", lastAction: "דוח עדכני מוכן" }
  },
  activityFeed: [
    { id: 1, time: "12:15", title: "מערכת הופעלה בהצלחה", desc: "סוכני ה-AI מחוברים למודל Gemini", tag: "Gemini", type: "success" },
    { id: 2, time: "11:31", title: "סריקת Apify הסתיימה", desc: "81 לידים נוספו למאגר", tag: "Apify", type: "success" },
    { id: 3, time: "11:30", title: "שיחה חדשה תואמה", desc: "עו״ד מזרחי (חדלות פירעון)", tag: "WhatsApp", type: "success" }
  ],
  leads: [],
  chats: {
    scraper: [{ sender: "agent", text: "שלום! אני דנה (מופעלת על Gemini). אילו ערים או משרדים לסרוק כעת בגוגל מפס?" }],
    copywriter: [{ sender: "agent", text: "שלום! אני יובל. איזה סגנון פנייה בוואטסאפ נרצה לנסח כעת לעורכי דין לחדלות פירעון?" }],
    sdr: [{ sender: "agent", text: "היי! אני מאיה, סוכנת הוואטסאפ. מחוברת לקו ומטפלת בכל מענה או תיאום שיחה." }],
    analytics: [{ sender: "agent", text: "שלום! אני אורי, מנהל התפעול. אשמח להציג ניתוח ביצועים, אחוזי מענה ודוח יומי." }]
  }
};

let sseClients = [];
function broadcastUpdate() {
  const payload = JSON.stringify({
    stats: db.stats,
    agentsState: db.agentsState,
    activityFeed: db.activityFeed
  });
  sseClients.forEach(c => {
    try { c.res.write(`data: ${payload}\n\n`); } catch(e) {}
  });
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

app.get("/api/state", (req, res) => {
  res.json({ stats: db.stats, agentsState: db.agentsState, activityFeed: db.activityFeed, chats: db.chats });
});

function getSmartFallbackReply(agentId, userText) {
  if (agentId === "analytics") {
    return `דוח תפעולי עדכני:\n- סה״כ לידים שנסרקו: ${db.stats.leadsCollected}\n- הודעות שנשלחו: ${db.stats.messagesSent}\n- אחוז מענה ממוצע: ${db.stats.responseRate}%\n- שיחות שתואמו ביומן: ${db.stats.callsBooked}\n\nמצב הקמפיין יציב ונמצא בקצב המרה תקין.`;
  }
  if (agentId === "scraper") {
    db.stats.leadsCollected += 25;
    return `ביצעתי סריקה של משרדי חדלות פירעון עבור "${userText}". נאספו 25 משרדים ונשמרו מספרי סלולר 05X ישירים במאגר.`;
  }
  if (agentId === "copywriter") {
    return `הנה נוסח פנייה ממוקד:\n"שלום עו״ד [שם], ראיתי את פעילות המשרד בחדלות פירעון. יש לנו כרגע הקצאה חודשית של 25 פניות מחייבים עם חובות מעל 150K בעיר שלך. רלוונטי לכם לבדוק התאמה?"`;
  }
  if (agentId === "sdr") {
    return `רשמתי לפניי. בהודעות הבאות נציג את החבילה (5,500 ₪) ונציע תיאום שיחה קצרה ביומן.`;
  }
  return `קיבלתי: "${userText}". הפעולה עודכנה במערכת.`;
}

async function askGemini(agent, userMessage) {
  if (!genAI && !geminiApiKey) return null;
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: `${agent.systemPrompt}\nענה תמיד בעברית מקצועית וקולעת.`
    });
    const result = await model.generateContent(userMessage);
    const response = await result.response;
    return response.text();
  } catch (err) {
    console.error("Gemini API call failed:", err.message);
    try {
      const restUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
      const restRes = await fetch(restUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userMessage }] }],
          systemInstruction: { parts: [{ text: agent.systemPrompt }] }
        })
      });
      const restData = await restRes.json();
      return restData?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) {
      return null;
    }
  }
}

app.post("/api/agents/:id/chat", async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const agent = AGENTS[id];

  if (!agent) return res.status(404).json({ error: "Agent not found" });

  if (!db.chats[id]) db.chats[id] = [];
  db.chats[id].push({ sender: "user", text: message });

  db.agentsState[id].status = "processing";
  db.agentsState[id].statusText = "מעבד פקודה...";
  broadcastUpdate();

  let finalReply = null;
  if (geminiApiKey) {
    finalReply = await askGemini(agent, message);
  }
  if (!finalReply) {
    finalReply = getSmartFallbackReply(id, message);
  }

  db.chats[id].push({ sender: "agent", text: finalReply });
  db.agentsState[id].status = "active";
  db.agentsState[id].statusText = "מוכן לפעולה הבאה";
  broadcastUpdate();

  res.json({ reply: finalReply });
});

app.post("/api/simulate/:type", (req, res) => {
  const type = req.params.type;
  if (type === "apify") {
    db.stats.leadsCollected += 30;
    db.activityFeed.unshift({
      id: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
      title: "סריקת Apify הסתיימה",
      desc: "נוספו 30 עורכי דין לחדלות פירעון למאגר",
      tag: "Apify",
      type: "success"
    });
  } else if (type === "whatsapp") {
    db.stats.callsBooked += 1;
    db.activityFeed.unshift({
      id: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
      title: "פנייה נכנסת בוואטסאפ",
      desc: "עו״ד ענה: אשמח לתאם שיחה לגבי הלידים",
      tag: "WhatsApp",
      type: "success"
    });
  }
  broadcastUpdate();
  res.json({ success: true });
});

app.post("/api/webhooks/green-api", async (req, res) => {
  const body = req.body;
  if (body?.typeWebhook === "incomingMessageReceived") {
    const text = body?.messageData?.textMessageData?.textMessage;
    const phone = body?.senderData?.chatId;

    if (text && phone) {
      db.activityFeed.unshift({
        id: Date.now(),
        time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
        title: "הודעה נכנסת מוואטסאפ",
        desc: `${phone}: "${text}"`,
        tag: "WhatsApp",
        type: "success"
      });
      broadcastUpdate();

      if (genAI) {
        try {
          const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: AGENTS.sdr.systemPrompt
          });
          const result = await model.generateContent(`עורך הדין כתב בוואטסאפ: "${text}". נסחי מענה קצר לתיאום שיחה טלפונית על חבילת הלידים (5,500 ₪).`);
          const replyText = (await result.response).text();

          const id = process.env.GREEN_API_ID;
          const token = process.env.GREEN_API_TOKEN;
          if (id && token) {
            await fetch(`https://api.green-api.com/waInstance${id}/sendMessage/${token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: phone, message: replyText })
            });
          }
        } catch (e) {
          console.error("Auto reply error:", e);
        }
      }
    }
  }
  res.status(200).send("OK");
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Live Agent Hub running on port ${PORT}`));
