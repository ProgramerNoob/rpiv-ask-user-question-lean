import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const extension = (await jiti.import("../index.ts")).default;

function createPi() {
  const tools = [];
  const handlers = new Map();
  const noOp = () => undefined;
  return new Proxy(
    {
      tools,
      handlers,
      registerTool(tool) {
        tools.push(tool);
      },
      on(event, handler) {
        const listeners = handlers.get(event) ?? [];
        listeners.push(handler);
        handlers.set(event, listeners);
      },
      getActiveTools: () => [],
      setActiveTools: noOp,
      events: { on: noOp, emit: noOp },
    },
    {
      get(target, property) {
        return property in target ? target[property] : noOp;
      },
    },
  );
}

function findDescriptions(value, path = "$", isPropertiesMap = false) {
  if (value === null || typeof value !== "object") return [];
  const found = !isPropertiesMap && Object.hasOwn(value, "description") ? [`${path}.description`] : [];
  for (const [key, child] of Object.entries(value)) {
    found.push(...findDescriptions(child, `${path}.${key}`, key === "properties"));
  }
  return found;
}

test("registers a compact ask_user_question tool while preserving the safety guidance", () => {
  const pi = createPi();
  extension(pi);

  assert.deepEqual(pi.tools.map((tool) => tool.name), ["ask_user_question"]);
  const tool = pi.tools[0];
  assert.equal(tool.description, "Ask 1-4 structured questions when a required user decision is unclear.");
  assert.equal(tool.promptSnippet, "");
  assert.equal(tool.promptGuidelines.length, 1);
  assert.deepEqual(findDescriptions(tool.parameters), []);
  assert.deepEqual(tool.parameters.required, ["questions"]);
  const question = tool.parameters.properties.questions.items;
  assert.deepEqual(question.required, ["question", "header", "options"]);
  assert.equal(question.properties.multiSelect.type, "boolean");
  assert.equal(question.properties.multiSelect.default, false);
  assert.equal(question.properties.options.minItems, 2);
  assert.equal(question.properties.options.maxItems, 4);
  assert.equal(question.properties.options.items.properties.preview.type, "string");
  assert.equal(pi.handlers.has("before_agent_start"), true);
});

test("keeps the provider-facing metadata within a compact budget", () => {
  const pi = createPi();
  extension(pi);
  const tool = pi.tools[0];
  const metadata = JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
  });

  assert.ok(metadata.length <= 1600, `metadata is ${metadata.length} chars`);
});

function rpcRun(questions, steps, signal) {
  const pi = createPi();
  extension(pi);
  const calls = [];
  const next = (kind, title, payload) => {
    calls.push({ kind, title, payload });
    const step = steps.shift();
    assert.ok(step, `unexpected ${kind}: ${title}`);
    assert.equal(kind, step.kind, `step ${calls.length}: ${title}`);
    return step.answer(payload);
  };
  const ui = {
    async select(title, options) { return next("select", title, options); },
    async input(title, placeholder) { return next("input", title, placeholder); },
    notify() {},
  };
  const ctx = { hasUI: true, mode: "rpc", ui, cwd: process.cwd() };
  return pi.tools[0].execute("id", { questions }, signal, undefined, ctx).then((result) => ({ result, calls, steps }));
}
const pick = (prefix) => ({
  kind: "select",
  answer: (opts) => {
    const row = opts.find((o) => o.startsWith(prefix));
    assert.ok(row, `no row starting with ${prefix}: ${JSON.stringify(opts)}`);
    return row;
  },
});
const typeText = (text) => ({ kind: "input", answer: () => text });
const single = {
  question: "One",
  header: "Single",
  options: [
    { label: "X", description: "x", preview: "line 1\n  indented" },
    { label: "Y", description: "y" },
  ],
};
const multi = {
  question: "Pick some",
  header: "Multi",
  multiSelect: true,
  options: [
    { label: "A", description: "a" },
    { label: "B", description: "b" },
    { label: "C", description: "c" },
  ],
};

test("RPC multi-select uses native toggle rows and keeps custom text until submit", async () => {
  const { result, calls, steps } = await rpcRun([multi], [
    pick("☐ 1."), pick("☐ 3."), pick("☑ 1."), pick("☐ 2."),
    pick("✎"), typeText(undefined), pick("✎"), typeText("  mine; too "), pick("✔"),
  ]);

  assert.equal(steps.length, 0);
  assert.equal(calls[0].title, "[Multi] Pick some");
  assert.deepEqual(calls[0].payload, ["☐ 1. A — a", "☐ 2. B — b", "☐ 3. C — c", "✎ Type something.", "✔ Submit answers (0)"]);
  assert.equal(calls[1].payload[0], "☑ 1. A — a");
  assert.equal(calls[8].payload[3], "✎ Type something. — mine; too");
  assert.deepEqual(result.details.answers[0].selected, ["B", "C"]);
  assert.equal(result.details.answers[0].answer, "mine; too");
  assert.equal(result.details.cancelled, false);
});

test("RPC cards allow going back, reviewing and editing earlier answers", async () => {
  const { result, calls, steps } = await rpcRun([single, multi], [
    pick("○ 2."),            // Q1 → Y
    pick("☐ 1."),            // Q2 toggle A
    pick("←"),               // back to Q1
    pick("○ 1."),            // Q1 → X, Q2 already has no answer so it opens next
    pick("☑ 1."), pick("☐ 3."), pick("✔ Next"),
    pick("1."),              // review: jump to Q1
    pick("✎"), typeText("own"), // Q1 → custom text, back to review
    pick("✔ Submit"),
  ]);

  assert.equal(steps.length, 0);
  assert.equal(calls[0].title, "(1/2) [Single] One");
  assert.equal(calls[1].payload.at(-1), "← Previous question");
  assert.ok(calls[3].payload.includes("◉ 2. Y — y"), "previous answer stays marked after going back");
  assert.equal(calls[4].payload[0], "☑ 1. A — a", "multi-select state survives navigation");
  assert.equal(calls[7].title, "Review your answers");
  assert.deepEqual(calls[7].payload, ["✔ Submit answers", "1. [Single] One → X", "2. [Multi] Pick some → C"]);
  assert.equal(calls[10].payload[1], "1. [Single] One → own");
  assert.equal(result.details.answers[0].kind, "custom");
  assert.equal(result.details.answers[0].answer, "own");
  assert.deepEqual(result.details.answers[1].selected, ["C"]);
});

test("RPC sessions get a prompt guideline without preview", () => {
  const pi = createPi();
  extension(pi);
  const handler = pi.handlers.get("before_agent_start").at(-1);
  const run = (mode) => {
    const event = { systemPromptOptions: { toolGuidelines: { ask_user_question: [...pi.tools[0].promptGuidelines] } } };
    handler(event, { mode });
    return event.systemPromptOptions.toolGuidelines.ask_user_question.join(" ");
  };

  assert.match(run("tui"), /preview only for useful single-select/);
  assert.match(run("rpc"), /Never use preview/);
  assert.doesNotMatch(run("rpc"), /preview only/);
});

test("RPC cards stop after dismissal or abort", async () => {
  const dismissed = await rpcRun([single, multi], [pick("○ 1."), { kind: "select", answer: () => undefined }]);
  assert.equal(dismissed.result.details.cancelled, true);

  const controller = new AbortController();
  const aborted = await rpcRun([multi], [
    { kind: "select", answer: (opts) => { controller.abort(); return opts[0]; } },
  ], controller.signal);
  assert.equal(aborted.steps.length, 0);
  assert.equal(aborted.result.details.cancelled, true);
});
