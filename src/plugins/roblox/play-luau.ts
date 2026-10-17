/**
 * The Luau the play adapter (`computer-play.ts`) runs through Studio's `execute_luau` in a play
 * test's own data models: who a client plays as, a player's state as the client and the server see
 * it, the game's clock, whether the game's live saved data can be reached, and the end of a
 * multiplayer test. Each answers JSON or a plain value, and reads only: none of it changes the game.
 */

/** Values Studio can write as JSON: numbers, text and true/false; anything else as its text. */
const PLAIN = `local function plain(value)
  local kind = typeof(value)
  if kind == "number" or kind == "string" or kind == "boolean" then return value end
  return tostring(value)
end
local function attributes(instance)
  local out = {}
  for name, value in instance:GetAttributes() do out[name] = plain(value) end
  return out
end
local function leaderstats(player)
  local out = {}
  local stats = player:FindFirstChild("leaderstats")
  if stats then
    for _, child in stats:GetChildren() do
      if child:IsA("ValueBase") then out[child.Name] = plain((child :: any).Value) end
    end
  end
  return out
end
local function vector(v) return { v.X, v.Y, v.Z } end
local function body(player)
  local character = player.Character
  local root = character and character:FindFirstChild("HumanoidRootPart")
  local humanoid = character and character:FindFirstChildOfClass("Humanoid")
  return {
    userId = player.UserId,
    name = player.Name,
    position = root and vector((root :: BasePart).Position) or nil,
    velocity = root and vector((root :: BasePart).AssemblyLinearVelocity) or nil,
    health = humanoid and humanoid.Health or nil,
    maxHealth = humanoid and humanoid.MaxHealth or nil,
    leaderstats = leaderstats(player),
    attributes = attributes(player),
  }
end`;

/** The snippets, by what they ask. */
export const PLAY_LUAU = {
  /** Client: the player this client plays as and its view's size; `userId` is null until it joins. */
  WhoAmI: `local player = game:GetService("Players").LocalPlayer
local camera = workspace.CurrentCamera
return game:GetService("HttpService"):JSONEncode({
  userId = player and player.UserId or nil,
  name = player and player.Name or nil,
  view = camera and { camera.ViewportSize.X, camera.ViewportSize.Y } or nil,
})`,
  /** Client: the local player as its client sees it. */
  ClientState: `${PLAIN}
local player = game:GetService("Players").LocalPlayer
local out = player and body(player) or {}
out.gameSeconds = workspace.DistributedGameTime
return game:GetService("HttpService"):JSONEncode(out)`,
  /** Server: every player as the server sees them. */
  ServerState: `${PLAIN}
local players = {}
for _, player in game:GetService("Players"):GetPlayers() do table.insert(players, body(player)) end
return game:GetService("HttpService"):JSONEncode({ players = players, gameSeconds = workspace.DistributedGameTime })`,
  /** Server: answers the server itself, so a test's server Studio is told from its clients. */
  IsServer: `return game:GetService("RunService"):IsServer() and "server" or "client"`,
  /** Client: the game's own clock, in seconds. */
  GameSeconds: "return workspace.DistributedGameTime",
  /**
   * Server: whether Studio can reach the game's live saved data (a published place whose Studio
   * may use Roblox's API services). Only the DataStore is asked for; nothing is read or written.
   */
  LiveData: `local reachable = game.PlaceId ~= 0 and (pcall(function()
  local service = game:GetService("DataStoreService")
  return service:GetDataStore("GenexLiveDataCheck")
end))
return reachable and "true" or "false"`,
  /** Server: ends the multiplayer test, its server and every client. */
  EndTest: `game:GetService("StudioTestService"):EndTest("genex")
return "ended"`,
} as const;
export type PlayLuau = (typeof PLAY_LUAU)[keyof typeof PLAY_LUAU];
