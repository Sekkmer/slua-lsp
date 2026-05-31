-- Define the menu buttons and dialog message.
local buttons = {"-", "Red", "Green", "Yellow"}
local dialogInfo = "\nPlease make a choice."

local ToucherID = nil
local dialogChannel = nil
local listenHandle = nil
local timerHandle = nil

-- This function is called when the script first starts.
function state_entry()
    -- Get the object's key and compute a dialog channel number.
    local key = ll.GetKey()
    -- Extract the last 7 characters of the key and convert it from hex.
    dialogChannel = -1 - tonumber(string.sub(tostring(key), -7, -1), 16)
end

-- Called when the object is touched.
LLEvents:on("touch_start", function(detected: {DetectedEvent})
    ToucherID = detected[1]:getKey()
    -- If there is already a listen handle, then remove it
    if listenHandle then
        ll.ListenRemove(listenHandle)
    end
    listenHandle = ll.Listen(dialogChannel, "", ToucherID, "")
    ll.Dialog(ToucherID, dialogInfo, buttons, dialogChannel)
    -- Set a 60-second timer for response.
    if timerHandle then
        LLTimers:off(timerHandle)
    end
    timerHandle = LLTimers:once(60,timeoutListen)
end)

-- Called when a dialog response is received.
LLEvents:on("listen", function(channel, name, sender_id, message)
    if message == "-" then
        -- Redisplay the dialog if the "-" option is selected.
        ll.Dialog(ToucherID, dialogInfo, buttons, dialogChannel)
        return
    end
    -- Stop the timer, and stop the listening handler.
    ll.ListenRemove(listenHandle)
    listenHandle = nil
    if timerHandle then
        LLTimers:off(timerHandle)
    end
    -- Let the user know what they selected
    ll.Say(0, `You selected {message}`)
end)

-- Called when the timer expires.
function timeoutListen()
    -- Stop the timer and clean up the listener.
    if listenHandle then
        ll.ListenRemove(listenHandle)
        ll.Whisper(0, "Sorry. You snooze; you lose.")
    end
end

-- Invoke state_entry on startup, since simulator doesn't invoke 
-- it like it does in LSL
state_entry()