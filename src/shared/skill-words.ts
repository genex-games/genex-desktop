/** Plain names for the harness's instruction files, for people who never read them. */
const SKILLS: Record<string, string> = {
  "facet-decomposition": "how Harness plans a build",
  director: "how Harness leads a build",
  "rust-extension-ladder": "how Harness reaches past a Rust game's engine",
};

export function skillWords(skill: string | undefined): string {
  const slug = (skill ?? "").replace(/^skills\//, "").replace(/\.md$/, "");
  return SKILLS[slug] ?? (slug ? `Harness's ${slug.replace(/[-_]+/g, " ")} instructions` : "Harness's instructions");
}

/** A proposal's own plain title when the proposer wrote one; older proposals name what they change. */
export function proposalTitle(proposal: { title?: string; skill?: string }): string {
  return proposal.title?.trim() || `Change ${skillWords(proposal.skill)}`;
}

export function changeTitle(change: { title?: string; skill?: string; file?: string }): string {
  return change.title?.trim() || `Changed ${skillWords(change.skill || change.file)}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
