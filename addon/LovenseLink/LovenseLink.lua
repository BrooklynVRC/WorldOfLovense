-- LovenseLink: turns game events into a tiny colour strip in the top-left corner of the screen.
-- The LovenseLink app reads that strip (like a screen share) and drives your toy. Addons can't talk to
-- other programs, so this is how the event gets out of the game. Nothing here touches other players.
--
-- Strip (4 squares, left to right), every channel uses 16 levels (value = level * 17):
--   [1] marker  magenta (15, 0, 15)
--   [2] data    R = sequence 1..15, G = event code high nibble, B = event code low nibble
--   [3] data    R = intensity 0..15, G = 15 - intensity (check), B = 8 (check)
--   [4] marker  cyan (0, 15, 15)
-- A new sequence number means a new event.

local ADDON = ...
local SQUARE = 8       -- physical pixels per square
local HOLD = 0.25      -- seconds each event stays on screen

-- Event codes (must match the app).
local EV = {
  test = 1, combat_start = 2, combat_end = 3, damage = 4, low_health = 5, died = 6, resurrected = 7,
  crit = 8, killing_blow = 9, level_up = 10, quest_done = 11, loot_rare = 12, loot_epic = 13, loot_legendary = 14,
  honor_kill = 15, killed_by_player = 16, boss_pull = 17, boss_kill = 18, wipe = 19,
}

LovenseLinkDB = LovenseLinkDB or {}

-- ---------------------------------------------------------------- strip
local strip = CreateFrame("Frame", "LovenseLinkStrip", nil) -- no parent: stays visible with the UI hidden (Alt+Z)
strip:SetFrameStrata("TOOLTIP")
strip:SetFrameLevel(10000)
local squares = {}
for i = 1, 4 do
  local t = strip:CreateTexture(nil, "OVERLAY")
  squares[i] = t
end

local function layout()
  local _, physH = GetPhysicalScreenSize()
  local unit = 768 / physH -- UI units per physical pixel at scale 1
  strip:SetScale(1)
  strip:ClearAllPoints()
  strip:SetPoint("TOPLEFT", WorldFrame, "TOPLEFT", 0, 0)
  local s = SQUARE * unit / (WorldFrame:GetEffectiveScale() or 1)
  strip:SetSize(s * 4, s)
  for i, t in ipairs(squares) do
    t:ClearAllPoints()
    t:SetPoint("TOPLEFT", strip, "TOPLEFT", (i - 1) * s, 0)
    t:SetSize(s, s)
  end
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
  local now = GetTime()
  if #queue > 0 and now - shownAt >= HOLD then
    local e = table.remove(queue, 1)
    show(e[1], e[2])
    shownAt = now
  end
end)

-- ---------------------------------------------------------------- game events
local me, myName
local damageSum, damageTimer, lowHealth, lastCrit, lastPlayerHit = 0, nil, false, 0, 0
local band = bit.band
local PLAYER_FLAG = COMBATLOG_OBJECT_TYPE_PLAYER or 0x400
local LOOT_PREFIX = (LOOT_ITEM_SELF or "You receive loot: %s."):gsub("%%s.*", "")
local PUSH_PREFIX = (LOOT_ITEM_PUSHED_SELF or "You receive item: %s."):gsub("%%s.*", "")

local function flushDamage()
  damageTimer = nil
  local maxHP = UnitHealthMax("player")
  if damageSum <= 0 or maxHP <= 0 then return end
  local pct = damageSum / maxHP * 100
  damageSum = 0
  if pct >= 2 then send("damage", math.ceil(pct / 5)) end -- 5% of your health per step, 75%+ = max
end

local function onCombatLog()
  local _, sub, _, srcGUID, _, srcFlags, _, dstGUID, _, _, _, a12, _, _, a15, _, _, a18, _, _, a21 = CombatLogGetCurrentEventInfo()
  if dstGUID == me and sub:find("_DAMAGE$") then
    local amount = (sub == "SWING_DAMAGE") and a12 or a15
    if type(amount) == "number" and amount > 0 then
      damageSum = damageSum + amount
      if not damageTimer then damageTimer = C_Timer.NewTimer(0.5, flushDamage) end
    end
    if srcFlags and band(srcFlags, PLAYER_FLAG) > 0 and srcGUID ~= me then lastPlayerHit = GetTime() end
  elseif srcGUID == me then
    if sub:find("_DAMAGE$") then
      local crit = (sub == "SWING_DAMAGE") and a18 or a21
      if crit and GetTime() - lastCrit > 1 then lastCrit = GetTime(); send("crit", 8) end
    elseif sub == "PARTY_KILL" then
      send("killing_blow", 10)
    end
  end
end

local f = CreateFrame("Frame")
for _, e in ipairs({ "PLAYER_LOGIN", "DISPLAY_SIZE_CHANGED", "UI_SCALE_CHANGED", "COMBAT_LOG_EVENT_UNFILTERED",
  "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "UNIT_HEALTH", "PLAYER_DEAD", "PLAYER_UNGHOST", "PLAYER_ALIVE",
  "PLAYER_LEVEL_UP", "QUEST_TURNED_IN", "CHAT_MSG_LOOT", "PLAYER_PVP_KILLS_CHANGED", "ENCOUNTER_START", "ENCOUNTER_END" }) do
  pcall(f.RegisterEvent, f, e) -- some events may not exist in every client
end

f:SetScript("OnEvent", function(_, event, ...)
  if event == "PLAYER_LOGIN" then
    me, myName = UnitGUID("player"), UnitName("player")
    layout(); show(0, 0)
  elseif event == "DISPLAY_SIZE_CHANGED" or event == "UI_SCALE_CHANGED" then
    layout()
  elseif event == "COMBAT_LOG_EVENT_UNFILTERED" then
    onCombatLog()
  elseif event == "PLAYER_REGEN_DISABLED" then
    send("combat_start", 4)
  elseif event == "PLAYER_REGEN_ENABLED" then
    send("combat_end", 2)
  elseif event == "UNIT_HEALTH" then
    if ... ~= "player" then return end
    local hp, max = UnitHealth("player"), UnitHealthMax("player")
    if max > 0 and not UnitIsDeadOrGhost("player") then
      local pct = hp / max
      if pct < 0.25 and not lowHealth then lowHealth = true; send("low_health", 12)
      elseif pct > 0.4 then lowHealth = false end
    end
  elseif event == "PLAYER_DEAD" then
    if GetTime() - lastPlayerHit < 5 then send("killed_by_player", 15) else send("died", 15) end
  elseif event == "PLAYER_UNGHOST" or (event == "PLAYER_ALIVE" and not UnitIsGhost("player")) then
    send("resurrected", 6)
  elseif event == "PLAYER_LEVEL_UP" then
    send("level_up", 15)
  elseif event == "QUEST_TURNED_IN" then
    send("quest_done", 6)
  elseif event == "CHAT_MSG_LOOT" then
    local msg, _, _, _, _, _, _, _, _, _, _, guid = ...
    local mine = (guid and guid == me) or msg:find(LOOT_PREFIX, 1, true) == 1 or msg:find(PUSH_PREFIX, 1, true) == 1
    local link = msg:match("|H(item:[^|]+)|h")
    if mine and link then
      local _, _, quality = GetItemInfo(link)
      if quality == 3 then send("loot_rare", 6)
      elseif quality == 4 then send("loot_epic", 12)
      elseif quality and quality >= 5 then send("loot_legendary", 15) end
    end
  elseif event == "PLAYER_PVP_KILLS_CHANGED" then
    send("honor_kill", 10)
  elseif event == "ENCOUNTER_START" then
    send("boss_pull", 8)
  elseif event == "ENCOUNTER_END" then
    local _, _, _, _, success = ...
    if success == 1 then send("boss_kill", 15) else send("wipe", 10) end
  end
end)

-- ---------------------------------------------------------------- slash command
SLASH_LOVENSELINK1 = "/lovenselink"
SLASH_LOVENSELINK2 = "/ll"
SlashCmdList.LOVENSELINK = function(msg)
  msg = (msg or ""):lower()
  if msg == "off" then LovenseLinkDB.off = true; print("|cffff5c9aLovenseLink|r paused.")
  elseif msg == "on" then LovenseLinkDB.off = false; print("|cffff5c9aLovenseLink|r on.")
  elseif msg == "test" then LovenseLinkDB.off = false; send("test", 10); print("|cffff5c9aLovenseLink|r sent a test event.")
  else print("|cffff5c9aLovenseLink|r: /ll test  (send a test event),  /ll off  (pause),  /ll on") end
end
