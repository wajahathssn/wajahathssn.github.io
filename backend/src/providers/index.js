import { callOpenAI } from "./openai.js";

// For now: OpenAI only.
// Later: add switch(provider) and new provider files (gemini.js, anthropic.js, etc.)
export async function callLLM({ provider, model, system, user }) {
  if (provider !== "openai") {
    throw new Error(`Provider not supported yet: ${provider}. Use provider="openai".`);
  }
  return callOpenAI({ model, system, user });
}
