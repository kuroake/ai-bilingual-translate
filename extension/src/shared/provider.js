/**
 * OpenAI 兼容 Chat Completions 客户端。
 * 只允许在 background 中调用（绕过 CORS、保护 API Key）。
 */
import { chatCompletionsUrl, modelsUrl } from "./config.js";
import { ERR, ERROR_TEXT } from "./messages.js";

export class ProviderError extends Error {
  constructor(code, message, status) {
    super(message || ERROR_TEXT[code] || ERROR_TEXT.HTTP_ERROR);
    this.name = "ProviderError";
    this.code = code || ERR.INTERNAL;
    this.status = Number(status) || 0;
  }
}

export function buildHeaders(apiKey, extraHeaders) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (key && value !== undefined && value !== null) headers[key] = String(value);
    }
  }
  return headers;
}

async function readErrorBody(res) {
  try {
    const raw = await res.text();
    if (!raw) return "";
    try {
      const json = JSON.parse(raw);
      return String((json && json.error && json.error.message) || json.message || json.error || "").slice(0, 300);
    } catch (_) {
      return raw.slice(0, 300);
    }
  } catch (_) {
    return "";
  }
}

async function httpError(res) {
  const detail = await readErrorBody(res);
  let code = ERR.HTTP_ERROR;
  if (res.status === 401 || res.status === 403) code = ERR.HTTP_401;
  else if (res.status === 429) code = ERR.HTTP_429;
  else if (res.status >= 500) code = ERR.HTTP_5XX;
  const base = ERROR_TEXT[code] || ERROR_TEXT.HTTP_ERROR;
  return new ProviderError(code, detail ? base + "（" + detail + "）" : base, res.status);
}

function timeoutSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 60000));
  let stopExternal = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      const onAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onAbort);
      stopExternal = () => externalSignal.removeEventListener("abort", onAbort);
    }
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (stopExternal) stopExternal();
    },
  };
}

function mapFetchError(error) {
  if (error && error.name === "AbortError") return new ProviderError(ERR.TIMEOUT, ERROR_TEXT.TIMEOUT);
  if (error && error.name === "TypeError") return new ProviderError(ERR.NETWORK, ERROR_TEXT.NETWORK);
  if (error instanceof ProviderError) return error;
  return new ProviderError(ERR.NETWORK, (error && error.message) || ERROR_TEXT.NETWORK);
}

function normalizeContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : part && part.text ? part.text : "")).join("");
  }
  return "";
}

function extractUsage(json) {
  const usage = (json && json.usage) || {};
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
  return { tokensIn: prompt, tokensOut: completion };
}

export function buildPayload(settings, messages, stream, overrides) {
  const provider = (settings && settings.provider) || {};
  const payload = {
    model: provider.model,
    messages,
    temperature: Number(provider.temperature),
    stream: !!stream,
  };
  if (!Number.isFinite(payload.temperature)) payload.temperature = 0.2;
  const maxTokens = Number(provider.maxTokens);
  if (maxTokens > 0) payload.max_tokens = maxTokens;
  if (overrides && overrides.maxTokens) payload.max_tokens = overrides.maxTokens;
  return payload;
}

/**
 * 发送一次对话请求。stream 为 true 时通过 onDelta 回调增量。
 */
export async function chatCompletion(options) {
  const settings = options.settings || {};
  const provider = settings.provider || {};
  const url = chatCompletionsUrl(provider.baseUrl);
  if (!url) throw new ProviderError(ERR.INVALID_CONFIG, ERROR_TEXT.INVALID_CONFIG);
  if (!provider.apiKey) throw new ProviderError(ERR.NO_API_KEY, ERROR_TEXT.NO_API_KEY);
  if (!provider.model) throw new ProviderError(ERR.INVALID_CONFIG, "还没有填写模型名称。");

  const stream = !!(options.stream && provider.stream !== false);
  const payload = buildPayload(settings, options.messages, stream, options.overrides);
  const guard = timeoutSignal(provider.timeoutMs, options.signal);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(provider.apiKey, provider.extraHeaders),
      body: JSON.stringify(payload),
      signal: guard.signal,
    });
  } catch (error) {
    guard.cleanup();
    throw mapFetchError(error);
  }

  if (!res.ok) {
    const error = await httpError(res);
    guard.cleanup();
    throw error;
  }

  try {
    if (stream) {
      return await readStream(res, options.onDelta, guard);
    }
    const json = await res.json();
    const choice = (json.choices && json.choices[0]) || {};
    const message = choice.message || {};
    const content = normalizeContent(message.content).trim();
    const reasoning = normalizeContent(message.reasoning_content || message.reasoning).trim();
    const usage = extractUsage(json);
    if (!content) throw new ProviderError(ERR.EMPTY_RESPONSE, ERROR_TEXT.EMPTY_RESPONSE);
    return { content, reasoning, usage };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error && error.name === "AbortError") throw new ProviderError(ERR.TIMEOUT, ERROR_TEXT.TIMEOUT);
    throw new ProviderError(ERR.PARSE, ERROR_TEXT.PARSE);
  } finally {
    guard.cleanup();
  }
}

async function readStream(res, onDelta, guard) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const json = await res.json();
    const choice = (json.choices && json.choices[0]) || {};
    const content = normalizeContent((choice.message || {}).content).trim();
    if (!content) throw new ProviderError(ERR.EMPTY_RESPONSE, ERROR_TEXT.EMPTY_RESPONSE);
    return { content, reasoning: "", usage: extractUsage(json) };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage = { tokensIn: 0, tokensOut: 0 };
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        done = true;
        break;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch (_) {
        continue;
      }
      const choice = (json.choices && json.choices[0]) || {};
      const delta = choice.delta || choice.message || {};
      const piece = normalizeContent(delta.content);
      const think = normalizeContent(delta.reasoning_content || delta.reasoning);
      if (piece) {
        content += piece;
        if (onDelta) onDelta({ delta: piece, content, reasoning });
      }
      if (think) {
        reasoning += think;
        if (onDelta) onDelta({ delta: "", content, reasoning });
      }
      if (json.usage) usage = extractUsage(json);
    }
  }
  guard.cleanup();
  content = content.trim();
  if (!content) throw new ProviderError(ERR.EMPTY_RESPONSE, ERROR_TEXT.EMPTY_RESPONSE);
  return { content, reasoning: reasoning.trim(), usage };
}

/** 拉取模型列表 */
export async function listModels(options) {
  const provider = options.provider || {};
  const url = modelsUrl(options.baseUrl || provider.baseUrl);
  if (!url) throw new ProviderError(ERR.INVALID_CONFIG, ERROR_TEXT.INVALID_CONFIG);
  if (!(options.apiKey || provider.apiKey)) throw new ProviderError(ERR.NO_API_KEY, ERROR_TEXT.NO_API_KEY);
  const guard = timeoutSignal(20000, null);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(options.apiKey || provider.apiKey, provider.extraHeaders),
      signal: guard.signal,
    });
    if (!res.ok) throw await httpError(res);
    const json = await res.json();
    const list = (json && (json.data || json.models)) || [];
    const models = list
      .map((item) => (typeof item === "string" ? item : item && (item.id || item.name)))
      .filter((item) => typeof item === "string" && item.length > 0);
    return { models, count: models.length };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw mapFetchError(error);
  } finally {
    guard.cleanup();
  }
}
