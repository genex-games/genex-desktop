#!/usr/bin/env node
/**
 * Builds the realism test scene (realism_scene.py's export) in an open Roblox Studio through
 * Studio's own MCP server, StudioMCP, and saves viewport screenshots of two looks:
 *
 *   today_<shot>.jpg      what Genex makes now: shape-only meshes in one flat colour each, under
 *                         the place's own lighting (Genex's template: Soft lighting, no effects)
 *   realistic_<shot>.jpg  the same meshes with PBR SurfaceAppearances (colour, normal, roughness,
 *                         metalness) under Realistic lighting, atmosphere, clouds and post effects
 *
 * Nothing reaches the Roblox account: meshes become EditableMesh-backed MeshParts and textures
 * EditableImages, which exist only in this Studio session. Nothing is saved or published.
 *
 * node studio_build.mjs <export-dir> <place-name-part> <shots-dir> [options]
 *   --mcp <path>       StudioMCP (default /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP)
 *   --step <name>      probe | today | realistic | all (default all; today and realistic rebuild)
 *   --chunk <chars>    base64 characters per execute_luau call (default: the probe's choice)
 *   --settle <ms>      wait after moving the camera, before a capture (default 3500)
 *   --quality <n>      Studio edit quality level for the shots, 1..21 (default 21; restored after)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_MCP = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 5 * 60 * 1000;
const JOIN_TIMEOUT_MS = 90 * 1000;
const PROBE_SIZES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
const MAX_CHUNK = 4 * 1024 * 1024;
const MARK = "GX:";

const [exportDir, placePart, shotsDir, ...rest] = process.argv.slice(2);
if (!exportDir || !placePart || !shotsDir) {
  console.error("usage: node studio_build.mjs <export-dir> <place-name-part> <shots-dir> [--step all] [--mcp path]");
  process.exit(2);
}
const option = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : fallback;
};
const STEP = option("step", "all");
const MCP = option("mcp", DEFAULT_MCP);
const SETTLE_MS = Number(option("settle", "3500"));
const QUALITY = Number(option("quality", "21"));
let chunkChars = option("chunk") ? Number(option("chunk")) : 0;

const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, "manifest.json"), "utf8"));
fs.mkdirSync(shotsDir, { recursive: true });
const report = { started: new Date().toISOString(), step: STEP, place: placePart, calls: 0, sent: 0, shots: [] };
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ---------------------------------------------------------------- StudioMCP client (stdio JSON-RPC)

const child = spawn(MCP, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: os.userInfo().homedir } });
const pending = new Map();
let nextId = 0;
let lineBuffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  lineBuffer += chunk;
  for (let at = lineBuffer.indexOf("\n"); at >= 0; at = lineBuffer.indexOf("\n")) {
    const line = lineBuffer.slice(0, at).trim();
    lineBuffer = lineBuffer.slice(at + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method) {
      if (message.id !== undefined) send({ id: message.id, result: {} });
      continue;
    }
    const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`StudioMCP: ${JSON.stringify(message.error)}`));
    else waiter.resolve(message.result);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (text) => fs.appendFileSync(path.join(shotsDir, "studiomcp-stderr.log"), text));
child.on("exit", (code, signal) => {
  for (const waiter of pending.values()) waiter.reject(new Error(`StudioMCP exited (${code ?? signal})`));
  pending.clear();
});

function send(message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => (clearTimeout(timer), resolve(value)),
      reject: (error) => (clearTimeout(timer), reject(error)),
    });
    send({ id, method, params });
  });
}

const callTool = (name, args, timeoutMs) => request("tools/call", { name, arguments: args }, timeoutMs);
const textOf = (result) =>
  (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

async function pickStudio() {
  const deadline = Date.now() + JOIN_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const listed = await callTool("list_roblox_studios", {}, 15000).catch((error) => ({ error }));
    last = listed.error ? String(listed.error) : textOf(listed);
    let studios = [];
    try {
      studios = JSON.parse(last).studios ?? [];
    } catch {}
    const found = studios.filter((studio) => typeof studio.name === "string" && studio.name.includes(placePart));
    if (found.length > 1) throw new Error(`two Studios have "${placePart}" open: ${last}`);
    if (found[0]) return found[0];
    await sleep(1000);
  }
  throw new Error(`no Studio with "${placePart}" open; last listing: ${last}`);
}

// ---------------------------------------------------------------- the Luau side

/** Defined again on every call (cheap); its state lives in _G.__gx between calls. */
const PRELUDE = String.raw`
local gx = _G.__gx
if type(gx) ~= "table" then
	gx = { blobs = {}, images = {}, meshes = {}, calls = 0 }
	_G.__gx = gx
end
gx.calls += 1
local AssetService = game:GetService("AssetService")
local HttpService = game:GetService("HttpService")
local Lighting = game:GetService("Lighting")

local function reply(value)
	local text = "${MARK}" .. HttpService:JSONEncode(value)
	print(text)
	return text
end

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function luauBase64(s)
	local dec = {}
	for i = 1, 64 do
		dec[string.byte(B64, i)] = i - 1
	end
	dec[61] = 0
	local n = #s
	local pad = 0
	if n >= 1 and string.byte(s, n) == 61 then pad += 1 end
	if n >= 2 and string.byte(s, n - 1) == 61 then pad += 1 end
	local out = buffer.create((n // 4) * 3)
	local o = 0
	for i = 1, n - 3, 4 do
		local a, b, c, d = string.byte(s, i, i + 3)
		local x = dec[a] * 262144 + dec[b] * 4096 + dec[c] * 64 + dec[d]
		buffer.writeu8(out, o, x // 65536)
		buffer.writeu8(out, o + 1, (x // 256) % 256)
		buffer.writeu8(out, o + 2, x % 256)
		o += 3
	end
	if pad == 0 then return out end
	local trimmed = buffer.create(o - pad)
	buffer.copy(trimmed, 0, out, 0, o - pad)
	return trimmed
end

local function base64(s)
	local found, service = pcall(game.GetService, game, "EncodingService")
	if found and service then
		local ok, out = pcall(function()
			return service:Base64Decode(buffer.fromstring(s))
		end)
		if ok and out then return out end
	end
	return luauBase64(s)
end

function gx.put(key, index, count, chunk)
	local entry = gx.blobs[key]
	if index == 1 or not entry then
		entry = { count = count, parts = {} }
		gx.blobs[key] = entry
	end
	entry.parts[index] = chunk
end

function gx.take(key)
	local entry = gx.blobs[key]
	if not entry then error("no data for " .. key) end
	for i = 1, entry.count do
		if not entry.parts[i] then error(("part %d of %s is missing"):format(i, key)) end
	end
	gx.blobs[key] = nil
	return base64(table.concat(entry.parts))
end

local function folder()
	local found = workspace:FindFirstChild("GxRealism")
	if found then return found end
	local made = Instance.new("Folder")
	made.Name = "GxRealism"
	made.Parent = workspace
	return made
end

local function vec3(data, at)
	return Vector3.new(buffer.readf32(data, at), buffer.readf32(data, at + 4), buffer.readf32(data, at + 8))
end

-- GXM1: "GXM1", u32 vertices, u32 triangles, f32 positions*3, normals*3, uvs*2, u32 triangles*3.
local function buildMesh(data)
	assert(buffer.readstring(data, 0, 4) == "GXM1", "not a GXM1 mesh")
	local vertices, triangles = buffer.readu32(data, 4), buffer.readu32(data, 8)
	local normalsAt = 12 + vertices * 12
	local uvsAt = normalsAt + vertices * 12
	local trianglesAt = uvsAt + vertices * 8
	assert(buffer.len(data) == trianglesAt + triangles * 12, "mesh size mismatch")
	local mesh = AssetService:CreateEditableMesh()
	local ids, normals, uvs = {}, {}, {}
	for i = 0, vertices - 1 do
		ids[i + 1] = mesh:AddVertex(vec3(data, 12 + i * 12))
		normals[i + 1] = mesh:AddNormal(vec3(data, normalsAt + i * 12))
		local at = uvsAt + i * 8
		uvs[i + 1] = mesh:AddUV(Vector2.new(buffer.readf32(data, at), buffer.readf32(data, at + 4)))
	end
	for t = 0, triangles - 1 do
		local at = trianglesAt + t * 12
		local a = buffer.readu32(data, at) + 1
		local b = buffer.readu32(data, at + 4) + 1
		local c = buffer.readu32(data, at + 8) + 1
		if a ~= b and b ~= c and a ~= c then
			local face = mesh:AddTriangle(ids[a], ids[b], ids[c])
			mesh:SetFaceNormals(face, { normals[a], normals[b], normals[c] })
			mesh:SetFaceUVs(face, { uvs[a], uvs[b], uvs[c] })
		end
	end
	return mesh
end

function gx.part(spec)
	local mesh = buildMesh(gx.take(spec.blob))
	local content = Content.fromObject(mesh)
	local ok, part = pcall(function()
		return AssetService:CreateMeshPartAsync(content, {
			CollisionFidelity = Enum.CollisionFidelity.Box,
			RenderFidelity = Enum.RenderFidelity.Precise,
		})
	end)
	if not ok then
		part = AssetService:CreateMeshPartAsync(content)
	end
	gx.meshes[spec.name] = mesh
	part.Name = spec.name
	part.Anchored = true
	part.Material = Enum.Material.Plastic
	part.Color = Color3.new(spec.average[1], spec.average[2], spec.average[3])
	part.Transparency = spec.transparency or 0
	part.CastShadow = spec.castShadow
	part.CFrame = CFrame.Angles(0, spec.yaw, 0) * CFrame.new(spec.centre[1], spec.centre[2], spec.centre[3])
	part:SetAttribute("GxMaterial", spec.material)
	part.Parent = folder()
	return { name = part.Name, size = { part.Size.X, part.Size.Y, part.Size.Z } }
end

local MAP_PROPERTY = {
	color = "ColorMapContent",
	normal = "NormalMapContent",
	roughness = "RoughnessMapContent",
	metalness = "MetalnessMapContent",
}

local function rgba(raw, width, height, channels)
	local count = width * height
	assert(buffer.len(raw) == count * channels, "texture size mismatch")
	if channels == 4 then return raw end
	local out = buffer.create(count * 4)
	if channels == 1 then
		for i = 0, count - 1 do
			buffer.writeu32(out, i * 4, 0xFF000000 + buffer.readu8(raw, i) * 0x010101)
		end
		return out
	end
	-- Each pixel reads four bytes (its RGB and the next pixel's R); the last one is copied by byte.
	for i = 0, count - 2 do
		buffer.writeu32(out, i * 4, bit32.bor(bit32.band(buffer.readu32(raw, i * 3), 0xFFFFFF), 0xFF000000))
	end
	local last = count - 1
	for k = 0, 2 do
		buffer.writeu8(out, last * 4 + k, buffer.readu8(raw, last * 3 + k))
	end
	buffer.writeu8(out, last * 4 + 3, 255)
	return out
end

function gx.texture(spec)
	local size = Vector2.new(spec.width, spec.height)
	local pixels = rgba(gx.take(spec.blob), spec.width, spec.height, spec.channels)
	local image = AssetService:CreateEditableImage({ Size = size })
	image:WritePixelsBuffer(Vector2.zero, size, pixels)
	gx.images[spec.blob] = image
	gx.byMaterial = gx.byMaterial or {}
	gx.byMaterial[spec.material] = gx.byMaterial[spec.material] or {}
	gx.byMaterial[spec.material][spec.map] = image
	local content = Content.fromObject(image)
	local property = MAP_PROPERTY[spec.map]
	local used, failure = 0, nil
	-- One SurfaceAppearance per part, holding its material's maps.
	for _, part in folder():GetChildren() do
		if part:GetAttribute("GxMaterial") == spec.material then
			local look = part:FindFirstChildOfClass("SurfaceAppearance")
			if not look then
				look = Instance.new("SurfaceAppearance")
				look.Parent = part
			end
			local ok, problem = pcall(function()
				look[property] = content
			end)
			if ok then
				used += 1
			else
				failure = tostring(problem)
			end
		end
	end
	return { blob = spec.blob, parts = used, failure = failure }
end

-- Counts the parts that wear a SurfaceAppearance and its maps. With remake, a material whose maps
-- could not be set one by one gets AssetService:CreateSurfaceAppearanceAsync from its kept images.
function gx.dress(remake)
	local looks, maps, remade, failure = 0, 0, 0, nil
	for _, part in folder():GetChildren() do
		local material = part:GetAttribute("GxMaterial")
		local kept = material and gx.byMaterial and gx.byMaterial[material]
		if remake and kept then
			local ok, made = pcall(function()
				local contents = {}
				for map, image in kept do
					contents[(MAP_PROPERTY[map]):gsub("Content$", "")] = Content.fromObject(image)
				end
				return AssetService:CreateSurfaceAppearanceAsync(contents)
			end)
			if ok then
				local old = part:FindFirstChildOfClass("SurfaceAppearance")
				if old then old:Destroy() end
				made.Parent = part
				remade += 1
			else
				failure = tostring(made)
			end
		end
		local look = part:FindFirstChildOfClass("SurfaceAppearance")
		if look then
			looks += 1
			for _, property in MAP_PROPERTY do
				local ok, has = pcall(function()
					return look[property].SourceType ~= Enum.ContentSourceType.None
				end)
				if ok and has then maps += 1 end
			end
		end
	end
	return { looks = looks, maps = maps, remade = remade, failure = failure }
end

function gx.reset()
	local old = workspace:FindFirstChild("GxRealism")
	if old then old:Destroy() end
	for _, name in { "Baseplate", "SpawnLocation" } do
		local found = workspace:FindFirstChild(name)
		if found then found:Destroy() end
	end
	gx.blobs, gx.images, gx.meshes = {}, {}, {}
	return { ok = true }
end

local function azimuth(v)
	return math.atan2(-v.Z, v.X)
end

-- A ClockTime and latitude whose sun has the wanted elevation, and the yaw that turns the scene so
-- the sun's bearing matches too. The place's own clock and latitude are left as they were.
function gx.sun(toSun)
	local want = Vector3.new(toSun[1], toSun[2], toSun[3]).Unit
	local wantElevation = math.asin(want.Y)
	local saved = { Lighting.ClockTime, Lighting.GeographicLatitude }
	local best, lowest, highest = nil, 1, -1
	for _, latitude in { 35, 20, 50, 5, 65 } do
		Lighting.GeographicLatitude = latitude
		for step = 0, 300 do
			local clock = 12 + step * 0.02
			Lighting.ClockTime = clock
			local d = Lighting:GetSunDirection()
			lowest, highest = math.min(lowest, d.Y), math.max(highest, d.Y)
			local miss = math.abs(math.asin(math.clamp(d.Y, -1, 1)) - wantElevation)
			if not best or miss < best.miss then
				best = { miss = miss, clock = clock, latitude = latitude, d = d }
			end
		end
		if best.miss < math.rad(0.5) then break end
	end
	Lighting.ClockTime, Lighting.GeographicLatitude = saved[1], saved[2]
	if highest - lowest < 1e-3 then
		return { clock = 14.5, latitude = 35, yaw = 0, note = "GetSunDirection did not follow ClockTime" }
	end
	return {
		clock = best.clock,
		latitude = best.latitude,
		yaw = azimuth(best.d) - azimuth(want),
		elevationMissDeg = math.deg(best.miss),
		sun = { best.d.X, best.d.Y, best.d.Z },
	}
end

local function child(parent, className, name)
	local found = parent:FindFirstChild(name)
	if found and found.ClassName == className then return found end
	if found then found:Destroy() end
	local made = Instance.new(className)
	made.Name = name
	made.Parent = parent
	return made
end

function gx.realistic(sun, lights)
	local styled = pcall(function()
		Lighting.LightingStyle = Enum.LightingStyle.Realistic
	end)
	pcall(function()
		Lighting.PrioritizeLightingQuality = true
	end)
	local future = pcall(function()
		Lighting.Technology = Enum.Technology.Future
	end)
	Lighting.GlobalShadows = true
	Lighting.Brightness = 3
	Lighting.Ambient = Color3.fromRGB(26, 26, 32)
	Lighting.OutdoorAmbient = Color3.fromRGB(104, 110, 124)
	Lighting.EnvironmentDiffuseScale = 1
	Lighting.EnvironmentSpecularScale = 1
	Lighting.ExposureCompensation = 0.1
	Lighting.ShadowSoftness = 0.1
	Lighting.ColorShift_Top = Color3.fromRGB(255, 238, 216)
	Lighting.ColorShift_Bottom = Color3.fromRGB(0, 0, 0)
	Lighting.ClockTime = sun.clock
	Lighting.GeographicLatitude = sun.latitude

	local air = child(Lighting, "Atmosphere", "GxAtmosphere")
	air.Density, air.Offset, air.Glare, air.Haze = 0.28, 0.12, 0.2, 0.7
	air.Color, air.Decay = Color3.fromRGB(205, 214, 228), Color3.fromRGB(112, 122, 142)
	local grade = child(Lighting, "ColorCorrectionEffect", "GxColor")
	grade.Brightness, grade.Contrast, grade.Saturation = 0.02, 0.12, 0.06
	grade.TintColor = Color3.fromRGB(255, 249, 240)
	local bloom = child(Lighting, "BloomEffect", "GxBloom")
	bloom.Intensity, bloom.Size, bloom.Threshold = 0.35, 28, 1.6
	local rays = child(Lighting, "SunRaysEffect", "GxSunRays")
	rays.Intensity, rays.Spread = 0.035, 0.5
	local depth = child(Lighting, "DepthOfFieldEffect", "GxDepth")
	depth.FarIntensity, depth.FocusDistance, depth.InFocusRadius, depth.NearIntensity = 0.12, 40, 60, 0
	local clouds = child(workspace.Terrain, "Clouds", "GxClouds")
	clouds.Cover, clouds.Density, clouds.Color = 0.48, 0.65, Color3.fromRGB(255, 255, 255)

	for index, light in lights do
		local holder = child(folder(), "Part", "GxLight" .. index)
		holder.Anchored, holder.CanCollide, holder.CastShadow = true, false, false
		holder.Transparency, holder.Size = 1, Vector3.new(0.2, 0.2, 0.2)
		holder.CFrame = CFrame.Angles(0, sun.yaw, 0) * CFrame.new(light.position[1], light.position[2], light.position[3])
		local glow = child(holder, "PointLight", "GxPointLight")
		glow.Color = Color3.fromRGB(light.color[1], light.color[2], light.color[3])
		glow.Brightness, glow.Range, glow.Shadows = light.brightness, light.range, true
	end
	return { lightingStyle = styled, future = future, technology = tostring(Lighting.Technology) }
end

function gx.camera(shot, yaw)
	local turn = CFrame.Angles(0, yaw, 0)
	local eye = turn * Vector3.new(shot.eye[1], shot.eye[2], shot.eye[3])
	local target = turn * Vector3.new(shot.target[1], shot.target[2], shot.target[3])
	local camera = workspace.CurrentCamera
	camera.CFrame = CFrame.lookAt(eye, target)
	camera.Focus = CFrame.new(target)
	camera.FieldOfView = shot.fov
	game:GetService("Selection"):Set({})
	local viewport = camera.ViewportSize
	return { viewport = { viewport.X, viewport.Y } }
end

-- Studio's edit quality level by its Enum.QualityLevel name ("Level21", "Automatic").
function gx.quality(name)
	local ok, result = pcall(function()
		local rendering = settings().Rendering
		rendering.EditQualityLevel = Enum.QualityLevel[name]
		return rendering.EditQualityLevel.Name
	end)
	return { ok = ok, level = tostring(result) }
end

function gx.probe()
	local found, encoding = pcall(game.GetService, game, "EncodingService")
	local decodes = false
	if found and encoding then
		local ok, same = pcall(function()
			return buffer.tostring(encoding:Base64Decode(buffer.fromstring("QUJD"))) == "ABC"
		end)
		decodes = ok and same
	end
	return {
		calls = gx.calls,
		place = game.Name,
		encodingService = decodes,
		luauBase64 = buffer.tostring(luauBase64("QUJD")) == "ABC",
		editableImage = (pcall(function()
			return AssetService:CreateEditableImage({ Size = Vector2.new(4, 4) })
		end)),
		editableMesh = (pcall(function()
			return AssetService:CreateEditableMesh()
		end)),
		lightingStyle = (pcall(function()
			return Lighting.LightingStyle
		end)) and tostring(Lighting.LightingStyle) or "missing",
		technology = tostring(Lighting.Technology),
		clock = Lighting.ClockTime,
		quality = (pcall(function()
			return settings().Rendering.EditQualityLevel
		end)) and settings().Rendering.EditQualityLevel.Name or "unreadable",
	}
end
`;

let studio;
async function luau(body, label) {
  const code = `${PRELUDE}\n${body}`;
  report.calls += 1;
  report.sent += code.length;
  const result = await callTool("execute_luau", { code, datamodel_type: "Edit", studio_id: studio.id });
  const text = textOf(result);
  const answer = marked(text);
  if (result?.isError || answer === undefined) throw new Error(`${label}: ${text.slice(0, 2000)}`);
  return answer;
}

/** The JSON our Luau printed after the mark, found in plain text or inside a JSON-wrapped answer. */
function marked(text) {
  const at = text.lastIndexOf(MARK);
  if (at < 0) return undefined;
  const line = text.slice(at + MARK.length).split("\n")[0];
  for (let end = line.length; end > 0; end = line.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(line.slice(0, end + (line[end] === "}" ? 1 : 0)));
    } catch {}
  }
  try {
    const wrapped = JSON.parse(text);
    const strings = [];
    const walk = (value) => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(wrapped);
    for (const one of strings.reverse()) {
      const found = one.includes(MARK) ? marked(one) : undefined;
      if (found !== undefined) return found;
    }
  } catch {}
  return undefined;
}

const lua = (value) => JSON.stringify(value).replace(/\[/g, "{").replace(/\]/g, "}").replace(/"(\w+)":/g, "$1=");

/** Sends a file as base64 in chunks; the last chunk's call also runs `then`. */
async function sendBlob(key, bytes, then, label) {
  const text = bytes.toString("base64");
  const count = Math.max(1, Math.ceil(text.length / chunkChars));
  let answer;
  for (let index = 1; index <= count; index++) {
    const chunk = text.slice((index - 1) * chunkChars, index * chunkChars);
    const put = `gx.put(${JSON.stringify(key)}, ${index}, ${count}, "${chunk}")`;
    const body = index === count ? `${put}\nreturn reply(${then})` : `${put}\nreturn reply({ ok = true })`;
    answer = await luau(body, `${label} ${index}/${count}`);
  }
  return answer;
}

// ---------------------------------------------------------------- steps

async function probe() {
  const first = await luau("return reply(gx.probe())", "probe");
  const second = await luau("return reply(gx.probe())", "probe again");
  const persists = second.calls > first.calls;
  report.probe = { ...second, persists };
  log("probe", JSON.stringify(report.probe));
  if (!persists) log("warning: _G does not persist between calls; every blob must fit one call");
  if (!chunkChars) {
    let largest = 0;
    for (const size of PROBE_SIZES) {
      const ok = await luau(`local pad = "${"A".repeat(size)}"\nreturn reply({ n = #pad })`, `size ${size}`)
        .then((answer) => answer.n === size)
        .catch((error) => (log(`size ${size} refused:`, String(error).slice(0, 300)), false));
      if (!ok) break;
      largest = size;
    }
    if (!largest) throw new Error("even a 256 KB call was refused");
    chunkChars = Math.min(largest, MAX_CHUNK) - 64 * 1024;
  }
  if (!persists) chunkChars = Number.MAX_SAFE_INTEGER;
  report.chunkChars = chunkChars;
  log("chunk", chunkChars);
}

async function build() {
  await luau("return reply(gx.reset())", "reset");
  report.sun = await luau(`return reply(gx.sun(${lua(manifest.toSun)}))`, "sun");
  log("sun", JSON.stringify(report.sun));
  const yaw = report.sun.yaw;
  const started = Date.now();
  for (const [index, part] of manifest.parts.entries()) {
    const material = manifest.materials[part.material];
    const spec = {
      blob: `mesh:${part.name}`,
      name: part.name,
      material: part.material,
      centre: part.centre,
      yaw,
      average: material.color?.average ?? material.average ?? [0.64, 0.64, 0.65],
      transparency: material.transparency ?? 0,
      castShadow: !part.material.startsWith("prop_wooden_lantern"),
    };
    const bytes = fs.readFileSync(path.join(exportDir, part.mesh));
    const made = await sendBlob(spec.blob, bytes, `gx.part(${lua(spec)})`, `part ${part.name}`);
    log(`part ${index + 1}/${manifest.parts.length}`, part.name, `${part.triangles} tris`, JSON.stringify(made.size));
  }
  report.buildMs = Date.now() - started;
}

async function textures() {
  const started = Date.now();
  const entries = Object.entries(manifest.materials);
  const failures = [];
  for (const [key, maps] of entries) {
    for (const [map, info] of Object.entries(maps)) {
      if (typeof info !== "object" || Array.isArray(info) || !info.file) continue;
      const channels = info.format === "rgb" ? 3 : 1;
      const spec = { blob: `tex:${key}:${map}`, material: key, map, width: info.width, height: info.height, channels };
      const bytes = fs.readFileSync(path.join(exportDir, info.file));
      const made = await sendBlob(spec.blob, bytes, `gx.texture(${lua(spec)})`, `texture ${key} ${map}`);
      if (made.failure) failures.push(`${key} ${map}: ${made.failure}`);
      log("texture", key, map, `${info.width}x${info.height}`, `parts ${made.parts}`, made.failure ?? "");
    }
  }
  report.mapFailures = failures;
  report.dress = await luau(`return reply(gx.dress(${failures.length > 0}))`, "dress");
  report.textureMs = Date.now() - started;
  log("dressed", JSON.stringify(report.dress));
}

async function shots(look) {
  for (const shot of manifest.shots) {
    const view = await luau(`return reply(gx.camera(${lua(shot)}, ${report.sun.yaw}))`, `camera ${shot.name}`);
    await sleep(SETTLE_MS);
    const captureId = `ScreenCapture_${look}_${shot.name}`;
    const result = await callTool("screen_capture", { capture_id: captureId, studio_id: studio.id });
    const image = (result?.content ?? []).find((part) => part.type === "image" && typeof part.data === "string");
    if (!image) throw new Error(`capture ${shot.name}: ${textOf(result).slice(0, 500)}`);
    const extension = (image.mimeType ?? "image/jpeg").includes("png") ? "png" : "jpg";
    const file = path.join(shotsDir, `${look}_${shot.name}.${extension}`);
    fs.writeFileSync(file, Buffer.from(image.data, "base64"));
    report.shots.push({ look, shot: shot.name, file, viewport: view.viewport, bytes: fs.statSync(file).size });
    log("shot", file, JSON.stringify(view.viewport));
  }
}

async function main() {
  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "genex-realism-test", version: "1.0" },
  });
  send({ method: "notifications/initialized" });
  const tools = await request("tools/list", {}, 15000);
  report.tools = (tools?.tools ?? []).map((tool) => tool.name);
  log("tools", report.tools.join(", "));
  studio = await pickStudio();
  report.studio = studio;
  log("studio", JSON.stringify(studio));
  await probe();
  if (STEP === "probe") return;
  const level = `Level${String(QUALITY).padStart(2, "0")}`;
  report.quality = await luau(`return reply(gx.quality("${level}"))`, "quality");
  log("quality", JSON.stringify(report.quality), "was", report.probe.quality);
  try {
    await build();
    if (STEP === "all" || STEP === "today") await shots("today");
    if (STEP === "all" || STEP === "realistic") {
      await textures();
      report.lighting = await luau(`return reply(gx.realistic(${lua(report.sun)}, ${lua(manifest.lights ?? [])}))`, "lighting");
      log("lighting", JSON.stringify(report.lighting));
      await shots("realistic");
    }
  } finally {
    const original = report.probe.quality === "unreadable" ? "Automatic" : report.probe.quality;
    report.qualityRestored = await luau(`return reply(gx.quality("${original}"))`, "quality restore").catch(String);
    log("quality restored", JSON.stringify(report.qualityRestored));
  }
}

try {
  await main();
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error);
  console.error(error);
} finally {
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(shotsDir, "build_report.json"), JSON.stringify(report, null, 1));
  child.stdin.end();
  child.kill("SIGTERM");
  process.exitCode = report.ok ? 0 : 1;
}
