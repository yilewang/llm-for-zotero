const fs = require('fs');
let code = fs.readFileSync('src/modules/contextPanel/setupHandlers.ts', 'utf8');

const regex = /doc\.querySelectorAll\((["'][^"']+["'])\)/g;
let replaced = 0;
const newCode = code.replace(regex, (match, p1) => {
    replaced++;
    return `(((body as any).__llmFloatedPanel || doc).querySelectorAll(${p1}))`;
});

fs.writeFileSync('src/modules/contextPanel/setupHandlers.ts', newCode);
console.log('Replaced querySelectorAll: ' + replaced);
