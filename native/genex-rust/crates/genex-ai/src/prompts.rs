//! The words genex-ai puts around a game's own prompt, word for word the web SDK's
//! (`src/page/ai/compile-prompts.ts`): how a judge call and an act call are asked. The same call
//! from a Rust game and a web game carries the same text, so a saved playtest's key is the same.

/// The system text of a judge call: classify, never write.
pub const JUDGE_SYSTEM: &str = "You are the referee of a game. You read the game's state and answer the questions about it.\nAnswer only the questions asked, in the JSON shape given. Write no prose.";

/// How a question with named options is answered.
pub const CHOICE_ANSWER_WORDS: &str = "the name of exactly one option";

/// The line an act prompt ends with.
const ACT_PICK: &str = "Pick exactly one of these tools and fill in its arguments:";
/// How an act answer is laid out.
const ACT_SHAPE: &str = "Put the tool's name in \"tool\" and its arguments under its own name. Fill the other tools' arguments with any valid values: they are ignored.";

/// One question as the judge prompt lists it.
pub(crate) struct PromptQuestion<'a> {
    pub name: &'a str,
    pub instructions: &'a str,
    /// How the answer is given, in words.
    pub answer: String,
    /// The options or levels, one per line, when the question has them.
    pub options: Vec<String>,
}

/// How a yes-or-no question is answered, with what yes and no mean when the game said.
pub(crate) fn yes_no_answer_words(sides: Option<(&str, &str)>) -> String {
    let named = sides.map_or(String::new(), |(yes, no)| format!(" (yes: {yes}; no: {no})"));
    format!("a probability from 0 to 1 that the answer is yes{named}")
}

/// How a question on a scale of `levels` levels is answered.
pub(crate) fn score_answer_words(levels: usize) -> String {
    format!("the level's number, from 0 (the lowest) to {} (the highest)", levels.saturating_sub(1))
}

/// The prompt of a judge call: the game's own words, the questions, then the state.
pub(crate) fn judge_prompt(questions: &[PromptQuestion<'_>], state: &str, extra: Option<&str>) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(extra) = extra {
        lines.push(extra.to_owned());
        lines.push(String::new());
    }
    lines.push("Questions:".to_owned());
    for question in questions {
        let mut asked = vec![
            format!("- {}: {}", question.name, question.instructions),
            format!("  Answer with {}.", question.answer),
        ];
        asked.extend(question.options.iter().map(|option| format!("  {option}")));
        lines.push(asked.join("\n"));
    }
    lines.push(String::new());
    lines.push("The game's state, as JSON:".to_owned());
    lines.push(state.to_owned());
    lines.join("\n")
}

/// The text an act call sends: the game's prompt, the tools, and how to pick one.
pub(crate) fn act_prompt(prompt: &str, tools: &[(&str, &str)]) -> String {
    let mut lines = vec![prompt.to_owned(), String::new(), ACT_PICK.to_owned()];
    lines.extend(tools.iter().map(|(name, description)| format!("- {name}: {description}")));
    lines.push(ACT_SHAPE.to_owned());
    lines.join("\n")
}
