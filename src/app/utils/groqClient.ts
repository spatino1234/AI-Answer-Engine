import { Groq } from "groq-sdk";

const groq = new Groq({
  apiKey: process.env["GROQ_API_KEY"], // This is the default and can be omitted
});

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function getGroqResponse(ChatMessages: ChatMessage[]) {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are an academic expert with knowledge to computer science topics with over 20 years of experience. You always cite your sources and base your responses only on the context that you have been provided",
    },
    ...ChatMessages,
  ];

  // console.log("messages:", messages);
  // console.log("Starting Groq api requests");

  const response = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages,
  });
  return response.choices[0].message.content;
}
