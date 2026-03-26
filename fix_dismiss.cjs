const fs = require('fs');
let code = fs.readFileSync('src/modules/contextPanel/setupHandlers.ts', 'utf8');
let replaced = 0;
// We'll replace all menu event propagation blocks directly instead.
// Specifically strings like:
// menu.addEventListener("pointerdown", (e: Event) => {
//     e.stopPropagation();
// });
// Or similar spaces.

code = code.replace(/(\w+)\.addEventListener\(\"pointerdown\",\s*\(e:\s*Event\)\s*=>\s*\{\n\s*e\.stopPropagation\(\);\n\s*\}\);/g, (match, prefix) => {
    replaced++;
    return prefix + '.addEventListener("pointerdown", (e: Event) => {\n      e.stopPropagation();\n    });\n    ' + prefix + '.addEventListener("llm-menu-dismiss-trigger", (e: Event) => {\n      e.stopPropagation();\n    });';
});

code = code.replace(/(\w+)\.addEventListener\(\"mousedown\",\s*\(e:\s*Event\)\s*=>\s*\{\n\s*e\.stopPropagation\(\);\n\s*\}\);/g, (match, prefix) => {
    replaced++;
    return prefix + '.addEventListener("mousedown", (e: Event) => {\n      e.stopPropagation();\n    });\n    ' + prefix + '.addEventListener("llm-menu-dismiss-trigger", (e: Event) => {\n      e.stopPropagation();\n    });';
});

fs.writeFileSync('src/modules/contextPanel/setupHandlers.ts', code);
console.log('Replaced ' + replaced);
