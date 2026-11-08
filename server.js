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

// מגיש את ממשק הדשבורד הוויזואלי ישירות מהדפדפן!
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "dummy",
});

const database = {
  leads: [],
  sentMessages: [],
  replies: []
};

const chatMemory = { scraper: [], copywriter: [], sdr: [], analytics: [] };

const agentTools = [
  {
    name: "scrape_lawyers",
    description: "סריקת משרדי עורכי דין מגוגל מפס לפי אזור ושאילתה דרך Apify",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "עיר או אזור בישראל" },
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
        phone: { type: "string", description: "מספר טלפון בפורמט בינלאומי (972501234567)" },
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

async function executeScrape(location, limit = 20) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { error: "חסר APIFY_TOKEN" };

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
    
    const cleanLeads = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const rawPhone = (item.phone || "").replace(/[^0-9]/g, "");
        let formattedPhone = "";
        if (rawPhone.startsWith("05")) formattedPhone = "972" + rawPhone.slice(1);
        else if (rawPhone.startsWith("9725")) formattedPhone = rawPhone;

        if (formattedPhone) {
          cleanLeads.push({
            name: item.title || "עו״ד",
            phone: formattedPhone,
            city: location,
            address: item.address
          });
        }
      }
    }

    database.leads.push(...cleanLeads);
    return { success: true, totalFound: items.length || 0, validMobiles: cleanLeads.length, sample: cleanLeads.slice(0, 3) };
  } catch (err) {
    return { error: err.message };
  }
}

async function executeSendWhatsapp(phone, message) {
  const id = process.env.GREEN_API_ID;
  const token = process.env.GREEN_API_TOKEN;
  if (!id || !token) return { error: "חסרים נתוני Green-API" };

  try {
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    const chatId = `${cleanPhone}@c.us`;
    const res = await fetch(`https://api.green-api.com/waInstance${id}/sendMessage/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message })
    });
    const data = await res.json();
    database.sentMessages.push({ phone: cleanPhone, message, date: new Date().toISOString() });
    return { success: true, messageId: data.idMessage };
  } catch (err) {
    return { error: err.message };
  }
}

app.get("/api/stats", (req, res) => {
  res.json({
    leads: 1244 + database.leads.length,
    sent: 236 + database.sentMessages.length,
    rate: "14%",
    calls: 10 + database.replies.length
  });
});

app.post("/api/agents/:id/chat", async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const agent = AGENTS[id];

  if (!agent) return res.status(404).json({ error: "Agent not found" });

  try {
    chatMemory[id].push({ role: "user", content: message });

    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: `${agent.systemPrompt}\nאתה מפעיל כלים אמיתיים דרך tools לפי הצורך ומדווח תמיד בעברית.`,
      messages: chatMemory[id],
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
        toolResult = {
          totalLeadsCollected: database.leads.length,
          totalSent: database.sentMessages.length,
          replies: database.replies.length
        };
      }

      const followUp = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: agent.systemPrompt,
        messages: [
          ...chatMemory[id],
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

    chatMemory[id].push({ role: "assistant", content: finalReply });
    res.json({ reply: finalReply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/webhooks/green-api", async (req, res) => {
  const body = req.body;
  if (body?.typeWebhook === "incomingMessageReceived") {
    const text = body?.messageData?.textMessageData?.textMessage;
    const phone = body?.senderData?.chatId;

    if (text && phone) {
      database.replies.push({ phone, text, date: new Date().toISOString() });
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

// מסך ברירת מחדל
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Dashboard Server running on port ${PORT}`));
