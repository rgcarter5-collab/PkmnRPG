// Validate generated regional teams are legal and actually battle-ready:
// convert to Showdown PokemonSet objects, run TeamValidator, then play a
// real battle between two generated teams using our TieredAI.
import { Dex, Teams, TeamValidator, BattleStream, getPlayerStreams } from './sim/index.ts';
import { TieredAI } from './tiered-ai.mjs';
import { toPokemonSet } from './pokemon-set.mjs';
import { readFileSync } from 'node:fs';

const regionalTeams = JSON.parse(readFileSync('./regional-teams.json', 'utf8'));

const validator = new TeamValidator('gen9doublescustomgame');

let totalTeams = 0, totalProblems = 0;
for (const regionId of Object.keys(regionalTeams)) {
	for (const team of regionalTeams[regionId].regionalTeams) {
		totalTeams++;
		const pokemonSets = team.roster.map(toPokemonSet);
		const problems = validator.validateTeam(pokemonSets);
		if (problems) {
			totalProblems++;
			console.log(`ISSUES in ${team.name}:`, problems);
		}
	}
}
console.log(`\nValidated ${totalTeams} regional teams, ${totalProblems} had legality issues.\n`);

// Live battle test: Kanto Weather vs Kanto Trick Room
const kanto = regionalTeams.kanto;
const teamA = kanto.regionalTeams.find(t => t.archetype === 'weather');
const teamB = kanto.regionalTeams.find(t => t.archetype === 'trick-room');

const p1team = teamA.roster.map(toPokemonSet);
const p2team = teamB.roster.map(toPokemonSet);

const streams = getPlayerStreams(new BattleStream());
const spec = { formatid: 'gen9doublescustomgame' };
const p1spec = { name: teamA.name, team: Teams.pack(p1team) };
const p2spec = { name: teamB.name, team: Teams.pack(p2team) };

const p1 = new TieredAI(streams.p1, 4, {}, false); // Master vs Master, no debug spam
const p2 = new TieredAI(streams.p2, 4, {}, false);

void p1.start();
void p2.start();

const fullLog = [];
void (async () => {
	for await (const chunk of streams.omniscient) fullLog.push(chunk);
	console.log(`=== ${teamA.name} vs ${teamB.name} ===`);
	const lines = fullLog.join('\n').split('\n');
	console.log(lines.filter(l => l.startsWith('|move|') || l.startsWith('|faint|') || l.startsWith('|win|') || l.startsWith('|switch|')).join('\n'));
	process.exit(0);
})();

void streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);
