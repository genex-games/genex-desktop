//! The closed JSON-schema dialect an `ask`, `judge` and `act` answer is held to
//! (`src/shared/game-ai-schema.ts`, genex.games' own): no `$ref`, `pattern`, `anyOf` or `format`;
//! `additionalProperties: false` on every object; depth at most 5, at most 32 properties, enums of
//! 1-32 scalars; the annotations `description` (500) and `title` (100). [`check_schema`] and
//! [`validate_value`] answer exactly as the TypeScript does (the shared fixture holds them).
//!
//! [`SchemaNode`] builds a schema of the dialect; [`Schema`] is a Rust type's own schema, which
//! `#[derive(Schema)]` writes from its fields (and keeps in step with their serde names).

use serde_json::{Map, Number, Value};

use crate::json::{MAX_SAFE_INTEGER, has_words, is_answer_json, js_json, utf16_len};
use crate::wire::{
    AI_MAX_JSON_ARRAY_ITEMS, AI_MAX_OUTPUT_BYTES, AI_SCHEMA_MAX_DEPTH, AI_SCHEMA_MAX_DESCRIPTION, AI_SCHEMA_MAX_ENUM,
    AI_SCHEMA_MAX_ITEMS_BOUND, AI_SCHEMA_MAX_KEY_CHARS, AI_SCHEMA_MAX_PROPERTIES, AI_SCHEMA_MAX_STRING,
    AI_SCHEMA_MAX_TITLE, AiSchemaProblem, AiSchemaType,
};

/// The keywords of the dialect.
const KEYWORDS: [&str; 14] = [
    "type",
    "description",
    "title",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
];
/// Property names a JavaScript reader would copy onto a prototype.
const FORBIDDEN_PROPERTY_NAMES: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// One pair of bounds: its keywords, the types it applies to and, where it counts, its cap.
struct Bound {
    min: &'static str,
    max: &'static str,
    types: &'static [AiSchemaType],
    integer_cap: Option<u64>,
}

const BOUNDS: [Bound; 3] = [
    Bound { min: "minimum", max: "maximum", types: &[AiSchemaType::Number, AiSchemaType::Integer], integer_cap: None },
    Bound {
        min: "minLength",
        max: "maxLength",
        types: &[AiSchemaType::String],
        integer_cap: Some(AI_SCHEMA_MAX_STRING),
    },
    Bound {
        min: "minItems",
        max: "maxItems",
        types: &[AiSchemaType::Array],
        integer_cap: Some(AI_SCHEMA_MAX_ITEMS_BOUND),
    },
];

/// One enum value of the dialect: a scalar (every serde_json number is finite).
fn is_enum_value(value: &Value) -> bool {
    matches!(value, Value::Null | Value::String(_) | Value::Bool(_) | Value::Number(_))
}

fn annotation_problem(schema: &Map<String, Value>) -> Option<AiSchemaProblem> {
    let too_long = |key: &str, cap: usize| match schema.get(key) {
        None => false,
        Some(Value::String(text)) => utf16_len(text) > cap,
        Some(_) => true,
    };
    let bad = too_long("description", AI_SCHEMA_MAX_DESCRIPTION) || too_long("title", AI_SCHEMA_MAX_TITLE);
    bad.then_some(AiSchemaProblem::BadAnnotation)
}

fn enum_problem(values: Option<&Value>) -> Option<AiSchemaProblem> {
    let values = values?;
    let fits = matches!(values, Value::Array(items) if !items.is_empty() && items.len() <= AI_SCHEMA_MAX_ENUM && items.iter().all(is_enum_value));
    (!fits).then_some(AiSchemaProblem::BadEnum)
}

fn object_problem(schema: &Map<String, Value>, depth: usize) -> Option<AiSchemaProblem> {
    let Some(Value::Object(properties)) = schema.get("properties") else { return Some(AiSchemaProblem::ObjectShape) };
    if schema.get("additionalProperties") != Some(&Value::Bool(false)) || properties.len() > AI_SCHEMA_MAX_PROPERTIES {
        return Some(AiSchemaProblem::ObjectShape);
    }
    for (key, child) in properties {
        if utf16_len(key) > AI_SCHEMA_MAX_KEY_CHARS || FORBIDDEN_PROPERTY_NAMES.contains(&key.as_str()) {
            return Some(AiSchemaProblem::BadPropertyName);
        }
        if let Some(problem) = schema_problem(child, depth + 1) {
            return Some(problem);
        }
    }
    let known = match schema.get("required") {
        None => true,
        Some(Value::Array(names)) => {
            names.iter().all(|name| name.as_str().is_some_and(|name| properties.contains_key(name)))
        }
        Some(_) => false,
    };
    (!known).then_some(AiSchemaProblem::BadRequired)
}

/// A number with no fraction (`Number.isInteger`).
fn is_whole(number: &Number) -> bool {
    number.is_u64() || number.is_i64() || number.as_f64().is_some_and(|value| value.fract() == 0.0)
}

/// One bound's value: absent, or a number (a whole one within its cap where the bound counts).
fn bound_fits(value: Option<&Value>, integer_cap: Option<u64>) -> bool {
    let number = match value {
        None => return true,
        Some(Value::Number(number)) => number,
        Some(_) => return false,
    };
    let Some(cap) = integer_cap else { return true };
    let within = number.as_f64().is_some_and(|value| value >= 0.0 && value <= cap as f64);
    is_whole(number) && within
}

fn as_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

fn pair_problem(schema: &Map<String, Value>, kind: AiSchemaType, bound: &Bound) -> Option<AiSchemaProblem> {
    let (low, high) = (schema.get(bound.min), schema.get(bound.max));
    if low.is_none() && high.is_none() {
        return None;
    }
    if !bound.types.contains(&kind) {
        return Some(AiSchemaProblem::MisplacedKeyword);
    }
    if !bound_fits(low, bound.integer_cap) || !bound_fits(high, bound.integer_cap) {
        return Some(AiSchemaProblem::BadBound);
    }
    match (as_f64(low), as_f64(high)) {
        (Some(low), Some(high)) if low > high => Some(AiSchemaProblem::BadBound),
        _ => None,
    }
}

fn bounds_problem(schema: &Map<String, Value>, kind: AiSchemaType) -> Option<AiSchemaProblem> {
    BOUNDS.iter().find_map(|bound| pair_problem(schema, kind, bound))
}

/// The keywords only one type takes, used on another.
fn placement_problem(schema: &Map<String, Value>, kind: AiSchemaType, depth: usize) -> Option<AiSchemaProblem> {
    if kind == AiSchemaType::Object {
        return object_problem(schema, depth);
    }
    let object_only = ["properties", "required", "additionalProperties"].iter().any(|key| schema.contains_key(*key));
    if object_only {
        return Some(AiSchemaProblem::MisplacedKeyword);
    }
    if kind == AiSchemaType::Array {
        return match schema.get("items") {
            Some(items) => schema_problem(items, depth + 1),
            None => Some(AiSchemaProblem::NotObject),
        };
    }
    schema.contains_key("items").then_some(AiSchemaProblem::MisplacedKeyword)
}

fn schema_problem(value: &Value, depth: usize) -> Option<AiSchemaProblem> {
    if depth > AI_SCHEMA_MAX_DEPTH {
        return Some(AiSchemaProblem::TooDeep);
    }
    let Value::Object(schema) = value else { return Some(AiSchemaProblem::NotObject) };
    let Some(kind) = schema.get("type").and_then(Value::as_str).and_then(AiSchemaType::from_wire) else {
        return Some(AiSchemaProblem::UnknownType);
    };
    if schema.keys().any(|key| !KEYWORDS.contains(&key.as_str())) {
        return Some(AiSchemaProblem::UnknownKeyword);
    }
    annotation_problem(schema)
        .or_else(|| enum_problem(schema.get("enum")))
        .or_else(|| placement_problem(schema, kind, depth))
        .or_else(|| bounds_problem(schema, kind))
}

/// Why a schema is refused (`checkSchema`), or None when the dialect takes it.
pub fn check_schema(schema: &Value) -> Option<AiSchemaProblem> {
    schema_problem(schema, 0)
}

/// JavaScript's `===` between two JSON scalars (numbers compare by value).
fn same_scalar(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => a == b,
    }
}

fn number_of(schema: &Map<String, Value>, key: &str) -> Option<f64> {
    schema.get(key).and_then(Value::as_f64)
}

fn count_of(schema: &Map<String, Value>, key: &str, absent: u64) -> f64 {
    number_of(schema, key).unwrap_or(absent as f64)
}

fn matches_object(value: &Value, schema: &Map<String, Value>) -> bool {
    let Value::Object(members) = value else { return false };
    let empty = Map::new();
    let properties = schema.get("properties").and_then(Value::as_object).unwrap_or(&empty);
    let required = schema.get("required").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let present = required.iter().all(|key| key.as_str().is_some_and(|key| members.contains_key(key)));
    present && members.iter().all(|(key, child)| properties.get(key).is_some_and(|inner| matches(child, inner)))
}

fn matches_array(value: &Value, schema: &Map<String, Value>) -> bool {
    let Value::Array(items) = value else { return false };
    let count = items.len() as f64;
    let within =
        count <= count_of(schema, "maxItems", AI_MAX_JSON_ARRAY_ITEMS) && count >= count_of(schema, "minItems", 0);
    within && schema.get("items").is_some_and(|inner| items.iter().all(|item| matches(item, inner)))
}

/// A number with no fraction JavaScript holds exactly (`Number.isSafeInteger`).
fn is_safe_integer(number: &Number) -> bool {
    is_whole(number) && number.as_f64().is_some_and(|value| value.abs() <= MAX_SAFE_INTEGER as f64)
}

fn matches_scalar(value: &Value, schema: &Map<String, Value>, kind: AiSchemaType) -> bool {
    let min = number_of(schema, "minimum").unwrap_or(f64::NEG_INFINITY);
    let max = number_of(schema, "maximum").unwrap_or(f64::INFINITY);
    let in_range = |number: &Number| number.as_f64().is_some_and(|value| value >= min && value <= max);
    match (kind, value) {
        (AiSchemaType::Null, Value::Null) | (AiSchemaType::Boolean, Value::Bool(_)) => true,
        (AiSchemaType::String, Value::String(text)) => {
            let points = text.chars().count() as f64;
            points >= count_of(schema, "minLength", 0) && points <= count_of(schema, "maxLength", AI_SCHEMA_MAX_STRING)
        }
        (AiSchemaType::Number, Value::Number(number)) => in_range(number),
        (AiSchemaType::Integer, Value::Number(number)) => is_safe_integer(number) && in_range(number),
        _ => false,
    }
}

/// genex.games' `matches`: the value fits a schema the dialect took (enum, type, bounds, exact
/// object keys).
fn matches(value: &Value, schema: &Value) -> bool {
    let Value::Object(schema) = schema else { return false };
    if let Some(Value::Array(members)) = schema.get("enum")
        && !members.iter().any(|member| same_scalar(member, value))
    {
        return false;
    }
    match schema.get("type").and_then(Value::as_str).and_then(AiSchemaType::from_wire) {
        Some(AiSchemaType::Object) => matches_object(value, schema),
        Some(AiSchemaType::Array) => matches_array(value, schema),
        Some(kind) => matches_scalar(value, schema, kind),
        None => false,
    }
}

/// Whether a value is a valid answer for `schema` (`validateValue`; None: a text answer, which
/// must hold words): plain JSON inside the answer bounds, at most
/// [`AI_MAX_OUTPUT_BYTES`] encoded, fitting the schema.
pub fn validate_value(schema: Option<&Value>, value: &Value) -> bool {
    if !is_answer_json(value) || js_json(value).len() > AI_MAX_OUTPUT_BYTES {
        return false;
    }
    match schema {
        None => value.as_str().is_some_and(has_words),
        Some(schema) => check_schema(schema).is_none() && matches(value, schema),
    }
}

/// A schema of the dialect, built: a Rust type's (`Schema::schema`) or a call's own.
///
/// ```
/// use genex_ai::SchemaNode;
///
/// let turn = SchemaNode::object()
///     .property("headline", SchemaNode::string().max_length(160))
///     .property("troops", SchemaNode::integer().minimum(-500.0).maximum(500.0));
/// assert_eq!(turn.problem(), None);
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct SchemaNode(Map<String, Value>);

impl SchemaNode {
    /// A schema of `kind` with no bounds; an object is closed and has no properties yet, an array
    /// takes items of `null` until [`SchemaNode::array`] names them.
    pub fn of(kind: AiSchemaType) -> SchemaNode {
        let mut node = Map::new();
        node.insert("type".to_owned(), Value::from(kind.wire()));
        if kind == AiSchemaType::Object {
            node.insert("properties".to_owned(), Value::Object(Map::new()));
            node.insert("required".to_owned(), Value::Array(Vec::new()));
            node.insert("additionalProperties".to_owned(), Value::Bool(false));
        }
        SchemaNode(node)
    }

    /// Text.
    pub fn string() -> SchemaNode {
        SchemaNode::of(AiSchemaType::String)
    }

    /// A safe integer.
    pub fn integer() -> SchemaNode {
        SchemaNode::of(AiSchemaType::Integer)
    }

    /// A finite number.
    pub fn number() -> SchemaNode {
        SchemaNode::of(AiSchemaType::Number)
    }

    /// `true` or `false`.
    pub fn boolean() -> SchemaNode {
        SchemaNode::of(AiSchemaType::Boolean)
    }

    /// `null`.
    pub fn null() -> SchemaNode {
        SchemaNode::of(AiSchemaType::Null)
    }

    /// A list of `items` (at most 256 unless [`SchemaNode::max_items`] says otherwise).
    pub fn array(items: SchemaNode) -> SchemaNode {
        let mut node = SchemaNode::of(AiSchemaType::Array);
        node.0.insert("items".to_owned(), items.into_value());
        node
    }

    /// A closed object with no properties yet.
    pub fn object() -> SchemaNode {
        SchemaNode::of(AiSchemaType::Object)
    }

    /// The node's type, or None for a node made from foreign JSON without one.
    pub fn kind(&self) -> Option<AiSchemaType> {
        self.0.get("type").and_then(Value::as_str).and_then(AiSchemaType::from_wire)
    }

    fn set(mut self, key: &str, value: Value) -> SchemaNode {
        self.0.insert(key.to_owned(), value);
        self
    }

    /// The node itself, or, for an array, its items: a text or number bound on a list is about
    /// what the list holds.
    fn on_items(self, apply: impl FnOnce(SchemaNode) -> SchemaNode) -> SchemaNode {
        if self.kind() != Some(AiSchemaType::Array) {
            return apply(self);
        }
        let mut node = self;
        if let Some(Value::Object(items)) = node.0.remove("items") {
            node.0.insert("items".to_owned(), apply(SchemaNode(items)).into_value());
        }
        node
    }

    /// Add a required property (an object's).
    pub fn property(self, name: &str, node: SchemaNode) -> SchemaNode {
        self.with_property(name, node, true)
    }

    /// Add a property the answer may leave out (an object's).
    pub fn optional_property(self, name: &str, node: SchemaNode) -> SchemaNode {
        self.with_property(name, node, false)
    }

    fn with_property(mut self, name: &str, node: SchemaNode, required: bool) -> SchemaNode {
        if let Some(Value::Object(properties)) = self.0.get_mut("properties") {
            properties.insert(name.to_owned(), node.into_value());
        }
        if required && let Some(Value::Array(names)) = self.0.get_mut("required") {
            names.push(Value::from(name));
        }
        self
    }

    /// The values the answer must be one of (an array's items when this is an array).
    pub fn one_of<V: Into<Value>>(self, values: impl IntoIterator<Item = V>) -> SchemaNode {
        let values: Vec<Value> = values.into_iter().map(Into::into).collect();
        self.on_items(|node| node.set("enum", Value::Array(values)))
    }

    /// The smallest number (an array's items when this is an array).
    pub fn minimum(self, minimum: f64) -> SchemaNode {
        self.on_items(|node| node.set("minimum", number(minimum)))
    }

    /// The largest number (an array's items when this is an array).
    pub fn maximum(self, maximum: f64) -> SchemaNode {
        self.on_items(|node| node.set("maximum", number(maximum)))
    }

    /// The fewest characters (code points; an array's items when this is an array).
    pub fn min_length(self, length: u64) -> SchemaNode {
        self.on_items(|node| node.set("minLength", Value::from(length)))
    }

    /// The most characters (code points; an array's items when this is an array).
    pub fn max_length(self, length: u64) -> SchemaNode {
        self.on_items(|node| node.set("maxLength", Value::from(length)))
    }

    /// The fewest items of a list.
    pub fn min_items(self, count: u64) -> SchemaNode {
        self.set("minItems", Value::from(count))
    }

    /// The most items of a list.
    pub fn max_items(self, count: u64) -> SchemaNode {
        self.set("maxItems", Value::from(count))
    }

    /// What the model reads about this value (at most 500 characters).
    pub fn describe(self, description: &str) -> SchemaNode {
        self.set("description", Value::from(description))
    }

    /// A short name for this value (at most 100 characters).
    pub fn title(self, title: &str) -> SchemaNode {
        self.set("title", Value::from(title))
    }

    /// Why the dialect refuses this schema, or None when it takes it. A game's own test can hold
    /// its types to the dialect: `assert_eq!(Turn::schema().problem(), None)`.
    pub fn problem(&self) -> Option<AiSchemaProblem> {
        check_schema(&Value::Object(self.0.clone()))
    }

    /// The schema as JSON.
    pub fn to_value(&self) -> Value {
        Value::Object(self.0.clone())
    }

    /// The schema as JSON, consumed.
    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }

    /// A schema written as JSON, when the dialect takes it.
    pub fn from_value(value: Value) -> Result<SchemaNode, AiSchemaProblem> {
        if let Some(problem) = check_schema(&value) {
            return Err(problem);
        }
        match value {
            Value::Object(node) => Ok(SchemaNode(node)),
            _ => Err(AiSchemaProblem::NotObject),
        }
    }
}

/// A finite number as JSON: a whole one JavaScript holds exactly as an integer, as the
/// TypeScript writes its bounds (a non-finite one, which no bound can be, as 0).
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= SAFE {
        return Value::from(value as i64);
    }
    Number::from_f64(value).map_or(Value::from(0), Value::Number)
}

/// A Rust type an answer is read into, as the dialect describes it. `#[derive(Schema)]` writes it
/// for a struct with named fields (every field required but an `Option` or a `#[serde(default)]`
/// one; `#[genex_ai(max_length = 120, max_items = 8, min = -3, max = 3, description = "…")]` bound
/// one) and for an enum of unit variants (one of their names).
pub trait Schema {
    /// The type's schema.
    fn schema() -> SchemaNode;
}

impl Schema for String {
    fn schema() -> SchemaNode {
        SchemaNode::string()
    }
}

impl Schema for bool {
    fn schema() -> SchemaNode {
        SchemaNode::boolean()
    }
}

impl Schema for () {
    fn schema() -> SchemaNode {
        SchemaNode::null()
    }
}

/// The largest whole number an `f64` bound states exactly for every integer type.
const SAFE: f64 = MAX_SAFE_INTEGER as f64;

macro_rules! integer_schema {
    ($($kind:ty),+) => {
        $(
            impl Schema for $kind {
                fn schema() -> SchemaNode {
                    // A type wider than JavaScript's safe range is bounded to it: the dialect's
                    // integers are safe integers.
                    SchemaNode::integer().minimum((<$kind>::MIN as f64).max(-SAFE)).maximum((<$kind>::MAX as f64).min(SAFE))
                }
            }
        )+
    };
}

integer_schema!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

impl Schema for f64 {
    fn schema() -> SchemaNode {
        SchemaNode::number()
    }
}

impl Schema for f32 {
    fn schema() -> SchemaNode {
        // An answer past f32's range would land as infinity.
        SchemaNode::number().minimum(f64::from(f32::MIN)).maximum(f64::from(f32::MAX))
    }
}

impl<T: Schema> Schema for Vec<T> {
    fn schema() -> SchemaNode {
        SchemaNode::array(T::schema())
    }
}

impl<T: Schema, const N: usize> Schema for [T; N] {
    fn schema() -> SchemaNode {
        SchemaNode::array(T::schema()).min_items(N as u64).max_items(N as u64)
    }
}

impl<T: Schema> Schema for Box<T> {
    fn schema() -> SchemaNode {
        T::schema()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn built_schemas_are_the_dialect_and_bounds_on_a_list_reach_its_items() {
        let node = SchemaNode::object()
            .property("names", Vec::<String>::schema().max_length(40).max_items(8))
            .optional_property("note", SchemaNode::string().describe("A note."));
        assert_eq!(node.problem(), None);
        assert_eq!(
            node.to_value(),
            json!({
                "type": "object",
                "properties": {
                    "names": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 8},
                    "note": {"type": "string", "description": "A note."}
                },
                "required": ["names"],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn integer_types_are_bounded_to_their_range_within_javascripts_safe_integers() {
        assert_eq!(u8::schema().to_value(), json!({"type": "integer", "minimum": 0, "maximum": 255}));
        let wide = u64::schema().to_value();
        assert_eq!(wide["maximum"], json!(MAX_SAFE_INTEGER));
        assert!(validate_value(Some(&wide), &json!(9_007_199_254_740_991_u64)));
        assert!(!validate_value(Some(&wide), &json!(9_007_199_254_740_992_u64)));
        assert!(!validate_value(Some(&i8::schema().to_value()), &json!(128)));
        assert_eq!(<[u8; 3]>::schema().problem(), None);
        assert!(!validate_value(Some(&<[u8; 3]>::schema().to_value()), &json!([1, 2])));
    }

    #[test]
    fn a_schema_from_json_is_checked() {
        assert_eq!(
            SchemaNode::from_value(json!({"type": "object", "properties": {}})),
            Err(AiSchemaProblem::ObjectShape)
        );
        assert_eq!(SchemaNode::from_value(json!([])), Err(AiSchemaProblem::NotObject));
        assert!(SchemaNode::from_value(json!({"type": "null"})).is_ok());
    }

    #[test]
    fn a_text_answer_needs_words_and_every_answer_fits_its_byte_cap() {
        assert!(validate_value(None, &json!("hi")));
        assert!(!validate_value(None, &json!(" \u{feff}")));
        assert!(!validate_value(None, &json!(3)));
        let long = "a".repeat(AI_MAX_OUTPUT_BYTES);
        assert!(!validate_value(Some(&json!({"type": "string"})), &json!(long)), "the quotes take it past the cap");
    }
}
