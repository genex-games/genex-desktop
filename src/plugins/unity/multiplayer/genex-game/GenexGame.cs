// Written by Genex. The game's own project on Genex, wherever the build runs, so a build made before
// the game's first publish still joins the right rooms once it is published:
//   1. Genex's Play names it (GENEX_GAME) when it starts a Mac, Windows or Linux build;
//   2. the published web page names it (window.__GENEX__.slug, read by GenexGame.jslib);
//   3. Assets/Resources/GenexSettings.json names it everywhere else (the editor, a build started by
//      hand), once unity__multiplayer was given the slug after the first publish.
// Null means nothing names it yet: the game is not published, so keep playing offline.
//
// For a server-authoritative room it also names where the room is: Studio's local room
// (genex__room) as LocalRoomUrl, and the published web page's room servers as PageAuthorityUrls, by
// region as PageAuthorityRegions, with the player's home region as PageAuthorityHome (a native build
// reads its own from GenexNativeIdentity.AuthorityUrls, AuthorityRegions and AuthorityHome).
using System;
using System.Runtime.InteropServices;
using Genex.Multiplayer.Authority;
using UnityEngine;

namespace Genex.Multiplayer.Unity
{
    public static class GenexGame
    {
        /// <summary>The environment variable Genex's Play names the game in.</summary>
        public const string GameEnv = "GENEX_GAME";
        /// <summary>The environment variable a build or editor is started with to join Studio's local room.</summary>
        public const string LocalRoomEnv = "GENEX_AUTHORITY_URL";
        private const string SettingsResource = "GenexSettings";
        private const string DefaultApiUrl = "https://api.genex.games";

        [Serializable]
        private sealed class Settings
        {
            public string slug;
            public string apiUrl;
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern string GenexGame_PageSlug();
        [DllImport("__Internal")] private static extern string GenexGame_LocalRoomUrl();
        [DllImport("__Internal")] private static extern string GenexGame_PageAuthorityUrls();
        [DllImport("__Internal")] private static extern string GenexGame_PageAuthorityRegions();
        [DllImport("__Internal")] private static extern string GenexGame_PageAuthorityHome();
#endif

        /// <summary>The game's slug on Genex: Play's, the page's, then GenexSettings.json's; null before its first publish.</summary>
        public static string Slug => Clean(FromLauncher()) ?? Clean(FromPage()) ?? Clean(ReadSettings()?.slug);

        /// <summary>Genex's API for GenexNativeIdentity. When Play starts the game, its own address (GENEX_API_URL) replaces it.</summary>
        public static string ApiUrl => Clean(ReadSettings()?.apiUrl) ?? DefaultApiUrl;

        /// <summary>
        /// Studio's local room (genex__room) when this copy was started into one, else null: GENEX_AUTHORITY_URL in a
        /// native build or the editor, the preview's genex_authority_url (a ws:// loopback room on a loopback page) in
        /// a WebGL build. Join it with no sign-in: the SDK sends a loopback room its local placeholder.
        /// </summary>
        public static string LocalRoomUrl
        {
            get
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                return Clean(GenexGame_LocalRoomUrl());
#else
                try { return Clean(Environment.GetEnvironmentVariable(LocalRoomEnv)); }
                catch (Exception) { return null; }
#endif
            }
        }

        /// <summary>The published web page's room servers (its embed SDK's getAuthorityUrls); empty elsewhere.</summary>
        public static string[] PageAuthorityUrls
        {
            get
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                var lines = GenexGame_PageAuthorityUrls() ?? "";
                return lines.Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
#else
                return Array.Empty<string>();
#endif
            }
        }

        /// <summary>The published web page's room servers by region (its embed SDK's getAuthorityRegions); empty elsewhere.</summary>
        public static GenexAuthorityRegion[] PageAuthorityRegions
        {
            get
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                var lines = (GenexGame_PageAuthorityRegions() ?? "").Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var regions = new System.Collections.Generic.List<GenexAuthorityRegion>();
                foreach (var line in lines)
                {
                    var fields = line.Split(new[] { '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    if (fields.Length < 2) continue;
                    var urls = new string[fields.Length - 1];
                    Array.Copy(fields, 1, urls, 0, urls.Length);
                    regions.Add(new GenexAuthorityRegion(fields[0], urls));
                }
                return regions.ToArray();
#else
                return Array.Empty<GenexAuthorityRegion>();
#endif
            }
        }

        /// <summary>The player's home region the published web page names (its embed SDK's getAuthorityHome), one of
        /// <see cref="PageAuthorityRegions"/>; null elsewhere or where the page names none.</summary>
        public static string PageAuthorityHome
        {
            get
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                return Clean(GenexGame_PageAuthorityHome());
#else
                return null;
#endif
            }
        }

        private static string Clean(string value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

        private static string FromLauncher()
        {
            try { return Environment.GetEnvironmentVariable(GameEnv); }
            catch (Exception) { return null; }
        }

        private static string FromPage()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return GenexGame_PageSlug();
#else
            return null;
#endif
        }

        private static Settings ReadSettings()
        {
            var file = Resources.Load<TextAsset>(SettingsResource);
            return file ? JsonUtility.FromJson<Settings>(file.text) : null;
        }
    }
}
