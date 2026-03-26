const fs = require('fs');
let code = fs.readFileSync('src/modules/contextPanel/setupHandlers.ts', 'utf8');

code = code.replace(
    'ztoolkit.log("LLM: handleDocumentDismiss fired " + e.type + ", target: " + (target ? (target as Element).tagName : "null") + ", modelMenus: " + modelMenus.length + ", button: " + button);',
    ''
);

code = code.replace(
    'const retryButtonTarget = isElementNode(target)',
    'ztoolkit.log("LLM: handleDocumentDismiss target: " + (target ? (target as Element).tagName : "null") + ", modelMenus: " + modelMenus.length + ", button: " + button);\n      const retryButtonTarget = isElementNode(target)'
);

fs.writeFileSync('src/modules/contextPanel/setupHandlers.ts', code);
console.log('Fixed log order');
