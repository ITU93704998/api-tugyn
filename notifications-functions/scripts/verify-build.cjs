const fs = require('node:fs');
const path = require('node:path');
for (const file of ['notifications-functions/src/index.js','api/_lib/pushEnvio.js','api/_lib/push.js']) {
  if (!fs.existsSync(path.resolve(__dirname,'../lib',file))) throw Error('Missing compiled function artifact: '+file+'. Run npm run build before deployment.');
}
