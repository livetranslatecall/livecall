// supabase/functions/groq-translate/index.ts
// Deploy: supabase functions deploy groq-translate

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-groq-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Groq modellek — sorban próbálja ha egy megtelik
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "gemma2-9b-it",
  "mixtral-8x7b-32768",
];

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  let body: { text: string; src: string; tgt: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { text, src, tgt, model } = body;

  if (!text || !src || !tgt) {
    return new Response(JSON.stringify({ error: "Missing fields: text, src, tgt" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (src === tgt) {
    return new Response(JSON.stringify({ translated: text, model: "passthrough" }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Az API kulcsot a kliens küldi a headerben (admin tárolta localStorage-ban)
  const groqKey = req.headers.get("x-groq-key");
  if (!groqKey) {
    return new Response(JSON.stringify({ error: "No API key provided" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const LANG_NAMES: Record<string, string> = {
    hu: "Hungarian", en: "English", ru: "Russian",
  };
  const srcName = LANG_NAMES[src] || src;
  const tgtName = LANG_NAMES[tgt] || tgt;

  const prompt = `Translate the following text from ${srcName} to ${tgtName}. Output ONLY the translated text, no explanation, no quotes, no prefix.\n\nText: ${text}`;

  // Modell prioritás: ha a kliens küld preferált modellt, azzal próbál először
  const modelOrder = model
    ? [model, ...GROQ_MODELS.filter((m) => m !== model)]
    : GROQ_MODELS;

  let lastError = "";
  for (const m of modelOrder) {
    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: m,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 512,
          temperature: 0.1,
        }),
      });

      if (groqRes.status === 429) {
        // Rate limit ezen a modellen — következő modellre vált
        lastError = "rate_limit";
        continue;
      }

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        lastError = `groq_error_${groqRes.status}`;
        console.error(`Groq ${m} error ${groqRes.status}:`, errText);
        continue;
      }

      const groqData = await groqRes.json();
      const translated = groqData?.choices?.[0]?.message?.content?.trim();

      if (!translated) {
        lastError = "empty_response";
        continue;
      }

      // Siker — visszaküldi a lefordított szöveget és a használt modellt
      return new Response(
        JSON.stringify({ translated, model: m, quality: "high" }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    } catch (err) {
      lastError = String(err);
      console.error(`Groq ${m} fetch error:`, err);
      continue;
    }
  }

  // Minden modell megbukott ezen a kulcson
  return new Response(
    JSON.stringify({ error: "all_models_failed", detail: lastError }),
    {
      status: 503,
      headers: { ...CORS, "Content-Type": "application/json" },
    }
  );
});
