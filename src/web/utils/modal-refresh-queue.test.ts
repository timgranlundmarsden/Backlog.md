import { describe, expect, it } from "bun:test";
import { consumePendingRefresh, createPendingRefreshState, queuePendingRefresh } from "./modal-refresh-queue";

describe("modal refresh queue", () => {
	it("queues a reactive refresh", () => {
		const state = queuePendingRefresh(createPendingRefreshState(), "reactive");

		expect(state).toEqual({ reactive: true, full: false });
		expect(consumePendingRefresh(state)).toEqual({
			mode: "reactive",
			nextState: { reactive: false, full: false },
		});
	});

	it("upgrades a queued reactive refresh to a full reload", () => {
		const reactiveState = queuePendingRefresh(createPendingRefreshState(), "reactive");
		const upgradedState = queuePendingRefresh(reactiveState, "full");

		expect(upgradedState).toEqual({ reactive: false, full: true });
		expect(consumePendingRefresh(upgradedState)).toEqual({
			mode: "full",
			nextState: { reactive: false, full: false },
		});
	});

	it("keeps a full reload queued when more reactive updates arrive", () => {
		const fullState = queuePendingRefresh(createPendingRefreshState(), "full");
		const nextState = queuePendingRefresh(fullState, "reactive");

		expect(nextState).toBe(fullState);
		expect(consumePendingRefresh(nextState)).toEqual({
			mode: "full",
			nextState: { reactive: false, full: false },
		});
	});

	it("does nothing when there is no pending refresh", () => {
		expect(consumePendingRefresh(createPendingRefreshState())).toEqual({
			mode: null,
			nextState: { reactive: false, full: false },
		});
	});
});
