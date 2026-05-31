function state_entry()
   ll.Say(0, "Hello, Avatar!")
end

LLEvents:on("touch_start", function(detected: {DetectedEvent})
   ll.Say(0, "Touched.")
end)

-- Simulate the state_entry event
state_entry()