import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import fs from "fs/promises";
import  GoogleSpreadsheetPkg  from 'google-spreadsheet';
import jwt from 'jsonwebtoken';

dotenv.config();

const app = express();
app.use(express.json());


// ────────────────────────────────────────────────
function extractNameFromMessage(text) {
  const regex = /(i am|i'm|this is|my name is)\s+([a-zA-Z]+)/i;
  const match = text.match(regex);
  return match ? match[2] : null;
}
// ────────────────────────────────────────────────


function calculateLeadScore(intent, message) {
  let score = 0;

  const buyingKeywords = [
    "price", "pricing", "cost", "buy", "purchase",
    "budget", "payment", "charges"
  ];

  if (["pricing", "booking", "services"].includes(intent)) {
    score += 2;
  }

  if (buyingKeywords.some(word => message.toLowerCase().includes(word))) {
    score += 2;
  }

  if (score >= 4) return "HOT";
  if (score >= 2) return "WARM";
  return "COLD";
}


// ────────────────────────────────────────────────





const { GoogleSpreadsheet } = GoogleSpreadsheetPkg;

async function saveLeadToExcel(lead) {
  const SHEET_ID = "1xMgxqCRe5Q22RLD6-84odv_eQ6t7rjnTNNLgEUNiQ4s";
  const CREDENTIALS_PATH = "./google-credentials.json";

  try {
    const credentialsRaw = await fs.readFile(CREDENTIALS_PATH, 'utf8');
    const credentials = JSON.parse(credentialsRaw);

    const doc = new GoogleSpreadsheet(SHEET_ID);

    await doc.useServiceAccountAuth({
      client_email: credentials.client_email,
      private_key: credentials.private_key.replace(/\\n/g, '\n'),
    });

    await doc.loadInfo();

    const sheet = doc.sheetsByIndex[0];

    if (!sheet.headerValues || sheet.headerValues.length === 0) {
      await sheet.setHeaderRow([
        "Name",
        "Phone",
        "Intent",
        "Lead Score",
        "Message",
        "Time",
      ]);
    }

    await sheet.addRow({
      Name: lead.name || "Unknown",
      Phone: lead.phone,
      Intent: lead.intent,
      "Lead Score": lead.score,
      Message: lead.message,
      Time: lead.time,
    });

    console.log("✅ Lead saved to Google Sheet:", lead.phone);

  } catch (err) {
    console.error("❌ Failed to save to Google Sheet:", err);
    console.log("Failed lead data:", lead);
  }
}

async function detectIntentWithGemini(userMessage) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: `
Classify the user's WhatsApp message into ONE intent.

Intents:
- greeting
- pricing
- services
- booking
- lead
- general

Message:
"${userMessage}"

Reply ONLY with JSON:
{ "intent": "one_intent_here" }
                `
              }
            ]
          }
        ]
      }
    );

    const rawText = response.data.candidates[0].content.parts[0].text;

    // Remove ```json ``` or ``` wrappers if Gemini adds them
    const cleanedText = rawText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(cleanedText);


  } catch (error) {
    console.error("Gemini intent error:", error.response?.data || error.message);
    return { intent: "general" };
  }
}


async function generateReplyWithGemini(intent, userMessage, userName = null) {
  try {
    let nameContext = "";
    if (userName) {
      nameContext = `The user's name is ${userName}. Use their name naturally in the reply if it feels appropriate.`;
    }

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: `
You are a professional WhatsApp business assistant.

User intent: ${intent}
${nameContext}

User message:
"${userMessage}"

Write a short WhatsApp reply.
Rules:
- Friendly and professional
- No emojis
- No AI mention
- Under 3 lines
- Ask a follow-up question if helpful
                `
              }
            ]
          }
        ]
      }
    );

    return response.data.candidates[0].content.parts[0].text.trim();

  } catch (error) {
    console.error("Gemini reply error:", error.response?.data || error.message);
    return "Thanks for reaching out. Could you please share a bit more detail?";
  }
}


async function sendWhatsAppMessage(phone, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("WhatsApp send error:", error.response?.data || error.message);
  }
}


app.get("/webhook", (req, res) => {
  const verifyToken = "my_verify_token";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});


app.post("/webhook", async (req, res) => {
  // ──── ADDED AS REQUESTED ────
  console.log("RAW WEBHOOK BODY:", JSON.stringify(req.body, null, 2));
  // ────────────────────────────

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const messageObj = change?.value?.messages?.[0];

    if (!messageObj || messageObj.type !== "text") {
      return res.sendStatus(200);
    }

    const userPhone = messageObj.from;
    const userText = messageObj.text.body.trim();

    console.log("Incoming:", userText);

    // 1. Extract name (if provided)
    const extractedName = extractNameFromMessage(userText);

    // 2. Detect intent
    const { intent } = await detectIntentWithGemini(userText);
    console.log("Intent:", intent);

    // ────────────────────────────────────────────────
    // NEW LOGIC AS REQUESTED IN STEP 5.6
    const name = extractNameFromMessage(userText);
    const leadScore = calculateLeadScore(intent, userText);

    console.log("Name:", name);
    console.log("Lead Score:", leadScore);

    // Save ALL incoming messages (safest for now - you can filter later)
    await saveLeadToExcel({
      name: name || "Unknown",
      phone: userPhone,
      intent,
      score: leadScore,
      message: userText,
      time: new Date().toLocaleString()
    });

    // 4. Generate personalized reply
    const reply = await generateReplyWithGemini(intent, userText, extractedName);
    console.log("Reply:", reply);

    let finalReply = reply;

    if (leadScore === "HOT") {
      finalReply += "\n\nOur team will contact you shortly with detailed pricing.";
    }

    // 5. Send final reply to user
    await sendWhatsAppMessage(userPhone, finalReply);
    // ────────────────────────────────────────────────

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.message);
    res.sendStatus(200);
  }
});


app.post("/send-message", async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({
      success: false,
      error: "Missing phone or message"
    });
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).json({
      success: true,
      data: response.data
    });
  } catch (error) {
    console.error("WhatsApp API error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log("Waiting for POST requests to /send-message ...");
});