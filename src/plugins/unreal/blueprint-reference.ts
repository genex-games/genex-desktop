/**
 * The Blueprint node reference: every node type id the user's own engine offers in a graph, by the
 * Blueprint's base class and the graph's kind, plus the pins of the nodes looked up so far. The
 * Genex editor helper exports the names in seconds (`export_reference`); pins cost about 0.1 s of
 * editor time per node, so they are read only for nodes a builder uses and then kept. Project
 * Blueprints add their own nodes (variable getters and setters, function calls, casts), described
 * by each Blueprint's declaration so a part can be checked before it exists in the editor.
 */

/** The base classes the reference covers; a Blueprint is checked against the nearest one. */
export const BaseClass = {
  Actor: "Actor",
  Character: "Character",
  Pawn: "Pawn",
  ActorComponent: "ActorComponent",
  SceneComponent: "SceneComponent",
  HUD: "HUD",
  GameModeBase: "GameModeBase",
  PlayerController: "PlayerController",
  UserWidget: "UserWidget",
  AnimInstance: "AnimInstance",
} as const;
export type BaseClass = (typeof BaseClass)[keyof typeof BaseClass];

/** Where nodes are placed: the event graph or a function graph (also the construction script). */
export const GraphKind = { Event: "EventGraph", Function: "Function" } as const;
export type GraphKind = (typeof GraphKind)[keyof typeof GraphKind];

/** A pin as Epic's NodeInfo names it: its name and its type's display string (`Exec` for flow). */
export type PinRef = readonly [name: string, type: string];
/** A node's pins in Epic's order. */
export type NodePins = { inputs: PinRef[]; outputs: PinRef[] };

/** The exported reference file. `contexts` holds each context's names beyond `common`. */
export type ReferenceData = {
  version: 1;
  engine: string;
  common: string[];
  contexts: Partial<Record<string, string[]>>;
  pins: Record<string, NodePins>;
};

/** The pin type Epic gives execution pins. */
export const EXEC_PIN = "Exec";

export const contextKey = (base: BaseClass, graph: GraphKind) => `${base}/${graph}`;

/** One project Blueprint, as its part declares it (or as the editor exported it). */
export type BlueprintDecl = {
  name: string;
  base: BaseClass;
  variables: { name: string; type?: string; category?: string }[];
  components: { name: string; class?: string }[];
  functions: { name: string; inputs?: string[]; outputs?: string[] }[];
};

/** A node the checker found: its type id as the editor spells it, and its pins when known. */
export type FoundNode = { typeId: string; pins?: NodePins };

/** What a checker asks of the reference. */
export type NodeLookup = {
  find(typeId: string): FoundNode | undefined;
  /** Every type id in this context, for "did you mean". */
  names(): readonly string[];
  /**
   * Whether a node or event the reference doesn't have may still exist: one inherited from a
   * game's C++ class, which the reference can't see. It is then unverified, never an error.
   */
  unverifiable?(typeId: string): boolean;
};

const lower = (text: string) => text.toLowerCase();
const exec = (name: string): PinRef => [name, EXEC_PIN];

/**
 * Unreal's display name for an object name (FName::NameToDisplayString, simplified): underscores
 * become spaces and a capital after a lower-case letter starts a new word.
 */
export function displayName(name: string): string {
  return name
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The category Epic gives a Blueprint class's members in other graphs: `Class|<display name without spaces>`. */
export const classCategory = (blueprint: string) => `Class|${displayName(blueprint).replaceAll(" ", "")}`;

/** Nodes a Blueprint's declaration adds inside its own graphs. */
function ownNodes(decl: BlueprintDecl): [string, NodePins][] {
  const nodes: [string, NodePins][] = [];
  for (const variable of decl.variables) {
    const category = `Variables|${variable.category ?? "Default"}`;
    const type = variable.type ?? "";
    nodes.push([`${category}|Get${variable.name}`, { inputs: [], outputs: [[variable.name, type]] }]);
    nodes.push([
      `${category}|Set${variable.name}`,
      { inputs: [exec("execute"), [variable.name, type]], outputs: [exec("then"), ["Output_Get", type]] },
    ]);
  }
  for (const component of decl.components) {
    nodes.push([
      `Variables|Default|Get${component.name}`,
      { inputs: [], outputs: [[component.name, component.class ?? ""]] },
    ]);
  }
  for (const fn of decl.functions) nodes.push([`CallFunction|${fn.name}`, callPins(fn, decl.name)]);
  return nodes;
}

function callPins(fn: BlueprintDecl["functions"][number], owner: string): NodePins {
  const inputs: PinRef[] = [exec("execute"), ["self", owner], ...(fn.inputs ?? []).map((name): PinRef => [name, ""])];
  return { inputs, outputs: [exec("then"), ...(fn.outputs ?? []).map((name): PinRef => [name, ""])] };
}

/** The cast to a project Blueprint, which any graph (its own too) can place. */
const castNode = (decl: BlueprintDecl): [string, NodePins] => [
  `Utilities|Casting|CastTo${decl.name}`,
  {
    inputs: [exec("execute"), ["Object", "Object"]],
    outputs: [exec("then"), exec("CastFailed"), [`As ${displayName(decl.name)}`, decl.name]],
  },
];

/** Nodes any graph gets for another project Blueprint: its members through a reference, and a cast. */
function memberNodes(decl: BlueprintDecl): [string, NodePins][] {
  const category = classCategory(decl.name);
  const self: PinRef = ["self", decl.name];
  const nodes: [string, NodePins][] = [castNode(decl)];
  for (const variable of [...decl.variables, ...decl.components.map((c) => ({ name: c.name, type: c.class }))]) {
    const type = variable.type ?? "";
    nodes.push([`${category}|Get${variable.name}`, { inputs: [self], outputs: [[variable.name, type]] }]);
    nodes.push([
      `${category}|Set${variable.name}`,
      { inputs: [exec("execute"), [variable.name, type], self], outputs: [exec("then"), ["Output_Get", type]] },
    ]);
  }
  for (const fn of decl.functions) nodes.push([`${category}|${fn.name}`, callPins(fn, decl.name)]);
  return nodes;
}

/** The nodes any graph gets for these project Blueprints (casts and members), with their pins. */
export const projectNodes = (decls: readonly BlueprintDecl[]): [string, NodePins][] => decls.flatMap(memberNodes);

/** The lookup for one graph: the engine's nodes for its context plus the project's own. */
export function createNodeLookup(
  data: ReferenceData,
  base: BaseClass,
  graph: GraphKind,
  own: BlueprintDecl | undefined,
  others: readonly BlueprintDecl[],
): NodeLookup {
  const byLower = new Map<string, FoundNode>();
  const add = (typeId: string, pins?: NodePins) =>
    byLower.set(lower(typeId), { typeId, pins: pins ?? data.pins[typeId] });
  for (const typeId of data.common) add(typeId);
  for (const typeId of data.contexts[contextKey(base, graph)] ?? []) add(typeId);
  for (const decl of others) for (const [typeId, pins] of memberNodes(decl)) add(typeId, pins);
  if (own) for (const [typeId, pins] of [...ownNodes(own), castNode(own)]) add(typeId, pins);
  let names: string[] | undefined;
  return {
    find: (typeId) => byLower.get(lower(typeId)),
    names: () => {
      names ??= [...byLower.values()].map((node) => node.typeId);
      return names;
    },
  };
}

/** The data input pins of a node: every input but the execution pins. */
export const dataInputs = (pins: NodePins) => pins.inputs.filter(([, type]) => type !== EXEC_PIN);
/** The data output pins of a node. */
export const dataOutputs = (pins: NodePins) => pins.outputs.filter(([, type]) => type !== EXEC_PIN);
/** The execution outputs of a node (then, else, CastFailed, ...). */
export const execOutputs = (pins: NodePins) => pins.outputs.filter(([, type]) => type === EXEC_PIN);
