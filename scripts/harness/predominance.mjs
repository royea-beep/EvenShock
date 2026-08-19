/**
 * The predominance arithmetic behind docs/predominance-test.md.
 *
 * Pure maths over counts pasted from production — exact binomial, Wilson
 * intervals, no simulation and nothing to seed, so anyone checking the
 * document can rerun it offline and get the same figures. The counts it
 * starts from are in the document, with the query that produced them.
 *
 *   npm run analysis:predominance
 */
// Predominance arithmetic. Exact binomial; no simulation, nothing to seed.
const C = (n,k)=>{let r=1;for(let i=0;i<k;i++)r=r*(n-i)/(i+1);return r;};
// First to k decisive wins, ties replayed => every round eventually decisive.
const matchWin=(q,k)=>{let p=0;for(let j=0;j<k;j++)p+=C(k-1+j,j)*Math.pow(q,k)*Math.pow(1-q,j);return p;};
const FORMATS=[['single',1],['bo3',2],['bo5',3],['bo7',4],['bo9',5],['bo11',6],['bo15',8],['bo21',11]];
// Wilson score interval — correct at the small n and extreme p we have here,
// where the normal approximation would put the bound above 1.
function wilson(x,n,z=1.96){const p=x/n,d=1+z*z/n,c=p+z*z/(2*n),m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n));
  return [(c-m)/d,(c+m)/d];}
// Invert matchWin numerically: the q needed to clear a target match win rate.
function qFor(target,k){let lo=0.5,hi=1;for(let i=0;i<200;i++){const mid=(lo+hi)/2;matchWin(mid,k)<target?lo=mid:hi=mid;}return (lo+hi)/2;}

const fmt=x=>(x*100).toFixed(1)+'%';
console.log('=== 1. Per-decisive-round edge, measured (production rows) ===');
const cases=[
  ['blind rounds (opponent is effectively random)',78,169],
  ['rounds where the reader played its read',77,88],
  ['all Nemesis rounds pooled',155,257],
];
const qs={};
for(const [label,x,n] of cases){
  const p=x/n,[lo,hi]=wilson(x,n);
  qs[label]=[p,lo,hi];
  console.log(`  ${label.padEnd(46)} q=${p.toFixed(4)}  95% CI ${lo.toFixed(4)}–${hi.toFixed(4)}  (${x}/${n})`);
}
console.log('\n=== 2. q required to clear the 75% match standard ===');
for(const [name,k] of FORMATS) console.log(`  ${name.padEnd(7)} first to ${k}: needs q >= ${qFor(0.75,k).toFixed(4)}`);

console.log('\n=== 3. Match win rate at each measured q, by format ===');
for(const [label,[p,lo,hi]] of Object.entries(qs)){
  if(label.startsWith('blind')) continue;
  console.log(`  using q=${p.toFixed(4)} [${lo.toFixed(4)}, ${hi.toFixed(4)}] — ${label}`);
  for(const [name,k] of FORMATS.slice(0,6)){
    const pt=matchWin(p,k),l=matchWin(lo,k),h=matchWin(hi,k);
    console.log(`    ${name.padEnd(7)} ${fmt(pt).padStart(6)}  95% CI ${fmt(l)} – ${fmt(h)}  ${pt>=0.75?'CLEARS 75%':'below 75%'}${l>=0.75?' (CI lower bound also clears)':''}`);
  }
}
console.log('\n=== 4. Is the blind branch distinguishable from a coin flip? ===');
{const [p,lo,hi]=qs['blind rounds (opponent is effectively random)'];
 console.log(`  q=${p.toFixed(4)}, 95% CI ${lo.toFixed(4)}–${hi.toFixed(4)} — 0.50 ${lo<=0.5&&hi>=0.5?'IS inside the interval: indistinguishable from chance':'is OUTSIDE the interval'}`);}

console.log('\n=== 5. Sample size needed for a defensible empirical figure ===');
const need=(p,half)=>Math.ceil(1.96*1.96*p*(1-p)/(half*half));
for(const half of [0.10,0.05,0.03]) console.log(`  CI half-width +/-${(half*100).toFixed(0)}pp around p=0.75: n = ${need(0.75,half)} matches`);
const demo=(t,p)=>{let n=1;while(p-1.96*Math.sqrt(p*(1-p)/n)<t)n++;return n;};
for(const p of [0.80,0.85,0.90]) console.log(`  to prove >75% when the truth is ${fmt(p)}: n = ${demo(0.75,p)} matches (95% lower bound clears)`);
