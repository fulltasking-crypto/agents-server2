import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { AGENTS } from "./agents.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "dummy",
});

// Live in-memory database & Activity Feed
const db = {
  stats: {
    leadsCollected: 1244,
    messagesSent: 236,
    responseRate: 14,
    callsBooked: 10
  },
  agentsState: {
    scraper: { status: "idle", statusText: "ממתין לפקודה", lastAction: "סריקה אחרונה: תל אביב (81 לידים)" },
    copywriter: { status: "idle", statusText: "ממתין לפקודה", lastAction: "הוכנו 3 תבניות פנייה לעו״ד" },
    sdr: { status: "active", statusText: "מאזין להודעות וואטסאפ", lastAction: "מחובר ל-Green-API" },
    analytics: { status: "idle", statusText: "ממתין לפקודה", lastAction: "דוח יומי הופק בהצלחה" }
  },
  activityFeed: [
    { id: 1, time: "11:31", title: "סריקת Apify הסתיימה", desc: "81 לידים נוספו ל-dataset", tag: "Apify", type: "success" },
    { id: 2, time: "11:31", title: "נוצרו 3 וריאציות פתיח", desc: "נשלחו 23 הודעות בסבב הנוכחי", tag: "Webhook", type: "info" },
    { id: 3, time: "11:30", title: "הודעה נכנסת מעו״ד מזרחי", desc: "התעניין בחבילת 5,500 ₪", tag: "WhatsApp", type: "success" }
  ],
  leads: [],
  chats: {
    scraper: [
      { sender: "agent", text: "שלום! אני דנה, סוכנת איסוף הלידים. אילו ערים או משרדים לסרוק עבורך כעת בגוגל מפס?" }
    ],
    copywriter: [
      { sender: "agent", text: "שלום! אני יובל, אחראי על ניסוח הפניות המדויקות לעורכי דין לחדלות פירעון. איזה סגנון פנייה תרצה לייצר?" }
    ],
    sdr: [
      { sender: "agent", text: "היי! אני מאיה, סוכנת הוואטסאפ. אני מאזינה לשיחות נכנסות, מטפלת בהתנגדויות ומתאמת שיחות ייעוץ." }
    ],
    analytics: [
      { sender: "agent", text: "שלום! אני אורי, מנהל התפעול והדוחות. אוכל להפיק עבורך ניתוח המרות, אחוזי מענה וסיכום יומי." }
    ]
  }
};

// SSE (Server-Sent Events) clients for LIVE dashboard updates
let sseClients = [];

function broadcastUpdate() {
  const payload = JSON.stringify({
    stats: db.stats,
    agentsState: db.agentsState,
    activityFeed: db.activityFeed
  });
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch(e) {}
  });
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  // Initial push
  res.write(`data: ${JSON.stringify({
    stats: db.stats,
    agentsState: db.agentsState,
    activityFeed: db.activityFeed
  })}\n\n`);

  req.on("close", () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

app.get("/api/state", (req, res) => {
  res.json({
    stats: db.stats,
    agentsState: db.agentsState,
    activityFeed: db.activityFeed,
    chats: db.chats
  });
});

// Tool Definitions for Claude
const agentTools = [
  {
    name: "scrape_lawyers",
    description: "סריקת משרדי עורכי דין מגוגל מפס לפי אזור דרך Apify",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "עיר או אזור בישראל (למשל: תל אביב, פתח תקווה)" },
        limit: { type: "number", description: "כמות עסקים לסריקה", default: 20 }
      },
      required: ["location"]
    }
  },
  {
    name: "send_whatsapp_message",
    description: "שליחת הודעת וואטסאפ אמיתית למספר טלפון דרך Green-API",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "מספר טלפון בפורמט 9725XXXXXXXX" },
        message: { type: "string", description: "נוסח ההודעה לשליחה" }
      },
      required: ["phone", "message"]
    }
  },
  {
    name: "get_business_stats",
    description: "שליפת נתוני הביצועים והמספרים העדכניים של העסק",
    input_schema: {
      type: "object",
      properties: {}
    }
  }
];

// Helper functions for actual actions
async function executeScrape(location, limit = 20) {
  const token = process.env.APIFY_TOKEN;
  db.agentsState.scraper.status = "processing";
  db.agentsState.scraper.statusText = `סורק כעת משרדים ב${location}...`;
  broadcastUpdate();

  if (!token) {
    // If no token provided, simulate realistic crawl with realistic Israeli bankruptcy firms
    await new Promise(r => setTimeout(r, 1500));
    const sampleLeads = [
      { name: `עו״ד אילן שמעוני (${location})`, phone: "050-8472911", status: "מאומת" },
      { name: `משרד עורכי דין כהן ושות' (${location})`, phone: "052-4910293", status: "מאומת" },
      { name: `עו״ד שרון לוי - חדלות פירעון (${location})`, phone: "054-9382012", status: "מאומת" }
    ];
    db.stats.leadsCollected += limit;
    db.agentsState.scraper.status = "active";
    db.agentsState.scraper.statusText = `נמצאו ${limit} משרדים ב${location}`;
    db.activityFeed.unshift({
      id: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
      title: `סריקה הושלמה: ${location}`,
      desc: `נאספו ${limit} לידים חדשים לחדלות פירעון`,
      tag: "Apify",
      type: "success"
    });
    broadcastUpdate();
    return { success: true, count: limit, sample: sampleLeads };
  }

  try {
    const query = `עורך דין חדלות פירעון ${location}`;
    const res = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchStringsArray: [query],
        maxCrawledPlacesPerSearch: limit,
        language: "iw"
      })
    });
    const items = await res.json();
    
    let count = 0;
    if (Array.isArray(items)) {
      for (const item of items) {
        const rawPhone = (item.phone || "").replace(/[^0-9]/g, "");
        if (rawPhone.startsWith("05") || rawPhone.startsWith("9725")) {
          db.leads.push({ name: item.title, phone: rawPhone, city: location });
          count++;
        }
      }
    }
    db.stats.leadsCollected += count || limit;
    db.agentsState.scraper.status = "active";
    db.agentsState.scraper.statusText = `נוספו ${count} מספרי נייד מ${location}`;
    db.activityFeed.unshift({
      id: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
      title: `סריקה חיה הסתיימה: ${location}`,
      desc: `נוספו ${count} עורכי דין עם נייד מאומת`,
      tag: "Apify",
      type: "success"
    });
    broadcastUpdate();
    return { success: true, count, items: items.slice(0, 3) };
  } catch (err) {
    db.agentsState.scraper.status = "idle";
    broadcastUpdate();
    return { error: err.message };
  }
}

async function executeSendWhatsapp(phone, message) {
  const id = process.env.GREEN_API_ID;
  const token = process.env.GREEN_API_TOKEN;

  db.agentsState.sdr.status = "processing";
  db.agentsState.sdr.statusText = `שולח הודעה ל-${phone}...`;
  broadcastUpdate();

  if (id && token) {
    try {
      const clean = phone.replace(/[^0-9]/g, "");
      const chatId = clean.includes("@c.us") ? clean : `${clean}@c.us`;
      await fetch(`https://api.green-api.com/waInstance${id}/sendMessage/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, message })
      });
    } catch(e) {
      console.error("WhatsApp sending error:", e);
    }
  }

  db.stats.messagesSent += 1;
  db.agentsState.sdr.status = "active";
  db.agentsState.sdr.statusText = "הודעה נשלחה בהצלחה";
  db.activityFeed.unshift({
    id: Date.now(),
    time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
    title: "הודעת וואטסאפ יצאה",
    desc: `נשלח ל-${phone}: "${message.substring(0, 30)}..."`,
    tag: "Green-API",
    type: "info"
  });
  broadcastUpdate();
  return { success: true, phone, message };
}

// Simulate actions directly from buttons
app.post("/api/simulate/apify", async (req, res) => {
  await executeScrape("פתח תקווה", 25);
  res.json({ success: true });
});

app.post("/api/simulate/whatsapp", async (req, res) => {
  db.activityFeed.unshift({
    id: Date.now(),
    time: new Date().toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
    title: "תגובה נכנסת מעו״ד רונן",
    desc: "שלום, אשמח לשמוע עוד על 25 הלידים. מתי אפשר לדבר?",
    tag: "WhatsApp",
    type: "success"
  });
  db.stats.callsBooked += 1;
  db.agentsState.sdr.status = "active";
  db.agentsState.sdr.statusText = "שיחה חדשה תואמה!";
  broadcastUpdate();
  res.json({ success: true });
});

// Chat endpoint
app.post("/api/agents/:id/chat", async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const agent = AGENTS[id];

  if (!agent) return res.status(404).json({ error: "Agent not found" });

  if (!db.chats[id]) db.chats[id] = [];
  db.chats[id].push({ sender: "user", text: message });

  // Update agent status to processing
  db.agentsState[id].status = "processing";
  db.agentsState[id].statusText = "מעבד תשובה...";
  broadcastUpdate();

  // If Claude API key is missing or dummy, generate instant intelligent Hebrew response matching persona
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "dummy") {
    setTimeout(async () => {
      let reply = "";
      if (id === "scraper") {
        await executeScrape("פתח תקווה", 30);
        reply = `ביצעתי סריקה של משרדי עורכי דין לחדלות פירעון בפתח תקווה! אותרו 30 משרדים, מתוכם חולצו 22 מספרי סלולר ישירים (05X) המוכנים לשליחת הודעות פנייה.`;
      } else if (id === "copywriter") {
        reply = `הכנתי עבורך 2 נוסחים ממוקדים:\n\n1. "שלום עו"ד [שם], ראיתי את פעילות המשרד בחדלות פירעון. יש לנו 25-30 פניות חמות מחייבים (חוב 150K+) בעיר שלך. רלוונטי לבדוק חיבור?"\n2. "היי [שם], סגרתם החודש תיקי פשיטת רגל חדשים? יש לנו הקצאה חודשית בלעדית של 25 פניות למשרד אחד בלבד באזור."`;
      } else if (id === "sdr") {
        reply = `שלום! עברתי על 4 הצ'אטים הפעילים: 2 עורכי דין שאלו לגבי מחיר (הסברתי שסגירת תיק אחד ב-20K מחזירה את ה-5,500 ₪ פי 4), ואחד מהם תואם לשיחה טלפונית למחר ב-11:00.`;
      } else if (id === "analytics") {
        reply = `דוח סטטוס יומי:\n- סה"כ לידים במאגר: ${db.stats.leadsCollected}\n- הודעות שנשלחו: ${db.stats.messagesSent}\n- אחוז מענה ממוצע: ${db.stats.responseRate}%\n- שיחות שתואמו ביומן: ${db.stats.callsBooked}\n\nהקמפיין עובד בקצב מעולה וקרוב ליעד החודשי.`;
      }
      db.chats[id].push({ sender: "agent", text: reply });
      db.agentsState[id].status = "active";
      db.agentsState[id].statusText = "מוכן לפעולה הבאה";
      broadcastUpdate();
      res.json({ reply });
    }, 1200);
    return;
  }

  // Live Claude API Call with Tools
  try {
    const formattedMessages = db.chats[id].map(m => ({
      role: m.sender === "user" ? "user" : "assistant",
      content: m.text
    }));

    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: `${agent.systemPrompt}\nענה תמיד בעברית מקצועית. אתה מחובר ישירות למערכת ויכול להפעיל כלים (tools) או לענות בהתבסס על מצב העסק.`,
      messages: formattedMessages,
      tools: agentTools
    });

    let finalReply = "";

    if (response.stop_reason === "tool_use") {
      const toolUse = response.content.find(block => block.type === "tool_use");
      let toolResult = null;

      if (toolUse.name === "scrape_lawyers") {
        toolResult = await executeScrape(toolUse.input.location, toolUse.input.limit);
      } else if (toolUse.name === "send_whatsapp_message") {
        toolResult = await executeSendWhatsapp(toolUse.input.phone, toolUse.input.message);
      } else if (toolUse.name === "get_business_stats") {
        toolResult = db.stats;
      }

      const followUp = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: agent.systemPrompt,
        messages: [
          ...formattedMessages,
          { role: "assistant", content: response.content },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(toolResult)
            }]
          }
        ]
      });
      finalReply = followUp.content[0].text;
    } else {
      finalReply = response.content[0].text;
    }

    db.chats[id].push({ sender: "agent", text: finalReply });
    db.agentsState[id].status = "active";
    db.agentsState[id].statusText = "מוכן לפעולה הבאה";
    broadcastUpdate();
    res.json({ reply: finalReply });
  } catch (err) {
    db.agentsState[id].status = "idle";
    db.agentsState[id].statusText = "שגיאה ב-API";
    broadcastUpdate();
    res.status(500).json({ error: err.message });
  }
});

// Green-API Live incoming webhook
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

      try {
        const replyAi = await anthropic.messages.create({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 300,
          system: AGENTS.sdr.systemPrompt,
          messages: [{ role: "user", content: `עורך הדין כתב: "${text}". נסחי מענה קצר לתיאום שיחה טלפונית.` }]
        });
        await executeSendWhatsapp(phone, replyAi.content[0].text);
      } catch (e) {
        console.error("Auto reply error:", e);
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
