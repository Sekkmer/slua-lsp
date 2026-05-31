-- Key: avatar uuid; Value: coroutine thread
routines = {}

main = function(toucher)
    local handle = ll.Listen(0, "", toucher, "")

    ll.RegionSayTo(toucher, 0, "Do you want pants or gloves?")
    local clothing = coroutine.yield()
    ll.RegionSayTo(toucher, 0, "For men or women?")
    local gender = coroutine.yield()
    ll.RegionSayTo(toucher, 0, "Favorite color?")
    local color = coroutine.yield()
    ll.RegionSayTo(toucher, 0, "Here's "..color.." "..clothing.." for "..gender)

    ll.ListenRemove(handle)
    routines[toucher] = nil -- Remove from collection
end

LLEvents:on("touch_start",function(detected: {DetectedEvent})
    local toucher = detected[1]:getKey()
    local routine = routines[toucher]
    if not routine then -- New user needs new routine
        routine = coroutine.create(main)
        routines[toucher] = routine -- Add to collection
        coroutine.resume(routine, toucher)
    end
end)

LLEvents:on("listen", function(channel, name, id, message)
    coroutine.resume(routines[id], message) -- Resume a specific coroutine
end)
