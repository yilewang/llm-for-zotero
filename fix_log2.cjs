const fs = require('fs');
let code = fs.readFileSync('src/modules/contextPanel/setupHandlers.ts', 'utf8');

code = code.replace(
    'ztoolkit.log("LLM: handleDocumentDismiss fired " + e.type);',
    'ztoolkit.log("LLM: handleDocumentDismiss fired " + e.type + ", target: " + (target ? (target as Element).tagName : "null") + ", modelMenus: " + modelMenus.length + ", button: " + button);'
);

fs.writeFileSync('src/modules/contextPanel/setupHandlers.ts', code);
console.log('Fixed log 2');