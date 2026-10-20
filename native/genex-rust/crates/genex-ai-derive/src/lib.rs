//! `#[derive(Schema)]` for genex-ai (`genex_ai::Schema`, re-exported there; a game never names
//! this crate): a Rust type as the closed JSON-schema dialect a play-time AI answer is held to.
//!
//! - A struct with named fields is a closed object: every field required but an `Option` or a
//!   `#[serde(default)]` one, `#[serde(skip)]` fields left out, names as serde reads them
//!   (`rename`, `rename_all`). It must say `#[serde(deny_unknown_fields)]`: the dialect's objects
//!   are closed, and so is the type that reads one.
//! - A one-field tuple struct is its field (serde_json reads a newtype struct as its value).
//! - An enum of unit variants is one of their names; an enum whose every variant has a doc
//!   comment is also a `genex_ai::ToolSet` for an act call (a unit variant takes no arguments, a
//!   struct variant its fields, a one-field tuple variant its field's type).
//! - `#[genex_ai(max_length = N, min_length = N, max_items = N, min_items = N, min = X, max = X,
//!   description = "…", title = "…")]` bound or annotate a field; a doc comment is its
//!   description. A text or number bound on a list reaches the list's items.
//!
//! Serde attributes that change the shape in ways the dialect cannot say (`flatten`, `tag`,
//! `untagged`, `with`, …) are refused at compile time with the reason. The generated code names
//! the runtime crate `genex_ai` (no leading `::`), so a game that reaches it through a re-export
//! (`use genex::ai as genex_ai;`) works too.

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as Tokens};
use quote::quote;
use syn::meta::ParseNestedMeta;
use syn::{
    Attribute, Data, DataEnum, DeriveInput, Expr, ExprLit, Fields, GenericArgument, Ident, Lit, LitStr, Meta,
    PathArguments, Token, Type, parse_macro_input, parse_quote,
};

/// The longest description the dialect takes, in UTF-16 units.
const MAX_DESCRIPTION: usize = 500;
/// The longest title the dialect takes, in UTF-16 units.
const MAX_TITLE: usize = 100;
/// The property an act answer names its tool in: no tool may take the name.
const TOOL_KEY: &str = "tool";

/// A type's (or a variant's) description of the dialect: `#[derive(Schema)]`.
#[proc_macro_derive(Schema, attributes(genex_ai))]
pub fn derive_schema(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    expand(&input).unwrap_or_else(syn::Error::into_compile_error).into()
}

fn expand(input: &DeriveInput) -> syn::Result<Tokens> {
    let container = SerdeContainer::read(&input.attrs)?;
    let notes = Notes::read(&input.attrs)?;
    match &input.data {
        Data::Struct(data) => struct_schema(input, &container, &notes, &data.fields),
        Data::Enum(data) => enum_impls(input, &container, &notes, data),
        Data::Union(_) => Err(syn::Error::new(input.ident.span(), "genex_ai::Schema: a union has no schema")),
    }
}

// ── serde's attributes, as far as they decide the shape ────────────────────────────────────

/// serde's rename rules, applied exactly as serde_derive applies them.
#[derive(Clone, Copy)]
enum Rule {
    Lower,
    Upper,
    Pascal,
    Camel,
    Snake,
    ScreamingSnake,
    Kebab,
    ScreamingKebab,
}

impl Rule {
    fn read(text: &LitStr) -> syn::Result<Rule> {
        Ok(match text.value().as_str() {
            "lowercase" => Rule::Lower,
            "UPPERCASE" => Rule::Upper,
            "PascalCase" => Rule::Pascal,
            "camelCase" => Rule::Camel,
            "snake_case" => Rule::Snake,
            "SCREAMING_SNAKE_CASE" => Rule::ScreamingSnake,
            "kebab-case" => Rule::Kebab,
            "SCREAMING-KEBAB-CASE" => Rule::ScreamingKebab,
            other => {
                return Err(syn::Error::new(text.span(), format!("genex_ai::Schema: unknown rename rule {other:?}")));
            }
        })
    }

    /// A variant's name (PascalCase in the source) under this rule.
    fn variant(self, name: &str) -> String {
        match self {
            Rule::Pascal => name.to_owned(),
            Rule::Lower => name.to_ascii_lowercase(),
            Rule::Upper => name.to_ascii_uppercase(),
            Rule::Camel => lower_first(name),
            Rule::Snake => {
                let mut snake = String::new();
                for (index, ch) in name.char_indices() {
                    if index > 0 && ch.is_uppercase() {
                        snake.push('_');
                    }
                    snake.push(ch.to_ascii_lowercase());
                }
                snake
            }
            Rule::ScreamingSnake => Rule::Snake.variant(name).to_ascii_uppercase(),
            Rule::Kebab => Rule::Snake.variant(name).replace('_', "-"),
            Rule::ScreamingKebab => Rule::ScreamingSnake.variant(name).replace('_', "-"),
        }
    }

    /// A field's name (snake_case in the source) under this rule.
    fn field(self, name: &str) -> String {
        match self {
            Rule::Lower | Rule::Snake => name.to_owned(),
            Rule::Upper | Rule::ScreamingSnake => name.to_ascii_uppercase(),
            Rule::Pascal => {
                let mut pascal = String::new();
                let mut capitalize = true;
                for ch in name.chars() {
                    if ch == '_' {
                        capitalize = true;
                    } else if capitalize {
                        pascal.push(ch.to_ascii_uppercase());
                        capitalize = false;
                    } else {
                        pascal.push(ch);
                    }
                }
                pascal
            }
            Rule::Camel => lower_first(&Rule::Pascal.field(name)),
            Rule::Kebab => name.replace('_', "-"),
            Rule::ScreamingKebab => Rule::ScreamingSnake.field(name).replace('_', "-"),
        }
    }
}

/// `text` with its first character in ASCII lower case, as serde's camelCase writes it.
fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| first.to_ascii_lowercase().to_string() + chars.as_str())
}

fn refuse(meta: &ParseNestedMeta<'_>, why: &str) -> syn::Error {
    meta.error(format!("genex_ai::Schema: {why}"))
}

/// Read past one serde item this derive does not need (`= "…"` or a `(…)` list).
fn skip(meta: &ParseNestedMeta<'_>) -> syn::Result<()> {
    if meta.input.peek(Token![=]) {
        meta.value()?.parse::<Lit>()?;
    } else if meta.input.peek(syn::token::Paren) {
        meta.parse_nested_meta(|inner| skip(&inner))?;
    }
    Ok(())
}

/// A `rename = "…"` or `rename(deserialize = "…")`: the name serde reads.
fn renamed(meta: &ParseNestedMeta<'_>) -> syn::Result<Option<String>> {
    if meta.input.peek(Token![=]) {
        return Ok(Some(meta.value()?.parse::<LitStr>()?.value()));
    }
    let mut read = None;
    meta.parse_nested_meta(|inner| {
        if inner.path.is_ident("deserialize") {
            read = Some(inner.value()?.parse::<LitStr>()?.value());
            return Ok(());
        }
        skip(&inner)
    })?;
    Ok(read)
}

fn rename_rule(meta: &ParseNestedMeta<'_>) -> syn::Result<Rule> {
    if meta.input.peek(Token![=]) {
        return Rule::read(&meta.value()?.parse::<LitStr>()?);
    }
    Err(refuse(meta, "write one rename_all = \"…\" rule: the schema follows what serde reads"))
}

/// The container's serde attributes this derive reads.
#[derive(Default)]
struct SerdeContainer {
    deny_unknown_fields: bool,
    default: bool,
    rename_all: Option<Rule>,
}

impl SerdeContainer {
    fn read(attrs: &[Attribute]) -> syn::Result<SerdeContainer> {
        let mut read = SerdeContainer::default();
        for attr in attrs.iter().filter(|attr| attr.path().is_ident("serde")) {
            attr.parse_nested_meta(|meta| {
                let name = meta.path.get_ident().map(Ident::to_string).unwrap_or_default();
                match name.as_str() {
                    "deny_unknown_fields" => read.deny_unknown_fields = true,
                    "default" => {
                        read.default = true;
                        skip(&meta)?;
                    }
                    "rename_all" => read.rename_all = Some(rename_rule(&meta)?),
                    "tag" | "content" | "untagged" | "transparent" | "from" | "try_from" | "into" | "remote" => {
                        return Err(refuse(
                            &meta,
                            &format!("#[serde({name})] changes the shape in a way the closed dialect cannot say"),
                        ));
                    }
                    _ => skip(&meta)?,
                }
                Ok(())
            })?;
        }
        Ok(read)
    }
}

/// A field's or a variant's serde attributes this derive reads.
#[derive(Default)]
struct SerdeItem {
    rename: Option<String>,
    rename_all: Option<Rule>,
    skipped: bool,
    default: bool,
}

impl SerdeItem {
    fn read(attrs: &[Attribute]) -> syn::Result<SerdeItem> {
        let mut read = SerdeItem::default();
        for attr in attrs.iter().filter(|attr| attr.path().is_ident("serde")) {
            attr.parse_nested_meta(|meta| {
                let name = meta.path.get_ident().map(Ident::to_string).unwrap_or_default();
                match name.as_str() {
                    "rename" => read.rename = renamed(&meta)?,
                    "rename_all" => read.rename_all = Some(rename_rule(&meta)?),
                    "skip" | "skip_deserializing" => read.skipped = true,
                    "default" => {
                        read.default = true;
                        skip(&meta)?;
                    }
                    "flatten" | "with" | "deserialize_with" | "other" | "untagged" => {
                        return Err(refuse(
                            &meta,
                            &format!("#[serde({name})] changes the shape in a way the closed dialect cannot say"),
                        ));
                    }
                    _ => skip(&meta)?,
                }
                Ok(())
            })?;
        }
        Ok(read)
    }
}

// ── genex_ai's own attributes and doc comments ───────────────────────────────────────────

/// A number bound as written (`min = -3`, `max = 1.5`).
fn signed_number(meta: &ParseNestedMeta<'_>) -> syn::Result<f64> {
    let input = meta.value()?;
    let negative = input.parse::<Option<Token![-]>>()?.is_some();
    let magnitude = match input.parse::<Lit>()? {
        Lit::Int(int) => int.base10_parse::<f64>()?,
        Lit::Float(float) => float.base10_parse::<f64>()?,
        other => return Err(syn::Error::new(other.span(), "genex_ai::Schema: a bound is a number")),
    };
    Ok(if negative { -magnitude } else { magnitude })
}

fn count(meta: &ParseNestedMeta<'_>) -> syn::Result<u64> {
    meta.value()?.parse::<syn::LitInt>()?.base10_parse::<u64>()
}

/// What `#[genex_ai(…)]` and the doc comments say about a value.
#[derive(Default)]
struct Notes {
    description: Option<String>,
    title: Option<String>,
    bounds: Vec<Tokens>,
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn doc_text(attrs: &[Attribute]) -> Option<String> {
    let lines: Vec<String> = attrs
        .iter()
        .filter(|attr| attr.path().is_ident("doc"))
        .filter_map(|attr| match &attr.meta {
            Meta::NameValue(pair) => match &pair.value {
                Expr::Lit(ExprLit { lit: Lit::Str(text), .. }) => Some(text.value().trim().to_owned()),
                _ => None,
            },
            _ => None,
        })
        .filter(|line| !line.is_empty())
        .collect();
    (!lines.is_empty()).then(|| lines.join(" "))
}

impl Notes {
    fn read(attrs: &[Attribute]) -> syn::Result<Notes> {
        let mut notes = Notes { description: doc_text(attrs), ..Notes::default() };
        for attr in attrs.iter().filter(|attr| attr.path().is_ident("genex_ai")) {
            attr.parse_nested_meta(|meta| notes.take(&meta))?;
        }
        let span = attrs.first().map_or_else(Span::call_site, |attr| attr.pound_token.span);
        if notes.description.as_deref().is_some_and(|text| utf16_len(text) > MAX_DESCRIPTION) {
            return Err(syn::Error::new(
                span,
                format!(
                    "genex_ai::Schema: a description is at most {MAX_DESCRIPTION} characters (the doc comment or `description`)"
                ),
            ));
        }
        if notes.title.as_deref().is_some_and(|text| utf16_len(text) > MAX_TITLE) {
            return Err(syn::Error::new(span, format!("genex_ai::Schema: a title is at most {MAX_TITLE} characters")));
        }
        Ok(notes)
    }

    fn take(&mut self, meta: &ParseNestedMeta<'_>) -> syn::Result<()> {
        let name = meta.path.get_ident().map(Ident::to_string).unwrap_or_default();
        let bound = match name.as_str() {
            "description" => {
                self.description = Some(meta.value()?.parse::<LitStr>()?.value());
                return Ok(());
            }
            "title" => {
                self.title = Some(meta.value()?.parse::<LitStr>()?.value());
                return Ok(());
            }
            "max_length" => {
                let n = count(meta)?;
                quote!(.max_length(#n))
            }
            "min_length" => {
                let n = count(meta)?;
                quote!(.min_length(#n))
            }
            "max_items" => {
                let n = count(meta)?;
                quote!(.max_items(#n))
            }
            "min_items" => {
                let n = count(meta)?;
                quote!(.min_items(#n))
            }
            "min" => {
                let x = signed_number(meta)?;
                quote!(.minimum(#x))
            }
            "max" => {
                let x = signed_number(meta)?;
                quote!(.maximum(#x))
            }
            _ => {
                return Err(refuse(
                    meta,
                    "#[genex_ai(…)] takes max_length, min_length, max_items, min_items, min, max, description and title",
                ));
            }
        };
        self.bounds.push(bound);
        Ok(())
    }

    /// The node expression with these bounds and annotations applied.
    fn apply(&self, node: Tokens) -> Tokens {
        let bounds = &self.bounds;
        let description = self.description.as_ref().map(|text| quote!(.describe(#text)));
        let title = self.title.as_ref().map(|text| quote!(.title(#text)));
        quote!(#node #(#bounds)* #title #description)
    }
}

// ── fields ────────────────────────────────────────────────────────────────────────────────

/// `T` when `ty` is `Option<T>`.
fn option_inner(ty: &Type) -> Option<&Type> {
    let Type::Path(path) = ty else { return None };
    let last = path.path.segments.last()?;
    if last.ident != "Option" {
        return None;
    }
    let PathArguments::AngleBracketed(args) = &last.arguments else { return None };
    match args.args.first() {
        Some(GenericArgument::Type(inner)) if args.args.len() == 1 => Some(inner),
        _ => None,
    }
}

fn plain_name(ident: &Ident) -> String {
    let name = ident.to_string();
    name.strip_prefix("r#").map_or(name.clone(), str::to_owned)
}

/// A closed object over named fields: `.property(…)` for each one serde reads.
fn object_of(fields: &syn::FieldsNamed, rule: Option<Rule>, default_all: bool) -> syn::Result<Tokens> {
    let mut properties = Vec::new();
    for field in &fields.named {
        let serde = SerdeItem::read(&field.attrs)?;
        if serde.skipped {
            continue;
        }
        let notes = Notes::read(&field.attrs)?;
        let ident = field.ident.as_ref().ok_or_else(|| syn::Error::new(Span::call_site(), "a named field"))?;
        let name = serde
            .rename
            .unwrap_or_else(|| rule.map_or_else(|| plain_name(ident), |rule| rule.field(&plain_name(ident))));
        let (ty, optional) = option_inner(&field.ty).map_or((&field.ty, false), |inner| (inner, true));
        let node = notes.apply(quote!(<#ty as genex_ai::Schema>::schema()));
        let add = if optional || serde.default || default_all { quote!(optional_property) } else { quote!(property) };
        properties.push(quote!(.#add(#name, #node)));
    }
    Ok(quote!(genex_ai::SchemaNode::object() #(#properties)*))
}

/// The one field of a newtype, with its bounds.
fn newtype_of(fields: &syn::FieldsUnnamed) -> syn::Result<Tokens> {
    let field = fields.unnamed.first().filter(|_| fields.unnamed.len() == 1).ok_or_else(|| {
        syn::Error::new(
            Span::call_site(),
            "genex_ai::Schema: a tuple of more than one field has no schema in the dialect",
        )
    })?;
    let ty = &field.ty;
    Ok(Notes::read(&field.attrs)?.apply(quote!(<#ty as genex_ai::Schema>::schema())))
}

fn with_bound(input: &DeriveInput, bound: Tokens) -> syn::Generics {
    let mut generics = input.generics.clone();
    let params: Vec<Ident> = generics.type_params().map(|param| param.ident.clone()).collect();
    let clause = generics.make_where_clause();
    for param in params {
        clause.predicates.push(parse_quote!(#param: #bound));
    }
    generics
}

fn struct_schema(
    input: &DeriveInput,
    container: &SerdeContainer,
    notes: &Notes,
    fields: &Fields,
) -> syn::Result<Tokens> {
    let body = match fields {
        Fields::Named(named) => {
            if !container.deny_unknown_fields {
                return Err(syn::Error::new(
                    input.ident.span(),
                    "genex_ai::Schema needs #[serde(deny_unknown_fields)]: the dialect's objects are closed, and so is the type that reads one",
                ));
            }
            object_of(named, container.rename_all, container.default)?
        }
        Fields::Unnamed(unnamed) => newtype_of(unnamed)?,
        Fields::Unit => quote!(genex_ai::SchemaNode::null()),
    };
    let body = notes.apply(body);
    let ident = &input.ident;
    let generics = with_bound(input, quote!(genex_ai::Schema));
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
    Ok(quote! {
        impl #impl_generics genex_ai::Schema for #ident #ty_generics #where_clause {
            fn schema() -> genex_ai::SchemaNode {
                #body
            }
        }
    })
}

// ── enums ─────────────────────────────────────────────────────────────────────────────────

/// One variant serde reads: its wire name, its description and its arguments.
struct Variant {
    name: String,
    description: Option<String>,
    args: Tokens,
    unit: bool,
    span: Span,
}

fn variants_of(data: &DataEnum, container: &SerdeContainer) -> syn::Result<Vec<Variant>> {
    let mut variants = Vec::new();
    for variant in &data.variants {
        let serde = SerdeItem::read(&variant.attrs)?;
        if serde.skipped {
            continue;
        }
        let notes = Notes::read(&variant.attrs)?;
        let source = plain_name(&variant.ident);
        let name = serde
            .rename
            .clone()
            .unwrap_or_else(|| container.rename_all.map_or(source.clone(), |rule| rule.variant(&source)));
        let (args, unit) = match &variant.fields {
            Fields::Unit => (quote!(genex_ai::SchemaNode::object()), true),
            Fields::Unnamed(unnamed) => (newtype_of(unnamed)?, false),
            Fields::Named(named) => {
                if !container.deny_unknown_fields {
                    return Err(syn::Error::new(
                        variant.ident.span(),
                        "genex_ai::Schema needs #[serde(deny_unknown_fields)] on an enum with struct variants: their objects are closed",
                    ));
                }
                (object_of(named, serde.rename_all, false)?, false)
            }
        };
        variants.push(Variant { name, description: notes.description, args, unit, span: variant.ident.span() });
    }
    Ok(variants)
}

fn is_tool_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let tail = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'_';
    let shaped = matches!(bytes.first(), Some(first) if first.is_ascii_alphabetic())
        && bytes.len() <= 64
        && bytes[1..].iter().all(tail);
    shaped && name != TOOL_KEY
}

/// Why `variants` cannot be an act call's tools, or None when they can.
fn tool_problem(variants: &[Variant]) -> Option<(Span, String)> {
    if variants.is_empty() {
        return Some((Span::call_site(), "an act call needs at least one tool".to_owned()));
    }
    variants.iter().find_map(|variant| {
        if variant.description.as_deref().is_none_or(|text| text.trim().is_empty()) {
            return Some((
                variant.span,
                format!("tool {:?} needs a doc comment: the model reads it to pick the tool", variant.name),
            ));
        }
        (!is_tool_name(&variant.name)).then(|| {
            (
                variant.span,
                format!("tool {:?} needs a name of [A-Za-z][A-Za-z0-9_]{{0,63}} other than \"tool\"", variant.name),
            )
        })
    })
}

fn tool_set(input: &DeriveInput, variants: &[Variant]) -> Tokens {
    let ident = &input.ident;
    let tools = variants.iter().map(|variant| {
        let (name, args) = (&variant.name, &variant.args);
        let description = variant.description.clone().unwrap_or_default();
        quote!(genex_ai::Tool::new(#name, #description, #args))
    });
    let picks = variants.iter().map(|variant| {
        let (name, unit) = (&variant.name, variant.unit);
        quote!(#name => genex_ai::decode_tool::<Self>(tool, args, #unit),)
    });
    let generics = with_bound(input, quote!(genex_ai::Schema));
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
    quote! {
        impl #impl_generics genex_ai::ToolSet for #ident #ty_generics #where_clause {
            fn tools() -> ::std::vec::Vec<genex_ai::Tool> {
                ::std::vec![#(#tools),*]
            }
            fn from_pick(tool: &str, args: &genex_ai::__private::Value) -> ::std::option::Option<Self> {
                match tool {
                    #(#picks)*
                    _ => ::std::option::Option::None,
                }
            }
        }
    }
}

fn enum_impls(input: &DeriveInput, container: &SerdeContainer, notes: &Notes, data: &DataEnum) -> syn::Result<Tokens> {
    let variants = variants_of(data, container)?;
    let all_unit = variants.iter().all(|variant| variant.unit);
    let tools = tool_problem(&variants);
    if !all_unit && let Some((span, why)) = tools {
        return Err(syn::Error::new(span, format!("genex_ai::Schema: {why}")));
    }
    let mut out = Tokens::new();
    if all_unit {
        if variants.is_empty() {
            return Err(syn::Error::new(
                input.ident.span(),
                "genex_ai::Schema: an enum with no variant serde reads has no schema",
            ));
        }
        let names = variants.iter().map(|variant| &variant.name);
        let body = notes.apply(quote!(genex_ai::SchemaNode::string().one_of([#(#names),*])));
        let ident = &input.ident;
        let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();
        out.extend(quote! {
            impl #impl_generics genex_ai::Schema for #ident #ty_generics #where_clause {
                fn schema() -> genex_ai::SchemaNode {
                    #body
                }
            }
        });
    }
    if tool_problem(&variants).is_none() {
        out.extend(tool_set(input, &variants));
    }
    Ok(out)
}
