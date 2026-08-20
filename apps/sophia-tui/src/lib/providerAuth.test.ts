import test from "node:test";
import assert from "node:assert/strict";

import {
  browserLoginProviderForModel,
  formatProviderLoginEvent,
} from "./providerAuth.js";

test("grok model specs map to the grok browser login", () => {
  assert.equal(browserLoginProviderForModel("grok"), "grok");
  assert.equal(browserLoginProviderForModel("grok-cli"), "grok");
  assert.equal(browserLoginProviderForModel("mock"), null);
  assert.equal(browserLoginProviderForModel("omlx"), null);
});

test("login event text never includes a token-shaped span", () => {
  const text = formatProviderLoginEvent({
    status: "complete",
    label: "Grok (xAI subscription)",
    provider: "grok",
    detail: "sign-in finished",
    urls: ["https://auth.x.ai/oauth"],
  });
  assert.match(text, /Grok/);
  assert.match(text, /https:\/\/auth\.x\.ai\/oauth/);
  assert.doesNotMatch(text, /sk-/);
});
