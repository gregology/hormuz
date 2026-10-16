/**
 * One-off events on the server's timeline.
 *
 * The world is drawn a little in the past (`PlaybackClock`), but an event
 * message arrives with the newest snapshot, ahead of what's on screen. Played
 * on arrival, an explosion went off before the drone that caused it got
 * there. Events here wait until playback reaches the tick they happened on.
 */

/**
 * Events further behind playback than this when they come due (seconds) are
 * dropped: playback skipped past them, e.g. while the tab was hidden, and
 * they'd only go off all at once.
 */
const MAX_LATENESS = 0.5;

export class EventTimeline<E> {
	private pending: { time: number; events: readonly E[] }[] = [];

	/** Queue the events that happened at this server time (seconds). */
	push(time: number, events: readonly E[]): void {
		const newest = this.pending.at(-1);
		// Server time going backwards means the server restarted.
		if (newest && time < newest.time) this.pending = [];
		this.pending.push({ time, events });
	}

	/** Events that have come due by this server time, oldest first. */
	due(time: number): E[] {
		const due: E[] = [];
		while (this.pending.length > 0 && this.pending[0].time <= time) {
			const batch = this.pending.shift();
			if (batch && batch.time >= time - MAX_LATENESS) due.push(...batch.events);
		}
		return due;
	}
}

/** What to do for each kind of event, for the kinds a part of the client reacts to. */
export type EventHandlers<E extends { kind: string }> = {
	[K in E["kind"]]?: (event: Extract<E, { kind: K }>) => void;
};

export function dispatchEvent<E extends { kind: string }>(
	handlers: EventHandlers<E>,
	event: E,
): void {
	const handler = handlers[event.kind as E["kind"]] as
		| ((event: E) => void)
		| undefined;
	handler?.(event);
}
