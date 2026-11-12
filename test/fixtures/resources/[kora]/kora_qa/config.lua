Config = Config or {}
Config.caps = {
    maxItemCount = 50,
    maxMoney = 100000,
    maxEntities = 2,
    maxWaitSeconds = 120,
    itemDeny = { 'weapon_rpg' },
    itemAllow = nil,
    modelDeny = { 'rhino', 'hydra' }, -- no tanks
    allowCommands = {},
    accounts = { 'cash', 'bank', 'crypto' },
    metadataDeny = { 'citizenid' },
}
