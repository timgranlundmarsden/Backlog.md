export type RefreshMode = "reactive" | "full";

export interface PendingRefreshState {
	reactive: boolean;
	full: boolean;
}

export const createPendingRefreshState = (): PendingRefreshState => ({
	reactive: false,
	full: false,
});

export const queuePendingRefresh = (state: PendingRefreshState, mode: RefreshMode): PendingRefreshState => {
	if (mode === "full") {
		return { reactive: false, full: true };
	}

	if (state.full) {
		return state;
	}

	return { ...state, reactive: true };
};

export const consumePendingRefresh = (
	state: PendingRefreshState,
): { mode: RefreshMode | null; nextState: PendingRefreshState } => {
	if (state.full) {
		return { mode: "full", nextState: createPendingRefreshState() };
	}

	if (state.reactive) {
		return { mode: "reactive", nextState: createPendingRefreshState() };
	}

	return { mode: null, nextState: state };
};
