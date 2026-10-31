import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

// Keys that aren't tied to a workspace need the workspace named on every request
const client = new Anthropic(
  process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } } : {},
);

const RULES = `You keep the top of Taylor Lamoureaux's LMX Home page current. That section is the Direction part of Taylor's Road Map in Obsidian: a main focus, goals, a "Top priorities" checklist (shown as a bar across the top of the page) and "Questions from Claude". Below it, every goal has its own headings of tasks. Taylor's main focus right now is getting on solid financial ground: more income and lower expenses.

Taylor writes a short update: what got done, what changed, what's on their mind. You answer with a short reply and a list of changes to the Road Map.

How to keep Top priorities useful:
- At most three open tasks, ever: the three that matter most right now (deadlines, money, the main focus). Everything else belongs under its goal heading.
- When a priority is done, tick it and, if there's room, move up the next most important task from a goal heading ("move" with group "Top priorities"). When a new task is more urgent than one of the three, move the least urgent priority back under its goal heading first.
- New tasks that aren't top priority go straight under the goal heading they belong to ("add" with that heading as group). Copy the heading exactly from the list of headings.
- Every open step is something Taylor can do in one sitting, a day at most, and starts with a verb. "Prepare Cloud 9 for sale" is too vague; "Take listing photos of Cloud 9 on a clear day" or "Ask two brokers what Cloud 9 would list for" are right.
- When a step is vague or too big, replace it with the next two to four concrete steps (remove it, then add them), or rename it to the very next action.
- When something needs a plan or strategy (selling the boat, cutting a budget, a job search), add a step like "Work out a sales strategy for Cloud 9 with Claude" and ask the questions you need answered to help, as new questions.
- Tick off ("done") what Taylor says is finished. If it's partly done, add a short progress note instead, and adjust the step to what's left.
- Drop or merge stale and duplicate tasks.
- Never invent facts, numbers, prices or people. If you need one, ask a question.
- Notes are dated automatically; don't start a note with a date.
- Use Taylor's accomplishments to set the priorities: build on momentum, don't repeat what's done, and notice what's been stalled.
- You may change tasks anywhere in this road map, but only the ones listed below, and keep upkeep and archive sections as they are.

Accomplishments: list every concrete thing Taylor says they did (applied for a job, fixed something on the boat, called the insurer), one short past-tense line each, in Taylor's terms ("Applied for Stage Technician at Tait", "Replaced Cloud 9's bilge pump switch"). Include things that also tick off a task. Leave out plans and things not yet done. Don't repeat ones already in the list. Copy a task's text exactly, character for character, when you name it in "task".

Writing style: plain and specific. Spell out dates ("October 18, 2026"). No em dashes; use commas, periods or parentheses. The reply is two to four sentences, plain text, no markdown headings.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "accomplishments", "changes"],
  properties: {
    accomplishments: { type: "array", items: { type: "string" }, description: "Things Taylor did, one short past-tense line each. Empty if none" },
    reply: { type: "string", description: "Short answer to Taylor: what you changed and why, and anything you'd like them to think about" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "task", "text", "group"],
        properties: {
          action: {
            type: "string",
            enum: ["done", "add", "remove", "rename", "note", "question", "move"],
            description: "done: tick a task. add: new task under group. move: move a task (with its notes) under group. remove: delete a task. rename: rewrite a task. note: progress note under a task. question: a new question for Taylor to answer on the page",
          },
          task: { type: "string", description: 'The existing task, copied exactly (done, remove, rename, note, move). "" for add and question' },
          text: { type: "string", description: 'The new task (add), new wording (rename), the note (note) or the question (question). "" for done, remove and move' },
          group: { type: "string", description: 'For add and move: the heading it goes under, copied exactly ("Top priorities" or a goal heading). "" otherwise' },
        },
      },
    },
  },
};

export async function planUpdate({ update, top, goals, money, profile, wins, today }) {
  const prompt = [
    `Today is ${today}.`,
    "## The top of the Road Map as it is now",
    top,
    goals ? `## Open tasks under each goal heading (heading, then its tasks)\n${goals}` : "",
    wins ? `## Taylor's recent accomplishments\n${wins}` : "",
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
