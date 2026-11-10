// Genex multiplayer quickstart: drop on an empty GameObject, press Play in two editors/builds.
// You move with WASD; every other player is a cube interpolated on its sender's clock.
// Unverified outside Unity (no Unity on the machine that wrote it).
using System.Collections.Generic;
using System.Threading.Tasks;
using Genex.Multiplayer;
using Genex.Multiplayer.Unity;
using UnityEngine;

public sealed class GenexQuickstart : MonoBehaviour
{
    [Tooltip("Relay URL. Ignored in WebGL builds, which use the page's relay list.")]
    public string relayUrl = "ws://127.0.0.1:2567";
    [Tooltip("Your game's slug (must equal the embed token's slug).")]
    public string gameId = "my-game";
    [Tooltip("Native builds: the Genex API, for a guest token. Empty = no token (local bench relay only).")]
    public string apiUrl = "";
    public float speed = 5f;

    private GenexSession session;
    private readonly Dictionary<string, GameObject> avatars = new Dictionary<string, GameObject>();
    private float publishTimer;

    private async void Start()
    {
        var options = new GenexConnectOptions { Url = relayUrl, GameId = gameId, Name = "unity-" + Random.Range(100, 999) };
        if (GenexWebGL.Available)
        {
            var auth = await GenexWebGL.RequestAuth();          // waits for the page's identity
            options.Url = null;
            options.Urls = auth.RelayUrls;
            options.GetEmbedToken = GenexWebGL.EmbedToken;        // fresh token per join
        }
        else if (!string.IsNullOrEmpty(apiUrl))
        {
            var identity = new GenexNativeIdentity(apiUrl, gameId);
            var ticket = GenexNativeIdentity.TakeLaunchTicket();  // launched by Genex?
            if (ticket != null) await identity.RedeemTicket(ticket);
            else await identity.SignInAsGuest();
            options.GetEmbedToken = identity.TokenProvider;
            if (identity.RelayUrls.Length > 0) { options.Url = null; options.Urls = identity.RelayUrls; }
        }

        try
        {
            session = GenexPump.Register(await GenexMultiplayer.Connect(options));
        }
        catch (GenexJoinException e)
        {
            Debug.LogError(e.ProtocolUnsupported ? "This game needs an update (relay protocol)." : "Join refused: " + e.Message);
            return;
        }
        session.PlayerLeft += id => { if (avatars.TryGetValue(id, out var go)) { Destroy(go); avatars.Remove(id); } };
        session.ChatReceived += m => Debug.Log($"[chat] {m.Name}: {m.Text}");
        session.Reconnecting += (attempt, code) => Debug.Log($"reconnecting… (attempt {attempt}, code {code})");
        session.Disconnected += code => Debug.Log("disconnected: " + code);
        session.SendChat("hello from Unity");
    }

    private void Update()
    {
        if (session == null || session.IsClosed) return;

        // Move yourself locally; publish on a fixed ~15 Hz tick, never every frame (§6.1).
        var input = new Vector3(Input.GetAxis("Horizontal"), 0, Input.GetAxis("Vertical"));
        transform.position += input * speed * Time.deltaTime;
        publishTimer += Time.deltaTime;
        if (publishTimer >= 1f / 15f)
        {
            publishTimer = 0;
            var p = transform.position;
            session.SetState(new Dictionary<string, object> { ["x"] = (double)p.x, ["y"] = (double)p.y, ["z"] = (double)p.z });
        }

        // Render everyone else from the smoothed State (GenexPump already ticked the session this frame).
        foreach (var player in session.Players.Values)
        {
            if (player.IsMe) continue;
            if (!avatars.TryGetValue(player.Id, out var go))
            {
                go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                go.name = player.Name;
                avatars[player.Id] = go;
            }
            var s = player.State;
            go.transform.position = new Vector3(
                (float)GenexJson.Num(s, "x"), (float)GenexJson.Num(s, "y"), (float)GenexJson.Num(s, "z"));
        }
    }

    private void OnDestroy()
    {
        if (session != null) _ = session.Leave();
    }
}
