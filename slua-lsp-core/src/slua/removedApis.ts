export type RemovedApiInfo = {
	message: string;
};

/**
 * APIs that exist in upstream LSL definitions but are not available in the SLua runtime.
 *
 * These should:
 * - not appear in completions/signature help (filtered out of the registry), and
 * - produce a friendly error diagnostic when referenced.
 */
export const REMOVED_LL_APIS: Record<string, RemovedApiInfo> = {
	SetTimerEvent: {
		message:
			'This SLua runtime doesn\'t support the legacy \'timer\' event / ll.SetTimerEvent(). Use LLTimers:every(seconds, callback) or LLTimers:once(seconds, callback) instead.'
	},
	SetMemoryLimit: {
		message: 'This SLua runtime doesn\'t expose ll.SetMemoryLimit().'
	},
	ResetTime: {
		message: 'This SLua runtime doesn\'t expose ll.ResetTime().'
	},
	GetAndResetTime: {
		message: 'This SLua runtime doesn\'t expose ll.GetAndResetTime().'
	}
};

export const REMOVED_LL_API_NAMES = new Set<string>(Object.keys(REMOVED_LL_APIS));
