const fs = require('fs');
let code = fs.readFileSync('src/modules/contextPanel/setupHandlers.ts', 'utf8');

code = code.replace(
    'const customEv = new CustomEvent("llm-menu-dismiss-trigger");',
    'ztoolkit.log("LLM: fDoc dismissTrigger fired, event type: " + ev.type + ", target: " + (ev.target ? (ev.target as Element).tagName : "null"));\n            const customEv = new CustomEvent("llm-menu-dismiss-trigger");'
);

code = code.replace(
    'const handleDocumentDismiss = (e: Event) => {',
    'const handleDocumentDismiss = (e: Event) => {\n      ztoolkit.log("LLM: handleDocumentDismiss fired " + e.type);'
);

fs.writeFileSync('src/modules/contextPanel/setupHandlers.ts', code);
console.log('Added debug logs');