--!strict
-- A model Genex checked (the asset gate) built in Studio as a MeshPart. Genex sends the mesh as
-- one part, `mesh.bin`, in a small format of its own, little-endian:
--
--   "GXM1", vertex count (u32), triangle count (u32),
--   positions (3 × f32 per vertex), normals (3 × f32 per vertex), UVs (2 × f32 per vertex),
--   triangles (3 × u32 vertex indexes each).
--
-- The helper makes an EditableMesh from it and a MeshPart with AssetService:CreateMeshPartAsync,
-- anchored at the origin of Workspace, inside one recording. Uploading the mesh to the person's
-- account happens only when they publish the place.

local AssetService = game:GetService("AssetService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local constants = require(script.Parent.constants)
local protocol = require(script.Parent.protocol)

local ErrorCode = constants.ErrorCode

local HEADER_BYTES = 12
-- The most vertices and triangles one mesh may have (Studio's own editable-mesh budget is larger).
local MAX_VERTICES = 60000
local MAX_TRIANGLES = 20000
local MAX_NAME_CHARS = 100

local model = {}

local function vector(data: buffer, at: number): Vector3
	return Vector3.new(buffer.readf32(data, at), buffer.readf32(data, at + 4), buffer.readf32(data, at + 8))
end

-- The mesh's sizes from its header; refuses data that isn't one.
local function header(data: buffer): (number, number)
	local size = buffer.len(data)
	if size < HEADER_BYTES or buffer.readstring(data, 0, 4) ~= constants.MODEL_MAGIC then
		protocol.fail(ErrorCode.Refused, "That isn't a mesh Genex sends.")
	end
	local vertices, triangles = buffer.readu32(data, 4), buffer.readu32(data, 8)
	local expected = HEADER_BYTES + vertices * 32 + triangles * 12
	if vertices > MAX_VERTICES or triangles > MAX_TRIANGLES or size ~= expected then
		protocol.fail(ErrorCode.Refused, "The mesh's sizes don't match its data, or pass the limits.")
	end
	return vertices, triangles
end

local function build(data: buffer, vertices: number, triangles: number): any
	local mesh = (AssetService :: any):CreateEditableMesh()
	local normalsAt = HEADER_BYTES + vertices * 12
	local uvsAt = normalsAt + vertices * 12
	local trianglesAt = uvsAt + vertices * 8
	local ids, normals, uvs = {}, {}, {}
	for index = 0, vertices - 1 do
		ids[index] = mesh:AddVertex(vector(data, HEADER_BYTES + index * 12))
		normals[index] = mesh:AddNormal(vector(data, normalsAt + index * 12))
		local at = uvsAt + index * 8
		uvs[index] = mesh:AddUV(Vector2.new(buffer.readf32(data, at), buffer.readf32(data, at + 4)))
	end
	for index = 0, triangles - 1 do
		local at = trianglesAt + index * 12
		local a, b, c = buffer.readu32(data, at), buffer.readu32(data, at + 4), buffer.readu32(data, at + 8)
		if a >= vertices or b >= vertices or c >= vertices then
			protocol.fail(ErrorCode.Refused, "A triangle names a vertex the mesh doesn't have.")
		end
		local face = mesh:AddTriangle(ids[a], ids[b], ids[c])
		mesh:SetFaceNormals(face, { normals[a], normals[b], normals[c] })
		mesh:SetFaceUVs(face, { uvs[a], uvs[b], uvs[c] })
	end
	return mesh
end

-- model.import: the mesh Genex sent as a MeshPart in Workspace.
function model.import(request: any): { [string]: any }
	local name = request.body.name
	if type(name) ~= "string" or #name == 0 or #name > MAX_NAME_CHARS or not protocol.isText(name) then
		protocol.fail(ErrorCode.Refused, "The model needs a short name.")
	end
	local data = request.takeParts()[constants.MODEL_PART]
	if not data or buffer.len(data) ~= request.body.bytes then
		protocol.fail(ErrorCode.Failed, "The model arrived incomplete.")
	end
	local vertices, triangles = header(data :: buffer)
	local found = pcall(function()
		return (AssetService :: any).CreateEditableMesh
	end)
	if not found then
		protocol.fail(ErrorCode.Unsupported, "This Studio can't build a mesh from a plugin.")
	end
	local mesh = build(data :: buffer, vertices, triangles)
	local recording = ChangeHistoryService:TryBeginRecording("Genex: import a model")
	local ok, part = pcall(function()
		local made = (AssetService :: any):CreateMeshPartAsync(Content.fromObject(mesh))
		made.Name = name
		made.Anchored = true
		made.Parent = workspace
		return made
	end)
	if recording then
		local operation = if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		ChangeHistoryService:FinishRecording(recording, operation)
	end
	if not ok then
		protocol.fail(ErrorCode.Failed, `Studio couldn't make the model: {part}`)
	end
	return { instance = protocol.plain(part:GetFullName(), 1000) }
end

return model
