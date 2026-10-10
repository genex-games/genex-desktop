using System;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace Genex.Unity
{
    internal static class CaptureTools
    {
        public static JToken Camera(JObject p)
        {
            var target = Args.GameObject(p).GetComponent<Camera>();
            if (!target) throw new BridgeException("invalid_argument", "Object has no Camera component");
            if (EditorUtility.IsPersistent(target)) throw new BridgeException("invalid_argument", "Capture requires a camera in a loaded scene, not a prefab asset");
            return Render(target, p);
        }
        public static JToken Scene(JObject p)
        {
            var scene = SceneView.lastActiveSceneView;
            if (!scene || !scene.camera) throw new BridgeException("invalid_state", "Open a Scene view before capturing it");
            return Render(scene.camera, p);
        }
        static JToken Render(Camera camera, JObject p)
        {
            if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null)
                throw new BridgeException("graphics_unavailable", "Capture needs an Editor session with a graphics device");
            var width = Args.Number(p, "width", 640, 64, 1920);
            var height = Args.Number(p, "height", 360, 64, 1080);
            var output = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
            Texture2D texture = null;
            var oldTarget = camera.targetTexture;
            var oldActive = RenderTexture.active;
            try
            {
                texture = new Texture2D(width, height, TextureFormat.RGB24, false);
                if (!output.Create()) throw new BridgeException("graphics_unavailable", "Unity could not allocate the capture render target");
                if (GraphicsSettings.currentRenderPipeline)
                {
                    var request = new RenderPipeline.StandardRequest { destination = output };
                    if (!RenderPipeline.SupportsRenderRequest(camera, request))
                        throw new BridgeException("unsupported_capture", "This camera/pipeline does not support a standard render request. URP capture requires a base camera");
                    RenderPipeline.SubmitRenderRequest(camera, request);
                }
                else { camera.targetTexture = output; camera.Render(); }
                RenderTexture.active = output;
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply();
                var png = texture.EncodeToPNG();
                if (png.Length > 2 * 1024 * 1024) throw new BridgeException("limit_exceeded", "Capture exceeds 2 MiB; use a smaller resolution");
                return new JObject { ["mimeType"] = "image/png", ["base64"] = Convert.ToBase64String(png),
                    ["width"] = width, ["height"] = height, ["camera"] = Args.Id(camera.gameObject) };
            }
            finally
            {
                camera.targetTexture = oldTarget;
                RenderTexture.active = oldActive;
                if (texture) UnityEngine.Object.DestroyImmediate(texture);
                UnityEngine.Object.DestroyImmediate(output);
            }
        }
    }
}
