const fs = require('fs');
let code = fs.readFileSync('src/modules/contextPanel/setupHandlers.ts', 'utf8');

code = code.replace(
  'doc.addEventListener("mousedown", handleDocumentDismiss);',
  'doc.addEventListener("mousedown", handleDocumentDismiss, true);'
);

code = code.replace(
  'doc.addEventListener("llm-menu-dismiss-trigger", handleDocumentDismiss as EventListener);',
  'doc.addEventListener("llm-menu-dismiss-trigger", handleDocumentDismiss as EventListener, true);'
);


fs.writeFileSync('src/modules/contextPanel/setupHandlers.ts', code);
console.log('Fixed early catch');
