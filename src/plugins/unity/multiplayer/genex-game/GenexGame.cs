// Written by Genex. The game's own project on Genex, wherever the build runs, so a build made before
// the game's first publish still joins the right rooms once it is published:
//   1. Genex's Play names it (GENEX_GAME) when it starts a Mac, Windows or Linux build;
//   2. the published web page names it (window.__GENEX__.slug, read by GenexGame.jslib);
//   3. Assets/Resources/GenexSettings.json names it everywhere else (the editor, a build started by
//      hand), once unity__multiplayer was given the slug after the first publish.
// Null means nothing names it yet: the game is not published, so keep playing offline.
using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Genex.Multiplayer.Unity
{
    public static class GenexGame
    {
        /// <summary>The environment variable Genex's Play names the game in.</summary>
        public const string GameEnv = "GENEX_GAME";
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
#endif

        /// <summary>The game's slug on Genex: Play's, the page's, then GenexSettings.json's; null before its first publish.</summary>
        public static string Slug => Clean(FromLauncher()) ?? Clean(FromPage()) ?? Clean(ReadSettings()?.slug);

        /// <summary>Genex's API for GenexNativeIdentity. When Play starts the game, its own address (GENEX_API_URL) replaces it.</summary>
        public static string ApiUrl => Clean(ReadSettings()?.apiUrl) ?? DefaultApiUrl;

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
