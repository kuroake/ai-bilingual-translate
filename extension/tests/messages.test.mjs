/**
 * shared/messages.js 单元测试：消息类型常量与错误码/中文错误文案的完整性。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MSG, CMD, STREAM_PORT, ERR, ERROR_TEXT } from "../src/shared/messages.js";

test("MSG 消息类型与契约一致且唯一", () => {
  const expected = {
    SETTINGS_GET: "ait:settings.get",
    SETTINGS_PATCH: "ait:settings.patch",
    SETTINGS_RESET: "ait:settings.reset",
    TRANSLATE_BATCH: "ait:translate.batch",
    TRANSLATE_TEXT: "ait:translate.text",
    PROVIDER_TEST: "ait:provider.test",
    PROVIDER_MODELS: "ait:provider.models",
    CACHE_STATS: "ait:cache.stats",
    CACHE_CLEAR: "ait:cache.clear",
    STATS_GET: "ait:stats.get",
    STATS_RESET: "ait:stats.reset",
    PAGE_TRANSLATED: "ait:page.translated",
    TAB_PAGE_STATE: "ait:tab.pageState",
  };
  assert.deepEqual(MSG, expected);
  assert.equal(new Set(Object.values(MSG)).size, Object.values(MSG).length);
  for (const value of Object.values(MSG)) assert.match(value, /^ait:[a-z]+\./);
});

test("CMD 命令类型与契约一致且唯一", () => {
  const expected = {
    TOGGLE_TRANSLATE: "ait:cmd.toggleTranslate",
    TOGGLE_MODE: "ait:cmd.toggleMode",
    TRANSLATE_SELECTION: "ait:cmd.translateSelection",
    SET_TARGET_LANG: "ait:cmd.setTargetLang",
    SETTINGS_CHANGED: "ait:cmd.settingsChanged",
  };
  assert.deepEqual(CMD, expected);
  assert.equal(new Set(Object.values(CMD)).size, Object.values(CMD).length);
});

test("流式端口名与契约一致", () => {
  assert.equal(STREAM_PORT, "ait-stream");
});

test("ERR 覆盖契约要求的全部错误码", () => {
  const required = [
    "NO_API_KEY",
    "INVALID_CONFIG",
    "HTTP_401",
    "HTTP_429",
    "HTTP_5XX",
    "TIMEOUT",
    "NETWORK",
    "PARSE",
    "EMPTY_RESPONSE",
    "ABORTED",
  ];
  for (const code of required) {
    assert.equal(typeof ERR[code], "string", "缺少错误码：" + code);
    assert.equal(ERR[code], code);
  }
  assert.equal(new Set(Object.values(ERR)).size, Object.values(ERR).length, "错误码不能重复");
});

test("每个错误码都有可直接展示的中文文案", () => {
  for (const code of Object.values(ERR)) {
    const text = ERROR_TEXT[code];
    assert.equal(typeof text, "string", "缺少错误文案：" + code);
    assert.ok(text.trim().length > 0, "错误文案为空：" + code);
    assert.match(text, /[\u4e00-\u9fff]/, "错误文案应为中文：" + code);
  }
});
