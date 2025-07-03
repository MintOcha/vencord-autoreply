/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";
import { CspPolicies, ConnectSrc } from "@main/csp";
const { GoogleGenerativeAI } = require("@google/generative-ai");
CspPolicies["https://generativelanguage.googleapis.com"] = ConnectSrc;
CspPolicies["https://api.deepseek.com"] = ConnectSrc;

interface ChatHistory {
    role: "user" | "model";
    parts: { text: string; }[];
}

export async function makeAIRequest(_: IpcMainInvokeEvent, provider: string, apiKey: string, model: string, history: ChatHistory[], message: string) {
    try {
        if (provider === "gemini") {
            const genAI = new GoogleGenerativeAI(apiKey);
            const aiModel = genAI.getGenerativeModel({ model: model || "gemini-2.5-pro" });
            const chat = await aiModel.startChat({
                history,
                generationConfig: {
                    temperature: 0.9,
                    topK: 40,
                    topP: 0.95,
                }
            });
            const result = await chat.sendMessage(message);
            return { success: true, data: result.response.text() };
        }

        if (provider === "deepseek" || provider === "openai") {
            const endpoint = provider === "deepseek" ?
                "https://api.deepseek.com/v1/chat/completions" :
                "https://api.openai.com/v1/chat/completions";

            const headers = {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            };

            const modelName = model || (provider === "deepseek" ? "deepseek-chat" : "gpt-3.5-turbo");

            const body = JSON.stringify({
                model: modelName,
                messages: [
                    ...history.map(msg => ({
                        role: provider === "deepseek" && msg.role === "model" ? "assistant" : msg.role,
                        content: msg.parts[0].text
                    })),
                    { role: "user", content: message }
                ],
                temperature: 0.9,
                max_tokens: 1000
            });

            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body
            });

            if (!response.ok) {
                return { success: false, error: `API request failed: ${response.statusText}` };
            }

            const data = await response.json();
            return { success: true, data: data.choices[0].message.content };
        }

        return { success: false, error: "Unknown provider" };
    } catch (error) {
        console.error("Error in makeAIRequest:", error);
        return { success: false, error: String(error) };
    }
}
