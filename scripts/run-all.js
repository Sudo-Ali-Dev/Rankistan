const { execSync } = require('child_process');

try {
  console.log("Fetching Devs...");
  execSync(`node -e "const fs=require('node:fs/promises'); const path=require('node:path'); const {fetchPakistaniDevelopers}=require('./scripts/fetch-devs.js'); (async()=>{const devs=await fetchPakistaniDevelopers({repoRoot:process.cwd()}); await fs.writeFile(path.join(process.cwd(),'public','raw.json'), JSON.stringify(devs,null,2)); console.log('Saved public/raw.json with', devs.length, 'developers');})().catch((e)=>{console.error(e.message); process.exit(1);});"`, {stdio: 'inherit'});
  
  console.log("Scoring Devs...");
  execSync("node scripts/score.js public/raw.json public/scored.json", {stdio: 'inherit'});
  
  console.log("Writing Leaderboard...");
  execSync("node scripts/write-leaderboard.js public/scored.json public/data.json", {stdio: 'inherit'});
  
  console.log("Generating Digest...");
  execSync("node scripts/generate-digest.js", {stdio: 'inherit'});
  
  console.log("All tasks finished successfully.");
} catch (e) {
  console.error("Task failed:", e.message);
  process.exit(1);
}
