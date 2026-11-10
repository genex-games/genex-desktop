// The fast channel's motion records (PROTOCOL.md §17.12 *Motion records*): the bytes one entity or one seat
// writes in a snapshot record. A record is `kind` uint8, `idLen` uint8 and that many UTF-8 bytes of the id, a
// `mask` uint32 naming the fields present, then each present field in table order. A field at its default
// (0, false, or an optional body field never written) is left out, so the encoding is canonical: one value,
// one byte string, and a snapshot delta sends a record only when one of its fields changed.
//
// The quantized body fields are written as their uint16 wire codes under the schema's own rule
// (`@colyseus/schema` quantize: clamp, symmetric range, span 2^16 − 2, half-up), so a fast seat decodes
// exactly the value a WebSocket seat decodes. A port of the TypeScript reference (fast-records.ts), held to
// fast-transport.json's `records` and record hostile rows. Pure: no I/O, no clock, no UnityEngine.
using System;
using System.Text;

namespace Genex.Multiplayer.Authority
{
    /// <summary>What a record describes, the first byte.</summary>
    public static class GenexMotionRecordKind
    {
        public const int Entity = 1;
        public const int Seat = 2;
    }

    /// <summary>How a record field is written.</summary>
    public enum GenexFieldWire
    {
        F32,
        U32,
        U16,
        /// <summary>A quantized orientation component in [−1, 1], uint16.</summary>
        Orientation,
        /// <summary>A quantized velocity in [−64, 64], uint16.</summary>
        Velocity,
        /// <summary>A boolean: the mask bit alone (1 present, 0 absent).</summary>
        Flag,
    }

    /// <summary>One motion record: an entity's or a seat's fields by its id. <see cref="Values"/> follows the kind's
    /// field table (<see cref="GenexFastRecords.FieldsOf"/>), each field at its default (0) when absent; a flag
    /// reads 1 or 0.</summary>
    public sealed class GenexMotionRecord
    {
        public int Kind;
        public string Id;
        public double[] Values;

        /// <summary>A record of <paramref name="kind"/> with every field at its default.</summary>
        public static GenexMotionRecord Blank(int kind, string id)
        {
            var fields = GenexFastRecords.FieldsOf(kind);
            return new GenexMotionRecord { Kind = kind, Id = id, Values = new double[fields == null ? 0 : fields.Length] };
        }

        /// <summary>Field <paramref name="name"/>'s value; NaN when the kind has no such field.</summary>
        public double Get(string name)
        {
            var i = GenexFastRecords.IndexOf(Kind, name);
            return i >= 0 && Values != null && i < Values.Length ? Values[i] : double.NaN;
        }

        /// <summary>Sets field <paramref name="name"/> (a name the kind lacks is ignored).</summary>
        public void Set(string name, double value)
        {
            var i = GenexFastRecords.IndexOf(Kind, name);
            if (i >= 0 && Values != null && i < Values.Length) Values[i] = value;
        }
    }

    /// <summary>The motion record codec (§17.12 *Motion records*).</summary>
    public static class GenexFastRecords
    {
        /// <summary>A record field: its name (the schema field it carries) and how it is written.</summary>
        public struct Field
        {
            public readonly string Name;
            public readonly GenexFieldWire Wire;

            public Field(string name, GenexFieldWire wire)
            {
                Name = name;
                Wire = wire;
            }
        }

        /// <summary>The entity record's fields, bit i of the mask naming field i. Appended only, never reordered.</summary>
        public static readonly Field[] EntityFields =
        {
            new Field("x", GenexFieldWire.F32),
            new Field("y", GenexFieldWire.F32),
            new Field("z", GenexFieldWire.F32),
            new Field("vx", GenexFieldWire.F32),
            new Field("vy", GenexFieldWire.F32),
            new Field("vz", GenexFieldWire.F32),
            new Field("yaw", GenexFieldWire.F32),
            new Field("pitch", GenexFieldWire.F32),
            new Field("duck", GenexFieldWire.F32),
            new Field("spin", GenexFieldWire.F32),
            new Field("fuel", GenexFieldWire.F32),
            new Field("epoch", GenexFieldWire.U32),
            new Field("mstate", GenexFieldWire.U32),
            new Field("qx", GenexFieldWire.Orientation),
            new Field("qy", GenexFieldWire.Orientation),
            new Field("qz", GenexFieldWire.Orientation),
            new Field("qw", GenexFieldWire.Orientation),
            new Field("lvx", GenexFieldWire.Velocity),
            new Field("lvy", GenexFieldWire.Velocity),
            new Field("lvz", GenexFieldWire.Velocity),
            new Field("avx", GenexFieldWire.Velocity),
            new Field("avy", GenexFieldWire.Velocity),
            new Field("avz", GenexFieldWire.Velocity),
            new Field("sleep", GenexFieldWire.Flag),
            new Field("rest", GenexFieldWire.U16),
        };

        /// <summary>The seat record's fields, bit i naming field i. Appended only.</summary>
        public static readonly Field[] SeatFields =
        {
            new Field("inMoveX", GenexFieldWire.F32),
            new Field("inMoveY", GenexFieldWire.F32),
            new Field("inMoveZ", GenexFieldWire.F32),
            new Field("inYaw", GenexFieldWire.F32),
            new Field("inPitch", GenexFieldWire.F32),
            new Field("inButtons", GenexFieldWire.U32),
            new Field("inRep", GenexFieldWire.U32),
            new Field("inStarve", GenexFieldWire.U32),
            new Field("inBuf", GenexFieldWire.U32),
            new Field("inAck", GenexFieldWire.U32),
        };

        /// <summary>The seat field that is no schema field: the receiving seat's own consumed-input ack.</summary>
        public const string SeatAckField = "inAck";

        /// <summary>The longest id a record carries, in characters (UTF-16 code units, as the TypeScript counts them).</summary>
        public const int RecordIdMaxChars = 64;

        private const int Head = 2;
        private const int MaskBytes = 4;
        private const double Uint32Max = 4294967295.0;
        private const double Uint16Max = 65535;
        /// <summary>The schema's clamp span on a symmetric range: 2^16 − 2, so 0 lands on a step (code 32767).</summary>
        private const int QSpan = 65534;
        private const int QZero = QSpan / 2;

        private static readonly UTF8Encoding Utf8Strict = new UTF8Encoding(false, true);
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, false);

        /// <summary>The field table of record kind <paramref name="kind"/>, else null.</summary>
        public static Field[] FieldsOf(int kind)
        {
            if (kind == GenexMotionRecordKind.Entity) return EntityFields;
            if (kind == GenexMotionRecordKind.Seat) return SeatFields;
            return null;
        }

        /// <summary>The index of field <paramref name="name"/> in kind <paramref name="kind"/>'s table, else −1.</summary>
        public static int IndexOf(int kind, string name)
        {
            var fields = FieldsOf(kind);
            if (fields == null) return -1;
            for (var i = 0; i < fields.Length; i++)
                if (fields[i].Name == name) return i;
            return -1;
        }

        private static double HalfOf(GenexFieldWire wire) => wire == GenexFieldWire.Orientation ? 1 : 64;

        /// <summary>The schema's quantize on a symmetric clamped range of half-width <paramref name="half"/>: the uint16 code.</summary>
        public static int QuantizeCode(double half, double value)
        {
            var v = Math.Min(half, Math.Max(-half, value));
            return (int)Math.Floor((v + half) / (2 * half) * QSpan + 0.5);
        }

        /// <summary>The schema's dequantize: the float a decoder reads for <paramref name="code"/>.</summary>
        public static double DequantizeCode(double half, int code) => -half + code / (double)QSpan * (2 * half);

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        private static bool IsUint(double v, double max) => IsFinite(v) && v == Math.Floor(v) && v >= 0 && v <= max;

        private static int Width(GenexFieldWire wire)
        {
            switch (wire)
            {
                case GenexFieldWire.F32:
                case GenexFieldWire.U32:
                    return 4;
                case GenexFieldWire.Flag:
                    return 0;
                default:
                    return 2;
            }
        }

        /// <summary>The wire value of one field: false when it cannot be written; <paramref name="present"/> false when
        /// it is at its default (left out).</summary>
        private static bool WireValue(GenexFieldWire wire, double v, out double value, out bool present)
        {
            value = 0;
            present = false;
            switch (wire)
            {
                case GenexFieldWire.F32:
                {
                    var f = (float)v;
                    if (float.IsNaN(f) || float.IsInfinity(f)) return false;
                    value = f;
                    present = f != 0;
                    return true;
                }
                case GenexFieldWire.U32:
                    if (!IsUint(v, Uint32Max)) return false;
                    value = v;
                    present = v != 0;
                    return true;
                case GenexFieldWire.U16:
                    if (!IsUint(v, Uint16Max)) return false;
                    value = v;
                    present = v != 0;
                    return true;
                case GenexFieldWire.Flag:
                    if (v != 0 && v != 1) return false;
                    value = v;
                    present = v == 1;
                    return true;
                default:
                {
                    if (double.IsNaN(v)) return false;
                    var code = QuantizeCode(HalfOf(wire), v);
                    value = code;
                    present = code != QZero;
                    return true;
                }
            }
        }

        /// <summary>The record's bytes (§17.12 *Motion records*); refuses (<c>field</c>) what it cannot carry.</summary>
        public static GenexFastResult<byte[]> EncodeRecord(GenexMotionRecord r)
        {
            var refuse = GenexFastResult<byte[]>.Fail(GenexFastFault.Field);
            var fields = r == null ? null : FieldsOf(r.Kind);
            if (fields == null || r.Id == null || r.Values == null || r.Values.Length != fields.Length) return refuse;
            var id = Utf8.GetBytes(r.Id);
            var idOk = r.Id.Length >= 1 && r.Id.Length <= RecordIdMaxChars && id.Length <= 0xff;
            if (!idOk) return refuse;
            var values = new double[fields.Length];
            uint mask = 0;
            var size = Head + id.Length + MaskBytes;
            for (var i = 0; i < fields.Length; i++)
            {
                if (!WireValue(fields[i].Wire, r.Values[i], out var value, out var present)) return refuse;
                if (!present) continue;
                mask |= 1u << i;
                values[i] = value;
                size += Width(fields[i].Wire);
            }
            var out_ = new byte[size];
            out_[0] = (byte)r.Kind;
            out_[1] = (byte)id.Length;
            Array.Copy(id, 0, out_, Head, id.Length);
            var at = Head + id.Length;
            GenexFastTransport.WriteU32(out_, at, mask);
            at += MaskBytes;
            for (var i = 0; i < fields.Length; i++)
            {
                if ((mask & (1u << i)) == 0) continue;
                var wire = fields[i].Wire;
                if (wire == GenexFieldWire.F32) GenexFastTransport.WriteF32(out_, at, values[i]);
                else if (wire == GenexFieldWire.U32) GenexFastTransport.WriteU32(out_, at, (uint)values[i]);
                else if (wire != GenexFieldWire.Flag) GenexFastTransport.WriteU16(out_, at, (uint)values[i]);
                at += Width(wire);
            }
            return GenexFastResult<byte[]>.Of(out_);
        }

        /// <summary>One field read back: its value, or the fault that drops the record (null: read).</summary>
        private static string ReadField(byte[] b, int at, GenexFieldWire wire, out double value)
        {
            value = 0;
            if (at + Width(wire) > b.Length) return GenexFastFault.Truncated;
            switch (wire)
            {
                case GenexFieldWire.Flag:
                    value = 1;
                    return null;
                case GenexFieldWire.F32:
                {
                    var f = GenexFastTransport.F32(b, at);
                    if (float.IsNaN(f) || float.IsInfinity(f) || f == 0) return GenexFastFault.Field;
                    value = f;
                    return null;
                }
                case GenexFieldWire.U32:
                {
                    var v = GenexFastTransport.U32(b, at);
                    if (v == 0) return GenexFastFault.Field;
                    value = v;
                    return null;
                }
                case GenexFieldWire.U16:
                {
                    var v = GenexFastTransport.U16(b, at);
                    if (v == 0) return GenexFastFault.Field;
                    value = v;
                    return null;
                }
                default:
                {
                    int code = GenexFastTransport.U16(b, at);
                    var canonical = code != QZero && code <= QSpan;
                    if (!canonical) return GenexFastFault.Field;
                    value = DequantizeCode(HalfOf(wire), code);
                    return null;
                }
            }
        }

        private static string ReadId(byte[] b, out string id)
        {
            id = null;
            int len = b[1];
            if (Head + len > b.Length) return GenexFastFault.Truncated;
            if (len == 0) return GenexFastFault.Field;
            try
            {
                id = Utf8Strict.GetString(b, Head, len);
            }
            catch (ArgumentException)
            {
                return GenexFastFault.Field;
            }
            // TextDecoder (the reference) drops a leading byte order mark.
            if (id.Length > 0 && id[0] == '﻿') id = id.Substring(1);
            return id.Length <= RecordIdMaxChars ? null : GenexFastFault.Field;
        }

        /// <summary>Reads one record to the byte; any fault drops it (the client leaves that id as it was). Every field
        /// left out reads as its default.</summary>
        public static GenexFastResult<GenexMotionRecord> DecodeRecord(byte[] bytes)
        {
            if (bytes.Length < Head) return GenexFastResult<GenexMotionRecord>.Fail(GenexFastFault.Truncated);
            var fields = FieldsOf(bytes[0]);
            if (fields == null) return GenexFastResult<GenexMotionRecord>.Fail(GenexFastFault.Kind);
            var idFault = ReadId(bytes, out var id);
            if (idFault != null) return GenexFastResult<GenexMotionRecord>.Fail(idFault);
            var at = Head + bytes[1];
            if (at + MaskBytes > bytes.Length) return GenexFastResult<GenexMotionRecord>.Fail(GenexFastFault.Truncated);
            var mask = GenexFastTransport.U32(bytes, at);
            at += MaskBytes;
            if (fields.Length < 32 && (mask >> fields.Length) != 0) return GenexFastResult<GenexMotionRecord>.Fail(GenexFastFault.Flags);
            var record = GenexMotionRecord.Blank(bytes[0], id);
            for (var i = 0; i < fields.Length; i++)
            {
                if ((mask & (1u << i)) == 0) continue;
                var fault = ReadField(bytes, at, fields[i].Wire, out var value);
                if (fault != null) return GenexFastResult<GenexMotionRecord>.Fail(fault);
                record.Values[i] = value;
                at += Width(fields[i].Wire);
            }
            if (at != bytes.Length) return GenexFastResult<GenexMotionRecord>.Fail(GenexFastFault.Trailing);
            return GenexFastResult<GenexMotionRecord>.Of(record);
        }
    }
}
