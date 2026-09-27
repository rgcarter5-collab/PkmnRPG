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
		this._lastRequest = null; // most recent non-null request, kept around for error recovery
		this._sideId = null;
	}

	// Same followup-request tolerance as TieredAI: a rejected choice (e.g. a
	// move that turned out disabled) gets a corrective request, not a crash.
	// IMPORTANT: for a plain "[Invalid choice]"/"[Unavailable choice]" error,
	// Showdown's sim does NOT always send a fresh |request| line afterward -
	// emitChoiceError only re-emits a request when it has a specific `update`
	// callback to patch the request with (e.g. a move found to be disabled).
	// A rejected switch/team choice (the case this exists for: a duplicate or
	// otherwise invalid combined choice string) just logs the error and
	// leaves the *original* request as the one still needing an answer. Since
	// submitChoice() optimistically nulls pendingRequest before we know the
	// choice was accepted, a rejection with no followup request would
	// otherwise strand the session forever (submitChoice() is now guarded by
	// game-server.mjs validating choices before ever calling it, but this
	// restores the request as a safety net for any case that slips through).
	receiveError(error) {
		if (/^\[.*choice\]/i.test(error.message)) {
			if (!this.pendingRequest && this._lastRequest) this.pendingRequest = this._lastRequest;
			return;
		}
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
		if (request.teamPreview) {
			// Bring 6, pick <maxChosenTeamSize> - a real decision now that
			// rental cores are full 6-mon rosters, not exactly-2 forced solos.
			this._sideId = request.side.id;
			this.pendingRequest = this._lastRequest = request;
			return;
		}
		if (request.forceSwitch) {
			// Only a real decision if there's an actual bench to switch into -
			// with no bench (or everything on it fainted) there's nothing to
			// choose, so let RandomPlayerAI's default auto-pass it.
			const hasBench = request.side.pokemon.some(p => !p.active && !p.condition.includes('fnt'));
			if (hasBench) {
				this._sideId = request.side.id;
				this.pendingRequest = this._lastRequest = request;
				return;
			}
			this.pendingRequest = null;
			return super.receiveRequest(request);
		}
		if (request.active) {
			this._sideId = request.side.id;
			this.pendingRequest = this._lastRequest = request;
			return; // wait for submitChoice() from the HTTP layer
		}
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
