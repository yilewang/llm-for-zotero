const fs = require('fs');
let code = fs.readFileSync('src/modules/contextPanel/setupHandlers.ts', 'utf8');

code = code.replace(
  /const dismissTrigger = \(ev: Event\) => \{([\s\S]*?)const customEv = new CustomEvent\("llm-menu-dismiss-trigger"/,
  (match, p1) => {
    return 'const dismissTrigger = (ev: Event) => {\n            ztoolkit.log("LLM: fDoc dismissTrigger fired, event type: " + ev.type + ", target: " + (ev.target ? (ev.target as Element).tagName : "null") + ", class: " + (ev.target ? (ev.target as Element).className : "null"));\n            const customEv = new CustomEvent("llm-menu-dismiss-trigger"';
  }
);

code = code.replace(
  'const handleDocumentDismiss = (e: Event) => {',
  'const handleDocumentDismiss = (e: Event) => {\n      ztoolkit.log("LLM: handleDocumentDismiss fired " + e.type + ", target: " + (e.target ? (e.target as Element).tagName : "null") + ", isCustom: " + (e.type === "llm-menu-dismiss-trigger"));'
);

fs.writeFileSync('src/modules/contextPanel/setupHandlers.ts', code);
console.log('Fixed log 3');
