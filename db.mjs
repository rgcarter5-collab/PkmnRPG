// Persistence layer: players, their Pokedollars/Training Points, and their
// owned Pokemon roster. Backed by node:sqlite (a built-in module, no npm
// dependency) writing to a local file - good enough for local dev, but this
// is NOT yet what the user asked for in production terms: Render's free
// tier wipes local disk on every redeploy, so anything saved here vanishes
// the next time the game is deployed. Getting REAL persistence in
// production means pointing this at a real hosted database (e.g. Turso for
// SQLite-over-the-network, or Supabase/Neon for Postgres) using the user's
// own account/credentials - something only they can set up. Everything
// below is written as plain SQL through a small set of functions specifically
// so that swap later only touches this one file: replace the DatabaseSync
// connection with a network client that exposes the same query shape (or
// return the same query shape from get/all/run wrappers over the new
// driver), and nothing in game-server.mjs or marketplace.mjs has to change.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'game.sqlite');

export const STARTING_POKEDOLLARS = 3000;
export const STARTING_TRAINING_POINTS = 0;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
	id TEXT PRIMARY KEY,
	pokedollars INTEGER NOT NULL DEFAULT ${STARTING_POKEDOLLARS},
	training_points INTEGER NOT NULL DEFAULT ${STARTING_TRAINING_POINTS},
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS owned_pokemon (
	id TEXT PRIMARY KEY,
	player_id TEXT NOT NULL REFERENCES players(id),
	species TEXT NOT NULL,
	ability TEXT NOT NULL,
	item TEXT NOT NULL,
	moves TEXT NOT NULL,      -- JSON array of 4 move names
	nature TEXT NOT NULL,
	sp TEXT NOT NULL,         -- JSON {hp,atk,def,spa,spd,spe} Stat Points (see stat-training.mjs)
	level INTEGER NOT NULL DEFAULT 50,
	tera_type TEXT NOT NULL,
	acquired_via TEXT NOT NULL DEFAULT 'breeder', -- 'breeder' | 'prize' | 'starter'
	on_team INTEGER NOT NULL DEFAULT 0,  -- 1 if currently one of the player's chosen 6
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_owned_pokemon_player ON owned_pokemon(player_id);
`);

function rowToPlayer(row) {
	if (!row) return null;
	return { id: row.id, pokedollars: row.pokedollars, trainingPoints: row.training_points };
}

function rowToPokemon(row) {
	if (!row) return null;
	return {
		id: row.id,
		playerId: row.player_id,
		species: row.species,
		ability: row.ability,
		item: row.item,
		moves: JSON.parse(row.moves),
		nature: row.nature,
		sp: JSON.parse(row.sp),
		level: row.level,
		teraType: row.tera_type,
		acquiredVia: row.acquired_via,
		onTeam: !!row.on_team,
	};
}

/** Fetch a player, creating a new save (with starting currency) if this id has never been seen. */
export function getOrCreatePlayer(playerId) {
	if (!playerId || typeof playerId !== 'string') throw new Error('Missing player id');
	const existing = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
	if (existing) return rowToPlayer(existing);
	db.prepare('INSERT INTO players (id, pokedollars, training_points) VALUES (?, ?, ?)')
		.run(playerId, STARTING_POKEDOLLARS, STARTING_TRAINING_POINTS);
	return { id: playerId, pokedollars: STARTING_POKEDOLLARS, trainingPoints: STARTING_TRAINING_POINTS };
}

export function getPlayer(playerId) {
	return rowToPlayer(db.prepare('SELECT * FROM players WHERE id = ?').get(playerId));
}

export function setPokedollars(playerId, amount) {
	db.prepare('UPDATE players SET pokedollars = ? WHERE id = ?').run(amount, playerId);
}

export function setTrainingPoints(playerId, amount) {
	db.prepare('UPDATE players SET training_points = ? WHERE id = ?').run(amount, playerId);
}

/**
 * @param {string} playerId
 * @param {{species, ability, item, moves, nature, sp, level, teraType, acquiredVia}} setData
 * @returns {object} the created owned-Pokemon record
 */
export function addOwnedPokemon(playerId, setData) {
	const id = randomUUID();
	db.prepare(`
		INSERT INTO owned_pokemon (id, player_id, species, ability, item, moves, nature, sp, level, tera_type, acquired_via)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		id, playerId, setData.species, setData.ability, setData.item,
		JSON.stringify(setData.moves), setData.nature, JSON.stringify(setData.sp || {}),
		setData.level || 50, setData.teraType, setData.acquiredVia || 'breeder',
	);
	return getOwnedPokemon(id);
}

export function getOwnedPokemon(id) {
	return rowToPokemon(db.prepare('SELECT * FROM owned_pokemon WHERE id = ?').get(id));
}

export function listOwnedPokemon(playerId) {
	return db.prepare('SELECT * FROM owned_pokemon WHERE player_id = ? ORDER BY created_at').all(playerId).map(rowToPokemon);
}

export function updateOwnedPokemonMoves(id, moves) {
	db.prepare('UPDATE owned_pokemon SET moves = ? WHERE id = ?').run(JSON.stringify(moves), id);
}

export function updateOwnedPokemonSP(id, sp) {
	db.prepare('UPDATE owned_pokemon SET sp = ? WHERE id = ?').run(JSON.stringify(sp), id);
}

/** Replace the player's current 6-mon team with exactly these owned-Pokemon ids. */
export function setTeam(playerId, ids) {
	const owned = listOwnedPokemon(playerId);
	const ownedIds = new Set(owned.map(p => p.id));
	for (const id of ids) {
		if (!ownedIds.has(id)) throw new Error(`Pokemon ${id} is not owned by this player`);
	}
	db.prepare('UPDATE owned_pokemon SET on_team = 0 WHERE player_id = ?').run(playerId);
	const mark = db.prepare('UPDATE owned_pokemon SET on_team = 1 WHERE id = ?');
	for (const id of ids) mark.run(id);
}

export function getTeam(playerId) {
	return db.prepare('SELECT * FROM owned_pokemon WHERE player_id = ? AND on_team = 1 ORDER BY created_at').all(playerId).map(rowToPokemon);
}
