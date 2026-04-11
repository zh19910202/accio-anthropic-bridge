"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const log = require("./logger");
const { normalizeRequestedModel } = require("./model");
const { delay, errMsg } = require("./utils");

class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

class AccioClient {
  constructor(config) {
    this.config = config;
  }

  isRetriableError(error) {
    if (!error) {
      return false;
    }

    if (error instanceof HttpError) {
      return error.status === 429 || error.status >= 500;
    }

    const message = String(error.message || error);
    return /timed out|ECONNREFUSED|ECONNRESET|closed before the request finished/i.test(
      message
    );
  }

  async requestJson(pathname, init = {}) {
    const response = await fetch(`${this.config.baseUrl}${pathname}`, init);
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const parsed =
      contentType.includes("application/json") && text ? JSON.parse(text) : text;

    if (!response.ok) {
      throw new HttpError(
        response.status,
        `Accio request failed: ${response.status} ${response.statusText}`,
        parsed
      );
    }

    return parsed;
  }

  async getAuthStatus() {
    return this.requestJson("/auth/status");
  }

  async getAuthDebugStatus() {
    return this.requestJson("/debug/auth/status");
  }

  async createConversation(name) {
    return this.requestJson("/conversation", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name,
        type: "dm",
        agentId: this.config.agentId
      })
    });
  }

  getConversationLogDirectory() {
    if (!this.config.accountId) {
      return null;
    }

    return path.join(
      this.config.accioHome,
      "accounts",
      this.config.accountId,
      "conversations",
      "dm"
    );
  }

  async getConversationLogDirectories() {
    const directories = [];
    const primary = this.getConversationLogDirectory();

    if (primary) {
      directories.push(primary);
    }

    try {
      const accountsRoot = path.join(this.config.accioHome, "accounts");
      const entries = await fsp.readdir(accountsRoot, { withFileTypes: true });
      const accountIds = entries
        .filter((entry) => entry.isDirectory() && entry.name !== "guest")
        .map((entry) => entry.name);

      for (const accountId of accountIds) {
        const directory = path.join(
          accountsRoot,
          accountId,
          "conversations",
          "dm"
        );

        if (!directories.includes(directory)) {
          directories.push(directory);
        }
      }
    } catch (error) {
      log.debug("conversation log directory scan failed", {
        accountsRoot: path.join(this.config.accioHome, "accounts"),
        error: errMsg(error)
      });
    }

    return directories;
  }

  async readConversationMessages(conversationId) {
    const messages = [];

    for (const directory of await this.getConversationLogDirectories()) {
      try {
        const allFiles = await fsp.readdir(directory);
        const files = allFiles
          .filter(
            (file) =>
              file.startsWith(`${conversationId}.message_`) && file.endsWith(".jsonl")
          )
          .sort();

        for (const file of files) {
          const filePath = path.join(directory, file);
          const content = await fsp.readFile(filePath, "utf8");
          const lines = content.split("\n");

          for (const line of lines) {
            const trimmed = line.trim();

            if (!trimmed) {
              continue;
            }

            try {
              messages.push(JSON.parse(trimmed));
            } catch (error) {
              log.debug("conversation message parse failed", {
                conversationId,
                filePath,
                error: errMsg(error)
              });
            }
          }
        }
      } catch (error) {
        log.debug("conversation log read failed", {
          conversationId,
          directory,
          error: errMsg(error)
        });
      }
    }

    return messages;
  }

  async collectConversationArtifacts(conversationId) {
    if (!conversationId) {
      return {
        messageId: null,
        toolCalls: [],
        toolResults: []
      };
    }

    const messages = await this.readConversationMessages(conversationId);
    const lastRequestIndex = [...messages]
      .map((message, index) => ({ index, message }))
      .filter((entry) => entry.message && entry.message.role === "req")
      .map((entry) => entry.index)
      .pop();
    const turnMessages =
      typeof lastRequestIndex === "number" ? messages.slice(lastRequestIndex + 1) : messages;
    const toolCalls = [];
    const seenToolCalls = new Set();
    const toolResults = turnMessages
      .filter(
        (message) =>
          message &&
          message.role === "tool" &&
          message.tool_call_id
      )
      .map((message) => ({
        tool_use_id: message.tool_call_id,
        name: message.name || "unknown",
        content: message.content || "",
        is_error: Boolean(message.metadata && message.metadata.is_error)
      }));

    for (const message of turnMessages) {
      if (
        !message ||
        message.role !== "res" ||
        !Array.isArray(message.tool_calls)
      ) {
        continue;
      }

      for (const toolCall of message.tool_calls) {
        if (!toolCall || !toolCall.name || seenToolCalls.has(toolCall.id)) {
          continue;
        }

        seenToolCalls.add(toolCall.id);
        toolCalls.push({
          id: toolCall.id || `tool_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
          name: toolCall.name,
          input: toolCall.arguments || toolCall.input || {}
        });
      }
    }

    const resolvedMessageId =
      [...turnMessages]
        .reverse()
        .find((message) => message && message.role === "res" && message.messageId)
        ?.messageId || null;

    return {
      messageId: resolvedMessageId,
      toolCalls,
      toolResults
    };
  }

  buildSource() {
    return {
      platform: this.config.sourcePlatform,
      type: this.config.sourceType,
      channelId: this.config.sourceChannelId,
      chatId: this.config.sourceChatId,
      userId: this.config.sourceUserId,
      chatType: this.config.sourceChatType,
      isAuthorized: true,
      wasMentioned: false
    };
  }

  buildSendQueryPayload(input) {
    const requestedModel = normalizeRequestedModel(input.model);

    return {
      type: "req",
      method: "sendQuery",
      params: {
        conversationId: input.conversationId,
        chatType: "direct",
        question: {
          query: input.query
        },
        path: input.workspacePath || this.config.workspacePath,
        agentId: this.config.agentId,
        targetAgentList: [
          {
            agentId: this.config.agentId,
            isTL: true
          }
        ],
        skills: [],
        language: this.config.language,
        ts: Date.now(),
        extra: {},
        source: this.buildSource(),
        ...(requestedModel ? { model: requestedModel } : {}),
        atIds: []
      }
    };
  }

  async runQuery(input) {
    const conversationId = input.conversationId;
    const clientId = `${this.config.clientIdPrefix}-${crypto.randomUUID()}`;
    const payload = this.buildSendQueryPayload({
      conversationId,
      query: input.query,
      workspacePath: input.workspacePath,
      model: input.model
    });
    const wsUrl =
      this.config.baseUrl.replace(/^http/, "ws") +
      `/websocket/connect?clientId=${encodeURIComponent(clientId)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const state = {
        ack: null,
        appendEvents: [],
        channelResponse: null,
        finalMessage: null,
        finalText: "",
        messageId: null,
        textSnapshot: "",
        uniqueId: null
      };

      let settled = false;
      let finishTimer = null;
      const timeout = setTimeout(() => {
        finalize(new Error(`Accio request timed out after ${this.config.requestTimeoutMs}ms`));
      }, this.config.requestTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(finishTimer);

        try {
          ws.close();
        } catch (error) {
          log.debug("websocket close failed", {
            error: errMsg(error)
          });
        }
      };

      const finalize = (error, result) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      };

      const maybeScheduleFinish = () => {
        if (!state.finalMessage) {
          return;
        }

        clearTimeout(finishTimer);
        finishTimer = setTimeout(() => {
          finalize(null, {
            ack: state.ack,
            channelResponse: state.channelResponse,
            finalMessage: state.finalMessage,
            finalText: state.finalText,
            messageId: state.messageId,
            uniqueId: state.uniqueId
          });
        }, 150);
      };

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify(payload));
      });

      ws.addEventListener("error", (event) => {
        finalize(new Error(event.message || "Accio WebSocket error"));
      });

      ws.addEventListener("close", () => {
        if (!settled && !state.finalMessage) {
          finalize(new Error("Accio WebSocket closed before the request finished"));
        }
      });

      ws.addEventListener("message", (event) => {
        let message;

        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          finalize(error);
          return;
        }

        if (message.type === "ack") {
          state.ack = message.payload;
          state.messageId = message.payload && message.payload.messageId;
          state.uniqueId = message.payload && message.payload.uniqueId;

          if (typeof input.onEvent === "function") {
            input.onEvent({
              type: "ack",
              payload: message.payload
            });
          }

          return;
        }

        if (message.type === "event" && message.method === "append") {
          const nextSnapshot = (message.payload && message.payload.content) || "";
          let delta = nextSnapshot;

          if (nextSnapshot.startsWith(state.textSnapshot)) {
            delta = nextSnapshot.slice(state.textSnapshot.length);
          }

          state.textSnapshot = nextSnapshot;
          state.appendEvents.push(message.payload);

          if (typeof input.onEvent === "function") {
            input.onEvent({
              type: "append",
              payload: message.payload,
              delta
            });
          }

          return;
        }

        if (message.type === "event" && message.method === "finished") {
          state.finalMessage = message.payload;
          state.finalText = (message.payload && message.payload.content) || state.textSnapshot;
          state.messageId = state.messageId || (message.payload && message.payload.messageId);
          state.uniqueId = state.uniqueId || (message.payload && message.payload.uniqueId);

          if (typeof input.onEvent === "function") {
            input.onEvent({
              type: "finished",
              payload: message.payload
            });
          }

          maybeScheduleFinish();
          return;
        }

        if (
          message.type === "channel.message.created" &&
          message.data &&
          message.data.conversationId === conversationId &&
          message.data.role === "res"
        ) {
          state.channelResponse = message.data;

          if (typeof input.onEvent === "function") {
            input.onEvent({
              type: "channel.message.created",
              payload: message.data
            });
          }

          if (state.finalMessage) {
            clearTimeout(finishTimer);
            finalize(null, {
              ack: state.ack,
              channelResponse: state.channelResponse,
              finalMessage: state.finalMessage,
              finalText: state.finalText || message.data.content || "",
              messageId: state.messageId,
              uniqueId: state.uniqueId
            });
          }
        }
      });
    });
  }

  async executeQuery(input) {
    const maxAttempts = Math.max(1, Number(this.config.maxRetries || 0) + 1);
    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        let conversationId = input.conversationId;

        if (!conversationId) {
          const title = (input.title || input.query || "Bridge Request").slice(0, 48);
          const created = await this.createConversation(title);
          conversationId = created.data.id;
        }

        const result = await this.runQuery({
          conversationId,
          model: input.model,
          onEvent: input.onEvent,
          query: input.query,
          workspacePath: input.workspacePath
        });

        return {
          ...result,
          conversationId,
          ...(await this.collectConversationArtifacts(conversationId))
        };
      } catch (error) {
        lastError = error;

        if (!this.isRetriableError(error) || attempt >= maxAttempts) {
          throw error;
        }

        const backoffMs = Math.min(
          this.config.retryBaseMs * 2 ** (attempt - 1),
          this.config.retryMaxDelayMs
        );
        await delay(backoffMs);
      }
    }

    throw lastError;
  }
}

module.exports = {
  AccioClient,
  HttpError,
  delay
};
