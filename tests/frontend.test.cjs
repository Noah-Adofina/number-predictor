const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function setup(fetchImpl = async () => ({ ok: true, json: async () => ({ prediction: 7 }) })) {
  const elements = Object.fromEntries(["canvas", "predict", "clear", "retry", "result-panel", "digit", "status", "keyboard-cursor"].map((id) => [id, {
    dataset: {}, style: {}, hidden: false, disabled: false, textContent: "", attributes: {}, listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    fire(name, event = {}) { this.listeners[name]?.(event); },
  }]));
  const canvas = elements.canvas;
  canvas.width = canvas.height = 320;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 160 });
  canvas.setPointerCapture = () => {};
  canvas.toBlob = (callback) => callback(new Blob(["png"], { type: "image/png" }));
  const operations = [];
  const ctx = {
    fillRect(...args) { operations.push(["fill", ...args]); },
    arc(...args) { operations.push(["arc", ...args]); },
    stroke() { operations.push(["stroke"]); },
    fill() {}, beginPath() {}, moveTo() {}, lineTo() {},
  };
  canvas.getContext = () => ctx;
  let timerId = 0;
  const timers = new Map();
  const context = {
    document: { querySelector: (selector) => elements[selector.slice(1)] },
    window: { location: { hostname: "localhost" } },
    Blob, FormData, AbortController, console,
    fetch: fetchImpl,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../frontend/script.js"), "utf8"), context);
  const pointer = (name, x = 40, y = 40) => canvas.fire(name, { pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
  const tick = (delay) => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } };
  return { elements, operations, pointer, tick };
}

async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("drawing scales pointer coordinates, enables prediction, and clear resets it", () => {
  const app = setup();
  assert.equal(app.elements.predict.disabled, true);
  app.pointer("pointerdown", 40, 40);
  assert.equal(app.elements.predict.disabled, false);
  assert.ok(app.operations.some(([name, x, y]) => name === "arc" && x === 80 && y === 80));
  app.elements.clear.fire("click");
  assert.equal(app.elements.predict.disabled, true);
  assert.equal(app.elements.digit.textContent, "—");
});

test("request uploads PNG, blocks duplicates, and shows a valid prediction", async () => {
  let calls = 0;
  let resolveResponse;
  const app = setup((url, options) => {
    calls++;
    assert.equal(url, "http://localhost:8000/predict");
    assert.equal(options.body.get("file").type, "image/png");
    return new Promise((resolve) => { resolveResponse = resolve; });
  });
  app.pointer("pointerdown");
  app.elements.predict.fire("click");
  app.elements.predict.fire("click");
  await settle();
  assert.equal(calls, 1);
  assert.equal(app.elements.predict.disabled, true);
  app.tick(6000);
  assert.match(app.elements.status.textContent, /waking up/);
  resolveResponse({ ok: true, json: async () => ({ prediction: 7 }) });
  await settle();
  assert.equal(app.elements.digit.textContent, "7");
  assert.equal(app.elements.predict.disabled, false);
});

test("invalid response offers retry and retry recovers", async () => {
  let calls = 0;
  const app = setup(async () => ({ ok: true, json: async () => ({ prediction: ++calls === 1 ? "bad" : 3 }) }));
  app.pointer("pointerdown");
  app.elements.predict.fire("click");
  await settle();
  assert.equal(app.elements["result-panel"].dataset.state, "error");
  assert.equal(app.elements.retry.hidden, false);
  app.elements.retry.fire("click");
  await settle();
  assert.equal(app.elements.digit.textContent, "3");
  assert.equal(app.elements.retry.hidden, true);
});

test("clear invalidates an in-flight response", async () => {
  let resolveResponse;
  const app = setup(() => new Promise((resolve) => { resolveResponse = resolve; }));
  app.pointer("pointerdown");
  app.elements.predict.fire("click");
  await settle();
  app.elements.clear.fire("click");
  resolveResponse({ ok: true, json: async () => ({ prediction: 8 }) });
  await settle();
  assert.equal(app.elements.digit.textContent, "—");
  assert.equal(app.elements.predict.disabled, true);
});

test("timeout produces a retryable error", async () => {
  const app = setup((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  app.pointer("pointerdown");
  app.elements.predict.fire("click");
  await settle();
  app.tick(75000);
  await settle();
  assert.match(app.elements.status.textContent, /timed out/);
  assert.equal(app.elements.retry.hidden, false);
  assert.equal(app.elements.predict.disabled, false);
});

test("HTTP errors and invalid JSON recover with a retry option", async () => {
  for (const response of [
    { ok: false, status: 503 },
    { ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } },
  ]) {
    const app = setup(async () => response);
    app.pointer("pointerdown");
    app.elements.predict.fire("click");
    await settle();
    assert.equal(app.elements["result-panel"].dataset.state, "error");
    assert.equal(app.elements.retry.hidden, false);
    assert.equal(app.elements.predict.disabled, false);
  }
});

test("redrawing invalidates an in-flight result and keyboard drawing enables prediction", async () => {
  let resolveResponse;
  const app = setup(() => new Promise((resolve) => { resolveResponse = resolve; }));
  app.elements.canvas.fire("keydown", { code: "Space", key: " ", preventDefault() {} });
  app.elements.canvas.fire("keydown", { code: "ArrowRight", key: "ArrowRight", shiftKey: false, preventDefault() {} });
  app.elements.canvas.fire("keyup", { code: "Space" });
  assert.equal(app.elements.predict.disabled, false);
  assert.ok(app.operations.some(([name]) => name === "stroke"));
  app.elements.predict.fire("click");
  await settle();
  app.pointer("pointerdown");
  resolveResponse({ ok: true, json: async () => ({ prediction: 4 }) });
  await settle();
  assert.equal(app.elements.digit.textContent, "—");
  assert.equal(app.elements.predict.disabled, false);
});
