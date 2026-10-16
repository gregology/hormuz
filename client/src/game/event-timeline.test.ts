import { describe, expect, it } from "vitest";
import { EventTimeline } from "./event-timeline";

describe("event timeline", () => {
	it("plays events when playback reaches their tick, not when they arrive", () => {
		const timeline = new EventTimeline<string>();
		timeline.push(10.0, ["explosion"]);
		expect(timeline.due(9.9)).toEqual([]);
		expect(timeline.due(10.0)).toEqual(["explosion"]);
		expect(timeline.due(10.1)).toEqual([]);
	});

	it("plays everything that came due during a frame, oldest first", () => {
		const timeline = new EventTimeline<string>();
		timeline.push(10.0, ["first"]);
		timeline.push(10.05, ["second", "third"]);
		expect(timeline.due(10.06)).toEqual(["first", "second", "third"]);
	});

	it("drops events that playback skipped far past", () => {
		const timeline = new EventTimeline<string>();
		timeline.push(10.0, ["missed while hidden"]);
		timeline.push(12.9, ["recent"]);
		expect(timeline.due(13.0)).toEqual(["recent"]);
	});

	it("forgets the old timeline when the server restarts", () => {
		const timeline = new EventTimeline<string>();
		timeline.push(500.0, ["before restart"]);
		timeline.push(0.05, ["after restart"]);
		expect(timeline.due(600)).toEqual([]);
	});
});
