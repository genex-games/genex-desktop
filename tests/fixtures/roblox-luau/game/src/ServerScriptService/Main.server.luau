--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Util = require(ReplicatedStorage.Shared.Util)
local coins: number = "none"
local unused = 5
print(Util.add(coins, 2))
if  coins == 1 then print("one") end
