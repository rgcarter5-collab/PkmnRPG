// Minimal playable slice of the Pokemon RPG: a plain Node HTTP server (no
// external deps - this only needs a handful of JSON endpoints, not a real
// framework) that lets a human fight a real doubles battle, via the actual
// Showdown sim, against a TieredAI opponent. No accounts, no persistence,
// no story yet - just "pick a rental core, fight the City League, see who
// wins" end to end. Everything else (progression, money, SP training,
// cutscenes) hangs off this loop later.
import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BattleStream, getPlayerStreams, Teams, Dex } from './sim/index.ts';
import { TieredAI } from './tiered-ai.mjs';
import { HumanPlayer } from './human-player.mjs';
import { toPokemonSet } from './pokemon-set.mjs';
import { parseDetails, parseHP } from './battle-tracker.mjs';
import { getMovepoolWithPresets, validateMoveset } from './movepool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8090;

// Difficulty of the City League opponent, on TieredAI's 1 (Pokeball) - 4
// (Master) scale. Tunable later per-tier once more of the ladder exists.
const CITY_LEAGUE_AI_TIER = 2;
// Real VGC-style doubles: bring a 6-mon roster, pick 4 at team preview. "Team
// Preview" itself is already on by default for gen9doublescustomgame; only
// the picked-team-size cap needs adding as a custom rule.
const FORMAT_ID = 'gen9doublescustomgame@@@Picked Team Size = 4';
const REQUEST_TIMEOUT_MS = 5000;
const REQUEST_POLL_MS = 15;

const regionalTeams = JSON.parse(readFileSync(path.join(__dirname, 'regional-teams.json'), 'utf8'));

/** @type {Map<string, object>} sessionId -> battle session */
const sessions = new Map();

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Turn one raw protocol line into a short human-readable log entry. Not
// exhaustive - just the lines a player actually wants narrated; anything
// else is silently dropped from the readable log (the raw data still drives
// state via HumanPlayer's tracker regardless of what we choose to narrate).
function formatLogLine(line) {
	const parts = line.split('|');
	const cmd = parts[1];
	const nameOf = pos => pos.includes(':') ? pos.split(':')[1].trim() : pos;
	switch (cmd) {
		case 'move': return `${nameOf(parts[2])} used ${parts[3]}!`;
		case 'switch': case 'drag': return `${nameOf(parts[2])} sent out ${parseDetails(parts[3]).speciesName}!`;
		case '-damage': return parts[3].includes('fnt') ? null : `${nameOf(parts[2])} took damage.`;
		case '-heal': return `${nameOf(parts[2])} recovered some HP.`;
		case '-crit': return 'A critical hit!';
		case '-supereffective': return "It's super effective!";
		case '-resisted': return "It's not very effective...";
		case '-immune': return `${nameOf(parts[2])} was unaffected!`;
		case '-fail': return `${nameOf(parts[2])}'s move failed.`;
		case '-miss': return `${nameOf(parts[2])} missed!`;
		case '-status': return `${nameOf(parts[2])} was afflicted with ${parts[3]}!`;
		case '-curestatus': return `${nameOf(parts[2])} recovered from its status.`;
		case '-boost': return `${nameOf(parts[2])}'s stat rose!`;
		case '-unboost': return `${nameOf(parts[2])}'s stat fell!`;
		case 'faint': return `${nameOf(parts[2])} fainted!`;
		case 'turn': return `--- Turn ${parts[2]} ---`;
		case 'win': return `${parts[2]} wins the battle!`;
		case 'tie': return "It's a tie!";
		default: return null;
	}
}

// Type effectiveness against a foe's (publicly known - types are never
// hidden info) type(s), as a display label for the move-selection UI. Real
// games only ever say "super effective" once, but the ask here was a
// graduated readout, so x4 gets its own "extremely effective" tier.
function effectivenessLabel(moveType, defenderTypes) {
	if (!Dex.getImmunity(moveType, defenderTypes)) return 'noEffect';
	const mod = Dex.getEffectiveness(moveType, defenderTypes);
	if (mod <= -1) return 'notVeryEffective';
	if (mod === 0) return 'effective';
	if (mod === 1) return 'superEffective';
	return 'extremelyEffective';
}

async function waitForPendingOrEnd(session, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!session.human.pendingRequest && !session.ended) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for the battle to respond');
		await sleep(REQUEST_POLL_MS);
	}
}

function startBattle(regionId, coreIndex, customMoves) {
	const regionData = regionalTeams[regionId];
	if (!regionData) throw new Error(`Unknown region: ${regionId}`);
	const core = regionData.cityLeagueCores[coreIndex];
	if (!core) throw new Error(`Unknown rental core index: ${coreIndex}`);
	const opponentTeamDef = regionData.regionalTeams[Math.floor(Math.random() * regionData.regionalTeams.length)];

	// Optional pre-battle moveset edits (the roster-builder screen): keyed by
	// 1-based roster slot, same indices team preview and the roster-detail
	// endpoint use elsewhere. Re-validated here (never trust the client) even
	// though the roster-builder endpoint already only offers legal moves.
	const p1roster = core.roster.map((mon, i) => {
		const override = customMoves?.[i + 1];
		if (!override) return mon;
		return { ...mon, moves: validateMoveset(mon.species, override, mon.moves) };
	});

	const p1team = p1roster.map(toPokemonSet);
	const p2team = opponentTeamDef.roster.map(toPokemonSet);

	const streams = getPlayerStreams(new BattleStream());
	const spec = { formatid: FORMAT_ID };
	const p1spec = { name: 'You', team: Teams.pack(p1team) };
	const p2spec = { name: opponentTeamDef.name, team: Teams.pack(p2team) };

	const id = randomUUID();
	const human = new HumanPlayer(streams.p1, {}, !!process.env.DEBUG_CHOICES);
	const ai = new TieredAI(streams.p2, CITY_LEAGUE_AI_TIER, {}, !!process.env.DEBUG_CHOICES);

	const session = {
		id, human, ai,
		ended: false, winner: null, tie: false,
		region: regionId, coreName: core.name, opponentName: opponentTeamDef.name,
		log: [],
	};
	sessions.set(id, session);

	void human.start().catch(err => { session.ended = true; session.error = err.message; });
	void ai.start().catch(err => { session.ended = true; session.error = err.message; });

	void (async () => {
		for await (const chunk of streams.omniscient) {
			for (const line of chunk.split('\n')) {
				const readable = formatLogLine(line);
				if (readable) session.log.push(readable);
				if (line.startsWith('|win|')) { session.ended = true; session.winner = line.slice('|win|'.length); }
				if (line.startsWith('|tie|')) { session.ended = true; session.tie = true; }
			}
		}
		// Keep the finished session around briefly (so a client can still poll
		// the final state after the last choice) then drop it - nothing here
		// persists across sessions yet, so there's no reason to hold onto
		// finished battles indefinitely.
		setTimeout(() => sessions.delete(id), 10 * 60 * 1000).unref();
	})();

	void streams.omniscient.write(
		`>start ${JSON.stringify(spec)}\n>player p1 ${JSON.stringify(p1spec)}\n>player p2 ${JSON.stringify(p2spec)}`
	);

	return session;
}

// Build the render-friendly snapshot the front end polls for. "You" comes
// from the authoritative pending request (exact HP, real PP); "foe" comes
// from HumanPlayer's fog-of-war tracker (HP fraction only, no PP) - the same
// partial-knowledge view TieredAI itself works from, just surfaced instead
// of scored.
function buildState(session) {
	const req = session.human.pendingRequest;
	const sideId = session.human._sideId || 'p1';
	const foePrefix = sideId === 'p1' ? 'p2' : 'p1';

	const foe = ['a', 'b'].map(letter => {
		const pos = foePrefix + letter;
		const s = session.human.seen[pos];
		if (!s || !s.species?.exists) return null;
		return {
			species: s.species.name, level: s.level, fainted: !!s.fainted,
			status: s.status || '', hpFraction: s.hpFraction ?? 1,
		};
	});
	const foeTypes = foe.map(f => (f ? Dex.species.get(f.species).types : null));

	const base = {
		battleId: session.id,
		region: session.region, coreName: session.coreName, opponentName: session.opponentName,
		ended: session.ended, winner: session.winner, tie: session.tie, error: session.error || null,
		foe,
		log: session.log.slice(-40),
	};

	if (!req) return { ...base, phase: 'waiting', needsChoice: false, you: [] };

	if (req.teamPreview) {
		// Bring-6-pick-4: nothing is "active" yet in any meaningful sense -
		// just present the full roster for the player to order/select from.
		const roster = req.side.pokemon.map((p, i) => {
			const { speciesName, level } = parseDetails(p.details);
			return { index: i + 1, species: speciesName, level, item: p.item, ability: p.ability || p.baseAbility, moves: p.moves };
		});
		// Real VGC Team Preview reveals both sides' full 6 species publicly -
		// see battle-tracker.mjs's parsePokeLine / human-player.mjs's
		// previewRoster. Falls back to an empty list if somehow never
		// populated (e.g. a format without the Team Preview rule) rather than
		// erroring - the picker just won't show anything for the foe then.
		const foeRoster = (session.human.previewRoster[foePrefix] || []).map((p, i) => ({
			index: i + 1, species: p.species, level: p.level,
		}));
		return {
			...base, phase: 'teamPreview', needsChoice: true, you: [], roster, foeRoster,
			maxChosenTeamSize: req.maxChosenTeamSize || roster.length,
		};
	}

	if (req.forceSwitch) {
		// A mon fainted and there's a real bench to switch into - report the
		// full brought-team roster (fainted/active flags) plus which active
		// slots need a replacement, index-aligned with req.forceSwitch.
		const roster = req.side.pokemon.map((p, i) => {
			const { speciesName, level } = parseDetails(p.details);
			const hp = parseHP(p.condition);
			return {
				index: i, species: speciesName, level, active: p.active,
				fainted: !!hp.fainted, hpFraction: hp.hpFraction ?? 0,
				hpText: hp.fainted ? '0/0' : p.condition.split(' ')[0],
			};
		});
		return { ...base, phase: 'switch', needsChoice: true, you: roster, forceSwitch: req.forceSwitch };
	}

	// Move phase (req.active): same shape as before, generalized to however
	// many mons are in the brought team (still just the active ones get moves).
	// `index` (1-based) is the roster slot number this entry lives in in
	// req.side.pokemon - the same number `switch N` expects, so the front end
	// can offer a voluntary switch from any bench slot alongside move choices.
	let activeIdx = 0;
	const you = req.side.pokemon.map((p, i) => {
		const fainted = p.condition.includes('fnt');
		const [hpPart, statusPart] = p.condition.split(' ');
		const [cur, max] = hpPart.split('/').map(Number);
		const { speciesName, level } = parseDetails(p.details);
		let moves = null;
		if (p.active && req.active[activeIdx]) {
			moves = req.active[activeIdx].moves.map((m, mi) => {
				const moveData = Dex.moves.get(m.id);
				let effectiveness = null;
				// Only meaningful for moves that actually hit a foe, and only
				// against foes we've actually seen (fog of war still applies -
				// types are public, but only once we know which species is
				// even out there).
				if (moveData.exists && moveData.category !== 'Status' &&
					['normal', 'any', 'adjacentFoe', 'allAdjacentFoes', 'allAdjacent'].includes(m.target)) {
					effectiveness = {};
					foe.forEach((f, fi) => {
						if (!f || f.fainted || !foeTypes[fi]) return;
						effectiveness[fi + 1] = effectivenessLabel(moveData.type, foeTypes[fi]);
					});
				}
				return {
					slot: mi + 1, id: m.id, name: m.move, pp: m.pp, maxpp: m.maxpp,
					disabled: !!m.disabled, target: m.target, effectiveness,
				};
			});
		}
		if (p.active) activeIdx++;
		return {
			index: i + 1, species: speciesName, level, fainted, active: p.active,
			status: fainted ? '' : (statusPart || ''),
			hpFraction: max ? cur / max : (fainted ? 0 : null),
			hpText: fainted ? '0/0' : `${cur}/${max}`,
			moves,
		};
	});

	return { ...base, phase: 'move', needsChoice: true, you };
}

// --- HTTP plumbing -----------------------------------------------------

function sendJSON(res, status, body) {
	const data = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
	res.end(data);
}

function readJSONBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', chunk => { data += chunk; });
		req.on('end', () => {
			if (!data) return resolve({});
			try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
		});
		req.on('error', reject);
	});
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serveStatic(req, res, urlPath) {
	const rel = urlPath === '/' ? '/index.html' : urlPath;
	const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
	if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
	readFile(filePath, (err, data) => {
		if (err) { res.writeHead(404); res.end('Not found'); return; }
		res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
		res.end(data);
	});
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);

	try {
		if (req.method === 'GET' && url.pathname === '/api/regions') {
			const regions = Object.entries(regionalTeams).map(([id, data]) => ({
				id, name: data.name,
				cores: data.cityLeagueCores.map((c, i) => ({
					index: i, name: c.name, species: c.roster.map(p => p.species),
				})),
			}));
			return sendJSON(res, 200, { regions });
		}

		const rosterMatch = url.pathname.match(/^\/api\/regions\/([^/]+)\/cores\/(\d+)$/);
		if (req.method === 'GET' && rosterMatch) {
			const regionData = regionalTeams[rosterMatch[1]];
			if (!regionData) return sendJSON(res, 404, { error: 'Unknown region' });
			const core = regionData.cityLeagueCores[Number(rosterMatch[2])];
			if (!core) return sendJSON(res, 404, { error: 'Unknown rental core' });
			const roster = core.roster.map((mon, i) => ({
				index: i + 1, species: mon.species, level: mon.level, item: mon.item, ability: mon.ability,
				moves: mon.moves,
				movepool: getMovepoolWithPresets(mon.species, mon.moves),
			}));
			return sendJSON(res, 200, { coreName: core.name, roster });
		}

		if (req.method === 'POST' && url.pathname === '/api/battle/start') {
			const body = await readJSONBody(req);
			let session;
			try {
				session = startBattle(body.region, body.coreIndex, body.moves);
			} catch (err) {
				return sendJSON(res, 400, { error: err.message });
			}
			await waitForPendingOrEnd(session, REQUEST_TIMEOUT_MS);
			return sendJSON(res, 200, buildState(session));
		}

		const stateMatch = url.pathname.match(/^\/api\/battle\/([^/]+)$/);
		if (req.method === 'GET' && stateMatch) {
			const session = sessions.get(stateMatch[1]);
			if (!session) return sendJSON(res, 404, { error: 'No such battle' });
			return sendJSON(res, 200, buildState(session));
		}

		const chooseMatch = url.pathname.match(/^\/api\/battle\/([^/]+)\/choose$/);
		if (req.method === 'POST' && chooseMatch) {
			const session = sessions.get(chooseMatch[1]);
			if (!session) return sendJSON(res, 404, { error: 'No such battle' });
			const req_ = session.human.pendingRequest;
			if (!req_) return sendJSON(res, 409, { error: 'Not waiting on a choice right now' });

			const body = await readJSONBody(req);
			let choiceString;

			if (req_.teamPreview) {
				// body.order: 1-based roster indices in the order to bring them,
				// e.g. [3,1,5,2] - first two become the starting active pair.
				const order = Array.isArray(body.order) ? body.order : [];
				if (order.length !== (req_.maxChosenTeamSize || req_.side.pokemon.length)) {
					return sendJSON(res, 400, { error: `Must pick exactly ${req_.maxChosenTeamSize} Pokemon` });
				}
				choiceString = `team ${order.join('')}`;
			} else if (req_.forceSwitch) {
				// body.switches: index-aligned with req_.forceSwitch - each entry
				// is either a 1-based roster slot to switch into, or null/absent
				// for a position that doesn't need one (or truly has no bench left).
				//
				// This is validated fully here, against the sim's own switch rules
				// (side.ts's chooseSwitch: slot must exist, must not be active/
				// fainted, must not already be used for another position this
				// turn), and any invalid combination is rejected with a 400
				// *without* ever calling submitChoice(). This matters because a
				// rejected switch/team choice does NOT reliably get a corrective
				// |request| line from the sim (only some rejections carry an
				// `update` callback that re-emits one) - so a bad combined choice
				// string can otherwise strand the session with no way to retry.
				// See human-player.mjs's receiveError for the belt-and-suspenders
				// version of this same guard.
				const switches = body.switches || [];
				const availableBench = req_.side.pokemon
					.map((p, idx) => ({ slot: idx + 1, p }))
					.filter(({ p }) => !p.active && !p.condition.includes('fnt'));
				const usedSlots = new Set();
				let invalid = null;
				const parts = req_.forceSwitch.map((needsSwitch, i) => {
					if (!needsSwitch) return 'pass';
					const slot = switches[i];
					if (slot == null) {
						const stillAvailable = availableBench.some(b => !usedSlots.has(b.slot));
						if (stillAvailable) invalid = invalid || 'You must choose a Pokemon to switch in.';
						return 'pass';
					}
					if (usedSlots.has(slot)) {
						invalid = invalid || 'That Pokemon was already chosen for another switch-in this turn.';
						return 'pass';
					}
					if (!availableBench.some(b => b.slot === slot)) {
						invalid = invalid || "That Pokemon can't switch in right now.";
						return 'pass';
					}
					usedSlots.add(slot);
					return `switch ${slot}`;
				});
				if (invalid) return sendJSON(res, 400, { error: invalid });
				choiceString = parts.join(', ');
			} else {
				// Move phase. Each acting slot's action is either a move choice
				// ({moveSlot, target?}) or a voluntary switch ({switchTo: <1-based
				// roster slot>}) - same duplicate/legality validation as the
				// forceSwitch branch above, and for the same reason: an invalid
				// combined choice can silently strand the session otherwise.
				const actions = body.actions || [];
				const availableBench = req_.side.pokemon
					.map((p, idx) => ({ slot: idx + 1, p }))
					.filter(({ p }) => !p.active && !p.condition.includes('fnt'));
				const usedSwitchSlots = new Set();
				let invalid = null;
				const parts = req_.active.map((activeSlot, i) => {
					const pokemon = req_.side.pokemon[i];
					if (pokemon.condition.includes('fnt')) return 'pass'; // fainted active slot: always pass
					const chosen = actions[i];
					if (!chosen) return 'pass';
					if (chosen.switchTo != null) {
						const slot = chosen.switchTo;
						if (usedSwitchSlots.has(slot)) {
							invalid = invalid || 'That Pokemon was already chosen for another switch-in this turn.';
							return 'pass';
						}
						if (!availableBench.some(b => b.slot === slot)) {
							invalid = invalid || "That Pokemon can't switch in right now.";
							return 'pass';
						}
						usedSwitchSlots.add(slot);
						return `switch ${slot}`;
					}
					if (!chosen.moveSlot) return 'pass';
					return chosen.target != null && chosen.target !== 0 ?
						`move ${chosen.moveSlot} ${chosen.target}` : `move ${chosen.moveSlot}`;
				});
				if (invalid) return sendJSON(res, 400, { error: invalid });
				choiceString = parts.join(', ');
			}

			if (process.env.DEBUG_CHOICES) console.error('[choose]', choiceString, JSON.stringify(body));
			try {
				session.human.submitChoice(choiceString);
			} catch (err) {
				return sendJSON(res, 400, { error: err.message });
			}
			await waitForPendingOrEnd(session, REQUEST_TIMEOUT_MS);
			return sendJSON(res, 200, buildState(session));
		}

		if (req.method === 'GET') return serveStatic(req, res, url.pathname);

		sendJSON(res, 404, { error: 'Not found' });
	} catch (err) {
		sendJSON(res, 500, { error: err.message });
	}
});

server.listen(PORT, () => {
	console.log(`Pokemon RPG game server running at http://localhost:${PORT}`);
});
