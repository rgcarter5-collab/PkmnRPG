// Breeder marketplace: a small, static catalog of purchasable species (not
// randomly rotating yet - that's an easy later addition once this vertical
// slice is proven out). Buying a listing spends Pokedollars and adds a new
// owned Pokemon to the player's roster, with a sensible auto-built starter
// kit (see build-regional-teams.mjs's buildStarterSet) and a suggested SP
// spread (see stat-training.mjs's suggestSpread) rather than a blank slate -
// the player can freely respec the SP for free (removeStat/trainStat) once
// they own it.
import { Dex } from './sim/index.ts';
import { buildStarterSet, classify } from './build-regional-teams.mjs';
import { suggestSpread, spToEVs } from './stat-training.mjs';
import { addOwnedPokemon, getPlayer, setPokedollars } from './db.mjs';

function bstOf(species) {
	const b = species.baseStats;
	return b.hp + b.atk + b.def + b.spa + b.spd + b.spe;
}

// Price scales with raw power (BST) - rough, deliberately simple bands
// rather than a per-mon hand-tuned price list. Tunable later.
function priceFor(bst) {
	if (bst >= 580) return 6000;
	if (bst >= 520) return 4500;
	if (bst >= 480) return 3000;
	if (bst >= 420) return 2000;
	return 1200;
}

// A modest, hand-picked spread of fully-evolved, non-legendary species
// spanning several regions and roles, so the marketplace has real variety
// from day one without needing every regional dex wired in yet.
const CATALOG_SPECIES = [
	'Pelipper', 'Whimsicott', 'Torkoal', 'Ludicolo', // weather/support
	'Garchomp', 'Tyranitar', 'Dragonite', 'Metagross', 'Salamence', // heavy hitters
	'Scizor', 'Gyarados', 'Alakazam', 'Blissey', 'Umbreon', // classics
	'Rillaboom', 'Incineroar', 'Toxapex', 'Corviknight', // VGC support staples
	'Excadrill', 'Talonflame', 'Sylveon', 'Hydreigon', // rounding out variety
];

let cachedCatalog = null;

/** @returns {{listingId: string, species, price, bst, types, role}[]} */
export function getCatalog() {
	if (cachedCatalog) return cachedCatalog;
	cachedCatalog = CATALOG_SPECIES.map(name => {
		const species = Dex.species.get(name);
		const bst = bstOf(species);
		const { role } = classify(species);
		return { listingId: species.id, species: species.name, price: priceFor(bst), bst, types: species.types, role };
	});
	return cachedCatalog;
}

export class MarketplaceError extends Error {}

/**
 * Buy a listing for a player: validates funds, deducts Pokedollars, and adds
 * a new owned Pokemon with an auto-built starter set + suggested SP spread.
 * @param {string} playerId
 * @param {string} listingId
 * @returns {{player: object, pokemon: object}}
 */
export function buyListing(playerId, listingId) {
	const listing = getCatalog().find(l => l.listingId === listingId);
	if (!listing) throw new MarketplaceError(`No such listing: ${listingId}`);

	const player = getPlayer(playerId);
	if (!player) throw new MarketplaceError('Unknown player');
	if (player.pokedollars < listing.price) {
		throw new MarketplaceError(`Not enough Pokedollars: need ${listing.price}, have ${player.pokedollars}`);
	}

	const set = buildStarterSet(listing.species);
	const sp = suggestSpread(listing.role, set.evs.atk >= set.evs.spa);

	setPokedollars(playerId, player.pokedollars - listing.price);
	const pokemon = addOwnedPokemon(playerId, {
		species: set.species, ability: set.ability, item: set.item, moves: set.moves,
		nature: set.nature, sp, level: set.level, teraType: set.teraType, acquiredVia: 'breeder',
	});

	return { player: getPlayer(playerId), pokemon };
}

/** Convert a persisted owned-Pokemon record into the setData shape battles
 * (and pokemon-set.mjs's toPokemonSet) expect - the SP allocation becomes
 * real EVs at the moment it's needed, everywhere else it stays SP. */
export function ownedPokemonToSetData(pokemon) {
	return {
		species: pokemon.species, ability: pokemon.ability, item: pokemon.item,
		moves: pokemon.moves, nature: pokemon.nature, evs: spToEVs(pokemon.sp),
		level: pokemon.level, teraType: pokemon.teraType,
	};
}
