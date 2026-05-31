-- Wait for user input mid-function before doing something useful with it.
main = function(toucher)
    local handle = ll.Listen(0, "", toucher, "")
    local event = touch_start   -- save function for later
    touch_start = nil           -- disable touch_start

    ll.RegionSayTo(toucher, 0, "Do you want pants or gloves?")
    local clothing = coroutine.yield() -- pause the routine's execution here
    ll.RegionSayTo(toucher, 0, "For men or women?")
    local gender = coroutine.yield()
    ll.RegionSayTo(toucher, 0, "Favorite color?")
    local color = coroutine.yield()
    ll.RegionSayTo(toucher, 0, "Here's "..color.." "..clothing.." for "..gender)

    ll.ListenRemove(handle)
    touch_start = event -- restore touch_start
end

LLEvents:on("touch_start",function(detected: {DetectedEvent})
    local toucher = detected[1]:getKey()
    routine = coroutine.create(main)    -- new coroutine
    coroutine.resume(routine, toucher)  -- run coroutine (with one argument)
end)

-- When the coroutine is suspended, incoming events can be handled
-- and we can resume() execution of the routine
-- and pass any number of arguments to be returned by yield()
LLEvents:on("listen", function(channel, name, id, message)
    coroutine.resume(routine, message)
end)
