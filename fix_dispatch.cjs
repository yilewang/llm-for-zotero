const fs = require('fs');
let code = fs.readFileSync('src/modules/contextPanel/setupHandlers.ts', 'utf8');

code = code.replace(
    'const customEv = new CustomEvent("llm-menu-dismiss-trigger");',
    'const customEv = new CustomEvent("llm-menu-dismiss-trigger", { bubbles: true, composed: true });'
);

code = code.replace(
    'if (body.ownerDocument) body.ownerDocument.dispatchEvent(customEv);',
    'body.dispatchEvent(customEv);'
);

fs.writeFileSync('src/modules/contextPanel/setupHandlers.ts', code);
console.log('Fixed dispatch');