// The closed JSON-schema dialect Genex holds every answer to, made from a C# type by reflection: an
// object lists every public field (and every public property with a setter) as required, with
// additionalProperties false; a C# enum is a string enum of its names; [GenexMaxItems] and
// [GenexMaxLength] bound lists and strings. Genex checks the schema again before any model sees it.
using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Genex.AI
{
    /// <summary>A type's schema in Genex's closed dialect.</summary>
    public static class GenexAiSchema
    {
        /// <summary>The deepest a schema nests (Genex's dialect).</summary>
        public const int MaxDepth = 5;

        static readonly Dictionary<Type, JObject> Made = new Dictionary<Type, JObject>();

        /// <summary>The schema of `type`; throws ArgumentException for a type the dialect cannot say.</summary>
        public static JObject For(Type type)
        {
            lock (Made)
            {
                if (!Made.TryGetValue(type, out var schema))
                {
                    // The root is depth 0, as Genex's own check counts it: five nested types and a leaf fit.
                    schema = Of(type, null, 0);
                    Made[type] = schema;
                }
                return (JObject)schema.DeepClone();
            }
        }

        static JObject Of(Type type, MemberInfo member, int depth)
        {
            if (depth > MaxDepth) throw new ArgumentException($"{type.Name} nests deeper than {MaxDepth}.");
            if (type == typeof(string)) return Bounded(new JObject { ["type"] = "string" }, member, "maxLength");
            if (type == typeof(bool)) return new JObject { ["type"] = "boolean" };
            if (IsInteger(type)) return new JObject { ["type"] = "integer" };
            if (type == typeof(float) || type == typeof(double) || type == typeof(decimal))
                return new JObject { ["type"] = "number" };
            if (type.IsEnum) return new JObject { ["type"] = "string", ["enum"] = new JArray(Enum.GetNames(type)) };
            var item = ItemType(type);
            if (item != null)
            {
                var list = new JObject { ["type"] = "array", ["items"] = Of(item, null, depth + 1) };
                return Bounded(list, member, "maxItems");
            }
            if (!CanBeRecord(type)) throw new ArgumentException($"{type.Name} is not a type Genex's schema can say.");
            return Record(type, depth);
        }

        static JObject Record(Type type, int depth)
        {
            var properties = new JObject();
            var required = new JArray();
            foreach (var member in Members(type))
            {
                var name = NameOf(member);
                properties[name] = Of(TypeOf(member), member, depth + 1);
                required.Add(name);
            }
            return new JObject
            {
                ["type"] = "object",
                ["properties"] = properties,
                ["required"] = required,
                ["additionalProperties"] = false,
            };
        }

        static IEnumerable<MemberInfo> Members(Type type)
        {
            foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
                if (field.GetCustomAttribute<JsonIgnoreAttribute>() == null) yield return field;
            foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                if (property.CanWrite && property.GetIndexParameters().Length == 0 && property.GetCustomAttribute<JsonIgnoreAttribute>() == null)
                    yield return property;
        }

        static string NameOf(MemberInfo member) => member.GetCustomAttribute<JsonPropertyAttribute>()?.PropertyName ?? member.Name;

        static Type TypeOf(MemberInfo member) => member is FieldInfo field ? field.FieldType : ((PropertyInfo)member).PropertyType;

        /// <summary>A class or struct of named fields: no primitive, interface, nullable or other collection.</summary>
        static bool CanBeRecord(Type type) =>
            !type.IsPrimitive && !type.IsInterface && !type.IsAbstract && Nullable.GetUnderlyingType(type) == null &&
            !typeof(System.Collections.IEnumerable).IsAssignableFrom(type);

        static bool IsInteger(Type type) =>
            type == typeof(int) || type == typeof(long) || type == typeof(short) || type == typeof(byte) ||
            type == typeof(uint) || type == typeof(ushort) || type == typeof(sbyte);

        /// <summary>The item type of an array or a List; null for anything else.</summary>
        static Type ItemType(Type type)
        {
            if (type.IsArray) return type.GetElementType();
            var isList = type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>);
            return isList ? type.GetGenericArguments()[0] : null;
        }

        static JObject Bounded(JObject schema, MemberInfo member, string bound)
        {
            var max = bound == "maxItems"
                ? member?.GetCustomAttribute<GenexMaxItemsAttribute>()?.Max
                : member?.GetCustomAttribute<GenexMaxLengthAttribute>()?.Max;
            if (max.HasValue) schema[bound] = max.Value;
            return schema;
        }
    }
}
