import Groq from "groq-sdk";

const HINT_MODEL = process.env.GROQ_HINT_MODEL?.toString().trim() || "llama-3.3-70b-versatile";
const MAX_CONTEXT_LINES = Number(process.env.COPILOT_MAX_CONTEXT_LINES || 12);
const ENABLE_DOMAIN_GROUNDING = (process.env.COPILOT_ENABLE_DOMAIN_GROUNDING || "true").toLowerCase() !== "false";

const DOMAIN_PRODUCTS = [
  {
    name: "VoiceStream Pro",
    category: "Call Intelligence",
    pricing: "INR 1900/month",
    features: ["Live transcription", "Realtime AI hints", "Post-call summary"],
    keywords: ["voicestream pro", "voice stream pro", "transcription", "live copilot"],
  },
  {
    name: "Tata Nexon",
    category: "SUV",
    pricing: "INR 8-15 lakh",
    features: ["5-star safety", "Touchscreen infotainment", "Petrol/Diesel options"],
    keywords: ["tata nexon", "nexon"],
  },
];

let groqClient = null;

function getGroqClient() {
  if (groqClient) {
    return groqClient;
  }

  const groqApiKey = process.env.GROQ_API_KEY?.toString().trim();
  if (!groqApiKey) {
    return null;
  }

  groqClient = new Groq({ apiKey: groqApiKey });
  return groqClient;
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0.65;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeHint(candidate, fallbackTrigger) {
  const normalizedType = ["OBJECTION", "QUESTION", "BUYING_SIGNAL", "COACHING"].includes(candidate?.type)
    ? candidate.type
    : "COACHING";

  const hint = candidate?.hint?.toString().trim() || "Continue discovery with a focused follow-up";
  const detail = candidate?.detail?.toString().trim() || "Use one concise sentence and confirm customer intent.";
  const talkTrack = candidate?.talkTrack?.toString().trim() || "Thanks for sharing that. Could you tell me the most important outcome you need from this solution?";
  const trigger = candidate?.trigger?.toString().trim() || fallbackTrigger;

  return {
    type: normalizedType,
    hint,
    detail,
    talkTrack,
    trigger,
    confidence: clampConfidence(candidate?.confidence),
  };
}

function buildContextText(conversation) {
  const lines = (conversation || [])
    .slice(-MAX_CONTEXT_LINES)
    .map((entry) => `${entry.speaker === "agent" ? "AGENT" : "CUSTOMER"}: ${entry.text}`);

  return lines.join("\n");
}

function buildDomainGroundingText(latestText, conversation) {
  if (!ENABLE_DOMAIN_GROUNDING) {
    return "";
  }

  const corpus = `${latestText || ""}\n${buildContextText(conversation)}`.toLowerCase();
  const matches = DOMAIN_PRODUCTS.filter((product) =>
    product.keywords.some((keyword) => corpus.includes(keyword.toLowerCase()))
  );

  if (matches.length === 0) {
    return "";
  }

  return matches
    .map(
      (product, index) =>
        `${index + 1}. ${product.name} | ${product.category} | ${product.pricing} | Features: ${product.features.join(", ")}`
    )
    .join("\n");
}

function heuristicFallback(latestText) {
  const text = (latestText || "").toLowerCase();

  if (/too expensive|price|costly|high price|budget issue/.test(text)) {
    return {
      type: "OBJECTION",
      hint: "Price objection detected",
      detail: "Acknowledge concern, quantify value, and compare total ownership value.",
      talkTrack:
        "I understand the budget concern. If we compare total value over the next year, this option reduces risk and support effort. Which part of pricing should we optimize first for you?",
      trigger: latestText,
      confidence: 0.82,
    };
  }

  if (/how|what|which|can you|do you|is it/.test(text)) {
    return {
      type: "QUESTION",
      hint: "Customer question detected",
      detail: "Answer directly, then verify if that resolves the concern.",
      talkTrack:
        "Great question. The short answer is yes, and I can walk you through the exact fit for your scenario. Which requirement should we confirm first?",
      trigger: latestText,
      confidence: 0.76,
    };
  }

  if (/next step|send proposal|book|start|trial|timeline|when can we/.test(text)) {
    return {
      type: "BUYING_SIGNAL",
      hint: "Buying signal detected",
      detail: "Confirm intent and propose one clear next action with time.",
      talkTrack:
        "That sounds like a great fit for next steps. I can send the plan and lock a short follow-up today. Would later today or tomorrow morning work better?",
      trigger: latestText,
      confidence: 0.88,
    };
  }

  return {
    type: "COACHING",
    hint: "Coach the conversation forward",
    detail: "Ask one open-ended question to uncover decision criteria.",
    talkTrack:
      "To make sure I recommend the right option, what are the top two outcomes you need from this solution?",
    trigger: latestText,
    confidence: 0.68,
  };
}

export async function generateRealtimeHint({ latestText, conversation, entityContext }) {
  const fallback = heuristicFallback(latestText);
  const client = getGroqClient();
  if (!client) {
    return fallback;
  }

  const prompt = [
    "You are a realtime AI sales copilot for live calls.",
    "Return ONLY strict JSON with keys: type, hint, detail, talkTrack, trigger, confidence.",
    "Allowed type values: OBJECTION, QUESTION, BUYING_SIGNAL, COACHING.",
    "Never ask the user to ask the customer again.",
    "Always provide direct, useful, actionable guidance.",
    "Be concise and confident.",
    "Use product and entity context when available.",
    "talkTrack must be natural speech, <= 3 sentences, and end with a question.",
    "Do not include markdown.",
  ].join(" ");

  const contextText = buildContextText(conversation);
  const domainGroundingText = buildDomainGroundingText(latestText, conversation);
  const entityContextText = entityContext
    ? JSON.stringify(entityContext)
    : "{}";

  try {
    const response = await client.chat.completions.create({
      model: HINT_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: `Conversation context:\n${contextText}\n\nEntity context:\n${entityContextText}\n\nDomain grounding:\n${domainGroundingText || "None"}\n\nLatest line:\n${latestText}`,
        },
      ],
    });

    const content = response?.choices?.[0]?.message?.content?.toString().trim();
    if (!content) {
      return fallback;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return fallback;
    }

    return normalizeHint(parsed, latestText);
  } catch (error) {
    console.error("Hint generation failed", error?.message || error);
    return fallback;
  }
}
