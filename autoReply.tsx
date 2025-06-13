/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Alerts, FluxDispatcher, MessageActions, MessageStore, RestAPI } from "@webpack/common";

const { GoogleGenerativeAI } = require("@google/generative-ai");
var isStarted = false;
var deBounce = false;

interface ChatHistory {
    role: "user" | "model";
    parts: { text: string; }[];
}

// Store chat sessions per channel
let activeChannelId: string | null = null;

// Cache for dynamically fetched models
let cachedModels: { [key: string]: any[] } = {
    gemini: [],
    deepseek: [],
    openai: []
};

// Function to get available models for each provider
function getAvailableModels(provider: string): any[] {
    switch (provider) {
        case "gemini":
            return [
                { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
                { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash" },
                { label: "Gemini 1.5 Pro", value: "gemini-1.5-pro" },
                { label: "Gemini 1.5 Flash", value: "gemini-1.5-flash" }
            ];
        case "deepseek":
            return [
                { label: "DeepSeek Chat", value: "deepseek-chat" },
                { label: "DeepSeek Coder", value: "deepseek-coder" }
            ];
        case "openai":
            return [
                { label: "GPT-3.5 Turbo", value: "gpt-3.5-turbo" },
                { label: "GPT-4", value: "gpt-4" },
                { label: "GPT-4 Turbo", value: "gpt-4-turbo" },
                { label: "GPT-4o", value: "gpt-4o" },
                { label: "GPT-4o Mini", value: "gpt-4o-mini" }
            ];
        default:
            return [];
    }
}

// Function to update model options dynamically
function updateModelOptions() {
    const provider = settings.store.aiProvider;

    if (provider && cachedModels[provider] && cachedModels[provider].length === 0) {
        const models = getAvailableModels(provider);
        cachedModels[provider] = models;
    }

    // Update the settings options (this will refresh the UI)
    if (provider && settings.def.model && settings.def.model.options) {
        const currentModels = cachedModels[provider] || [];
        // Clear existing options and add new ones
        while (settings.def.model.options.length > 0) {
            settings.def.model.options.pop();
        }
        currentModels.forEach(model => settings.def.model.options.push(model));
    }
}

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Whether or not the plugin is enabled",
        default: true,
    },
    aiProvider: {
        type: OptionType.SELECT,
        description: "AI Provider to use",
        default: "gemini",
        options: [
            { label: "DeepSeek", value: "deepseek" },
            { label: "OpenAI", value: "openai" },
            { label: "Gemini", value: "gemini" }
        ]
    },
    model: {
        type: OptionType.SELECT,
        description: "AI Model to use (dynamic models will load based on provider and API key)",
        default: "gemini-2.5-pro",
        options: [
            { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" }
        ]  // Will be populated dynamically based on selected provider
    },
    apiKey: {
        type: OptionType.STRING,
        description: "API key for the selected provider",
        default: "",
    },
    cooldown: {
        type: OptionType.NUMBER,
        description: "Cooldown period in seconds before replying again",
        default: 5,
    },
    customInstructions: {
        type: OptionType.STRING,
        description: "Custom instructions for the AI (e.g., how to behave, specific personality traits)",
        default: "Please mimic the communication style based on the message history of the model. Maintain a natural, conversational tone.",
    },
    historyLength: {
        type: OptionType.NUMBER,
        description: "Number of previous messages to include for context",
        default: 10,
    },
    showTyping: {
        type: OptionType.BOOLEAN,
        description: "Show typing indicator when replying",
        default: true,
    }
});

// Chat toggle button component
const AutoReplyToggle = ({ isMainChat }) => {
    const toggle = () => isStarted = !isStarted;

    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip={isStarted ? "Disable Auto Reply" : "Enable Auto Reply"}
            onClick={toggle}
        >
            <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                style={{ scale: "1.2" }}
            >
                <path fill="currentColor" mask="url(#vc-silent-msg-mask)" d="M18 10.7101C15.1085 9.84957 13 7.17102 13 4c0-.30736.0198-.6101.0582-.907C12.7147 3.03189 12.3611 3 12 3 8.686 3 6 5.686 6 9v5c0 1.657-1.344 3-3 3v1h18v-1c-1.656 0-3-1.343-3-3v-3.2899ZM8.55493 19c.693 1.19 1.96897 2 3.44497 2s2.752-.81 3.445-2H8.55493ZM18.2624 5.50209 21 2.5V1h-4.9651v1.49791h2.4411L16 5.61088V7h5V5.50209h-2.7376Z" />
                {!isStarted && <>
                    <mask id="vc-silent-msg-mask">
                        <path fill="#fff" d="M0 0h24v24H0Z" />
                        <path stroke="#000" strokeWidth="5.99068" d="M0 24 24 0" />
                    </mask>
                    <path fill="var(--status-danger)" d="m21.178 1.70703 1.414 1.414L4.12103 21.593l-1.414-1.415L21.178 1.70703Z" />
                </>}
            </svg>
        </ChatBarButton>
    );
};

async function setTypingStatus(channelId: string, typing: boolean) {
    try {
        if (typing) {
            // Use Discord's REST API to send typing indicator
            await RestAPI.post({
                url: `/channels/${channelId}/typing`
            });
        }
    } catch (error) {
        console.error("Error setting typing status:", error);
    }
}

async function getMessageHistory(channelId: string): Promise<ChatHistory[]> {
    const messages = MessageStore.getMessages(channelId)?.toArray().slice(-settings.store.historyLength) || [];
    const selfId = window.DiscordNative.crashReporter.getMetadata().user_id;
    var msgdict = messages.map(msg => ({
        role: msg.author.id === selfId ? "model" : "user",
        parts: [{ text: msg.content }]
    }));

    // go through messages and delete empty ones
    msgdict = msgdict.filter(msg => msg.parts[0].text.trim() !== "");
    if (msgdict[0].role === "model") msgdict[0].role = "user";
    return msgdict;
}

async function makeAICall(history: ChatHistory[], message: string): Promise<string> {
    const provider = settings.store.aiProvider;
    const { apiKey, model } = settings.store;

    if (!apiKey) {
        throw new Error("API key is required");
    }

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
        return result.response.text();
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

        console.log("Messages received!", [
            ...history.map(msg => ({
                role: msg.role,
                content: msg.parts[0].text
            })),
            { role: "user", content: message }
        ]);

        const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body
        });

        if (!response.ok) {
            throw new Error(`API request failed: ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }
    console.error("No such provider!");
    return "";
}

async function generateReply(channelId: string, message: string): Promise<string> {
    try {
        if (!message || message.trim() === "") {
            throw new Error("Empty message content");
        }

        const history = await getMessageHistory(channelId);
        history.pop(); // Remove latest message
        history.push({
            role: "user",
            parts: [{ text: settings.store.customInstructions }]
        });

        const response = await makeAICall(history, message);
        return response;
    } catch (error) {
        console.error("Error generating reply:", error);
        throw error;
    }
}

export default definePlugin({
    name: "autoReply",
    description: "Automatically reply to messages using AI",
    authors: [{ name: "MintOcha", id: 1272925700013424660n }],
    settings,

    start() {
        if (!settings.store.apiKey) {
            Alerts.show({
                title: "AutoReply Plugin",
                body: "Please set your API key in the plugin settings.",
                confirmText: "OK"
            });
            return;
        }

        // Update model options when plugin starts
        updateModelOptions();

        // Add settings change listener to update models when provider changes
        this.previousProvider = settings.store.aiProvider;
        this.settingsCheckInterval = setInterval(() => {
            if (settings.store.aiProvider !== this.previousProvider) {
                this.previousProvider = settings.store.aiProvider;
                updateModelOptions();
            }
        }, 1000);

        this.boundHandleMessage = this.handleMessage.bind(this);
        this.boundHandleChannelSelect = this.handleChannelSelect.bind(this);
        FluxDispatcher?.subscribe?.("MESSAGE_CREATE", this.boundHandleMessage);
        FluxDispatcher?.subscribe?.("CHANNEL_SELECT", this.boundHandleChannelSelect);
        addChatBarButton("autoReply", AutoReplyToggle);
    },

    stop() {
        FluxDispatcher?.unsubscribe?.("MESSAGE_CREATE", this.boundHandleMessage);
        FluxDispatcher?.unsubscribe?.("CHANNEL_SELECT", this.boundHandleChannelSelect);
        removeChatBarButton("autoReply");

        // Clear the settings check interval
        if (this.settingsCheckInterval) {
            clearInterval(this.settingsCheckInterval);
        }

        activeChannelId = null;
    },

    handleChannelSelect(event: any) {
        activeChannelId = event.channelId;
    },

    async handleMessage(message: any) {
        if (!settings.store.enabled || !message?.message?.author?.id ||
            message.message.author.id === window.DiscordNative.crashReporter.getMetadata().user_id ||
            message.channelId !== activeChannelId || !isStarted || deBounce) {
            return;
        }

        deBounce = true;
        try {
            if (settings.store.showTyping) await setTypingStatus(message.channelId, settings.store.showTyping);
            const reply = await generateReply(message.channelId, message.message.content);

            if (/\n\s*\n+/.test(reply)) {
                const parts = reply.split(/\n\s*\n+/);
                for (const part of parts) {
                    if (part.trim() === "") continue;
                    const msg = {
                        content: part,
                        tts: false,
                        invalidEmojis: [],
                        validNonShortcutEmojis: []
                    };
                    if (settings.store.showTyping) await setTypingStatus(message.channelId, settings.store.showTyping);
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + part.length * 40));
                    MessageActions.sendMessage(message.channelId, msg, void 0);
                }
                return;
            }

            const msg = {
                content: reply,
                tts: false,
                invalidEmojis: [],
                validNonShortcutEmojis: []
            };
            if (settings.store.showTyping) await setTypingStatus(message.channelId, settings.store.showTyping);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + reply.length * 40));
            MessageActions.sendMessage(message.channelId, msg, void 0);
        } catch (error) {
            console.error("Failed to generate or send reply:", error);
            if (!this.hasShownError) {
                this.hasShownError = true;
                Alerts.show({
                    title: "AutoReply Error",
                    body: "Failed to generate reply. Please check your API key and try again.",
                    confirmText: "OK"
                });
                setTimeout(() => {
                    this.hasShownError = false;
                }, 1 * 60 * 1000);
            }
        } finally {
            await new Promise(resolve => setTimeout(resolve, settings.store.cooldown * 1000));
            deBounce = false;
        }
    }
});
