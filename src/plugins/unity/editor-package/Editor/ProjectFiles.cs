using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace Genex.Unity
{
    /// <summary>Project-owned file access, with link and optimistic-concurrency boundaries.</summary>
    public static class ProjectFiles
    {
        public const int MaximumTextBytes = 512 * 1024;
        public static string Root => Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        public static string ProjectId => HashBytes(Encoding.UTF8.GetBytes(
            Path.DirectorySeparatorChar == '\\' ? Root.Replace('\\', '/').ToLowerInvariant() : Root));

        public static string Resolve(string relative, string prefix = "Assets") => ResolveAt(Root, relative, prefix);

        /// <summary>The same boundary over an explicit fixture root; never exposed as a bridge parameter.</summary>
        public static string ResolveAt(string root, string relative, string prefix = "Assets")
        {
            if (string.IsNullOrWhiteSpace(relative) || relative.Length > 1024 || relative.Contains('\\') ||
                relative.Contains(':') || relative.StartsWith("/", StringComparison.Ordinal))
                throw new BridgeException("invalid_path", "Use a project-relative path with forward slashes");
            var parts = relative.Split('/');
            if (parts[0] != prefix || parts.Length < 2 || parts.Any(UnsafeSegment))
                throw new BridgeException("invalid_path", "Path must stay under " + prefix + " with ordinary file names");
            var absolute = Path.GetFullPath(Path.Combine(root, relative));
            var allowed = Path.Combine(Path.GetFullPath(root), prefix) + Path.DirectorySeparatorChar;
            if (!absolute.StartsWith(allowed, Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                throw new BridgeException("invalid_path", "Path escapes its project root");
            AssertNoLinks(absolute);
            return absolute;
        }

        static bool UnsafeSegment(string segment)
        {
            if (segment.Length == 0 || segment.StartsWith(".", StringComparison.Ordinal) ||
                segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal) ||
                segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return true;
            var stem = segment.Split('.')[0].ToUpperInvariant();
            return stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
                (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)) &&
                 stem[3] >= '1' && stem[3] <= '9');
        }

        public static void AssertNoLinks(string path)
        {
            for (var current = Path.GetFullPath(path); current != null; current = Path.GetDirectoryName(current))
            {
                try
                {
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                        throw new BridgeException("invalid_path", "Linked files or folders are refused");
                }
                catch (FileNotFoundException) { }
                catch (DirectoryNotFoundException) { }
            }
        }

        public static string Hash(string file)
        {
            AssertNoLinks(file);
            using (var stream = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var algorithm = SHA256.Create()) return Hex(algorithm.ComputeHash(stream));
        }
        public static string HashBytes(byte[] data)
        {
            using (var algorithm = SHA256.Create()) return Hex(algorithm.ComputeHash(data));
        }
        static string Hex(byte[] data) => string.Concat(data.Select(b => b.ToString("x2")));

        public static void Write(string relative, string text, string expectedSha256)
            => WriteAt(Root, relative, text, expectedSha256);

        /// <summary>Atomic optimistic write over an owned root, shared by production and path-boundary tests.</summary>
        public static void WriteAt(string root, string relative, string text, string expectedSha256)
        {
            var path = ResolveAt(root, relative);
            var bytes = new UTF8Encoding(false, true).GetBytes(text);
            if (bytes.Length > MaximumTextBytes) throw new BridgeException("limit_exceeded", "Text is larger than 512 KiB");
            var exists = File.Exists(path);
            if (exists && (expectedSha256 == null || Hash(path) != expectedSha256))
                throw new BridgeException("stale_file", "Read the current file hash before overwriting it");
            if (!exists && expectedSha256 != null)
                throw new BridgeException("stale_file", "The expected existing file is missing");
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            AssertNoLinks(path);
            var staged = Path.Combine(Path.GetDirectoryName(path), ".genex-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.WriteAllBytes(staged, bytes);
                AssertNoLinks(path);
                if (exists)
                {
                    if (Hash(path) != expectedSha256) throw new BridgeException("stale_file", "The file changed while staging the edit");
                    File.Replace(staged, path, null);
                }
                else File.Move(staged, path);
            }
            finally { if (File.Exists(staged)) File.Delete(staged); }
        }
    }
}
