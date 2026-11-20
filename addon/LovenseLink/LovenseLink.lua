-- LovenseLink: turns game events into a tiny colour strip in the top-left corner of the screen.
-- The LovenseLink app reads that strip (like a screen share) and drives your toy. Addons can't talk to
-- other programs, so this is how the event gets out of the game. Nothing here touches other players.
--
-- Strip (left to right), every channel uses 16 levels (value = level * 17):
--   [1] marker  magenta (15, 0, 15)
--   [2] data    R = sequence 1..15, G = event code high nibble, B = event code low nibble
--   [3] data    R = intensity 0..15, G = 15 - intensity (check), B = 8 (check)
--   [4] marker  cyan (0, 15, 15)
--   [5..12] health bar, 8 squares wide: white fill on black, filled part = your health
-- A new sequence number means a new event.
--
-- WoW Forever runs with the Midnight addon restrictions: the combat log is off limits and your
-- health is a "secret" number addons can't do maths on. The health bar is how the app still
-- knows when you take damage: secret values may be shown in a status bar (that's how unit frames
-- work), so the addon never reads the number and the app measures the bar instead.

local SQUARE = 8       -- physical pixels per square
local HOLD = 0.25      -- seconds each event stays on screen
local BAR = 8          -- health bar width, in squares

-- Event codes (must match the app). Damage (4) and low health (5) are worked out by the app
-- from the health bar; crit (8), killing blow (9) and killed by player (16) need the combat log.
local EV = {
  test = 1, combat_start = 2, combat_end = 3, died = 6, resurrected = 7,
  level_up = 10, quest_done = 11, loot_rare = 12, loot_epic = 13, loot_legendary = 14,
  honor_kill = 15, boss_pull = 17, boss_kill = 18, wipe = 19,
}

LovenseLinkDB = LovenseLinkDB or {}
local secret = issecretvalue or function() return false end

-- ---------------------------------------------------------------- strip
local strip = CreateFrame("Frame", "LovenseLinkStrip", nil) -- no parent: stays visible with the UI hidden (Alt+Z)
strip:SetFrameStrata("TOOLTIP")
strip:SetFrameLevel(10000)
local squares = {}
for i = 1, 4 do squares[i] = strip:CreateTexture(nil, "OVERLAY") end

local bar = CreateFrame("StatusBar", nil, strip)
bar:SetFrameLevel(10001)
local barBg = bar:CreateTexture(nil, "BACKGROUND")
barBg:SetAllPoints()
barBg:SetColorTexture(0, 0, 0, 1)
bar:SetStatusBarTexture("Interface\\Buttons\\WHITE8X8")
bar:SetStatusBarColor(1, 1, 1, 1)
bar:SetMinMaxValues(0, 1)
bar:SetValue(0)

local function layout()
  local _, physH = GetPhysicalScreenSize()
  local unit = 768 / physH -- UI units per physical pixel at scale 1
  strip:SetScale(1)
  strip:ClearAllPoints()
  strip:SetPoint("TOPLEFT", WorldFrame, "TOPLEFT", 0, 0)
  local s = SQUARE * unit / (WorldFrame:GetEffectiveScale() or 1)
  strip:SetSize(s * (4 + BAR), s)
  for i, t in ipairs(squares) do
    t:ClearAllPoints()
    t:SetPoint("TOPLEFT", strip, "TOPLEFT", (i - 1) * s, 0)
    t:SetSize(s, s)
  end
  bar:ClearAllPoints()
  bar:SetPoint("TOPLEFT", strip, "TOPLEFT", 4 * s, 0)
  bar:SetSize(s * BAR, s)
end

-- Health goes straight from the game into the bar; the addon never looks at the numbers.
local function updateHealth()
  bar:SetMinMaxValues(0, UnitHealthMax("player"))
  bar:SetValue(UnitHealth("player"))
end

local function lvl(n) return (math.max(0, math.min(15, n)) * 17) / 255 end
local seq = 0
local function show(code, intensity)
  seq = seq % 15 + 1
  squares[1]:SetColorTexture(1, 0, 1, 1)
  squares[2]:SetColorTexture(lvl(seq), lvl(math.floor(code / 16)), lvl(code % 16), 1)
  squares[3]:SetColorTexture(lvl(intensity), lvl(15 - intensity), lvl(8), 1)
  squares[4]:SetColorTexture(0, 1, 1, 1)
end

-- ---------------------------------------------------------------- queue
local queue, shownAt = {}, 0
local function send(name, intensity)
  if LovenseLinkDB.off then return end
  table.insert(queue, { EV[name], math.floor(intensity or 8) })
  if #queue > 20 then table.remove(queue, 1) end
end

strip:SetScript("OnUpdate", function()
  updateHealth()
  local now = GetTime()
  if #queue > 0 and now - shownAt >= HOLD then
    local e = table.remove(queue, 1)
    show(e[1], e[2])
    shownAt = now
  end
end)

-- ---------------------------------------------------------------- game events
local LOOT_PREFIX = (LOOT_ITEM_SELF or "You receive loot: %s."):gsub("%%s.*", "")
local PUSH_PREFIX = (LOOT_ITEM_PUSHED_SELF or "You receive item: %s."):gsub("%%s.*", "")

local f = CreateFrame("Frame")
for _, e in ipairs({ "PLAYER_LOGIN", "DISPLAY_SIZE_CHANGED", "UI_SCALE_CHANGED",
  "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "PLAYER_DEAD", "PLAYER_UNGHOST", "PLAYER_ALIVE",
  "PLAYER_LEVEL_UP", "QUEST_TURNED_IN", "CHAT_MSG_LOOT", "PLAYER_PVP_KILLS_CHANGED", "ENCOUNTER_START", "ENCOUNTER_END" }) do
  pcall(f.RegisterEvent, f, e) -- some events may not exist in every client
end

f:SetScript("OnEvent", function(_, event, ...)
  if event == "PLAYER_LOGIN" then
    layout(); show(0, 0); updateHealth()
    if LovenseLinkDB.off then strip:Hide() end -- paused: no strip, so the app sees nothing
  elseif event == "DISPLAY_SIZE_CHANGED" or event == "UI_SCALE_CHANGED" then
    layout()
  elseif event == "PLAYER_REGEN_DISABLED" then
    send("combat_start", 4)
  elseif event == "PLAYER_REGEN_ENABLED" then
    send("combat_end", 2)
  elseif event == "PLAYER_DEAD" then
    send("died", 15)
  elseif event == "PLAYER_UNGHOST" or (event == "PLAYER_ALIVE" and not UnitIsGhost("player")) then
    send("resurrected", 6)
  elseif event == "PLAYER_LEVEL_UP" then
    send("level_up", 15)
  elseif event == "QUEST_TURNED_IN" then
    send("quest_done", 6)
  elseif event == "CHAT_MSG_LOOT" then
    local msg = ...
    if type(msg) ~= "string" or secret(msg) then return end
    local mine = msg:find(LOOT_PREFIX, 1, true) == 1 or msg:find(PUSH_PREFIX, 1, true) == 1
    local link = msg:match("|H(item:[^|]+)|h")
    if mine and link then
      local getInfo = (C_Item and C_Item.GetItemInfo) or GetItemInfo
      local _, _, quality = getInfo(link)
      if secret(quality) or type(quality) ~= "number" then return end
      if quality == 3 then send("loot_rare", 6)
      elseif quality == 4 then send("loot_epic", 12)
      elseif quality >= 5 then send("loot_legendary", 15) end
    end
  elseif event == "PLAYER_PVP_KILLS_CHANGED" then
    send("honor_kill", 10)
  elseif event == "ENCOUNTER_START" then
    send("boss_pull", 8)
  elseif event == "ENCOUNTER_END" then
    local _, _, _, _, success = ...
    if secret(success) then return end
    if success == 1 then send("boss_kill", 15) else send("wipe", 10) end
  end
end)

-- ---------------------------------------------------------------- slash command
SLASH_LOVENSELINK1 = "/lovenselink"
SLASH_LOVENSELINK2 = "/ll"
SlashCmdList.LOVENSELINK = function(msg)
  msg = (msg or ""):lower()
  if msg == "off" then LovenseLinkDB.off = true; strip:Hide(); print("|cffff5c9aLovenseLink|r paused.")
  elseif msg == "on" then LovenseLinkDB.off = false; strip:Show(); print("|cffff5c9aLovenseLink|r on.")
  elseif msg == "test" then LovenseLinkDB.off = false; strip:Show(); send("test", 10); print("|cffff5c9aLovenseLink|r sent a test event.")
  else print("|cffff5c9aLovenseLink|r: /ll test  (send a test event),  /ll off  (pause),  /ll on") end
end
