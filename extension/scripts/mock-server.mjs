#!/usr/bin/env node
/**
 * 本地 OpenAI 兼容 mock 服务，用于在不消耗真实 API 额度的情况下验证扩展全链路。
 *
 * 用法：
 *   node extension/scripts/mock-server.mjs            # 默认 http://127.0.0.1:8787
 *   PORT=9000 node extension/scripts/mock-server.mjs
 *
 * 在扩展设置里填：
 *   Base URL: http://127.0.0.1:8787/v1
 *   API Key:  any（填 mock 即可）
 *   模型:     mock-translator
 *
 * 行为：把 "[n] 原文" 变成 "[n] 【译】原文"，流式逐字返回，便于观察打字机效果。
 * 特殊：API Key 为 bad 时返回 401；模型名含 slow 时每块延迟 90ms。
 */
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const MODELS = ["mock-translator", "mock-fast", "mock-slow", "deepseek-chat", "gpt-4o-mini"];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function translateBatch(userContent) {
  const lines = String(userContent || "").split("\n");
  const segments = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s?([\s\S]*)$/);
    if (match) {
      if (current) segments.push(current);
      current = { index: match[1], text: match[2] };
    } else if (current) {
      current.text += "\n" + line;
    }
  }
  if (current) segments.push(current);
  if (!segments.length) {
    return { segments: [], content: "【译】" + String(userContent || "").slice(0, 200) };
  }
  const content = segments
    .map((segment) => {
      const text = segment.text.trim();
      const translated = /[\u4e00-\u9fff]/.test(text) ? "【译】" + text : "【译】" + text;
      return "[" + segment.index + "] " + translated;
    })
    .join("\n");
  return { segments, content };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

async function handleChat(req, res) {
  const auth = String(req.headers.authorization || "");
  if (auth.indexOf("bad") >= 0) {
    sendJson(res, 401, { error: { message: "Invalid API key (mock)", type: "invalid_request_error" } });
    return;
  }
  const raw = await readBody(req);
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch (_) {
    sendJson(res, 400, { error: { message: "Invalid JSON body (mock)" } });
    return;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const userMessage = messages.filter((item) => item.role === "user").pop();
  const userContent = userMessage ? String(userMessage.content || "") : "";
  console.log("[mock] chat " + (payload.stream ? "stream" : "json") + " model=" + (payload.model || "?") + " chars=" + userContent.length);
  const result = translateBatch(userContent);
  const model = payload.model || "mock-translator";
  const slow = String(model).indexOf("slow") >= 0;
  const usage = { prompt_tokens: Math.ceil(userContent.length / 3), completion_tokens: Math.ceil(result.content.length / 2), total_tokens: 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  if (!payload.stream) {
    sendJson(res, 200, {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }],
      usage: usage,
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const pieces = result.content.match(/[\s\S]{1,6}/g) || [""];
  const delay = slow ? 90 : 12;
  let index = 0;
  const timer = setInterval(() => {
    if (index >= pieces.length) {
      clearInterval(timer);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const chunk = {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: index === pieces.length - 1 ? "stop" : null }],
    };
    res.write("data: " + JSON.stringify(chunk) + "\n\n");
    index += 1;
  }, delay);
  req.on("close", () => clearInterval(timer));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://" + HOST + ":" + PORT);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, models: MODELS });
    return;
  }
  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    sendJson(res, 200, { object: "list", data: MODELS.map((id) => ({ id: id, object: "model", owned_by: "mock" })) });
    return;
  }
  if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
    try {
      await handleChat(req, res);
    } catch (error) {
      sendJson(res, 500, { error: { message: String(error && error.message) } });
    }
    return;
  }
  sendJson(res, 404, { error: { message: "Not found (mock)" } });
});

server.listen(PORT, HOST, () => {
  console.log("mock OpenAI server: http://" + HOST + ":" + PORT + "/v1");
  console.log("Base URL 填 http://" + HOST + ":" + PORT + "/v1，API Key 任意，模型 mock-translator");
});
