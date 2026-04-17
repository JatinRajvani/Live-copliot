import Groq from "groq-sdk";

const SUMMARY_MODEL = process.env.GROQ_SUMMARY_MODEL?.toString().trim() || "llama-3.3-70b-versatile";

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

function toPercent(value, fallback = 55) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toScore(value, fallback = 6.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

function aggregateHintCounts(hints) {
  const counts = {
    OBJECTION: 0,
    QUESTION: 0,
    BUYING_SIGNAL: 0,
    COACHING: 0,
  };

  for (const hint of hints || []) {
    if (counts[hint?.type] !== undefined) {
      counts[hint.type] += 1;
    }
  }

  return counts;
}

function fallbackSummary({ conversation, hints }) {
  const counts = aggregateHintCounts(hints);
  const totalLines = conversation?.length || 0;
  const hasBuying = counts.BUYING_SIGNAL > 0;

  return {
    sentiment: hasBuying ? "positive" : "neutral",
    dealProbability: hasBuying ? 72 : 48,
    repScore: hasBuying ? 7.8 : 6.4,
    executiveSummary:
      totalLines > 0
        ? "Conversation completed with usable customer context. Review key questions and objections to plan the next follow-up."
        : "Insufficient transcript data to generate a rich summary.",
    actionItems: [
      {
        priority: "high",
        task: "Send a concise recap and proposed next step to the customer.",
      },
      {
        priority: "medium",
        task: "Address unresolved objections with specific value proof points.",
      },
    ],
    hintBreakdown: counts,
    nextBestAction: "Schedule a short follow-up to close open questions.",
    followUpEmail:
      "Hi, thanks for your time today. Based on our conversation, I am sharing the best-fit option and next steps. Please let me know a convenient time for a quick follow-up call.",
  };
}

function normalizeSummary(candidate, fallback) {
  const safe = candidate || {};

  return {
    sentiment: ["positive", "neutral", "negative"].includes((safe.sentiment || "").toLowerCase())
      ? safe.sentiment.toLowerCase()
      : fallback.sentiment,
    dealProbability: toPercent(safe.dealProbability, fallback.dealProbability),
    repScore: toScore(safe.repScore, fallback.repScore),
    executiveSummary: safe.executiveSummary?.toString().trim() || fallback.executiveSummary,
    actionItems: Array.isArray(safe.actionItems) && safe.actionItems.length > 0
      ? safe.actionItems.slice(0, 5).map((item) => ({
          priority: item?.priority?.toString().trim() || "medium",
          task: item?.task?.toString().trim() || "Review call and define next action.",
        }))
      : fallback.actionItems,
    hintBreakdown: {
      OBJECTION: Number(safe?.hintBreakdown?.OBJECTION ?? fallback.hintBreakdown.OBJECTION) || 0,
      QUESTION: Number(safe?.hintBreakdown?.QUESTION ?? fallback.hintBreakdown.QUESTION) || 0,
      BUYING_SIGNAL: Number(safe?.hintBreakdown?.BUYING_SIGNAL ?? fallback.hintBreakdown.BUYING_SIGNAL) || 0,
      COACHING: Number(safe?.hintBreakdown?.COACHING ?? fallback.hintBreakdown.COACHING) || 0,
    },
    nextBestAction: safe.nextBestAction?.toString().trim() || fallback.nextBestAction,
    followUpEmail: safe.followUpEmail?.toString().trim() || fallback.followUpEmail,
  };
}

function buildConversationText(conversation) {
  return (conversation || [])
    .map((entry) => `${entry.speaker === "agent" ? "AGENT" : "CUSTOMER"}: ${entry.text}`)
    .join("\n");
}

export async function generateSessionSummary({ conversation, hints }) {
  const fallback = fallbackSummary({ conversation, hints });
  const client = getGroqClient();
  if (!client) {
    return fallback;
  }

  const systemPrompt = [
    "You summarize a sales call.",
    "Return ONLY strict JSON with keys:",
    "sentiment, dealProbability, repScore, executiveSummary, actionItems, hintBreakdown, nextBestAction, followUpEmail.",
    "sentiment must be one of positive, neutral, negative.",
    "dealProbability is 0-100.",
    "repScore is 0-10.",
    "actionItems must be an array of up to 5 items with priority and task.",
    "Do not include markdown.",
  ].join(" ");

  try {
    const response = await client.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Hints observed: ${JSON.stringify(aggregateHintCounts(hints))}\n\nConversation:\n${buildConversationText(conversation)}`,
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

    return normalizeSummary(parsed, fallback);
  } catch (error) {
    console.error("Summary generation failed", error?.message || error);
    return fallback;
  }
}
