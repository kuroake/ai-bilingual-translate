/**
 * shared/provider.js 单元测试（mock 全局 fetch，不发起真实网络请求）。
 * 覆盖：URL 规范化、请求体/请求头、401/403/429/5xx/400 错误映射、
 *       网络错误与中断映射、非流式解析、SSE 分块解析、模型列表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderError,
  buildHeaders,
  buildPayload,
  chatCompletion,
  listModels,
} from "../src/shared/provider.js";
import { ERR, ERROR_TEXT } from "../src/shared/messages.js";

const originalFetch = globalThis.fetch;

function makeSettings(overrides) {
  const provider = {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 0,
    timeoutMs: 30000,
    stream: false,
    extraHeaders: {},
  };
  const settings = { provider };
  if (overrides && overrides.provider) Object.assign(provider, overrides.provider);
  return settings;
}

function jsonResponse(body, options) {
  const opts = options || {};
  const status = opts.status === undefined ? 200 : opts.status;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    async text() {
      return text;
    },
    async json() {
      if (opts.jsonError) throw opts.jsonError;
      return JSON.parse(text);
    },
  };
}

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;
  return {
    ok: true,
    status: 200,
    async json() {
      throw new Error("流式响应不应该走 json");
    },
    async text() {
      return "";
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= queue.length) return { done: true, value: undefined };
            const value = queue[index];
            index += 1;
            return { done: false, value };
          },
        };
      },
    },
  };
}

/** 打开 fetch mock，返回调用记录与 restore；务必在 finally 中 restore */
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const record = { url: String(url), options: options || {} };
    calls.push(record);
    return handler(record, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function captureError(task) {
  try {
    await task();
  } catch (error) {
    return error;
  }
  assert.fail("期望抛出错误，但任务成功返回");
}

function assertProviderError(error, code) {
  assert.ok(error instanceof ProviderError, "应为 ProviderError，实际：" + error);
  assert.equal(error.code, code);
  assert.equal(typeof error.message, "string");
  assert.ok(error.message.length > 0);
}

// ---------------------------------------------------------------- 请求构造

test("buildHeaders 带鉴权头并合并 extraHeaders", () => {
  const headers = buildHeaders("sk-abc", { "X-Foo": "bar", Empty: undefined, Nil: null });
  assert.equal(headers.Authorization, "Bearer sk-abc");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Accept, "application/json");
  assert.equal(headers["X-Foo"], "bar");
  assert.equal("Empty" in headers, false);
  assert.equal("Nil" in headers, false);
});

test("buildHeaders 无 apiKey 时不带 Authorization", () => {
  const headers = buildHeaders("", null);
  assert.equal("Authorization" in headers, false);
});

test("buildPayload 控制 temperature / max_tokens / stream_options", () => {
  const messages = [{ role: "user", content: "hi" }];
  const plain = buildPayload(makeSettings(), messages, false);
  assert.equal(plain.model, "deepseek-chat");
  assert.equal(plain.temperature, 0.2);
  assert.equal(plain.stream, false);
  assert.equal("max_tokens" in plain, false);
  assert.equal("stream_options" in plain, false);

  const withMax = buildPayload(makeSettings({ provider: { maxTokens: 1024 } }), messages, false);
  assert.equal(withMax.max_tokens, 1024);

  const overridden = buildPayload(makeSettings({ provider: { maxTokens: 1024 } }), messages, false, {
    maxTokens: 24,
  });
  assert.equal(overridden.max_tokens, 24);

  const streamed = buildPayload(makeSettings(), messages, true);
  assert.equal(streamed.stream, true);
  // 注意：provider 不强制发送 stream_options（部分 OpenAI 兼容服务不认该字段），
  // 缺席时 background 会退化为估算 token，见 docs/TESTING.md 已知限制。

  const badTemp = buildPayload(makeSettings({ provider: { temperature: "abc" } }), messages, false);
  assert.equal(badTemp.temperature, 0.2);
});

test("chatCompletion 请求 URL、方法与鉴权头符合契约", async () => {
  const mock = installFetch(() => jsonResponse({ choices: [{ message: { content: "正常" } }] }));
  try {
    const result = await chatCompletion({
      settings: makeSettings(),
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.content, "正常");
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(mock.calls[0].options.method, "POST");
    assert.equal(mock.calls[0].options.headers.Authorization, "Bearer sk-test");
    const body = JSON.parse(mock.calls[0].options.body);
    assert.equal(body.model, "deepseek-chat");
    assert.equal(body.stream, false);
  } finally {
    mock.restore();
  }
});

test("chatCompletion 在 Key 缺失/模型缺失/Base URL 缺失时提前报错且不请求网络", async () => {
  let fetchCalled = false;
  const mock = installFetch(() => {
    fetchCalled = true;
    return jsonResponse({});
  });
  try {
    const noKey = await captureError(() =>
      chatCompletion({ settings: makeSettings({ provider: { apiKey: "" } }), messages: [] })
    );
    assertProviderError(noKey, ERR.NO_API_KEY);
    assert.equal(noKey.message, ERROR_TEXT.NO_API_KEY);

    const noModel = await captureError(() =>
      chatCompletion({ settings: makeSettings({ provider: { model: "" } }), messages: [] })
    );
    assertProviderError(noModel, ERR.INVALID_CONFIG);

    const noBase = await captureError(() =>
      chatCompletion({ settings: makeSettings({ provider: { baseUrl: "" } }), messages: [] })
    );
    assertProviderError(noBase, ERR.INVALID_CONFIG);

    assert.equal(fetchCalled, false);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- HTTP 错误映射

test("HTTP 401 / 403 映射为 HTTP_401 并附带服务端错误详情", async () => {
  for (const status of [401, 403]) {
    const mock = installFetch(() =>
      jsonResponse({ error: { message: "Invalid API key" } }, { status })
    );
    try {
      const error = await captureError(() =>
        chatCompletion({ settings: makeSettings(), messages: [] })
      );
      assertProviderError(error, ERR.HTTP_401);
      assert.equal(error.status, status);
      assert.match(error.message, /鉴权失败/);
      assert.match(error.message, /Invalid API key/);
    } finally {
      mock.restore();
    }
  }
});

test("HTTP 429 映射为 HTTP_429 且提示限流", async () => {
  const mock = installFetch(() => jsonResponse({ error: { message: "rate limited" } }, { status: 429 }));
  try {
    const error = await captureError(() => chatCompletion({ settings: makeSettings(), messages: [] }));
    assertProviderError(error, ERR.HTTP_429);
    assert.match(error.message, /429/);
  } finally {
    mock.restore();
  }
});

test("HTTP 5xx 映射为 HTTP_5XX", async () => {
  for (const status of [500, 502, 503]) {
    const mock = installFetch(() => jsonResponse("upstream error", { status }));
    try {
      const error = await captureError(() => chatCompletion({ settings: makeSettings(), messages: [] }));
      assertProviderError(error, ERR.HTTP_5XX);
      assert.equal(error.status, status);
    } finally {
      mock.restore();
    }
  }
});

test("其他 4xx 映射为 HTTP_ERROR", async () => {
  const mock = installFetch(() => jsonResponse({ message: "bad request" }, { status: 400 }));
  try {
    const error = await captureError(() => chatCompletion({ settings: makeSettings(), messages: [] }));
    assertProviderError(error, ERR.HTTP_ERROR);
    assert.match(error.message, /bad request/);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- 非流式解析

test("非流式响应解析 content / reasoning / usage", async () => {
  const mock = installFetch(() =>
    jsonResponse({
      choices: [
        {
          message: {
            content: "  你好  ",
            reasoning_content: "  想一想  ",
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    })
  );
  try {
    const result = await chatCompletion({ settings: makeSettings(), messages: [] });
    assert.equal(result.content, "你好");
    assert.equal(result.reasoning, "想一想");
    assert.deepEqual(result.usage, { tokensIn: 11, tokensOut: 7 });
  } finally {
    mock.restore();
  }
});

test("非流式兼容数组形式的 content 以及 input/output tokens 字段", async () => {
  const mock = installFetch(() =>
    jsonResponse({
      choices: [{ message: { content: [{ type: "text", text: "你" }, { text: "好" }, "！"] } }],
      usage: { input_tokens: 3, output_tokens: 2 },
    })
  );
  try {
    const result = await chatCompletion({ settings: makeSettings(), messages: [] });
    assert.equal(result.content, "你好！");
    assert.deepEqual(result.usage, { tokensIn: 3, tokensOut: 2 });
  } finally {
    mock.restore();
  }
});

test("非流式空内容映射为 EMPTY_RESPONSE", async () => {
  const mock = installFetch(() => jsonResponse({ choices: [{ message: { content: "   " } }] }));
  try {
    const error = await captureError(() => chatCompletion({ settings: makeSettings(), messages: [] }));
    assertProviderError(error, ERR.EMPTY_RESPONSE);
  } finally {
    mock.restore();
  }
});

test("非流式 JSON 解析失败映射为 PARSE", async () => {
  const mock = installFetch(() =>
    jsonResponse("not-json", { jsonError: new SyntaxError("Unexpected token") })
  );
  try {
    const error = await captureError(() => chatCompletion({ settings: makeSettings(), messages: [] }));
    assertProviderError(error, ERR.PARSE);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- 流式解析

test("SSE 流式响应跨 chunk 分块解析、累积内容与 usage", async () => {
  const sse =
    ": keep-alive\n\n" +
    'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n' +
    "data: [DONE]\n\n";
  // 故意在 JSON 中间切开，验证 SSE 行缓冲
  const pieces = [sse.slice(0, 41), sse.slice(41, 97), sse.slice(97, 173), sse.slice(173)];
  assert.equal(pieces.join(""), sse);

  const deltas = [];
  const mock = installFetch(() => streamResponse(pieces));
  try {
    const result = await chatCompletion({
      settings: makeSettings({ provider: { stream: true } }),
      messages: [],
      stream: true,
      onDelta: (delta) => deltas.push(delta),
    });
    assert.equal(result.content, "你好世界");
    assert.equal(result.reasoning, "想一想");
    assert.deepEqual(result.usage, { tokensIn: 7, tokensOut: 3 });
    const visible = deltas.filter((delta) => delta.delta);
    assert.deepEqual(visible.map((delta) => delta.content), ["你", "你好", "你好世界"]);
    assert.deepEqual(visible.map((delta) => delta.delta), ["你", "好", "世界"]);
    assert.equal(deltas[0].reasoning, "想一想");
  } finally {
    mock.restore();
  }
});

test("流式响应无 body 时回退为整体 JSON 解析", async () => {
  const mock = installFetch(() =>
    jsonResponse({ choices: [{ message: { content: "整体译文" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } })
  );
  try {
    const result = await chatCompletion({
      settings: makeSettings({ provider: { stream: true } }),
      messages: [],
      stream: true,
    });
    assert.equal(result.content, "整体译文");
    assert.deepEqual(result.usage, { tokensIn: 1, tokensOut: 2 });
  } finally {
    mock.restore();
  }
});

test("流式响应只有思考内容没有正文时映射为 EMPTY_RESPONSE", async () => {
  const sse =
    'data: {"choices":[{"delta":{"reasoning_content":"只有思考"}}]}\n\n' + "data: [DONE]\n\n";
  const mock = installFetch(() => streamResponse([sse]));
  try {
    const error = await captureError(() =>
      chatCompletion({
        settings: makeSettings({ provider: { stream: true } }),
        messages: [],
        stream: true,
      })
    );
    assertProviderError(error, ERR.EMPTY_RESPONSE);
  } finally {
    mock.restore();
  }
});

test("流式响应遇到坏 JSON 行会跳过而不中断", async () => {
  const sse =
    "data: {bad json}\n\n" +
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
    "data: [DONE]\n\n";
  const mock = installFetch(() => streamResponse([sse]));
  try {
    const result = await chatCompletion({
      settings: makeSettings({ provider: { stream: true } }),
      messages: [],
      stream: true,
    });
    assert.equal(result.content, "好");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- 网络与中断

test("fetch 抛 TypeError 映射为 NETWORK", async () => {
  const mock = installFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const error = await captureError(() => chatCompletion({ settings: makeSettings(), messages: [] }));
    assertProviderError(error, ERR.NETWORK);
    assert.equal(error.message, ERROR_TEXT.NETWORK);
  } finally {
    mock.restore();
  }
});

test("fetch 抛 AbortError 映射为 TIMEOUT", async () => {
  const mock = installFetch(() => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  });
  try {
    const error = await captureError(() => chatCompletion({ settings: makeSettings(), messages: [] }));
    assertProviderError(error, ERR.TIMEOUT);
  } finally {
    mock.restore();
  }
});

test("外部 AbortSignal 已中断时请求被立即取消并映射为 TIMEOUT", async () => {
  const controller = new AbortController();
  controller.abort();
  let observedAborted = false;
  const mock = installFetch((record) => {
    if (record.options.signal && record.options.signal.aborted) {
      observedAborted = true;
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return jsonResponse({ choices: [{ message: { content: "不应到这里" } }] });
  });
  try {
    const error = await captureError(() =>
      chatCompletion({ settings: makeSettings(), messages: [], signal: controller.signal })
    );
    assertProviderError(error, ERR.TIMEOUT);
    assert.equal(observedAborted, true);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------- 模型列表

test("listModels 解析 data 数组（对象与字符串混合）", async () => {
  const mock = installFetch(() =>
    jsonResponse({ data: [{ id: "model-a" }, { id: "model-b" }, "model-c", { nope: true }] })
  );
  try {
    const result = await listModels({ provider: makeSettings().provider });
    assert.deepEqual(result.models, ["model-a", "model-b", "model-c"]);
    assert.equal(result.count, 3);
    assert.equal(mock.calls[0].url, "https://api.deepseek.com/v1/models");
    assert.equal(mock.calls[0].options.method, "GET");
    assert.equal(mock.calls[0].options.headers.Authorization, "Bearer sk-test");
  } finally {
    mock.restore();
  }
});

test("listModels 兼容 models 数组与 name 字段", async () => {
  const mock = installFetch(() => jsonResponse({ models: [{ name: "qwen2.5:7b" }] }));
  try {
    const result = await listModels({ provider: makeSettings().provider });
    assert.deepEqual(result.models, ["qwen2.5:7b"]);
  } finally {
    mock.restore();
  }
});

test("listModels 空列表返回空数组", async () => {
  const mock = installFetch(() => jsonResponse({ data: [] }));
  try {
    const result = await listModels({ provider: makeSettings().provider });
    assert.deepEqual(result.models, []);
    assert.equal(result.count, 0);
  } finally {
    mock.restore();
  }
});

test("listModels 在 Key 缺失时提前报错", async () => {
  const mock = installFetch(() => jsonResponse({}));
  try {
    const error = await captureError(() =>
      listModels({ provider: makeSettings({ provider: { apiKey: "" } }).provider })
    );
    assertProviderError(error, ERR.NO_API_KEY);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("listModels 透传 HTTP 401 与网络错误", async () => {
  let mock = installFetch(() => jsonResponse({ error: { message: "unauthorized" } }, { status: 401 }));
  try {
    const error = await captureError(() => listModels({ provider: makeSettings().provider }));
    assertProviderError(error, ERR.HTTP_401);
  } finally {
    mock.restore();
  }

  mock = installFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const error = await captureError(() => listModels({ provider: makeSettings().provider }));
    assertProviderError(error, ERR.NETWORK);
  } finally {
    mock.restore();
  }
});

test("ProviderError 默认信息取中文错误文案", () => {
  const error = new ProviderError(ERR.HTTP_429);
  assert.equal(error.message, ERROR_TEXT.HTTP_429);
  assert.equal(error.code, ERR.HTTP_429);
  assert.equal(error.status, 0);
  const fallback = new ProviderError();
  assert.equal(fallback.code, ERR.INTERNAL);
  assert.equal(fallback.message, ERROR_TEXT.HTTP_ERROR);
});
