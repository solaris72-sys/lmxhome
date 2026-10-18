import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

// Keys that aren't tied to a workspace need the workspace named on every request
const client = new Anthropic(
  process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } } : {},
);

const RULES = `You keep the top of Taylor Lamoureaux's LMX Home page current. That section is the Direction part of Taylor's Road Map in Obsidian: a main focus, goals, a "Next steps" checklist and "Questions from Claude". Taylor's main focus right now is getting on solid financial ground: more income and lower expenses.

Taylor writes a short update: what got done, what changed, what's on their mind. You answer with a short reply and a list of changes to the Road Map.

How to keep Next steps useful:
- Every open step is something Taylor can do in one sitting, a day at most, and starts with a verb. "Prepare Cloud 9 for sale" is too vague; "Take listing photos of Cloud 9 on a clear day" or "Ask two brokers what Cloud 9 would list for" are right.
- When a step is vague or too big, replace it with the next two to four concrete steps (remove it, then add them), or rename it to the very next action.
- When something needs a plan or strategy (selling the boat, cutting a budget, a job search), add a step like "Work out a sales strategy for Cloud 9 with Claude" and ask the questions you need answered to help, as new questions.
- Tick off ("done") what Taylor says is finished. If it's partly done, add a short progress note instead, and adjust the step to what's left.
- Keep about five to eight open steps, the ones that move the main focus most right now. Drop or merge stale ones.
- Never invent facts, numbers, prices or people. If you need one, ask a question.
- Only touch tasks in the Direction and agenda sections. Copy a task's text exactly, character for character, when you name it in "task".

Writing style: plain and specific. Spell out dates ("October 18, 2026"). No em dashes; use commas, periods or parentheses. The reply is two to four sentences, plain text, no markdown headings.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "changes"],
  properties: {
    reply: { type: "string", description: "Short answer to Taylor: what you changed and why, and anything you'd like them to think about" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "task", "text"],
        properties: {
          action: {
            type: "string",
            enum: ["done", "add", "remove", "rename", "note", "question"],
            description: "done: tick a task. add: new Next steps task. remove: delete a task. rename: rewrite a task. note: progress note under a task. question: a new question for Taylor to answer on the page",
          },
          task: { type: "string", description: 'The existing task, copied exactly (done, remove, rename, note). "" for add and question' },
          text: { type: "string", description: 'The new task (add), new wording (rename), the note (note) or the question (question). "" for done and remove' },
        },
      },
    },
  },
};

export async function planUpdate({ update, top, money, profile, today }) {
  const prompt = [
    `Today is ${today}.`,
    "## The top of the Road Map as it is now",
    top,
    money ? `## Money each month (from Taylor's notes)\n${money}` : "",
    profile ? `## About Taylor\n${profile}` : "",
    "## Taylor's update",
    update,
  ].filter(Boolean).join("\n\n");
  const response = await client.messages
    .stream({
      model: MODEL,
      max_tokens: 16000,
      system: RULES,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    })
    .finalMessage();
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off; try a shorter update");
  return JSON.parse(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
}
