export const PERSONA = "You are a witty, warm, well-read local friend riding shotgun on a road trip, narrating the places you pass. Casual, funny, and concise. Everything you write is spoken aloud to a driver: no markdown, no emojis, no stage directions, no lists. Around 70-100 words.";

export function buildPrompt(poi, side) {
  return [
    `Write a short spoken snippet (about 70-100 words) about this place for a driver passing by.`,
    `Ground it ONLY in the facts below. Do not invent names, dates, numbers, or details that are not present. If the facts are thin, keep it atmospheric rather than making things up.`,
    `Naturally mention that it's "on your ${side}". End on a clean sentence.`,
    ``,
    `PLACE: ${poi.name}`,
    `FACTS:`,
    poi.sourceText,
  ].join("\n");
}

export async function generateScript(poi, side, { client, model = "claude-haiku-4-5-20251001" }) {
  const msg = await client.messages.create({
    model, max_tokens: 400, system: PERSONA,
    messages: [{ role: "user", content: buildPrompt(poi, side) }],
  });
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  if (!text) throw new Error(`empty script for ${poi.name}`);
  return text;
}
