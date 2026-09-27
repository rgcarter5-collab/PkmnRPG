// Separate economy for held items - deliberately has nothing to do with
// stat-training.mjs's Training Points. Pokedollars are earned differently
// (tournament payouts / prize money, conceptually) and only buy items;
// Mega Stones are explicitly NOT purchasable here - they're earned through
// story events per the game's design.
export class EconomyError extends Error {}

export function createWallet(startingBalance = 0) {
	return { pokedollars: startingBalance };
}

export function earn(wallet, amount) {
	if (amount < 0) throw new EconomyError('earn amount must be non-negative');
	return { pokedollars: wallet.pokedollars + amount };
}

export function spend(wallet, amount) {
	if (amount < 0) throw new EconomyError('spend amount must be non-negative');
	if (amount > wallet.pokedollars) {
		throw new EconomyError(`Not enough Pokedollars: need ${amount}, have ${wallet.pokedollars}`);
	}
	return { pokedollars: wallet.pokedollars - amount };
}

// Items explicitly excluded from purchase - earned via story instead.
export const STORY_ONLY_ITEMS = new Set([
	// Populated with real Mega Stone names as needed, e.g. 'Charizardite X'.
	// Left as a pattern check below so we don't have to hand-list all ~50.
]);

// Items that end in "-ite" but are NOT Mega Stones (checked against
// Showdown's real item list - Eviolite is the one real false positive the
// naming pattern below would otherwise catch).
const ITE_FALSE_POSITIVES = new Set(['Eviolite']);

export function isPurchasable(itemName) {
	if (STORY_ONLY_ITEMS.has(itemName)) return false;
	if (ITE_FALSE_POSITIVES.has(itemName)) return true;
	if (/ite( [XY])?$/.test(itemName)) {
		// Catches the "<Species>ite" / "<Species>ite X/Y" Mega Stone naming
		// pattern (Charizardite X, Venusaurite, etc.) without hand-listing them.
		return false;
	}
	return true;
}

export function buyItem(wallet, itemName, price) {
	if (!isPurchasable(itemName)) {
		throw new EconomyError(`${itemName} can't be purchased - it's earned through story progression`);
	}
	return spend(wallet, price);
}
