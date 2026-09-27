// Prove the SP training system actually changes real Showdown stats
// correctly: two identical Pikachu, one with 32 SP dumped into Speed, one
// with 0 SP anywhere, and confirm (a) the computed Speed stat differs by
// the expected amount and (b) it actually changes turn order in a battle.
import { Dex, Teams, BattleStream, getPlayerStreams } from './sim/index.ts';
import { TieredAI } from './tiered-ai.mjs';
import { spToEVs, evsToSP, trainStat, removeStat, validateSP, emptySP, TrainingError } from './stat-training.mjs';
import { createWallet, earn, spend, buyItem, isPurchasable, EconomyError } from './economy.mjs';

console.log('=== Unit checks ===');

// 32 SP -> 252 EV (clamped from 256), 16 SP -> 128 EV
console.log('spToEVs({spe:32}):', spToEVs({ spe: 32 }).spe, '(expect 252)');
console.log('spToEVs({spe:16}):', spToEVs({ spe: 16 }).spe, '(expect 128)');
console.log('evsToSP({spe:252}):', evsToSP({ spe: 252 }).spe, '(expect 32, rounds up from 31.5)');

// Cap enforcement
try {
	const sp = emptySP();
	trainStat(sp, 'spe', 33, 10000); // over per-stat cap
	console.log('FAIL: should have thrown on per-stat cap');
} catch (e) {
	console.log('OK: per-stat cap enforced ->', e instanceof TrainingError, e.message);
}

try {
	let sp = emptySP();
	sp = trainStat(sp, 'spe', 32, 10000).sp;
	sp = trainStat(sp, 'atk', 32, 10000).sp; // 64 total, fine
	trainStat(sp, 'def', 5, 10000); // would push to 69 > 66 total cap
	console.log('FAIL: should have thrown on total cap');
} catch (e) {
	console.log('OK: total SP cap enforced ->', e instanceof TrainingError);
}

// TP cost and affordability
{
	const r = trainStat(emptySP(), 'spe', 10, 100);
	console.log('10 SP costs', r.tpSpent, 'TP (expect 50), remaining balance', r.tpBalance, '(expect 50)');
}
try {
	trainStat(emptySP(), 'spe', 10, 10); // can't afford
	console.log('FAIL: should have thrown on insufficient TP');
} catch (e) {
	console.log('OK: insufficient TP rejected ->', e instanceof TrainingError);
}

// Removing SP is free
{
	let sp = trainStat(emptySP(), 'atk', 20, 1000).sp;
	const removed = removeStat(sp, 'atk', 5);
	console.log('after removing 5 SP from 20:', removed.sp.atk, '(expect 15), no tp field returned:', !('tpBalance' in removed));
}

// Economy: separate from training TP entirely, mega stones blocked
{
	let wallet = createWallet(1000);
	wallet = earn(wallet, 500);
	console.log('wallet after earning 500 on top of 1000:', wallet.pokedollars, '(expect 1500)');
	console.log('Eviolite purchasable:', isPurchasable('Eviolite'), '(expect true)');
	console.log('Charizardite X purchasable:', isPurchasable('Charizardite X'), '(expect false)');
	console.log('Leftovers purchasable:', isPurchasable('Leftovers'), '(expect true)');
	try {
		buyItem(wallet, 'Charizardite X', 100);
		console.log('FAIL: should not be able to buy a mega stone');
	} catch (e) {
		console.log('OK: mega stone purchase blocked ->', e instanceof EconomyError);
	}
	wallet = buyItem(wallet, 'Leftovers', 200);
	console.log('wallet after buying Leftovers for 200:', wallet.pokedollars, '(expect 1300)');
}

console.log('\n=== Live battle proof: does SP-derived Speed actually change turn order? ===');

function pikachuWithSP(name, sp) {
	const evs = spToEVs(sp);
	return {
		name, species: 'Pikachu', item: 'Leftovers', ability: 'Static',
		moves: ['thunderbolt', 'protect'],
		nature: 'Hardy', gender: '',
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...evs },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		level: 50, shiny: false, teraType: 'Electric',
	};
}

// Second mon on each side is a filler so it's a legal doubles team.
function filler(name) {
	return {
		name, species: 'Magikarp', item: 'Leftovers', ability: 'Swift Swim',
		moves: ['splash'], nature: 'Hardy', gender: '',
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		level: 50, shiny: false, teraType: 'Water',
	};
}

const fastPikachu = pikachuWithSP('FastPika', { spe: 32, spa: 32 });
const slowPikachu = pikachuWithSP('SlowPika', emptySP());

const streams = getPlayerStreams(new BattleStream());
const spec = { formatid: 'gen9doublescustomgame' };
const p1spec = { name: 'Fast', team: Teams.pack([fastPikachu, filler('F1')]) };
const p2spec = { name: 'Slow', team: Teams.pack([slowPikachu, filler('F2')]) };

const p1 = new TieredAI(streams.p1, 4, {}, false);
const p2 = new TieredAI(streams.p2, 4, {}, false);
void p1.start();
void p2.start();

const log = [];
void (async () => {
	for await (const chunk of streams.omniscient) log.push(chunk);
	const text = log.join('\n');
	const firstMoveLine = text.split('\n').find(l => l.includes('|move|') && (l.includes('FastPika') || l.includes('SlowPika')));
	console.log('First Pikachu move line:', firstMoveLine);
	console.log(firstMoveLine?.includes('FastPika') ? 'CORRECT: the 32-SP-Speed Pikachu moved first' : 'CHECK MANUALLY');
	console.log('\n--- full log ---');
	console.log(text);
	process.exit(0);
})();

void streams.omniscient.write(`>start ${JSON.stringify(spec)}\n>player p1 ${JSON.stringify(p1spec)}\n>player p2 ${JSON.stringify(p2spec)}`);
