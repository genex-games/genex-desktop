/**
 * `s`: the schemas a game's `ask` answers are held to, written as code. Each builder returns a
 * plain JSON schema of the closed dialect genex.games and Studio share (`shared/game-ai-schema.ts`:
 * no `$ref`, `pattern`, `anyOf` or `format`, every object closed, at most five deep), carrying the
 * TypeScript type of the values it admits, so `ask({ schema })` answers are typed. A builder never
 * throws: a schema the dialect refuses is refused at the call (`invalid_schema`), with the reason
 * `ai.schemaCheck` gives the builder agent.
 */
import { AiSchemaType, type AiOutputSchema } from "../../shared/game-ai-schema.ts";

/**
 * A schema of the dialect that admits values of type `T`. The type rides on a property that is
 * never present at run time (a string key, so the template's own declaration of `genex-ai` names
 * the very same type).
 */
export type Schema<T = unknown> = AiOutputSchema & { readonly "~admits"?: T };

/** The type of value a schema admits. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** An object schema's properties, by name. */
export type Shape = Readonly<Record<string, Schema>>;

/** The values an object schema with `P` admits. */
export type InferShape<P extends Shape> = { [K in keyof P]: Infer<P[K]> };

/** A string's bounds and annotation. */
export interface StringOptions {
  /** The longest the string may be, in characters: bound every string a model writes. */
  max?: number;
  min?: number;
  description?: string;
}

/** A schema with its description, when one was given. */
function described<S extends AiOutputSchema>(schema: S, description: string | undefined): S {
  return description === undefined ? schema : { ...schema, description };
}

/** A schema typed as admitting `T`: the builders' one widening, a type the JSON already enforces. */
const admits = <T>(schema: AiOutputSchema): Schema<T> => schema;

function string(options: StringOptions = {}): Schema<string> {
  const bounds = {
    ...(options.min === undefined ? {} : { minLength: options.min }),
    ...(options.max === undefined ? {} : { maxLength: options.max }),
  };
  return admits(described({ type: AiSchemaType.String, ...bounds }, options.description));
}

function int(min: number, max: number, description?: string): Schema<number> {
  return admits(described({ type: AiSchemaType.Integer, minimum: min, maximum: max }, description));
}

function number(min: number, max: number, description?: string): Schema<number> {
  return admits(described({ type: AiSchemaType.Number, minimum: min, maximum: max }, description));
}

function bool(description?: string): Schema<boolean> {
  return admits(described({ type: AiSchemaType.Boolean }, description));
}

function oneOf<const V extends readonly string[]>(values: V, description?: string): Schema<V[number]> {
  return admits(described({ type: AiSchemaType.String, enum: [...values] }, description));
}

function list<S extends Schema>(item: S, max: number, min?: number): Schema<Infer<S>[]> {
  const bounds = min === undefined ? { maxItems: max } : { minItems: min, maxItems: max };
  return admits({ type: AiSchemaType.Array, items: item, ...bounds });
}

function object<P extends Shape>(properties: P, description?: string): Schema<InferShape<P>> {
  const schema: AiOutputSchema = {
    type: AiSchemaType.Object,
    properties: { ...properties },
    required: Object.keys(properties),
    additionalProperties: false,
  };
  return admits(described(schema, description));
}

function describe<S extends Schema>(schema: S, description: string): S {
  return { ...schema, description };
}

/** The schema builders. */
export const s = {
  /** Text, bounded by `max` characters. */
  string,
  /** A whole number from `min` to `max`. */
  int,
  /** A number from `min` to `max`. */
  number,
  bool,
  /** One of a fixed list of words (ids the game shipped, actions it knows). */
  oneOf,
  /** A list of `item`, at most `max` long. */
  list,
  /** An object with exactly these properties, every one required. */
  object,
  /** The same schema with a description the model reads. */
  describe,
} as const;
