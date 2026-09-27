// The human side of a battle stream. Mirrors TieredAI's shape (same base
// class, same fog-of-war tracker) but never auto-picks a move: team preview
// and forced switches are auto-handled by RandomPlayerAI's default logic
// (meaningless decisions anyway - every rental core is exactly 2 Pokemon,
// i.e. the whole active team, so there's never a real bench to switch into),
// while an `active` move request is stashed on `pendingRequest` for the HTTP
// layer to read and answer via `submitChoice()` once the player picks moves.
import { RandomPlayerAI } from './sim/tools/random-player-ai.ts';
import { createSeenTracker, trackSeenLine } from './battle-tracker.mjs';

export class HumanPlayer extends RandomPlayerAI {
	constructor(playerStream, options = {}, debug = false) {
		super(playerStream, options, debug);
		this.seen = createSeenTracker(); // fog-of-war view of the foe's side, position -> info
		this.pendingRequest = null; // the raw MoveRequest waiting on a human choice, or null
		this._sideId = null;
	}

	// Same followup-request tolerance as TieredAI: a rejected choice (e.g. a
	// move that turned out disabled) gets a corrective request, not a crash.
	receiveError(error) {
		if (/^\[.*choice\]/i.test(error.message)) return;
		throw error;
	}

	receiveLine(line) {
		trackSeenLine(this.seen, line);
		return super.receiveLine(line);
	}

	receiveRequest(request) {
		if (request.wait) {
			this.pendingRequest = null;
			return;
		}
		if (request.active && !request.forceSwitch) {
			this._sideId = request.side.id;
			this.pendingRequest = request;
			return; // wait for submitChoice() from the HTTP layer
		}
		// Team preview / forced switch with no real bench: nothing meaningful
		// to decide, so let RandomPlayerAI's default (deterministic here) handle it.
		this.pendingRequest = null;
		return super.receiveRequest(request);
	}

	// Called once the HTTP layer has validated a choice string built from the
	// player's move/target picks against `pendingRequest`.
	submitChoice(choiceString) {
		if (!this.pendingRequest) throw new Error('No pending move request to respond to');
		this.pendingRequest = null;
		this.choose(choiceString);
	}
}
