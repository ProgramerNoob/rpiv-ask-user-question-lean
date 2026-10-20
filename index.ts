import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "@juicesharp/rpiv-ask-user-question";
import { registerStrings, scope } from "@juicesharp/rpiv-i18n";
const COLLAPSED_DISPLAY_SERVICE = Symbol.for(
	"@local/pi-collapsed-tools.display-service.v1",
);

type CollapsedDisplayTool = { name: string };
type CollapsedDisplayService = {
	readonly version: 1;
	decorate<T extends CollapsedDisplayTool>(tool: T): T;
};

function decorateWithCollapsedDisplay<T extends CollapsedDisplayTool>(tool: T): T {
	const services = globalThis as unknown as Record<PropertyKey, unknown>;
	const candidate = services[COLLAPSED_DISPLAY_SERVICE];
	if (!candidate || typeof candidate !== "object") return tool;
	const service = candidate as Partial<CollapsedDisplayService>;
	return service.version === 1 && typeof service.decorate === "function"
		? service.decorate(tool)
		: tool;
}

const TOOL_DESCRIPTION =
	"Ask 1-4 structured questions when a required user decision is unclear.";

const PROMPT_SNIPPET = "";

const PROMPT_GUIDELINES = [
	"ask_user_question: Each question needs 2-4 options. Put recommendations first with (Recommended); never add Other or Type something. Use multiSelect only for nonexclusive choices and preview only for useful single-select visual comparisons.",
];

// RPC hosts such as Codex cannot display previews, so the model is told not to send them there.
const RPC_PROMPT_GUIDELINES = [
	"ask_user_question: Each question needs 2-4 options. Put recommendations first with (Recommended); never add Other or Type something. Use multiSelect only for nonexclusive choices. Never use preview; this host cannot display it.",
];

// Mirrors upstream tool/types.ts MAX_HEADER_LENGTH (not exported); a test pins it to the real schema.
const MAX_HEADER_LENGTH = 16;
const QUESTION_KEYS = ["question", "header", "options", "multiSelect"] as const;

type Args = Record<string, unknown>;
type Prepare = (args: unknown) => unknown;

const isRecord = (value: unknown): value is Args =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A display-only chip derived from the question text, cut on whole characters. */
function deriveHeader(question: string): string {
	let header = "";
	for (const char of question.replace(/\s+/g, " ").trim()) {
		if (header.length + char.length > MAX_HEADER_LENGTH) break;
		header += char;
	}
	return header.trimEnd();
}

// Model mistakes repaired before validation: a lone question flattened to the top
// level, header/options left beside a one-item `questions`, and a missing header.
// Nothing is guessed for several questions and no existing value is overwritten.
function prepareAskArguments(args: unknown, upstream: Prepare): unknown {
	const decoded = upstream(args);
	if (!isRecord(decoded)) return decoded;
	let top: Args = decoded;
	let questions = top.questions;
	const pick = (item: Args): Args => {
		const moved: Args = {};
		for (const key of QUESTION_KEYS) {
			if (item[key] === undefined && top[key] !== undefined) moved[key] = top[key];
		}
		if (Object.keys(moved).length === 0) return item;
		top = Object.fromEntries(Object.entries(top).filter(([key]) => !(key in moved)));
		return { ...item, ...moved };
	};
	if (questions === undefined && typeof top.question === "string") {
		questions = [pick({})];
	} else if (Array.isArray(questions) && questions.length === 1 && isRecord(questions[0])) {
		questions = [pick(questions[0])];
	}
	if (Array.isArray(questions)) {
		questions = questions.map((item) =>
			isRecord(item) && item.header === undefined && typeof item.question === "string" && deriveHeader(item.question)
				? { ...item, header: deriveHeader(item.question) }
				: item,
		);
	}
	return upstream(questions === decoded.questions ? top : { ...top, questions });
}

function removeSchemaDescriptions(value: unknown, seen = new Set<object>()): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);

	const record = value as Record<string, unknown>;
	delete record.description;
	for (const [key, child] of Object.entries(record)) {
		if (key === "properties" && child !== null && typeof child === "object") {
			for (const propertySchema of Object.values(child as Record<string, unknown>)) {
				removeSchemaDescriptions(propertySchema, seen);
			}
			continue;
		}
		removeSchemaDescriptions(child, seen);
	}
}

// RPC hosts (codexhost/Codex Desktop, ACP clients) only offer one flat card at a
// time: a single-line title plus single-choice string rows. Upstream's RPC
// fallback walks questions strictly forward, folds previews into the title and
// lists multi-select options inside a text-input title — all invisible in
// Codex. In RPC mode the wrapper runs its own card flow (back navigation,
// review, multi-select toggles) on upstream's first dialog call,
// i.e. after upstream validation, then replays the collected answers into
// upstream's walker so upstream still builds the tool result.
const t = scope("@juicesharp/rpiv-ask-user-question");
const LEAN_NAMESPACE = "@ssk_dev/rpiv-ask-user-question-lean";
registerStrings(LEAN_NAMESPACE, {
	zh: { back: "上一题" },
});
const lt = scope(LEAN_NAMESPACE);

type DialogOptions = { signal?: AbortSignal };
type DialogUI = {
	select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
};
type Option = { label: string; description?: string };
type Question = { question: string; header?: string; multiSelect?: boolean; options: Option[] };
type Answer = { picked: number[]; custom: string };
type Reply = (rows?: string[]) => string;

const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, " ").replace(/\r/g, "");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const headed = (q: Question) => `${q.header ? `[${q.header}] ` : ""}${oneLine(q.question)}`;

async function askQuestion(
	ui: DialogUI,
	q: Question,
	index: number,
	total: number,
	draft: Answer,
	opts?: DialogOptions,
): Promise<{ back: boolean } | undefined> {
	const title = `${total > 1 ? `(${index + 1}/${total}) ` : ""}${headed(q)}`;
	const picked = new Set(draft.picked);
	let custom = draft.custom;
	// The draft is updated in place so navigation keeps unsubmitted toggles, like the TUI tabs.
	const save = (back: boolean) => {
		draft.picked = [...picked].sort((a, b) => a - b);
		draft.custom = custom;
		return { back };
	};
	for (;;) {
		if (opts?.signal?.aborted) return undefined;
		const rows = q.options.map((o, i) => {
			const mark = q.multiSelect ? (picked.has(i) ? "☑" : "☐") : picked.has(i) ? "◉" : "○";
			return `${mark} ${i + 1}. ${oneLine(o.label)}${o.description ? ` — ${oneLine(o.description)}` : ""}`;
		});
		const done = q.multiSelect
			? `✔ ${total > 1 ? t("sentinel.next", "Next") : t("submit.label", "Submit answers")} (${picked.size})`
			: undefined;
		const other = `✎ ${t("sentinel.other", "Type something.")}${custom ? ` — ${oneLine(custom)}` : ""}`;
		const back = index > 0 ? `← ${lt("back", "Previous question")}` : "";
		const list = [...rows, other, done ?? "", back].filter((row) => row.length > 0);
		const chosen = await ui.select(title, list, opts);
		if (chosen == null) return undefined;
		if (back && chosen === back) return save(true);
		if (chosen === done) return save(false);

		const choice = rows.indexOf(chosen);
		if (choice < 0) {
			// The custom row, or a host that accepts typed replies in place of a pick.
			const typed =
				chosen === other
					? await ui.input(`${title} — ${t("rpc.custom_answer_title", "Type your answer:")}`, custom, opts)
					: chosen;
			if (typed == null) continue;
			custom = typed.trim();
			if (!q.multiSelect && custom) {
				picked.clear();
				return save(false);
			}
			continue;
		}
		if (!q.multiSelect) {
			picked.clear();
			picked.add(choice);
			custom = "";
			return save(false);
		}
		if (!picked.delete(choice)) picked.add(choice);
	}
}

function summarize(q: Question, a: Answer): string {
	const parts = a.picked.map((i) => oneLine(q.options[i].label));
	if (a.custom) parts.push(oneLine(a.custom));
	return parts.length > 0 ? parts.join(", ") : "—";
}

/** The whole questionnaire, or `undefined` when the user dismissed a card. */
async function runCards(ui: DialogUI, questions: Question[], opts?: DialogOptions): Promise<Answer[] | undefined> {
	const answers: Answer[] = questions.map(() => ({ picked: [], custom: "" }));
	const answered = questions.map(() => false);
	let position = 0;
	for (;;) {
		if (opts?.signal?.aborted) return undefined;
		if (position < questions.length) {
			const result = await askQuestion(ui, questions[position], position, questions.length, answers[position], opts);
			if (result === undefined) return undefined;
			if (result.back) {
				position--;
				continue;
			}
			answered[position] = true;
			const next = answered.indexOf(false);
			position = next >= 0 ? next : questions.length;
			continue;
		}
		if (questions.length === 1) return answers;
		const submit = `✔ ${t("submit.label", "Submit answers")}`;
		const rows = questions.map(
			(q, i) => `${i + 1}. ${clip(headed(q), 60)} → ${summarize(q, answers[i])}`,
		);
		const chosen = await ui.select(t("review.heading", "Review your answers"), [submit, ...rows], opts);
		if (chosen == null) return undefined;
		if (chosen === submit) return answers;
		const row = rows.indexOf(chosen);
		if (row >= 0) position = row;
	}
}

/** The replies upstream's sequential walker expects, one per select/input call. */
function repliesFor(questions: Question[], answers: Answer[]): Reply[] {
	return questions.flatMap((q, i): Reply[] => {
		const { picked, custom } = answers[i];
		if (q.multiSelect) {
			const numbers = picked.map((n) => n + 1).join(",");
			return [() => (custom ? `${numbers}; ${custom}` : numbers)];
		}
		if (picked.length > 0) return [(rows) => rows?.[picked[0]] ?? ""];
		// Upstream's "Type something." row is last; its follow-up input takes the text.
		return [(rows) => rows?.[rows.length - 1] ?? "", () => custom];
	});
}

function withRpcCards<C extends { mode?: string; ui: DialogUI }>(ctx: C, params: unknown, signal?: AbortSignal): C {
	if (ctx.mode !== "rpc") return ctx;
	const questions = (params as { questions?: Question[] }).questions ?? [];
	let replies: Promise<Reply[] | undefined> | undefined;
	const reply = async (rows?: string[]) => {
		replies ??= runCards(ctx.ui, questions, signal ? { signal } : undefined).then(
			(answers) => answers && repliesFor(questions, answers),
		);
		return (await replies)?.shift()?.(rows);
	};
	const ui = new Proxy(ctx.ui, {
		get(target, property) {
			if (property === "select") return (_title: string, rows: string[]) => reply(rows);
			if (property === "input") return () => reply();
			const member = Reflect.get(target, property, target);
			return typeof member === "function" ? member.bind(target) : member;
		},
	});
	return new Proxy(ctx, {
		get(target, property) {
			if (property === "ui") return ui;
			const member = Reflect.get(target, property, target);
			return typeof member === "function" ? member.bind(target) : member;
		},
	});
}

export default function (pi: ExtensionAPI): void {
	const leanPi = new Proxy(pi, {
		get(target, property) {
			if (property === "registerTool") {
				return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
					if (tool.name === "ask_user_question") {
						removeSchemaDescriptions(tool.parameters);
						return target.registerTool(decorateWithCollapsedDisplay({
							...tool,
							description: TOOL_DESCRIPTION,
							promptSnippet: PROMPT_SNIPPET,
							promptGuidelines: PROMPT_GUIDELINES,
							prepareArguments: (args: unknown) =>
								prepareAskArguments(args, (value) => tool.prepareArguments?.(value as never) ?? value) as never,
							execute: (id, params, signal, onUpdate, ctx) =>
								tool.execute(id, params, signal, onUpdate, withRpcCards(ctx, params, signal)),
						}));
					}
					return target.registerTool(decorateWithCollapsedDisplay(tool));
				};
			}

			const member = Reflect.get(target, property, target);
			return typeof member === "function" ? member.bind(target) : member;
		},
	});

	askUserQuestion(leanPi);
	pi.on("before_agent_start", (event, ctx) => {
		// Pi >= 1.x exposes per-tool guidelines here; older peers keep the default text.
		const options = event.systemPromptOptions as { toolGuidelines?: Record<string, string[]> };
		const guidelines = options.toolGuidelines;
		if ((ctx as { mode?: string }).mode === "rpc" && guidelines?.ask_user_question) {
			guidelines.ask_user_question = RPC_PROMPT_GUIDELINES;
		}
	});
}
